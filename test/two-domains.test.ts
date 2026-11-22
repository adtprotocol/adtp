/**
 * The two-server example (examples/two-domains), run the way its README says:
 * the example's own config file and .env presets, the DNS records each node
 * tells its operator to publish, and a person on one side who reads and
 * answers on the node's inbox page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AdtpClient } from '../src/client.js';
import { dnsTxtRecord, loadConfig, parseConfig, type NodeConfig } from '../src/config.js';
import { AdtpNode } from '../src/core/node.js';
import { createApp } from '../src/http/app.js';
import { httpRequest, type HttpClient } from '../src/identity/safe-http.js';
import { silentLogger } from '../src/log.js';
import { createTestDb, dbAvailable, freePort, TestKeys, type TestDb } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

// The compiled test lives in dist/test; the example and the image's config are at the repository root.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLE = path.join(ROOT, 'examples', 'two-domains');
/** The config the Docker image starts with: everything from environment variables. */
const ENV_CONFIG = path.join(ROOT, 'deploy', 'env.config.yaml');

/** The settings a server gets from one of the example's .env presets, as Compose would pass them on. */
function preset(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path.join(EXAMPLE, file), 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  env.ADTP_PUBLIC_URL = `https://${env.ADTP_HOST}`;
  return env;
}

interface Side {
  config: NodeConfig;
  url: string;
  node: AdtpNode;
  server: Server;
  db: TestDb;
  client: AdtpClient;
  /** A signed-in browser session on the node's admin pages. */
  cookie: string;
}

describe('the built-in inbox channel', () => {
  it('needs no channel settings and no destination', () => {
    const config = parseConfig({ domain: 'a.test', public_url: 'https://a.test', addresses: [{ local: 'dana', type: 'human', routes: [{ default: true, channel: 'inbox' }] }] }, {}, '/tmp');
    assert.deepEqual(config.addresses[0]!.routes, [{ match: undefined, default: true, channel: 'inbox', to: undefined }]);
    assert.throws(
      () => parseConfig({ domain: 'a.test', public_url: 'https://a.test', addresses: [{ local: 'dana', routes: [{ default: true, channel: 'pager' }] }] }, {}, '/tmp'),
      /to is required for the pager channel/,
      'other channels still need both',
    );
  });
});

describe('the two-server example: agent@example.com and dana@example.org', { skip }, () => {
  let source: Side;
  let dana: Side;
  const AGENT = 'agent@example.com';
  const DANA = 'dana@example.org';

  async function start(file: string, port: number, http: HttpClient, resolveTxt: (name: string) => Promise<string[][]>): Promise<Side> {
    const config = loadConfig(ENV_CONFIG, preset(file));
    const db = await createTestDb();
    const node = await AdtpNode.create({ config, db: db.conn, keys: new TestKeys(), http, resolveTxt });
    const server = createApp({ node, adminToken: 'admin-token', agentToken: 'agent-token', log: silentLogger });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${port}`;
    const login = await fetch(`${url}/admin/login`, { method: 'POST', body: new URLSearchParams({ token: 'admin-token' }), redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    return { config, url, node, server, db, client: new AdtpClient({ baseUrl: url, token: 'admin-token' }), cookie };
  }

  /** What a person does on the inbox page: a form post from the signed-in browser. */
  async function submit(side: Side, action: string, fields: Record<string, string>): Promise<string> {
    const res = await fetch(`${side.url}${action}`, { method: 'POST', headers: { cookie: side.cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
    assert.equal(res.status, 303, `${action} answers with a redirect`);
    return res.headers.get('location') ?? '';
  }
  const page = async (side: Side, where: string): Promise<string> => (await fetch(`${side.url}${where}`, { headers: { cookie: side.cookie } })).text();
  /** A form post that is answered with a page instead of a redirect: returns its status. */
  async function submitPage(side: Side, action: string, fields: Record<string, string>): Promise<number> {
    const res = await fetch(`${side.url}${action}`, { method: 'POST', headers: { cookie: side.cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
    await res.text();
    return res.status;
  }
  const outbound = async (side: Side, id: string, to: string) => (await side.node.store.findDeliveries('out', id, to))[0];
  const inbound = async (side: Side, id: string, to: string) => (await side.node.store.findDeliveries('in', id, to))[0];
  /** Lets both nodes work through their queues until nothing is left to send. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await source.node.worker.drain();
      await dana.node.worker.drain();
    }
  }

  before(async () => {
    const [sourcePort, danaPort] = [await freePort(), await freePort()];
    const hosts: Record<string, number> = { 'adtp.example.com': sourcePort, 'adtp.example.org': danaPort };
    // Stands in for public DNS + TLS: https://<host>/... is served by the node behind that host.
    const internet: HttpClient = async (url, options) => {
      const target = new URL(url);
      if (target.protocol !== 'https:') throw new Error(`refusing plain http URL ${target.origin}`);
      const port = hosts[target.host];
      if (!port) throw new Error(`getaddrinfo ENOTFOUND ${target.host}`);
      return httpRequest(`http://127.0.0.1:${port}${target.pathname}${target.search}`, { ...options, allowInsecure: true });
    };
    // The TXT records the README has the operator publish: exactly what each node prints.
    const records = new Map<string, string>();
    const resolveTxt = async (name: string): Promise<string[][]> => {
      const value = records.get(name);
      if (!value) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return [[value]];
    };
    source = await start('first.env.example', sourcePort, internet, resolveTxt);
    dana = await start('second.env.example', danaPort, internet, resolveTxt);
    for (const side of [source, dana]) {
      const record = dnsTxtRecord(side.config);
      records.set(record.name, record.value);
    }
  });

  after(async () => {
    for (const side of [source, dana]) {
      if (!side) continue;
      side.server.closeAllConnections();
      await new Promise((resolve) => side.server.close(resolve));
      await side.node.close();
      await side.db.drop();
    }
  });

  it('gives each server the address and the DNS record the README names', () => {
    assert.deepEqual(source.config.addresses.map((a) => [a.address, a.type, a.listed]), [[AGENT, 'agent', true]]);
    assert.deepEqual(dana.config.addresses.map((a) => [a.address, a.type, a.listed]), [[DANA, 'human', false]]);
    assert.deepEqual(dnsTxtRecord(source.config), {
      name: '_adtp.example.com',
      value: 'v=adtp0; card=https://adtp.example.com/.well-known/adtp/{local}; directory=https://adtp.example.com/.well-known/adtp',
    });
    assert.deepEqual(dnsTxtRecord(dana.config), {
      name: '_adtp.example.org',
      value: 'v=adtp0; card=https://adtp.example.org/.well-known/adtp/{local}; directory=https://adtp.example.org/.well-known/adtp',
    });
    const readme = readFileSync(path.join(EXAMPLE, 'README.md'), 'utf8');
    for (const side of [source, dana]) {
      const record = dnsTxtRecord(side.config);
      assert.ok(readme.includes(`\`${record.name}\``) && readme.includes(record.value), `the README gives the record for ${side.config.domain}`);
    }
  });

  it('lets each side find the other through DNS', async () => {
    const there = await source.node.resolve(DANA);
    assert.equal(there.resolved?.method, 'dns');
    assert.equal(there.endpoint, 'https://adtp.example.org/adtp/v0/messages');
    assert.equal((await dana.node.resolve(AGENT)).endpoint, 'https://adtp.example.com/adtp/v0/messages');

    // agent@ is listed; dana@, a person, is not.
    const listed = await dana.node.directory('example.com');
    assert.deepEqual(listed.entries.map((e) => [e.address, e.type]), [[AGENT, 'agent']]);
    assert.ok(listed.entries[0]!.description);
    assert.deepEqual((await source.node.directory('example.org')).entries, []);
  });

  it('carries a first message from source to dana, who approves, reads and answers it in the browser', async () => {
    // 1. agent@example.com writes to someone it has never written to, from the New message page.
    const form = await page(source, '/admin/compose');
    assert.match(form, /<option value="agent@example\.com"/, 'the node\'s own address is offered as the sender');
    assert.equal(await submitPage(source, '/admin/compose', { from: AGENT, to: 'not an address', intent: 'request', text: 'Hello' }), 400);
    assert.equal(await submitPage(source, '/admin/compose', { from: AGENT, to: DANA, intent: 'shout', text: 'Hello' }), 400);
    const where = await submit(source, '/admin/compose', { from: AGENT, to: DANA, intent: 'request', text: 'Hello from example.com. Can you read this?' });
    const opened = /^\/admin\/threads\/([^?]+)\?done=sent$/.exec(where);
    assert.ok(opened, `sending opens the thread (${where})`);
    const [first] = await source.node.thread(decodeURIComponent(opened[1]!));
    assert.ok(first, 'the message is on that thread');
    const sent = { id: first.id, thread: first.thread_id };
    assert.deepEqual([first.from_addr, first.to_addrs, first.intent], [AGENT, [DANA], 'request']);
    await settle();
    assert.equal((await outbound(source, sent.id, DANA))?.state, 'sent', 'the other node took it');
    assert.equal((await inbound(dana, sent.id, DANA))?.state, 'held', 'and holds it: dana does not know this sender');

    // 2. Dana finds it under Requests and approves the sender.
    assert.match(await page(dana, '/admin/tray'), /agent@example\.com[\s\S]*Hello from example\.com\. Can you read this\?/);
    assert.equal(await submit(dana, '/admin/tray/approve', { id: sent.id, recipient: DANA, from: AGENT }), '/admin/tray?done=approved');
    await settle();
    const delivered = await inbound(dana, sent.id, DANA);
    assert.equal(delivered?.state, 'delivered');
    assert.equal(delivered?.channel, 'inbox', 'it stays on the node, for the inbox page');
    assert.equal((await outbound(source, sent.id, DANA))?.state, 'delivered', 'and source is told');

    // 3. The thread page offers what a reader needs: mark read, and a reply box.
    const thread = `/admin/threads/${encodeURIComponent(sent.thread)}`;
    const before = await page(dana, thread);
    assert.match(before, /action="\/admin\/inbox\/read"/);
    assert.match(before, /action="\/admin\/inbox\/reply"[\s\S]*Reply as dana@example\.org/);
    const fields = { id: sent.id, recipient: DANA, from: AGENT, thread: sent.thread };

    assert.equal(await submit(dana, '/admin/inbox/read', fields), `${thread}?done=read`);
    await settle();
    assert.equal((await outbound(source, sent.id, DANA))?.state, 'read');
    assert.equal(await submit(dana, '/admin/inbox/read', fields), `${thread}?done=already_read`, 'marking twice changes nothing');
    assert.doesNotMatch(await page(dana, thread), /action="\/admin\/inbox\/read"/, 'the button goes once the message is read');

    // 4. A reply needs text; with text it goes out and the original is answered.
    assert.equal(await submit(dana, '/admin/inbox/reply', { ...fields, text: '   ' }), `${thread}?done=empty`);
    assert.equal(await submit(dana, '/admin/inbox/reply', { ...fields, text: 'Yes. Read it on the node\'s inbox page.' }), `${thread}?done=replied`);
    await settle();
    assert.equal((await inbound(dana, sent.id, DANA))?.state, 'replied');
    assert.equal((await outbound(source, sent.id, DANA))?.state, 'replied', 'source hears that it was answered');
    assert.match(await page(dana, `${thread}?done=replied`), /Reply sent\./);
    assert.doesNotMatch(await page(dana, thread), /action="\/admin\/inbox\/reply"/, 'an answered message asks for no further answer');

    // 5. The answer itself arrives on source's node, on the same thread, without waiting:
    //    source wrote to dana first, so it knows the sender.
    const messages = await source.node.thread(sent.thread);
    const reply = messages.find((m) => m.direction === 'in' && !m.receipt_for);
    assert.ok(reply, 'the reply is on the thread');
    assert.equal(reply.from_addr, DANA);
    assert.deepEqual(reply.deliveries.map((d) => [d.recipient, d.state, d.channel]), [[AGENT, 'delivered', 'inbox']]);
    assert.match(await page(source, thread), /Yes\. Read it on the node&#39;s inbox page\./);
  });

  it('lets dana write back without waiting, and answer from the command line by message id', async () => {
    // The other direction: source already knows dana, so nothing is held.
    const hello = await dana.client.send({ from: DANA, to: AGENT, intent: 'inform', text: 'Writing to you first this time.' });
    await settle();
    assert.equal((await inbound(source, hello.id, AGENT))?.state, 'delivered');

    // What `adtp send --in-reply-to <id>` sends: the same request with in_reply_to.
    const answer = await source.client.send({ from: AGENT, to: DANA, intent: 'inform', text: 'Got it.', in_reply_to: hello.id });
    await settle();
    assert.equal((await inbound(source, hello.id, AGENT))?.state, 'replied');
    assert.equal((await outbound(dana, hello.id, AGENT))?.state, 'replied');
    assert.equal((await inbound(dana, answer.id, DANA))?.state, 'delivered', 'dana approved source earlier, so this is delivered at once');
  });

  it('shows no inbox controls for messages this node sent, or to someone who is not signed in', async () => {
    const sent = await source.client.send({ from: AGENT, to: DANA, intent: 'inform', text: 'One more.' });
    await settle();
    const thread = `/admin/threads/${encodeURIComponent(sent.thread)}`;
    assert.doesNotMatch(await page(source, thread), /\/admin\/inbox\//, 'the sender\'s copy has nothing to read or answer');
    assert.match(await page(dana, thread), /\/admin\/inbox\/reply/);

    const anonymous = await fetch(`${dana.url}/admin/inbox/read`, { method: 'POST', body: new URLSearchParams({ id: sent.id, recipient: DANA, from: AGENT, thread: sent.thread }), redirect: 'manual' });
    assert.equal(anonymous.headers.get('location'), '/admin/login');
    assert.equal((await inbound(dana, sent.id, DANA))?.state, 'delivered', 'and nothing was marked');
  });
});
