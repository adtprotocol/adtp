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

export class Discovery implements Resolver, DirectoryResolver {
  private readonly cache = new Map<string, { card?: ResolvedCard; error?: string; expires: number; fetchedAt: number }>();
  private readonly directories = new Map<string, { directory?: ResolvedDirectory; error?: string; expires: number }>();
  private readonly resolveTxt: (name: string) => Promise<string[][]>;
  private readonly http: HttpClient;
  private readonly now: () => number;

  constructor(private readonly opts: DiscoveryOptions = {}) {
    this.resolveTxt = opts.resolveTxt ?? ((name) => dnsPromises.resolveTxt(name));
    this.http = opts.http ?? httpRequest;
    this.now = opts.now ?? Date.now;
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

    try {
      const card = await this.fetchCard(address);
      this.cache.set(address, { card, expires: now + (this.opts.cacheTtlMs ?? 300_000), fetchedAt: now });
      return card;
    } catch (err) {
      const message = (err as Error).message;
      this.cache.set(address, { error: message, expires: now + NEGATIVE_TTL_MS, fetchedAt: now });
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
    try {
      const directory = await this.fetchDirectory(domain);
      this.directories.set(domain, { directory, expires: now + (this.opts.cacheTtlMs ?? 300_000) });
      return directory;
    } catch (err) {
      const message = (err as Error).message;
      this.directories.set(domain, { error: message, expires: now + NEGATIVE_TTL_MS });
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
