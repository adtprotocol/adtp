/**
 * The channel adapter interface.
 *
 * An adapter turns an ADTP message into whatever a channel natively carries
 * (an email, a Slack post, ...) and turns native events from that channel
 * back into ADTP messages:
 *
 *   render(message)      -> native payload
 *   deliver(payload)     -> receipt
 *   ingest(native event) -> ADTP message
 *   capabilities()
 */
import type { Logger } from '../log.js';
import type { Intent } from '../protocol/constants.js';
import type { AckVerification, CardType, Envelope, Part } from '../protocol/types.js';

export interface AdapterCapabilities {
  /** The channel can tell the node when the recipient opened a message. */
  read_receipts: boolean;
  /** The channel can carry replies back to the node (via ingest). */
  replies: boolean;
  /** How structured (data) parts reach the recipient. */
  structured_data: 'native' | 'summarized' | 'dropped';
  /** How file parts reach the recipient. */
  files: 'native' | 'attached' | 'linked' | 'dropped';
}

/** What an adapter needs to know about one delivery besides the message itself. */
export interface RenderContext {
  /** The ADTP address this copy is being delivered to. */
  recipient: string;
  /** Channel destination from the matched route (e.g. an email address). */
  target: string;
  /** Unguessable per-delivery token, for read tracking and for matching replies. */
  token: string;
  thread: string;
  senderType: CardType | null;
  /** Verified principal the sender acts for, if any. */
  principal: string | null;
  /** What this node verified before accepting the message. */
  verified: AckVerification | null;
}

export interface DeliveryReceipt {
  /** The channel's own identifier for what was delivered (e.g. an SMTP Message-ID). */
  native_id: string;
  detail?: string;
}

/** A message produced by a channel, ready for the node to sign and send. */
export interface IngestedMessage {
  draft: {
    /** Stable id derived from the native event, so a redelivered event is not sent twice. */
    id?: string;
    from: string;
    to: string[];
    thread: string;
    intent: Intent;
    text: string;
    parts?: Part[];
  };
  /** Set when the native event is a reply to something this node delivered. */
  in_reply_to?: { message_id: string; from: string };
}

export interface DeliveredItem {
  message: Envelope;
  thread: string;
  recipient: string;
  target: string | null;
  channel: string | null;
}

export interface IngestContext {
  /** Looks up a past delivery by the token the adapter embedded when rendering it. */
  findDelivery(token: string): Promise<DeliveredItem | null>;
}

/** What an inbound webhook request looks like to an adapter deciding whether to trust it. */
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
  rawBody: string;
}

export interface ChannelAdapter<Payload = unknown> {
  readonly name: string;
  capabilities(): AdapterCapabilities;
  render(message: Envelope, ctx: RenderContext): Payload | Promise<Payload>;
  deliver(payload: Payload): Promise<DeliveryReceipt>;
  /** Returns null for events that are not messages (or not for us). */
  ingest(event: unknown, ctx: IngestContext): Promise<IngestedMessage | null>;
  /**
   * Authenticates a request to POST /hooks/{name}. Adapters without this
   * method cannot receive webhooks.
   */
  authenticate?(request: WebhookRequest): boolean;
  close?(): void | Promise<void>;
}

export interface AdapterFactoryContext {
  /** This adapter's section of `channels` in the node config. */
  config: unknown;
  node: { domain: string; public_url: string };
  log: Logger;
}

export type AdapterFactory = (ctx: AdapterFactoryContext) => ChannelAdapter | Promise<ChannelAdapter>;
