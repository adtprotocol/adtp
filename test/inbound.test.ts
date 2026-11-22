/**
 * The inbound pipeline against a real Postgres: validation, verification,
 * store-and-forward, acks, idempotency, trust, the requests tray, rate limits,
 * deadlines, routing, and status receipts.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DiscoveryError } from '../src/identity/discovery.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { AdtpNode } from '../src/core/node.js';
import { mintDelegation } from '../src/protocol/delegation.js';
import { receiptOf, receiptParts } from '../src/protocol/envelope.js';
import { verifySignature } from '../src/protocol/signing.js';
import type { Envelope } from '../src/protocol/types.js';
import {
  createTestDb,
  createTestNode,
  dbAvailable,
  FakeAdapter,
  signedEnvelope,
  TEST_EPOCH,
  testConfig,
  TestKeys,
  type EnvelopeInput,
  type TestNode,
} from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

describe('inbound pipeline', { skip }, () => {
  let t: TestNode;
  const alice = new TestKeys();
  const mallory = new TestKeys();

  const fromAlice = (input: Partial<EnvelopeInput> = {}): Envelope =>
    signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], intent: 'inform', text: 'hello bob', ...input }, alice);

  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await t.db.conn.query<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, params)).rows[0]!.n;

  const deliveryState = async (id: string, recipient = 'bob@b.test', direction: 'in' | 'out' = 'in') =>
    (await t.node.store.findDeliveries(direction, id, recipient))[0]?.state;

  /** Makes alice a known contact of bob, as an earlier approval would have. */
  const trustAlice = (owner = 'bob@b.test') => t.node.store.addContact(owner, 'alice@a.test', 'approved', t.clock.now());

  /** The receipts this node has queued for alice, as [status, message_id] pairs. */
  const receiptsSent = async (): Promise<string[]> => {
    // Ordered by the delivery sequence: the order they go on the wire.
    const res = await t.db.conn.query<{ envelope: Envelope }>(
      `SELECT m.envelope FROM messages m JOIN deliveries d ON d.direction = m.direction AND d.message_id = m.id
        WHERE m.direction = 'out' AND m.receipt_for IS NOT NULL ORDER BY d.seq`,
    );
    return res.rows.map((r) => {
      const receipt = receiptOf(r.envelope)!;
      return `${receipt.status}:${receipt.message_id}`;
    });
  };

  beforeEach(async () => {
    t = await createTestNode('b.test');
    t.resolver.add(alice.card('alice@a.test', 'human'));
  });
  afterEach(async () => {
    await t.close();
  });

  describe('accepting and storing', () => {
    it('persists the message before acknowledging it, and holds first contact in the tray', async () => {
      const env = fromAlice({ thread: 'thread-7' });
      const ack = await t.node.receive(env);

      assert.equal(ack.status, 'queued');
      assert.equal(ack.id, env.id);
      assert.deepEqual(ack.recipients, { 'bob@b.test': { status: 'queued' } });
      // The receipt names the message (sender + id), says who signed it, and is signed with that recipient's key.
      assert.equal(ack.from, 'alice@a.test');
      assert.equal(ack.by, 'bob@b.test');
      assert.deepEqual(verifySignature(ack, t.keys.publicKeys(), t.clock.now()), { ok: true, kid: t.keys.kid });
      assert.deepEqual(ack.verified, { signature: alice.kid });

      const stored = await t.node.store.getMessage('in', env.from, env.id);
      assert.ok(stored, 'the message is in Postgres by the time the ack is returned');
      assert.deepEqual(stored.envelope, env, 'the signed envelope is stored verbatim');
      assert.deepEqual(stored.ack, ack);
      assert.equal(stored.thread_id, 'thread-7');
      assert.equal(stored.sender_type, 'human');
      assert.equal(await deliveryState(env.id), 'held');

      await t.node.worker.drain();
      assert.equal(t.adapter.delivered.length, 0, 'a held message is not delivered');
      assert.deepEqual((await t.node.tray()).map((i) => [i.message.id, i.delivery.recipient]), [[env.id, 'bob@b.test']]);
    });

    it('stores the envelope byte-for-byte as signed, including key order and awkward characters', async () => {
      const env = fromAlice({
        parts: [
          { type: 'text', text: 'Tab\there, emoji 🎉, a NUL \u0000 and a "quote"' },
          { type: 'data', data: { zebra: 1, apple: { nested: [3, 2, 1] }, 'a longer key': null } },
        ],
      });
      assert.equal((await t.node.receive(env)).status, 'queued');
      const stored = (await t.node.store.getMessage('in', env.from, env.id))!;
      assert.equal(JSON.stringify(stored.envelope), JSON.stringify(env), 'same members in the same order');

      await t.node.approve(env.id, 'bob@b.test');
      await t.node.worker.drain();
      assert.equal(JSON.stringify(t.adapter.delivered[0]!.message), JSON.stringify(env));
    });

    it('accepts and delivers a message from a known sender straight away', async () => {
      await trustAlice();
      const env = fromAlice();
      const ack = await t.node.receive(env);
      assert.equal(ack.status, 'accepted');

      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'delivered');
      assert.equal(t.adapter.delivered.length, 1);
      assert.equal(t.adapter.delivered[0]!.ctx.target, 'bob@mail.test');
      assert.equal(t.adapter.delivered[0]!.ctx.recipient, 'bob@b.test');
      assert.equal((await t.node.tray()).length, 0);
    });
  });

  describe('idempotency', () => {
    it('returns the original ack for a repeated id and never delivers twice', async () => {
      await trustAlice();
      const env = fromAlice();
      const first = await t.node.receive(env);
      t.clock.advance(5000);
      const second = await t.node.receive(env);
      assert.deepEqual(second, first, 'same ack, including its original timestamp');

      await t.node.worker.drain();
      t.clock.advance(60_000);
      const third = await t.node.receive(JSON.parse(JSON.stringify(env)));
      assert.deepEqual(third, first, 'still the original ack after delivery');
      await t.node.worker.drain();

      assert.equal(await count("messages WHERE direction = 'in'"), 1);
      assert.equal(await count("deliveries WHERE direction = 'in'"), 1);
      assert.equal(t.adapter.delivered.length, 1, 'delivered exactly once');
    });

    it('handles the same message arriving concurrently', async () => {
      await trustAlice();
      const env = fromAlice();
      const acks = await Promise.all(Array.from({ length: 6 }, () => t.node.receive(env)));
      for (const ack of acks) assert.deepEqual(ack, acks[0]);
      await t.node.worker.drain();
      assert.equal(await count("messages WHERE direction = 'in'"), 1);
      assert.equal(t.adapter.delivered.length, 1);
    });

    it('refuses the same id from the same sender when the message is a different one', async () => {
      const env = fromAlice({ id: 'reused-id', text: 'the original' });
      const first = await t.node.receive(env);
      const changed = await t.node.receive(fromAlice({ id: 'reused-id', text: 'something else' }));
      assert.equal(changed.status, 'rejected');
      assert.equal(changed.reason?.code, 'id_conflict');
      assert.equal(Boolean(changed.reason?.retryable), false);

      // The stored message is untouched, and the original still gets its receipt back.
      assert.deepEqual((await t.node.store.getMessage('in', 'alice@a.test', 'reused-id'))!.envelope, env);
      assert.deepEqual(await t.node.receive(env), first);
      assert.equal(await count('messages'), 1);
    });

    it('tells a repeat from a first delivery', async () => {
      const env = fromAlice();
      const first = await t.node.handle(env);
      assert.equal(first.duplicate, false);
      const again = await t.node.handle(env);
      assert.equal(again.duplicate, true);
      assert.deepEqual(again.ack, first.ack);
      assert.equal((await t.node.handle(fromAlice({ id: env.id, text: 'different' }))).duplicate, false, 'a conflict is a refusal, not a repeat');
    });

    it('keeps ids per sender: two senders may use the same one', async () => {
      t.resolver.add(mallory.card('mallory@m.test'));
      const mine = fromAlice({ id: 'shared-id' });
      const theirs = signedEnvelope({ id: 'shared-id', from: 'mallory@m.test', to: ['bob@b.test'], text: 'same id, my own message' }, mallory);
      assert.equal((await t.node.receive(mine)).status, 'queued');
      const ack = await t.node.receive(theirs);
      assert.equal(ack.status, 'queued', 'another sender cannot burn, or collide with, this id');
      assert.equal(ack.from, 'mallory@m.test');
      assert.deepEqual((await t.node.store.getMessage('in', 'alice@a.test', 'shared-id'))!.envelope, mine);
      assert.deepEqual((await t.node.store.getMessage('in', 'mallory@m.test', 'shared-id'))!.envelope, theirs);

      // Acting on one of them needs to say which.
      await assert.rejects(t.node.approve('shared-id', 'bob@b.test'), /more than one sender used this message id/);
      assert.deepEqual(await t.node.approve('shared-id', 'bob@b.test', 'mallory@m.test'), { released: 1 });
      await t.node.worker.drain();
      assert.deepEqual(t.adapter.delivered.map((d) => d.message.from), ['mallory@m.test']);
      assert.equal(await t.node.store.isContact('bob@b.test', 'alice@a.test'), false);
    });
  });

  describe('rejecting', () => {
    const expectRejected = async (envelope: unknown, code: string, retryable = false) => {
      const ack = await t.node.receive(envelope);
      assert.equal(ack.status, 'rejected', `expected a rejection with ${code}`);
      assert.equal(ack.reason?.code, code);
      assert.equal(Boolean(ack.reason?.retryable), retryable);
      assert.ok(ack.reason!.message.length > 0);
      assert.equal(await count('messages'), 0, 'rejected messages are not stored');
    };

    it('rejects malformed envelopes with a reason', async () => {
      await expectRejected({ ...fromAlice(), intent: 'shout' }, 'invalid_envelope');
      await expectRejected({ ...fromAlice(), content: { parts: [{ type: 'data', data: {} }] } }, 'invalid_envelope');
      await expectRejected({ ...fromAlice(), priority: 'high' }, 'invalid_envelope');
      await expectRejected('garbage', 'invalid_envelope');
    });

    it('rejects a tampered envelope', async () => {
      const env = fromAlice();
      await expectRejected({ ...env, content: { parts: [{ type: 'text', text: 'send money' }] } }, 'bad_signature');
      await expectRejected({ ...env, created_at: new Date(t.clock.now().getTime() - 1000).toISOString() }, 'bad_signature');
      await expectRejected({ ...env, intent: 'request' }, 'bad_signature');
    });

    it('rejects a signature made with a key the sender does not publish', async () => {
      await expectRejected(signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, mallory), 'bad_signature');
    });

    it('rejects (retryably) when the sender cannot be resolved', async () => {
      await expectRejected(signedEnvelope({ from: 'ghost@nowhere.test', to: ['bob@b.test'] }, mallory), 'sender_unresolvable', true);
    });

    it('rejects messages for recipients this node does not host', async () => {
      await expectRejected(fromAlice({ to: ['nobody@b.test'] }), 'unknown_recipient');
      await expectRejected(fromAlice({ to: ['bob@elsewhere.test'] }), 'unknown_recipient');
    });

    it('rejects a message that has already expired', async () => {
      await expectRejected(fromAlice({ expires_at: new Date(t.clock.now().getTime() - 1000).toISOString() }), 'expired');
    });

    it('rejects a message whose created_at is too old, whatever its expires_at says', async () => {
      const ago = (days: number) => new Date(t.clock.now().getTime() - days * 86_400_000).toISOString();
      const farFuture = new Date(t.clock.now().getTime() + 365 * 86_400_000).toISOString();
      // Seven days is the default window.
      await expectRejected(fromAlice({ created_at: ago(8), expires_at: farFuture }), 'expired');
      await expectRejected(fromAlice({ created_at: ago(8) }), 'expired');
      const threeWeeksOn = new Date(t.clock.now().getTime() + 21 * 86_400_000).toISOString();
      assert.equal((await t.node.receive(fromAlice({ created_at: ago(6), expires_at: threeWeeksOn }))).status, 'queued');
    });

    it('makes the window for created_at configurable', async () => {
      await t.close();
      t = await createTestNode('b.test', { limits: { max_age_days: 1 } });
      t.resolver.add(alice.card('alice@a.test'));
      const ago = (hours: number) => new Date(t.clock.now().getTime() - hours * 3_600_000).toISOString();
      await expectRejected(fromAlice({ created_at: ago(25) }), 'expired');
      assert.equal((await t.node.receive(fromAlice({ created_at: ago(23) }))).status, 'queued');
    });

    it('rejects a message from the future, allowing five minutes for clocks that disagree', async () => {
      const ahead = (seconds: number) => new Date(t.clock.now().getTime() + seconds * 1000).toISOString();
      await expectRejected(fromAlice({ created_at: ahead(301) }), 'invalid_envelope');
      assert.equal((await t.node.receive(fromAlice({ created_at: ahead(299) }))).status, 'queued');
    });

    it('accepts a signature from a key the sender rotated to after we cached its card', async () => {
      const rotated = new TestKeys();
      const calls: boolean[] = [];
      const db = await createTestDb();
      const adapters = new AdapterRegistry();
      adapters.set(new FakeAdapter('email'));
      const node = await AdtpNode.create({
        config: testConfig('b.test'),
        db: db.conn,
        keys: new TestKeys(),
        adapters,
        now: () => new Date(TEST_EPOCH),
        resolver: {
          // Serves the stale card until asked for a fresh one.
          resolve: async (address, opts) => {
            if (address !== 'alice@a.test') throw new DiscoveryError('unknown');
            calls.push(opts?.fresh === true);
            return opts?.fresh ? rotated.card('alice@a.test') : alice.card('alice@a.test');
          },
        },
      });
      try {
        const ack = await node.receive(signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, rotated));
        assert.equal(ack.status, 'queued');
        assert.deepEqual(calls, [false, true], 'the card is fetched afresh once when it does not list the key the signature names');
        assert.equal(ack.verified?.signature, rotated.kid);
      } finally {
        await node.close();
        await db.drop();
      }
    });
  });

  describe('a key this node has not seen yet', () => {
    // The sender (or a principal) has just rotated. This node holds a copy of the card from before the
    // rotation. What happens next depends on whether it can take a fresh look at the card.
    const rotated = new TestKeys();
    type Look = 'too-soon' | 'fetch-fails' | 'fresh';
    /** Serves `stale` for an address until asked for a fresh copy, then answers as `look` says. */
    const serve = (address: string, stale: TestKeys, look: () => Look) => {
      const real = t.resolver.resolve.bind(t.resolver);
      t.resolver.resolve = async (asked: string, opts?: { fresh?: boolean }) => {
        if (asked !== address) return real(asked);
        if (!opts?.fresh) return stale.card(address);
        if (look() === 'fetch-fails') throw new DiscoveryError(`could not resolve ${address} (connect ETIMEDOUT)`);
        if (look() === 'too-soon') return { ...stale.card(address), resolved: { method: 'dns' as const, retry_after: 45 } };
        return rotated.card(address);
      };
    };

    it('asks the sender to try again when it cannot take a fresh look at the card, and accepts the message once it can', async () => {
      let look: Look = 'too-soon';
      serve('alice@a.test', alice, () => look);
      const env = signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], text: 'signed with my new key' }, rotated);

      // The card was fetched moments ago, so it is not fetched again yet. The key may well be new: not a refusal.
      const early = await t.node.receive(env);
      assert.equal(early.status, 'rejected');
      assert.equal(early.reason?.code, 'sender_unresolvable');
      assert.equal(early.reason?.retryable, true, 'the sender should try again, not give up');
      assert.equal(early.reason?.retry_after, 45, 'and is told when');
      assert.match(early.reason!.message, new RegExp(`key "${rotated.kid}".*fetched too recently`));
      assert.equal(await count('messages'), 0);

      // The fresh look fails outright (the sender's site is briefly unreachable): the same answer.
      look = 'fetch-fails';
      const unreachable = await t.node.receive(env);
      assert.equal(unreachable.reason?.code, 'sender_unresolvable');
      assert.equal(unreachable.reason?.retryable, true);

      // The sender's node retries the same envelope after the wait. Now the card can be fetched, and lists the key.
      look = 'fresh';
      const later = await t.node.receive(env);
      assert.equal(later.status, 'queued');
      assert.equal(later.verified?.signature, rotated.kid);
    });

    it('still refuses outright when a fresh card does not list the key', async () => {
      // A fresh look was taken (the plain test resolver always gives a current card) and the key is not there.
      const ack = await t.node.receive(signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, mallory));
      assert.equal(ack.reason?.code, 'bad_signature');
      assert.equal(Boolean(ack.reason?.retryable), false);
    });

    it("does the same for a principal's key on a delegation token", async () => {
      const agent = new TestKeys();
      const carol = new TestKeys(); // carol's key as this node last saw it
      t.resolver.add(agent.card('bot@agents.test', 'agent'));
      let look: Look = 'too-soon';
      serve('carol@c.test', carol, () => look);
      // The token is signed with carol's new key.
      const { token } = mintDelegation({ principal: 'carol@c.test', agent: 'bot@agents.test', scope: ['inform'], ttlSeconds: 3600, now: t.clock.now() }, rotated);
      const env = signedEnvelope({ from: 'bot@agents.test', to: ['bob@b.test'], on_behalf_of: 'carol@c.test', delegation: token }, agent);

      const early = await t.node.receive(env);
      assert.equal(early.reason?.code, 'principal_unresolvable');
      assert.equal(early.reason?.retryable, true);
      assert.equal(early.reason?.retry_after, 45);

      look = 'fresh';
      const later = await t.node.receive(env);
      assert.equal(later.status, 'queued');
      assert.equal(later.verified?.delegation, 'carol@c.test');
    });
  });

  describe('unknown senders and the requests tray', () => {
    it('lets unknown senders use only inform and request', async () => {
      for (const intent of ['propose', 'accept', 'decline', 'commit', 'status', 'cancel', 'approval.request', 'approval.response'] as const) {
        const ack = await t.node.receive(fromAlice({ intent }));
        assert.equal(ack.status, 'rejected', intent);
        assert.equal(ack.reason?.code, 'not_trusted', intent);
      }
      assert.equal((await t.node.receive(fromAlice({ intent: 'inform' }))).status, 'queued');
      assert.equal((await t.node.receive(fromAlice({ intent: 'request' }))).status, 'queued');
      assert.equal(await count('messages'), 2);
    });

    it('approve delivers the message and trusts the sender from then on', async () => {
      const first = fromAlice({ text: 'first' });
      const second = fromAlice({ text: 'second' });
      await t.node.receive(first);
      await t.node.receive(second);
      assert.equal((await t.node.tray()).length, 2);

      const result = await t.node.approve(first.id, 'bob@b.test');
      assert.equal(result.released, 2, 'everything held from this sender for this recipient is released');
      assert.equal(await t.node.store.isContact('bob@b.test', 'alice@a.test'), true);

      await t.node.worker.drain();
      assert.deepEqual(t.adapter.delivered.map((d) => d.message.id).sort(), [first.id, second.id].sort());
      assert.equal((await t.node.tray()).length, 0);

      const later = fromAlice({ intent: 'propose', text: 'now I may propose' });
      assert.equal((await t.node.receive(later)).status, 'accepted', 'a trusted sender skips the tray and may use any intent');
      await t.node.worker.drain();
      assert.equal(t.adapter.delivered.length, 3);
    });

    it('trust is per recipient', async () => {
      await trustAlice('bob@b.test');
      const env = fromAlice({ to: ['bob@b.test', 'helper@b.test'] });
      const ack = await t.node.receive(env);
      assert.equal(ack.status, 'accepted');
      assert.deepEqual(ack.recipients, { 'bob@b.test': { status: 'accepted' }, 'helper@b.test': { status: 'queued' } });

      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id, 'bob@b.test'), 'delivered');
      assert.equal(await deliveryState(env.id, 'helper@b.test'), 'held');
      assert.deepEqual(t.adapter.delivered.map((d) => d.ctx.recipient), ['bob@b.test']);
    });

    it('reject drops the message and leaves the sender unknown', async () => {
      const env = fromAlice();
      await t.node.receive(env);
      await t.node.reject(env.id, 'bob@b.test');

      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'rejected');
      assert.equal(t.adapter.delivered.length, 0);
      assert.equal((await t.node.tray()).length, 0);
      assert.equal(await t.node.store.isContact('bob@b.test', 'alice@a.test'), false);
      assert.equal((await t.node.receive(fromAlice())).status, 'queued', 'the next message goes to the tray again');
      assert.deepEqual(await receiptsSent(), [], 'the sender is told nothing about a rejection');

      await assert.rejects(t.node.approve(env.id, 'bob@b.test'), /rejected, not awaiting approval/);
      await assert.rejects(t.node.reject('no-such-id', 'bob@b.test'), /no such message/);
    });

    it('a recipient that has written to someone knows them', async () => {
      t.resolver.add(mallory.card('carol@c.test'));
      await t.node.submit({ from: 'bob@b.test', to: ['carol@c.test'], intent: 'request', text: 'hi carol' });
      const reply = signedEnvelope({ from: 'carol@c.test', to: ['bob@b.test'], intent: 'accept', text: 'sure' }, mallory);
      assert.equal((await t.node.receive(reply)).status, 'accepted');
    });

    it('answers per recipient when some are unknown here or belong to other nodes', async () => {
      await trustAlice();
      const ack = await t.node.receive(fromAlice({ to: ['bob@b.test', 'ghost@b.test', 'zed@elsewhere.test'] }));
      assert.equal(ack.status, 'accepted');
      assert.equal(ack.recipients!['bob@b.test']!.status, 'accepted');
      assert.equal(ack.recipients!['ghost@b.test']!.reason?.code, 'unknown_recipient');
      assert.equal(ack.recipients!['zed@elsewhere.test'], undefined, "another node's recipient is not this node's to answer for");
    });
  });

  describe('rate limits for unknown senders', () => {
    it('limits each sender per hour, without storing what it turns away', async () => {
      await t.close();
      t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 2, per_org_per_hour: 100 } } });
      t.resolver.add(alice.card('alice@a.test'));

      assert.equal((await t.node.receive(fromAlice())).status, 'queued');
      assert.equal((await t.node.receive(fromAlice())).status, 'queued');
      const limited = fromAlice();
      const ack = await t.node.receive(limited);
      assert.equal(ack.status, 'rejected');
      assert.equal(ack.reason?.code, 'rate_limited');
      assert.equal(ack.reason?.retryable, true);
      assert.equal(await count('messages'), 2);

      t.clock.advance(60 * 60 * 1000);
      assert.equal((await t.node.receive(limited)).status, 'queued', 'the same id is accepted once the window has passed');
    });

    it('limits each organization per hour across its senders', async () => {
      await t.close();
      t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 10, per_org_per_hour: 3 } } });
      const org = new TestKeys();
      const statuses: string[] = [];
      for (const local of ['a', 'b', 'c', 'd', 'e']) {
        t.resolver.add(org.card(`${local}@bigco.test`));
        statuses.push((await t.node.receive(signedEnvelope({ from: `${local}@bigco.test`, to: ['bob@b.test'] }, org))).status);
      }
      assert.deepEqual(statuses, ['queued', 'queued', 'queued', 'rejected', 'rejected']);

      const other = new TestKeys();
      t.resolver.add(other.card('x@smallco.test'));
      assert.equal((await t.node.receive(signedEnvelope({ from: 'x@smallco.test', to: ['bob@b.test'] }, other))).status, 'queued', 'other organizations are unaffected');
    });

    it('decides a turned-away recipient again when the sender retries, and never delivers twice to one that took it', async () => {
      await t.close();
      t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 1, per_org_per_hour: 100 } } });
      t.resolver.add(alice.card('alice@a.test'));
      await trustAlice('bob@b.test');
      // Alice spends this hour's first-contact allowance on the helper.
      assert.equal((await t.node.receive(fromAlice({ to: ['helper@b.test'] }))).status, 'queued');

      // Bob knows her, the helper does not: one copy is taken, the other is told to come back later.
      const env = fromAlice({ to: ['bob@b.test', 'helper@b.test'] });
      const deliveredTo = () => t.adapter.delivered.filter((d) => d.message.id === env.id).map((d) => d.ctx.recipient).sort();
      const first = await t.node.receive(env);
      assert.equal(first.status, 'accepted');
      assert.equal(first.recipients!['bob@b.test']!.status, 'accepted');
      assert.equal(first.recipients!['helper@b.test']!.reason?.code, 'rate_limited');
      assert.equal(first.recipients!['helper@b.test']!.reason?.retryable, true);
      await t.node.worker.drain();
      assert.deepEqual(deliveredTo(), ['bob@b.test']);

      // A retry inside the same hour changes nothing.
      const early = await t.node.receive(env);
      assert.equal(early.recipients!['bob@b.test']!.status, 'accepted');
      assert.equal(early.recipients!['helper@b.test']!.reason?.code, 'rate_limited');
      assert.equal(await count('deliveries WHERE message_id = $1', [env.id]), 1);

      // Once the allowance is back, the retry gets the helper's copy into the tray.
      t.clock.advance(60 * 60 * 1000);
      const later = await t.node.receive(env);
      assert.equal(later.status, 'accepted');
      assert.deepEqual(later.recipients, { 'bob@b.test': { status: 'accepted' }, 'helper@b.test': { status: 'queued' } });
      assert.equal(later.at, first.at, 'it is still the ack of the original message');
      assert.deepEqual((await t.node.store.getMessage('in', env.from, env.id))!.ack, later, 'the stored ack is brought up to date');
      assert.equal(await deliveryState(env.id, 'helper@b.test'), 'held');
      assert.ok((await t.node.tray()).some((i) => i.message.id === env.id && i.delivery.recipient === 'helper@b.test'), 'and it is in the requests tray');

      // From here on it is an ordinary duplicate: same answer, nothing stored or counted again.
      assert.deepEqual(await t.node.receive(env), later);
      assert.equal(await count('messages WHERE id = $1', [env.id]), 1);
      assert.equal(await count('deliveries WHERE message_id = $1', [env.id]), 2);
      await t.node.worker.drain();
      assert.deepEqual(deliveredTo(), ['bob@b.test'], "bob's copy was delivered once, whatever the retries");

      await t.node.approve(env.id, 'helper@b.test');
      await t.node.worker.drain();
      assert.deepEqual(deliveredTo(), ['bob@b.test', 'helper@b.test']);
    });

    it('leaves a turned-away recipient turned away once the message has expired', async () => {
      await t.close();
      t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 1, per_org_per_hour: 100 } } });
      t.resolver.add(alice.card('alice@a.test'));
      await trustAlice('bob@b.test');
      await t.node.receive(fromAlice({ to: ['helper@b.test'] }));

      const expiresAt = new Date(t.clock.now().getTime() + 30 * 60 * 1000).toISOString();
      const env = fromAlice({ to: ['bob@b.test', 'helper@b.test'], expires_at: expiresAt });
      const first = await t.node.receive(env);
      assert.equal(first.recipients!['helper@b.test']!.reason?.code, 'rate_limited');

      t.clock.advance(60 * 60 * 1000);
      assert.deepEqual(await t.node.receive(env), first);
      assert.equal(await deliveryState(env.id, 'helper@b.test'), undefined);
    });

    it('leaves a turned-away recipient turned away once the message is older than the node accepts', async () => {
      await t.close();
      t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 1, per_org_per_hour: 100 } } });
      t.resolver.add(alice.card('alice@a.test'));
      await trustAlice('bob@b.test');
      await t.node.receive(fromAlice({ to: ['helper@b.test'] }));

      // Not expired for another three weeks, but a week from now its created_at is too old to accept.
      const day = 86_400_000;
      const env = fromAlice({ to: ['bob@b.test', 'helper@b.test'], expires_at: new Date(t.clock.now().getTime() + 21 * day).toISOString() });
      const first = await t.node.receive(env);
      assert.equal(first.status, 'accepted');
      assert.equal(first.recipients!['helper@b.test']!.reason?.code, 'rate_limited');

      t.clock.advance(7 * day + 60_000);
      assert.deepEqual(await t.node.receive(env), first, 'the stored answer stands');
      assert.equal(await deliveryState(env.id, 'helper@b.test'), undefined, 'no delivery is added for it');
      assert.ok(!(await t.node.tray()).some((i) => i.message.id === env.id));
      assert.equal(await count('deliveries WHERE message_id = $1', [env.id]), 1);
    });

    it('does not rate-limit known senders', async () => {
      await t.close();
      t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 1, per_org_per_hour: 1 } } });
      t.resolver.add(alice.card('alice@a.test'));
      await trustAlice();
      for (let i = 0; i < 5; i++) assert.equal((await t.node.receive(fromAlice())).status, 'accepted');
    });
  });

  describe('retention', () => {
    it('purges a message once it is expired and older than the retention period, and still refuses a replay of it', async () => {
      await trustAlice();
      const day = 86_400_000;
      const env = fromAlice({ expires_at: new Date(t.clock.now().getTime() + day).toISOString() });
      assert.equal((await t.node.receive(env)).status, 'accepted');
      await t.node.worker.drain();
      const kept = fromAlice({ expires_at: new Date(t.clock.now().getTime() + 30 * day).toISOString() });
      await t.node.receive(kept);
      await t.node.worker.drain();
      assert.equal(await count("messages WHERE direction = 'in'"), 2);

      // A week on: expired, but inside the thirty days this node keeps messages. A replay still gets its receipt.
      t.clock.advance(7 * day);
      await t.node.worker.tick();
      assert.ok(await t.node.store.getMessage('in', env.from, env.id));
      assert.equal((await t.node.handle(env)).duplicate, true);

      // Past retention: the message and its receipts are gone...
      t.clock.advance(23.5 * day);
      await t.node.worker.tick();
      assert.equal(await t.node.store.getMessage('in', env.from, env.id), null);
      assert.equal(await count('messages WHERE receipt_for = $1', [env.id]), 0, 'the receipts this node sent for it are purged too');
      assert.equal(await count('deliveries WHERE message_id = $1', [env.id]), 0);
      // ...and the record of its id is no longer needed: the envelope is refused for its age alone.
      const replay = await t.node.receive(env);
      assert.equal(replay.status, 'rejected');
      assert.equal(replay.reason?.code, 'expired');
      assert.equal(t.adapter.delivered.filter((d) => d.message.id === env.id).length, 1, 'delivered once, ever');

      // A message that has not been expired for a day keeps its record, though it arrived longer ago than that.
      assert.ok(await t.node.store.getMessage('in', kept.from, kept.id));
      assert.equal((await t.node.handle(kept)).duplicate, true);
      t.clock.advance(2 * day);
      await t.node.worker.tick();
      assert.equal(await t.node.store.getMessage('in', kept.from, kept.id), null);
    });

    it('refuses a message that would have to be kept for longer than the retention period', async () => {
      await trustAlice();
      const day = 86_400_000;
      const at = (ms: number) => new Date(ms).toISOString();
      const created = Math.floor(t.clock.now().getTime() / 1000) * 1000;

      const farAhead = await t.node.receive(fromAlice({ created_at: at(created), expires_at: '2099-01-01T00:00:00Z' }));
      assert.equal(farAhead.status, 'rejected');
      assert.equal(farAhead.reason?.code, 'invalid_envelope');
      assert.match(farAhead.reason!.message, /expires_at is more than 30 days after created_at/);
      assert.equal(farAhead.reason?.retryable ?? false, false);
      assert.equal((await t.node.receive(fromAlice({ created_at: at(created), expires_at: at(created + 30 * day + 1000) }))).status, 'rejected');
      assert.equal(await count("messages WHERE direction = 'in'"), 0, 'a refused message is not stored');

      // Exactly the retention period is fine, and so is a message that names no expiry.
      assert.equal((await t.node.receive(fromAlice({ created_at: at(created), expires_at: at(created + 30 * day) }))).status, 'accepted');
      assert.equal((await t.node.receive(fromAlice())).status, 'accepted');

      // This node holds itself to the same bound when it sends.
      await assert.rejects(
        t.node.submit({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'inform', text: 'see you next century', expires_at: '2099-01-01T00:00:00Z' }),
        /expires_at is more than 30 days ahead/,
      );
      assert.equal(await count("messages WHERE direction = 'out' AND receipt_for IS NULL"), 0);
    });

    it('gives a message stored before that rule the same bound, so it is deleted in the end', async () => {
      await trustAlice();
      const day = 86_400_000;
      const env = fromAlice();
      assert.equal((await t.node.receive(env)).status, 'accepted');
      await t.node.worker.drain();
      // As an earlier build would have stored it: expiring in the next century.
      await t.db.conn.query("UPDATE messages SET expires_at = $1 WHERE direction = 'in' AND id = $2", [new Date('2099-01-01T00:00:00Z'), env.id]);

      t.clock.advance(2 * 60 * 60 * 1000);
      await t.node.worker.tick();
      const capped = (await t.node.store.getMessage('in', env.from, env.id))!.expires_at.getTime();
      assert.ok(capped <= t.clock.now().getTime() + 31 * day, 'its expiry is brought forward to the bound');
      assert.equal((await t.node.handle(env)).duplicate, true, 'it is still the record of its id');

      t.clock.advance(33 * day);
      await t.node.worker.tick();
      assert.equal(await t.node.store.getMessage('in', env.from, env.id), null);
      assert.equal(await count('deliveries WHERE message_id = $1', [env.id]), 0);
      // The envelope cannot come back: its created_at is long past what the node accepts.
      const replay = await t.node.receive(env);
      assert.equal(replay.status, 'rejected');
      assert.equal(replay.reason?.code, 'expired');
      assert.equal(t.adapter.delivered.filter((d) => d.message.id === env.id).length, 1, 'delivered once, ever');
    });

    it('keeps messages for as long as the operator configures', async () => {
      await t.close();
      t = await createTestNode('b.test', { limits: { retention_days: 2 } });
      t.resolver.add(alice.card('alice@a.test'));
      const env = fromAlice({ expires_at: new Date(t.clock.now().getTime() + 3_600_000).toISOString() });
      await t.node.receive(env);
      t.clock.advance(3 * 86_400_000);
      await t.node.worker.tick();
      assert.equal(await count('messages'), 0);
    });
  });

  describe('deadlines', () => {
    const inOneHour = () => new Date(t.clock.now().getTime() + 60 * 60 * 1000).toISOString();

    it('expires a held message at its deadline and refuses to approve it afterwards', async () => {
      const env = fromAlice({ expires_at: inOneHour() });
      assert.equal((await t.node.receive(env)).status, 'queued');

      t.clock.advance(61 * 60 * 1000);
      assert.equal((await t.node.tray()).length, 0, 'expired requests leave the tray');
      assert.equal(await deliveryState(env.id), 'expired');
      await assert.rejects(t.node.approve(env.id, 'bob@b.test'), /expired, not awaiting approval/);
      await t.node.worker.drain();
      assert.equal(t.adapter.delivered.length, 0);
    });

    it('never delivers after expires_at, even if approval and expiry race', async () => {
      const env = fromAlice({ expires_at: inOneHour() });
      await t.node.receive(env);
      t.clock.advance(61 * 60 * 1000);
      // No sweep has run yet: approve() itself must notice the deadline.
      await assert.rejects(t.node.approve(env.id, 'bob@b.test'), /expired/);
      assert.equal(await deliveryState(env.id), 'expired');
      assert.equal(await t.node.store.isContact('bob@b.test', 'alice@a.test'), false);
    });

    it('marks a message expired when the channel stays down past the deadline', async () => {
      await trustAlice();
      t.adapter.failures = 99;
      const env = fromAlice({ expires_at: new Date(t.clock.now().getTime() + 15_000).toISOString() });
      await t.node.receive(env);

      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'pending', 'first attempt failed; a retry is scheduled');
      assert.equal(t.adapter.attempts, 1);

      t.clock.advance(20_000);
      t.adapter.failures = 0;
      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'expired');
      assert.equal(t.adapter.attempts, 1, 'no delivery is attempted after the deadline');
      assert.equal(t.adapter.delivered.length, 0);
    });

    it('delivers normally before the deadline', async () => {
      await trustAlice();
      const env = fromAlice({ expires_at: inOneHour() });
      await t.node.receive(env);
      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'delivered');
    });
  });

  describe('channel delivery', () => {
    it('retries a failing channel with backoff, then marks the delivery failed', async () => {
      await trustAlice();
      t.adapter.failures = 99;
      const env = fromAlice();
      await t.node.receive(env);

      await t.node.worker.drain();
      let d = (await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'bob@b.test' }))!;
      assert.equal(d.state, 'pending');
      assert.equal(d.attempts, 1);
      assert.equal(d.next_attempt_at.getTime() - t.clock.now().getTime(), 10_000, 'first retry after the base delay');

      t.clock.advance(10_000);
      await t.node.worker.drain();
      d = (await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'bob@b.test' }))!;
      assert.equal(d.attempts, 2);
      assert.equal(d.next_attempt_at.getTime() - t.clock.now().getTime(), 20_000, 'the delay doubles');

      t.clock.advance(20_000);
      await t.node.worker.drain();
      d = (await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'bob@b.test' }))!;
      assert.equal(d.state, 'failed');
      assert.match(d.last_error ?? '', /gave up after 3 attempts: email: channel unavailable/);

      t.clock.advance(24 * 60 * 60 * 1000);
      await t.node.worker.drain();
      assert.equal(t.adapter.attempts, 3, 'a failed delivery is final');
      assert.deepEqual(await receiptsSent(), [`failed:${env.id}`], 'the sender is told the message could not be delivered');
      const receipt = (await t.node.thread(env.thread!)).find((m) => m.receipt_for === env.id)!;
      assert.ok(!JSON.stringify(receipt.envelope).includes('channel unavailable'), 'but not why: that is this node\'s business');
    });

    it('routes by priority, intent, sender organization and sender type', async () => {
      await t.close();
      t = await createTestNode('b.test', {
        addresses: [
          {
            local: 'bob',
            type: 'human',
            routes: [
              { match: { priority: 'urgent' }, channel: 'email', to: 'pager@mail.test' },
              { match: { intent: ['request', 'approval.request'], sender_type: 'agent' }, channel: 'email', to: 'agents@mail.test' },
              { match: { from_org: 'a.test' }, channel: 'email', to: 'a-team@mail.test' },
              { default: true, channel: 'email', to: 'bob@mail.test' },
            ],
          },
        ],
      });
      const agent = new TestKeys();
      t.resolver.add(alice.card('alice@a.test', 'human')).add(agent.card('bot@agents.test', 'agent'));
      await trustAlice();
      await t.node.store.addContact('bob@b.test', 'bot@agents.test', 'approved', t.clock.now());

      const cases: [Envelope, string][] = [
        [fromAlice({ priority: 'urgent' }), 'pager@mail.test'],
        [signedEnvelope({ from: 'bot@agents.test', to: ['bob@b.test'], intent: 'request' }, agent), 'agents@mail.test'],
        [fromAlice({ intent: 'request' }), 'a-team@mail.test'],
        [signedEnvelope({ from: 'bot@agents.test', to: ['bob@b.test'], intent: 'inform' }, agent), 'bob@mail.test'],
      ];
      for (const [env, expected] of cases) {
        await t.node.receive(env);
        await t.node.worker.drain();
        assert.equal(t.adapter.delivered.at(-1)!.ctx.target, expected);
        assert.equal((await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'bob@b.test' }))!.target, expected);
      }
    });

    it('fails a delivery that no route matches', async () => {
      await t.close();
      t = await createTestNode('b.test', {
        addresses: [{ local: 'bob', routes: [{ match: { priority: 'urgent' }, channel: 'email', to: 'pager@mail.test' }] }],
      });
      t.resolver.add(alice.card('alice@a.test'));
      await trustAlice();
      const env = fromAlice({ priority: 'low' });
      await t.node.receive(env);
      await t.node.worker.drain();
      const d = (await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'bob@b.test' }))!;
      assert.equal(d.state, 'failed');
      assert.match(d.last_error ?? '', /no route matches/);
      assert.deepEqual(await receiptsSent(), [`failed:${env.id}`]);
    });
  });

  describe('delegation (on_behalf_of)', () => {
    const principal = new TestKeys();
    const agent = new TestKeys();
    const mint = (extra: Partial<Parameters<typeof mintDelegation>[0]> = {}, signer = principal) =>
      mintDelegation({ principal: 'carol@c.test', agent: 'bot@agents.test', scope: ['inform', 'request'], ttlSeconds: 3600, now: t.clock.now(), ...extra }, signer);
    const fromAgent = (delegation: string, input: Partial<EnvelopeInput> = {}) =>
      signedEnvelope({ from: 'bot@agents.test', to: ['bob@b.test'], on_behalf_of: 'carol@c.test', delegation, ...input }, agent);
    const expectInvalid = async (envelope: Envelope, pattern: RegExp) => {
      const ack = await t.node.receive(envelope);
      assert.equal(ack.reason?.code, 'delegation_invalid');
      assert.match(ack.reason!.message, pattern);
      assert.equal(await count('messages'), 0);
    };

    beforeEach(() => {
      t.resolver.add(principal.card('carol@c.test', 'human')).add(agent.card('bot@agents.test', 'agent'));
    });

    it('accepts an agent acting for a principal who signed a delegation for it', async () => {
      const env = fromAgent(mint().token);
      const ack = await t.node.receive(env);
      assert.equal(ack.status, 'queued');
      assert.deepEqual(ack.verified, { signature: agent.kid, delegation: 'carol@c.test' });
      const stored = (await t.node.store.getMessage('in', env.from, env.id))!;
      assert.equal(stored.principal, 'carol@c.test');
      assert.equal(stored.sender_type, 'agent');

      await t.node.approve(env.id, 'bob@b.test');
      await t.node.worker.drain();
      assert.equal(t.adapter.delivered[0]!.ctx.principal, 'carol@c.test');
    });

    it('rejects a delegation issued to a different agent, signed by the wrong key, or expired', async () => {
      await expectInvalid(fromAgent(mint({ agent: 'other@agents.test' }).token), /does not name the sender/);
      await expectInvalid(fromAgent(mint({}, agent).token), /key the principal does not publish/);
      await expectInvalid(signedEnvelope({ from: 'bot@agents.test', to: ['bob@b.test'], on_behalf_of: 'carol@c.test' }, agent), /requires a delegation token/);

      const stale = mint().token;
      t.clock.advance(2 * 60 * 60 * 1000);
      await expectInvalid(fromAgent(stale), /expired/);
    });

    it('rejects an intent outside the scope the principal granted', async () => {
      await expectInvalid(fromAgent(mint({ scope: ['inform'] }).token, { intent: 'request' }), /does not cover the intent "request"/);
      assert.equal((await t.node.receive(fromAgent(mint({ scope: ['inform'] }).token, { intent: 'inform' }))).status, 'queued');
    });

    it('honours the audience: a token for another node is no good here', async () => {
      await expectInvalid(fromAgent(mint({ audience: 'https://some-other-node.test' }).token), /not meant for this node/);
      assert.equal((await t.node.receive(fromAgent(mint({ audience: 'https://b.test' }).token))).status, 'queued', 'this node is https://b.test');
    });

    it('rejects (retryably) when the principal cannot be resolved', async () => {
      t.resolver.failing.add('carol@c.test');
      const ack = await t.node.receive(fromAgent(mint().token));
      assert.equal(ack.reason?.code, 'principal_unresolvable');
      assert.equal(ack.reason?.retryable, true);
    });

    it('stops accepting a delegation from one of its own principals once it is revoked', async () => {
      // An agent elsewhere acts for bob, who is hosted here: this node signed the token and can take it back.
      const grant = t.node.delegate('bob@b.test', 'bot@agents.test', { scope: ['inform'] });
      assert.equal(grant.aud, 'adtp');
      assert.deepEqual(grant.scope, ['inform']);
      assert.equal(Date.parse(grant.expires_at) - t.clock.now().getTime(), 24 * 60 * 60 * 1000, 'a day unless asked otherwise');
      const forBob = (id?: string) =>
        signedEnvelope({ id, from: 'bot@agents.test', to: ['helper@b.test'], on_behalf_of: 'bob@b.test', delegation: grant.token }, agent);

      assert.equal((await t.node.receive(forBob())).status, 'queued');
      assert.equal(await t.node.revokeDelegation(grant.jti), true);
      assert.equal(await t.node.revokeDelegation(grant.jti), false, 'revoking twice is harmless');

      const after = await t.node.receive(forBob());
      assert.equal(after.reason?.code, 'delegation_invalid');
      assert.match(after.reason!.message, /revoked/);
      assert.equal(Boolean(after.reason?.retryable), false);
    });

    it('limits what delegations it will sign', async () => {
      assert.throws(() => t.node.delegate('carol@c.test', 'bot@agents.test', { scope: ['inform'] }), /not an address hosted on this node/);
      assert.throws(() => t.node.delegate('bob@b.test', 'bot@agents.test', { scope: ['shout'] }), /scope must list the intents/);
      assert.throws(() => t.node.delegate('bob@b.test', 'bot@agents.test', {}), /scope must list the intents/, 'a delegation always says what it covers');
      assert.throws(() => t.node.delegate('bob@b.test', 'bot@agents.test', { scope: ['inform'], ttlSeconds: 8 * 86400 }), /at most 604800/);
      assert.throws(() => t.node.delegate('bob@b.test', 'bot@agents.test', { scope: ['inform'], audience: 'everyone' }), /audience must be "adtp" or the origin/);
      const bound = t.node.delegate('bob@b.test', 'bot@agents.test', { scope: ['inform'], audience: 'https://b.test', ttlSeconds: 600 });
      assert.equal(bound.aud, 'https://b.test');
    });
  });

  describe('status updates back to the sender', () => {
    it('reports delivered, read and replied as status messages on the same thread', async () => {
      await trustAlice();
      const env = fromAlice({ thread: 'thread-9', intent: 'request', text: 'are you free on friday?' });
      await t.node.receive(env);
      await t.node.worker.drain();
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`]);

      const token = t.adapter.delivered[0]!.ctx.token;
      t.clock.advance(60_000);
      assert.equal(await t.node.markRead(token), true);
      assert.equal(await t.node.markRead(token), false, 'a second open changes nothing');
      assert.equal(await deliveryState(env.id), 'read');

      t.clock.advance(60_000);
      const reply = await t.node.ingest('email', { token, text: 'friday works' });
      assert.ok(reply?.created);
      assert.equal(await deliveryState(env.id), 'replied');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`, `read:${env.id}`, `replied:${env.id}`]);

      const recent = await t.node.recent();
      assert.deepEqual(recent.map((m) => m.id).sort(), [env.id, reply.id].sort(), 'the inbox lists messages, not their receipts');
      assert.match(recent.find((m) => m.id === env.id)!.deliveries[0]!.replied_at ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

      const thread = await t.node.thread('thread-9');
      const outgoing = thread.filter((m) => m.direction === 'out');
      assert.equal(outgoing.length, 4, 'three receipts and the reply itself');
      for (const m of outgoing) {
        assert.equal(m.from_addr, 'bob@b.test');
        assert.deepEqual(m.to_addrs, ['alice@a.test']);
      }
      const receipts = outgoing.filter((m) => m.receipt_for === env.id);
      assert.equal(receipts.length, 3);
      assert.ok(receipts.every((m) => m.intent === 'status'));
      const replyMessage = outgoing.find((m) => m.id === reply.id)!;
      assert.equal(replyMessage.intent, 'inform');
      assert.equal(replyMessage.thread_id, 'thread-9');
    });

    it('handles a recipient that reads and replies before the node has recorded the delivery', async () => {
      await trustAlice();
      const env = fromAlice({ intent: 'request' });
      // The recipient reacts inside the handoff itself, as a fast agent does.
      t.adapter.onDeliver = async ({ ctx }) => {
        assert.equal(await deliveryState(env.id), 'pending', 'the node has not finished its own bookkeeping yet');
        assert.equal(await t.node.markRead(ctx.token), true);
        await t.node.ingest('email', { token: ctx.token, text: 'instant answer' });
      };
      await t.node.receive(env);
      await t.node.worker.drain();

      assert.equal(await deliveryState(env.id), 'replied');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`, `read:${env.id}`, `replied:${env.id}`], 'each status exactly once, in order');
      const d = (await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'bob@b.test' }))!;
      assert.equal(d.channel, 'email', 'how it was delivered is still recorded');
      assert.equal(d.native_id, 'fake-1');
      assert.ok(d.delivered_at && d.read_at && d.replied_at);
    });

    it('never records a state without queuing the receipt that reports it', async () => {
      await trustAlice();
      const env = fromAlice({ intent: 'request' });
      await t.node.receive(env);

      // From here on, storing a receipt fails until told otherwise, as it would if the database went away at that moment.
      const store = t.node.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const real = store.insertMessage!;
      const breakReceipts = () => {
        store.insertMessage = async () => {
          throw new Error('the database went away');
        };
      };
      const restore = () => {
        store.insertMessage = real;
      };

      // Delivered: the channel takes the message, then recording it fails.
      breakReceipts();
      await t.node.worker.drain();
      restore();
      assert.equal(t.adapter.delivered.length, 1);
      assert.equal(await deliveryState(env.id), 'pending', 'not recorded as delivered without its receipt');
      assert.deepEqual(await receiptsSent(), []);
      // The attempt's lease runs out and the hand-over is repeated. This time the state and the receipt both land.
      t.clock.advance(121_000);
      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'delivered');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`]);
      assert.equal(t.adapter.delivered.length, 2, 'the channel may see a message twice; the sender is never left without its receipt');

      // Read: the caller is told it failed, nothing changed, and trying again works.
      const token = t.adapter.delivered[0]!.ctx.token;
      breakReceipts();
      await assert.rejects(t.node.markRead(token), /the database went away/);
      restore();
      assert.equal(await deliveryState(env.id), 'delivered');
      assert.equal(await t.node.markRead(token), true);
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`, `read:${env.id}`]);

      // Replied: the same.
      breakReceipts();
      await assert.rejects(t.node.ingest('email', { token, text: 'on it' }), /the database went away/);
      restore();
      assert.equal(await deliveryState(env.id), 'read');
      assert.ok((await t.node.ingest('email', { token, text: 'on it' }))?.created);
      assert.equal(await deliveryState(env.id), 'replied');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`, `read:${env.id}`, `replied:${env.id}`]);
    });

    it('does not report a message as replied unless the reply itself is stored', async () => {
      await trustAlice();
      const env = fromAlice({ intent: 'request' });
      await t.node.receive(env);
      await t.node.worker.drain();
      const token = t.adapter.delivered[0]!.ctx.token;

      // Storing the reply fails. Storing a receipt would have worked.
      const store = t.node.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const real = store.insertMessage!;
      store.insertMessage = async (...args: unknown[]) => {
        if ((args[1] as { receipt_for: string | null }).receipt_for === null) throw new Error('the database went away');
        return real.call(store, ...args);
      };
      await assert.rejects(t.node.ingest('email', { token, text: 'on it' }), /the database went away/);
      store.insertMessage = real;
      assert.equal(await deliveryState(env.id), 'delivered', 'not replied: no reply was queued');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`], 'and the sender is not told it was');

      // The channel hands the reply over again. Now the reply, the state and the receipt all land,
      // and the receipt is queued ahead of the reply.
      const reply = await t.node.ingest('email', { token, text: 'on it' });
      assert.ok(reply?.created);
      assert.equal(await deliveryState(env.id), 'replied');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`, `replied:${env.id}`]);
      const queued = await t.db.conn.query<{ message_id: string }>("SELECT message_id FROM deliveries WHERE direction = 'out' ORDER BY seq");
      assert.equal(queued.rows.at(-1)!.message_id, reply.id, 'the reply goes out after the receipt that announces it');
    });

    it('does not give up on a delivery without queuing the failed receipt', async () => {
      await trustAlice();
      t.adapter.failures = 99;
      const env = fromAlice();
      await t.node.receive(env);
      // Two failed attempts, with their backoff.
      await t.node.worker.drain();
      t.clock.advance(10_000);
      await t.node.worker.drain();

      // The third attempt is the last. Recording "failed" and its receipt fails.
      const store = t.node.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const real = store.insertMessage!;
      store.insertMessage = async () => {
        throw new Error('the database went away');
      };
      t.clock.advance(20_000);
      await t.node.worker.drain();
      store.insertMessage = real;
      assert.equal(await deliveryState(env.id), 'pending', 'not recorded as failed without telling the sender');
      assert.deepEqual(await receiptsSent(), []);

      t.clock.advance(121_000);
      await t.node.worker.drain();
      assert.equal(await deliveryState(env.id), 'failed');
      assert.deepEqual(await receiptsSent(), [`failed:${env.id}`]);
    });

    it('does not treat a message that was never handed over as read', async () => {
      const env = fromAlice();
      await t.node.receive(env); // held in the tray: no delivery attempt has started
      assert.equal(await t.node.markReadBy(env.id, 'bob@b.test'), false);
      assert.equal(await deliveryState(env.id), 'held');
      await t.node.approve(env.id, 'bob@b.test'); // pending, but still not attempted
      assert.equal(await t.node.markReadBy(env.id, 'bob@b.test'), false);
      assert.equal(await deliveryState(env.id), 'pending');
      assert.deepEqual(await receiptsSent(), []);
    });

    it('a reply without a prior open still ends in replied', async () => {
      await trustAlice();
      const env = fromAlice();
      await t.node.receive(env);
      await t.node.worker.drain();
      t.clock.advance(60_000);
      await t.node.ingest('email', { token: t.adapter.delivered[0]!.ctx.token, text: 'ok' });
      assert.equal(await deliveryState(env.id), 'replied');
      assert.deepEqual(await receiptsSent(), [`delivered:${env.id}`, `replied:${env.id}`]);
    });

    it('does not send a reply twice when the channel redelivers its event', async () => {
      await trustAlice();
      const env = fromAlice();
      await t.node.receive(env);
      await t.node.worker.drain();
      const event = { token: t.adapter.delivered[0]!.ctx.token, text: 'ok', id: 'native-event-1' };
      assert.equal((await t.node.ingest('email', event))?.created, true);
      assert.equal((await t.node.ingest('email', event))?.created, false);
      assert.equal(await count("messages WHERE direction = 'out' AND receipt_for IS NULL"), 1);
    });

    it('ignores read beacons and replies that match nothing', async () => {
      assert.equal(await t.node.markRead('f'.repeat(32)), false);
      assert.equal(await t.node.ingest('email', { token: 'f'.repeat(32), text: 'hello?' }), null);
      await assert.rejects(t.node.ingest('carrier-pigeon', {}), /no adapter named/);
    });
  });

  describe('receipts arriving from other nodes', () => {
    const receiptFromAlice = (
      sent: { id: string; thread: string },
      status: 'delivered' | 'read' | 'replied' | 'failed',
      signer = alice,
      from = 'alice@a.test',
    ) =>
      signedEnvelope(
        {
          from,
          to: ['bob@b.test'],
          thread: sent.thread, // a receipt travels on the thread of the message it reports on
          intent: 'status',
          parts: receiptParts({ message_id: sent.id, status, at: t.clock.now().toISOString() }),
        },
        signer,
      );

    it('advance the state of the message they report on, and are not delivered to a channel', async () => {
      const sent = await t.node.submit({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'request', text: 'ping' });
      const state = () => deliveryState(sent.id, 'alice@a.test', 'out');
      assert.equal(await state(), 'pending');

      assert.equal((await t.node.receive(receiptFromAlice(sent, 'delivered'))).status, 'accepted');
      assert.equal(await state(), 'delivered');
      await t.node.receive(receiptFromAlice(sent, 'replied'));
      assert.equal(await state(), 'replied');
      await t.node.receive(receiptFromAlice(sent, 'read'));
      assert.equal(await state(), 'replied', 'a late receipt never moves the state backwards');

      await t.node.worker.drain();
      assert.equal(t.adapter.delivered.length, 0, 'receipts are consumed by the node');
      assert.equal(await count("deliveries WHERE direction = 'in'"), 0);
      assert.deepEqual(await receiptsSent(), [], 'receipts are never acknowledged with receipts');
      assert.equal((await t.node.thread(sent.thread)).filter((m) => m.receipt_for === sent.id).length, 3, 'they are kept in the thread history');
    });

    it('are recorded in full or not at all, so a retry finishes what a failure interrupted', async () => {
      const statuses = async () => (await t.node.events('bob@b.test', 0)).map((e) => e.data.status);
      const store = t.node.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

      // Whichever write fails, nothing of the receipt is kept: not the state it reports, not the event, not the receipt itself.
      for (const failing of ['transition', 'addEvent']) {
        const sent = await t.node.submit({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'request', text: `ping (${failing})` });
        const state = () => deliveryState(sent.id, 'alice@a.test', 'out');
        const receipt = receiptFromAlice(sent, 'delivered');
        const before = await statuses();

        const real = store[failing]!;
        store[failing] = async () => {
          throw new Error('the database went away');
        };
        try {
          await assert.rejects(t.node.receive(receipt), /the database went away/);
        } finally {
          store[failing] = real;
        }
        assert.equal(await t.node.store.getMessage('in', receipt.from, receipt.id), null, `${failing}: the receipt is not marked as seen`);
        assert.equal(await state(), 'pending', `${failing}: the delivery has not moved`);
        assert.deepEqual(await statuses(), before, `${failing}: nothing was reported`);

        // The other node retries the same receipt. This time it goes through, completely.
        assert.equal((await t.node.receive(receipt)).status, 'accepted');
        assert.equal(await state(), 'delivered');
        assert.deepEqual((await statuses()).slice(before.length), ['accepted', 'delivered']);

        // And only once.
        assert.equal((await t.node.receive(receipt)).status, 'accepted');
        assert.deepEqual((await statuses()).slice(before.length), ['accepted', 'delivered']);
      }
    });

    it('end a delivery that never arrived when the other node reports failure, and never undo one that did', async () => {
      const statuses = async () => (await t.node.events('bob@b.test', 0)).map((e) => `${e.data.message_id}:${e.data.status}`);

      const lost = await t.node.submit({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'request', text: 'will not arrive' });
      assert.equal((await t.node.receive(receiptFromAlice(lost, 'failed'))).status, 'accepted');
      assert.equal(await deliveryState(lost.id, 'alice@a.test', 'out'), 'failed');
      assert.deepEqual(await statuses(), [`${lost.id}:failed`]);
      // Failed is final: a late "delivered" for the same message changes nothing.
      await t.node.receive(receiptFromAlice(lost, 'delivered'));
      assert.equal(await deliveryState(lost.id, 'alice@a.test', 'out'), 'failed');

      const arrived = await t.node.submit({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'request', text: 'will arrive' });
      await t.node.receive(receiptFromAlice(arrived, 'delivered'));
      await t.node.receive(receiptFromAlice(arrived, 'failed'));
      assert.equal(await deliveryState(arrived.id, 'alice@a.test', 'out'), 'delivered', 'a delivered message cannot be un-delivered');
      assert.ok(!(await statuses()).includes(`${arrived.id}:failed`), 'and no failure is reported for it');
    });

    it('are rejected when they do not come from the recipient of that message', async () => {
      t.resolver.add(mallory.card('mallory@m.test'));
      const sent = await t.node.submit({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'request', text: 'ping' });
      const forged = await t.node.receive(receiptFromAlice(sent, 'read', mallory, 'mallory@m.test'));
      assert.equal(forged.reason?.code, 'unknown_receipt_target');
      assert.equal(await deliveryState(sent.id, 'alice@a.test', 'out'), 'pending');

      const unknown = await t.node.receive(receiptFromAlice({ id: 'never-sent', thread: 'thr_none' }, 'delivered'));
      assert.equal(unknown.reason?.code, 'unknown_receipt_target');
    });
  });
});
