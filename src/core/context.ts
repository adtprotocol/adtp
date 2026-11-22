import type { AdapterRegistry } from '../adapters/registry.js';
import type { NodeConfig } from '../config.js';
import type { Resolver } from '../identity/discovery.js';
import type { KeyStore } from '../identity/keyring.js';
import type { HttpClient } from '../identity/safe-http.js';
import type { Logger } from '../log.js';
import type { DomainResolver } from './domains.js';
import type { EventFeed } from './events.js';
import type { Store } from './store.js';

/** Everything the engine's parts share. Built once by AdtpNode. */
export interface Core {
  config: NodeConfig;
  /** Which addresses this node answers for. */
  domains: DomainResolver;
  store: Store;
  events: EventFeed;
  /** Signing keys, per hosted address. */
  keys: KeyStore;
  resolver: Resolver;
  adapters: AdapterRegistry;
  http: HttpClient;
  log: Logger;
  now: () => Date;
  random: () => number;
  /** Nudges the queue worker to look for work right away. */
  wake: () => void;
  /**
   * Runs once per worker pass, after deliveries were attempted: the node's own
   * reactions to what was delivered (automatic replies). Returns how many
   * messages it dealt with.
   */
  respond?: () => Promise<number>;
}

/** An error whose message is safe and useful to show to the caller. */
export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}
