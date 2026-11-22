/**
 * The inbound pipeline: everything between "an envelope arrived" and "an
 * answer went back".
 *
 *   validate -> created_at not in the future -> recipient hosted here?
 *     -> verify signature (+ delegation, + revocation for our own principals)
 *     -> seen before? same content: return the receipt it got; different: id_conflict
 *     -> expired, or older than max_age? refuse
 *     -> status receipt? record it and stop
 *     -> per recipient: known sender -> pending | unknown -> held (tray) or refused
 *     -> persist message + deliveries + signed receipt in one transaction
 *     -> receipt
 *
 * Nothing is acknowledged as accepted or queued before it is committed.
 * Refused messages are not stored, so a sender can fix the problem and
 * resend the same id.
 *
 * A message with several recipients can be stored for some of them while
 * another is told "try again later" (the first-contact rate limit). That
 * answer must not be frozen by deduplication: when the sender retries, the
 * recipients that were turned away for a retryable reason are decided again,
 * and the ones that were taken are left exactly as they are.
 */
import { randomBytes } from 'node:crypto';
import { domainOf } from '../protocol/address.js';
import { ADTP_VERSION, DELEGATION_AUDIENCE, MAX_CLOCK_SKEW_SECONDS, UNKNOWN_SENDER_INTENTS } from '../protocol/constants.js';
import { verifyDelegation } from '../protocol/delegation.js';
import { receiptOf, validateEnvelope, type ValidatedEnvelope } from '../protocol/envelope.js';
import { contentHash, signObject, verifySignature } from '../protocol/signing.js';
import type { Ack, AckReason, AckVerification, CardType, Receipt, RecipientAck, ResolvedCard } from '../protocol/types.js';
import { isTrustedByConfig } from '../config.js';
import type { Core } from './context.js';
import type { DeliveryKey, DeliveryPatch, DeliveryState, EventRow, MessageRow, NewDelivery } from './store.js';

type Verified = { ok: true; senderType: CardType | null; verified: AckVerification } | { ok: false; reason: AckReason };

/** The pipeline's answer: the ack, and whether it is the answer to a message that was already stored. */
export interface Received {
  ack: Ack;
  duplicate: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export function newDeliveryToken(): string {
  return randomBytes(16).toString('hex');
}

/** A recipient that was turned away for now and may be taken if the sender tries again. */
function mayRetry(outcome: RecipientAck | undefined): boolean {
  return outcome?.status === 'rejected' && outcome.reason?.retryable === true;
}

/** One message-level verdict from the per-recipient ones: accepted if anyone took it, else queued, else rejected. */
function overall(outcomes: Record<string, RecipientAck>): Ack['status'] {
  const results = Object.values(outcomes);
  if (results.some((o) => o.status === 'accepted')) return 'accepted';
  return results.some((o) => o.status === 'queued') ? 'queued' : 'rejected';
}

/** The deliveries a set of per-recipient verdicts calls for. */
function deliveriesFor(outcomes: Record<string, RecipientAck>): NewDelivery[] {
  const deliveries: NewDelivery[] = [];
  for (const [recipient, outcome] of Object.entries(outcomes)) {
    if (outcome.status === 'rejected') continue;
    deliveries.push({ recipient, state: outcome.status === 'accepted' ? 'pending' : 'held', token: newDeliveryToken() });
  }
  return deliveries;
}

export class Receiver {
  constructor(private readonly core: Core) {}

  /** Runs the whole pipeline for one raw envelope and returns the ack. */
  async receive(raw: unknown): Promise<Ack> {
    return (await this.handle(raw)).ack;
  }

  /** As `receive`, and also says whether the envelope was a repeat. */
  async handle(raw: unknown): Promise<Received> {
    const { core } = this;
    const now = core.now();
    const refuse = (id: string | null, reason: AckReason): Received => ({ ack: this.rejected(id, reason, now), duplicate: false });

    const checked = validateEnvelope(raw);
    if (!checked.ok) return refuse(checked.id, { code: 'invalid_envelope', message: checked.message });
    const v = checked.value;
    const env = v.envelope;

    if (v.createdAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_SECONDS * 1000) {
      return refuse(env.id, { code: 'invalid_envelope', message: 'created_at is in the future' });
    }

    const hosted = v.to.filter((a) => core.domains.lookup(a) !== null);
    if (hosted.length === 0) {
      return refuse(env.id, { code: 'unknown_recipient', message: 'none of the recipients is hosted on this node' });
    }

    const verified = await this.verify(v, now);
    if (!verified.ok) return refuse(env.id, verified.reason);

    const existing = await core.store.getMessage('in', v.from, env.id);
    if (existing) return this.duplicate(existing, v, hosted, now);

    if (v.expiresAt.getTime() <= now.getTime()) {
      return refuse(env.id, { code: 'expired', message: `the message expired at ${v.expiresAt.toISOString()}` });
    }
    const maxAgeMs = core.config.limits.max_age_seconds * 1000;
    if (v.createdAt.getTime() + maxAgeMs <= now.getTime()) {
      return refuse(env.id, { code: 'expired', message: `created_at is older than this node accepts (${core.config.limits.max_age_seconds} seconds)` });
    }

    // A message stays stored until it has expired, so one that expires far ahead would have to be
    // kept far longer than this node keeps messages. It is refused instead.
    const maxLifetimeMs = core.config.limits.max_lifetime_seconds * 1000;
    if (v.expiresAt.getTime() > v.createdAt.getTime() + maxLifetimeMs) {
      const days = Math.floor(core.config.limits.max_lifetime_seconds / 86400);
      return refuse(env.id, { code: 'invalid_envelope', message: `expires_at is more than ${days} days after created_at, which is longer than this node keeps a message` });
    }

    const receipt = receiptOf(env);
    if (receipt) return { ack: await this.acceptReceipt(v, receipt, hosted, verified, now), duplicate: false };

    // Decide, per local recipient, whether this sender may deliver directly.
    const local = v.to.filter((recipient) => core.domains.serves(domainOf(recipient))); // the rest are another node's
    const outcomes = await this.decide(local, v.from, env.intent, now);
    const deliveries = deliveriesFor(outcomes);

    const status = overall(outcomes);
    if (status === 'rejected') {
      // If any recipient may be tried again, say so: the answer as a whole is then "not now", not "no".
      const reasons = Object.values(outcomes).map((o) => o.reason);
      const reason = reasons.find((r) => r?.retryable) ?? reasons[0] ?? { code: 'invalid_envelope', message: 'the message was refused' };
      core.log.info('inbound rejected', { id: env.id, from: v.from, intent: env.intent, code: reason.code });
      return { ack: { adtp: ADTP_VERSION, id: env.id, from: v.from, status, reason, recipients: outcomes, at: now.toISOString() }, duplicate: false };
    }
    const ack = this.sign({ adtp: ADTP_VERSION, id: env.id, from: v.from, by: hosted[0]!, status, recipients: outcomes, verified: verified.verified, at: now.toISOString() });

    const inserted = await core.store.saveMessage(
      {
        direction: 'in',
        from_addr: v.from,
        id: env.id,
        thread_id: v.thread,
        principal: v.principal,
        to_addrs: v.to,
        intent: env.intent,
        priority: v.priority,
        expires_at: v.expiresAt,
        requires_approval: v.requiresApproval,
        sender_type: verified.senderType,
        receipt_for: null,
        envelope: env,
        content_hash: contentHash(env),
        ack,
      },
      deliveries,
      now,
    );
    if (!inserted) {
      // Lost a race with an identical concurrent request: answer as for any other repeat.
      const winner = await core.store.getMessage('in', v.from, env.id);
      return winner ? this.duplicate(winner, v, hosted, now) : { ack, duplicate: false };
    }

    core.log.info('inbound stored', { id: env.id, thread: v.thread, from: v.from, intent: env.intent, ack: status, recipients: deliveries.length });
    if (deliveries.some((d) => d.state === 'pending')) core.wake();
    return { ack, duplicate: false };
  }

  /** Signs an acceptance receipt with the key of the recipient it names in `by`. */
  private sign(ack: Ack & { by: string }): Ack {
    const { signature: _stale, ...unsigned } = ack;
    return signObject(unsigned, this.core.keys.signer(ack.by));
  }

  /**
   * Decides what happens to a message from `sender` for each of the given
   * recipients on this node's domain: taken for delivery (`accepted`), held in
   * the requests tray (`queued`), or turned away (`rejected`, with the reason).
   * Counts once against the first-contact allowance if any recipient does not
   * know the sender yet.
   */
  private async decide(recipients: string[], sender: string, intent: string, now: Date): Promise<Record<string, RecipientAck>> {
    const outcomes: Record<string, RecipientAck> = {};
    const firstContact: string[] = [];
    for (const recipient of recipients) {
      if (!this.core.domains.lookup(recipient)) {
        outcomes[recipient] = { status: 'rejected', reason: { code: 'unknown_recipient', message: `${recipient} is not hosted on this node` } };
      } else if (await this.isKnown(recipient, sender)) {
        outcomes[recipient] = { status: 'accepted' };
      } else if (!(UNKNOWN_SENDER_INTENTS as readonly string[]).includes(intent)) {
        outcomes[recipient] = {
          status: 'rejected',
          reason: {
            code: 'not_trusted',
            message: `${recipient} does not know this sender yet; a first message must use one of: ${UNKNOWN_SENDER_INTENTS.join(', ')}`,
          },
        };
      } else {
        firstContact.push(recipient);
      }
    }
    if (firstContact.length > 0) {
      const limited = await this.rateLimit(sender, now);
      for (const recipient of firstContact) {
        // An address that is open to first contact takes the message at once; any other holds it for approval.
        const open = this.core.domains.lookup(recipient)?.first_contact === 'open';
        outcomes[recipient] = limited ? { status: 'rejected', reason: limited } : { status: open ? 'accepted' : 'queued' };
      }
    }
    return outcomes;
  }

  /**
   * A sender is known to a recipient if it is the recipient itself, is on the
   * recipient's configured allowlist, or has interacted with it before.
   */
  private async isKnown(recipient: string, sender: string): Promise<boolean> {
    if (recipient === sender) return true;
    const hosted = this.core.domains.lookup(recipient);
    if (hosted && isTrustedByConfig(hosted, sender)) return true;
    return this.core.store.isContact(recipient, sender);
  }

  private rejected(id: string | null, reason: AckReason, now: Date): Ack {
    this.core.log.info('inbound rejected', { id, code: reason.code });
    return { adtp: ADTP_VERSION, id, status: 'rejected', reason, at: now.toISOString() };
  }

  /**
   * A message this sender already sent under this id. If it says something
   * else now, the id is taken (`id_conflict`). If it is the same message, it
   * gets the receipt it got the first time, and nothing that was taken is
   * stored or delivered again. The exception is a recipient that was turned
   * away for a retryable reason: a retry is the sender asking again, so that
   * recipient is decided again and, if it can be taken now, the stored
   * message gains a delivery for it and its receipt is brought up to date.
   */
  private async duplicate(stored: MessageRow, v: ValidatedEnvelope, hosted: string[], now: Date): Promise<Received> {
    const { core } = this;
    const id = v.envelope.id;
    if (contentHash(v.envelope) !== stored.content_hash) {
      const reason = { code: 'id_conflict', message: 'this sender already used this id for a different message' };
      return { ack: this.rejected(id, reason, now), duplicate: false };
    }
    core.log.info('inbound duplicate', { id, from: v.from });
    const by = stored.ack?.by ?? hosted[0]!;
    const storedAck: Ack = stored.ack ?? this.sign({ adtp: ADTP_VERSION, id, from: v.from, by, status: 'accepted', at: now.toISOString() });

    // A retry may add a delivery only while the message could still be accepted as new: not after
    // it expired, and not once its created_at is older than this node accepts. After that the stored answer stands.
    const expired = stored.expires_at.getTime() <= now.getTime();
    const tooOld = v.createdAt.getTime() + core.config.limits.max_age_seconds * 1000 <= now.getTime();
    const again = Object.keys(storedAck.recipients ?? {}).filter((recipient) => mayRetry(storedAck.recipients?.[recipient]));
    if (again.length === 0 || expired || tooOld) return { ack: storedAck, duplicate: true };

    const fresh = await this.decide(again, stored.from_addr, stored.intent, now);
    if (Object.values(fresh).every(mayRetry)) {
      // Still turned away. Nothing to store; the answer carries the current "try again after".
      return { ack: this.sign({ ...storedAck, by, recipients: { ...storedAck.recipients, ...fresh } }), duplicate: true };
    }

    let added: NewDelivery[] = [];
    const revised = await core.store.reviseMessage(
      'in',
      stored.from_addr,
      id,
      (current) => {
        // Only recipients that are still waiting for a decision change; a concurrent retry may have settled some.
        const base = current ?? storedAck;
        const settled: Record<string, RecipientAck> = {};
        for (const [recipient, outcome] of Object.entries(fresh)) {
          if (mayRetry(base.recipients?.[recipient])) settled[recipient] = outcome;
        }
        if (Object.keys(settled).length === 0) return null;
        const recipients = { ...base.recipients, ...settled };
        added = deliveriesFor(settled);
        return { ack: this.sign({ ...base, by, status: overall(recipients), recipients }), deliveries: added };
      },
      now,
    );
    if (added.length > 0) {
      core.log.info('inbound retry stored', { id, from: v.from, recipients: added.length });
      if (added.some((d) => d.state === 'pending')) core.wake();
    }
    return { ack: revised ?? storedAck, duplicate: true };
  }

  /**
   * Verifies the envelope signature against the sender's card, and the
   * delegation token against the principal's. A key id the card (as cached)
   * does not list is worth one fresh look at the card: the key may be new.
   */
  private async verify(v: ValidatedEnvelope, now: Date): Promise<Verified> {
    const { resolver } = this.core;
    const env = v.envelope;

    let card;
    try {
      card = await resolver.resolve(v.from);
    } catch (err) {
      return { ok: false, reason: { code: 'sender_unresolvable', message: `could not fetch the sender's card: ${(err as Error).message}`, retryable: true } };
    }
    let check = verifySignature(env, card.keys, now);
    if (!check.ok && check.reason === 'unknown_key') {
      // The copy of the card this node holds does not list that key. The sender may have rotated
      // since: look again. If the look cannot be made right now (the card was fetched too recently,
      // or the fetch fails), the key is neither confirmed nor ruled out, and the honest answer is
      // "try again later", not "bad signature".
      const fresh = await this.lookAgain(v.from);
      if (!fresh.ok) {
        const message = `the envelope is signed with key "${env.signature.kid}", which is not in the copy of ${v.from}'s card this node holds, and ${fresh.why}`;
        return { ok: false, reason: { code: 'sender_unresolvable', message, retryable: true, retry_after: fresh.retry_after } };
      }
      card = fresh.card;
      check = verifySignature(env, card.keys, now);
    }
    if (!check.ok) {
      const message =
        check.reason === 'unknown_key'
          ? `the envelope is signed with key "${env.signature.kid}", which ${v.from} does not publish (or no longer does)`
          : `the envelope signature does not verify against key "${env.signature.kid}" of ${v.from}`;
      return { ok: false, reason: { code: 'bad_signature', message } };
    }
    const verified: AckVerification = { signature: check.kid };

    if (v.principal) {
      const invalid = (message: string): Verified => ({ ok: false, reason: { code: 'delegation_invalid', message } });
      if (!env.delegation) return invalid('on_behalf_of requires a delegation token from the principal');
      let principalCard;
      try {
        principalCard = await resolver.resolve(v.principal);
      } catch (err) {
        return {
          ok: false,
          reason: { code: 'principal_unresolvable', message: `could not fetch the principal's card: ${(err as Error).message}`, retryable: true },
        };
      }
      const input = {
        token: env.delegation,
        principal: v.principal,
        agent: v.from,
        intent: env.intent,
        audiences: [DELEGATION_AUDIENCE, new URL(this.core.config.public_url).origin],
        now,
      };
      let delegation = verifyDelegation({ ...input, keys: principalCard.keys });
      if (!delegation.ok && delegation.unknown_key) {
        // As for the envelope's own key: look again, and if that cannot be done now, say "later".
        const fresh = await this.lookAgain(v.principal);
        if (!fresh.ok) {
          const message = `the delegation token is signed with a key that is not in the copy of ${v.principal}'s card this node holds, and ${fresh.why}`;
          return { ok: false, reason: { code: 'principal_unresolvable', message, retryable: true, retry_after: fresh.retry_after } };
        }
        delegation = verifyDelegation({ ...input, keys: fresh.card.keys });
      }
      if (!delegation.ok) return invalid(delegation.message);
      // Revocation is known only for principals whose keys live here; see DECISIONS.md.
      if (this.core.domains.lookup(v.principal) && (await this.core.store.isDelegationRevoked(delegation.claims.jti))) {
        return invalid('this delegation token has been revoked');
      }
      verified.delegation = v.principal;
    }

    return { ok: true, senderType: card.type, verified };
  }

  /**
   * Fetches an address's card afresh, to look for a key the cached copy does
   * not list. Fails, with the reason and how long to wait when known, if a
   * fresh copy cannot be had right now.
   */
  private async lookAgain(address: string): Promise<{ ok: true; card: ResolvedCard } | { ok: false; why: string; retry_after?: number }> {
    let card: ResolvedCard;
    try {
      card = await this.core.resolver.resolve(address, { fresh: true });
    } catch (err) {
      return { ok: false, why: `the card could not be fetched again: ${(err as Error).message}` };
    }
    const wait = card.resolved?.retry_after;
    if (wait !== undefined) return { ok: false, why: `the card was fetched too recently to fetch again (try again in ${wait}s)`, retry_after: wait };
    return { ok: true, card };
  }

  /**
   * Counts one first-contact message against the sender's and the sender's
   * organization's hourly allowance. Returns a refusal if either is spent.
   */
  private async rateLimit(sender: string, now: Date): Promise<AckReason | null> {
    const limits = this.core.config.rate_limits.unknown_sender;
    const window = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    const reset = window.getTime() + HOUR_MS;
    const limited = (who: string): AckReason => ({
      code: 'rate_limited',
      message: `too many first-contact messages from this ${who}; try again after ${new Date(reset).toISOString()}`,
      retryable: true,
      retry_after: Math.max(1, Math.ceil((reset - now.getTime()) / 1000)),
    });

    const senderCount = await this.core.store.bumpRate(`sender:${sender}`, window);
    if (senderCount > limits.per_sender_per_hour) return limited('sender');
    const orgCount = await this.core.store.bumpRate(`org:${domainOf(sender)}`, window);
    if (orgCount > limits.per_org_per_hour) return limited('organization');
    return null;
  }

  /**
   * A status receipt is consumed by the node: it advances the state of the
   * outbound message it reports on and is kept in the thread history, but is
   * never routed to a channel and never answered with a receipt of its own.
   */
  private async acceptReceipt(
    v: ValidatedEnvelope,
    receipt: Receipt,
    hosted: string[],
    checked: Extract<Verified, { ok: true }>,
    now: Date,
  ): Promise<Ack> {
    const { store, events } = this.core;
    // A receipt is addressed to the sender of the message it reports on, and comes from one of that message's recipients.
    let original: MessageRow | null = null;
    for (const sender of hosted) {
      original = await store.getMessage('out', sender, receipt.message_id);
      if (original) break;
    }
    const key: DeliveryKey | null = original ? { direction: 'out', from: original.from_addr, message_id: original.id, recipient: v.from } : null;
    if (!original || !key || !(await store.getDelivery(key))) {
      return this.rejected(
        v.envelope.id,
        { code: 'unknown_receipt_target', message: 'this receipt does not match a message this node sent to its sender' },
        now,
      );
    }
    const target = original;

    const ack = this.sign({ adtp: ADTP_VERSION, id: v.envelope.id, from: v.from, by: target.from_addr, status: 'accepted', verified: checked.verified, at: now.toISOString() });
    const at = new Date(receipt.at);
    const undeliverable = "the recipient's node could not deliver the message";
    // States only move forward. A receipt that arrives after a later one (a retried "read"
    // landing after "replied") still records its timestamp and is still reported.
    const forward: Record<Receipt['status'], { from: DeliveryState[]; later: DeliveryState[]; patch: DeliveryPatch }> = {
      delivered: { from: ['pending', 'sent'], later: ['read', 'replied'], patch: { delivered_at: at } },
      read: { from: ['pending', 'sent', 'delivered'], later: ['replied'], patch: { read_at: at } },
      replied: { from: ['pending', 'sent', 'delivered', 'read'], later: [], patch: { replied_at: at } },
      // "failed" ends a delivery that never arrived. It never undoes one that did.
      failed: { from: ['pending', 'sent'], later: [], patch: { last_error: undeliverable } },
    };

    // The receipt (which is also what makes a retry of it a repeat), the state it
    // moves the delivery to, and the sender's status events are committed together.
    // If any part fails, none of it is kept and the other node's retry starts over.
    const recorded = await store.recordReceipt(
      {
        direction: 'in',
        from_addr: v.from,
        id: v.envelope.id,
        thread_id: v.thread,
        principal: v.principal,
        to_addrs: v.to,
        intent: v.envelope.intent,
        priority: v.priority,
        expires_at: v.expiresAt,
        requires_approval: false,
        sender_type: checked.senderType,
        receipt_for: receipt.message_id,
        envelope: v.envelope,
        content_hash: contentHash(v.envelope),
        ack,
      },
      key,
      { state: receipt.status, ...forward[receipt.status] },
      (wasPending, moved) => {
        const rows: (Omit<EventRow, 'seq'> | null)[] = [];
        if (receipt.status === 'failed') {
          if (moved) rows.push(events.statusEvent(target, v.from, 'failed', at, { detail: undeliverable }));
        } else {
          // A receipt can overtake the ack of the message it reports on. Keep the sender's feed in order.
          if (wasPending) rows.push(events.statusEvent(target, v.from, 'accepted', at));
          rows.push(events.statusEvent(target, v.from, receipt.status, at));
        }
        return rows.filter((row) => row !== null);
      },
      now,
    );
    if (recorded) {
      events.notify();
      this.core.log.info('receipt recorded', { message_id: receipt.message_id, recipient: v.from, status: receipt.status });
    }
    return ack;
  }
}
