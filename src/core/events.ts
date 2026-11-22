/**
 * The event feed: how a local agent hears from its node without holding a
 * connection open or running a server of its own.
 *
 * Events are rows in the database, ordered per address. An agent reads "everything
 * for my address after sequence N" and may ask the node to hold the request
 * open until something arrives (long polling).
 *
 *   message  a message was handed to the address by the agent channel
 *   status   a message the address sent reached a new state
 */
import type { AckReason, AckVerification } from '../protocol/types.js';
import type { EventRow, EventType, MessageRow, Store } from './store.js';

/** Every state an outbound message can report to the agent that sent it. */
export type SentStatus = 'accepted' | 'queued' | 'rejected' | 'delivered' | 'read' | 'replied' | 'failed' | 'expired';

export interface StatusDetails {
  reason?: AckReason;
  /** What the recipient's node verified before accepting. */
  verified?: AckVerification;
  /** Who signed the receipt for the message, and with which key. This node checked that signature. */
  receipt?: { by: string; kid: string };
  detail?: string;
}

/** The parts of a sent message a status event needs. */
type SentMessage = Pick<MessageRow, 'id' | 'thread_id' | 'from_addr' | 'receipt_for'>;

const RECHECK_MS = 1000;

export class EventFeed {
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly now: () => Date,
  ) {}

  async publish(address: string, type: EventType, messageId: string, threadId: string, data: Record<string, unknown>): Promise<number> {
    const seq = await this.store.addEvent({ address, type, message_id: messageId, thread_id: threadId, data, created_at: this.now() });
    this.notify();
    return seq;
  }

  /** Wakes every pending long poll. Call after committing events written outside `publish`. */
  notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * The event that says `recipient`'s copy of a message sent by a local address
   * reached `status`, ready to be stored. Null for receipts, which are plumbing
   * rather than something an agent sent.
   */
  statusEvent(message: SentMessage, recipient: string, status: SentStatus, at: Date, details: StatusDetails = {}): Omit<EventRow, 'seq'> | null {
    if (message.receipt_for) return null;
    return {
      address: message.from_addr,
      type: 'status',
      message_id: message.id,
      thread_id: message.thread_id,
      data: { message_id: message.id, thread: message.thread_id, recipient, status, at: at.toISOString(), ...details },
      created_at: this.now(),
    };
  }

  /**
   * Closes every held or pending delivery whose deadline has passed, and tells
   * local senders about theirs. Returns how many were closed.
   */
  async expireOverdue(now: Date): Promise<number> {
    const expired = await this.store.expireDue(now, (row) =>
      row.direction === 'out' ? this.statusEvent(row, row.recipient, 'expired', now, { detail: 'expired before it could be delivered' }) : null,
    );
    if (expired.some((row) => row.direction === 'out')) this.notify();
    return expired.length;
  }

  latest(address: string): Promise<number> {
    return this.store.latestEventSeq(address);
  }

  /**
   * Events for `address` after `after`. With `waitMs`, holds on until one
   * exists or the time is up. The periodic re-check covers events written by
   * another process sharing the database.
   */
  async read(address: string, after: number, limit: number, waitMs = 0): Promise<EventRow[]> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = await this.store.eventsAfter(address, after, limit);
      const remaining = deadline - Date.now();
      if (rows.length > 0 || remaining <= 0 || this.closed) return rows;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(RECHECK_MS, remaining));
        this.waiters.add(done);
      });
    }
  }

  /** Releases every pending long poll (shutdown). */
  close(): void {
    this.closed = true;
    for (const wake of [...this.waiters]) wake();
  }
}

/** The JSON shape of an event in API responses. */
export function eventJson(row: EventRow): Record<string, unknown> {
  return { seq: row.seq, type: row.type, address: row.address, ...row.data };
}
