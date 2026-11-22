/**
 * The directory: the addresses a domain chooses to make findable, each with a
 * line saying what it is for.
 *
 *   {
 *     "adtp": "0",
 *     "domain": "acme.com",
 *     "entries": [
 *       { "address": "ap@acme.com", "type": "agent",
 *         "description": "Accounts payable. Send invoices and payment questions here." }
 *     ]
 *   }
 *
 * A directory says who to write to. It carries no keys and no endpoint: those
 * come from the card of the address that was picked.
 */
import { domainOf, parseAddress } from './address.js';
import { ADTP_VERSION, MAX_DESCRIPTION_LENGTH, MAX_DIRECTORY_ENTRIES } from './constants.js';
import type { Directory, DirectoryEntry, ResolvedDirectory } from './types.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A description as one line of plain text: control characters and line breaks
 * become spaces, and anything past the limit is cut. The text was written by
 * someone else and ends up on terminals and in front of language models.
 */
export function cleanDescription(text: string): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  return [...line].slice(0, MAX_DESCRIPTION_LENGTH).join('').trim();
}

/** The directory a node publishes for `domain`, from the addresses it lists. */
export function buildDirectory(domain: string, listed: DirectoryEntry[]): Directory {
  const entries: DirectoryEntry[] = [];
  for (const item of listed.slice(0, MAX_DIRECTORY_ENTRIES)) {
    const entry: DirectoryEntry = { address: item.address };
    if (item.type) entry.type = item.type;
    const description = item.description ? cleanDescription(item.description) : '';
    if (description) entry.description = description;
    entries.push(entry);
  }
  return { adtp: ADTP_VERSION, domain, entries };
}

/**
 * Validates and normalizes a directory fetched for `domain`. Throws with a
 * readable message if the document is not a directory for that domain. An
 * entry that cannot be used (not an object, no valid address, an address on
 * another domain, a repeat) is left out; the rest stand.
 */
export function parseDirectory(raw: unknown, domain: string): ResolvedDirectory {
  if (!isObject(raw)) throw new Error('directory is not a JSON object');
  if (typeof raw.adtp !== 'string' || !/^0(\.\d+)*$/.test(raw.adtp)) throw new Error('directory: adtp is missing or not a version this node speaks');
  if (typeof raw.domain !== 'string' || raw.domain.toLowerCase() !== domain) {
    throw new Error(`directory is for ${typeof raw.domain === 'string' ? raw.domain : 'no domain'}, not ${domain}`);
  }
  if (!Array.isArray(raw.entries)) throw new Error('directory: entries is missing or not a list');

  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.entries) {
    if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
    if (!isObject(item)) continue;
    const address = parseAddress(item.address);
    if (!address || domainOf(address.address) !== domain || seen.has(address.address)) continue;
    seen.add(address.address);
    const entry: DirectoryEntry = { address: address.address };
    if (item.type === 'agent' || item.type === 'human') entry.type = item.type;
    const description = typeof item.description === 'string' ? cleanDescription(item.description) : '';
    if (description) entry.description = description;
    entries.push(entry);
  }
  return { domain, entries };
}
