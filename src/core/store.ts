/**
 * All SQL lives here, written once for both databases: plain statements with
 * $1-style parameters, no dialect-specific locking or JSON functions. The one
 * exception is marked where it occurs.
 *
 * Every time comparison uses a timestamp passed in by the caller (the node's
 * clock) rather than the database's, so behaviour is deterministic under test.
 *
 * `Store` (the type) is the seam: the node only ever talks to this surface,
 * so a wrapper can hand it another implementation (see ARCHITECTURE.md).
 */
import type { Db, Queryable } from '../db/index.js';
import type { Ack, CardType, Envelope } from '../protocol/types.js';

export type Direction = 'in' | 'out';

export type DeliveryState = 'held' | 'pending' | 'sent' | 'delivered' | 'read' | 'replied' | 'rejected' | 'expired' | 'failed';

/** A message is named by its sender and its id together; two senders may use the same id. */
export interface MessageRow {
  direction: Direction;
  from_addr: string;
  id: string;
  thread_id: string;
  principal: string | null;
  to_addrs: string[];
  intent: string;
  priority: string;
  expires_at: Date;
  requires_approval: boolean;
  sender_type: CardType | null;
  receipt_for: string | null;
  envelope: Envelope;
  /** SHA-256 of the signed bytes. */
  content_hash: string;
  ack: Ack | null;
  /** When this node stored the message. */
  created_at: Date;
}

export interface DeliveryRow {
  /** Creation order. */
  seq: number;
  direction: Direction;
  from_addr: string;
  message_id: string;
  recipient: string;
  state: DeliveryState;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  channel: string | null;
  target: string | null;
  native_id: string | null;
  token: string | null;
  remote_ack: Ack | null;
  delivered_at: Date | null;
  read_at: Date | null;
  replied_at: Date | null;
  updated_at: Date;
}

export type NewMessage = Omit<MessageRow, 'created_at'>;

export interface NewDelivery {
  recipient: string;
  state: DeliveryState;
  token?: string | null;
}

export interface DeliveryKey {
  direction: Direction;
  /** The message's sender. */
  from: string;
  message_id: string;
  recipient: string;
}

export const keyOf = (d: Pick<DeliveryRow, 'direction' | 'from_addr' | 'message_id' | 'recipient'>): DeliveryKey => ({
  direction: d.direction,
  from: d.from_addr,
  message_id: d.message_id,
  recipient: d.recipient,
});

/** Summary of one delivery as embedded in message views. */
export interface DeliverySummary {
  recipient: string;
  state: DeliveryState;
  attempts: number;
  last_error: string | null;
  channel: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  updated_at: string;
}

export type MessageView = MessageRow & { deliveries: DeliverySummary[] };

export interface HeldItem {
  delivery: DeliveryRow;
  message: MessageRow;
}

/** A delivery the expiry sweep just closed, with the parts of its message needed to report it. */
export type ExpiredDelivery = Pick<MessageRow, 'direction' | 'id' | 'thread_id' | 'from_addr' | 'receipt_for'> & { recipient: string };

export type EventType = 'message' | 'status';

export interface EventRow {
  seq: number;
  address: string;
  type: EventType;
  message_id: string;
  thread_id: string;
  data: Record<string, unknown>;
  created_at: Date;
}

/**
 * What follows from a delivery reaching a new state, to be stored together
 * with that change: a message to send (a status receipt for the other node)
 * and events for a local agent's feed.
 */
export interface Consequences {
  message?: { message: NewMessage; deliveries: NewDelivery[] } | null;
  events?: (Omit<EventRow, 'seq'> | null)[];
}

/** The received message an outgoing one answers: the state change that records the answer, and the receipt that reports it. */
export interface Answered {
  key: DeliveryKey;
  from: DeliveryState[];
  patch: DeliveryPatch;
  receipt: { message: NewMessage; deliveries: NewDelivery[] } | null;
}

export type DeliveryPatch = Partial<
  Pick<
    DeliveryRow,
    'state' | 'next_attempt_at' | 'last_error' | 'channel' | 'target' | 'native_id' | 'remote_ack' | 'delivered_at' | 'read_at' | 'replied_at'
  >
>;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function summarize(d: DeliveryRow): DeliverySummary {
  return {
    recipient: d.recipient,
    state: d.state,
    attempts: d.attempts,
    last_error: d.last_error,
    channel: d.channel,
    delivered_at: iso(d.delivered_at),
    read_at: iso(d.read_at),
    replied_at: iso(d.replied_at),
    updated_at: d.updated_at.toISOString(),
  };
}

/** Thrown inside `saveReply` to undo the transaction when the reply turns out not to be new. */
class NotNew extends Error {}

const DELIVERY_WHERE = 'direction = $2 AND from_addr = $3 AND message_id = $4 AND recipient = $5';

export class SqlStore {
  constructor(private readonly db: Db) {}

  // ---- messages ---------------------------------------------------------------

  async getMessage(direction: Direction, from: string, id: string, q: Queryable = this.db): Promise<MessageRow | null> {
    const res = await q.query<MessageRow>('SELECT * FROM messages WHERE direction = $1 AND from_addr = $2 AND id = $3', [direction, from, id]);
    return res.rows[0] ?? null;
  }

  private async insertDeliveries(q: Queryable, msg: Pick<MessageRow, 'direction' | 'from_addr' | 'id'>, deliveries: NewDelivery[], now: Date): Promise<void> {
    for (const d of deliveries) {
      await q.query(
        `INSERT INTO deliveries (direction, from_addr, message_id, recipient, state, next_attempt_at, token, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $6)
         ON CONFLICT (direction, from_addr, message_id, recipient) DO NOTHING`,
        [msg.direction, msg.from_addr, msg.id, d.recipient, d.state, now, d.token ?? null],
      );
    }
  }

  private async insertMessage(q: Queryable, msg: NewMessage, deliveries: NewDelivery[], now: Date): Promise<boolean> {
    const inserted = await q.query(
      `INSERT INTO messages (direction, from_addr, id, thread_id, principal, to_addrs, intent, priority, expires_at,
                             requires_approval, sender_type, receipt_for, envelope, content_hash, ack, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (direction, from_addr, id) DO NOTHING`,
      [
        msg.direction,
        msg.from_addr,
        msg.id,
        msg.thread_id,
        msg.principal,
        JSON.stringify(msg.to_addrs),
        msg.intent,
        msg.priority,
        msg.expires_at,
        msg.requires_approval,
        msg.sender_type,
        msg.receipt_for,
        JSON.stringify(msg.envelope),
        msg.content_hash,
        msg.ack ? JSON.stringify(msg.ack) : null,
        now,
      ],
    );
    if (inserted.rowCount !== 1) return false;
    await this.insertDeliveries(q, msg, deliveries, now);
    return true;
  }

  /**
   * Persists a message and its deliveries atomically. Returns false, changing
   * nothing, if this sender already has a message with this id (in this
   * direction). `contacts` records who the sender has now interacted with.
   */
  async saveMessage(
    msg: NewMessage,
    deliveries: NewDelivery[],
    now: Date,
    contacts: { owner: string; peer: string; source: 'outbound' | 'approved' }[] = [],
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await this.insertMessage(tx, msg, deliveries, now);
      if (!inserted) return false;
      for (const c of contacts) await this.addContact(c.owner, c.peer, c.source, now, tx);
      return true;
    });
  }

  /**
   * Stores an outgoing message that answers a received one, and records that
   * answer, as one unit: the received message becomes `replied`, the receipt
   * that says so is queued, and the reply itself is queued behind it, so the
   * other side hears "replied" and then gets the reply. Either all of it is
   * stored or none of it: the sender is never told a message was answered
   * while the answer is missing.
   *
   * A reply whose id was submitted before changes nothing, as in
   * `saveMessage`: the message already stored under that id may say something
   * else to someone else, so it is no evidence of an answer. Returns whether
   * the reply was new and whether the received message moved.
   */
  async saveReply(
    reply: NewMessage,
    deliveries: NewDelivery[],
    now: Date,
    contacts: { owner: string; peer: string; source: 'outbound' | 'approved' }[],
    answered: Answered,
  ): Promise<{ created: boolean; replied: boolean }> {
    try {
      return await this.db.transaction(async (tx) => {
        // The receipt is stored first so that it leaves first. Whether the reply is new is
        // only known once it is inserted (two submissions can race), so a repeat is undone.
        const replied = await this.transition(answered.key, answered.from, answered.patch, now, tx);
        if (replied && answered.receipt) await this.insertMessage(tx, answered.receipt.message, answered.receipt.deliveries, now);
        if (!(await this.insertMessage(tx, reply, deliveries, now))) throw new NotNew();
        for (const c of contacts) await this.addContact(c.owner, c.peer, c.source, now, tx);
        return { created: true, replied };
      });
    } catch (err) {
      if (err instanceof NotNew) return { created: false, replied: false };
      throw err;
    }
  }

  /**
   * Revises the ack of a message that is already stored and adds the
   * deliveries the revision calls for, atomically. Used when a retried
   * envelope can now be taken for a recipient that was told "try again later"
   * the first time.
   *
   * `revise` is given the ack as it is stored now (two retries can race) and
   * returns the new ack plus the deliveries to add, or null to change nothing.
   * A delivery that already exists is left alone. Returns the ack that is
   * stored when the call ends.
   */
  async reviseMessage(
    direction: Direction,
    from: string,
    id: string,
    revise: (stored: Ack | null) => { ack: Ack; deliveries: NewDelivery[] } | null,
    now: Date,
  ): Promise<Ack | null> {
    return this.db.transaction(async (tx) => {
      // A write that changes nothing: it makes concurrent revisions of this message wait their turn on either database.
      await tx.query('UPDATE messages SET ack = ack WHERE direction = $1 AND from_addr = $2 AND id = $3', [direction, from, id]);
      const current = await this.getMessage(direction, from, id, tx);
      if (!current) return null;
      const revised = revise(current.ack);
      if (!revised) return current.ack;
      await this.insertDeliveries(tx, current, revised.deliveries, now);
      await tx.query('UPDATE messages SET ack = $1 WHERE direction = $2 AND from_addr = $3 AND id = $4', [JSON.stringify(revised.ack), direction, from, id]);
      return revised.ack;
    });
  }

  /**
   * Records a status receipt and everything that follows from it as one
   * unit: the receipt message (which is also its deduplication record), the
   * new state of the delivery it reports on, and the events for the local
   * sender. Either all of it is committed or none of it, so a receipt that
   * failed half way is simply processed again when the other node retries.
   *
   * `events` is told whether the delivery was still waiting for its ack, so
   * the caller can report the acceptance before the receipt's own status.
   * Returns false, changing nothing, if this receipt was already recorded.
   */
  async recordReceipt(
    receipt: NewMessage,
    target: DeliveryKey,
    step: { state: DeliveryState; from: DeliveryState[]; later: DeliveryState[]; patch: DeliveryPatch },
    events: (wasPending: boolean, moved: boolean) => Omit<EventRow, 'seq'>[],
    now: Date,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (!(await this.insertMessage(tx, receipt, [], now))) return false;

      const forward = { last_error: null, state: step.state, ...step.patch };
      // States only move forward. `pending` is tried on its own so we know, without a race, whether the ack was still outstanding.
      const wasPending = step.from.includes('pending') && (await this.transition(target, ['pending'], forward, now, tx));
      const others = step.from.filter((s) => s !== 'pending');
      const moved = wasPending || (others.length > 0 && (await this.transition(target, others, forward, now, tx)));
      // A receipt that arrives after a later one still records its timestamp.
      if (!moved && step.later.length > 0 && Object.keys(step.patch).length > 0) await this.transition(target, step.later, step.patch, now, tx);

      for (const event of events(wasPending, moved)) await this.addEvent(event, tx);
      return true;
    });
  }

  /**
   * Deletes messages (and, with them, their deliveries) that this node stored
   * before `storedBefore` and that expired before `expiredBefore`. A message
   * is also the record that stops its id from being accepted twice, so it is
   * never removed while it could still be accepted: only once expired.
   */
  /**
   * Brings forward the expiry of stored messages that expire after `latest`.
   * A node no longer accepts a message that lives longer than it keeps
   * messages; this applies the same bound to any it stored before that rule,
   * so they too expire and are deleted. The signed envelope is not touched.
   */
  async capExpiry(latest: Date): Promise<number> {
    const res = await this.db.query('UPDATE messages SET expires_at = $1 WHERE expires_at > $1', [latest]);
    return res.rowCount;
  }

  async purgeMessages(storedBefore: Date, expiredBefore: Date): Promise<number> {
    const res = await this.db.query('DELETE FROM messages WHERE created_at < $1 AND expires_at < $2', [storedBefore, expiredBefore]);
    return res.rowCount;
  }

  // ---- contacts & rate limits ---------------------------------------------------

  async isContact(owner: string, peer: string): Promise<boolean> {
    const res = await this.db.query('SELECT 1 AS known FROM contacts WHERE owner = $1 AND peer = $2', [owner, peer]);
    return res.rows.length === 1;
  }

  async addContact(owner: string, peer: string, source: 'outbound' | 'approved', now: Date, q: Queryable = this.db): Promise<void> {
    await q.query(
      'INSERT INTO contacts (owner, peer, source, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (owner, peer) DO NOTHING',
      [owner, peer, source, now],
    );
  }

  /** Increments a fixed-window counter and returns its new value. */
  async bumpRate(key: string, windowStart: Date): Promise<number> {
    const res = await this.db.query<{ count: number }>(
      `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + 1
       RETURNING count`,
      [key, windowStart],
    );
    return res.rows[0]?.count ?? 1;
  }

  async pruneRateCounters(before: Date): Promise<void> {
    await this.db.query('DELETE FROM rate_counters WHERE window_start < $1', [before]);
  }

  // ---- delegation revocations -------------------------------------------------------

  /** Takes back a delegation token by its id. Returns false if it was already revoked. */
  async revokeDelegation(jti: string, now: Date): Promise<boolean> {
    const res = await this.db.query('INSERT INTO revoked_delegations (jti, revoked_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING', [jti, now]);
    return res.rowCount === 1;
  }

  async isDelegationRevoked(jti: string): Promise<boolean> {
    const res = await this.db.query('SELECT 1 AS revoked FROM revoked_delegations WHERE jti = $1', [jti]);
    return res.rows.length === 1;
  }

  // ---- queue ----------------------------------------------------------------------

  /**
   * Marks every held or pending delivery whose message deadline has passed as
   * expired, and returns them. `eventFor` supplies the event, if any, that
   * tells a local sender; it is stored with the change.
   */
  async expireDue(now: Date, eventFor: (row: ExpiredDelivery) => Omit<EventRow, 'seq'> | null = () => null): Promise<ExpiredDelivery[]> {
    const overdue = await this.db.query<ExpiredDelivery>(
      `SELECT d.direction, d.recipient, m.id, m.thread_id, m.from_addr, m.receipt_for
         FROM deliveries d JOIN messages m ON m.direction = d.direction AND m.from_addr = d.from_addr AND m.id = d.message_id
        WHERE d.state IN ('held', 'pending') AND m.expires_at <= $1`,
      [now],
    );
    const expired: ExpiredDelivery[] = [];
    for (const row of overdue.rows) {
      // Guarded like every other transition: whoever moved the row first wins.
      const key: DeliveryKey = { direction: row.direction, from: row.from_addr, message_id: row.id, recipient: row.recipient };
      const patch = { state: 'expired' as const, last_error: 'expired before it could be delivered' };
      if (await this.transitionWith(key, ['held', 'pending'], patch, now, { events: [eventFor(row)] })) expired.push(row);
    }
    return expired;
  }

  /**
   * Claims up to `limit` due deliveries, oldest first (by due time, then
   * creation order). Claiming bumps the attempt counter and pushes
   * next_attempt_at out by the lease, so a crashed worker's claim is retried
   * once the lease runs out. Each claim is a compare-and-swap on the attempt
   * counter, so two workers looking at the same row cannot both take it.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<DeliveryRow[]> {
    const due = await this.db.query<DeliveryRow>(
      `SELECT * FROM deliveries WHERE state = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at, seq LIMIT $2`,
      [now, limit],
    );
    const lease = new Date(now.getTime() + leaseMs);
    const claimed: DeliveryRow[] = [];
    for (const d of due.rows) {
      const res = await this.db.query(
        `UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = $1, updated_at = $6
          WHERE ${DELIVERY_WHERE} AND state = 'pending' AND attempts = $7`,
        [lease, d.direction, d.from_addr, d.message_id, d.recipient, now, d.attempts],
      );
      if (res.rowCount === 1) claimed.push({ ...d, attempts: d.attempts + 1, next_attempt_at: lease, updated_at: now });
    }
    return claimed;
  }

  /**
   * Applies `patch` to a delivery if it is currently in one of the `from`
   * states. Returns whether a row changed, which makes every state transition
   * race-safe: whoever moves the row first wins, everyone else is a no-op.
   */
  async transition(key: DeliveryKey, from: DeliveryState[], patch: DeliveryPatch, now: Date, q: Queryable = this.db): Promise<boolean> {
    const values: unknown[] = [now, key.direction, key.from, key.message_id, key.recipient];
    const sets: string[] = ['updated_at = $1'];
    for (const [column, value] of Object.entries(patch)) {
      values.push(column === 'remote_ack' && value !== null ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}`);
    }
    const states = from.map((state) => {
      values.push(state);
      return `$${values.length}`;
    });
    const res = await q.query(`UPDATE deliveries SET ${sets.join(', ')} WHERE ${DELIVERY_WHERE} AND state IN (${states.join(', ')})`, values);
    return res.rowCount === 1;
  }

  /**
   * `transition`, together with what follows from it, as one unit. If the
   * delivery moves, the receipt that reports the move is queued and the events
   * are written in the same transaction. If it does not move, or anything
   * fails, nothing is written, so whatever retries the step finds the delivery
   * where it was and does all of it again. A state can therefore never be
   * recorded without its report.
   */
  async transitionWith(key: DeliveryKey, from: DeliveryState[], patch: DeliveryPatch, now: Date, then: Consequences): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (!(await this.transition(key, from, patch, now, tx))) return false;
      // The receipt's id is derived from what it reports, so one that is already stored is simply left alone.
      if (then.message) await this.insertMessage(tx, then.message.message, then.message.deliveries, now);
      for (const event of then.events ?? []) {
        if (event) await this.addEvent(event, tx);
      }
      return true;
    });
  }

  async getDelivery(key: DeliveryKey): Promise<DeliveryRow | null> {
    const res = await this.db.query<DeliveryRow>(
      'SELECT * FROM deliveries WHERE direction = $1 AND from_addr = $2 AND message_id = $3 AND recipient = $4',
      [key.direction, key.from, key.message_id, key.recipient],
    );
    return res.rows[0] ?? null;
  }

  /**
   * The deliveries of every message with this id to this recipient. Almost
   * always one; more only if different senders chose the same id.
   */
  async findDeliveries(direction: Direction, messageId: string, recipient: string): Promise<DeliveryRow[]> {
    const res = await this.db.query<DeliveryRow>(
      'SELECT * FROM deliveries WHERE direction = $1 AND message_id = $2 AND recipient = $3 ORDER BY seq',
      [direction, messageId, recipient],
    );
    return res.rows;
  }

  async findInboundByToken(token: string): Promise<HeldItem | null> {
    const res = await this.db.query<DeliveryRow>("SELECT * FROM deliveries WHERE direction = 'in' AND token = $1", [token]);
    const delivery = res.rows[0];
    if (!delivery) return null;
    const message = await this.getMessage('in', delivery.from_addr, delivery.message_id);
    return message ? { delivery, message } : null;
  }

  // ---- requests tray ----------------------------------------------------------------

  async listHeld(): Promise<HeldItem[]> {
    const res = await this.db.query<DeliveryRow>(
      `SELECT d.* FROM deliveries d JOIN messages m ON m.direction = d.direction AND m.from_addr = d.from_addr AND m.id = d.message_id
        WHERE d.direction = 'in' AND d.state = 'held'
        ORDER BY m.created_at, d.seq`,
    );
    const items: HeldItem[] = [];
    for (const delivery of res.rows) {
      const message = await this.getMessage('in', delivery.from_addr, delivery.message_id);
      if (message) items.push({ delivery, message });
    }
    return items;
  }

  /** Messages delivered to `recipient` that it has neither read nor answered yet, oldest first. */
  async listDelivered(recipient: string, limit: number): Promise<HeldItem[]> {
    const res = await this.db.query<DeliveryRow>(
      `SELECT * FROM deliveries WHERE direction = 'in' AND recipient = $1 AND state = 'delivered' ORDER BY seq LIMIT $2`,
      [recipient, limit],
    );
    const items: HeldItem[] = [];
    for (const delivery of res.rows) {
      const message = await this.getMessage('in', delivery.from_addr, delivery.message_id);
      if (message) items.push({ delivery, message });
    }
    return items;
  }

  /**
   * Trusts `sender` on behalf of `recipient` and releases every message from
   * that sender still held for that recipient. Returns how many were released.
   */
  async approveSender(recipient: string, sender: string, now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      await this.addContact(recipient, sender, 'approved', now, tx);
      const res = await tx.query(
        `UPDATE deliveries SET state = 'pending', next_attempt_at = $1, updated_at = $1
          WHERE direction = 'in' AND state = 'held' AND recipient = $2 AND from_addr = $3`,
        [now, recipient, sender],
      );
      return res.rowCount;
    });
  }

  // ---- views --------------------------------------------------------------------------

  /** Attaches each message's per-recipient delivery summaries. */
  private async withDeliveries(messages: MessageRow[]): Promise<MessageView[]> {
    if (messages.length === 0) return [];
    const ids = [...new Set(messages.map((m) => m.id))];
    const res = await this.db.query<DeliveryRow>(
      `SELECT * FROM deliveries WHERE message_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY recipient`,
      ids,
    );
    const name = (direction: string, from: string, id: string) => `${direction} ${from} ${id}`;
    const byMessage = new Map<string, DeliverySummary[]>();
    for (const d of res.rows) {
      const key = name(d.direction, d.from_addr, d.message_id);
      byMessage.set(key, [...(byMessage.get(key) ?? []), summarize(d)]);
    }
    return messages.map((m) => ({ ...m, deliveries: byMessage.get(name(m.direction, m.from_addr, m.id)) ?? [] }));
  }

  async thread(threadId: string): Promise<MessageView[]> {
    const res = await this.db.query<MessageRow>(
      'SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at, direction DESC, id',
      [threadId],
    );
    return this.withDeliveries(res.rows);
  }

  /** The latest messages in either direction. Status receipts are left out: they show up as status on the message they report on. */
  async recent(limit: number): Promise<MessageView[]> {
    const res = await this.db.query<MessageRow>(
      'SELECT * FROM messages WHERE receipt_for IS NULL ORDER BY created_at DESC, id LIMIT $1',
      [limit],
    );
    return this.withDeliveries(res.rows);
  }

  /** Every copy of the messages with this id: sent and received, from whichever sender. */
  async messageViews(id: string): Promise<MessageView[]> {
    const res = await this.db.query<MessageRow>('SELECT * FROM messages WHERE id = $1 ORDER BY direction DESC, from_addr', [id]);
    return this.withDeliveries(res.rows);
  }

  // ---- event feed ---------------------------------------------------------------------

  /**
   * Appends an event for a local address and returns its sequence number.
   * A reader paging with "after seq N" must never skip an event, so sequence
   * order has to equal commit order per address. SQLite has a single writer,
   * which gives that for free. Postgres does not, hence the advisory lock:
   * the one place the two dialects differ.
   */
  async addEvent(event: Omit<EventRow, 'seq'>, q: Queryable = this.db): Promise<number> {
    const values = [event.address, event.type, event.message_id, event.thread_id, JSON.stringify(event.data), event.created_at];
    const sql =
      this.db.dialect === 'postgres'
        ? `WITH guard AS (SELECT pg_advisory_xact_lock(hashtext($1)))
           INSERT INTO events (address, type, message_id, thread_id, data, created_at)
           SELECT $1, $2, $3, $4, $5, $6 FROM guard
           RETURNING seq`
        : `INSERT INTO events (address, type, message_id, thread_id, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING seq`;
    const res = await q.query<{ seq: number }>(sql, values);
    return res.rows[0]!.seq;
  }

  async eventsAfter(address: string, after: number, limit: number): Promise<EventRow[]> {
    const res = await this.db.query<EventRow>(
      'SELECT * FROM events WHERE address = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [address, after, limit],
    );
    return res.rows;
  }

  async latestEventSeq(address: string): Promise<number> {
    const res = await this.db.query<{ seq: number | null }>('SELECT max(seq) AS seq FROM events WHERE address = $1', [address]);
    return res.rows[0]?.seq ?? 0;
  }

  async pruneEvents(before: Date): Promise<void> {
    await this.db.query('DELETE FROM events WHERE created_at < $1', [before]);
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1 AS ok');
  }
}

/**
 * The storage surface the node depends on: every public method of the SQL
 * implementation, and nothing of how it is built.
 */
export type Store = { [K in keyof SqlStore]: SqlStore[K] };
