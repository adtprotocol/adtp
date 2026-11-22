/**
 * An address that greets whoever writes to it: open to first contact, with an
 * automatic reply. What it answers, what it does not, and what still limits it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfig } from '../src/config.js';
import type { HttpClient } from '../src/identity/safe-http.js';
import { AUTO_REPLY_DATA_TYPE } from '../src/protocol/constants.js';
import { receiptOf } from '../src/protocol/envelope.js';
import { signObject } from '../src/protocol/signing.js';
import type { Envelope } from '../src/protocol/types.js';
import { createTestNode, dbAvailable, signedEnvelope, TEST_EPOCH, TestKeys, type EnvelopeInput, type TestNode } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

const WELCOME = 'welcome@hub.test';
const GREETING = 'Welcome to ADTP. Your node is set up and can send and receive.';

describe('configuration: first contact and automatic replies', () => {
  const config = (address: Record<string, unknown>) =>
    parseConfig({ domain: 'hub.test', public_url: 'https://hub.test', addresses: [{ local: 'welcome', type: 'agent', routes: [{ default: true, channel: 'inbox' }], ...address }] }, {}, '/tmp').addresses[0]!;

  it('holds first contact and answers nothing unless told otherwise', () => {
    const plain = config({});
    assert.equal(plain.first_contact, 'held');
    assert.equal(plain.auto_reply, undefined);
    assert.equal(config({ auto_reply: '   ' }).auto_reply, undefined, 'blank text is no reply');
  });

  it('takes open first contact and a reply text', () => {
    const open = config({ first_contact: 'Open', auto_reply: `  ${GREETING}\n` });
    assert.equal(open.first_contact, 'open');
    assert.equal(open.auto_reply, GREETING);
    assert.throws(() => config({ first_contact: 'everyone' }), /first_contact must be held or open/);
    assert.throws(() => config({ auto_reply: 'x'.repeat(4001) }), /auto_reply may be at most 4000 characters/);
  });
});

describe('an address that greets whoever writes to it', { skip }, () => {
  let t: TestNode;
  const stranger = new TestKeys();
  /** What this node posted to other nodes, in order. */
  let sent: Envelope[];
  const wire = () => sent.map((e) => receiptOf(e)?.status ?? e.intent);

  const http: HttpClient = async (_url, options) => {
    const envelope = JSON.parse(options?.body ?? '{}') as Envelope;
    sent.push(envelope);
    const receipt = signObject({ adtp: '0', id: envelope.id, from: envelope.from, by: envelope.to[0]!, status: 'accepted', verified: { signature: 'remote' }, at: TEST_EPOCH }, stranger);
    return { status: 202, headers: {}, body: JSON.stringify(receipt) };
  };

  const from = (address: string, input: Partial<EnvelopeInput> = {}): Envelope =>
    signedEnvelope({ from: address, to: [WELCOME], intent: 'request', text: 'Hello. Is this thing on?', ...input }, stranger);
  const state = async (id: string) => (await t.node.store.findDeliveries('in', id, WELCOME))[0]?.state;

  beforeEach(async () => {
    sent = [];
    t = await createTestNode(
      'hub.test',
      {
        addresses: [
          { local: 'welcome', type: 'agent', first_contact: 'open', auto_reply: GREETING, routes: [{ default: true, channel: 'inbox' }] },
          { local: 'guarded', type: 'human', routes: [{ default: true, channel: 'inbox' }] },
        ],
        rate_limits: { unknown_sender: { per_sender_per_hour: 3, per_org_per_hour: 50 } },
      },
      { http },
    );
    for (const name of ['ann', 'bot', 'cat', 'dan']) t.resolver.add(stranger.card(`${name}@new.test`, 'agent', 'https://node.new.test/adtp/v0/messages'));
  });
  afterEach(async () => {
    await t.close();
  });

  it('takes a stranger\'s first message at once and answers it', async () => {
    const hello = from('ann@new.test', { thread: 'thr_hello' });
    const ack = await t.node.receive(hello);
    assert.equal(ack.status, 'accepted', 'not held for approval');
    assert.equal((await t.node.tray()).length, 0);

    await t.node.worker.drain();
    assert.equal(await state(hello.id), 'replied');
    assert.deepEqual(wire(), ['delivered', 'replied', 'inform'], 'the sender hears it was delivered and answered, then gets the answer');

    const reply = sent.at(-1)!;
    assert.deepEqual([reply.from, reply.to, reply.thread, reply.intent], [WELCOME, ['ann@new.test'], 'thr_hello', 'inform']);
    assert.deepEqual(reply.content.parts, [
      { type: 'text', text: GREETING },
      { type: 'data', data: { type: AUTO_REPLY_DATA_TYPE } },
    ]);
  });

  it('still holds strangers on an address that is not open', async () => {
    const ack = await t.node.receive(from('ann@new.test', { to: ['guarded@hub.test'] }));
    assert.equal(ack.status, 'queued');
    assert.equal((await t.node.tray()).length, 1);
  });

  it('keeps the limits on strangers: only inform and request, and only so many an hour', async () => {
    const proposal = await t.node.receive(from('ann@new.test', { intent: 'propose' }));
    assert.equal(proposal.status, 'rejected');
    assert.equal(proposal.reason?.code, 'not_trusted');

    // No answer has gone out yet, so the sender is still a stranger and each message counts.
    for (let i = 0; i < 3; i++) assert.equal((await t.node.receive(from('bot@new.test'))).status, 'accepted');
    const fourth = await t.node.receive(from('bot@new.test'));
    assert.equal(fourth.reason?.code, 'rate_limited');
    assert.equal(fourth.reason?.retryable, true);
  });

  it('does not answer another automatic message', async () => {
    const auto = from('bot@new.test', { parts: [{ type: 'text', text: 'I am out of office.' }, { type: 'data', data: { type: AUTO_REPLY_DATA_TYPE } }] });
    await t.node.receive(auto);
    await t.node.worker.drain();
    assert.equal(await state(auto.id), 'read', 'dealt with, but not answered');
    assert.deepEqual(wire(), ['delivered', 'read']);
  });

  it('answers a thread once: a thank-you gets no second greeting', async () => {
    const hello = from('cat@new.test', { thread: 'thr_once' });
    await t.node.receive(hello);
    await t.node.worker.drain();
    assert.equal(await state(hello.id), 'replied');

    const thanks = from('cat@new.test', { thread: 'thr_once', intent: 'inform', text: 'Thanks!' });
    assert.equal((await t.node.receive(thanks)).status, 'accepted', 'the sender is known now: the node wrote to it');
    await t.node.worker.drain();
    assert.equal(await state(thanks.id), 'read');
    assert.equal(wire().filter((w) => w === 'inform').length, 1, 'one greeting in all');

    // A new thread from the same sender is a new conversation.
    const again = from('cat@new.test', { thread: 'thr_twice' });
    await t.node.receive(again);
    await t.node.worker.drain();
    assert.equal(await state(again.id), 'replied');
    assert.equal(wire().filter((w) => w === 'inform').length, 2);
  });

  it('stops answering a sender who keeps starting new threads', async () => {
    // The first greeting makes dan a known sender, so the first-contact limit no longer slows him down.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const message = from('dan@new.test', { thread: `thr_flood_${i}` });
      ids.push(message.id);
      assert.equal((await t.node.receive(message)).status, 'accepted');
      await t.node.worker.drain();
    }
    const states = await Promise.all(ids.map(state));
    assert.equal(states.filter((s) => s === 'replied').length, 10, 'ten greetings an hour for one sender');
    assert.deepEqual(states.slice(10), ['read', 'read'], 'the rest are read and left unanswered');
    assert.equal(wire().filter((w) => w === 'inform').length, 10);
  });

  it('leaves a message to be answered on the next pass if the answer cannot be stored', async () => {
    const hello = from('ann@new.test');
    await t.node.receive(hello);
    const store = t.node.store as unknown as { saveReply: (...args: unknown[]) => Promise<unknown> };
    const real = store.saveReply.bind(store);
    store.saveReply = async () => {
      throw new Error('database went away');
    };
    await t.node.worker.drain();
    assert.equal(await state(hello.id), 'delivered', 'neither answered nor written off');
    assert.deepEqual(wire(), ['delivered']);

    store.saveReply = real;
    await t.node.worker.drain();
    assert.equal(await state(hello.id), 'replied');
  });
});
