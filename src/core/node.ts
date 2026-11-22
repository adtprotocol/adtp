/**
 * AdtpNode wires the engine together and exposes the operations the HTTP
 * layer, the CLI and the tests use. It owns no HTTP and no process state.
 */
import { AgentAdapter } from '../adapters/agent.js';
import { emailAdapterFactory } from '../adapters/email.js';
import { AdapterRegistry } from '../adapters/registry.js';
import type { DeliveredItem } from '../adapters/types.js';
import { BUILT_IN_CHANNELS, type NodeConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { Discovery, DiscoveryError, type DirectoryResolver, type Resolver } from '../identity/discovery.js';
import type { KeyStore } from '../identity/keyring.js';
import { httpRequest, type HttpClient } from '../identity/safe-http.js';
import { silentLogger, type Logger } from '../log.js';
import { domainOf, isValidDomain, parseAddress } from '../protocol/address.js';
import { buildCard } from '../protocol/cards.js';
import { buildDirectory } from '../protocol/directory.js';
import { AUTO_REPLY_DATA_TYPE, DELEGATION_AUDIENCE, INTENTS, MAX_ENVELOPE_BYTES, MESSAGES_PATH } from '../protocol/constants.js';
import { mintDelegation, parseScope } from '../protocol/delegation.js';
import type { Ack, Card, Directory, Envelope, PublishedKey, ResolvedCard, ResolvedDirectory } from '../protocol/types.js';
import { OperationError, type Core } from './context.js';
import { ConfigDomainResolver, type DomainResolver } from './domains.js';
import { EventFeed } from './events.js';
import { Receiver, type Received } from './receiver.js';
import { Sender, type Draft, type Submitted } from './sender.js';
import { keyOf, SqlStore, type DeliveryKey, type EventRow, type HeldItem, type MessageRow, type MessageView, type Store } from './store.js';
import { Worker } from './worker.js';

export interface NodeOptions {
  config: NodeConfig;
  /** The database the default store runs on. Not needed when `store` is given. */
  db?: Db;
  /** Signing keys, per hosted address. */
  keys: KeyStore;
  /** Replaces the SQL store (see ARCHITECTURE.md, "Seams"). */
  store?: Store;
  /** Replaces "the addresses in the config file" as the answer to "is this address mine". */
  domains?: DomainResolver;
  log?: Logger;
  now?: () => Date;
  random?: () => number;
  http?: HttpClient;
  /** Replaces DNS/HTTP discovery (tests). Local addresses are still answered locally. */
  resolver?: Resolver;
  /** Replaces the DNS TXT lookup used by discovery (tests). */
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Replaces the lookup of other domains' directories (tests). */
  directories?: DirectoryResolver;
  adapters?: AdapterRegistry;
}

/** How many delivered messages one address answers automatically per worker pass. */
const AUTO_REPLY_BATCH = 20;
/** The most automatic replies one sender gets from one address in an hour. */
const AUTO_REPLIES_PER_SENDER_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

export interface DelegationGrant {
  token: string;
  jti: string;
  principal: string;
  agent: string;
  aud: string;
  scope: string[];
  expires_at: string;
}

export class AdtpNode {
  readonly core: Core;
  readonly receiver: Receiver;
  readonly sender: Sender;
  readonly worker: Worker;
  /** Discovery over DNS and HTTPS, without the shortcut for addresses hosted here. */
  private readonly remote: Resolver;
  /** Looks up other domains' directories. */
  private readonly directories: DirectoryResolver;

  private constructor(opts: NodeOptions, adapters: AdapterRegistry) {
    const { config } = opts;
    const log = opts.log ?? silentLogger;
    const http = opts.http ?? httpRequest;
    const domains = opts.domains ?? new ConfigDomainResolver(config.domain, config.addresses);
    if (!opts.store && !opts.db) throw new Error('AdtpNode needs a database (db) or a store');

    const local = (address: string): ResolvedCard | null => {
      if (!domains.serves(domainOf(address))) return null;
      const hosted = domains.lookup(address);
      if (!hosted) throw new DiscoveryError(`${address} is not hosted on this node`);
      const card: ResolvedCard = {
        address,
        type: hosted.type,
        endpoint: this.endpoint,
        keys: opts.keys.publicKeys(address),
        accepts: [...INTENTS],
        max_bytes: MAX_ENVELOPE_BYTES,
        resolved: { method: 'local' },
      };
      if (hosted.acts_for) card.acts_for = hosted.acts_for;
      return card;
    };
    const discovery = new Discovery({
      overrides: config.discovery.overrides,
      allowInsecure: config.discovery.allow_insecure,
      cacheTtlMs: config.discovery.cache_ttl_seconds * 1000,
      http,
      resolveTxt: opts.resolveTxt,
    });
    const remote: Resolver = (this.remote = opts.resolver ?? discovery);
    this.directories = opts.directories ?? discovery;
    const resolver: Resolver = {
      resolve: async (address, o) => local(parseAddress(address)?.address ?? address) ?? remote.resolve(address, o),
    };

    const now = opts.now ?? (() => new Date());
    const store: Store = opts.store ?? new SqlStore(opts.db!);
    this.core = {
      config,
      domains,
      store,
      events: new EventFeed(store, now),
      keys: opts.keys,
      resolver,
      adapters,
      http,
      log,
      now,
      random: opts.random ?? Math.random,
      wake: () => this.worker.kick(),
      respond: () => this.answerAutomatically(),
    };
    // The built-in channels (agent, inbox): delivery means an event on the address's feed.
    for (const channel of BUILT_IN_CHANNELS) {
      if (!adapters.get(channel)) {
        adapters.set(new AgentAdapter((p) => this.core.events.publish(p.address, 'message', p.message_id, p.thread, p.data), channel));
      }
    }
    this.receiver = new Receiver(this.core);
    this.sender = new Sender(this.core);
    this.worker = new Worker(this.core, this.receiver, this.sender);
  }

  static async create(opts: NodeOptions): Promise<AdtpNode> {
    const adapters = opts.adapters ?? new AdapterRegistry();
    if (!adapters.hasFactory('email')) adapters.register('email', emailAdapterFactory);
    await adapters.loadPlugins(opts.config.plugins);
    await adapters.init(opts.config.channels, {
      node: { domain: opts.config.domain, public_url: opts.config.public_url },
      log: opts.log ?? silentLogger,
    });
    return new AdtpNode(opts, adapters);
  }

  get config(): NodeConfig {
    return this.core.config;
  }

  get store(): Store {
    return this.core.store;
  }

  /** URL other nodes POST envelopes to, as published in cards. */
  get endpoint(): string {
    return `${this.core.config.public_url}${MESSAGES_PATH}`;
  }

  /** The keys published for a hosted address (by default, for the node's first address). */
  publicKeys(address: string = this.core.domains.list()[0]?.address ?? ''): PublishedKey[] {
    return this.core.keys.publicKeys(address);
  }

  /** The card served at /.well-known/adtp/{local}, or null if the address is not hosted here. */
  card(address: string): Card | null {
    const hosted = this.core.domains.lookup(address.toLowerCase());
    if (!hosted) return null;
    return buildCard({ address: hosted.address, type: hosted.type, acts_for: hosted.acts_for }, this.endpoint, this.core.keys.publicKeys(hosted.address));
  }

  /**
   * The directory this node publishes for a domain it serves: the addresses
   * marked `listed`, each with its description. Served at /.well-known/adtp.
   */
  publishedDirectory(domain: string = this.core.config.domain): Directory {
    const listed = this.core.domains.list().filter((a) => a.listed === true && domainOf(a.address) === domain);
    return buildDirectory(domain, listed.map((a) => ({ address: a.address, type: a.type, description: a.description })));
  }

  /**
   * The directory of any domain: who can be written to there, and what each
   * address is for. A domain this node serves is answered from its own
   * settings; with `external` it is looked up through DNS and HTTPS like any
   * other, which shows what the rest of the world sees.
   */
  async directory(domain: string, opts: { external?: boolean } = {}): Promise<ResolvedDirectory> {
    const name = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
    if (!isValidDomain(name)) throw new OperationError('invalid_domain', 'a directory is looked up by domain, e.g. acme.com');
    if (!opts.external && this.core.domains.serves(name)) {
      return { domain: name, entries: this.publishedDirectory(name).entries, resolved: { method: 'local' } };
    }
    return this.directories.directory(name);
  }

  // ---- messaging -------------------------------------------------------------------

  receive(rawEnvelope: unknown): Promise<Ack> {
    return this.receiver.receive(rawEnvelope);
  }

  /** As `receive`, and also says whether the envelope repeated a message already stored. */
  handle(rawEnvelope: unknown): Promise<Received> {
    return this.receiver.handle(rawEnvelope);
  }

  /**
   * Signs, stores and queues a message from a hosted address. With
   * `inReplyTo`, the received message it answers is marked as replied, in the
   * same transaction that stores the reply: the other side is never told
   * "replied" for an answer that was not queued. The "replied" receipt is
   * queued ahead of the reply, so they hear "replied" and then get the reply.
   *
   * A message answers a received one only if it is addressed to that
   * message's sender. Naming a received message while writing to someone else
   * marks nothing: the message still goes out, as an ordinary one.
   */
  async submit(draft: Draft, opts: { inReplyTo?: string | { message_id: string; from?: string } } = {}): Promise<Submitted> {
    const signed = await this.sender.sign(draft); // throws on an invalid draft before anything is recorded
    if (!opts.inReplyTo) return this.sender.store(signed);

    const answered = typeof opts.inReplyTo === 'string' ? { message_id: opts.inReplyTo } : opts.inReplyTo;
    const replier = signed.validated.from;
    const sender = answered.from?.toLowerCase();
    const addressed = sender === undefined ? signed.validated.to : signed.validated.to.filter((to) => to === sender);
    const item = await this.inbound(answered.message_id, replier, addressed);
    if (!item) return this.sender.store(signed); // nothing here to mark: the message still goes out
    const now = this.core.now();
    const key = keyOf(item.delivery);
    await this.settleDelivery(key, item, now);
    return this.sender.store(signed, {
      answers: {
        key,
        from: ['delivered', 'read'],
        patch: { state: 'replied', replied_at: now },
        receipt: await this.sender.receipt(item.message, key.recipient, 'replied', now),
      },
    });
  }

  /** Builds and signs the envelope a draft would be sent as, without storing or sending anything. */
  async preview(draft: Draft): Promise<Envelope> {
    return (await this.sender.sign(draft)).envelope;
  }

  /**
   * How an address resolves from this node: its card and where the card was
   * found. With `external`, an address hosted here is looked up through DNS
   * and HTTPS like any other, which shows what the rest of the world sees.
   */
  resolve(address: string, opts: { fresh?: boolean; external?: boolean } = {}): Promise<ResolvedCard> {
    if (opts.external) return this.remote.resolve(address, { fresh: true });
    return this.core.resolver.resolve(address, opts);
  }

  /**
   * Signs "agent may send these intents for principal". The principal must be
   * hosted here, since this node holds its key. The token is good for a day
   * unless a shorter or longer life (up to the configured maximum) is asked for.
   */
  delegate(principal: string, agent: string, opts: { ttlSeconds?: number; scope?: unknown; audience?: string } = {}): DelegationGrant {
    const { delegation } = this.core.config;
    const p = parseAddress(principal);
    const a = parseAddress(agent);
    if (!p || !this.core.domains.lookup(p.address)) {
      throw new OperationError('unknown_principal', `${principal} is not an address hosted on this node`);
    }
    if (!a) throw new OperationError('invalid_agent', `${agent} is not a valid address`);
    const ttlSeconds = Math.floor(opts.ttlSeconds ?? delegation.default_ttl_seconds);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new OperationError('invalid_ttl', 'ttl_seconds must be positive');
    if (ttlSeconds > delegation.max_ttl_seconds) {
      throw new OperationError('invalid_ttl', `ttl_seconds may be at most ${delegation.max_ttl_seconds} on this node (delegation.max_ttl_hours)`);
    }
    const scope = parseScope(opts.scope);
    if (!scope) throw new OperationError('invalid_scope', `scope must list the intents the agent may send: any of ${INTENTS.join(', ')}`);
    const audience = opts.audience ?? DELEGATION_AUDIENCE;
    if (audience !== DELEGATION_AUDIENCE) {
      let origin = '';
      try {
        origin = new URL(audience).origin;
      } catch {
        /* not a URL */
      }
      if (origin !== audience) throw new OperationError('invalid_audience', 'audience must be "adtp" or the origin of one node, e.g. https://adtp.example.com');
    }
    const { token, claims } = mintDelegation(
      { principal: p.address, agent: a.address, scope, ttlSeconds, audience, now: this.core.now() },
      this.core.keys.signer(p.address),
    );
    this.core.log.info('delegation issued', { jti: claims.jti, principal: p.address, agent: a.address, scope: scope.join(' '), ttl_seconds: ttlSeconds });
    return { token, jti: claims.jti, principal: p.address, agent: a.address, aud: audience, scope, expires_at: new Date(claims.exp * 1000).toISOString() };
  }

  /**
   * Takes a delegation token back by its id. From then on this node neither
   * sends nor accepts messages that carry it. Returns false if it was already revoked.
   */
  async revokeDelegation(jti: string): Promise<boolean> {
    if (typeof jti !== 'string' || jti.length === 0 || jti.length > 200) throw new OperationError('invalid_jti', 'a delegation id (jti) is required');
    const revoked = await this.core.store.revokeDelegation(jti, this.core.now());
    if (revoked) this.core.log.info('delegation revoked', { jti });
    return revoked;
  }

  // ---- automatic replies -------------------------------------------------------------

  /**
   * Deals with what was delivered to the addresses that have an `auto_reply`:
   * each message is either answered with that text or marked read, so every
   * one leaves the "delivered" state exactly once. Either step is one
   * transaction; if the node stops in between, the message is still
   * "delivered" and is dealt with on the next pass. Returns how many messages
   * were dealt with.
   */
  private async answerAutomatically(): Promise<number> {
    const { store, log } = this.core;
    let handled = 0;
    for (const address of this.core.domains.list()) {
      if (!address.auto_reply) continue;
      for (const { message } of await store.listDelivered(address.address, AUTO_REPLY_BATCH)) {
        const sender = message.from_addr;
        try {
          const reason = await this.whyNotAnswered(address.address, message);
          if (reason) {
            await this.markReadBy(message.id, address.address, sender);
            log.info('not answered automatically', { id: message.id, recipient: address.address, reason });
          } else {
            await this.submit(
              { from: address.address, to: [sender], intent: 'inform', thread: message.thread_id, text: address.auto_reply, data: [{ type: AUTO_REPLY_DATA_TYPE }] },
              { inReplyTo: { message_id: message.id, from: sender } },
            );
            log.info('answered automatically', { id: message.id, recipient: address.address });
          }
          handled++;
        } catch (err) {
          // Left as it is: still "delivered", so the next pass tries again.
          log.warn('automatic reply failed', { id: message.id, recipient: address.address, error: (err as Error).message });
        }
      }
    }
    return handled;
  }

  /**
   * Why a delivered message gets no automatic reply, or null if it gets one.
   * These are what keep an auto-responder from talking in circles: it never
   * answers another automatic message, answers a thread once, and stops
   * answering a sender who keeps starting new threads.
   */
  private async whyNotAnswered(address: string, message: MessageRow): Promise<string | null> {
    const automatic = message.envelope.content.parts.some((part) => part.type === 'data' && part.data.type === AUTO_REPLY_DATA_TYPE);
    if (automatic) return 'it is an automatic message itself';
    const thread = await this.core.store.thread(message.thread_id);
    if (thread.some((m) => m.direction === 'out' && m.from_addr === address && !m.receipt_for)) return 'this address already wrote on the thread';
    const window = new Date(Math.floor(this.core.now().getTime() / HOUR_MS) * HOUR_MS);
    const count = await this.core.store.bumpRate(`autoreply:${address}:${message.from_addr}`, window);
    if (count > AUTO_REPLIES_PER_SENDER_PER_HOUR) return 'this sender has had its automatic replies for the hour';
    return null;
  }

  // ---- requests tray -----------------------------------------------------------------

  /** First-contact messages waiting for a decision, oldest first. Expired ones are not listed. */
  async tray(): Promise<HeldItem[]> {
    await this.core.events.expireOverdue(this.core.now());
    return this.core.store.listHeld();
  }

  /**
   * Finds `recipient`'s copy of a received message. An id is only unique per
   * sender, so `from` settles it in the rare case two senders chose the same.
   * With `from`, only a message from one of those senders is found.
   */
  private async inbound(messageId: string, recipient: string, from?: string | string[]): Promise<HeldItem | null> {
    const { store } = this.core;
    const mine = recipient.toLowerCase();
    let found = await store.findDeliveries('in', messageId, mine);
    if (from !== undefined) {
      const senders = (Array.isArray(from) ? from : [from]).map((f) => f.toLowerCase());
      found = found.filter((d) => senders.includes(d.from_addr));
    }
    if (found.length > 1) {
      throw new OperationError('ambiguous_message', 'more than one sender used this message id; pass "from" to say which message is meant', 409);
    }
    const delivery = found[0];
    const message = delivery ? await store.getMessage('in', delivery.from_addr, messageId) : null;
    return delivery && message ? { delivery, message } : null;
  }

  /**
   * Approves a held message: the sender becomes a known contact of the
   * recipient and everything held from that sender for that recipient is
   * released for delivery.
   */
  async approve(messageId: string, recipient: string, from?: string): Promise<{ released: number }> {
    const { store } = this.core;
    const now = this.core.now();
    const item = await this.inbound(messageId, recipient, from);
    if (!item) throw new OperationError('not_found', 'no such message in the requests tray', 404);
    const { delivery, message } = item;
    if (delivery.state !== 'held') throw new OperationError('not_pending', `this message is ${delivery.state}, not awaiting approval`, 409);
    if (message.expires_at.getTime() <= now.getTime()) {
      await store.transition(keyOf(delivery), ['held'], { state: 'expired', last_error: 'expired before it was approved' }, now);
      throw new OperationError('expired', 'this message expired and can no longer be delivered', 409);
    }
    const released = await store.approveSender(delivery.recipient, message.from_addr, now);
    this.core.log.info('tray approved', { id: messageId, recipient: delivery.recipient, sender: message.from_addr, released });
    this.core.wake();
    return { released };
  }

  /** Rejects a held message. It is never delivered and the sender stays unknown. */
  async reject(messageId: string, recipient: string, from?: string): Promise<void> {
    const now = this.core.now();
    const item = await this.inbound(messageId, recipient, from);
    const moved = item
      ? await this.core.store.transition(keyOf(item.delivery), ['held'], { state: 'rejected', last_error: 'rejected from the requests tray' }, now)
      : false;
    if (!moved) throw new OperationError('not_pending', 'no such message awaiting approval', 404);
    this.core.log.info('tray rejected', { id: messageId, recipient: item!.delivery.recipient });
  }

  // ---- channel events ------------------------------------------------------------------

  /** Records that the recipient opened a delivered message (read-receipt beacon). Unknown tokens are ignored. */
  async markRead(token: string): Promise<boolean> {
    const item = await this.core.store.findInboundByToken(token);
    if (!item) return false;
    return this.markReadBy(item.message.id, item.delivery.recipient, item.message.from_addr);
  }

  /** Records that `recipient` read a message delivered to it, and tells the sender. Returns whether anything changed. */
  async markReadBy(messageId: string, recipient: string, from?: string): Promise<boolean> {
    const { store } = this.core;
    const now = this.core.now();
    const item = await this.inbound(messageId, recipient, from);
    if (!item) return false;
    const key = keyOf(item.delivery);
    await this.settleDelivery(key, item, now);
    // The new state and the receipt that reports it are stored together: never one without the other.
    const receipt = await this.sender.receipt(item.message, key.recipient, 'read', now);
    const moved = await store.transitionWith(key, ['delivered'], { state: 'read', read_at: now }, now, { message: receipt });
    if (!moved) return false;
    this.core.log.info('read', { id: messageId, recipient: key.recipient });
    this.core.wake();
    return true;
  }

  /**
   * A recipient can react faster than the worker finishes its bookkeeping: an
   * agent may mark a message read the instant it is handed over, while the
   * delivery row still says `pending`. A read or reply for a delivery that is
   * mid-attempt proves the handoff happened, so it is recorded as delivered
   * (and the sender told) before the read or reply is applied.
   */
  private async settleDelivery(key: DeliveryKey, item: HeldItem, now: Date): Promise<void> {
    if (item.delivery.state !== 'pending' || item.delivery.attempts === 0) return;
    const receipt = await this.sender.receipt(item.message, key.recipient, 'delivered', now);
    const moved = await this.core.store.transitionWith(key, ['pending'], { state: 'delivered', delivered_at: now, last_error: null }, now, { message: receipt });
    if (moved) this.core.wake();
  }

  /**
   * Feeds a native event from a channel (e.g. an email reply) to its adapter.
   * If the adapter turns it into a message, the node signs and sends it, and
   * marks the message it answers as replied.
   */
  async ingest(channel: string, event: unknown): Promise<Submitted | null> {
    const adapter = this.core.adapters.get(channel);
    if (!adapter) throw new OperationError('unknown_channel', `no adapter named "${channel}"`, 404);
    const { store } = this.core;

    const ingested = await adapter.ingest(event, {
      findDelivery: async (token): Promise<DeliveredItem | null> => {
        const item = await store.findInboundByToken(token);
        if (!item) return null;
        return {
          message: item.message.envelope,
          thread: item.message.thread_id,
          recipient: item.delivery.recipient,
          target: item.delivery.target,
          channel: item.delivery.channel,
        };
      },
    });
    if (!ingested) return null;

    return this.submit(ingested.draft, { inReplyTo: ingested.in_reply_to });
  }

  // ---- event feed (local agents) ----------------------------------------------------------

  /** Events for a hosted address after sequence `after`; optionally waits for one to arrive. */
  async events(address: string, after: number, opts: { limit?: number; waitMs?: number } = {}): Promise<EventRow[]> {
    const hosted = this.hostedAddress(address);
    return this.core.events.read(hosted, after, Math.min(Math.max(opts.limit ?? 100, 1), 500), opts.waitMs ?? 0);
  }

  /** The newest sequence number on an address's feed (0 if empty). */
  async latestEvent(address: string): Promise<number> {
    return this.core.events.latest(this.hostedAddress(address));
  }

  private hostedAddress(address: string): string {
    const parsed = parseAddress(address);
    if (!parsed || !this.core.domains.lookup(parsed.address)) {
      throw new OperationError('unknown_address', `${address} is not an address hosted on this node`, 404);
    }
    return parsed.address;
  }

  // ---- views -----------------------------------------------------------------------------

  /** Every copy of a message this node holds (sent and/or received), with per-recipient delivery state. */
  status(id: string): Promise<MessageView[]> {
    return this.core.store.messageViews(id);
  }

  thread(threadId: string): Promise<MessageView[]> {
    return this.core.store.thread(threadId);
  }

  recent(limit = 100): Promise<MessageView[]> {
    return this.core.store.recent(limit);
  }

  async close(): Promise<void> {
    this.core.events.close();
    await this.worker.stop();
    await this.core.adapters.close();
  }
}
