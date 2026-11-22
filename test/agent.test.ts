/**
 * What the demo relies on, against a real database: the trusted allowlist, the
 * agent channel and its event feed, status events for local senders, and
 * node-signed delegation (acts_for).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { HttpClient } from '../src/identity/safe-http.js';
import { INTENTS } from '../src/protocol/constants.js';
import { mintDelegation, verifyDelegation } from '../src/protocol/delegation.js';
import { receiptOf, receiptParts } from '../src/protocol/envelope.js';
import { signObject, verifySignature } from '../src/protocol/signing.js';
import type { Envelope } from '../src/protocol/types.js';
import { eventJson } from '../src/core/events.js';
import { createTestNode, dbAvailable, signedEnvelope, TEST_EPOCH, TestKeys, type TestNode } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

describe('agents on a node', { skip }, () => {
  let t: TestNode;
  /** How other nodes answer this node's posts: with a signed receipt, a refusal, or not at all. */
  let remote: 'accepted' | Error | { status: number; error: string; message: string };
  let posts: number;
  const stratus = new TestKeys(); // the remote node hosting agent@s.test and dylan@s.test
  const stranger = new TestKeys();

  /** What this node posted to other nodes, in order: a receipt's status, or the message intent. */
  let wire: string[];

  const http: HttpClient = async (_url, options) => {
    posts++;
    const envelope = JSON.parse(options?.body ?? '{}') as Envelope;
    wire.push(receiptOf(envelope)?.status ?? envelope.intent);
    if (remote instanceof Error) throw remote;
    if (remote !== 'accepted') return { status: remote.status, headers: {}, body: JSON.stringify({ error: remote.error, message: remote.message, retryable: false }) };
    // The receipt is signed by the recipient's node, with the key that recipient publishes.
    const by = envelope.to[0]!;
    const signer = by.endsWith('@s.test') ? stratus : stranger;
    const receipt = signObject({ adtp: '0', id: envelope.id, from: envelope.from, by, status: 'accepted', verified: { signature: 'ed25519-remote' }, at: TEST_EPOCH }, signer);
    return { status: 202, headers: {}, body: JSON.stringify(receipt) };
  };

  const fromStratus = (overrides: Record<string, unknown> = {}): Envelope =>
    signedEnvelope(
      {
        from: 'agent@s.test',
        to: ['echo@demo.test'],
        intent: 'request',
        text: 'Hello from Stratus Labs.',
        on_behalf_of: 'dylan@s.test',
        delegation: mintDelegation({ principal: 'dylan@s.test', agent: 'agent@s.test', scope: [...INTENTS], ttlSeconds: 3600, now: t.clock.now() }, stratus).token,
        ...overrides,
      },
      stratus,
    );

  const feed = async (address: string) => (await t.node.events(address, 0)).map(eventJson) as any[];
  const state = async (id: string, recipient: string, direction: 'in' | 'out' = 'in') =>
    (await t.node.store.findDeliveries(direction, id, recipient))[0]?.state;
  const receiptsSent = async (): Promise<string[]> => {
    const res = await t.db.conn.query<{ envelope: Envelope }>("SELECT envelope FROM messages WHERE direction = 'out' AND receipt_for IS NOT NULL ORDER BY created_at, id");
    return res.rows.map((r) => receiptOf(r.envelope)!.status).sort();
  };

  beforeEach(async () => {
    posts = 0;
    wire = [];
    remote = 'accepted';
    t = await createTestNode(
      'demo.test',
      {
        addresses: [
          { local: 'echo', type: 'agent', trusted: ['agent@s.test', '*@partner.test', 'bot@demo.test'], routes: [{ default: true, channel: 'agent' }] },
          { local: 'dylan', type: 'human' },
          { local: 'bot', type: 'agent', acts_for: 'dylan', routes: [{ default: true, channel: 'agent' }] },
        ],
      },
      { http },
    );
    t.resolver
      .add(stratus.card('agent@s.test', 'agent'))
      .add(stratus.card('dylan@s.test', 'human'))
      .add(stratus.card('ops@partner.test', 'human'))
      .add(stranger.card('someone@elsewhere.test', 'human'))
      .add(stranger.card('peer@r.test', 'agent', 'https://node.r.test/adtp/v0/messages'));
  });
  afterEach(async () => {
    await t.close();
  });

  describe('trusted allowlist', () => {
    it('lets an allowlisted sender skip the requests tray on first contact, with any intent', async () => {
      const ack = await t.node.receive(fromStratus({ intent: 'propose' }));
      assert.equal(ack.status, 'accepted');
      assert.equal((await t.node.tray()).length, 0);
    });

    it('matches whole domains written as *@domain', async () => {
      const env = signedEnvelope({ from: 'ops@partner.test', to: ['echo@demo.test'], intent: 'commit', text: 'done' }, stratus);
      assert.equal((await t.node.receive(env)).status, 'accepted');
    });

    it('still holds everyone else', async () => {
      const env = signedEnvelope({ from: 'someone@elsewhere.test', to: ['echo@demo.test'], text: 'hi' }, stranger);
      assert.equal((await t.node.receive(env)).status, 'queued');
      assert.equal((await t.node.tray()).length, 1);
    });

    it('is per address: the allowlist of one address does not cover another', async () => {
      const env = fromStratus({ to: ['bot@demo.test'] });
      assert.equal((await t.node.receive(env)).status, 'queued');
    });
  });

  describe('agent channel', () => {
    it('reports what was verified in the ack', async () => {
      const ack = await t.node.receive(fromStratus());
      assert.deepEqual(ack.verified, { signature: stratus.kid, delegation: 'dylan@s.test' });
      const plain = await t.node.receive(signedEnvelope({ from: 'ops@partner.test', to: ['echo@demo.test'], text: 'no principal' }, stratus));
      assert.deepEqual(plain.verified, { signature: stratus.kid });
    });

    it('hands the message to the agent as an event, with what the node verified', async () => {
      const env = fromStratus({ thread: 'thr_demo', parts: [{ type: 'text', text: 'Hello from Stratus Labs.' }, { type: 'data', data: { type: 'demo.ping' } }] });
      await t.node.receive(env);
      assert.deepEqual(await feed('echo@demo.test'), [], 'nothing on the feed before the worker delivers');

      await t.node.worker.drain();
      assert.equal(await state(env.id, 'echo@demo.test'), 'delivered');
      const events = await feed('echo@demo.test');
      assert.equal(events.length, 1);
      const [event] = events;
      assert.equal(event.type, 'message');
      assert.equal(event.address, 'echo@demo.test');
      assert.equal(event.message.id, env.id);
      assert.equal(event.message.thread, 'thr_demo');
      assert.equal(event.message.from, 'agent@s.test');
      assert.equal(event.message.on_behalf_of, 'dylan@s.test');
      assert.equal(event.message.intent, 'request');
      assert.equal(event.message.sender_type, 'agent');
      assert.equal(event.message.text, 'Hello from Stratus Labs.');
      assert.deepEqual(event.message.parts, env.content.parts);
      assert.deepEqual(event.verified, { signature: stratus.kid, delegation: 'dylan@s.test' });
      assert.deepEqual(await receiptsSent(), ['delivered']);

      const d = (await t.node.store.getDelivery({ direction: 'in', from: env.from, message_id: env.id, recipient: 'echo@demo.test' }))!;
      assert.equal(d.channel, 'agent');
      assert.match(d.native_id ?? '', /^event:\d+$/);
    });

    it('lets the agent mark a message read and reply on the same thread', async () => {
      const env = fromStratus({ thread: 'thr_demo' });
      await t.node.receive(env);
      await t.node.worker.drain();

      t.clock.advance(1000);
      assert.equal(await t.node.markReadBy(env.id, 'echo@demo.test'), true);
      assert.equal(await t.node.markReadBy(env.id, 'echo@demo.test'), false, 'marking twice changes nothing');
      assert.equal(await t.node.markReadBy('msg_unknown', 'echo@demo.test'), false);
      assert.equal(await state(env.id, 'echo@demo.test'), 'read');

      t.clock.advance(1000);
      const reply = await t.node.submit(
        { from: 'echo@demo.test', to: ['agent@s.test'], intent: 'inform', text: 'Received your request.', thread: 'thr_demo' },
        { inReplyTo: env.id },
      );
      assert.equal(reply.thread, 'thr_demo');
      assert.equal(await state(env.id, 'echo@demo.test'), 'replied');
      assert.deepEqual(await receiptsSent(), ['delivered', 'read', 'replied']);

      const stored = (await t.node.store.getMessage('out', 'echo@demo.test', reply.id))!;
      assert.equal(stored.sender_type, 'agent');
      assert.equal(stored.envelope.on_behalf_of, undefined, 'echo acts for no one');
    });

    it('sends delivered, read, replied and then the reply itself, in that order', async () => {
      const env = fromStratus({ thread: 'thr_demo' });
      await t.node.receive(env);
      await t.node.worker.drain();
      // The agent reads and answers within the same instant: nothing but creation order separates these.
      await t.node.markReadBy(env.id, 'echo@demo.test');
      await t.node.submit({ from: 'echo@demo.test', to: ['agent@s.test'], intent: 'inform', text: 'Received.', thread: 'thr_demo' }, { inReplyTo: env.id });
      await t.node.worker.drain();
      assert.deepEqual(wire, ['delivered', 'read', 'replied', 'inform']);
    });

    it('records nothing as replied when the reply itself is invalid', async () => {
      const env = fromStratus();
      await t.node.receive(env);
      await t.node.worker.drain();
      await assert.rejects(t.node.submit({ from: 'echo@demo.test', to: ['agent@s.test'], intent: 'inform', text: '  ' }, { inReplyTo: env.id }), /text part/);
      assert.equal(await state(env.id, 'echo@demo.test'), 'delivered');
    });

    it('counts a message as a reply only when it is addressed to the sender it answers', async () => {
      const env = fromStratus({ thread: 'thr_demo' });
      await t.node.receive(env);
      await t.node.worker.drain();

      // The only message with this id is from agent@s.test, and this one goes to someone else.
      const elsewhere = await t.node.submit({ from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'About that request.' }, { inReplyTo: env.id });
      assert.equal(elsewhere.created, true, 'the message itself still goes out');
      assert.equal(await state(elsewhere.id, 'peer@r.test', 'out'), 'pending');
      assert.equal(await state(env.id, 'echo@demo.test'), 'delivered', 'the request was not answered');
      assert.deepEqual(await receiptsSent(), ['delivered'], 'and its sender is not told it was');

      // Naming the sender does not help while the message is written to someone else.
      await t.node.submit(
        { from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'Still about that request.' },
        { inReplyTo: { message_id: env.id, from: 'agent@s.test' } },
      );
      assert.equal(await state(env.id, 'echo@demo.test'), 'delivered');
      assert.deepEqual(await receiptsSent(), ['delivered']);

      // A message that reaches the sender is an answer, whoever else it also goes to.
      await t.node.submit({ from: 'echo@demo.test', to: ['peer@r.test', 'Agent@S.test'], intent: 'inform', text: 'Received.', thread: 'thr_demo' }, { inReplyTo: env.id });
      assert.equal(await state(env.id, 'echo@demo.test'), 'replied');
      assert.deepEqual(await receiptsSent(), ['delivered', 'replied']);
    });

    it('changes nothing when a reply reuses the id of a message already submitted', async () => {
      const env = fromStratus({ thread: 'thr_demo' });
      await t.node.receive(env);
      await t.node.worker.drain();
      const earlier = await t.node.submit({ id: 'msg_taken', from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'Something else entirely.' });
      assert.equal(earlier.created, true);

      // The id is taken, so this reply is thrown away. Nothing may say the request was answered.
      const reply = { id: 'msg_taken', from: 'echo@demo.test', to: ['agent@s.test'], intent: 'inform' as const, text: 'Received.', thread: 'thr_demo' };
      const repeat = await t.node.submit(reply, { inReplyTo: env.id });
      assert.equal(repeat.created, false);
      assert.equal(repeat.thread, earlier.thread, 'the answer describes the message that is stored');
      assert.equal(await state(env.id, 'echo@demo.test'), 'delivered', 'the request was not answered');
      assert.deepEqual(await receiptsSent(), ['delivered'], 'and its sender is not told it was');
      assert.equal(await state('msg_taken', 'agent@s.test', 'out'), undefined, 'no answer was queued for them');

      // Under an id of its own the same reply counts, and repeating it adds nothing.
      const sent = await t.node.submit({ ...reply, id: 'msg_reply' }, { inReplyTo: env.id });
      assert.equal(sent.created, true);
      assert.equal(await state(env.id, 'echo@demo.test'), 'replied');
      assert.equal((await t.node.submit({ ...reply, id: 'msg_reply' }, { inReplyTo: env.id })).created, false);
      assert.deepEqual(await receiptsSent(), ['delivered', 'replied']);
      await t.node.worker.drain();
      assert.deepEqual(wire, ['delivered', 'inform', 'replied', 'inform'], 'the earlier message, then "replied" ahead of the one reply');
    });

    it('keeps messages for different agents on separate feeds', async () => {
      await t.node.receive(fromStratus());
      await t.node.worker.drain();
      assert.equal((await feed('echo@demo.test')).length, 1);
      assert.deepEqual(await feed('bot@demo.test'), []);
      await assert.rejects(t.node.events('nobody@demo.test', 0), /not an address hosted on this node/);
      await assert.rejects(t.node.events('agent@s.test', 0), /not an address hosted on this node/);
    });
  });

  describe('status events for the sending agent', () => {
    const receipt = (sent: { id: string; thread: string }, status: 'delivered' | 'read' | 'replied', at: string) =>
      signedEnvelope(
        { from: 'peer@r.test', to: ['bot@demo.test'], thread: sent.thread, intent: 'status', parts: receiptParts({ message_id: sent.id, status, at }) },
        stranger,
      );
    const statuses = async () => (await feed('bot@demo.test')).filter((e) => e.type === 'status').map((e) => e.status);

    it('reports accepted, then delivered, read and replied as they come back', async () => {
      const sent = await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'request', text: 'ping' });
      assert.deepEqual(await statuses(), []);
      await t.node.worker.drain();

      let events = await feed('bot@demo.test');
      assert.equal(events.length, 1);
      assert.equal(events[0].status, 'accepted');
      assert.equal(events[0].message_id, sent.id);
      assert.equal(events[0].thread, sent.thread);
      assert.equal(events[0].recipient, 'peer@r.test');
      assert.deepEqual(events[0].verified, { signature: 'ed25519-remote' }, "carries what the recipient's node verified");
      assert.deepEqual(events[0].receipt, { by: 'peer@r.test', kid: stranger.kid }, 'and whose signed receipt this node checked');

      await t.node.receive(receipt(sent, 'delivered', '2026-06-01T12:00:01.000Z'));
      await t.node.receive(receipt(sent, 'read', '2026-06-01T12:00:02.000Z'));
      await t.node.receive(receipt(sent, 'replied', '2026-06-01T12:00:03.000Z'));
      events = await feed('bot@demo.test');
      assert.deepEqual(events.map((e) => e.status), ['accepted', 'delivered', 'read', 'replied']);
      assert.deepEqual(events.slice(1).map((e) => e.at), ['2026-06-01T12:00:01.000Z', '2026-06-01T12:00:02.000Z', '2026-06-01T12:00:03.000Z']);
      assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq), 'sequence numbers increase');

      // The receipts are plumbing: they reach neither feed as messages nor produce status events of their own.
      assert.equal((await feed('bot@demo.test')).filter((e) => e.type === 'message').length, 0);
    });

    it('stays in order when a receipt overtakes the ack', async () => {
      const sent = await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'request', text: 'ping' });
      // The delivered receipt lands while the outbound delivery is still waiting for its ack.
      await t.node.receive(receipt(sent, 'delivered', '2026-06-01T12:00:01.000Z'));
      assert.deepEqual(await statuses(), ['accepted', 'delivered']);
      await t.node.worker.drain();
      assert.deepEqual(await statuses(), ['accepted', 'delivered'], 'the late ack adds nothing');
      assert.equal(await state(sent.id, 'peer@r.test', 'out'), 'delivered');
    });

    it('still reports a receipt that arrives after a later one', async () => {
      const sent = await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'request', text: 'ping' });
      await t.node.worker.drain();
      await t.node.receive(receipt(sent, 'replied', '2026-06-01T12:00:03.000Z'));
      await t.node.receive(receipt(sent, 'read', '2026-06-01T12:00:02.000Z'));
      await t.node.receive(receipt(sent, 'delivered', '2026-06-01T12:00:01.000Z'));

      assert.deepEqual(await statuses(), ['accepted', 'replied', 'read', 'delivered'], 'every status is reported once, as it arrives');
      const d = (await t.node.store.getDelivery({ direction: 'out', from: 'bot@demo.test', message_id: sent.id, recipient: 'peer@r.test' }))!;
      assert.equal(d.state, 'replied', 'the state never moves backwards');
      assert.equal(d.read_at?.toISOString(), '2026-06-01T12:00:02.000Z', 'but the late timestamps are kept');
      assert.equal(d.delivered_at?.toISOString(), '2026-06-01T12:00:01.000Z');
    });

    it('reports a rejection with its reason', async () => {
      remote = { status: 401, error: 'bad_signature', message: 'the envelope signature does not verify' };
      await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'request', text: 'ping' });
      await t.node.worker.drain();
      const [event] = await feed('bot@demo.test');
      assert.equal(event.status, 'rejected');
      assert.deepEqual(event.reason, { code: 'bad_signature', message: 'the envelope signature does not verify', retryable: false });
    });

    it('reports failed once retries run out, and expired when the deadline passes', async () => {
      remote = new Error('connect ECONNREFUSED');
      await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'will fail' });
      for (let i = 0; i < 3; i++) {
        await t.node.worker.drain();
        t.clock.advance(60_000);
      }
      assert.deepEqual(await statuses(), ['failed']);
      assert.match((await feed('bot@demo.test'))[0].detail, /gave up after 3 attempts/);

      await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'will expire', expires_at: new Date(t.clock.now().getTime() + 5000).toISOString() });
      await t.node.worker.drain();
      t.clock.advance(10_000);
      await t.node.worker.drain();
      assert.deepEqual(await statuses(), ['failed', 'expired']);
    });
  });

  describe('reading the feed', () => {
    it('pages by sequence number', async () => {
      for (const text of ['one', 'two', 'three']) {
        await t.node.receive(fromStratus({ text }));
        await t.node.worker.drain();
      }
      const all = await t.node.events('echo@demo.test', 0);
      assert.deepEqual(all.map((e) => (e.data.message as { text: string }).text), ['one', 'two', 'three']);
      assert.equal((await t.node.events('echo@demo.test', all[0]!.seq)).length, 2);
      assert.equal((await t.node.events('echo@demo.test', 0, { limit: 2 })).length, 2);
      assert.equal(await t.node.latestEvent('echo@demo.test'), all[2]!.seq);
      assert.deepEqual(await t.node.events('echo@demo.test', all[2]!.seq), []);
      assert.equal(await t.node.latestEvent('bot@demo.test'), 0);
    });

    it('long-polls: answers as soon as an event arrives, or with nothing when the wait is over', async () => {
      const started = Date.now();
      const waiting = t.node.events('echo@demo.test', 0, { waitMs: 5000 });
      setTimeout(() => void t.node.receive(fromStratus()).then(() => t.node.worker.drain()), 60);
      const events = await waiting;
      assert.equal(events.length, 1);
      assert.ok(Date.now() - started < 2000, 'returned well before the timeout');

      const emptyStarted = Date.now();
      assert.deepEqual(await t.node.events('echo@demo.test', events[0]!.seq, { waitMs: 250 }), []);
      const waited = Date.now() - emptyStarted;
      assert.ok(waited >= 200 && waited < 2000, `waited ${waited}ms`);
    });
  });

  describe('acts_for and node-signed delegation', () => {
    it('sends for the configured principal and signs the delegation itself', async () => {
      const sent = await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'request', text: 'on behalf of dylan' });
      const stored = (await t.node.store.getMessage('out', 'bot@demo.test', sent.id))!;
      const env = stored.envelope;
      assert.equal(env.on_behalf_of, 'dylan@demo.test');
      assert.equal(stored.sender_type, 'agent');
      assert.equal(typeof env.delegation, 'string');
      const check = verifyDelegation({
        token: env.delegation!,
        principal: 'dylan@demo.test',
        agent: 'bot@demo.test',
        intent: 'request',
        audiences: ['adtp'],
        keys: t.keys.publicKeys(),
        now: t.clock.now(),
      });
      assert.ok(check.ok, check.ok ? '' : check.message);
      // A token for this one message: its intent only, valid for as long as the message can still be delivered.
      assert.deepEqual(check.claims.scope, ['request']);
      assert.equal(check.claims.aud, 'adtp');
      assert.equal(check.claims.exp * 1000, Date.parse(env.expires_at!));
      assert.ok(verifySignature(env, t.keys.publicKeys(), t.clock.now()).ok);
      assert.deepEqual(Object.keys(env), ['adtp', 'id', 'thread', 'from', 'on_behalf_of', 'to', 'intent', 'priority', 'created_at', 'expires_at', 'requires_approval', 'content', 'delegation', 'signature']);

      const other = await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'another' });
      const otherToken = (await t.node.store.getMessage('out', 'bot@demo.test', other.id))!.envelope.delegation!;
      assert.notEqual(otherToken, env.delegation, 'every message gets its own token');
    });

    it('a delegated message is verified end to end on the receiving side', async () => {
      // bot -> echo on the same node: goes through the full inbound pipeline, including the delegation check.
      const sent = await t.node.submit({ from: 'bot@demo.test', to: ['echo@demo.test'], intent: 'request', text: 'hello neighbour' });
      await t.node.worker.drain();
      const [event] = (await feed('echo@demo.test')).filter((e) => e.type === 'message');
      assert.equal(event.message.id, sent.id);
      assert.equal(event.message.on_behalf_of, 'dylan@demo.test');
      assert.deepEqual(event.verified, { signature: t.keys.kid, delegation: 'dylan@demo.test' });
      assert.equal(posts, 0);
    });

    it('humans and agents without a principal send as themselves', async () => {
      const human = await t.node.submit({ from: 'dylan@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'from a person' });
      const env = (await t.node.store.getMessage('out', 'dylan@demo.test', human.id))!.envelope;
      assert.equal(env.on_behalf_of, undefined);
      assert.equal(env.delegation, undefined);

      const asSelf = await t.node.submit({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'just me', on_behalf_of: null });
      assert.equal((await t.node.store.getMessage('out', 'bot@demo.test', asSelf.id))!.envelope.on_behalf_of, undefined);
    });

    it('needs a token from the principal when the principal lives on another node', async () => {
      await assert.rejects(
        t.node.submit({ from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'x', on_behalf_of: 'dylan@s.test' }),
        /hosted elsewhere, so a delegation token from its node is required/,
      );
      const { token } = mintDelegation({ principal: 'dylan@s.test', agent: 'echo@demo.test', scope: ['inform'], ttlSeconds: 600, now: t.clock.now() }, stratus);
      const sent = await t.node.submit({ from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'x', on_behalf_of: 'dylan@s.test', delegation: token });
      assert.equal((await t.node.store.getMessage('out', 'echo@demo.test', sent.id))!.envelope.delegation, token);
    });

    it('stops sending with a delegation one of its own principals took back', async () => {
      // dylan lets echo, which does not normally act for him, send informs on his behalf.
      const grant = t.node.delegate('dylan@demo.test', 'echo@demo.test', { scope: ['inform'] });
      const draft = { from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform' as const, text: 'for dylan', on_behalf_of: 'dylan@demo.test', delegation: grant.token };
      assert.equal((await t.node.submit(draft)).created, true);

      await t.node.revokeDelegation(grant.jti);
      await assert.rejects(t.node.submit(draft), /this delegation token has been revoked/);
      await assert.rejects(t.node.preview(draft), /revoked/);
    });

    it('does not send a message that was queued before its delegation was revoked', async () => {
      const grant = t.node.delegate('dylan@demo.test', 'echo@demo.test', { scope: ['inform'] });
      const draft = { from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform' as const, text: 'for dylan', on_behalf_of: 'dylan@demo.test', delegation: grant.token };
      const statuses = async () => (await feed('echo@demo.test')).filter((e) => e.type === 'status');

      // Queued, never attempted, then revoked: it never goes on the wire.
      const queued = await t.node.submit(draft);
      await t.node.revokeDelegation(grant.jti);
      await t.node.worker.drain();
      assert.equal(posts, 0, 'the other node never sees it');
      assert.equal(await state(queued.id, 'peer@r.test', 'out'), 'rejected');
      const [event] = await statuses();
      assert.equal(event.status, 'rejected');
      assert.equal(event.reason.code, 'delegation_invalid');
      assert.match(event.reason.message, /revoked before the message was sent/);
    });

    it('stops retrying a message once its delegation is revoked', async () => {
      const grant = t.node.delegate('dylan@demo.test', 'echo@demo.test', { scope: ['inform'] });
      // The other node is down, so the message waits for its next attempt.
      remote = new Error('connect ECONNREFUSED');
      const sent = await t.node.submit({ from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'for dylan', on_behalf_of: 'dylan@demo.test', delegation: grant.token });
      await t.node.worker.drain();
      assert.equal(posts, 1);
      assert.equal(await state(sent.id, 'peer@r.test', 'out'), 'pending');

      // The other node comes back, but by then the delegation has been taken back.
      await t.node.revokeDelegation(grant.jti);
      remote = 'accepted';
      t.clock.advance(60_000);
      await t.node.worker.drain();
      assert.equal(posts, 1, 'no further attempt is made');
      assert.equal(await state(sent.id, 'peer@r.test', 'out'), 'rejected');

      // A delegation from a principal hosted elsewhere is not this node's to revoke: such messages are sent as before.
      const { token } = mintDelegation({ principal: 'dylan@s.test', agent: 'echo@demo.test', scope: ['inform'], ttlSeconds: 600, now: t.clock.now() }, stratus);
      const other = await t.node.submit({ from: 'echo@demo.test', to: ['peer@r.test'], intent: 'inform', text: 'x', on_behalf_of: 'dylan@s.test', delegation: token });
      await t.node.worker.drain();
      assert.equal(await state(other.id, 'peer@r.test', 'out'), 'sent');
    });

    it('rejects on_behalf_of without a delegation token on the way in', async () => {
      const env = signedEnvelope({ from: 'agent@s.test', to: ['echo@demo.test'], on_behalf_of: 'dylan@s.test' }, stratus);
      const ack = await t.node.receive(env);
      assert.equal(ack.reason?.code, 'delegation_invalid');
    });

    it('publishes acts_for in the agent card', () => {
      const card = t.node.card('bot@demo.test')!;
      assert.equal(card.type, 'agent');
      assert.equal(card.acts_for, 'dylan@demo.test');
      assert.equal(card.endpoint, 'https://demo.test/adtp/v0/messages');
      assert.equal(t.node.card('echo@demo.test')!.acts_for, undefined);
      assert.equal(t.node.card('nobody@demo.test'), null);
    });
  });

  it('preview signs an envelope without storing or sending it', async () => {
    const env = await t.node.preview({ from: 'bot@demo.test', to: ['peer@r.test'], intent: 'request', text: 'dry run' });
    assert.ok(verifySignature(env, t.keys.publicKeys(), t.clock.now()).ok);
    assert.match(env.id, /^msg_/);
    assert.match(env.thread ?? '', /^thr_/);
    assert.equal((await t.db.conn.query('SELECT 1 FROM messages')).rowCount, 0);
    await t.node.worker.drain();
    assert.equal(posts, 0);
  });
});
