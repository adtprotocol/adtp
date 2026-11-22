/**
 * How envelopes and their answers travel between nodes.
 *
 *   POST {endpoint}                      (the URL in the recipient's card)
 *   Content-Type: application/adtp+json
 *   body: one signed envelope
 *
 *   202  stored; body is the signed acceptance receipt
 *   200  a repeat of a message already stored; body is the receipt it got
 *   4xx / 5xx  refused; body is { "error", "message", "retryable" }
 *
 * A sender retries only when `retryable` is true, on 429, on 5xx and when the
 * request itself fails.
 */
import { ADTP_CONTENT_TYPE } from './constants.js';
import { isSignature } from './signing.js';
import type { Ack, AckReason, ErrorBody, RecipientAck } from './types.js';

/** HTTP status for each refusal code. Anything not listed is 503 if it can be retried and 400 if not. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  invalid_envelope: 400,
  bad_signature: 401,
  delegation_invalid: 403,
  not_trusted: 403,
  unknown_recipient: 404,
  unknown_receipt_target: 404,
  id_conflict: 409,
  expired: 410,
  too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  sender_unresolvable: 503,
  principal_unresolvable: 503,
};

export function statusFor(reason: AckReason): number {
  return STATUS_BY_CODE[reason.code] ?? (reason.retryable ? 503 : 400);
}

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: Ack | ErrorBody;
}

export function errorBody(reason: AckReason, recipients?: Record<string, RecipientAck>): ErrorBody {
  const body: ErrorBody = { error: reason.code, message: reason.message, retryable: reason.retryable === true };
  if (recipients && Object.keys(recipients).length > 0) body.recipients = recipients;
  return body;
}

/** The HTTP answer for the outcome of the inbound pipeline. */
export function toResponse(ack: Ack, duplicate: boolean): WireResponse {
  const headers: Record<string, string> = { 'content-type': ADTP_CONTENT_TYPE };
  if (ack.status !== 'rejected') return { status: duplicate ? 200 : 202, headers, body: ack };
  const reason = ack.reason ?? { code: 'invalid_envelope', message: 'the message was refused' };
  if (reason.retry_after !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(reason.retry_after)));
  return { status: statusFor(reason), headers, body: errorBody(reason, ack.recipients) };
}

/** What a sending node makes of the answer to its POST. */
export type Outcome =
  | { kind: 'receipt'; ack: Ack }
  | { kind: 'refused'; status: number; reason: AckReason; recipients?: Record<string, RecipientAck> };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * What a receipt says about one recipient, read defensively (the receipt came
 * from another node) and without touching the signed object. Falls back to
 * the receipt's overall status when it does not mention the recipient.
 */
export function recipientOutcome(ack: Ack, recipient: string): RecipientAck {
  return parseRecipients(ack.recipients)?.[recipient.toLowerCase()] ?? { status: ack.status };
}

function parseRecipients(value: unknown): Record<string, RecipientAck> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, RecipientAck> = {};
  for (const [address, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue;
    if (entry.status !== 'accepted' && entry.status !== 'queued' && entry.status !== 'rejected') continue;
    const result: RecipientAck = { status: entry.status };
    if (isObject(entry.reason) && typeof entry.reason.code === 'string') {
      result.reason = {
        code: entry.reason.code,
        message: typeof entry.reason.message === 'string' ? entry.reason.message : entry.reason.code,
        retryable: entry.reason.retryable === true,
      };
      if (typeof entry.reason.retry_after === 'number' && entry.reason.retry_after > 0) result.reason.retry_after = entry.reason.retry_after;
    }
    out[address.toLowerCase()] = result;
  }
  return out;
}

/** Reads the answer to a POST of an envelope. Never throws: an answer that makes no sense is a retryable refusal. */
export function parseResponse(status: number, headers: Record<string, string | string[] | undefined>, text: string): Outcome {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (status === 200 || status === 202) {
    if (isObject(body) && (body.status === 'accepted' || body.status === 'queued') && typeof body.id === 'string' && isSignature(body.signature)) {
      // Handed on exactly as received: it is signed, and changing anything would break the signature.
      return { kind: 'receipt', ack: body as unknown as Ack };
    }
    return {
      kind: 'refused',
      status,
      reason: { code: 'bad_receipt', message: `the recipient node answered HTTP ${status} without a signed receipt`, retryable: true },
    };
  }

  const error = isObject(body) ? body : {};
  const reason: AckReason = {
    code: typeof error.error === 'string' && error.error.length > 0 ? error.error : `http_${status}`,
    message: typeof error.message === 'string' && error.message.length > 0 ? error.message : `the recipient node answered HTTP ${status}`,
    retryable: error.retryable === true || status === 429 || status >= 500,
  };
  const retryAfter = Number(Array.isArray(headers['retry-after']) ? headers['retry-after'][0] : headers['retry-after']);
  if (reason.retryable && Number.isFinite(retryAfter) && retryAfter > 0) reason.retry_after = retryAfter;
  return { kind: 'refused', status, reason, recipients: parseRecipients(error.recipients) };
}
