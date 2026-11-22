import type { Intent, Priority, ReceiptStatus } from './constants.js';

// ---- Message content -----------------------------------------------------------

export interface TextPart {
  type: 'text';
  text: string;
}

/** A structured payload for the receiving agent. `data.type`, when present, names what it is. */
export interface DataPart {
  type: 'data';
  data: Record<string, unknown>;
}

/** A file, by reference. Envelopes never carry file bytes. */
export interface FilePart {
  type: 'file';
  url: string;
  name?: string;
  media_type?: string;
  /** Size in bytes, if the sender knows it. */
  size?: number;
}

export type Part = TextPart | DataPart | FilePart;

export interface MessageContent {
  /** At least one non-empty text part. */
  parts: Part[];
}

// ---- Signatures -----------------------------------------------------------------

export interface Signature {
  alg: 'Ed25519';
  /** Id of the key that made the signature, as published in the signer's card. */
  kid: string;
  /** base64url of the 64-byte signature over the RFC 8785 form of the object without `signature`. */
  value: string;
}

// ---- Envelope -------------------------------------------------------------------

export interface Envelope {
  adtp: string;
  id: string;
  /** Conversation id. A message without one starts a thread named after its id. */
  thread?: string;
  from: string;
  /** Address of the principal the sender acts for. Requires `delegation`. */
  on_behalf_of?: string;
  to: string[];
  intent: Intent;
  priority?: Priority;
  /** RFC 3339 time the sender created (signed) the message. */
  created_at: string;
  /** RFC 3339 time after which the message must not be delivered. Defaults to created_at + 7 days. */
  expires_at?: string;
  requires_approval?: boolean;
  content: MessageContent;
  /** Token signed by the principal's key granting `from` the right to send for it. */
  delegation?: string;
  signature: Signature;
}

export type UnsignedEnvelope = Omit<Envelope, 'signature'>;

// ---- Acceptance receipts ("acks") and errors ------------------------------------------

export type AckStatus = 'accepted' | 'queued' | 'rejected';

/** Why a message, or one recipient's copy of it, was turned away. Mirrors the wire error body. */
export interface AckReason {
  code: string;
  message: string;
  /** True when sending the same message again later may succeed. */
  retryable?: boolean;
  /** For retryable reasons: how many seconds to wait first, when the node knows. */
  retry_after?: number;
}

export interface RecipientAck {
  status: AckStatus;
  reason?: AckReason;
}

/** What the acknowledging node checked before accepting. */
export interface AckVerification {
  /** Id of the sender's published key the envelope signature verified against. */
  signature: string;
  /** The principal whose delegation token verified, when the message was sent on someone's behalf. */
  delegation?: string;
}

/**
 * The answer to a submitted envelope. `accepted` and `queued` acks are the
 * signed acceptance receipts of SPEC.md: they are stored, signed by the
 * receiving node and returned with 202 (or 200 for a repeat). A `rejected` ack
 * is this node's internal form of a refusal; on the wire it becomes an HTTP
 * error with an error body and is never signed or stored.
 */
export interface Ack {
  adtp: string;
  /** Id of the message being acknowledged (null when the envelope was too malformed to read one). */
  id: string | null;
  /** The message's sender. With `id` it names the message. */
  from?: string;
  /** The recipient address whose published key signed this receipt. */
  by?: string;
  status: AckStatus;
  reason?: AckReason;
  /** Outcome per recipient hosted on the acknowledging node. */
  recipients?: Record<string, RecipientAck>;
  verified?: AckVerification;
  at: string;
  signature?: Signature;
}

/** Body of every non-2xx answer from the messages endpoint. */
export interface ErrorBody {
  error: string;
  message: string;
  retryable: boolean;
  /** Present when the node decided per recipient and turned every one of them away. */
  recipients?: Record<string, RecipientAck>;
}

// ---- Cards --------------------------------------------------------------------

export interface PublishedKey {
  kid: string;
  alg: 'Ed25519';
  /** base64url of the raw 32-byte Ed25519 public key. */
  public_key: string;
  /** Signatures verify against this key only until this time. Set on rotated-out keys. */
  not_after?: string;
}

export type CardType = 'human' | 'agent';

/** The discovery document for one address, served at /.well-known/adtp/{local}. */
export interface Card {
  adtp: string;
  address: string;
  /** URL envelopes for this address are POSTed to. */
  endpoint: string;
  keys: PublishedKey[];
  /** Intents this address takes. */
  accepts: Intent[];
  /** Largest envelope, in bytes, the endpoint takes. */
  max_bytes: number;
  type?: CardType;
  /** Agents only: the principal this agent declares it acts for. */
  acts_for?: string;
}

/** How a card was found. Local bookkeeping; never part of a card. */
export interface Resolution {
  method: 'local' | 'override' | 'dns' | 'well-known';
  /** The URL the card was finally served from (after redirects). */
  card_url?: string;
  /** The `_adtp` TXT record that pointed at the card, when DNS was used. */
  dns_record?: { name: string; value: string };
  /**
   * Set when a fresh copy was asked for but this one was fetched too recently
   * to fetch again: the seconds until it may be. Until then, "this card does
   * not list that key" is not a final answer, because the key may be new.
   */
  retry_after?: number;
}

/** A card after validation and normalization. */
export interface ResolvedCard {
  address: string;
  /** Null when the card does not say. */
  type: CardType | null;
  endpoint: string;
  keys: PublishedKey[];
  accepts: string[];
  max_bytes: number;
  acts_for?: string;
  resolved?: Resolution;
}

// ---- Directory ---------------------------------------------------------------------

/** One listed address in a domain's directory. */
export interface DirectoryEntry {
  address: string;
  type?: CardType;
  /** What the address is for: one line of plain text. */
  description?: string;
}

/** The addresses a domain chooses to make findable. One document per domain. */
export interface Directory {
  adtp: string;
  domain: string;
  entries: DirectoryEntry[];
}

/** A directory after validation and normalization, with how it was found. */
export interface ResolvedDirectory {
  domain: string;
  entries: DirectoryEntry[];
  /** Local bookkeeping; never part of a directory. */
  resolved?: {
    method: Resolution['method'];
    /** The URL the directory was finally served from (after redirects). */
    url?: string;
    /** The `_adtp` TXT record that pointed at it, when DNS was used. */
    dns_record?: { name: string; value: string };
  };
}

// ---- Status receipts ---------------------------------------------------------------

/** What a `status` message reports about one recipient's copy of an earlier message. */
export interface Receipt {
  message_id: string;
  status: ReceiptStatus;
  at: string;
}
