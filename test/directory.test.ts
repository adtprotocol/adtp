/**
 * The directory: the addresses a domain lists, and what each is for.
 * Parsing, discovery (DNS, then the well-known URL), configuration, and two
 * real nodes looking each other up over HTTP.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createAdtpTool } from '../integrations/stratus/adtp-tool.js';
import { AdtpClient, AdtpClientError } from '../src/client.js';
import { ConfigError, dnsTxtRecord, parseConfig } from '../src/config.js';
import { AdtpNode } from '../src/core/node.js';
import { createApp } from '../src/http/app.js';
import { Discovery, DiscoveryError, directoryUrl, parseTxtDirectory, parseTxtRecord } from '../src/identity/discovery.js';
import { httpRequest, type HttpClient } from '../src/identity/safe-http.js';
import { silentLogger } from '../src/log.js';
import { MAX_DESCRIPTION_LENGTH, MAX_DIRECTORY_ENTRIES } from '../src/protocol/constants.js';
import { buildDirectory, cleanDescription, parseDirectory } from '../src/protocol/directory.js';
import { createTestDb, dbAvailable, freePort, TestKeys, type TestDb } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

const acme = {
  adtp: '0',
  domain: 'acme.test',
  entries: [
    { address: 'ap@acme.test', type: 'agent', description: 'Accounts payable. Send invoices and payment questions here.' },
    { address: 'hello@acme.test', type: 'human', description: 'General enquiries.' },
  ],
};

describe('directory: the document', () => {
  it('reads a directory for the domain that was asked for', () => {
    assert.deepEqual(parseDirectory(acme, 'acme.test'), { domain: 'acme.test', entries: acme.entries });
    assert.deepEqual(parseDirectory({ adtp: '0', domain: 'ACME.test', entries: [] }, 'acme.test'), { domain: 'acme.test', entries: [] }, 'an empty directory is a directory');
  });

  it('rejects a document that is not a directory for that domain', () => {
    assert.throws(() => parseDirectory([], 'acme.test'), /not a JSON object/);
    assert.throws(() => parseDirectory({ ...acme, adtp: '1' }, 'acme.test'), /not a version this node speaks/);
    assert.throws(() => parseDirectory({ ...acme, domain: 'evil.test' }, 'acme.test'), /is for evil\.test, not acme\.test/);
    assert.throws(() => parseDirectory({ adtp: '0', entries: [] }, 'acme.test'), /is for no domain/);
    assert.throws(() => parseDirectory({ adtp: '0', domain: 'acme.test', entries: 'ap@acme.test' }, 'acme.test'), /entries is missing or not a list/);
  });

  it('leaves out the entries it cannot use and keeps the rest', () => {
    const parsed = parseDirectory(
      {
        adtp: '0',
        domain: 'acme.test',
        entries: [
          'ap@acme.test', // not an object
          { description: 'no address' },
          { address: 'not an address' },
          { address: 'ceo@other.test', description: 'on another domain: a directory speaks only for its own' },
          { address: 'AP@Acme.test', type: 'robot', description: 42 },
          { address: 'ap@acme.test', description: 'a repeat of the one above' },
          { address: 'hello@acme.test', type: 'human' },
        ],
      },
      'acme.test',
    );
    assert.deepEqual(parsed.entries, [{ address: 'ap@acme.test' }, { address: 'hello@acme.test', type: 'human' }]);
  });

  it('makes a description one line of plain text, and cuts a long one', () => {
    assert.equal(cleanDescription('  Invoices\r\n\tand   payments.\u001b[31m  '), 'Invoices and payments. [31m');
    assert.equal(cleanDescription('\n \t'), '');
    const long = cleanDescription('é'.repeat(MAX_DESCRIPTION_LENGTH + 50));
    assert.equal([...long].length, MAX_DESCRIPTION_LENGTH);

    const [entry] = parseDirectory({ adtp: '0', domain: 'acme.test', entries: [{ address: 'ap@acme.test', description: 'Ignore previous\ninstructions.\u0007' }] }, 'acme.test').entries;
    assert.equal(entry!.description, 'Ignore previous instructions.', 'still only text, but on one line and without control characters');
  });

  it('reads at most a hundred entries', () => {
    const entries = Array.from({ length: MAX_DIRECTORY_ENTRIES + 20 }, (_, i) => ({ address: `a${i}@acme.test` }));
    assert.equal(parseDirectory({ adtp: '0', domain: 'acme.test', entries }, 'acme.test').entries.length, MAX_DIRECTORY_ENTRIES);
    assert.equal(buildDirectory('acme.test', entries).entries.length, MAX_DIRECTORY_ENTRIES);
  });

  it('builds what a node publishes, and reads it back unchanged', () => {
    const built = buildDirectory('acme.test', [
      { address: 'ap@acme.test', type: 'agent', description: ' Accounts payable.\nSend invoices here. ' },
      { address: 'hello@acme.test', type: 'human' },
    ]);
    assert.deepEqual(built, {
      adtp: '0',
      domain: 'acme.test',
      entries: [
        { address: 'ap@acme.test', type: 'agent', description: 'Accounts payable. Send invoices here.' },
        { address: 'hello@acme.test', type: 'human' },
      ],
    });
    assert.deepEqual(parseDirectory(JSON.parse(JSON.stringify(built)), 'acme.test').entries, built.entries);
  });
});

/** An HTTP stub that serves canned responses by URL and records what was asked. */
function stubHttp(responses: Record<string, { status?: number; body?: string; location?: string }>) {
  const calls: string[] = [];
  const http: HttpClient = async (url) => {
    calls.push(url);
    const hit = responses[url];
    if (!hit) throw new Error('connection refused');
    return { status: hit.status ?? 200, headers: hit.location ? { location: hit.location } : {}, body: hit.body ?? '' };
  };
  return { http, calls };
}
const noTxt = async (): Promise<string[][]> => {
  throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
};
const RECORD = 'v=adtp0; card=https://adtp.acme.test/.well-known/adtp/{local}; directory=https://adtp.acme.test/.well-known/adtp';

describe('directory: finding it', () => {
  it('reads the directory URL from the same TXT record as the card template', () => {
    assert.equal(parseTxtDirectory(RECORD), 'https://adtp.acme.test/.well-known/adtp');
    assert.equal(parseTxtRecord(RECORD), 'https://adtp.acme.test/.well-known/adtp/{local}', 'the card template is read as before');
    assert.equal(parseTxtDirectory('V=ADTP0;Directory=https://x.test/d'), 'https://x.test/d');
    assert.equal(parseTxtDirectory('v=adtp0; card=https://x.test/{local}'), null, 'a record need not name one');
    assert.equal(parseTxtDirectory('v=spf1; directory=https://x.test/d'), null, 'another protocol\'s record is not ours');
    assert.equal(directoryUrl('acme.test'), 'https://acme.test/.well-known/adtp');
  });

  it('uses the TXT record when it names a directory', async () => {
    const { http, calls } = stubHttp({ 'https://adtp.acme.test/.well-known/adtp': { body: JSON.stringify(acme) } });
    const asked: string[] = [];
    const discovery = new Discovery({
      http,
      resolveTxt: async (name) => {
        asked.push(name);
        return [['v=spf1 -all'], [RECORD.slice(0, 40), RECORD.slice(40)]]; // the record arrives in two chunks
      },
    });
    const found = await discovery.directory('Acme.test');
    assert.deepEqual(found.entries, acme.entries);
    assert.deepEqual(found.resolved, { method: 'dns', url: 'https://adtp.acme.test/.well-known/adtp', dns_record: { name: '_adtp.acme.test', value: RECORD } });
    assert.deepEqual(asked, ['_adtp.acme.test']);
    assert.deepEqual(calls, ['https://adtp.acme.test/.well-known/adtp'], 'the fallback is not asked when DNS works');
  });

  it('falls back to the well-known URL on the domain, following a redirect to the node', async () => {
    const { http, calls } = stubHttp({
      'https://acme.test/.well-known/adtp': { status: 302, location: 'https://adtp.acme.test/.well-known/adtp' },
      'https://adtp.acme.test/.well-known/adtp': { body: JSON.stringify(acme) },
    });
    for (const resolveTxt of [noTxt, async () => [['v=adtp0; card=https://adtp.acme.test/c/{local}']]]) {
      const found = await new Discovery({ http, resolveTxt }).directory('acme.test');
      assert.deepEqual(found.resolved, { method: 'well-known', url: 'https://adtp.acme.test/.well-known/adtp' });
      assert.equal(found.entries.length, 2);
    }
    assert.equal(calls.filter((c) => c === 'https://acme.test/.well-known/adtp').length, 2);
  });

  it('tries the well-known URL when the one in DNS does not answer', async () => {
    const { http } = stubHttp({ 'https://acme.test/.well-known/adtp': { body: JSON.stringify(acme) } });
    const found = await new Discovery({ http, resolveTxt: async () => [[RECORD]] }).directory('acme.test');
    assert.equal(found.resolved?.method, 'well-known');
  });

  it('works out the directory of a domain with a discovery override', async () => {
    const { http, calls } = stubHttp({ 'http://acme-node:7387/.well-known/adtp': { body: JSON.stringify(acme) } });
    const discovery = new Discovery({ http, resolveTxt: noTxt, overrides: { 'acme.test': 'http://acme-node:7387/.well-known/adtp/{local}', 'odd.test': 'http://odd-node/cards?who={local}' } });
    assert.deepEqual((await discovery.directory('acme.test')).resolved, { method: 'override', url: 'http://acme-node:7387/.well-known/adtp' });
    assert.deepEqual(calls, ['http://acme-node:7387/.well-known/adtp']);
    await assert.rejects(discovery.directory('odd.test'), /does not end in \/\{local\}/);

    // {domain} in an override is filled in for the directory as it is for cards.
    const shared = stubHttp({ 'https://node.test/acme.test/.well-known/adtp': { body: JSON.stringify(acme) } });
    const hosted = new Discovery({ http: shared.http, resolveTxt: noTxt, overrides: { 'acme.test': 'https://node.test/{domain}/.well-known/adtp/{local}' } });
    assert.deepEqual((await hosted.directory('acme.test')).resolved, { method: 'override', url: 'https://node.test/acme.test/.well-known/adtp' });
  });

  it('refuses a directory that speaks for another domain, and says where it looked', async () => {
    const { http } = stubHttp({
      'https://acme.test/.well-known/adtp': { body: JSON.stringify({ ...acme, domain: 'other.test' }) },
      'https://broken.test/.well-known/adtp': { body: '<html>not json</html>' },
      'https://gone.test/.well-known/adtp': { status: 404 },
    });
    const discovery = new Discovery({ http, resolveTxt: noTxt });
    await assert.rejects(discovery.directory('acme.test'), (err: Error) => err instanceof DiscoveryError && /is for other\.test, not acme\.test/.test(err.message));
    await assert.rejects(discovery.directory('broken.test'), /could not find a directory for broken\.test \(https:\/\/broken\.test\/\.well-known\/adtp: /);
    await assert.rejects(discovery.directory('gone.test'), /HTTP 404/);
    await assert.rejects(discovery.directory('nowhere.test'), /connection refused/);
  });

  it('keeps a directory for a while, and a failure for a shorter while', async () => {
    let now = 1_000_000;
    const responses: Record<string, { status?: number; body?: string }> = { 'https://acme.test/.well-known/adtp': { body: JSON.stringify(acme) } };
    const { http, calls } = stubHttp(responses);
    const discovery = new Discovery({ http, resolveTxt: noTxt, now: () => now, cacheTtlMs: 300_000 });

    await discovery.directory('acme.test');
    await discovery.directory('acme.test');
    assert.equal(calls.length, 1, 'the second lookup is answered from memory');
    now += 300_001;
    await discovery.directory('acme.test');
    assert.equal(calls.length, 2, 'and fetched again once it is old');

    await assert.rejects(discovery.directory('later.test'), /connection refused/);
    responses['https://later.test/.well-known/adtp'] = { body: JSON.stringify({ adtp: '0', domain: 'later.test', entries: [] }) };
    await assert.rejects(discovery.directory('later.test'), /connection refused/, 'a failure is remembered for half a minute');
    now += 30_001;
    assert.deepEqual((await discovery.directory('later.test')).entries, []);
  });
});

describe('directory: configuration', () => {
  const config = (address: Record<string, unknown>) =>
    parseConfig({ domain: 'acme.test', public_url: 'https://adtp.acme.test', addresses: [{ local: 'ap', type: 'agent', routes: [{ default: true, channel: 'agent' }], ...address }] }, {}, '/tmp');

  it('lists nothing unless an address asks for it', () => {
    assert.equal(config({}).addresses[0]!.listed, false);
    assert.equal(config({ description: 'Accounts payable.' }).addresses[0]!.listed, false, 'a description alone does not list an address');
    const listed = config({ listed: true, description: 'Accounts payable.' }).addresses[0]!;
    assert.equal(listed.listed, true);
    assert.equal(listed.description, 'Accounts payable.');
  });

  it('wants a description for a listed address, of a length a directory can carry', () => {
    assert.throws(() => config({ listed: true }), (err: Error) => err instanceof ConfigError && /addresses\[0\]\.listed needs a description: one line saying what ap@acme\.test is for/.test(err.message));
    assert.throws(() => config({ listed: true, description: ' \n ' }), /listed needs a description/);
    assert.throws(() => config({ listed: true, description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }), /may be at most 500 characters/);
    assert.throws(() => config({ listed: 'yes', description: 'Accounts payable.' }), /listed must be true or false/);
    assert.doesNotThrow(() => config({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }), 'the limit is the directory\'s, so it applies only to listed addresses');
  });

  it('puts the directory in the DNS record a node tells its operator to publish', () => {
    const record = dnsTxtRecord({ domain: 'acme.test', public_url: 'https://adtp.acme.test' });
    assert.deepEqual(record, { name: '_adtp.acme.test', value: RECORD });
    assert.equal(parseTxtDirectory(record.value), 'https://adtp.acme.test/.well-known/adtp');
  });
});

interface Side {
  url: string;
  node: AdtpNode;
  server: Server;
  db: TestDb;
}

describe('directory: two nodes', { skip }, () => {
  let acmeSide: Side;
  let shop: Side;
  const fetched: string[] = [];

  async function startSide(domain: string, publicUrl: string, port: number, addresses: unknown[], http: HttpClient, resolveTxt: (name: string) => Promise<string[][]>): Promise<Side> {
    const db = await createTestDb();
    const config = parseConfig({ domain, public_url: publicUrl, listen: { host: '127.0.0.1', port }, addresses }, {}, '/tmp');
    const node = await AdtpNode.create({ config, db: db.conn, keys: new TestKeys(), http, resolveTxt });
    const server = createApp({ node, adminToken: 'admin-token', agentToken: 'agent-token', log: silentLogger });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${port}`, node, server, db };
  }

  before(async () => {
    const [acmePort, shopPort] = [await freePort(), await freePort()];
    const hosts: Record<string, number> = { 'adtp.acme.test': acmePort, 'node.shop.test': shopPort };
    // Stands in for public DNS + TLS: https://<host>/... is served by the node behind that host.
    const internet: HttpClient = async (url, options) => {
      const target = new URL(url);
      fetched.push(`${options?.method ?? 'GET'} ${url}`);
      if (target.protocol !== 'https:') throw new Error(`refusing plain http URL ${target.origin}`);
      // shop.test's website does not run the node; it redirects the well-known paths to it.
      if (target.host === 'shop.test') return { status: 302, headers: { location: `https://node.shop.test${target.pathname}` }, body: '' };
      const port = hosts[target.host];
      if (!port) throw new Error(`getaddrinfo ENOTFOUND ${target.host}`);
      return httpRequest(`http://127.0.0.1:${port}${target.pathname}${target.search}`, { ...options, allowInsecure: true });
    };
    // Only acme.test publishes an _adtp record.
    const resolveTxt = async (name: string): Promise<string[][]> => {
      if (name === '_adtp.acme.test') return [[RECORD]];
      throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    };
    const agent = { type: 'agent', routes: [{ default: true, channel: 'agent' }] };
    acmeSide = await startSide(
      'acme.test',
      'https://adtp.acme.test',
      acmePort,
      [
        { local: 'ap', ...agent, listed: true, description: 'Accounts payable. Send invoices and payment questions here.' },
        { local: 'hello', type: 'human', listed: true, description: 'General enquiries.' },
        { local: 'ceo', type: 'human', description: 'Not listed: only people who know this address can write to it.' },
      ],
      internet,
      resolveTxt,
    );
    shop = await startSide('shop.test', 'https://node.shop.test', shopPort, [{ local: 'buyer', ...agent }], internet, resolveTxt);
  });

  after(async () => {
    for (const side of [acmeSide, shop]) {
      if (!side) continue;
      side.server.closeAllConnections();
      await new Promise((resolve) => side.server.close(resolve));
      await side.node.close();
      await side.db.drop();
    }
  });

  it('serves the listed addresses, and only those, to anyone who asks', async () => {
    const res = await fetch(`${acmeSide.url}/.well-known/adtp`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.deepEqual(await res.json(), { ...acme, entries: acme.entries });

    // The unlisted address is not in the directory, and works as before for whoever knows it.
    const card = await fetch(`${acmeSide.url}/.well-known/adtp/ceo`);
    assert.equal(card.status, 200);
    assert.equal(((await card.json()) as { address: string }).address, 'ceo@acme.test');
    assert.equal((await fetch(`${acmeSide.url}/.well-known/adtp/ap`)).status, 200, 'cards are still served next to it');
  });

  it('serves an empty directory when nothing is listed', async () => {
    const res = await fetch(`${shop.url}/.well-known/adtp`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { adtp: '0', domain: 'shop.test', entries: [] });
  });

  it('looks up another domain through its TXT record', async () => {
    const found = await shop.node.directory('acme.test');
    assert.deepEqual(found.entries, acme.entries);
    assert.deepEqual(found.resolved, { method: 'dns', url: 'https://adtp.acme.test/.well-known/adtp', dns_record: { name: '_adtp.acme.test', value: RECORD } });
    assert.ok(!fetched.some((f) => f.includes('https://acme.test/')), 'the fallback is not used when the TXT record works');
  });

  it('looks up a domain without a TXT record through its well-known URL', async () => {
    const found = await acmeSide.node.directory('shop.test');
    assert.deepEqual(found, { domain: 'shop.test', entries: [], resolved: { method: 'well-known', url: 'https://node.shop.test/.well-known/adtp' } });
    assert.ok(fetched.includes('GET https://shop.test/.well-known/adtp'), 'asked the domain first');
  });

  it('answers for its own domain from its settings, or the way others see it', async () => {
    assert.deepEqual(await acmeSide.node.directory('ACME.test'), { domain: 'acme.test', entries: acme.entries, resolved: { method: 'local' } });
    const asOthersSeeIt = await acmeSide.node.directory('acme.test', { external: true });
    assert.equal(asOthersSeeIt.resolved?.method, 'dns');
    assert.deepEqual(asOthersSeeIt.entries, acme.entries);
    await assert.rejects(acmeSide.node.directory('not a domain'), /looked up by domain/);
  });

  it('gives an agent the lookup over the local API, with the agent token', async () => {
    const agent = new AdtpClient({ baseUrl: shop.url, token: 'agent-token' });
    const found = await agent.directory('acme.test');
    assert.deepEqual(found.entries, acme.entries);
    assert.equal((await agent.directory('shop.test')).resolved?.method, 'local');
    assert.equal((await agent.directory('shop.test', { external: true })).resolved?.method, 'well-known');

    const refused = async (path: string, token: string | null) => {
      const res = await fetch(`${shop.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    assert.equal((await refused('/api/v0/directory?domain=acme.test', null)).status, 401);
    assert.equal((await refused('/api/v0/directory?domain=acme.test', 'wrong')).status, 401);
    assert.equal((await refused('/api/v0/directory', 'agent-token')).status, 400);
    assert.deepEqual(await refused('/api/v0/directory?domain=not%20a%20domain', 'agent-token'), { status: 400, error: 'invalid_domain' });
    assert.deepEqual(await refused('/api/v0/directory?domain=nowhere.test', 'agent-token'), { status: 502, error: 'unresolvable' });
    await assert.rejects(agent.directory('nowhere.test'), (err: Error) => err instanceof AdtpClientError && err.code === 'unresolvable');
  });

  it('gives a model the lookup as a tool', async () => {
    const tool = createAdtpTool({ nodeUrl: shop.url, token: 'agent-token', address: 'buyer@shop.test' });
    assert.deepEqual(tool.tools.map((t) => t.name), ['adtp_send', 'adtp_directory']);
    assert.deepEqual(await tool.adtp_directory('acme.test'), { domain: 'acme.test', entries: acme.entries });
    assert.deepEqual(await tool.call('adtp_directory', { domain: 'acme.test' }), { domain: 'acme.test', entries: acme.entries });
    await tool.stop();
  });

  it('does not open a listed address to strangers: a first message still waits for approval', async () => {
    const sent = await shop.node.submit({ from: 'buyer@shop.test', to: ['ap@acme.test'], intent: 'request', text: 'Where do I send an invoice?' });
    await shop.node.worker.drain();
    const held = await acmeSide.node.tray();
    assert.deepEqual(held.map((item) => [item.message.id, item.message.from_addr, item.delivery.recipient]), [[sent.id, 'buyer@shop.test', 'ap@acme.test']]);
    assert.equal((await shop.node.store.findDeliveries('out', sent.id, 'ap@acme.test'))[0]?.state, 'sent', 'accepted by the other node, and held there');
  });
});
