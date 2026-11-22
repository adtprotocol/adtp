/**
 * End to end: two complete nodes (HTTP server, queue worker, real discovery
 * over HTTP, real SMTP into an in-memory sink), each on its own database
 * schema, exchanging a message the way the demo does.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AdtpClient, AdtpClientError } from '../src/client.js';
import { parseConfig } from '../src/config.js';
import { AdtpNode } from '../src/core/node.js';
import { createApp } from '../src/http/app.js';
import { Keyring } from '../src/identity/keyring.js';
import { silentLogger } from '../src/log.js';
import { ADTP_CONTENT_TYPE, INTENTS, MESSAGES_PATH } from '../src/protocol/constants.js';
import { parseCard } from '../src/protocol/cards.js';
import { mintDelegation } from '../src/protocol/delegation.js';
import { verifySignature } from '../src/protocol/signing.js';
import type { Ack, Envelope } from '../src/protocol/types.js';
import {
  createTestDb,
  createTestNode,
  dbAvailable,
  eventually,
  freePort,
  signedEnvelope,
  startSmtpSink,
  TestKeys,
  type EnvelopeInput,
  type SmtpSink,
  type TestDb,
  type TestNode,
} from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

interface Running {
  name: string;
  url: string;
  node: AdtpNode;
  keyring: Keyring;
  server: Server;
  db: TestDb;
  /** Talks to the node with its admin token. */
  client: AdtpClient;
  /** Talks to the node with its agent token. */
  agent: AdtpClient;
  adminToken: string;
  agentToken: string;
}

/** POSTs a body to a node's messages endpoint the way another node would. */
async function post(url: string, body: string | object, headers: Record<string, string> = { 'content-type': ADTP_CONTENT_TYPE }) {
  const res = await fetch(`${url}${MESSAGES_PATH}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json };
}

describe('two nodes, end to end', { skip }, () => {
  let smtp: SmtpSink;
  let alice: Running;
  let bob: Running;
  let dir: string;

  async function startNode(name: string, port: number, peer: { name: string; port: number }): Promise<Running> {
    const db = await createTestDb();
    const config = parseConfig(
      {
        domain: `${name}.test`,
        public_url: `http://127.0.0.1:${port}`,
        listen: { host: '127.0.0.1', port },
        keys: { path: path.join(dir, name, 'keyring.json') },
        addresses: [
          { local: name, type: 'human', routes: [{ default: true, channel: 'email', to: `${name}@mail.test` }] },
          { local: 'assistant', type: 'agent', name: `${name}'s assistant`, routes: [{ default: true, channel: 'email', to: `${name}-assistant@mail.test` }] },
        ],
        channels: {
          email: {
            from: `ADTP <adtp@${name}.test>`,
            smtp: { host: '127.0.0.1', port: smtp.port },
            inbound: { token: 'hook-secret' },
            reply_to: `reply+{token}@${name}.test`,
          },
        },
        delivery: { poll_interval_ms: 50, backoff_base_seconds: 0.2, max_attempts: 5 },
        discovery: { allow_insecure: true, overrides: { [`${peer.name}.test`]: `http://127.0.0.1:${peer.port}/.well-known/adtp/{local}` } },
      },
      {},
      dir,
    );
    const { keyring } = Keyring.load({ path: config.keys.path, graceDays: 30 });
    const node = await AdtpNode.create({ config, db: db.conn, keys: keyring });
    const adminToken = `admin-${name}`;
    const agentToken = `agent-${name}`;
    const server = createApp({ node, adminToken, agentToken, log: silentLogger });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    node.worker.start();
    const url = `http://127.0.0.1:${port}`;
    const client = new AdtpClient({ baseUrl: url, token: adminToken });
    return { name, url, node, keyring, server, db, adminToken, agentToken, client, agent: new AdtpClient({ baseUrl: url, token: agentToken }) };
  }

  async function stopNode(r: Running): Promise<void> {
    r.server.closeAllConnections();
    await new Promise((resolve) => r.server.close(resolve));
    await r.node.close();
    await r.db.drop();
  }

  const outboundState = async (r: Running, id: string): Promise<string | undefined> =>
    (await r.client.status(id)).copies.find((c) => c.direction === 'out')?.deliveries[0]?.state;

  const mailTo = (address: string) => smtp.messages.filter((m) => m.to.includes(address));

  /** A signed envelope from one of Alice's addresses, created now (these nodes run on the real clock). */
  const fromAlice = (input: Partial<EnvelopeInput> = {}): Envelope =>
    signedEnvelope({ from: 'assistant@alice.test', to: ['assistant@bob.test'], intent: 'inform', text: 'direct post', created_at: new Date().toISOString(), ...input }, alice.keyring);

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'adtp-e2e-'));
    smtp = await startSmtpSink();
    const [alicePort, bobPort] = [await freePort(), await freePort()];
    alice = await startNode('alice', alicePort, { name: 'bob', port: bobPort });
    bob = await startNode('bob', bobPort, { name: 'alice', port: alicePort });
  });

  after(async () => {
    // Each step is independent so a failed setup still releases everything it did start.
    for (const running of [alice, bob]) {
      if (running) await stopNode(running).catch(() => {});
    }
    await smtp?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('send -> requests tray -> approve -> email -> delivered / read / replied -> reply delivered back', async () => {
    // 1. Alice's node signs and sends; Bob's node has never heard of Alice, so it queues the message.
    const sent = await alice.client.send({
      from: 'alice@alice.test',
      to: 'bob@bob.test',
      intent: 'request',
      text: 'Can you review the launch plan by Friday?',
      data: { doc: 'launch-plan-v3', pages: 12 },
    });
    await eventually(async () => (await outboundState(alice, sent.id)) === 'sent', 8000, 'alice to reach bob');
    const aliceCopy = (await alice.client.status(sent.id)).copies[0]!;
    assert.equal(aliceCopy.direction, 'out');

    // 2. It sits in Bob's requests tray; no email has gone out.
    const tray = await bob.client.request<{ items: any[] }>('GET', '/api/v0/tray');
    assert.equal(tray.items.length, 1);
    assert.equal(tray.items[0].id, sent.id);
    assert.equal(tray.items[0].from, 'alice@alice.test');
    assert.equal(tray.items[0].sender_type, 'human');
    assert.equal(tray.items[0].text, 'Can you review the launch plan by Friday?');
    assert.equal(mailTo('bob@mail.test').length, 0);

    // 3. Bob approves: the email goes out and Alice learns it was delivered.
    await bob.client.request('POST', '/api/v0/tray/approve', { id: sent.id, recipient: 'bob@bob.test' });
    const [mail] = await eventually(async () => (mailTo('bob@mail.test').length > 0 ? mailTo('bob@mail.test') : null), 8000, 'the email to bob');
    assert.ok(mail);
    assert.equal(mail.from, 'adtp@bob.test');
    assert.match(mail.raw, /^Subject: \[ADTP request\] Can you review the launch plan by Friday\?/m);
    assert.match(mail.raw, new RegExp(`^X-ADTP-Message-Id: ${sent.id}`, 'mi'), 'header names are case-insensitive');
    assert.match(mail.raw, /Can you review the launch plan by Friday\?/);
    assert.match(mail.raw, /doc: launch-plan-v3/);
    const token = /^Message-ID: <adtp\.([a-f0-9]{32})@bob\.test>/m.exec(mail.raw)?.[1];
    assert.ok(token, 'the outgoing email carries the delivery token in its Message-ID');
    assert.match(mail.raw, new RegExp(`^Reply-To: reply\\+${token}@bob\\.test`, 'm'));

    await eventually(async () => (await outboundState(alice, sent.id)) === 'delivered', 8000, 'the delivered status');

    // 4. Bob opens the email (his mail client loads the beacon image).
    const beacon = await fetch(`${bob.url}/r/${token}.gif`);
    assert.equal(beacon.status, 200);
    assert.equal(beacon.headers.get('content-type'), 'image/gif');
    await eventually(async () => (await outboundState(alice, sent.id)) === 'read', 8000, 'the read status');

    // 5. Bob replies by email; his mail provider posts the reply to the node's webhook.
    const hook = await fetch(`${bob.url}/hooks/email`, {
      method: 'POST',
      headers: { authorization: 'Bearer hook-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'Bob <bob@mail.test>',
        to: `reply+${token}@bob.test`,
        subject: 'Re: [ADTP request] Can you review the launch plan by Friday?',
        text: 'Yes, I will have comments by Thursday.\n\nOn Mon, 1 Jun 2026, alice@alice.test via ADTP <adtp@bob.test> wrote:\n> Can you review the launch plan by Friday?',
        headers: { 'In-Reply-To': `<adtp.${token}@bob.test>`, 'Message-ID': '<reply-1@mail.test>' },
      }),
    });
    assert.equal(hook.status, 202);
    const hooked = (await hook.json()) as { accepted: boolean; id: string; thread: string };
    assert.equal(hooked.accepted, true);
    assert.equal(hooked.thread, sent.thread);

    await eventually(async () => (await outboundState(alice, sent.id)) === 'replied', 8000, 'the replied status');
    const final = (await alice.client.status(sent.id)).copies[0]!.deliveries[0]!;
    assert.ok(final.delivered_at && final.read_at && final.replied_at, 'every stage is timestamped');

    // 6. The reply itself reaches Alice by email, without a tray stop: she wrote to Bob first.
    const [replyMail] = await eventually(async () => (mailTo('alice@mail.test').length > 0 ? mailTo('alice@mail.test') : null), 8000, "bob's reply to reach alice's inbox");
    assert.ok(replyMail);
    assert.match(replyMail.raw, /Yes, I will have comments by Thursday\./);
    assert.ok(!replyMail.raw.includes('> Can you review'), 'the quoted original is stripped from the reply');

    // 7. Both nodes can replay the conversation.
    const aliceThread = await alice.client.request<{ messages: any[] }>('GET', `/api/v0/threads/${sent.thread}`);
    const conversation = aliceThread.messages.filter((m) => !m.receipt_for).map((m) => [m.direction, m.from, m.intent, m.text]);
    assert.deepEqual(conversation, [
      ['out', 'alice@alice.test', 'request', 'Can you review the launch plan by Friday?'],
      ['in', 'bob@bob.test', 'inform', 'Yes, I will have comments by Thursday.'],
    ]);
    assert.deepEqual(aliceThread.messages.filter((m) => m.receipt_for === sent.id).map((m) => m.intent), ['status', 'status', 'status']);

    const bobThread = await bob.client.request<{ messages: any[] }>('GET', `/api/v0/threads/${sent.thread}`);
    assert.equal(bobThread.messages.find((m) => m.id === sent.id).deliveries[0].state, 'replied');
    await eventually(async () => (await outboundState(bob, hooked.id)) === 'delivered', 8000, "bob to learn his reply was delivered");

    // The same webhook delivered again does not send a second reply.
    const again = await fetch(`${bob.url}/hooks/email`, {
      method: 'POST',
      headers: { authorization: 'Bearer hook-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'bob@mail.test', text: 'Yes, I will have comments by Thursday.', headers: { 'In-Reply-To': `<adtp.${token}@bob.test>`, 'Message-ID': '<reply-1@mail.test>' } }),
    });
    assert.equal(((await again.json()) as { duplicate: boolean }).duplicate, true);
  });

  it('serves a health check', async () => {
    const res = await fetch(`${alice.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', domain: 'alice.test', adtp: '0', version: '0' });
  });

  it('answers a request target that is not a URL with 400, and keeps serving', async () => {
    // fetch() would never send this; a raw socket can. It used to end the process.
    const raw = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(Number(new URL(alice.url).port), '127.0.0.1');
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (response += chunk));
        socket.on('end', () => resolve(response));
        socket.on('error', reject);
        socket.write(`GET ${target} HTTP/1.1\r\nHost: alice.test\r\nConnection: close\r\n\r\n`);
      });

    for (const target of ['//[', '//:', 'http://[::1']) {
      const response = await raw(target);
      assert.match(response, /^HTTP\/1\.1 400 /, `${target} is answered, not dropped`);
      assert.match(response, /"error":"bad_request"/);
    }
    assert.equal((await fetch(`${alice.url}/healthz`)).status, 200, 'the node is still up');
  });

  it('serves a card for each address: where to send, how to verify, what is accepted', async () => {
    const human = await fetch(`${bob.url}/.well-known/adtp/bob`);
    assert.equal(human.status, 200);
    const humanCard = (await human.json()) as Record<string, unknown>;
    assert.deepEqual(humanCard, {
      adtp: '0',
      address: 'bob@bob.test',
      endpoint: `${bob.url}/adtp/v0/messages`,
      keys: bob.keyring.publicKeys(),
      accepts: [...INTENTS],
      max_bytes: 262144,
      type: 'human',
    });
    assert.ok(!JSON.stringify(humanCard).includes('mail.test'), 'delivery preferences are not published');

    const agentCard = (await (await fetch(`${bob.url}/.well-known/adtp/assistant`)).json()) as Record<string, unknown>;
    assert.equal(agentCard.type, 'agent');
    assert.equal(parseCard(agentCard).endpoint, `${bob.url}/adtp/v0/messages`);
    assert.ok(!JSON.stringify(agentCard).includes('mail.test'));

    assert.equal((await fetch(`${bob.url}/.well-known/adtp/nobody`)).status, 404);
  });

  it('answers a posted envelope with a signed receipt, and a repeat with the same receipt', async () => {
    const envelope = fromAlice();
    const first = await post(bob.url, envelope);
    assert.equal(first.status, 202);
    assert.equal(first.headers.get('content-type'), ADTP_CONTENT_TYPE);
    const receipt = first.json as Ack;
    assert.equal(receipt.status, 'queued', 'first contact is stored and held for approval');
    assert.equal(receipt.id, envelope.id);
    assert.equal(receipt.from, 'assistant@alice.test');
    assert.equal(receipt.by, 'assistant@bob.test');
    assert.deepEqual(receipt.verified, { signature: alice.keyring.kid });
    assert.ok(verifySignature(receipt, bob.keyring.publicKeys(), new Date()).ok, "signed with the key in the recipient's card");

    // A replayed envelope (same sender, same id, same content) gets the original receipt and is not stored again.
    const replay = await post(bob.url, envelope);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, receipt);
    const stored = await bob.client.status(envelope.id);
    assert.equal(stored.copies.length, 1);

    // The same id for a different message is a conflict.
    const conflict = await post(bob.url, fromAlice({ id: envelope.id, text: 'something else under the same id' }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(Object.keys(conflict.json), ['error', 'message', 'retryable']);
    assert.equal(conflict.json.error, 'id_conflict');
    assert.equal(conflict.json.retryable, false);
  });

  it('refuses a tampered envelope and a stale one', async () => {
    const envelope = fromAlice();
    const tampered = await post(bob.url, { ...envelope, content: { parts: [{ type: 'text', text: 'tampered' }] } });
    assert.equal(tampered.status, 401);
    assert.equal(tampered.json.error, 'bad_signature');

    // Signed correctly, but created eight days ago: outside the replay window, whatever its expires_at says.
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const stale = await post(bob.url, fromAlice({ created_at: eightDaysAgo, expires_at: new Date(Date.now() + 86_400_000).toISOString() }));
    assert.equal(stale.status, 410);
    assert.equal(stale.json.error, 'expired');
    assert.equal(stale.json.retryable, false);
    assert.equal((await bob.client.request<{ items: { id: string }[] }>('GET', '/api/v0/tray')).items.some((i) => i.id === envelope.id), false, 'neither was stored');
  });

  it('protects the API, the admin pages and the webhooks', async () => {
    const anonymous = new AdtpClient({ baseUrl: bob.url, token: 'wrong' });
    await assert.rejects(anonymous.status('anything'), (err: AdtpClientError) => err.status === 401);
    await assert.rejects(anonymous.send({ from: 'bob@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'x' }), (err: AdtpClientError) => err.status === 401);
    assert.equal((await fetch(`${bob.url}/api/v0/tray`)).status, 401);

    assert.equal((await fetch(`${bob.url}/hooks/email`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${bob.url}/hooks/email`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${bob.url}/hooks/slack`, { method: 'POST', headers: { authorization: 'Bearer hook-secret' }, body: '{}' })).status, 401);

    const page = await fetch(`${bob.url}/admin/tray`, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/admin/login');
    assert.equal((await fetch(`${bob.url}/nope`)).status, 404);
    assert.equal((await fetch(`${bob.url}${MESSAGES_PATH}`)).status, 405);
  });

  it('gives the agent token what an agent needs and nothing else', async () => {
    const forbidden = (err: AdtpClientError) => err.status === 403 && err.code === 'forbidden';

    // What an agent does: send as itself, follow its feed, mark read, look things up.
    const sent = await bob.agent.send({ from: 'assistant@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'sent with the agent token' });
    assert.equal(sent.created, true);
    assert.equal((await bob.agent.status(sent.id)).id, sent.id);
    assert.ok(Array.isArray((await bob.agent.request<{ messages: unknown[] }>('GET', `/api/v0/threads/${sent.thread}`)).messages));
    assert.ok(Array.isArray((await bob.agent.request<{ events: unknown[] }>('GET', '/api/v0/events?address=assistant@bob.test')).events));
    assert.equal((await bob.agent.request<{ address: string }>('GET', '/api/v0/resolve?address=assistant@alice.test')).address, 'assistant@alice.test');
    assert.deepEqual(await bob.agent.request('POST', '/api/v0/messages/msg_none/read', { recipient: 'assistant@bob.test' }), { read: true, changed: false });

    // Not an administrator: no tray, no delegations, no admin pages.
    await assert.rejects(bob.agent.request('GET', '/api/v0/tray'), forbidden);
    await assert.rejects(bob.agent.request('POST', '/api/v0/tray/approve', { id: 'x', recipient: 'bob@bob.test' }), forbidden);
    await assert.rejects(bob.agent.request('POST', '/api/v0/tray/reject', { id: 'x', recipient: 'bob@bob.test' }), forbidden);
    await assert.rejects(bob.agent.request('POST', '/api/v0/delegations', { principal: 'bob@bob.test', agent: 'assistant@bob.test' }), forbidden);
    await assert.rejects(bob.agent.request('POST', '/api/v0/delegations/dlg_x/revoke', {}), forbidden);
    const login = await fetch(`${bob.url}/admin/login`, { method: 'POST', body: new URLSearchParams({ token: bob.agentToken }), redirect: 'manual' });
    assert.equal(login.status, 401, 'the agent token does not open the admin pages');
    assert.equal(login.headers.get('set-cookie'), null);
    const page = await fetch(`${bob.url}/admin/tray`, { headers: { authorization: `Bearer ${bob.agentToken}` }, redirect: 'manual' });
    assert.equal(page.headers.get('location'), '/admin/login');

    // Not a key to people's mailboxes either: it acts only for agent addresses.
    await assert.rejects(bob.agent.send({ from: 'bob@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'as a person' }), forbidden);
    await assert.rejects(bob.agent.request('GET', '/api/v0/events?address=bob@bob.test'), forbidden);
    await assert.rejects(bob.agent.request('POST', '/api/v0/messages/msg_none/read', { recipient: 'bob@bob.test' }), forbidden);
    // And it cannot have the node sign a delegation from someone the agent is not configured to act for.
    await assert.rejects(
      bob.agent.send({ from: 'assistant@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'for bob?', on_behalf_of: 'bob@bob.test' }),
      forbidden,
    );

    // The admin token can do all of the above.
    assert.equal((await bob.client.send({ from: 'bob@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'as admin' })).created, true);
    assert.ok(Array.isArray((await bob.client.request<{ items: unknown[] }>('GET', '/api/v0/tray')).items));
  });

  it('issues delegations and takes them back', async () => {
    // Bob lets Alice's assistant send informs on his behalf.
    const grant = await bob.client.request<{ token: string; jti: string; scope: string[]; aud: string; expires_at: string }>('POST', '/api/v0/delegations', {
      principal: 'bob@bob.test',
      agent: 'assistant@alice.test',
      scope: ['inform'],
    });
    assert.deepEqual(grant.scope, ['inform']);
    assert.equal(grant.aud, 'adtp');
    assert.ok(Math.abs(Date.parse(grant.expires_at) - Date.now() - 24 * 3600 * 1000) < 60_000, 'good for a day by default');
    const forBob = () => fromAlice({ on_behalf_of: 'bob@bob.test', delegation: grant.token });

    const accepted = await post(bob.url, forBob());
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.verified.delegation, 'bob@bob.test');
    const outOfScope = await post(bob.url, fromAlice({ intent: 'request', on_behalf_of: 'bob@bob.test', delegation: grant.token }));
    assert.equal(outOfScope.status, 403);
    assert.equal(outOfScope.json.error, 'delegation_invalid');

    assert.deepEqual(await bob.client.request('POST', `/api/v0/delegations/${grant.jti}/revoke`, {}), { jti: grant.jti, revoked: true, already_revoked: false });
    assert.deepEqual(await bob.client.request('POST', `/api/v0/delegations/${grant.jti}/revoke`, {}), { jti: grant.jti, revoked: true, already_revoked: true });
    const afterRevocation = await post(bob.url, forBob());
    assert.equal(afterRevocation.status, 403);
    assert.equal(afterRevocation.json.error, 'delegation_invalid');
    assert.match(afterRevocation.json.message, /revoked/);

    await assert.rejects(
      bob.client.request('POST', '/api/v0/delegations', { principal: 'bob@bob.test', agent: 'assistant@alice.test', scope: ['inform'], ttl_seconds: 30 * 86400 }),
      (err: AdtpClientError) => err.status === 400 && err.code === 'invalid_ttl',
    );
  });

  it('reports client mistakes on the API clearly', async () => {
    await assert.rejects(bob.client.status('no-such-message'), (err: AdtpClientError) => err.status === 404 && err.code === 'not_found');
    await assert.rejects(
      bob.client.send({ from: 'mallory@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'x' }),
      (err: AdtpClientError) => err.status === 400 && err.code === 'unknown_sender',
    );
    await assert.rejects(bob.client.request('POST', '/api/v0/messages', { from: 'bob@bob.test', to: 42, intent: 'inform', text: 'x' }), /to must be/);
    await assert.rejects(bob.client.request('POST', '/api/v0/messages', { from: 'bob@bob.test', to: 'alice@alice.test', intent: 'inform', text: 'x', priority: 'high' }), /priority must be one of low, normal, urgent/);
    await assert.rejects(bob.client.request('POST', '/api/v0/tray/approve', { id: 'nope', recipient: 'bob@bob.test' }), (err: AdtpClientError) => err.status === 404);
  });

  it('lets an admin sign in to the web tray and approve a request there', async () => {
    const sent = await alice.client.send({ from: 'assistant@alice.test', to: 'assistant@bob.test', intent: 'request', text: 'Agent <b>says</b> hello & asks for access' });
    await eventually(async () => (await outboundState(alice, sent.id)) === 'sent', 8000, 'the request to reach bob');

    const denied = await fetch(`${bob.url}/admin/login`, { method: 'POST', body: new URLSearchParams({ token: 'guess' }), redirect: 'manual' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('set-cookie'), null);

    const login = await fetch(`${bob.url}/admin/login`, { method: 'POST', body: new URLSearchParams({ token: bob.adminToken }), redirect: 'manual' });
    assert.equal(login.status, 303);
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    assert.ok(!setCookie.includes(bob.adminToken), 'the cookie is not the token itself');
    const cookie = setCookie.split(';')[0]!;

    const trayPage = await fetch(`${bob.url}/admin/tray`, { headers: { cookie } });
    assert.equal(trayPage.status, 200);
    assert.match(trayPage.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(trayPage.headers.get('referrer-policy'), 'same-origin', 'private from other sites, without hiding the origin of the page\'s own forms');
    const html = await trayPage.text();
    assert.match(html, /assistant@alice\.test/);
    assert.match(html, /Agent &lt;b&gt;says&lt;\/b&gt; hello &amp; asks for access/, 'message text is escaped');
    assert.ok(!html.includes('<b>says</b>'));

    const crossSite = await fetch(`${bob.url}/admin/tray/approve`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.test' },
      body: new URLSearchParams({ id: sent.id, recipient: 'assistant@bob.test' }),
      redirect: 'manual',
    });
    assert.equal(crossSite.status, 403);

    // What browsers send, and what the node makes of it. The form's own fields are missing on
    // purpose in the refused cases: a refusal must come before anything is looked at.
    const post = (headers: Record<string, string>, fields: Record<string, string> = {}) =>
      fetch(`${bob.url}/admin/tray/approve`, { method: 'POST', headers: { cookie, ...headers }, body: new URLSearchParams(fields), redirect: 'manual' });
    const elsewhere = { id: 'msg_not_there', recipient: 'assistant@bob.test' };
    assert.equal((await post({ 'sec-fetch-site': 'cross-site', origin: bob.url })).status, 403, 'another site, whatever Origin claims');
    assert.equal((await post({ 'sec-fetch-site': 'same-site', origin: bob.url })).status, 403, 'a sibling subdomain is not this node');
    assert.equal((await post({ 'sec-fetch-site': 'none' })).status, 403);
    assert.equal((await post({ origin: 'null' })).status, 403, 'an origin the browser would not name, from a browser without Sec-Fetch-Site');
    // A page of this node posting its own form. Behind a proxy the browser may name the public
    // host while Host is internal, or (with an older referrer policy) say "Origin: null".
    assert.equal((await post({ 'sec-fetch-site': 'same-origin', origin: 'null' }, elsewhere)).status, 303);
    assert.equal((await post({ 'sec-fetch-site': 'same-origin', origin: 'https://public.example' }, elsewhere)).status, 303);
    assert.equal((await post({}, elsewhere)).status, 303, 'not a browser: the session cookie is what counts');

    const approve = await fetch(`${bob.url}/admin/tray/approve`, {
      method: 'POST',
      headers: { cookie, origin: bob.url },
      body: new URLSearchParams({ id: sent.id, recipient: 'assistant@bob.test' }),
      redirect: 'manual',
    });
    assert.equal(approve.status, 303);
    assert.equal(approve.headers.get('location'), '/admin/tray?done=approved');

    await eventually(async () => (await outboundState(alice, sent.id)) === 'delivered', 8000, 'delivery after approval in the web tray');
    assert.equal(mailTo('bob-assistant@mail.test').filter((m) => m.raw.includes(sent.id)).length, 1);

    const inbox = await (await fetch(`${bob.url}/admin/inbox`, { headers: { cookie } })).text();
    assert.match(inbox, /delivered/);
    const thread = await (await fetch(`${bob.url}/admin/threads/${sent.thread}`, { headers: { cookie } })).text();
    assert.match(thread, /assistant@alice\.test/);
  });

  it('keeps retrying while the other node is down and delivers when it returns', async () => {
    // Take Bob's HTTP server away, send, then bring it back on the same port.
    const port = Number(new URL(bob.url).port);
    bob.server.closeAllConnections();
    await new Promise((resolve) => bob.server.close(resolve));

    const sent = await alice.client.send({ from: 'alice@alice.test', to: 'bob@bob.test', intent: 'inform', text: 'are you there?' });
    const stuck = await eventually(async () => {
      const d = (await alice.client.status(sent.id)).copies[0]!.deliveries[0]!;
      return d.attempts >= 2 ? d : null;
    }, 8000, 'at least two failed attempts');
    assert.equal(stuck.state, 'pending');
    assert.match(stuck.last_error ?? '', /ECONNREFUSED|could not resolve/);

    bob.server = createApp({ node: bob.node, adminToken: bob.adminToken, agentToken: bob.agentToken, log: silentLogger });
    await new Promise<void>((resolve) => bob.server.listen(port, '127.0.0.1', resolve));

    // Alice is a known contact of Bob by now (he approved her), so this one is delivered directly.
    await eventually(async () => (await outboundState(alice, sent.id)) === 'delivered', 15000, 'delivery after the node came back');
  });
});

describe('the messages endpoint, status by status', { skip }, () => {
  let t: TestNode;
  let server: Server;
  let url: string;
  const alice = new TestKeys();
  const fromAlice = (input: Partial<EnvelopeInput> = {}): Envelope =>
    signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], intent: 'inform', text: 'hello bob', ...input }, alice);
  const expectError = async (res: Awaited<ReturnType<typeof post>>, status: number, error: string, retryable = false) => {
    assert.equal(res.status, status, `${error}: HTTP status`);
    assert.equal(res.headers.get('content-type'), ADTP_CONTENT_TYPE);
    assert.deepEqual(Object.keys(res.json).slice(0, 3), ['error', 'message', 'retryable']);
    assert.equal(res.json.error, error);
    assert.equal(res.json.retryable, retryable, `${error}: retryable`);
    assert.ok(res.json.message.length > 0);
  };

  before(async () => {
    // One first-contact message an hour, so the rate limit is easy to reach. The clock is the test clock.
    t = await createTestNode('b.test', { rate_limits: { unknown_sender: { per_sender_per_hour: 1, per_org_per_hour: 100 } } });
    t.resolver.add(alice.card('alice@a.test'));
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

  it('202 for a stored message, 200 for its repeat, 409 for a different message under the same id', async () => {
    const envelope = fromAlice({ id: 'msg_status_1' });
    const first = await post(url, envelope);
    assert.equal(first.status, 202);
    assert.equal(first.json.status, 'queued');
    const again = await post(url, envelope);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, first.json);
    await expectError(await post(url, fromAlice({ id: 'msg_status_1', text: 'not the same' })), 409, 'id_conflict');
  });

  it('429 with Retry-After once the first-contact allowance is spent', async () => {
    const limited = await post(url, fromAlice());
    await expectError(limited, 429, 'rate_limited', true);
    const wait = Number(limited.headers.get('retry-after'));
    assert.ok(Number.isInteger(wait) && wait > 0 && wait <= 3600, `Retry-After is the seconds until the allowance resets (${wait})`);
  });

  it('400 for anything that is not a well-formed envelope', async () => {
    await expectError(await post(url, '{not json'), 400, 'invalid_envelope');
    await expectError(await post(url, { ...fromAlice(), intent: 'shout' }), 400, 'invalid_envelope');
    await expectError(await post(url, { ...fromAlice(), priority: 'high' }), 400, 'invalid_envelope');
    const noTimestamp: Record<string, unknown> = { ...fromAlice() };
    delete noTimestamp.created_at;
    await expectError(await post(url, noTimestamp), 400, 'invalid_envelope');
    await expectError(await post(url, fromAlice({ created_at: new Date(t.clock.now().getTime() + 3_600_000).toISOString() })), 400, 'invalid_envelope');
  });

  it('401 for a signature that does not verify, or names a key the sender does not publish', async () => {
    const envelope = fromAlice();
    await expectError(await post(url, { ...envelope, intent: 'request' }), 401, 'bad_signature');
    await expectError(await post(url, signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, new TestKeys())), 401, 'bad_signature');
  });

  it('403 for a bad delegation, and for a first message with an intent strangers may not use', async () => {
    const carol = new TestKeys();
    t.resolver.add(carol.card('carol@c.test'));
    const { token } = mintDelegation({ principal: 'carol@c.test', agent: 'alice@a.test', scope: ['inform'], ttlSeconds: 600, now: t.clock.now() }, carol);
    await expectError(await post(url, fromAlice({ intent: 'request', on_behalf_of: 'carol@c.test', delegation: token })), 403, 'delegation_invalid');
    await expectError(await post(url, fromAlice({ on_behalf_of: 'carol@c.test' })), 403, 'delegation_invalid');
    await expectError(await post(url, fromAlice({ intent: 'commit' })), 403, 'not_trusted');
  });

  it('404 for a recipient that is not here', async () => {
    await expectError(await post(url, fromAlice({ to: ['nobody@b.test'] })), 404, 'unknown_recipient');
    await expectError(await post(url, fromAlice({ to: ['bob@elsewhere.test'] })), 404, 'unknown_recipient');
  });

  it('410 for a message that has expired or is older than the replay window', async () => {
    await expectError(await post(url, fromAlice({ expires_at: new Date(t.clock.now().getTime() - 1000).toISOString() })), 410, 'expired');
    await expectError(await post(url, fromAlice({ created_at: new Date(t.clock.now().getTime() - 8 * 86_400_000).toISOString() })), 410, 'expired');
  });

  it('413 for an envelope over the size limit, 415 for the wrong media type', async () => {
    const big = fromAlice({ text: 'x'.repeat(263_000) });
    await expectError(await post(url, big), 413, 'too_large');
    await expectError(await post(url, fromAlice(), { 'content-type': 'application/json' }), 415, 'unsupported_media_type');
    assert.equal((await post(url, fromAlice({ id: 'msg_with_charset' }), { 'content-type': `${ADTP_CONTENT_TYPE}; charset=utf-8` })).status, 429, 'a charset parameter is fine (and the allowance is still spent)');
  });

  it('503, retryable, when the sender cannot be looked up right now', async () => {
    const ghost = new TestKeys();
    await expectError(await post(url, signedEnvelope({ from: 'ghost@nowhere.test', to: ['bob@b.test'] }, ghost)), 503, 'sender_unresolvable', true);
  });

  it('503 with Retry-After, not 401, for a key it has not seen while it may not fetch the card again yet', async () => {
    // Alice has just rotated. This node's copy of her card is from before, and too recent to fetch again.
    const rotated = new TestKeys();
    const real = t.resolver.resolve.bind(t.resolver);
    t.resolver.resolve = async (address: string, opts?: { fresh?: boolean }) =>
      address === 'alice@a.test' && opts?.fresh ? { ...alice.card('alice@a.test'), resolved: { method: 'dns' as const, retry_after: 37 } } : real(address);
    try {
      const res = await post(url, signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, rotated));
      await expectError(res, 503, 'sender_unresolvable', true);
      assert.equal(res.headers.get('retry-after'), '37');
    } finally {
      t.resolver.resolve = real;
    }
  });

  it('answers with the per-recipient verdicts when every recipient is turned away', async () => {
    const res = await post(url, fromAlice({ to: ['bob@b.test', 'ghost@b.test'] }));
    await expectError(res, 429, 'rate_limited', true);
    assert.equal(res.json.recipients['ghost@b.test'].reason.code, 'unknown_recipient');
    assert.equal(res.json.recipients['bob@b.test'].reason.code, 'rate_limited');
  });
});
