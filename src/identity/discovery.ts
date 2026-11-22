/**
 * Address resolution: local@domain -> recipient card.
 *
 * Order:
 *   1. addresses hosted by this node (answered from config, no network);
 *   2. a configured override for the domain (local development);
 *   3. DNS TXT at `_adtp.{domain}`: `v=adtp0; card=<url template>`;
 *   4. fallback `https://{domain}/.well-known/adtp/{local}`.
 *
 * A domain's directory (the addresses it lists) is found the same way: the
 * `directory=<url>` field of the same TXT record, then
 * `https://{domain}/.well-known/adtp`.
 */
import { promises as dnsPromises } from 'node:dns';
import { domainOf, localOf, parseAddress } from '../protocol/address.js';
import { parseCard } from '../protocol/cards.js';
import { ADTP_DNS_VERSION_TAG, DIRECTORY_PATH, WELL_KNOWN_PREFIX } from '../protocol/constants.js';
import { parseDirectory } from '../protocol/directory.js';
import type { Resolution, ResolvedCard, ResolvedDirectory } from '../protocol/types.js';
import { httpRequest, type HttpClient } from './safe-http.js';

export class DiscoveryError extends Error {}
/** The node is already doing as many lookups as it allows itself. Nothing is wrong with the address; ask again shortly. */
export class DiscoveryBusyError extends DiscoveryError {}

export interface DiscoveryOptions {
  /** domain -> card URL template containing `{local}`. */
  overrides?: Record<string, string>;
  allowInsecure?: boolean;
  cacheTtlMs?: number;
  /** Answers for addresses hosted on this node; return null for anything else. */
  local?: (address: string) => ResolvedCard | null;
  resolveTxt?: (name: string) => Promise<string[][]>;
  http?: HttpClient;
  now?: () => number;
  /** How many lookups may be on the network at once (default 16). */
  maxConcurrent?: number;
  /** How many more may wait for their turn before further ones are turned away (default 64). */
  maxWaiting?: number;
  /** How many cards, and how many directories, are remembered at most (default 5000 each). */
  maxCacheEntries?: number;
}

export interface Resolver {
  /**
   * The card for an address. With `fresh`, a cached copy is fetched again,
   * unless it was fetched too recently: then the cached copy comes back with
   * `resolved.retry_after` set, which tells the caller it asked for a fresh
   * look and did not get one.
   */
  resolve(address: string, opts?: { fresh?: boolean }): Promise<ResolvedCard>;
}

/** Looks up a domain's directory. */
export interface DirectoryResolver {
  directory(domain: string): Promise<ResolvedDirectory>;
}

/** The `name=value` pairs of one `_adtp` TXT record, or null if it is not an ADTP v0 record. */
function txtFields(record: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const piece of record.split(';')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    fields.set(piece.slice(0, eq).trim().toLowerCase(), piece.slice(eq + 1).trim());
  }
  return fields.get('v')?.toLowerCase() === ADTP_DNS_VERSION_TAG ? fields : null;
}

/** Parses one `_adtp` TXT record. Returns the card URL template, or null if the record is not an ADTP v0 record. */
export function parseTxtRecord(record: string): string | null {
  const card = txtFields(record)?.get('card');
  return card && card.length > 0 ? card : null;
}

/** The directory URL in one `_adtp` TXT record, or null if the record names none. */
export function parseTxtDirectory(record: string): string | null {
  const directory = txtFields(record)?.get('directory');
  return directory && directory.length > 0 ? directory : null;
}

/** Fills `{local}` and `{domain}` in a card URL template. */
export function expandTemplate(template: string, address: string): string {
  return template
    .replaceAll('{local}', encodeURIComponent(localOf(address)))
    .replaceAll('{domain}', encodeURIComponent(domainOf(address)));
}

export function wellKnownUrl(address: string): string {
  return `https://${domainOf(address)}${WELL_KNOWN_PREFIX}${encodeURIComponent(localOf(address))}`;
}

/** Where a domain's directory is when its DNS record does not say. */
export function directoryUrl(domain: string): string {
  return `https://${domain}${DIRECTORY_PATH}`;
}

/** Where a card might be, and how we came to look there. */
export interface Candidate {
  url: string;
  method: Resolution['method'];
  dns_record?: { name: string; value: string };
}

/** A card location may redirect (e.g. the apex domain's well-known path pointing at the node). */
const MAX_REDIRECTS = 3;
const NEGATIVE_TTL_MS = 30_000;
/** A forced refresh (e.g. after an unknown key id) re-fetches a card at most this often, so bogus messages cannot make this node hammer someone else's. */
const MIN_REFRESH_MS = 60_000;
// Anyone can make this node look up a card: it has to, before it can check a signature. These
// three numbers bound what that can cost, whatever arrives.
const MAX_CONCURRENT = 16;
const MAX_WAITING = 64;
const MAX_CACHE_ENTRIES = 5000;
/** How often entries that have expired are cleared out of the caches. */
const SWEEP_INTERVAL_MS = 60_000;

export class Discovery implements Resolver, DirectoryResolver {
  private readonly cache = new Map<string, { card?: ResolvedCard; error?: string; expires: number; fetchedAt: number }>();
  private readonly directories = new Map<string, { directory?: ResolvedDirectory; error?: string; expires: number }>();
  private readonly resolveTxt: (name: string) => Promise<string[][]>;
  private readonly http: HttpClient;
  private readonly now: () => number;
  /** Lookups under way, by address and by domain: a second caller joins the first instead of starting another. */
  private readonly lookups = new Map<string, Promise<ResolvedCard>>();
  private readonly directoryLookups = new Map<string, Promise<ResolvedDirectory>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private nextSweep = 0;

  constructor(private readonly opts: DiscoveryOptions = {}) {
    this.resolveTxt = opts.resolveTxt ?? ((name) => dnsPromises.resolveTxt(name));
    this.http = opts.http ?? httpRequest;
    this.now = opts.now ?? Date.now;
  }

  /** How much is cached and how much is under way. For tests and for anyone watching a node. */
  stats(): { cards: number; directories: number; active: number; waiting: number } {
    return { cards: this.cache.size, directories: this.directories.size, active: this.active, waiting: this.waiting.length };
  }

  /** Runs one lookup when there is room for it: at most `maxConcurrent` at once, and a bounded queue behind them. */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < (this.opts.maxConcurrent ?? MAX_CONCURRENT)) {
      this.active++;
    } else {
      if (this.waiting.length >= (this.opts.maxWaiting ?? MAX_WAITING)) {
        throw new DiscoveryBusyError('too many lookups are in progress on this node; try again shortly');
      }
      await new Promise<void>((turn) => this.waiting.push(turn)); // the one that finishes hands its place over
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /**
   * Stores a cache entry as the newest one. Entries that have expired are
   * cleared out once a minute, and a cache that is full drops its oldest.
   */
  private remember<V extends { expires: number }>(cache: Map<string, V>, key: string, entry: V, now: number): void {
    if (now >= this.nextSweep) {
      this.nextSweep = now + SWEEP_INTERVAL_MS;
      for (const map of [this.cache, this.directories] as Map<string, { expires: number }>[]) {
        for (const [k, e] of map) if (e.expires <= now) map.delete(k);
      }
    }
    cache.delete(key);
    cache.set(key, entry);
    const max = Math.max(1, this.opts.maxCacheEntries ?? MAX_CACHE_ENTRIES);
    if (cache.size <= max) return;
    for (const [k, e] of cache) if (e.expires <= now) cache.delete(k);
    for (const k of cache.keys()) {
      if (cache.size <= max) break;
      cache.delete(k); // a Map lists its keys oldest first
    }
  }

  /** The card locations to try for an address, in order. */
  async candidates(address: string): Promise<Candidate[]> {
    const domain = domainOf(address);
    const override = this.opts.overrides?.[domain];
    if (override) return [{ url: expandTemplate(override, address), method: 'override' }];

    const found: Candidate[] = [];
    const name = `_adtp.${domain}`;
    try {
      const records = await this.resolveTxt(name);
      for (const chunks of records) {
        const value = chunks.join('');
        const template = parseTxtRecord(value);
        if (template) {
          found.push({ url: expandTemplate(template, address), method: 'dns', dns_record: { name, value } });
          break;
        }
      }
    } catch {
      // No TXT record (or DNS failure): fall through to the well-known URL.
    }
    const fallback = wellKnownUrl(address);
    if (!found.some((c) => c.url === fallback)) found.push({ url: fallback, method: 'well-known' });
    return found;
  }

  /** The card URLs to try for an address, in order. */
  async candidateUrls(address: string): Promise<string[]> {
    return (await this.candidates(address)).map((c) => c.url);
  }

  async resolve(input: string, opts: { fresh?: boolean } = {}): Promise<ResolvedCard> {
    const parsed = parseAddress(input);
    if (!parsed) throw new DiscoveryError(`"${input}" is not a valid address`);
    const address = parsed.address;

    const local = this.opts.local?.(address);
    if (local) return local;

    const now = this.now();
    const cached = this.cache.get(address);
    const tooSoonMs = cached ? MIN_REFRESH_MS - (now - cached.fetchedAt) : 0;
    const refresh = opts.fresh === true && tooSoonMs <= 0;
    if (cached && !refresh && cached.expires > now) {
      if (!cached.card) throw new DiscoveryError(cached.error ?? `could not resolve ${address}`);
      // Asked for a fresh copy, but this one is too recent to fetch again. Hand it back marked,
      // so the caller does not mistake "not in this copy" for "not in the card".
      if (opts.fresh === true && tooSoonMs > 0) {
        return { ...cached.card, resolved: { ...(cached.card.resolved ?? { method: 'well-known' }), retry_after: Math.ceil(tooSoonMs / 1000) } };
      }
      return cached.card;
    }

    // Many messages from one sender arriving together cost one lookup, not one each.
    const underWay = this.lookups.get(address);
    if (underWay) return underWay;
    const lookup = this.lookUp(address, now).finally(() => this.lookups.delete(address));
    this.lookups.set(address, lookup);
    return lookup;
  }

  private async lookUp(address: string, now: number): Promise<ResolvedCard> {
    try {
      const card = await this.limited(() => this.fetchCard(address));
      this.remember(this.cache, address, { card, expires: now + (this.opts.cacheTtlMs ?? 300_000), fetchedAt: now }, now);
      return card;
    } catch (err) {
      if (err instanceof DiscoveryBusyError) throw err; // says nothing about the address: not remembered
      const message = (err as Error).message;
      this.remember(this.cache, address, { error: message, expires: now + NEGATIVE_TTL_MS, fetchedAt: now }, now);
      throw err instanceof DiscoveryError ? err : new DiscoveryError(message);
    }
  }

  private async fetchCard(address: string): Promise<ResolvedCard> {
    const failures: string[] = [];
    for (const candidate of await this.candidates(address)) {
      try {
        const { body, url } = await this.get(candidate.url);
        const card = parseCard(JSON.parse(body));
        if (card.address !== address) throw new Error(`card is for ${card.address}, not ${address}`);
        if (card.keys.length === 0) throw new Error('card publishes no usable keys');
        card.resolved = { method: candidate.method, card_url: url };
        if (candidate.dns_record) card.resolved.dns_record = candidate.dns_record;
        return card;
      } catch (err) {
        failures.push(`${candidate.url}: ${(err as Error).message}`);
      }
    }
    throw new DiscoveryError(`could not resolve ${address} (${failures.join('; ')})`);
  }

  /** The places to look for a domain's directory, in order. */
  async directoryCandidates(domain: string): Promise<Candidate[]> {
    const override = this.opts.overrides?.[domain];
    if (override) {
      // An override is a card template. The directory is the collection the cards sit under.
      if (!override.endsWith('/{local}')) {
        throw new DiscoveryError(`the discovery override for ${domain} does not end in /{local}, so its directory cannot be worked out`);
      }
      const collection = override.slice(0, -'/{local}'.length).replaceAll('{domain}', encodeURIComponent(domain));
      return [{ url: collection, method: 'override' }];
    }

    const found: Candidate[] = [];
    const name = `_adtp.${domain}`;
    try {
      for (const chunks of await this.resolveTxt(name)) {
        const value = chunks.join('');
        const url = parseTxtDirectory(value);
        if (url) {
          found.push({ url, method: 'dns', dns_record: { name, value } });
          break;
        }
      }
    } catch {
      // No TXT record (or DNS failure): fall through to the well-known URL.
    }
    const fallback = directoryUrl(domain);
    if (!found.some((c) => c.url === fallback)) found.push({ url: fallback, method: 'well-known' });
    return found;
  }

  /**
   * The directory of a domain: the addresses it lists and what each is for.
   * Cached like a card. Throws a DiscoveryError if the domain publishes none
   * that can be read.
   */
  async directory(input: string): Promise<ResolvedDirectory> {
    const domain = input.trim().toLowerCase();
    const now = this.now();
    const cached = this.directories.get(domain);
    if (cached && cached.expires > now) {
      if (!cached.directory) throw new DiscoveryError(cached.error ?? `could not find a directory for ${domain}`);
      return cached.directory;
    }
    const underWay = this.directoryLookups.get(domain);
    if (underWay) return underWay;
    const lookup = this.lookUpDirectory(domain, now).finally(() => this.directoryLookups.delete(domain));
    this.directoryLookups.set(domain, lookup);
    return lookup;
  }

  private async lookUpDirectory(domain: string, now: number): Promise<ResolvedDirectory> {
    try {
      const directory = await this.limited(() => this.fetchDirectory(domain));
      this.remember(this.directories, domain, { directory, expires: now + (this.opts.cacheTtlMs ?? 300_000) }, now);
      return directory;
    } catch (err) {
      if (err instanceof DiscoveryBusyError) throw err;
      const message = (err as Error).message;
      this.remember(this.directories, domain, { error: message, expires: now + NEGATIVE_TTL_MS }, now);
      throw err instanceof DiscoveryError ? err : new DiscoveryError(message);
    }
  }

  private async fetchDirectory(domain: string): Promise<ResolvedDirectory> {
    const failures: string[] = [];
    for (const candidate of await this.directoryCandidates(domain)) {
      try {
        const { body, url } = await this.get(candidate.url);
        const directory = parseDirectory(JSON.parse(body), domain);
        directory.resolved = { method: candidate.method, url };
        if (candidate.dns_record) directory.resolved.dns_record = candidate.dns_record;
        return directory;
      } catch (err) {
        failures.push(`${candidate.url}: ${(err as Error).message}`);
      }
    }
    throw new DiscoveryError(`could not find a directory for ${domain} (${failures.join('; ')})`);
  }

  /** GETs a card or directory URL, following a few redirects. Every hop goes through the guarded HTTP client. */
  private async get(start: string): Promise<{ body: string; url: string }> {
    let url = start;
    for (let hop = 0; ; hop++) {
      const res = await this.http(url, {
        headers: { accept: 'application/json' },
        allowInsecure: this.opts.allowInsecure ?? false,
        timeoutMs: 8000,
        maxBytes: 256 * 1024,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location;
        if (typeof location !== 'string' || location.length === 0) throw new Error(`HTTP ${res.status} without a Location header`);
        if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
        url = new URL(location, url).toString();
        continue;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return { body: res.body, url };
    }
  }
}
