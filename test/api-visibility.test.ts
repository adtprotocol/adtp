/**
 * What each token may read back through GET /api/v0/messages/{id} and
 * GET /api/v0/threads/{thread}. The admin token reads every stored copy. The
 * agent token reads only what an agent address of the node sent or was handed.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/http/app.js';
import { silentLogger } from '../src/log.js';
import { ADTP_CONTENT_TYPE, MESSAGES_PATH } from '../src/protocol/constants.js';
import { createTestNode, freePort, signedEnvelope, TestKeys, type EnvelopeInput, type TestNode } from './helpers.js';

describe('reading stored messages back: admin token and agent token', () => {
  let t: TestNode;
  let server: Server;
  let url: string;
  const alice = new TestKeys();
  const carol = new TestKeys();
  const dave = new TestKeys();

  const deliver = async (input: EnvelopeInput, signer: TestKeys): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${url}${MESSAGES_PATH}`, { method: 'POST', headers: { 'content-type': ADTP_CONTENT_TYPE }, body: JSON.stringify(signedEnvelope(input, signer)) });
    return { status: res.status, json: await res.json() };
  };
  const api = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  const message = (token: string, id: string) => api(token, 'GET', `/api/v0/messages/${id}`);
  const thread = async (token: string, id: string): Promise<any[]> => (await api(token, 'GET', `/api/v0/threads/${id}`)).json.messages;
  const summary = (messages: any[]) => messages.map((m) => `${m.direction} ${m.from} ${m.id}`);

  before(async () => {
    const known = ['alice@a.test', 'carol@c.test'];
    t = await createTestNode('b.test', {
      addresses: [
        { local: 'bob', type: 'human', trusted: known, routes: [{ default: true, channel: 'email', to: 'bob@mail.test' }] },
        { local: 'helper', type: 'agent', trusted: known, routes: [{ default: true, channel: 'email', to: 'helper@mail.test' }] },
      ],
    });
    t.resolver.add(alice.card('alice@a.test'));
    t.resolver.add(carol.card('carol@c.test'));
    t.resolver.add(dave.card('dave@d.test'));
    server = createApp({ node: t.node, adminToken: 'admin', agentToken: 'agent', log: silentLogger });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await t.close();
  });

  it('keeps a thread between people from the agent token', async () => {
    const received = await deliver({ from: 'alice@a.test', to: ['bob@b.test'], id: 'msg_private_1', thread: 'thr_private', text: 'for bob only' }, alice);
    assert.equal(received.status, 202);
    const answer = await api('admin', 'POST', '/api/v0/messages', { from: 'bob@b.test', to: 'alice@a.test', intent: 'inform', text: 'bob answers', thread: 'thr_private' });
    assert.equal(answer.status, 201, JSON.stringify(answer.json));

    const asAdmin = await message('admin', 'msg_private_1');
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.json.copies[0].text, 'for bob only');
    assert.equal((await thread('admin', 'thr_private')).length, 2);

    // To the agent token the message and the thread look like ones that do not exist.
    const asAgent = await message('agent', 'msg_private_1');
    assert.equal(asAgent.status, 404);
    assert.equal(asAgent.json.error, 'not_found');
    assert.ok(!JSON.stringify(asAgent.json).includes('for bob only'));
    assert.equal((await message('agent', answer.json.id)).status, 404, "a person's sent message");
    assert.deepEqual(await thread('agent', 'thr_private'), []);
    assert.deepEqual(asAgent.json, (await message('agent', 'msg_no_such_message')).json, 'the same answer as for an id nobody used');
  });

  it('shows the agent token its own part of a thread it shares with a person', async () => {
    const toBoth = await deliver({ from: 'alice@a.test', to: ['bob@b.test', 'helper@b.test'], id: 'msg_mixed_1', thread: 'thr_mixed', text: 'for both' }, alice);
    assert.equal(toBoth.status, 202);
    assert.equal((await deliver({ from: 'alice@a.test', to: ['bob@b.test'], id: 'msg_mixed_2', thread: 'thr_mixed', text: 'an aside for bob' }, alice)).status, 202);
    const fromBob = await api('admin', 'POST', '/api/v0/messages', { from: 'bob@b.test', to: 'alice@a.test', intent: 'inform', text: 'bob on the shared thread', thread: 'thr_mixed' });
    const fromHelper = await api('agent', 'POST', '/api/v0/messages', { from: 'helper@b.test', to: 'alice@a.test', intent: 'inform', text: 'helper on the shared thread', thread: 'thr_mixed' });
    assert.equal(fromBob.status, 201);
    assert.equal(fromHelper.status, 201);

    assert.equal((await thread('admin', 'thr_mixed')).length, 4);
    const seen = await thread('agent', 'thr_mixed');
    assert.deepEqual(summary(seen).sort(), [`in alice@a.test msg_mixed_1`, `out helper@b.test ${fromHelper.json.id}`].sort());
    assert.ok(!JSON.stringify(seen).includes('an aside for bob'));
    assert.ok(!JSON.stringify(seen).includes('bob on the shared thread'));

    // The copy it shares with bob: the whole signed envelope, but only the agent's own delivery.
    const admin = (await message('admin', 'msg_mixed_1')).json.copies[0];
    const agent = (await message('agent', 'msg_mixed_1')).json.copies[0];
    assert.deepEqual(admin.deliveries.map((d: any) => d.recipient), ['bob@b.test', 'helper@b.test']);
    assert.deepEqual(agent.deliveries.map((d: any) => d.recipient), ['helper@b.test']);
    assert.deepEqual(agent.envelope, admin.envelope);
    assert.ok(agent.envelope.signature.value);
    // Its own sent message: every recipient's delivery, as before.
    const own = await message('agent', fromHelper.json.id);
    assert.equal(own.status, 200);
    assert.deepEqual(own.json.copies[0].deliveries.map((d: any) => d.recipient), ['alice@a.test']);
  });

  it('tells two senders with the same id apart', async () => {
    assert.equal((await deliver({ from: 'alice@a.test', to: ['bob@b.test'], id: 'msg_shared_id', text: 'alice to bob' }, alice)).status, 202);
    assert.equal((await deliver({ from: 'carol@c.test', to: ['helper@b.test'], id: 'msg_shared_id', text: 'carol to helper' }, carol)).status, 202);

    const asAdmin = (await message('admin', 'msg_shared_id')).json.copies;
    assert.deepEqual(asAdmin.map((c: any) => c.from), ['alice@a.test', 'carol@c.test']);
    const asAgent = await message('agent', 'msg_shared_id');
    assert.equal(asAgent.status, 200);
    assert.deepEqual(asAgent.json.copies.map((c: any) => [c.from, c.text]), [['carol@c.test', 'carol to helper']]);
    assert.ok(!JSON.stringify(asAgent.json).includes('alice to bob'));
  });

  it('does not show the agent token a message still waiting in the requests tray', async () => {
    const held = await deliver({ from: 'dave@d.test', to: ['helper@b.test'], id: 'msg_held_1', thread: 'thr_held', intent: 'request', text: 'from a stranger' }, dave);
    assert.equal(held.status, 202);
    assert.equal(held.json.status, 'queued');

    assert.equal((await message('agent', 'msg_held_1')).status, 404);
    assert.deepEqual(await thread('agent', 'thr_held'), []);
    assert.equal((await message('admin', 'msg_held_1')).status, 200);

    assert.equal((await api('admin', 'POST', '/api/v0/tray/approve', { id: 'msg_held_1', recipient: 'helper@b.test' })).status, 200);
    const released = await message('agent', 'msg_held_1');
    assert.equal(released.status, 200);
    assert.equal(released.json.copies[0].text, 'from a stranger');
    assert.equal((await thread('agent', 'thr_held')).length, 1);
  });
});
