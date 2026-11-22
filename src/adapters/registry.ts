/**
 * Adapter registry.
 *
 * Channels are looked up by name. The node registers the built-in `email`
 * factory; anything else arrives as a plugin: a module listed under `plugins`
 * in the config whose default export (or `register` export) receives the
 * registry and calls `registry.register('slack', factory)`.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { AdapterFactory, AdapterFactoryContext, ChannelAdapter } from './types.js';

export type PluginRegister = (registry: AdapterRegistry) => void | Promise<void>;

export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly adapters = new Map<string, ChannelAdapter>();

  /** Makes a channel type available. It is instantiated only if the config has a `channels.{name}` section. */
  register(name: string, factory: AdapterFactory): void {
    const key = name.toLowerCase();
    if (this.factories.has(key)) throw new Error(`a channel adapter named "${key}" is already registered`);
    this.factories.set(key, factory);
  }

  /** Installs a ready-made adapter instance (used by tests and by embedders). */
  set(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name.toLowerCase(), adapter);
  }

  get(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name.toLowerCase());
  }

  names(): string[] {
    return [...this.adapters.keys()];
  }

  hasFactory(name: string): boolean {
    return this.factories.has(name.toLowerCase());
  }

  /** Instantiates an adapter for every configured channel that is not already installed. */
  async init(channels: Record<string, unknown>, ctx: Omit<AdapterFactoryContext, 'config'>): Promise<void> {
    for (const [name, config] of Object.entries(channels)) {
      const key = name.toLowerCase();
      if (config === undefined || config === null || this.adapters.has(key)) continue;
      const factory = this.factories.get(key);
      if (!factory) {
        throw new Error(`channels.${name} is configured, but no adapter named "${key}" is registered (missing plugin?)`);
      }
      const adapter = await factory({ ...ctx, config });
      this.adapters.set(key, adapter);
    }
  }

  async loadPlugins(specifiers: string[]): Promise<void> {
    for (const spec of specifiers) {
      const url = path.isAbsolute(spec) ? pathToFileURL(spec).href : spec;
      const mod = (await import(url)) as { default?: PluginRegister; register?: PluginRegister };
      const register = mod.register ?? mod.default;
      if (typeof register !== 'function') {
        throw new Error(`plugin ${spec} must export a register(registry) function (named or default)`);
      }
      await register(this);
    }
  }

  async close(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.close?.();
  }
}
