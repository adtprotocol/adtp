/**
 * Cards: the discovery document for one address.
 *
 *   {
 *     "adtp": "0",
 *     "address": "agent@stratuslabs.com",
 *     "endpoint": "https://adtp.stratuslabs.com/adtp/v0/messages",
 *     "keys": [{ "kid": "...", "alg": "Ed25519", "public_key": "<base64url>" }],
 *     "accepts": ["inform", "request", ...],
 *     "max_bytes": 262144,
 *     "type": "agent",                       (optional)
 *     "acts_for": "dylan@stratuslabs.com"    (optional, agents only)
 *   }
 *
 * A card says where to send and how to verify. It never contains delivery
 * preferences (routes, channel addresses).
 */
import { parseAddress } from './address.js';
import { ADTP_VERSION, INTENTS, MAX_ENVELOPE_BYTES, SIGNATURE_ALG } from './constants.js';
import type { Card, CardType, PublishedKey, ResolvedCard } from './types.js';

export interface CardSubject {
  address: string;
  type: CardType;
  /** Agents only: the principal this agent acts for. */
  acts_for?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function buildCard(subject: CardSubject, endpoint: string, keys: PublishedKey[]): Card {
  const card: Card = {
    adtp: ADTP_VERSION,
    address: subject.address,
    endpoint,
    keys,
    accepts: [...INTENTS],
    max_bytes: MAX_ENVELOPE_BYTES,
    type: subject.type,
  };
  if (subject.type === 'agent' && subject.acts_for) card.acts_for = subject.acts_for;
  return card;
}

function parseKeys(raw: unknown): PublishedKey[] | null {
  if (!Array.isArray(raw)) return null;
  const keys: PublishedKey[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) return null;
    if (typeof entry.kid !== 'string' || entry.kid.length === 0 || typeof entry.public_key !== 'string') return null;
    if (entry.alg !== SIGNATURE_ALG) continue; // ignore algorithms this version does not know
    if (keys.some((k) => k.kid === entry.kid)) return null; // a key id must name exactly one key
    const key: PublishedKey = { kid: entry.kid, alg: SIGNATURE_ALG, public_key: entry.public_key };
    if (typeof entry.not_after === 'string') key.not_after = entry.not_after;
    keys.push(key);
  }
  return keys;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Validates and normalizes a card. Throws with a readable message if the document is not a usable ADTP card. */
export function parseCard(raw: unknown): ResolvedCard {
  if (!isObject(raw)) throw new Error('card is not a JSON object');
  if (typeof raw.adtp !== 'string' || !/^0(\.\d+)*$/.test(raw.adtp)) throw new Error('card: adtp is missing or not a version this node speaks');
  const address = parseAddress(raw.address);
  if (!address) throw new Error('card: address is missing or invalid');
  if (!isHttpUrl(raw.endpoint)) throw new Error('card: endpoint is missing or not an http(s) URL');
  const keys = parseKeys(raw.keys);
  if (!keys) throw new Error('card: keys is missing or invalid');

  // A card without these two speaks plain v0: every intent, the standard size limit.
  let accepts: string[] = [...INTENTS];
  if (raw.accepts !== undefined) {
    if (!Array.isArray(raw.accepts) || raw.accepts.some((a) => typeof a !== 'string')) throw new Error('card: accepts must be a list of intents');
    accepts = raw.accepts as string[];
  }
  let maxBytes = MAX_ENVELOPE_BYTES;
  if (raw.max_bytes !== undefined) {
    if (typeof raw.max_bytes !== 'number' || !Number.isInteger(raw.max_bytes) || raw.max_bytes <= 0) {
      throw new Error('card: max_bytes must be a positive integer');
    }
    maxBytes = raw.max_bytes;
  }

  const card: ResolvedCard = {
    address: address.address,
    type: raw.type === 'agent' || raw.type === 'human' ? raw.type : null,
    endpoint: raw.endpoint,
    keys,
    accepts,
    max_bytes: maxBytes,
  };
  const principal = parseAddress(raw.acts_for);
  if (principal) card.acts_for = principal.address;
  return card;
}
