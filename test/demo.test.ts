/**
 * The demo, as a test: two complete nodes set up the way demo/local does it,
 * with the real demo scripts (echo-agent.js, run.js) run as child processes.
 * A second scenario resolves the two sides through DNS and the well-known
 * fallback instead of overrides.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAdtpTool, type AdtpMessage, type AdtpStatus } from '../integrations/stratus/adtp-tool.js';
import { parseConfig } from '../src/config.js';
import { eventJson } from '../src/core/events.js';
import { AdtpNode } from '../src/core/node.js';
import { createApp } from '../src/http/app.js';
import { Keyring } from '../src/identity/keyring.js';
import { httpRequest, type HttpClient } from '../src/identity/safe-http.js';
import { silentLogger } from '../src/log.js';
import { verifyDelegation } from '../src/protocol/delegation.js';
import { verifySignature } from '../src/protocol/signing.js';
import type { Envelope } from '../src/protocol/types.js';
import { createTestDb, dbAvailable, eventually, freePort, type TestDb } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';
const DIST = path.resolve(import.meta.dirname, '..');

interface Side {
  url: string;
  /** The agent token: what the demo's agents and the runner hold. */
  token: string;
  adminToken: string;
  node: AdtpNode;
  keyring: Keyring;
  server: Server;
  db: TestDb;
}

interface SideOptions {
  domain: string;
  publicUrl?: string;
  port: number;
  addresses: unknown[];
  discovery?: Record<string, unknown>;
  http?: HttpClient;
  resolveTxt?: (name: string) => Promise<string[][]>;
}

async function startSide(dir: string, token: string, opts: SideOptions): Promise<Side> {
  const db = await createTestDb();
  const url = `http://127.0.0.1:${opts.port}`;
  const config = parseConfig(
    {
      domain: opts.domain,
      public_url: opts.publicUrl ?? url,
      listen: { host: '127.0.0.1', port: opts.port },
      keys: { path: path.join(dir, opts.domain, 'keyring.json') },
      addresses: opts.addresses,
      delivery: { poll_interval_ms: 50, backoff_base_seconds: 0.2, max_attempts: 5 },
      discovery: opts.discovery ?? {},
    },
    {},
    dir,
  );
  const { keyring } = Keyring.load({ path: config.keys.path, graceDays: 30 });
  const node = await AdtpNode.create({ config, db: db.conn, keys: keyring, http: opts.http, resolveTxt: opts.resolveTxt });
  const adminToken = `${token}-admin`;
  const server = createApp({ node, adminToken, agentToken: token, log: silentLogger });
  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  node.worker.start();
  return { url, token, adminToken, node, keyring, server, db };
}

async function stopSide(side: Side | undefined): Promise<void> {
  if (!side) return;
  side.server.closeAllConnections();
  await new Promise((resolve) => side.server.close(resolve));
  await side.node.close();
  await side.db.drop();
}

/** Runs a compiled demo script and collects what it prints. */
function runScript(script: string, args: string[], env: Record<string, string>): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [path.join(DIST, 'demo', script), ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout!.on('data', (chunk: Buffer) => (text += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, output: () => text, exited };
}

describe('the demo, local mode', { skip }, () => {
  let dir: string;
  let stratus: Side;
  let echo: Side;
  let echoAgent: ReturnType<typeof runScript>;
  /** A receiver that has no way to find the sender: no override, no DNS record. */
  let blind: Side;
  /** What the blind side asked DNS and the web for. */
  const blindLookups: string[] = [];
  const FROM = 'agent@stratuslabs.localhost';
  const TO = 'echo@demo.adtp.localhost';
  const runnerEnv = () => ({ STRATUS_NODE_URL: stratus.url, STRATUS_TOKEN: stratus.token, FROM_ADDRESS: FROM, TO_ADDRESS: TO, OUT_DIR: dir, TIMEOUT_MS: '15000' });
  const api = async (side: Side, method: string, pathname: string, body?: unknown, token = side.token) => {
    const res = await fetch(side.url + pathname, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'adtp-demo-'));
    const [stratusPort, echoPort, blindPort] = [await freePort(), await freePort(), await freePort()];
    // The same shape as demo/local/*.config.yaml, with ports instead of container names.
    stratus = await startSide(dir, 'stratus-token', {
      domain: 'stratuslabs.localhost',
      port: stratusPort,
      addresses: [
        { local: 'dylan', type: 'human' },
        { local: 'agent', type: 'agent', acts_for: 'dylan', routes: [{ default: true, channel: 'agent' }] },
      ],
      discovery: {
        allow_insecure: true,
        overrides: {
          'demo.adtp.localhost': `http://127.0.0.1:${echoPort}/.well-known/adtp/{local}`,
          'blind.localhost': `http://127.0.0.1:${blindPort}/.well-known/adtp/{local}`,
        },
      },
    });
    // The blind side has no override for the sender's domain, so it looks the sender up as a
    // real node would: DNS, then the well-known URL. Both lookups are answered here, at once,
    // with "no such name". With the machine's own resolver, how long that takes (and so whether
    // the runner sees a retry before its timeout) would depend on where the test runs.
    blind = await startSide(dir, 'blind-token', {
      domain: 'blind.localhost',
      port: blindPort,
      addresses: [{ local: 'echo', type: 'agent', trusted: [FROM], routes: [{ default: true, channel: 'agent' }] }],
      discovery: { allow_insecure: true },
      resolveTxt: async (name) => {
        blindLookups.push(name);
        throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      },
      http: async (url) => {
        blindLookups.push(url);
        throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`);
      },
    });
    echo = await startSide(dir, 'echo-token', {
      domain: 'demo.adtp.localhost',
      port: echoPort,
      addresses: [{ local: 'echo', type: 'agent', trusted: [FROM], routes: [{ default: true, channel: 'agent' }] }],
      discovery: { allow_insecure: true, overrides: { 'stratuslabs.localhost': `http://127.0.0.1:${stratusPort}/.well-known/adtp/{local}` } },
    });
    echoAgent = runScript('echo-agent.js', [], { ADTP_NODE_URL: echo.url, ADTP_AGENT_TOKEN: echo.token, ADTP_ADDRESS: TO });
    await eventually(async () => echoAgent.output().includes('ready: waiting for messages'), 10_000, 'the echo agent to start');
  });

  after(async () => {
    echoAgent?.child.kill('SIGTERM');
    await echoAgent?.exited;
    await stopSide(stratus).catch(() => {});
    await stopSide(echo).catch(() => {});
    await stopSide(blind).catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('run.js: one signed message is accepted, delivered, read and answered, in under five seconds', async () => {
    const run = runScript('run.js', [], { ...runnerEnv(), MAX_SECONDS: '5' });
    const code = await run.exited;
    const out = run.output();
    assert.equal(code, 0, out);

    // The transcript on screen, in order.
    const order = ['discover', 'card', 'send', 'envelope', 'accepted', 'delivered', 'read', 'replied', 'reply', 'verify'].map((step) => out.search(new RegExp(`  ${step} +`)));
    assert.ok(order.every((at) => at >= 0), `every step is printed:\n${out}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `steps appear in causal order:\n${out}`);
    assert.match(out, /accepted +signature verified \(key ed25519-[0-9a-f]{16}\); delegation verified: agent@stratuslabs\.localhost acts for dylan@stratuslabs\.localhost; signed receipt from echo@demo\.adtp\.localhost checked/);
    assert.match(out, /"Received your request, signature verified for agent@stratuslabs\.localhost acting for dylan@stratuslabs\.localhost\."/);
    assert.match(out, /✓ accepted, delivered, read, and a reply on the same thread in \d+\.\d\ds/);

    // transcript.json: the full record.
    const transcript = JSON.parse(readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
    assert.equal(transcript.result.ok, true);
    assert.ok(transcript.result.elapsed_ms < 5000);
    assert.deepEqual(Object.keys(transcript.result.statuses), ['accepted', 'delivered', 'read', 'replied']);
    assert.equal(transcript.discovery.resolved.method, 'override');
    assert.equal(transcript.discovery.endpoint, `${echo.url}/adtp/v0/messages`);

    // The envelope is the one in SPEC.md, field for field.
    const envelope = transcript.envelope as Envelope;
    assert.deepEqual(Object.keys(envelope), ['adtp', 'id', 'thread', 'from', 'on_behalf_of', 'to', 'intent', 'priority', 'created_at', 'expires_at', 'requires_approval', 'content', 'delegation', 'signature']);
    assert.equal(envelope.adtp, '0');
    assert.match(envelope.id, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(envelope.thread!, /^thr_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(envelope.from, FROM);
    assert.equal(envelope.on_behalf_of, 'dylan@stratuslabs.localhost');
    assert.deepEqual(envelope.to, [TO]);
    assert.equal(envelope.intent, 'request');
    assert.equal(envelope.priority, 'normal');
    assert.equal(envelope.requires_approval, false);
    assert.deepEqual(Object.keys(envelope.content), ['parts']);
    const textPart = envelope.content.parts[0]!;
    assert.equal(textPart.type === 'text' && textPart.text, 'Hello from Stratus Labs. This is the first ADTP message. Please confirm receipt.');
    const dataPart = envelope.content.parts[1]!;
    assert.equal(dataPart.type === 'data' && dataPart.data.type, 'demo.ping');
    assert.ok(Math.abs(Date.parse(envelope.created_at) - Date.now()) < 60_000, 'created just now');
    const lifetime = Date.parse(envelope.expires_at!) - Date.now();
    assert.ok(lifetime > 55 * 60_000 && lifetime <= 60 * 60_000, 'expires an hour after sending');
    assert.deepEqual(Object.keys(envelope.signature), ['alg', 'kid', 'value']);
    assert.deepEqual(verifySignature(envelope, stratus.keyring.publicKeys(), new Date()), { ok: true, kid: stratus.keyring.kid }, 'the published transcript envelope really verifies');
    const delegation = verifyDelegation({
      token: envelope.delegation!,
      principal: 'dylan@stratuslabs.localhost',
      agent: FROM,
      intent: 'request',
      audiences: ['adtp'],
      keys: stratus.keyring.publicKeys(),
      now: new Date(),
    });
    assert.ok(delegation.ok && delegation.claims.scope.join() === 'request', 'the delegation covers this message and nothing more');

    // The reply is on the same thread, and both nodes agree on the outcome.
    assert.equal(transcript.reply.thread, envelope.thread);
    assert.equal(transcript.reply.from, TO);
    assert.equal(transcript.reply.intent, 'inform');
    assert.deepEqual(transcript.reply.verified, { signature: echo.keyring.kid });
    const onEcho = await api(echo, 'GET', `/api/v0/messages/${envelope.id}`);
    assert.equal(onEcho.json.copies[0].deliveries[0].state, 'replied');
    assert.equal(onEcho.json.copies[0].deliveries[0].channel, 'agent');

    // transcript.md: pasteable, with the signature shortened.
    const md = readFileSync(path.join(dir, 'transcript.md'), 'utf8');
    assert.match(md, /^# ADTP v0 demo: one signed message, end to end/);
    assert.match(md, /\*\*Result:\*\* ✅/);
    assert.ok(!md.includes(envelope.signature.value), 'the full signature is not pasted into the markdown');
    assert.ok(md.includes(envelope.signature.value.slice(0, 16)));

    // Side B's own log tells the same story.
    await eventually(async () => echoAgent.output().includes('replied with msg_'), 5000, "the echo agent's log");
    const log = echoAgent.output();
    assert.match(log, new RegExp(`received request ${envelope.id} from ${FROM} acting for dylan@stratuslabs\\.localhost`));
    assert.match(log, new RegExp(`signature verified \\(key ${stratus.keyring.kid}\\)`));
    assert.match(log, /delegation verified \(signed by dylan@stratuslabs\.localhost\)/);
    assert.match(log, /marked read/);
  });

  it('run.js --tamper: one flipped byte and Side B rejects the envelope with a signature error', async () => {
    const run = runScript('run.js', ['--tamper'], runnerEnv());
    const code = await run.exited;
    const out = run.output();
    assert.equal(code, 0, out);
    assert.match(out, /tamper +one byte changed in transit: "Hello…" → "Iello…"/);
    assert.match(out, /rejected +HTTP 401 {2}bad_signature: the envelope signature does not verify against key "ed25519-[0-9a-f]{16}" of agent@stratuslabs\.localhost/);
    assert.match(out, /✓ Side B refused the tampered envelope/);

    const transcript = JSON.parse(readFileSync(path.join(dir, 'transcript.tamper.json'), 'utf8'));
    assert.equal(transcript.mode, 'tamper');
    assert.equal(transcript.result.ok, true);
    assert.deepEqual(verifySignature(transcript.envelope, stratus.keyring.publicKeys(), new Date()), { ok: false, reason: 'invalid' });
    assert.equal((await api(echo, 'GET', `/api/v0/messages/${transcript.envelope.id}`)).status, 404, 'Side B stored nothing');
    assert.equal((await api(stratus, 'GET', `/api/v0/messages/${transcript.envelope.id}`)).status, 404, 'signing for the test sent nothing');
  });

  it('run.js: says why when the other side cannot verify the sender yet', async () => {
    // The usual first-live-run mistake: the receiver cannot find the sender's card (a missing DNS record).
    // The runner checks on a silent message half way to its timeout. These test nodes retry every
    // few hundred milliseconds and give up within three seconds, so by then they are mid-retry.
    const run = runScript('run.js', [], { ...runnerEnv(), TO_ADDRESS: 'echo@blind.localhost', TIMEOUT_MS: '2000' });
    const code = await run.exited;
    const out = run.output();
    assert.equal(code, 1, out);
    assert.match(out, /stratus +retrying +attempt \d did not get through; the node will retry: sender_unresolvable: could not fetch the sender's card/);
    // Depending on timing the run ends at its own timeout or when the node gives up; both say why.
    assert.match(out, /✗ (timed out after 2s; missing: accepted, delivered, read, reply|the message did not complete: failed)/);
    assert.ok(!/ (accepted|delivered) /.test(out.split('"signature"')[1] ?? ''), 'nothing was accepted');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'transcript.json'), 'utf8')).result.ok, false);
    assert.equal((await api(blind, 'GET', '/api/v0/tray', undefined, blind.adminToken)).json.items.length, 0, 'the receiver stored nothing');
    // The receiver looked for the sender where a real node would, and nowhere else.
    assert.deepEqual([...new Set(blindLookups)], ['_adtp.stratuslabs.localhost', 'https://stratuslabs.localhost/.well-known/adtp/agent']);
  });

  it('run.js --watch: transcribes a message sent by the agent itself', async () => {
    // An older message that is still being retried. Its "failed" status arrives while the runner is
    // watching, and must not be mistaken for the message the runner is waiting for.
    const older = await api(stratus, 'POST', '/api/v0/messages', { from: FROM, to: 'echo@blind.localhost', intent: 'request', text: 'this one will fail later' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const run = runScript('run.js', ['--watch'], runnerEnv());
    await eventually(async () => run.output().includes('Waiting for agent@stratuslabs.localhost'), 10_000, 'the runner to start watching');
    await eventually(
      async () => (await api(stratus, 'GET', `/api/v0/messages/${older.json.id}`)).json.copies[0].deliveries[0].state === 'failed',
      10_000,
      'the older message to fail while the runner watches',
    );
    // The "real" agent, using the same tool the Stratus agent would.
    const agent = createAdtpTool({ nodeUrl: stratus.url, token: stratus.token, address: FROM });
    const sent = await agent.call('adtp_send', { to: TO, intent: 'request', text: 'Sent by the agent, not by the script.' });
    const code = await run.exited;
    assert.equal(code, 0, run.output());
    assert.match(run.output(), new RegExp(`the Stratus agent sent ${(sent as { id: string }).id}`));
    assert.match(run.output(), /Sent by the agent, not by the script\./);
    assert.match(run.output(), /✓ accepted, delivered, read, and a reply/);
    assert.ok(!run.output().includes(older.json.id), 'the older message is not what was transcribed');
  });

  it('the tool surfaces statuses and the reply through its callbacks', async () => {
    const tool = createAdtpTool({ nodeUrl: stratus.url, token: stratus.token, address: FROM });
    assert.deepEqual(tool.tools.map((t) => t.name), ['adtp_send', 'adtp_directory']);
    const statuses: AdtpStatus[] = [];
    const replies: AdtpMessage[] = [];
    tool.adtp_on_status((s) => void statuses.push(s));
    tool.adtp_on_message((m) => void replies.push(m));
    try {
      const sent = await tool.adtp_send(TO, 'request', 'ping from the tool', { n: 1 });
      await eventually(async () => replies.length > 0 && statuses.some((s) => s.status === 'replied'), 8000, 'the reply and statuses');
      const mine = statuses.filter((s) => s.message_id === sent.id);
      assert.deepEqual(mine.map((s) => s.status), ['accepted', 'delivered', 'read', 'replied']);
      assert.ok(mine.every((s) => s.recipient === TO && s.thread === sent.thread && !Number.isNaN(Date.parse(s.at))));
      assert.deepEqual(mine[0]!.verified, { signature: stratus.keyring.kid, delegation: 'dylan@stratuslabs.localhost' });
      assert.deepEqual(mine[0]!.receipt, { by: TO, kid: echo.keyring.kid }, "the receipt was signed by the recipient's node");
      assert.equal(replies[0]!.thread, sent.thread);
      assert.equal(replies[0]!.from, TO);
      await assert.rejects(tool.call('adtp_delete_everything', {}), /unknown ADTP tool/);
      await assert.rejects(tool.adtp_send('not-an-address', 'request', 'x'), /ADTP node answered 400/);
    } finally {
      await tool.stop();
    }
  });

  it('serves the agent API: events, read, resolve and sign-only', async () => {
    // events: auth, cursors, validation
    assert.equal((await api(echo, 'GET', `/api/v0/events?address=${TO}`, undefined, 'wrong')).status, 401);
    assert.equal((await api(echo, 'GET', '/api/v0/events')).status, 400);
    assert.equal((await api(echo, 'GET', `/api/v0/events?address=${TO}&after=minus-one`)).status, 400);
    assert.equal((await api(echo, 'GET', '/api/v0/events?address=nobody@demo.adtp.localhost')).status, 403, 'the agent token reads agent feeds only');
    assert.equal((await api(echo, 'GET', '/api/v0/events?address=nobody@demo.adtp.localhost', undefined, echo.adminToken)).status, 404);
    const latest = await api(echo, 'GET', `/api/v0/events?address=${TO}&after=latest`);
    assert.deepEqual(latest.json.events, []);
    assert.ok(latest.json.cursor > 0);
    const all = await api(echo, 'GET', `/api/v0/events?address=${TO}&after=0&limit=1`);
    assert.equal(all.json.events.length, 1);
    assert.equal(all.json.events[0].type, 'message');
    assert.equal(all.json.cursor, all.json.events[0].seq);

    // long poll over HTTP: the request is held open and answered when something lands on the feed.
    // Other events (statuses for earlier replies) may come first, so keep following until the message does.
    const started = Date.now();
    let cursor: number = latest.json.cursor;
    const firstPoll = api(echo, 'GET', `/api/v0/events?address=${TO}&after=${cursor}&wait=10`);
    const sent = await api(stratus, 'POST', '/api/v0/messages', { from: FROM, to: TO, intent: 'inform', text: 'wake the poller' });
    let arrived: any;
    let page = await firstPoll;
    for (;;) {
      assert.ok(page.json.events.length > 0, 'a poll that returns before its wait is over carries at least one event');
      cursor = page.json.cursor;
      arrived = page.json.events.find((e: any) => e.type === 'message' && e.message.id === sent.json.id);
      if (arrived) break;
      page = await api(echo, 'GET', `/api/v0/events?address=${TO}&after=${cursor}&wait=10`);
    }
    assert.equal(arrived.message.text, 'wake the poller');
    assert.ok(Date.now() - started < 5000, 'answered long before the 10 second wait ran out');

    // read: an inform is not answered by the echo agent, so this API call is what marks it read
    const read = await api(echo, 'POST', `/api/v0/messages/${sent.json.id}/read`, { recipient: TO, from: FROM });
    assert.deepEqual(read.json, { read: true, changed: true });
    await eventually(async () => (await api(stratus, 'GET', `/api/v0/messages/${sent.json.id}`)).json.copies[0].deliveries[0].state === 'read', 5000, 'the read status');

    // resolve: where the other side's card came from
    const resolved = await api(stratus, 'GET', `/api/v0/resolve?address=${TO}`);
    assert.equal(resolved.json.address, TO);
    assert.equal(resolved.json.type, 'agent');
    assert.deepEqual(resolved.json.resolved, { method: 'override', card_url: `${echo.url}/.well-known/adtp/echo` });
    assert.equal((await api(stratus, 'GET', `/api/v0/resolve?address=${FROM}`)).json.acts_for, 'dylan@stratuslabs.localhost');
    assert.equal((await api(stratus, 'GET', '/api/v0/resolve?address=ghost@nowhere.invalid')).status, 502);

    // sign-only
    const dry = await api(stratus, 'POST', '/api/v0/messages', { from: FROM, to: TO, intent: 'request', text: 'not sent', dry_run: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dry_run, true);
    assert.ok(verifySignature(dry.json.envelope, stratus.keyring.publicKeys(), new Date()).ok);
    assert.equal((await api(stratus, 'GET', `/api/v0/messages/${dry.json.id}`)).status, 404);

    // on_behalf_of: left out, the agent's configured principal applies; an explicit null sends as the agent itself.
    assert.equal(dry.json.envelope.on_behalf_of, 'dylan@stratuslabs.localhost');
    const asItself = await api(stratus, 'POST', '/api/v0/messages', { from: FROM, to: TO, intent: 'inform', text: 'as myself', on_behalf_of: null, dry_run: true });
    assert.equal(asItself.status, 200);
    assert.equal(asItself.json.envelope.on_behalf_of, undefined);
    assert.equal(asItself.json.envelope.delegation, undefined);
    assert.ok(verifySignature(asItself.json.envelope, stratus.keyring.publicKeys(), new Date()).ok);

    // The agents hold the agent token, which is not a way into the node's administration.
    assert.equal((await api(echo, 'GET', '/api/v0/tray')).status, 403);
    assert.equal((await api(echo, 'POST', '/api/v0/delegations', { principal: TO, agent: FROM })).status, 403);
    assert.equal((await api(echo, 'GET', '/api/v0/tray', undefined, echo.adminToken)).status, 200);
  });
});

describe('the demo, resolved through DNS and the well-known fallback', { skip }, () => {
  let dir: string;
  let stratus: Side;
  let echo: Side;
  const fetched: string[] = [];
  const txtLookups: string[] = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'adtp-dns-'));
    const [stratusPort, echoPort] = [await freePort(), await freePort()];
    const hosts: Record<string, number> = { 'adtp.stratus.test': stratusPort, 'node.demo.test': echoPort };

    // Stands in for public DNS + TLS: https://<host>/... is served by the node behind that host.
    const internet: HttpClient = async (url, options) => {
      const target = new URL(url);
      fetched.push(`${options?.method ?? 'GET'} ${url}`);
      if (target.protocol !== 'https:') throw new Error(`refusing plain http URL ${target.origin}`);
      // demo.test's website does not run the node; it redirects the well-known path to it.
      if (target.host === 'demo.test') return { status: 302, headers: { location: `https://node.demo.test${target.pathname}` }, body: '' };
      const port = hosts[target.host];
      if (!port) throw new Error(`getaddrinfo ENOTFOUND ${target.host}`);
      return httpRequest(`http://127.0.0.1:${port}${target.pathname}${target.search}`, { ...options, allowInsecure: true });
    };
    // Only stratus.test publishes an _adtp record.
    const resolveTxt = async (name: string): Promise<string[][]> => {
      txtLookups.push(name);
      if (name === '_adtp.stratus.test') return [['v=spf1 -all'], ['v=adtp0; card=https://adtp.stratus.test/.well-known/adtp/{local}']];
      throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    };

    stratus = await startSide(dir, 'stratus-token', {
      domain: 'stratus.test',
      publicUrl: 'https://adtp.stratus.test',
      port: stratusPort,
      addresses: [
        { local: 'dylan', type: 'human' },
        { local: 'agent', type: 'agent', acts_for: 'dylan', routes: [{ default: true, channel: 'agent' }] },
      ],
      http: internet,
      resolveTxt,
    });
    echo = await startSide(dir, 'echo-token', {
      domain: 'demo.test',
      publicUrl: 'https://node.demo.test',
      port: echoPort,
      addresses: [{ local: 'echo', type: 'agent', trusted: ['agent@stratus.test'], routes: [{ default: true, channel: 'agent' }] }],
      http: internet,
      resolveTxt,
    });
  });

  after(async () => {
    await stopSide(stratus).catch(() => {});
    await stopSide(echo).catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds the recipient through the well-known fallback (following a redirect) and the sender through its TXT record', async () => {
    const sent = await stratus.node.submit({ from: 'agent@stratus.test', to: ['echo@demo.test'], intent: 'request', text: 'Hello over real discovery.' });

    const [event] = await eventually(async () => {
      const events = (await echo.node.events('echo@demo.test', 0)).map(eventJson) as any[];
      return events.length > 0 ? events : null;
    }, 8000, 'the message to reach the echo agent');
    assert.equal(event.message.id, sent.id);
    assert.deepEqual(event.verified, { signature: stratus.keyring.kid, delegation: 'dylan@stratus.test' });

    // Recipient: no TXT record for demo.test, so the well-known URL on the domain itself, which redirects to the node.
    const recipient = await stratus.node.resolve('echo@demo.test');
    assert.deepEqual(recipient.resolved, { method: 'well-known', card_url: 'https://node.demo.test/.well-known/adtp/echo' });
    assert.equal(recipient.endpoint, 'https://node.demo.test/adtp/v0/messages');
    assert.ok(txtLookups.includes('_adtp.demo.test'), 'DNS was asked first');
    assert.ok(fetched.includes('GET https://demo.test/.well-known/adtp/echo'));
    assert.ok(fetched.includes('GET https://node.demo.test/.well-known/adtp/echo'));
    assert.ok(fetched.includes('POST https://node.demo.test/adtp/v0/messages'), 'the envelope went to the endpoint from the card');

    // Sender, as seen from Side B: found through its _adtp TXT record.
    const sender = await echo.node.resolve('agent@stratus.test');
    assert.deepEqual(sender.resolved, {
      method: 'dns',
      card_url: 'https://adtp.stratus.test/.well-known/adtp/agent',
      dns_record: { name: '_adtp.stratus.test', value: 'v=adtp0; card=https://adtp.stratus.test/.well-known/adtp/{local}' },
    });
    assert.equal(sender.acts_for, 'dylan@stratus.test');
    assert.ok(!fetched.some((f) => f.includes('https://stratus.test/')), 'the fallback is not used when the TXT record works');

    // A node can also check its own address the way the rest of the world sees it.
    assert.deepEqual((await stratus.node.resolve('agent@stratus.test')).resolved, { method: 'local' });
    const asOthersSeeIt = await stratus.node.resolve('agent@stratus.test', { external: true });
    assert.equal(asOthersSeeIt.resolved?.method, 'dns');
    assert.equal(asOthersSeeIt.resolved?.card_url, 'https://adtp.stratus.test/.well-known/adtp/agent');
    assert.deepEqual(asOthersSeeIt.keys, stratus.keyring.publicKeys());
    const viaApi = await fetch(`${stratus.url}/api/v0/resolve?address=agent@stratus.test&external=true`, { headers: { authorization: `Bearer ${stratus.token}` } });
    assert.equal(((await viaApi.json()) as { resolved: { method: string } }).resolved.method, 'dns');

    // And the status updates find their way back the same way.
    await eventually(async () => (await stratus.node.store.getDelivery({ direction: 'out', from: 'agent@stratus.test', message_id: sent.id, recipient: 'echo@demo.test' }))?.state === 'delivered', 8000, 'the delivered status');
  });
});
