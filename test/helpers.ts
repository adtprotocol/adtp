/** Shared fixtures for the test suite. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type {
  AdapterCapabilities,
  ChannelAdapter,
  DeliveryReceipt,
  IngestContext,
  IngestedMessage,
  RenderContext,
} from '../src/adapters/types.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { parseConfig, type NodeConfig } from '../src/config.js';
import { AdtpNode } from '../src/core/node.js';
import { openDatabase, type Db, type Dialect } from '../src/db/index.js';
import { DiscoveryError, type Resolver } from '../src/identity/discovery.js';
import type { KeyStore } from '../src/identity/keyring.js';
import type { HttpClient } from '../src/identity/safe-http.js';
import { silentLogger } from '../src/log.js';
import { ADTP_VERSION, INTENTS, MAX_ENVELOPE_BYTES } from '../src/protocol/constants.js';
import { generateKeyPair, kidFor, privateKeyFromSeed, signBytes, signEnvelope, type Signer } from '../src/protocol/signing.js';
import type { CardType, Envelope, Part, PublishedKey, ResolvedCard, UnsignedEnvelope } from '../src/protocol/types.js';

/**
 * Which database the database-backed suites run against.
 *   TEST_DB=sqlite    (default) a throwaway SQLite file per suite; needs nothing
 *   TEST_DB=postgres  the Postgres at TEST_DATABASE_URL, one schema per suite
 */
export const TEST_DB: Dialect = process.env.TEST_DB === 'postgres' ? 'postgres' : 'sqlite';
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://adtp:adtp@127.0.0.1:5432/adtp_test';

let dbCheck: Promise<boolean> | undefined;

/**
 * Whether the test database is usable. Always true for SQLite. For Postgres,
 * suites skip (loudly) when the server is not reachable.
 */
export function dbAvailable(): Promise<boolean> {
  if (TEST_DB === 'sqlite') return Promise.resolve(true);
  dbCheck ??= (async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return true;
    } catch (err) {
      if (process.env.ADTP_TEST_REQUIRE_DB === '1') {
        throw new Error(`ADTP_TEST_REQUIRE_DB=1 but Postgres is not reachable at TEST_DATABASE_URL: ${(err as Error).message}`);
      }
      process.stderr.write(
        '\n!! TEST_DB=postgres but Postgres is not reachable: database-backed tests are SKIPPED.\n' +
          '!! Start one (docker compose -f docker-compose.test.yml up -d postgres) or set TEST_DATABASE_URL.\n\n',
      );
      return false;
    } finally {
      await client.end().catch(() => {});
    }
  })();
  return dbCheck;
}

export interface TestDb {
  conn: Db;
  drop(): Promise<void>;
}

/** A migrated, empty database of its own, so suites cannot see each other's rows. */
export async function createTestDb(): Promise<TestDb> {
  if (TEST_DB === 'sqlite') {
    const dir = mkdtempSync(path.join(tmpdir(), 'adtp-test-db-'));
    const conn = openDatabase(`sqlite:${path.join(dir, 'adtp.db')}`);
    await conn.migrate(silentLogger);
    return {
      conn,
      drop: async () => {
        await conn.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const schema = 'adtp_test_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const conn = openDatabase(TEST_DATABASE_URL, { schema, max: 5 });
  await conn.migrate(silentLogger);
  return {
    conn,
    drop: async () => {
      await conn.close();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}

/** A controllable clock. */
export class Clock {
  constructor(private ms = Date.parse(TEST_EPOCH)) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Where the test clock starts. Envelopes built by the helpers are created at this instant unless told otherwise. */
export const TEST_EPOCH = '2026-06-01T12:00:00.000Z';

/** An Ed25519 identity for a (possibly remote) party in a test. Also usable as a node's key store. */
export class TestKeys implements Signer, KeyStore {
  readonly publicKey: string;
  readonly kid: string;
  private readonly key;

  constructor() {
    const pair = generateKeyPair();
    this.publicKey = pair.publicKey;
    this.kid = kidFor(pair.publicKey);
    this.key = privateKeyFromSeed(pair.privateKey);
  }

  sign(data: Buffer): { kid: string; signature: Buffer } {
    return { kid: this.kid, signature: signBytes(this.key, data) };
  }

  signer(): Signer {
    return this;
  }

  publicKeys(): PublishedKey[] {
    return [{ kid: this.kid, alg: 'Ed25519', public_key: this.publicKey }];
  }

  rotate(): never {
    throw new Error('test keys do not rotate');
  }

  card(address: string, type: CardType = 'human', endpoint = 'https://remote.test/adtp/v0/messages'): ResolvedCard {
    return { address, type, endpoint, keys: this.publicKeys(), accepts: [...INTENTS], max_bytes: MAX_ENVELOPE_BYTES };
  }
}

export interface EnvelopeInput {
  id?: string;
  thread?: string;
  from: string;
  to: string[];
  intent?: Envelope['intent'];
  text?: string;
  parts?: Part[];
  priority?: Envelope['priority'];
  created_at?: string;
  expires_at?: string;
  requires_approval?: boolean;
  on_behalf_of?: string;
  delegation?: string;
}

export function unsignedEnvelope(input: EnvelopeInput): UnsignedEnvelope {
  const id = input.id ?? randomUUID();
  const env: UnsignedEnvelope = {
    adtp: ADTP_VERSION,
    id,
    thread: input.thread ?? id,
    from: input.from,
    to: input.to,
    intent: input.intent ?? 'inform',
    priority: input.priority ?? 'normal',
    created_at: input.created_at ?? TEST_EPOCH,
    requires_approval: input.requires_approval ?? false,
    content: { parts: input.parts ?? [{ type: 'text', text: input.text ?? 'hello' }] },
  };
  if (input.expires_at) env.expires_at = input.expires_at;
  if (input.on_behalf_of) env.on_behalf_of = input.on_behalf_of;
  if (input.delegation) env.delegation = input.delegation;
  return env;
}

export function signedEnvelope(input: EnvelopeInput, signer: Signer): Envelope {
  return signEnvelope(unsignedEnvelope(input), signer);
}

/** A resolver backed by a map, standing in for DNS + HTTP discovery. */
export class StaticResolver implements Resolver {
  readonly cards = new Map<string, ResolvedCard>();
  readonly failing = new Set<string>();
  lookups = 0;

  add(card: ResolvedCard): this {
    this.cards.set(card.address, card);
    return this;
  }

  /** Always a current card: `fresh` makes no difference here. Tests that need a stale copy replace this method. */
  async resolve(address: string, _opts?: { fresh?: boolean }): Promise<ResolvedCard> {
    this.lookups++;
    const card = this.cards.get(address.toLowerCase());
    if (!card || this.failing.has(address.toLowerCase())) throw new DiscoveryError(`could not resolve ${address}`);
    return card;
  }
}

export interface FakeDelivery {
  message: Envelope;
  ctx: RenderContext;
}

/** A channel adapter that records what it is asked to deliver and can be told to fail. */
export class FakeAdapter implements ChannelAdapter<FakeDelivery> {
  readonly delivered: FakeDelivery[] = [];
  /** Number of upcoming deliver() calls that should throw. */
  failures = 0;
  attempts = 0;
  /** Runs inside deliver(), after the handoff but before the node records it: a recipient reacting instantly. */
  onDeliver: ((payload: FakeDelivery) => Promise<void>) | null = null;

  constructor(readonly name = 'email') {}

  capabilities(): AdapterCapabilities {
    return { read_receipts: true, replies: true, structured_data: 'native', files: 'dropped' };
  }

  render(message: Envelope, ctx: RenderContext): FakeDelivery {
    return { message, ctx };
  }

  async deliver(payload: FakeDelivery): Promise<DeliveryReceipt> {
    this.attempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('channel unavailable');
    }
    this.delivered.push(payload);
    await this.onDeliver?.(payload);
    return { native_id: `fake-${this.delivered.length}` };
  }

  authenticate(): boolean {
    return true;
  }

  /** Test events look like { token, text }: a reply to the delivery with that token. */
  async ingest(event: unknown, ctx: IngestContext): Promise<IngestedMessage | null> {
    const e = event as { token?: string; text?: string; id?: string };
    if (!e.token || !e.text) return null;
    const item = await ctx.findDelivery(e.token);
    if (!item) return null;
    return {
      draft: { id: e.id, from: item.recipient, to: [item.message.from], thread: item.thread, intent: 'inform', text: e.text },
      in_reply_to: { message_id: item.message.id, from: item.message.from },
    };
  }
}

type ConfigOverrides = Record<string, unknown>;

/** A valid node config for `domain` hosting `bob` (human) and `helper` (agent) unless overridden. */
export function testConfig(domain: string, overrides: ConfigOverrides = {}): NodeConfig {
  return parseConfig(
    {
      domain,
      public_url: `https://${domain}`,
      addresses: [
        { local: 'bob', type: 'human', routes: [{ default: true, channel: 'email', to: 'bob@mail.test' }] },
        { local: 'helper', type: 'agent', name: 'Helper', routes: [{ default: true, channel: 'email', to: 'helper@mail.test' }] },
      ],
      channels: { email: { from: `ADTP <adtp@${domain}>`, smtp: { host: '127.0.0.1', port: 1 }, inbound: { token: 'hook-secret' } } },
      delivery: { max_attempts: 3, backoff_base_seconds: 10, backoff_max_seconds: 600 },
      ...overrides,
    },
    {},
    '/tmp',
  );
}

export interface TestNode {
  node: AdtpNode;
  keys: TestKeys;
  adapter: FakeAdapter;
  resolver: StaticResolver;
  clock: Clock;
  db: TestDb;
  close(): Promise<void>;
}

/** A node on its own schema with a fake channel adapter, a static resolver and a manual clock. */
export async function createTestNode(
  domain: string,
  overrides: ConfigOverrides = {},
  shared?: { resolver?: StaticResolver; clock?: Clock; http?: HttpClient },
): Promise<TestNode> {
  const db = await createTestDb();
  const keys = new TestKeys();
  const adapter = new FakeAdapter('email');
  const adapters = new AdapterRegistry();
  adapters.set(adapter);
  const resolver = shared?.resolver ?? new StaticResolver();
  const clock = shared?.clock ?? new Clock();
  const node = await AdtpNode.create({
    config: testConfig(domain, overrides),
    db: db.conn,
    keys,
    resolver,
    adapters,
    http: shared?.http,
    now: clock.now,
    random: () => 1, // no jitter: backoff is exactly the ceiling
  });
  return {
    node,
    keys,
    adapter,
    resolver,
    clock,
    db,
    close: async () => {
      await node.close();
      await db.drop();
    },
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
}

export interface SmtpSink {
  port: number;
  messages: CapturedMail[];
  close(): Promise<void>;
}

/** A minimal SMTP server that accepts every message and keeps it in memory. */
export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let inData = false;
    let current: CapturedMail = { from: '', to: [], raw: '' };
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          messages.push(current);
          current = { from: '', to: [], raw: '' };
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink\r\n250 8BITMIME\r\n');
        else if (verb === 'MAIL') {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          socket.write('250 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Polls until `check` returns a value or the timeout passes. */
export async function eventually<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 8000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
