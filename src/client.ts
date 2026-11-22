/**
 * A tiny client for a node's local API: send a message, check its status.
 * This is a stub for tests, the demo and the CLI, not an SDK.
 */
import type { ResolvedDirectory } from './protocol/types.js';

export interface SendInput {
  from: string;
  to: string | string[];
  intent: string;
  text: string;
  data?: Record<string, unknown> | Record<string, unknown>[];
  id?: string;
  thread?: string;
  priority?: 'low' | 'normal' | 'urgent';
  expires_at?: string;
  requires_approval?: boolean;
  /** The principal the message is sent for; defaults to the sending agent's configured acts_for. `null` sends as the address itself. */
  on_behalf_of?: string | null;
  /** Needed only when the principal is hosted on another node. */
  delegation?: string;
  /** Id of a received message this one answers; that message is then marked replied. */
  in_reply_to?: string;
}

export interface SendResult {
  id: string;
  thread: string;
  created: boolean;
}

export interface DeliveryStatus {
  recipient: string;
  state: string;
  attempts: number;
  last_error: string | null;
  channel: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
}

export interface MessageCopy {
  direction: 'in' | 'out';
  id: string;
  thread: string;
  from: string;
  to: string[];
  intent: string;
  text: string;
  receipt_for: string | null;
  created_at: string;
  deliveries: DeliveryStatus[];
}

export interface MessageStatus {
  id: string;
  /** The copies this node holds: the one it sent and/or the one it received. */
  copies: MessageCopy[];
}

export class AdtpClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class AdtpClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: { baseUrl: string; token: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  /** Performs an authenticated request against the node's API. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const err = (parsed ?? {}) as { error?: string; message?: string };
      throw new AdtpClientError(res.status, err.error ?? 'error', err.message ?? `HTTP ${res.status}`);
    }
    return parsed as T;
  }

  /** Asks the node to sign and send a message from one of its addresses. */
  send(message: SendInput): Promise<SendResult> {
    return this.request<SendResult>('POST', '/api/v0/messages', message);
  }

  /** Who can be written to at a domain, and what each address is for. Fails if the domain publishes no directory. */
  directory(domain: string, opts: { external?: boolean } = {}): Promise<ResolvedDirectory> {
    return this.request<ResolvedDirectory>('GET', `/api/v0/directory?domain=${encodeURIComponent(domain)}${opts.external ? '&external=true' : ''}`);
  }

  /** Per-recipient delivery state of a message this node sent or received. */
  status(id: string): Promise<MessageStatus> {
    return this.request<MessageStatus>('GET', `/api/v0/messages/${encodeURIComponent(id)}`);
  }
}
