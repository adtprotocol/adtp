/**
 * The queue worker. One loop serves both queues, which are the same table:
 *
 *   outbound deliveries: POST the signed envelope to the recipient's node
 *   inbound deliveries:  route to a channel adapter and hand the message over
 *
 * A failed attempt is rescheduled with exponential backoff. A delivery ends
 * in exactly one final state: sent/delivered (and onwards), rejected,
 * expired, or failed once attempts run out. There is no dead-letter queue.
 */
import { domainOf } from '../protocol/address.js';
import { ADTP_CONTENT_TYPE } from '../protocol/constants.js';
import { peekDelegation } from '../protocol/delegation.js';
import { verifySignature } from '../protocol/signing.js';
import { parseResponse, recipientOutcome } from '../protocol/wire.js';
import type { Ack, AckReason, Envelope, RecipientAck, ResolvedCard } from '../protocol/types.js';
import { backoffMs } from './backoff.js';
import type { Core } from './context.js';
import type { Receiver } from './receiver.js';
import { selectRoute } from './routing.js';
import type { Sender } from './sender.js';
import { keyOf, type Consequences, type DeliveryRow, type MessageRow } from './store.js';

/** The recipient's node said no, or said something this node cannot accept as an answer. */
class Refused extends Error {
  constructor(readonly reason: AckReason) {
    super(`${reason.code}: ${reason.message}`);
  }
}

const BATCH = 10;
const LEASE_MS = 120_000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long events stay readable on the feed. */
const EVENT_RETENTION_MS = 7 * DAY_MS;

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private wakeRequested = false;
  private current: Promise<unknown> = Promise.resolve();
  private lastPrune = 0;

  constructor(
    private readonly core: Core,
    private readonly receiver: Receiver,
    private readonly sender: Sender,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops the loop and waits for the pass in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current.catch(() => {});
  }

  /** Asks the loop to run a pass now instead of waiting out the poll interval. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) this.wakeRequested = true;
    else this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.loop();
    }, delayMs);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let processed = 0;
    try {
      processed = await this.tick();
    } catch (err) {
      this.core.log.error('worker pass failed', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
    const again = processed > 0 || this.wakeRequested;
    this.wakeRequested = false;
    this.schedule(again ? 0 : this.core.config.delivery.poll_interval_ms);
  }

  /** One pass: expire what is past its deadline, then attempt every due delivery. Returns how many were attempted. */
  async tick(): Promise<number> {
    const { store } = this.core;
    const now = this.core.now();

    const expired = await this.core.events.expireOverdue(now);
    if (expired > 0) this.core.log.info('expired deliveries', { count: expired });

    if (now.getTime() - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now.getTime();
      await store.pruneRateCounters(new Date(now.getTime() - DAY_MS));
      await store.pruneEvents(new Date(now.getTime() - EVENT_RETENTION_MS));
      // A stored message is also what stops its id from being accepted twice, so it stays at
      // least a day past the point where it could no longer be accepted anyway.
      const purged = await store.purgeMessages(new Date(now.getTime() - this.core.config.limits.retention_days * DAY_MS), new Date(now.getTime() - DAY_MS));
      if (purged > 0) this.core.log.info('purged old messages', { count: purged, retention_days: this.core.config.limits.retention_days });
    }

    const claimed = await store.claimDue(now, BATCH, LEASE_MS);
    // Different recipients are attempted in parallel; deliveries to the same recipient go one
    // after another, oldest first, so a peer sees "read" before "replied" and a reply after both.
    const lanes = new Map<string, DeliveryRow[]>();
    for (const delivery of claimed) {
      const lane = `${delivery.direction}:${delivery.recipient}`;
      lanes.set(lane, [...(lanes.get(lane) ?? []), delivery]);
    }
    await Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (const delivery of lane) {
          try {
            const message = await store.getMessage(delivery.direction, delivery.from_addr, delivery.message_id);
            if (!message) continue;
            if (delivery.direction === 'out') await this.attemptOutbound(delivery, message);
            else await this.attemptInbound(delivery, message);
          } catch (err) {
            // Unexpected (e.g. the database went away mid-attempt): the lease will expire and the delivery is retried.
            this.core.log.error('delivery attempt crashed', { id: delivery.message_id, direction: delivery.direction, error: (err as Error).message });
          }
        }
      }),
    );
    // What the node itself does with messages that were just delivered (automatic replies).
    let responded = 0;
    try {
      responded = (await this.core.respond?.()) ?? 0;
    } catch (err) {
      this.core.log.error('automatic replies failed', { error: (err as Error).message });
    }
    return claimed.length + responded;
  }

  /** Runs passes until nothing is due. Used by tests and the demo to reach a quiet state deterministically. */
  async drain(maxPasses = 25): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      if ((await this.tick()) === 0) return;
    }
  }

  private isExpired(message: MessageRow, now: Date): boolean {
    return message.expires_at.getTime() <= now.getTime();
  }

  /**
   * Ends a delivery in a final state and, in the same transaction, records who
   * is told: the local sender (an event on its feed) if the message was one of
   * theirs, or the other node (a `failed` receipt, without the internal
   * reason) if this node accepted a message and then could not hand it over.
   */
  private async finish(d: DeliveryRow, message: MessageRow, state: 'failed' | 'rejected' | 'expired', error: string, reason?: AckReason): Promise<void> {
    const { events, store } = this.core;
    const now = this.core.now();
    const then: Consequences =
      d.direction === 'out'
        ? { events: [events.statusEvent(message, d.recipient, state, now, { detail: error, reason })] }
        : { message: state === 'failed' ? await this.sender.receipt(message, d.recipient, 'failed', now) : null };
    const moved = await store.transitionWith(keyOf(d), ['pending'], { state, last_error: error }, now, then);
    this.core.log.warn('delivery ended', { id: d.message_id, direction: d.direction, recipient: d.recipient, state, attempts: d.attempts, error });
    if (!moved) return;
    if (d.direction === 'out') events.notify();
    else if (then.message) this.core.wake();
  }

  private async retryOrFail(d: DeliveryRow, message: MessageRow, error: string, retryAfterSeconds = 0): Promise<void> {
    const { delivery } = this.core.config;
    if (d.attempts >= delivery.max_attempts) {
      await this.finish(d, message, 'failed', `gave up after ${d.attempts} attempts: ${error}`);
      return;
    }
    const now = this.core.now();
    // Never sooner than the other node asked for.
    const wait = Math.max(backoffMs(d.attempts, delivery.backoff_base_seconds, delivery.backoff_max_seconds, this.core.random), retryAfterSeconds * 1000);
    await this.core.store.transition(
      keyOf(d),
      ['pending'],
      { next_attempt_at: new Date(now.getTime() + wait), last_error: error },
      now,
    );
    this.core.log.info('delivery will be retried', {
      id: d.message_id,
      direction: d.direction,
      recipient: d.recipient,
      attempt: d.attempts,
      retry_in_ms: wait,
      error,
    });
  }

  // ---- outbound: this node -> the recipient's node ---------------------------------

  private async attemptOutbound(d: DeliveryRow, message: MessageRow): Promise<void> {
    const { core } = this;
    if (this.isExpired(message, core.now())) return this.finish(d, message, 'expired', 'expired before it could be sent');

    // A delegation one of this node's principals has taken back must not leave here, not even on a
    // message that was queued before the revocation. The other node has no way to know about it.
    if (message.principal && message.envelope.delegation && core.domains.lookup(message.principal)) {
      const jti = peekDelegation(message.envelope.delegation)?.jti;
      if (typeof jti === 'string' && (await core.store.isDelegationRevoked(jti))) {
        const reason: AckReason = { code: 'delegation_invalid', message: 'the delegation token this message carries was revoked before the message was sent' };
        return this.finish(d, message, 'rejected', `${reason.code}: ${reason.message}`, reason);
      }
    }

    let ack: Ack;
    let outcome: RecipientAck;
    try {
      if (core.domains.serves(domainOf(d.recipient))) {
        // The recipient lives on this node: hand the envelope straight to the inbound pipeline.
        ack = await this.receiver.receive(message.envelope);
        outcome = ack.recipients?.[d.recipient] ?? { status: ack.status, reason: ack.reason };
      } else {
        const card = await core.resolver.resolve(d.recipient);
        ({ ack, outcome } = await this.post(card, d.recipient, message.envelope));
      }
    } catch (err) {
      if (!(err instanceof Refused)) return this.retryOrFail(d, message, (err as Error).message); // could not reach or resolve: try again
      outcome = { status: 'rejected', reason: err.reason };
      ack = { adtp: message.envelope.adtp, id: message.id, status: 'rejected', reason: err.reason, at: core.now().toISOString() };
    }

    if (outcome.status === 'rejected') {
      const why = outcome.reason ? `${outcome.reason.code}: ${outcome.reason.message}` : 'refused by the recipient node';
      return outcome.reason?.retryable
        ? this.retryOrFail(d, message, why, outcome.reason.retry_after)
        : this.finish(d, message, 'rejected', why, outcome.reason);
    }

    const now = core.now();
    const receipt = ack.by && ack.signature ? { by: ack.by, kid: ack.signature.kid } : undefined;
    // The new state and the event that tells the sending agent are stored together. If a status receipt
    // overtook this ack, the row has already moved on and the receiver reported the acceptance then
    // (see Receiver.acceptReceipt): nothing is written here.
    const moved = await core.store.transitionWith(keyOf(d), ['pending'], { state: 'sent', remote_ack: ack, last_error: null }, now, {
      events: [core.events.statusEvent(message, d.recipient, outcome.status, now, { verified: ack.verified, receipt })],
    });
    core.log.info('outbound sent', { id: d.message_id, recipient: d.recipient, ack: outcome.status, attempts: d.attempts });
    if (moved) core.events.notify();
  }

  /**
   * POSTs the envelope to the recipient's node and returns its verdict for
   * this recipient. Throws `Refused` for an answer that means no, and a plain
   * error when the node could not be reached at all.
   */
  private async post(card: ResolvedCard, recipient: string, envelope: Envelope): Promise<{ ack: Ack; outcome: RecipientAck }> {
    const { core } = this;
    // The card says what the address takes. Do not send what it has already said it will refuse.
    if (!card.accepts.includes(envelope.intent)) {
      throw new Refused({ code: 'intent_not_accepted', message: `${recipient} does not accept the intent "${envelope.intent}"` });
    }
    const body = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > card.max_bytes) {
      throw new Refused({ code: 'too_large', message: `the message is ${bytes} bytes; ${recipient} accepts at most ${card.max_bytes}` });
    }

    const res = await core.http(card.endpoint, {
      method: 'POST',
      headers: { 'content-type': ADTP_CONTENT_TYPE, accept: ADTP_CONTENT_TYPE },
      body,
      allowInsecure: core.config.discovery.allow_insecure,
      timeoutMs: 15_000,
    });

    const answer = parseResponse(res.status, res.headers, res.body);
    if (answer.kind === 'refused') {
      // When the node turned every recipient away one by one, use what it said about this one.
      throw new Refused(answer.recipients?.[recipient]?.reason ?? answer.reason);
    }

    // A receipt counts only if it is about this message and signed by one of its recipients on that node.
    const ack = answer.ack;
    const untrusted = (message: string) => new Refused({ code: 'bad_receipt', message, retryable: true });
    if (ack.id !== envelope.id || ack.from?.toLowerCase() !== envelope.from.toLowerCase()) {
      throw untrusted('the recipient node returned a receipt for a different message');
    }
    const by = ack.by?.toLowerCase();
    if (!by || domainOf(by) !== domainOf(recipient) || !envelope.to.some((to) => to.toLowerCase() === by)) {
      throw untrusted('the recipient node returned a receipt that is not signed by a recipient of the message');
    }
    let signer = by === recipient ? card : await core.resolver.resolve(by);
    let check = verifySignature(ack, signer.keys, core.now());
    if (!check.ok && check.reason === 'unknown_key') {
      signer = await core.resolver.resolve(by, { fresh: true });
      check = verifySignature(ack, signer.keys, core.now());
    }
    if (!check.ok) throw untrusted(`the signature on the recipient node's receipt does not verify (${check.reason})`);

    return { ack, outcome: recipientOutcome(ack, recipient) };
  }

  // ---- inbound: this node -> the recipient's channel ----------------------------------

  private async attemptInbound(d: DeliveryRow, message: MessageRow): Promise<void> {
    const { core } = this;
    if (this.isExpired(message, core.now())) return this.finish(d, message, 'expired', 'expired before it could be delivered');

    const address = core.domains.lookup(d.recipient);
    if (!address) return this.finish(d, message, 'failed', `${d.recipient} is no longer hosted on this node`);

    const route = selectRoute(address.routes, {
      priority: message.priority,
      intent: message.intent,
      from_org: domainOf(message.from_addr),
      sender_type: message.sender_type,
    });
    if (!route) return this.finish(d, message, 'failed', 'no route matches this message and no default route is configured');

    const adapter = core.adapters.get(route.channel);
    if (!adapter) return this.finish(d, message, 'failed', `no adapter is available for channel "${route.channel}"`);
    if (!d.token) return this.finish(d, message, 'failed', 'delivery has no token');
    // Channels without a destination of their own (the agent channel) deliver to the address itself.
    const target = route.to ?? d.recipient;

    let nativeId: string;
    try {
      const payload = await adapter.render(message.envelope, {
        recipient: d.recipient,
        target,
        token: d.token,
        thread: message.thread_id,
        senderType: message.sender_type,
        principal: message.principal,
        verified: message.ack?.verified ?? null,
      });
      // Last look at the clock: rendering may have taken a while, and nothing is delivered after the deadline.
      if (this.isExpired(message, core.now())) return this.finish(d, message, 'expired', 'expired before it could be delivered');
      nativeId = (await adapter.deliver(payload)).native_id;
    } catch (err) {
      return this.retryOrFail(d, message, `${route.channel}: ${(err as Error).message}`);
    }

    // "Delivered" and the receipt that tells the sender so are stored together. If that fails, the
    // delivery is still pending: its lease runs out and the hand-over is repeated (the channel may
    // see the message twice, the sender is never left without its receipt).
    const now = core.now();
    const moved = await core.store.transitionWith(
      keyOf(d),
      ['pending'],
      { state: 'delivered', delivered_at: now, channel: route.channel, target, native_id: nativeId, last_error: null },
      now,
      { message: await this.sender.receipt(message, d.recipient, 'delivered', now) },
    );
    if (!moved) {
      // The recipient already reacted (read or replied) and the delivery was settled then; just note how it got there.
      await core.store.transition(keyOf(d), ['delivered', 'read', 'replied'], { channel: route.channel, target, native_id: nativeId }, now);
      return;
    }
    core.log.info('delivered', { id: d.message_id, recipient: d.recipient, channel: route.channel, attempts: d.attempts });
    core.wake();
  }
}
