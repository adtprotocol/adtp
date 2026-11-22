/**
 * Wire-level constants for ADTP v0.
 *
 * Everything in src/protocol/ mirrors SPEC.md. If the two disagree, SPEC.md
 * wins and the fix belongs in this directory.
 */

/** Value of the `adtp` field in envelopes, receipts and cards. */
export const ADTP_VERSION = '0';

/** Protocol tag used in the `_adtp.{domain}` DNS TXT record (`v=adtp0`). */
export const ADTP_DNS_VERSION_TAG = 'adtp0';

/** Media type of an envelope on the wire. */
export const ADTP_CONTENT_TYPE = 'application/adtp+json';

/** Path of the node-to-node endpoint. Cards publish the full URL. */
export const MESSAGES_PATH = '/adtp/v0/messages';

/** Well-known path prefix for cards. */
export const WELL_KNOWN_PREFIX = '/.well-known/adtp/';

/** Well-known path of a domain's directory: the collection its cards sit under. */
export const DIRECTORY_PATH = '/.well-known/adtp';

/** A directory is for entry points, not a staff list: entries past this many are ignored. */
export const MAX_DIRECTORY_ENTRIES = 100;

/** Longest description of a directory entry, in characters. Longer ones are cut. */
export const MAX_DESCRIPTION_LENGTH = 500;

/**
 * `data.type` of the data part that marks a message as sent automatically,
 * without a person or a model deciding to send it. Nothing answers such a
 * message automatically, which is what keeps two auto-responders from
 * answering each other forever.
 */
export const AUTO_REPLY_DATA_TYPE = 'adtp.auto_reply';

/** Largest envelope, in bytes of its JSON text, a node must accept. Cards may publish a different `max_bytes`. */
export const MAX_ENVELOPE_BYTES = 262_144;

export const INTENTS = [
  'inform',
  'request',
  'propose',
  'accept',
  'decline',
  'commit',
  'status',
  'cancel',
  'approval.request',
  'approval.response',
] as const;

export type Intent = (typeof INTENTS)[number];

/** Intents a sender the recipient has never interacted with may use. */
export const UNKNOWN_SENDER_INTENTS: readonly Intent[] = ['inform', 'request'];

export const PRIORITIES = ['low', 'normal', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = 'normal';

/** Delivery states a receiving node reports back to the sender as `status` messages. */
export const RECEIPT_STATUSES = ['delivered', 'read', 'replied', 'failed'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** `type` of the data part that marks a `status` message as a status receipt. */
export const RECEIPT_DATA_TYPE = 'adtp.receipt';

/** The only signature algorithm in v0. */
export const SIGNATURE_ALG = 'Ed25519';

/** `typ` header of delegation tokens. */
export const DELEGATION_TOKEN_TYP = 'adtp-delegation+jwt';

/** Audience of a delegation token that is valid at any ADTP node. */
export const DELEGATION_AUDIENCE = 'adtp';

/** How far in the future `created_at` (and a delegation's `iat`) may lie: allowance for clock drift. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

/** A message without `expires_at` expires this long after `created_at`. */
export const DEFAULT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** Default for how old `created_at` may be before a node refuses the message, whatever its `expires_at` says. */
export const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const MAX_RECIPIENTS = 50;
export const MAX_ID_LENGTH = 200;
