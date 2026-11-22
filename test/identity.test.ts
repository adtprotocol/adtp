import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Discovery, expandTemplate, parseTxtRecord, wellKnownUrl } from '../src/identity/discovery.js';
import { Keyring } from '../src/identity/keyring.js';
import { httpRequest, isPrivateAddress, type HttpClient } from '../src/identity/safe-http.js';
import { buildCard } from '../src/protocol/cards.js';
import { generateKeyPair, kidFor, verifyBytes } from '../src/protocol/signing.js';
import { TestKeys } from './helpers.js';

const keys = new TestKeys();
const humanCard = (address: string) => JSON.stringify(buildCard({ address, type: 'human' }, 'https://node.b.test/adtp/v0/messages', keys.publicKeys()));

/** An HTTP stub that serves canned bodies by URL and records what was asked. */
function stubHttp(responses: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const http: HttpClient = async (url) => {
    calls.push(url);
    const hit = responses[url];
    if (!hit) throw new Error('connection refused');
    return { status: hit.status ?? 200, headers: {}, body: hit.body };
  };
  return { http, calls };
}

const noTxt = async (): Promise<string[][]> => {
  throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
};

describe('discovery: DNS TXT records', () => {
  it('parses v=adtp0; card=<template>', () => {
    assert.equal(parseTxtRecord('v=adtp0; card=https://adtp.b.test/.well-known/adtp/{local}'), 'https://adtp.b.test/.well-known/adtp/{local}');
    assert.equal(parseTxtRecord('V=ADTP0;card=https://x.test/c?u={local}&k=v'), 'https://x.test/c?u={local}&k=v');
  });

  it('ignores records for other protocols or without a card', () => {
    assert.equal(parseTxtRecord('v=spf1 include:_spf.example.com ~all'), null);
    assert.equal(parseTxtRecord('v=adtp1; card=https://x.test/{local}'), null);
    assert.equal(parseTxtRecord('v=adtp0'), null);
  });

  it('expands templates and builds the well-known fallback', () => {
    assert.equal(expandTemplate('https://x.test/{domain}/{local}.json', 'bob+a@b.test'), 'https://x.test/b.test/bob%2Ba.json');
    assert.equal(wellKnownUrl('bob@b.test'), 'https://b.test/.well-known/adtp/bob');
  });
});

describe('discovery: resolution order', () => {
  it('uses the TXT record when there is one', async () => {
    const { http, calls } = stubHttp({ 'https://adtp.b.test/cards/bob': { body: humanCard('bob@b.test') } });
    const asked: string[] = [];
    const discovery = new Discovery({
      http,
      resolveTxt: async (name) => {
        asked.push(name);
        return [['v=spf1 -all'], ['v=adtp0; card=https://adtp.b.test', '/cards/{local}']]; // second record arrives in two chunks
      },
    });
    const card = await discovery.resolve('Bob@B.test');
    assert.equal(card.address, 'bob@b.test');
    assert.equal(card.endpoint, 'https://node.b.test/adtp/v0/messages');
    assert.deepEqual(asked, ['_adtp.b.test']);
    assert.deepEqual(calls, ['https://adtp.b.test/cards/bob']);
  });

  it('falls back to https://{domain}/.well-known/adtp/{local} without a TXT record', async () => {
    const { http, calls } = stubHttp({ 'https://b.test/.well-known/adtp/bob': { body: humanCard('bob@b.test') } });
    const card = await new Discovery({ http, resolveTxt: noTxt }).resolve('bob@b.test');
    assert.equal(card.type, 'human');
    assert.deepEqual(calls, ['https://b.test/.well-known/adtp/bob']);
  });

  it('falls back to the well-known URL when the TXT location does not answer', async () => {
    const { http, calls } = stubHttp({ 'https://b.test/.well-known/adtp/bob': { body: humanCard('bob@b.test') } });
    const discovery = new Discovery({ http, resolveTxt: async () => [['v=adtp0; card=https://down.b.test/{local}']] });
    assert.equal((await discovery.resolve('bob@b.test')).address, 'bob@b.test');
    assert.deepEqual(calls, ['https://down.b.test/bob', 'https://b.test/.well-known/adtp/bob']);
  });

  it('a configured override wins and skips DNS entirely', async () => {
    const { http, calls } = stubHttp({ 'http://bob-node:7387/.well-known/adtp/bob': { body: humanCard('bob@bob.localhost') } });
    const discovery = new Discovery({
      http,
      overrides: { 'bob.localhost': 'http://bob-node:7387/.well-known/adtp/{local}' },
      resolveTxt: async () => assert.fail('DNS must not be consulted for an overridden domain'),
    });
    assert.equal((await discovery.resolve('bob@bob.localhost')).address, 'bob@bob.localhost');
    assert.deepEqual(calls, ['http://bob-node:7387/.well-known/adtp/bob']);
  });

  it('answers hosted addresses locally without any network', async () => {
    const discovery = new Discovery({
      http: async () => assert.fail('no HTTP for local addresses'),
      resolveTxt: noTxt,
      local: (address) => (address === 'me@here.test' ? keys.card('me@here.test') : null),
    });
    assert.equal((await discovery.resolve('me@here.test')).address, 'me@here.test');
  });
});

describe('discovery: redirects and how a card was found', () => {
  const redirect = (location: string, status = 302) => ({ status, body: '', headers: { location } });

  /** Like stubHttp, but responses may carry headers (for redirects). */
  function stubWeb(responses: Record<string, { status?: number; body: string; headers?: Record<string, string> }>) {
    const calls: string[] = [];
    const http: HttpClient = async (url) => {
      calls.push(url);
      const hit = responses[url];
      if (!hit) throw new Error('connection refused');
      return { status: hit.status ?? 200, headers: hit.headers ?? {}, body: hit.body };
    };
    return { http, calls };
  }

  it('follows a redirect from the well-known location to the node', async () => {
    const { http, calls } = stubWeb({
      'https://b.test/.well-known/adtp/bob': redirect('https://adtp.b.test/.well-known/adtp/bob', 301),
      'https://adtp.b.test/.well-known/adtp/bob': { body: humanCard('bob@b.test') },
    });
    const card = await new Discovery({ http, resolveTxt: noTxt }).resolve('bob@b.test');
    assert.equal(card.address, 'bob@b.test');
    assert.deepEqual(card.resolved, { method: 'well-known', card_url: 'https://adtp.b.test/.well-known/adtp/bob' }, 'reports where the card was finally served from');
    assert.deepEqual(calls, ['https://b.test/.well-known/adtp/bob', 'https://adtp.b.test/.well-known/adtp/bob']);
  });

  it('resolves relative redirects and gives up after a few hops', async () => {
    const relative = stubWeb({
      'https://b.test/.well-known/adtp/bob': redirect('/cards/bob.json', 307),
      'https://b.test/cards/bob.json': { body: humanCard('bob@b.test') },
    });
    assert.equal((await new Discovery({ http: relative.http, resolveTxt: noTxt }).resolve('bob@b.test')).resolved?.card_url, 'https://b.test/cards/bob.json');

    const loop = stubWeb({ 'https://b.test/.well-known/adtp/bob': redirect('https://b.test/.well-known/adtp/bob') });
    await assert.rejects(new Discovery({ http: loop.http, resolveTxt: noTxt }).resolve('bob@b.test'), /more than 3 redirects/);
    assert.equal(loop.calls.length, 4);

    const nowhere = stubWeb({ 'https://b.test/.well-known/adtp/bob': { status: 302, body: '' } });
    await assert.rejects(new Discovery({ http: nowhere.http, resolveTxt: noTxt }).resolve('bob@b.test'), /without a Location header/);
  });

  it('records the DNS record or override that led to the card', async () => {
    const viaDns = stubWeb({ 'https://adtp.b.test/c/bob': { body: humanCard('bob@b.test') } });
    const dns = await new Discovery({ http: viaDns.http, resolveTxt: async () => [['v=adtp0; card=https://adtp.b.test/c/{local}']] }).resolve('bob@b.test');
    assert.deepEqual(dns.resolved, {
      method: 'dns',
      card_url: 'https://adtp.b.test/c/bob',
      dns_record: { name: '_adtp.b.test', value: 'v=adtp0; card=https://adtp.b.test/c/{local}' },
    });

    const viaOverride = stubWeb({ 'http://bob-node:7387/.well-known/adtp/bob': { body: humanCard('bob@bob.localhost') } });
    const override = await new Discovery({ http: viaOverride.http, overrides: { 'bob.localhost': 'http://bob-node:7387/.well-known/adtp/{local}' } }).resolve('bob@bob.localhost');
    assert.deepEqual(override.resolved, { method: 'override', card_url: 'http://bob-node:7387/.well-known/adtp/bob' });
  });

  it('lists candidates in order: TXT location first, then the well-known URL', async () => {
    const discovery = new Discovery({ resolveTxt: async () => [['v=adtp0; card=https://adtp.b.test/c/{local}']] });
    assert.deepEqual((await discovery.candidates('bob@b.test')).map((c) => [c.method, c.url]), [
      ['dns', 'https://adtp.b.test/c/bob'],
      ['well-known', 'https://b.test/.well-known/adtp/bob'],
    ]);
    // A TXT record that simply points at the well-known URL does not produce a duplicate.
    const same = new Discovery({ resolveTxt: async () => [['v=adtp0; card=https://b.test/.well-known/adtp/{local}']] });
    assert.deepEqual((await same.candidates('bob@b.test')).map((c) => c.method), ['dns']);
  });
});

describe('discovery: safety', () => {
  it('rejects a card that is for a different address', async () => {
    const { http } = stubHttp({ 'https://b.test/.well-known/adtp/bob': { body: humanCard('mallory@b.test') } });
    await assert.rejects(new Discovery({ http, resolveTxt: noTxt }).resolve('bob@b.test'), /card is for mallory@b\.test/);
  });

  it('rejects non-200 answers, non-JSON bodies and invalid addresses', async () => {
    const { http } = stubHttp({
      'https://b.test/.well-known/adtp/gone': { status: 404, body: '{}' },
      'https://b.test/.well-known/adtp/html': { body: '<html>' },
    });
    const discovery = new Discovery({ http, resolveTxt: noTxt });
    await assert.rejects(discovery.resolve('gone@b.test'), /HTTP 404/);
    await assert.rejects(discovery.resolve('html@b.test'), /could not resolve/);
    await assert.rejects(discovery.resolve('not-an-address'), /not a valid address/);
  });

  it('caches cards and failures, and limits forced refreshes', async () => {
    let clock = 1_000_000;
    const { http, calls } = stubHttp({ 'https://b.test/.well-known/adtp/bob': { body: humanCard('bob@b.test') } });
    const discovery = new Discovery({ http, resolveTxt: noTxt, cacheTtlMs: 300_000, now: () => clock });

    await discovery.resolve('bob@b.test');
    await discovery.resolve('bob@b.test');
    assert.equal(calls.length, 1, 'second lookup is served from cache');

    // A forced refresh right after a fetch is not made, and the caller is told so: the card
    // it gets back is the cached one, marked with how long until a fresh look is allowed.
    clock += 15_000;
    const tooSoon = await discovery.resolve('bob@b.test', { fresh: true });
    assert.equal(calls.length, 1, 'a forced refresh right after a fetch is ignored');
    assert.equal(tooSoon.resolved?.retry_after, 45, 'the card was fetched 15 seconds ago; another look is allowed in 45');
    assert.equal(tooSoon.address, 'bob@b.test');
    assert.equal((await discovery.resolve('bob@b.test')).resolved?.retry_after, undefined, 'an ordinary lookup of the cached card carries no such mark');

    clock += 46_000;
    const refetched = await discovery.resolve('bob@b.test', { fresh: true });
    assert.equal(calls.length, 2, 'a forced refresh a minute later re-fetches');
    assert.equal(refetched.resolved?.retry_after, undefined, 'and that copy is fresh');

    clock += 300_001;
    await discovery.resolve('bob@b.test');
    assert.equal(calls.length, 3, 'expired entries are re-fetched');

    await assert.rejects(discovery.resolve('nobody@b.test'));
    const before = calls.length;
    await assert.rejects(discovery.resolve('nobody@b.test'));
    assert.equal(calls.length, before, 'failures are cached briefly');
  });

  it('classifies private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it('refuses plain http, private targets and odd schemes unless explicitly allowed', async () => {
    await assert.rejects(httpRequest('http://example.com/card'), /refusing plain http/);
    await assert.rejects(httpRequest('https://127.0.0.1/card'), /private address/);
    await assert.rejects(httpRequest('https://[::1]/card'), /private address/);
    await assert.rejects(httpRequest('https://localhost/card'), /private address/);
    await assert.rejects(httpRequest('file:///etc/passwd'), /unsupported URL scheme/);
    await assert.rejects(httpRequest('https://user:pw@example.com/'), /credentials/);
  });
});

describe('keyring', () => {
  const withDir = (fn: (file: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adtp-keys-'));
    try {
      fn(path.join(dir, 'keys', 'keyring.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('generates a key on first run, stores it privately, and reuses it afterwards', () =>
    withDir((file) => {
      const first = Keyring.load({ path: file, graceDays: 30 });
      assert.equal(first.created, true);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);

      const published = first.keyring.publicKeys();
      assert.equal(published.length, 1);
      assert.equal(published[0]!.kid, first.keyring.kid);
      assert.equal(published[0]!.not_after, undefined);
      assert.ok(!JSON.stringify(published).includes('private'), 'published keys never include private material');

      const data = Buffer.from('hello');
      assert.ok(verifyBytes(published[0]!.public_key, data, first.keyring.sign(data).signature));

      const second = Keyring.load({ path: file, graceDays: 30 });
      assert.equal(second.created, false);
      assert.equal(second.keyring.kid, first.keyring.kid);
    }));

  it('rotation: new key signs, old key keeps verifying for the grace period only', () =>
    withDir((file) => {
      let now = new Date('2026-06-01T00:00:00Z');
      const { keyring } = Keyring.load({ path: file, graceDays: 7, now: () => now });
      const oldKid = keyring.kid;
      const data = Buffer.from('signed before rotation');
      const oldSignature = keyring.sign(data).signature;

      const result = keyring.rotate();
      assert.notEqual(result.kid, oldKid);
      assert.equal(result.previous, oldKid);
      assert.equal(result.previousValidUntil, '2026-06-08T00:00:00.000Z');
      assert.equal(keyring.kid, result.kid);

      const published = keyring.publicKeys();
      assert.deepEqual(published.map((k) => k.kid), [result.kid, oldKid], 'active key first, rotated-out key still published');
      assert.equal(published[1]!.not_after, '2026-06-08T00:00:00.000Z');
      assert.ok(verifyBytes(published[1]!.public_key, data, oldSignature), 'old signatures verify during the grace period');
      assert.ok(verifyBytes(published[0]!.public_key, data, keyring.sign(data).signature));

      const stored = JSON.parse(readFileSync(file, 'utf8')) as { keys: { kid: string; private_key?: string }[] };
      assert.equal(stored.keys.find((k) => k.kid === oldKid)!.private_key, undefined, 'the rotated-out private key is destroyed');

      now = new Date('2026-06-09T00:00:00Z');
      assert.deepEqual(keyring.publicKeys().map((k) => k.kid), [result.kid], 'after the grace period the old key is no longer published');

      const reloaded = Keyring.load({ path: file, graceDays: 7, now: () => now });
      assert.equal(reloaded.keyring.kid, result.kid);
    }));

  it('takes the active key from the environment and retires the previous one', () =>
    withDir((file) => {
      const fromFile = Keyring.load({ path: file, graceDays: 30 });
      const fileKid = fromFile.keyring.kid;

      const envKey = generateKeyPair();
      const loaded = Keyring.load({ path: file, graceDays: 30, envPrivateKey: envKey.privateKey });
      assert.equal(loaded.rotatedFromEnv, true);
      assert.equal(loaded.keyring.kid, kidFor(envKey.publicKey));
      assert.deepEqual(loaded.keyring.publicKeys().map((k) => k.kid), [kidFor(envKey.publicKey), fileKid]);
      assert.ok(!readFileSync(file, 'utf8').includes(envKey.privateKey), 'an environment key is never written to disk');
      assert.throws(() => loaded.keyring.rotate(), /ADTP_PRIVATE_KEY/);

      const again = Keyring.load({ path: file, graceDays: 30, envPrivateKey: envKey.privateKey });
      assert.equal(again.rotatedFromEnv, false);
    }));
});
