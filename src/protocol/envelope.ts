import { parseAddress } from './address.js';
import {
  DEFAULT_LIFETIME_SECONDS,
  DEFAULT_PRIORITY,
  INTENTS,
  MAX_ID_LENGTH,
  MAX_RECIPIENTS,
  PRIORITIES,
  RECEIPT_DATA_TYPE,
  RECEIPT_STATUSES,
  SIGNATURE_ALG,
  type Intent,
  type Priority,
  type ReceiptStatus,
} from './constants.js';
import type { Envelope, MessageContent, Part, Receipt } from './types.js';

/** An envelope that passed structural validation, with normalized views of its fields. */
export interface ValidatedEnvelope {
  /** The envelope exactly as received. This is what was signed and what gets stored. */
  envelope: Envelope;
  from: string;
  /** Normalized, de-duplicated recipients. */
  to: string[];
  /** Normalized `on_behalf_of`, if any. */
  principal: string | null;
  thread: string;
  priority: Priority;
  createdAt: Date;
  /** The envelope's `expires_at`, or created_at + 7 days when it has none. */
  expiresAt: Date;
  requiresApproval: boolean;
}

export type ValidationResult =
  | { ok: true; value: ValidatedEnvelope }
  | { ok: false; id: string | null; message: string };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~_-]*$/;
const VERSION_RE = /^0(\.\d+)*$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH && ID_RE.test(v);
}

/** Parses an RFC 3339 timestamp. Returns null for anything else, including dates without a time or an offset. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !RFC3339_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Structural validation of an ADTP envelope. Checks shape only: the clock,
 * signatures, delegation and trust are checked later in the pipeline.
 */
export function validateEnvelope(raw: unknown): ValidationResult {
  const id = isObject(raw) && isId(raw.id) ? raw.id : null;
  const fail = (message: string): ValidationResult => ({ ok: false, id, message });

  if (!isObject(raw)) return fail('envelope must be a JSON object');
  if (typeof raw.adtp !== 'string' || !VERSION_RE.test(raw.adtp)) {
    return fail('adtp: unsupported or missing protocol version (expected "0")');
  }
  if (!isId(raw.id)) return fail('id: required, 1-200 letters, digits or . _ : ~ -');
  if (raw.thread !== undefined && !isId(raw.thread)) {
    return fail('thread: must be 1-200 letters, digits or . _ : ~ -');
  }

  const from = parseAddress(raw.from);
  if (!from) return fail('from: required, must be an address of the form local@domain');

  if (!Array.isArray(raw.to) || raw.to.length === 0) return fail('to: required, must be a non-empty array of addresses');
  if (raw.to.length > MAX_RECIPIENTS) return fail(`to: at most ${MAX_RECIPIENTS} recipients`);
  const to: string[] = [];
  for (const entry of raw.to) {
    const parsed = parseAddress(entry);
    if (!parsed) return fail('to: every entry must be an address of the form local@domain');
    if (!to.includes(parsed.address)) to.push(parsed.address);
  }

  if (typeof raw.intent !== 'string' || !(INTENTS as readonly string[]).includes(raw.intent)) {
    return fail(`intent: required, must be one of ${INTENTS.join(', ')}`);
  }

  if (raw.priority !== undefined && !(PRIORITIES as readonly unknown[]).includes(raw.priority)) {
    return fail(`priority: must be one of ${PRIORITIES.join(', ')}`);
  }

  const createdAt = parseTimestamp(raw.created_at);
  if (!createdAt) return fail('created_at: required, must be an RFC 3339 timestamp');

  let expiresAt = new Date(createdAt.getTime() + DEFAULT_LIFETIME_SECONDS * 1000);
  if (raw.expires_at !== undefined) {
    const parsed = parseTimestamp(raw.expires_at);
    if (!parsed) return fail('expires_at: must be an RFC 3339 timestamp');
    expiresAt = parsed;
  }

  if (raw.requires_approval !== undefined && typeof raw.requires_approval !== 'boolean') {
    return fail('requires_approval: must be a boolean');
  }

  let principal: string | null = null;
  if (raw.on_behalf_of !== undefined) {
    const parsed = parseAddress(raw.on_behalf_of);
    if (!parsed) return fail('on_behalf_of: must be an address of the form local@domain');
    principal = parsed.address;
  }
  if (raw.delegation !== undefined) {
    if (typeof raw.delegation !== 'string' || raw.delegation.length === 0) return fail('delegation: must be a non-empty token string');
    if (!principal) return fail('delegation: only meaningful together with on_behalf_of');
  }

  const contentError = validateContent(raw.content);
  if (contentError) return fail(contentError);

  const signature = raw.signature;
  if (!isObject(signature)) return fail('signature: required, must be an object with alg, kid and value');
  if (signature.alg !== SIGNATURE_ALG) return fail(`signature.alg: must be "${SIGNATURE_ALG}"`);
  if (typeof signature.kid !== 'string' || signature.kid.length === 0 || signature.kid.length > MAX_ID_LENGTH) {
    return fail('signature.kid: required, the id of the signing key as published in the sender\'s card');
  }
  if (typeof signature.value !== 'string' || !BASE64URL_RE.test(signature.value) || Buffer.from(signature.value, 'base64url').length !== 64) {
    return fail('signature.value: must be a base64url-encoded Ed25519 signature (64 bytes)');
  }

  const envelope = raw as unknown as Envelope;
  return {
    ok: true,
    value: {
      envelope,
      from: from.address,
      to,
      principal,
      thread: envelope.thread ?? envelope.id,
      priority: envelope.priority ?? DEFAULT_PRIORITY,
      createdAt,
      expiresAt,
      requiresApproval: envelope.requires_approval === true,
    },
  };
}

function validateContent(content: unknown): string | null {
  if (!isObject(content)) return 'content: required, must be an object with a parts array';
  if (!Array.isArray(content.parts) || content.parts.length === 0) return 'content.parts: required, must be a non-empty array';
  let hasText = false;
  for (const part of content.parts) {
    if (!isObject(part) || typeof part.type !== 'string') return 'content.parts: every part needs a type';
    if (part.type === 'text') {
      if (typeof part.text !== 'string') return 'content.parts: text parts need a text string';
      if (part.text.trim().length > 0) hasText = true;
    } else if (part.type === 'data') {
      if (!isObject(part.data)) return 'content.parts: data parts need a data object';
    } else if (part.type === 'file') {
      if (!isHttpUrl(part.url)) return 'content.parts: file parts need an http(s) url';
      if (part.name !== undefined && typeof part.name !== 'string') return 'content.parts: a file name must be a string';
      if (part.media_type !== undefined && typeof part.media_type !== 'string') return 'content.parts: a file media_type must be a string';
      if (part.size !== undefined && (typeof part.size !== 'number' || !Number.isInteger(part.size) || part.size < 0)) {
        return 'content.parts: a file size must be a whole number of bytes';
      }
    } else {
      return `content.parts: unknown part type "${part.type}"`;
    }
  }
  if (!hasText) return 'content.parts: at least one non-empty text part is required';
  return null;
}

export function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

/** All text parts of a message, in order, separated by blank lines. */
export function textOf(content: MessageContent): string {
  return content.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

const RECEIPT_PHRASE: Record<ReceiptStatus, string> = {
  delivered: 'was delivered',
  read: 'was read',
  replied: 'was replied to',
  failed: 'could not be delivered',
};

/** Builds the two parts of a status receipt: a human-readable line and the machine-readable record. */
export function receiptParts(receipt: Receipt): Part[] {
  return [
    { type: 'text', text: `Message ${receipt.message_id} ${RECEIPT_PHRASE[receipt.status]} (${receipt.at}).` },
    { type: 'data', data: { type: RECEIPT_DATA_TYPE, ...receipt } },
  ];
}

/** Returns the status receipt carried by a `status` message, if it is one. */
export function receiptOf(envelope: Envelope): Receipt | null {
  if (envelope.intent !== 'status') return null;
  for (const part of envelope.content.parts) {
    if (part.type !== 'data' || part.data.type !== RECEIPT_DATA_TYPE) continue;
    const { message_id, status, at } = part.data;
    if (typeof message_id !== 'string' || message_id.length === 0) return null;
    if (typeof status !== 'string' || !(RECEIPT_STATUSES as readonly string[]).includes(status)) return null;
    // A receipt without a usable time of its own happened, as far as anyone can tell, when it was written.
    const when = parseTimestamp(at) ? (at as string) : envelope.created_at;
    return { message_id, status: status as ReceiptStatus, at: when };
  }
  return null;
}
