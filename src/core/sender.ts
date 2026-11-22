/**
 * The outbound side: turns a draft from a local address into a signed
 * envelope, stores it, and queues one delivery per recipient for the worker.
 */
import { createHash } from 'node:crypto';
import { parseAddress } from '../protocol/address.js';
import {
  ADTP_VERSION,
  DEFAULT_LIFETIME_SECONDS,
  DEFAULT_PRIORITY,
  MAX_ENVELOPE_BYTES,
  type Intent,
  type Priority,
  type ReceiptStatus,
} from '../protocol/constants.js';
import { mintDelegation, peekDelegation } from '../protocol/delegation.js';
import { isIntent, parseTimestamp, receiptParts, validateEnvelope, type ValidatedEnvelope } from '../protocol/envelope.js';
import { newMessageId, newThreadId } from '../protocol/ids.js';
import { contentHash, signEnvelope } from '../protocol/signing.js';
import type { Envelope, Part, UnsignedEnvelope } from '../protocol/types.js';
import { OperationError, type Core } from './context.js';
import type { Answered, MessageRow, NewDelivery, NewMessage } from './store.js';

/** What a local sender (API caller, channel adapter) hands the node to send. */
export interface Draft {
  /** Optional caller-chosen id; resubmitting the same id is a no-op. */
  id?: string;
  from: string;
  to: string[];
  intent: Intent;
  text: string;
  /** Structured payloads; each becomes a data part after the text part. */
  data?: Record<string, unknown>[];
  /** Full control over parts (overrides text/data). Must still include a text part. */
  parts?: Part[];
  thread?: string;
  priority?: Priority;
  /** Defaults to seven days from now. */
  expires_at?: string;
  requires_approval?: boolean;
  /**
   * The principal this message is sent for. Defaults to the sending agent's
   * configured `acts_for`. If the principal is hosted on this node, the node
   * signs the delegation itself; otherwise pass `delegation`. `null` sends
   * as the address itself even if it has an `acts_for`.
   */
  on_behalf_of?: string | null;
  delegation?: string;
}

export interface Submitted {
  id: string;
  thread: string;
  /** False when a message with this id had already been submitted. */
  created: boolean;
}

interface SubmitOptions {
  receiptFor?: string;
  /** Sending to someone makes them a known contact of the sender. Receipts skip this. */
  recordContacts?: boolean;
  /** The received message this one answers. It is marked replied in the same transaction that stores this message. */
  answers?: Answered;
}

interface Signed {
  envelope: Envelope;
  validated: ValidatedEnvelope;
}

/** A signed message as the rows that store it: the message, and one pending delivery per recipient. */
export interface Outgoing {
  message: NewMessage;
  deliveries: NewDelivery[];
}

/** A time as it is written into envelopes: UTC, to the second. Nothing in the protocol needs finer, and it reads better. */
function timestamp(time: Date): string {
  return new Date(Math.floor(time.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export class Sender {
  constructor(private readonly core: Core) {}

  /** Builds and signs the envelope for a draft without storing or sending it. */
  async sign(draft: Draft): Promise<Signed> {
    const { core } = this;
    const now = core.now();

    const from = parseAddress(draft.from);
    const sender = from ? core.domains.lookup(from.address) : null;
    if (!from || !sender) {
      throw new OperationError('unknown_sender', `from: ${String(draft.from)} is not an address hosted on this node`);
    }
    if (!Array.isArray(draft.to) || draft.to.length === 0) throw new OperationError('invalid_message', 'to: at least one recipient is required');
    const to: string[] = [];
    for (const entry of draft.to) {
      const parsed = parseAddress(entry);
      if (!parsed) throw new OperationError('invalid_message', `to: ${String(entry)} is not a valid address`);
      if (!to.includes(parsed.address)) to.push(parsed.address);
    }
    if (!isIntent(draft.intent)) throw new OperationError('invalid_message', 'intent: unknown or missing intent');

    const id = draft.id ?? newMessageId(now.getTime());
    const thread = draft.thread ?? newThreadId(now.getTime());
    const parts: Part[] = draft.parts ?? [
      { type: 'text', text: draft.text },
      ...(draft.data ?? []).map((data): Part => ({ type: 'data', data })),
    ];

    const createdAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
    let expiresAt = new Date(createdAt.getTime() + DEFAULT_LIFETIME_SECONDS * 1000);
    if (draft.expires_at !== undefined) {
      const parsed = parseTimestamp(draft.expires_at);
      if (!parsed) throw new OperationError('invalid_message', 'expires_at: must be an RFC 3339 timestamp');
      if (parsed.getTime() <= now.getTime()) throw new OperationError('invalid_message', 'expires_at is already in the past');
      expiresAt = parsed;
    }

    // Who the message is sent for, and the proof that the sender may do so.
    let principal: string | undefined;
    let delegation: string | undefined;
    const principalInput = draft.on_behalf_of === null ? undefined : (draft.on_behalf_of ?? sender.acts_for);
    if (principalInput !== undefined) {
      principal = parseAddress(principalInput)?.address;
      if (!principal) throw new OperationError('invalid_message', `on_behalf_of: ${String(principalInput)} is not a valid address`);
      const local = core.domains.lookup(principal) !== null;
      if (draft.delegation) {
        delegation = draft.delegation;
        // A token this node's principal took back must not leave here either.
        const jti = peekDelegation(delegation)?.jti;
        if (local && typeof jti === 'string' && (await core.store.isDelegationRevoked(jti))) {
          throw new OperationError('delegation_invalid', 'this delegation token has been revoked', 403);
        }
      } else if (local) {
        // The principal's key lives on this node: sign a token for exactly this message. It
        // covers this one intent and lasts as long as the message can still be delivered.
        const lifetime = Math.ceil((expiresAt.getTime() - createdAt.getTime()) / 1000);
        const ttlSeconds = Math.min(Math.max(lifetime, 60), core.config.delegation.max_ttl_seconds);
        delegation = mintDelegation({ principal, agent: from.address, scope: [draft.intent], ttlSeconds, now: createdAt }, core.keys.signer(principal)).token;
      } else {
        throw new OperationError(
          'delegation_required',
          `on_behalf_of: ${principal} is hosted elsewhere, so a delegation token from its node is required`,
        );
      }
    }

    // Field order follows the example in SPEC.md; it has no effect on the signature.
    const unsigned: UnsignedEnvelope = {
      adtp: ADTP_VERSION,
      id,
      thread,
      from: from.address,
      ...(principal ? { on_behalf_of: principal } : {}),
      to,
      intent: draft.intent,
      priority: draft.priority ?? DEFAULT_PRIORITY,
      created_at: timestamp(createdAt),
      expires_at: timestamp(expiresAt),
      requires_approval: draft.requires_approval === true,
      content: { parts },
      ...(delegation ? { delegation } : {}),
    };

    let envelope: Envelope;
    try {
      envelope = signEnvelope(unsigned, core.keys.signer(from.address));
    } catch (err) {
      // Canonical JSON has no form for some values (NaN, broken Unicode): the draft is at fault, not the node.
      throw new OperationError('invalid_message', (err as Error).message);
    }
    // Never put on the wire what this node itself would refuse to accept.
    const checked = validateEnvelope(envelope);
    if (!checked.ok) throw new OperationError('invalid_message', checked.message);
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (bytes > MAX_ENVELOPE_BYTES) {
      throw new OperationError('too_large', `the message is ${bytes} bytes; the limit is ${MAX_ENVELOPE_BYTES}`, 413);
    }
    return { envelope, validated: checked.value };
  }

  async submit(draft: Draft, opts: SubmitOptions = {}): Promise<Submitted> {
    return this.store(await this.sign(draft), opts);
  }

  private outgoing({ envelope, validated: v }: Signed, opts: SubmitOptions): Outgoing {
    return {
      message: {
        direction: 'out',
        from_addr: v.from,
        id: envelope.id,
        thread_id: v.thread,
        principal: v.principal,
        to_addrs: v.to,
        intent: envelope.intent,
        priority: v.priority,
        expires_at: v.expiresAt,
        requires_approval: v.requiresApproval,
        sender_type: this.core.domains.lookup(v.from)?.type ?? null,
        receipt_for: opts.receiptFor ?? null,
        envelope,
        content_hash: contentHash(envelope),
        ack: null,
      },
      deliveries: v.to.map((recipient) => ({ recipient, state: 'pending' })),
    };
  }

  /** Stores a signed envelope and queues one delivery per recipient. */
  async store(signed: Signed, opts: SubmitOptions = {}): Promise<Submitted> {
    const { core } = this;
    const { envelope, validated: v } = signed;
    const { message, deliveries } = this.outgoing(signed, opts);
    const contacts = opts.recordContacts === false ? [] : v.to.map((peer) => ({ owner: v.from, peer, source: 'outbound' as const }));

    let created: boolean;
    if (opts.answers) {
      const result = await core.store.saveReply(message, deliveries, core.now(), contacts, opts.answers);
      created = result.created;
      if (result.replied) {
        core.log.info('replied', { id: opts.answers.key.message_id, recipient: opts.answers.key.recipient, reply_id: envelope.id });
        core.wake(); // the "replied" receipt is waiting to go out
      }
    } else {
      created = await core.store.saveMessage(message, deliveries, core.now(), contacts);
    }
    if (!created) {
      // This id was submitted before. Answer with what is stored: the envelope just signed
      // was thrown away, and with it any thread id that was made up for it.
      const stored = await core.store.getMessage('out', v.from, envelope.id);
      return { id: envelope.id, thread: stored?.thread_id ?? v.thread, created: false };
    }
    core.log.info('outbound queued', { id: envelope.id, thread: v.thread, from: v.from, intent: envelope.intent, recipients: v.to.length });
    core.wake();
    return { id: envelope.id, thread: v.thread, created: true };
  }

  /**
   * The `status` message that tells the original sender `recipient`'s copy of
   * their message reached a new state: signed, and ready to be stored in the
   * same transaction as the state change it reports (`Store.transitionWith`).
   * Its id is derived from the message and the (recipient, status) pair, so
   * each receipt exists at most once. Null when no receipt is due.
   */
  async receipt(original: MessageRow, recipient: string, status: ReceiptStatus, at: Date): Promise<Outgoing | null> {
    if (original.intent === 'status') return null; // never acknowledge acknowledgements
    const name = `${original.from_addr}|${original.id}|${recipient}|${status}`;
    const signed = await this.sign({
      id: 'msg_rcpt_' + createHash('sha256').update(name).digest('hex').slice(0, 32),
      from: recipient,
      to: [original.from_addr],
      thread: original.thread_id,
      intent: 'status',
      priority: 'low',
      text: '',
      parts: receiptParts({ message_id: original.id, status, at: at.toISOString() }),
      // A receipt speaks for the address itself, not for whoever it acts for.
      on_behalf_of: null,
    });
    return this.outgoing(signed, { receiptFor: original.id });
  }
}
