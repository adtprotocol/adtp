/**
 * The outbound side against a real database: signing, queueing, the wire
 * format, checking the other node's receipt, retries with exponential
 * backoff, and final states.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { HttpClient, HttpRequestOptions } from '../src/identity/safe-http.js';
import { ADTP_CONTENT_TYPE } from '../src/protocol/constants.js';
import { signObject, verifySignature } from '../src/protocol/signing.js';
import type { Ack, Envelope, RecipientAck } from '../src/protocol/types.js';
import { createTestNode, dbAvailable, TEST_EPOCH, TestKeys, type TestNode } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
/** What the recipient node answers: a fixed answer, one computed from the posted envelope, or a network failure. */
type Reply = Answer | Error | ((envelope: Envelope) => Answer);

const ENDPOINT = 'https://node.b.test/adtp/v0/messages';

describe('outbound delivery', { skip }, () => {
  let t: TestNode;
  let requests: { url: string; options: HttpRequestOptions }[];
  /** One entry per request; the last entry repeats. */
  let replies: Reply[];
  const bobKeys = new TestKeys();

  const http: HttpClient = async (url, options = {}) => {
    requests.push({ url, options });
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    const answer = typeof reply === 'function' ? reply(JSON.parse(options.body!) as Envelope) : reply;
    return { status: answer.status, headers: answer.headers ?? {}, body: answer.body };
  };

  /** The signed receipt Bob's node would return for the envelope it was sent. */
  const receipt =
    (status: 'accepted' | 'queued', extra: Partial<Ack> = {}, signer = bobKeys) =>
    (envelope: Envelope): Answer => ({
      status: 202,
      body: JSON.stringify(
        signObject({ adtp: '0', id: envelope.id, from: envelope.from, by: 'bob@b.test', status, verified: { signature: envelope.signature.kid }, at: TEST_EPOCH, ...extra }, signer),
      ),
    });
  const refusal = (status: number, error: string, message: string, extra: { retryable?: boolean; recipients?: Record<string, RecipientAck>; headers?: Record<string, string> } = {}): Answer => ({
    status,
    headers: extra.headers,
    body: JSON.stringify({ error, message, retryable: extra.retryable === true, ...(extra.recipients ? { recipients: extra.recipients } : {}) }),
  });
  const unreachable = new Error('connect ECONNREFUSED 203.0.113.9:443');

  const send = (overrides: Record<string, unknown> = {}) =>
    t.node.submit({ from: 'alice@a.test', to: ['bob@b.test'], intent: 'request', text: 'can we talk?', ...overrides } as Parameters<typeof t.node.submit>[0]);
  const delivery = async (id: string, recipient = 'bob@b.test') =>
    (await t.node.store.getDelivery({ direction: 'out', from: 'alice@a.test', message_id: id, recipient }))!;

  beforeEach(async () => {
    requests = [];
    replies = [receipt('accepted')];
    t = await createTestNode(
      'a.test',
      {
        addresses: [
          { local: 'alice', type: 'human', routes: [{ default: true, channel: 'email', to: 'alice@mail.test' }] },
          { local: 'carol', type: 'human', routes: [{ default: true, channel: 'email', to: 'carol@mail.test' }] },
        ],
      },
      { http },
    );
    t.resolver.add(bobKeys.card('bob@b.test', 'human', ENDPOINT));
  });
  afterEach(async () => {
    await t.close();
  });

  it('signs the envelope and posts it, as it is, to the endpoint in the recipient card', async () => {
    const sent = await send({ thread: 'thread-3', priority: 'urgent', data: [{ topic: 'budget' }] });
    assert.equal(sent.created, true);
    assert.equal(sent.thread, 'thread-3');
    assert.equal((await delivery(sent.id)).state, 'pending', 'queued before anything goes on the wire');

    await t.node.worker.drain();
    assert.equal(requests.length, 1);
    const { url, options } = requests[0]!;
    assert.equal(url, ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers!['content-type'], ADTP_CONTENT_TYPE);

    // The body is the envelope and nothing else: no wrapper around it.
    const envelope = JSON.parse(options.body!) as Envelope;
    assert.deepEqual(Object.keys(envelope), ['adtp', 'id', 'thread', 'from', 'to', 'intent', 'priority', 'created_at', 'expires_at', 'requires_approval', 'content', 'signature']);
    assert.equal(envelope.id, sent.id);
    assert.match(sent.id, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/, 'ids are msg_<ulid>');
    assert.equal(envelope.from, 'alice@a.test');
    assert.deepEqual(envelope.to, ['bob@b.test']);
    assert.equal(envelope.intent, 'request');
    assert.equal(envelope.priority, 'urgent');
    assert.equal(envelope.thread, 'thread-3');
    assert.equal(envelope.created_at, '2026-06-01T12:00:00Z', 'created when it was signed, to the second');
    assert.equal(envelope.expires_at, '2026-06-08T12:00:00Z', 'seven days to live unless the sender says otherwise');
    assert.deepEqual(envelope.content, {
      parts: [
        { type: 'text', text: 'can we talk?' },
        { type: 'data', data: { topic: 'budget' } },
      ],
    });
    assert.deepEqual(envelope.signature, { alg: 'Ed25519', kid: t.keys.kid, value: envelope.signature.value });
    assert.deepEqual(verifySignature(envelope, t.keys.publicKeys(), t.clock.now()), { ok: true, kid: t.keys.kid }, "verifies against this node's published key");

    const d = await delivery(sent.id);
    assert.equal(d.state, 'sent');
    assert.equal(d.attempts, 1);
    assert.equal(d.remote_ack?.status, 'accepted');
    assert.ok(verifySignature(d.remote_ack!, bobKeys.publicKeys(), t.clock.now()).ok, "the other node's signed receipt is kept as proof");
    assert.equal(await t.node.store.isContact('alice@a.test', 'bob@b.test'), true, 'writing to someone makes them a known contact');
  });

  it('retries with exponential backoff while the recipient node is unreachable, then fails for good', async () => {
    replies = [unreachable];
    const sent = await send();

    await t.node.worker.drain();
    let d = await delivery(sent.id);
    assert.equal(d.state, 'pending');
    assert.equal(d.attempts, 1);
    assert.match(d.last_error ?? '', /ECONNREFUSED/);
    assert.equal(d.next_attempt_at.getTime() - t.clock.now().getTime(), 10_000);

    await t.node.worker.drain();
    assert.equal(requests.length, 1, 'nothing is retried before its time');

    t.clock.advance(9_999);
    await t.node.worker.drain();
    assert.equal(requests.length, 1);

    t.clock.advance(1);
    await t.node.worker.drain();
    d = await delivery(sent.id);
    assert.equal(requests.length, 2);
    assert.equal(d.attempts, 2);
    assert.equal(d.next_attempt_at.getTime() - t.clock.now().getTime(), 20_000, 'the wait doubles');

    t.clock.advance(20_000);
    await t.node.worker.drain();
    d = await delivery(sent.id);
    assert.equal(requests.length, 3);
    assert.equal(d.state, 'failed', 'max_attempts (3) reached');
    assert.match(d.last_error ?? '', /gave up after 3 attempts: connect ECONNREFUSED/);

    t.clock.advance(6 * 24 * 60 * 60 * 1000);
    await t.node.worker.drain();
    assert.equal(requests.length, 3, 'failed is final: no dead-letter retries');
  });

  it('delivers once the recipient node comes back', async () => {
    replies = [unreachable, { status: 503, body: 'maintenance' }, receipt('queued')];
    const sent = await send();
    await t.node.worker.drain();
    t.clock.advance(10_000);
    await t.node.worker.drain();
    assert.equal((await delivery(sent.id)).state, 'pending');
    assert.match((await delivery(sent.id)).last_error ?? '', /HTTP 503/);
    t.clock.advance(20_000);
    await t.node.worker.drain();

    const d = await delivery(sent.id);
    assert.equal(d.state, 'sent');
    assert.equal(d.attempts, 3);
    assert.equal(d.last_error, null);
    assert.equal(d.remote_ack?.status, 'queued');
    assert.equal(new Set(requests.map((r) => r.options.body)).size, 1, 'every attempt sends the same bytes: the envelope is signed once');
  });

  it('retries when the recipient cannot be discovered yet', async () => {
    const sent = await send({ to: ['dave@d.test'] });
    await t.node.worker.drain();
    const d = await delivery(sent.id, 'dave@d.test');
    assert.equal(d.state, 'pending');
    assert.match(d.last_error ?? '', /could not resolve dave@d\.test/);
    assert.equal(requests.length, 0);

    const daveKeys = new TestKeys();
    t.resolver.add(daveKeys.card('dave@d.test', 'human', 'https://node.d.test/adtp/v0/messages'));
    replies = [receipt('accepted', { by: 'dave@d.test' }, daveKeys)];
    t.clock.advance(10_000);
    await t.node.worker.drain();
    assert.equal((await delivery(sent.id, 'dave@d.test')).state, 'sent');
    assert.equal(requests[0]!.url, 'https://node.d.test/adtp/v0/messages');
  });

  it('marks a message expired instead of sending it after expires_at', async () => {
    replies = [unreachable];
    const sent = await send({ expires_at: new Date(t.clock.now().getTime() + 15_000).toISOString() });
    await t.node.worker.drain();
    assert.equal(requests.length, 1);

    replies = [receipt('accepted')];
    t.clock.advance(15_000);
    await t.node.worker.drain();
    const d = await delivery(sent.id);
    assert.equal(d.state, 'expired');
    assert.equal(requests.length, 1, 'nothing is sent once the deadline has passed');
  });

  it('treats a refusal as final, unless the recipient node says it may be retried', async () => {
    replies = [refusal(403, 'not_trusted', 'a first message must use inform or request')];
    const refused = await send({ intent: 'propose' });
    await t.node.worker.drain();
    let d = await delivery(refused.id);
    assert.equal(d.state, 'rejected');
    assert.match(d.last_error ?? '', /not_trusted: a first message/);
    t.clock.advance(3_600_000);
    await t.node.worker.drain();
    assert.equal(requests.length, 1);

    for (const [status, code] of [[400, 'invalid_envelope'], [401, 'bad_signature'], [404, 'unknown_recipient'], [409, 'id_conflict'], [410, 'expired'], [413, 'too_large']] as const) {
      replies = [refusal(status, code, 'no')];
      const sent = await send();
      await t.node.worker.drain();
      assert.equal((await delivery(sent.id)).state, 'rejected', `${status} ${code} is not retried`);
    }
  });

  it('retries on 429, on 5xx and on retryable: true, and waits as long as Retry-After asks', async () => {
    replies = [refusal(429, 'rate_limited', 'slow down', { retryable: true, headers: { 'retry-after': '120' } }), receipt('queued')];
    const limited = await send();
    await t.node.worker.drain();
    let d = await delivery(limited.id);
    assert.equal(d.state, 'pending');
    assert.match(d.last_error ?? '', /rate_limited/);
    assert.equal(d.next_attempt_at.getTime() - t.clock.now().getTime(), 120_000, 'not sooner than the other node asked, even though backoff alone would say 10s');
    t.clock.advance(10_000);
    await t.node.worker.drain();
    assert.equal(requests.length, 1);
    t.clock.advance(110_000);
    await t.node.worker.drain();
    assert.equal((await delivery(limited.id)).state, 'sent');

    // The same decision from the status code alone, and from the flag alone.
    for (const reply of [refusal(429, 'rate_limited', 'slow down'), { status: 500, body: 'oops' }, refusal(503, 'sender_unresolvable', 'cannot reach your card', { retryable: true }), refusal(409, 'busy', 'later', { retryable: true })]) {
      replies = [reply];
      const sent = await send();
      await t.node.worker.drain();
      assert.equal((await delivery(sent.id)).state, 'pending', `${reply.status} is retried`);
    }
  });

  it('uses the per-recipient outcome when the receipt carries one', async () => {
    const recipients: Record<string, RecipientAck> = {
      'bob@b.test': { status: 'accepted' },
      'ben@b.test': { status: 'rejected', reason: { code: 'unknown_recipient', message: 'ben@b.test is not hosted on this node' } },
    };
    replies = [receipt('accepted', { recipients })];
    t.resolver.add(bobKeys.card('ben@b.test', 'human', ENDPOINT));
    const sent = await send({ to: ['bob@b.test', 'ben@b.test'] });
    await t.node.worker.drain();
    assert.equal((await delivery(sent.id, 'bob@b.test')).state, 'sent');
    assert.equal((await delivery(sent.id, 'ben@b.test')).state, 'rejected');
    assert.equal(requests.length, 2, 'one request per recipient; the receiving node recognizes the repeat');
  });

  it('uses the per-recipient outcome when every recipient was turned away', async () => {
    const recipients: Record<string, RecipientAck> = {
      'bob@b.test': { status: 'rejected', reason: { code: 'rate_limited', message: 'slow down', retryable: true } },
      'ben@b.test': { status: 'rejected', reason: { code: 'unknown_recipient', message: 'no such mailbox' } },
    };
    replies = [refusal(429, 'rate_limited', 'slow down', { retryable: true, recipients })];
    t.resolver.add(bobKeys.card('ben@b.test', 'human', ENDPOINT));
    const sent = await send({ to: ['bob@b.test', 'ben@b.test'] });
    await t.node.worker.drain();
    assert.equal((await delivery(sent.id, 'bob@b.test')).state, 'pending', 'worth another try');
    assert.equal((await delivery(sent.id, 'ben@b.test')).state, 'rejected', 'final, although the answer as a whole was "try again"');
  });

  it('only trusts a receipt that is about this message and signed by its recipient', async () => {
    const expectUntrusted = async (reply: Reply, pattern: RegExp) => {
      replies = [reply];
      const sent = await send();
      await t.node.worker.drain();
      const d = await delivery(sent.id);
      assert.equal(d.state, 'pending', 'an answer that proves nothing is not an acceptance; the message is sent again later');
      assert.match(d.last_error ?? '', pattern);
    };
    await expectUntrusted(receipt('accepted', {}, new TestKeys()), /signature on the recipient node's receipt does not verify/);
    await expectUntrusted(receipt('accepted', { id: 'msg_some_other_message' }), /receipt for a different message/);
    await expectUntrusted(receipt('accepted', { from: 'mallory@m.test' }), /receipt for a different message/);
    await expectUntrusted(receipt('accepted', { by: 'stranger@b.test' }), /not signed by a recipient of the message/);
    await expectUntrusted({ status: 200, body: '<html>It works!</html>' }, /without a signed receipt/);
    await expectUntrusted({ status: 202, body: JSON.stringify({ id: 'x', status: 'accepted' }) }, /without a signed receipt/);
    // A receipt whose body was changed after signing.
    await expectUntrusted((envelope) => {
      const signed = JSON.parse(receipt('queued')(envelope).body) as Ack;
      return { status: 202, body: JSON.stringify({ ...signed, status: 'accepted' }) };
    }, /does not verify/);
  });

  it('does not send what the recipient card says it will not take', async () => {
    t.resolver.add({ ...bobKeys.card('picky@b.test', 'agent', ENDPOINT), accepts: ['inform'], max_bytes: 600 });
    const wrongIntent = await send({ to: ['picky@b.test'], intent: 'request' });
    const tooBig = await send({ to: ['picky@b.test'], intent: 'inform', text: 'x'.repeat(700) });
    await t.node.worker.drain();
    assert.equal(requests.length, 0, 'nothing went on the wire');
    assert.equal((await delivery(wrongIntent.id, 'picky@b.test')).state, 'rejected');
    assert.match((await delivery(wrongIntent.id, 'picky@b.test')).last_error ?? '', /does not accept the intent "request"/);
    assert.equal((await delivery(tooBig.id, 'picky@b.test')).state, 'rejected');
    assert.match((await delivery(tooBig.id, 'picky@b.test')).last_error ?? '', /too_large.*at most 600/);
  });

  it('refuses drafts it could not deliver', async () => {
    await assert.rejects(send({ from: 'stranger@a.test' }), /not an address hosted on this node/);
    await assert.rejects(send({ from: 'alice@elsewhere.test' }), /not an address hosted on this node/);
    await assert.rejects(send({ to: [] }), /at least one recipient/);
    await assert.rejects(send({ to: ['not-an-address'] }), /not a valid address/);
    await assert.rejects(send({ intent: 'shout' }), /intent/);
    await assert.rejects(send({ priority: 'high' }), /priority: must be one of low, normal, urgent/);
    await assert.rejects(send({ text: '   ' }), /text part/);
    await assert.rejects(send({ expires_at: new Date(t.clock.now().getTime() - 1).toISOString() }), /already in the past/);
    await assert.rejects(send({ expires_at: 'soon' }), /expires_at/);
    await assert.rejects(send({ text: 'x'.repeat(270_000) }), /the limit is 262144/);
    assert.equal((await t.db.conn.query('SELECT 1 FROM messages')).rowCount, 0);
  });

  it('submitting the same id twice queues it once', async () => {
    const first = await send({ id: 'my-id-1' });
    const second = await send({ id: 'my-id-1', text: 'different text, same id' });
    assert.deepEqual([first.created, second.created], [true, false]);
    await t.node.worker.drain();
    assert.equal(requests.length, 1);
  });

  it('answers a repeated submission with the thread that was stored, not a new one', async () => {
    // No thread given: the node makes one up. A retry of the same submission must not be told a different one.
    const first = await send({ id: 'my-id-2' });
    const second = await send({ id: 'my-id-2' });
    assert.equal(second.created, false);
    assert.equal(second.thread, first.thread);
    assert.deepEqual((await t.node.thread(second.thread)).map((m) => m.id), ['my-id-2'], 'the thread the caller is given is one that exists');

    // And when the caller names a thread on the retry, the stored one still wins: nothing was stored under the new name.
    const third = await send({ id: 'my-id-2', thread: 'thr_some_other_thread' });
    assert.equal(third.thread, first.thread);
    assert.deepEqual(await t.node.thread('thr_some_other_thread'), []);
  });

  it('records "sent" together with the event that tells the sending agent', async () => {
    const statuses = async () => (await t.node.events('alice@a.test', 0)).map((e) => `${e.data.message_id}:${e.data.status}`);
    const store = t.node.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const real = store.addEvent!;
    store.addEvent = async () => {
      throw new Error('the database went away');
    };
    const sent = await send();
    await t.node.worker.drain();
    store.addEvent = real;
    assert.equal(requests.length, 1, 'the other node took the message');
    assert.equal((await delivery(sent.id)).state, 'pending', 'but "sent" is not recorded without its event');
    assert.deepEqual(await statuses(), []);

    // The lease runs out and the envelope is posted again; the other node answers the repeat with the same receipt.
    t.clock.advance(121_000);
    await t.node.worker.drain();
    assert.equal((await delivery(sent.id)).state, 'sent');
    assert.deepEqual(await statuses(), [`${sent.id}:accepted`], 'reported once');
    assert.equal(requests[1]!.options.body, requests[0]!.options.body, 'the same envelope, byte for byte');
  });

  it('delivers to a recipient on the same node without touching the network', async () => {
    const sent = await send({ to: ['carol@a.test'], intent: 'inform', text: 'hi neighbour' });
    await t.node.worker.drain();

    assert.equal(requests.length, 0);
    assert.equal(t.resolver.lookups, 0, 'local addresses are resolved from config');
    assert.equal((await delivery(sent.id, 'carol@a.test')).state, 'sent');
    const tray = await t.node.tray();
    assert.deepEqual(tray.map((i) => [i.message.from_addr, i.delivery.recipient]), [['alice@a.test', 'carol@a.test']], 'first contact still goes through the tray');

    await t.node.approve(sent.id, 'carol@a.test');
    t.clock.advance(1000);
    await t.node.worker.drain();
    assert.equal(t.adapter.delivered.length, 1);
    assert.equal(t.adapter.delivered[0]!.ctx.target, 'carol@mail.test');
    assert.equal((await delivery(sent.id, 'carol@a.test')).state, 'delivered', 'the delivered receipt came back in-process');
  });
});
