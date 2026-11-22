/**
 * The database layer: both drivers must hand back the same row shapes and
 * give the same transactional guarantees. Runs against whichever database
 * TEST_DB selects; the SQLite-only cases always run.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqlStore as Store } from '../src/core/store.js';
import { contentHash } from '../src/protocol/signing.js';
import { dialectOf, openDatabase, sqlitePath } from '../src/db/index.js';
import { silentLogger } from '../src/log.js';
import { createTestDb, dbAvailable, signedEnvelope, TEST_DB, TestKeys, type TestDb } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';
const keys = new TestKeys();

describe('database URLs', () => {
  it('tells SQLite from Postgres', () => {
    assert.equal(dialectOf('sqlite:/data/adtp.db'), 'sqlite');
    assert.equal(dialectOf('SQLITE::memory:'), 'sqlite');
    assert.equal(dialectOf('postgres://u:p@host/db'), 'postgres');
    assert.equal(dialectOf('postgresql://u:p@host:5432/db?sslmode=require'), 'postgres');
    assert.equal(dialectOf('mysql://host/db'), null);
    assert.equal(dialectOf('/data/adtp.db'), null);
  });

  it('reads the file out of a sqlite: URL', () => {
    assert.equal(sqlitePath('sqlite:/data/adtp.db'), '/data/adtp.db');
    assert.equal(sqlitePath('sqlite:///data/adtp.db'), '/data/adtp.db');
    assert.equal(sqlitePath('sqlite:./local.db'), './local.db');
    assert.equal(sqlitePath('sqlite::memory:'), ':memory:');
  });

  it('refuses URLs it does not understand, and never shows credentials', () => {
    assert.throws(() => openDatabase('mongodb://host/db'), /database_url must be sqlite:<path> or postgres:/);
    const pg = openDatabase('postgres://adtp:s3cret@db.internal:5432/adtp');
    assert.equal(pg.location, 'Postgres at db.internal:5432/adtp');
    assert.ok(!pg.location.includes('s3cret'));
    void pg.close();
  });
});

describe(`database driver (${TEST_DB})`, { skip }, () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.drop();
  });

  const message = (id: string, extra: Record<string, unknown> = {}) => {
    const from = (extra.from_addr as string | undefined) ?? 'alice@a.test';
    const envelope = signedEnvelope({ id, from, to: ['bob@b.test'], parts: [{ type: 'text', text: 'héllo 🎉' }, { type: 'data', data: { z: 1, a: [true, null] } }] }, keys);
    return {
      direction: 'in' as const,
      from_addr: from,
      id,
      thread_id: `thr_${id}`,
      principal: null,
      to_addrs: ['bob@b.test', 'carol@b.test'],
      intent: 'inform',
      priority: 'normal',
      expires_at: new Date('2026-12-01T10:30:00.123Z'),
      requires_approval: true,
      sender_type: 'human' as const,
      receipt_for: null,
      envelope,
      content_hash: contentHash(envelope),
      ack: { adtp: '0', id, status: 'accepted' as const, at: '2026-11-01T00:00:00.000Z' },
      ...extra,
    };
  };
  const key = (id: string, recipient = 'bob@b.test', from = 'alice@a.test') => ({ direction: 'in' as const, from, message_id: id, recipient });

  it('returns timestamps as Dates, JSON as values, booleans as booleans', async () => {
    const store = new Store(t.conn);
    const now = new Date('2026-11-01T12:00:00.456Z');
    const input = message('m1');
    assert.equal(await store.saveMessage(input, [{ recipient: 'bob@b.test', state: 'pending', token: 'tok1' }], now), true);

    const row = (await store.getMessage('in', 'alice@a.test', 'm1'))!;
    assert.ok(row.created_at instanceof Date);
    assert.equal(row.created_at.toISOString(), '2026-11-01T12:00:00.456Z');
    assert.equal(row.expires_at.toISOString(), '2026-12-01T10:30:00.123Z');
    assert.equal(row.content_hash, input.content_hash);
    assert.strictEqual(row.requires_approval, true);
    assert.deepEqual(row.to_addrs, ['bob@b.test', 'carol@b.test']);
    assert.deepEqual(row.envelope, input.envelope);
    assert.equal(JSON.stringify(row.envelope), JSON.stringify(input.envelope), 'the envelope comes back with its keys in the original order');
    assert.deepEqual(row.ack, input.ack);
    assert.strictEqual(row.principal, null);

    const delivery = (await store.getDelivery(key('m1')))!;
    assert.equal(delivery.from_addr, 'alice@a.test');
    assert.equal(typeof delivery.seq, 'number');
    assert.equal(delivery.attempts, 0);
    assert.ok(delivery.next_attempt_at instanceof Date);
    assert.strictEqual(delivery.delivered_at, null);
    assert.strictEqual(delivery.remote_ack, null);

    const plain = message('m2', { requires_approval: false, ack: null });
    await store.saveMessage(plain, [], now);
    const second = (await store.getMessage('in', 'alice@a.test', 'm2'))!;
    assert.strictEqual(second.requires_approval, false);
    assert.strictEqual(second.ack, null);
  });

  it('compares and orders timestamps correctly', async () => {
    const store = new Store(t.conn);
    const base = Date.parse('2026-11-01T12:00:00.000Z');
    // Saved out of order, and across a second boundary where naive text comparison could go wrong.
    for (const [id, offset] of [['late', 1500], ['early', 5], ['middle', 999]] as const) {
      await store.saveMessage(message(id), [{ recipient: 'bob@b.test', state: 'pending' }], new Date(base + offset));
    }
    assert.deepEqual((await store.claimDue(new Date(base + 1000), 10, 60_000)).map((d) => d.message_id), ['early', 'middle']);
    assert.deepEqual((await store.claimDue(new Date(base + 1000), 10, 60_000)).map((d) => d.message_id), [], 'claimed rows are leased');
    assert.deepEqual((await store.claimDue(new Date(base + 2000), 10, 60_000)).map((d) => d.message_id), ['late']);
    assert.deepEqual((await store.claimDue(new Date(base + 61_000), 10, 60_000)).map((d) => d.message_id), ['early', 'middle'], 'leases run out');
  });

  it('gives each due delivery to exactly one of several concurrent workers', async () => {
    const store = new Store(t.conn);
    const now = new Date('2026-11-01T12:00:00.000Z');
    for (let i = 0; i < 12; i++) await store.saveMessage(message(`m${i}`), [{ recipient: 'bob@b.test', state: 'pending' }], now);
    const batches = await Promise.all(Array.from({ length: 6 }, () => store.claimDue(now, 12, 60_000)));
    const claimed = batches.flat().map((d) => d.message_id);
    assert.equal(claimed.length, 12, 'every delivery was claimed');
    assert.equal(new Set(claimed).size, 12, 'and none of them twice');
    assert.ok(batches.flat().every((d) => d.attempts === 1));
  });

  it('names a message by its sender and its id together', async () => {
    const store = new Store(t.conn);
    const now = new Date('2026-11-01T12:00:00.000Z');
    const one = [{ recipient: 'bob@b.test', state: 'pending' as const }];
    assert.equal(await store.saveMessage(message('same-id'), one, now), true);
    assert.equal(await store.saveMessage(message('same-id'), one, now), false, 'the same sender cannot store the id twice');
    assert.equal(await store.saveMessage(message('same-id', { from_addr: 'mallory@m.test' }), one, now), true, 'another sender can use it');

    assert.equal((await store.getMessage('in', 'alice@a.test', 'same-id'))!.from_addr, 'alice@a.test');
    assert.equal((await store.getMessage('in', 'mallory@m.test', 'same-id'))!.from_addr, 'mallory@m.test');
    assert.equal(await store.getMessage('in', 'nobody@x.test', 'same-id'), null);
    assert.deepEqual((await store.findDeliveries('in', 'same-id', 'bob@b.test')).map((d) => d.from_addr).sort(), ['alice@a.test', 'mallory@m.test']);
    assert.deepEqual((await store.messageViews('same-id')).map((m) => [m.from_addr, m.deliveries.length]), [['alice@a.test', 1], ['mallory@m.test', 1]]);

    // Each copy has its own delivery, and moving one leaves the other alone.
    assert.equal(await store.transition(key('same-id', 'bob@b.test', 'mallory@m.test'), ['pending'], { state: 'delivered' }, now), true);
    assert.equal((await store.getDelivery(key('same-id')))!.state, 'pending');
  });

  it('purges messages only once they are both old and expired, deliveries with them', async () => {
    const store = new Store(t.conn);
    const day = 86_400_000;
    const stored = new Date('2026-01-01T00:00:00.000Z');
    const one = [{ recipient: 'bob@b.test', state: 'expired' as const }];
    await store.saveMessage(message('old-expired', { expires_at: new Date(stored.getTime() + 7 * day) }), one, stored);
    await store.saveMessage(message('old-still-valid', { expires_at: new Date(stored.getTime() + 90 * day) }), one, stored);
    await store.saveMessage(message('recent', { expires_at: new Date(stored.getTime() + 41 * day) }), one, new Date(stored.getTime() + 40 * day));

    // Forty-five days on, with thirty days of retention and a day of grace after expiry.
    const now = stored.getTime() + 45 * day;
    assert.equal(await store.purgeMessages(new Date(now - 30 * day), new Date(now - day)), 1);
    assert.equal(await store.getMessage('in', 'alice@a.test', 'old-expired'), null);
    assert.equal(await store.getDelivery(key('old-expired')), null, 'its deliveries go with it');
    assert.ok(await store.getMessage('in', 'alice@a.test', 'old-still-valid'), 'a message that could still be accepted keeps its record, however old');
    assert.ok(await store.getMessage('in', 'alice@a.test', 'recent'), 'an expired message is kept until the retention period is over');
    assert.equal(await store.purgeMessages(new Date(now - 30 * day), new Date(now - day)), 0);
  });

  it('remembers revoked delegation ids', async () => {
    const store = new Store(t.conn);
    const now = new Date('2026-11-01T12:00:00.000Z');
    assert.equal(await store.isDelegationRevoked('dlg_1'), false);
    assert.equal(await store.revokeDelegation('dlg_1', now), true);
    assert.equal(await store.revokeDelegation('dlg_1', now), false, 'revoking twice changes nothing');
    assert.equal(await store.isDelegationRevoked('dlg_1'), true);
    assert.equal(await store.isDelegationRevoked('dlg_2'), false);
  });

  it('rolls a failed transaction back completely', async () => {
    const store = new Store(t.conn);
    const now = new Date();
    // The contact write fails (its source is not one the schema allows), after the message and delivery went in.
    const broken = [{ owner: 'bob@b.test', peer: 'alice@a.test', source: 'nonsense' as 'approved' }];
    await assert.rejects(store.saveMessage(message('m1'), [{ recipient: 'bob@b.test', state: 'pending' }], now, broken));
    assert.equal(await store.getMessage('in', 'alice@a.test', 'm1'), null, 'the message row was rolled back with it');
    assert.equal(await store.getDelivery(key('m1')), null, 'and so was its delivery');
    assert.equal(await store.saveMessage(message('m1'), [{ recipient: 'bob@b.test', state: 'pending' }], now), true, 'and the database is usable afterwards');
  });

  it('keeps unrelated statements out of an open transaction', async () => {
    const store = new Store(t.conn);
    const now = new Date();
    let insideSeen = -1;
    // While this transaction is open (and about to fail), another caller writes.
    const doomed = t.conn.transaction(async (tx) => {
      await tx.query('INSERT INTO contacts (owner, peer, source, created_at) VALUES ($1, $2, $3, $4)', ['a@x.test', 'b@y.test', 'approved', now]);
      await new Promise((r) => setTimeout(r, 30));
      insideSeen = (await tx.query('SELECT 1 AS one FROM contacts')).rows.length;
      throw new Error('abort');
    });
    const bystander = store.addContact('c@x.test', 'd@y.test', 'outbound', now);
    await assert.rejects(doomed, /abort/);
    await bystander;
    // SQLite makes other callers wait for the transaction; Postgres lets them commit alongside it.
    if (TEST_DB === 'sqlite') assert.equal(insideSeen, 1, "the transaction saw only its own write, not the bystander's");
    assert.equal(await store.isContact('a@x.test', 'b@y.test'), false, 'the aborted write is gone');
    assert.equal(await store.isContact('c@x.test', 'd@y.test'), true, "the bystander's write survived the rollback");
  });

  it('counts atomically under concurrency', async () => {
    const store = new Store(t.conn);
    const window = new Date('2026-11-01T12:00:00.000Z');
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.bumpRate('sender:x@y.test', window)));
    assert.deepEqual([...counts].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('numbers events in order per address', async () => {
    const store = new Store(t.conn);
    const add = (address: string, n: number) =>
      store.addEvent({ address, type: 'status', message_id: `m${n}`, thread_id: 't', data: { n }, created_at: new Date() });
    const seqs = await Promise.all([add('a@x.test', 1), add('b@x.test', 2), add('a@x.test', 3), add('a@x.test', 4)]);
    assert.equal(new Set(seqs).size, 4);
    const events = await store.eventsAfter('a@x.test', 0, 10);
    assert.deepEqual(events.map((e) => e.data.n).sort(), [1, 3, 4]);
    assert.deepEqual(events.map((e) => e.seq), [...events.map((e) => e.seq)].sort((a, b) => a - b));
    assert.equal(await store.latestEventSeq('a@x.test'), Math.max(...events.map((e) => e.seq)));
    assert.equal(await store.latestEventSeq('nobody@x.test'), 0);
    assert.ok(events[0]!.created_at instanceof Date);
  });

  it('applies migrations once', async () => {
    assert.deepEqual(await t.conn.migrate(silentLogger), [], 'a second run finds nothing to do');
    const versions = (await t.conn.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version);
    assert.deepEqual(versions, ['001_messages.sql']);
  });
});

describe('SQLite specifics', () => {
  const inTempDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adtp-sqlite-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('needs nothing but a path: the file and its directory are created on first use', () =>
    inTempDir(async (dir) => {
      const file = path.join(dir, 'nested', 'data', 'adtp.db');
      const db = openDatabase(`sqlite:${file}`);
      assert.equal(db.dialect, 'sqlite');
      assert.equal(db.location, `SQLite file ${file}`);
      assert.deepEqual(await db.migrate(silentLogger), ['001_messages.sql']);
      await db.waitUntilReady(silentLogger);
      assert.ok(statSync(file).isFile());
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700, 'the data directory is private');
      assert.equal(statSync(file).mode & 0o777, 0o600, 'the database file holds message contents: owner-only');
      await db.query("INSERT INTO contacts (owner, peer, source, created_at) VALUES ('a@x.test', 'b@y.test', 'approved', '2026-01-01T00:00:00.000Z')");
      assert.equal(statSync(`${file}-wal`).mode & 0o777, 0o600, 'and so does its write-ahead log');
      await db.close();
    }));

  it('keeps everything across a restart', () =>
    inTempDir(async (dir) => {
      const url = `sqlite:${path.join(dir, 'adtp.db')}`;
      const now = new Date('2026-11-01T12:00:00.000Z');
      const envelope = signedEnvelope({ id: 'survivor', from: 'alice@a.test', to: ['bob@b.test'], text: 'still here?' }, keys);

      const first = openDatabase(url);
      await first.migrate(silentLogger);
      await new Store(first).saveMessage(
        { direction: 'in', from_addr: 'alice@a.test', id: 'survivor', thread_id: 't1', principal: null, to_addrs: ['bob@b.test'], intent: 'inform', priority: 'normal', expires_at: new Date('2026-12-01T00:00:00.000Z'), requires_approval: false, sender_type: 'human', receipt_for: null, envelope, content_hash: contentHash(envelope), ack: null },
        [{ recipient: 'bob@b.test', state: 'pending' }],
        now,
      );
      await first.close();

      const second = openDatabase(url);
      assert.deepEqual(await second.migrate(silentLogger), [], 'nothing to migrate the second time');
      const store = new Store(second);
      assert.deepEqual((await store.getMessage('in', 'alice@a.test', 'survivor'))?.envelope, envelope);
      assert.deepEqual((await store.claimDue(now, 10, 1000)).map((d) => d.message_id), ['survivor'], 'the queue picks up where it left off');
      await second.close();
    }));

  it('says so plainly when a database comes from an earlier schema generation', () =>
    inTempDir(async (dir) => {
      const url = `sqlite:${path.join(dir, 'adtp.db')}`;
      const old = openDatabase(url);
      await old.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL)');
      await old.query("INSERT INTO schema_migrations (version, applied_at) VALUES ('001_schema.sql', '2026-01-01T00:00:00.000Z')");
      await old.query('CREATE TABLE messages (id TEXT)');
      await assert.rejects(old.migrate(silentLogger), /001_messages\.sql failed.*created by an earlier build \(it has 001_schema\.sql\).*fresh database/s);
      await old.close();
    }));

  it('works in memory too', async () => {
    const db = openDatabase('sqlite::memory:');
    await db.migrate(silentLogger);
    assert.equal(db.location, 'SQLite (in memory)');
    assert.equal((await db.query<{ n: number }>('SELECT count(*) AS n FROM messages')).rows[0]!.n, 0);
    await db.close();
  });
});
