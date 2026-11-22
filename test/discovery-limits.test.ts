/**
 * The bounds on discovery. Anyone can make a node look a card up, because it
 * must before it can check a signature, so the work that takes is limited:
 * one lookup per address at a time, a cap on lookups in progress, and caches
 * that do not grow without end.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Discovery, DiscoveryBusyError, DiscoveryError } from '../src/identity/discovery.js';
import type { HttpClient } from '../src/identity/safe-http.js';
import { buildCard } from '../src/protocol/cards.js';
import { TestKeys } from './helpers.js';

const keys = new TestKeys();
const cardFor = (address: string): string => JSON.stringify(buildCard({ address, type: 'agent' }, 'https://node.test/adtp/v0/messages', keys.publicKeys()));
const noTxt = async (): Promise<string[][]> => {
  throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
};
const addressOf = (url: string): string => {
  const { hostname, pathname } = new URL(url);
  return `${decodeURIComponent(pathname.split('/').pop()!)}@${hostname}`;
};

/** A web where every well-known card exists, but answers only when the test says so. */
function gatedWeb() {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  const http: HttpClient = async (url) => {
    calls.push(url);
    await new Promise<void>((open) => gates.push(open));
    return { status: 200, headers: {}, body: cardFor(addressOf(url)) };
  };
  const open = () => gates.splice(0).forEach((g) => g());
  return { http, calls, open, held: () => gates.length };
}
/** The same web without the wait; hosts under down.test do not answer. */
function openWeb() {
  const calls: string[] = [];
  const http: HttpClient = async (url) => {
    calls.push(url);
    if (new URL(url).hostname.endsWith('down.test')) throw new Error('connect ECONNREFUSED');
    return { status: 200, headers: {}, body: cardFor(addressOf(url)) };
  };
  return { http, calls };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('discovery: bounded work', () => {
  it('makes one lookup for an address however many ask at once', async () => {
    const web = gatedWeb();
    const discovery = new Discovery({ http: web.http, resolveTxt: noTxt });
    const asks = Array.from({ length: 20 }, (_, i) => discovery.resolve('alice@a.test', { fresh: i % 2 === 0 }));
    await tick();
    assert.equal(web.calls.length, 1);
    web.open();
    const cards = await Promise.all(asks);
    assert.ok(cards.every((card) => card.address === 'alice@a.test'));
    assert.equal(web.calls.length, 1);

    // The same for a directory, and for a lookup that fails.
    const down = new Discovery({ http: openWeb().http, resolveTxt: noTxt });
    const failed = await Promise.allSettled(Array.from({ length: 5 }, () => down.resolve('bob@down.test')));
    assert.ok(failed.every((r) => r.status === 'rejected' && r.reason instanceof DiscoveryError));
  });

  it('keeps a limited number of lookups in progress, lets a few wait, and turns the rest away without blaming the address', async () => {
    const web = gatedWeb();
    const discovery = new Discovery({ http: web.http, resolveTxt: noTxt, maxConcurrent: 2, maxWaiting: 1 });
    const first = [1, 2, 3].map((n) => discovery.resolve(`sender${n}@s${n}.test`));
    await tick();
    assert.deepEqual(discovery.stats(), { cards: 0, directories: 0, active: 2, waiting: 1 });
    assert.equal(web.calls.length, 2, 'the third waits its turn');

    await assert.rejects(discovery.resolve('sender4@s4.test'), (err) => err instanceof DiscoveryBusyError && /too many lookups/.test(err.message));
    await assert.rejects(discovery.directory('s5.test'), DiscoveryBusyError);
    assert.equal(web.calls.length, 2, 'a lookup that was turned away asked nobody');

    web.open();
    await tick();
    await tick();
    assert.equal(web.calls.length, 3, 'the waiting lookup took the place that came free');
    web.open();
    assert.deepEqual((await Promise.all(first)).map((card) => card.address), ['sender1@s1.test', 'sender2@s2.test', 'sender3@s3.test']);
    assert.deepEqual(discovery.stats(), { cards: 3, directories: 0, active: 0, waiting: 0 });

    // Being turned away was not remembered as a failure: the address resolves as soon as there is room.
    const again = discovery.resolve('sender4@s4.test');
    await tick();
    web.open();
    assert.equal((await again).address, 'sender4@s4.test');
  });

  it('frees its place when a lookup fails', async () => {
    const discovery = new Discovery({ http: openWeb().http, resolveTxt: noTxt, maxConcurrent: 1, maxWaiting: 0 });
    await assert.rejects(discovery.resolve('bob@down.test'), DiscoveryError);
    assert.equal(discovery.stats().active, 0);
    assert.equal((await discovery.resolve('alice@a.test')).address, 'alice@a.test');
  });

  it('remembers a limited number of cards, dropping the oldest', async () => {
    const web = openWeb();
    const discovery = new Discovery({ http: web.http, resolveTxt: noTxt, maxCacheEntries: 3 });
    for (let n = 1; n <= 10; n++) await discovery.resolve(`sender${n}@s${n}.test`);
    for (let n = 1; n <= 10; n++) await assert.rejects(discovery.resolve(`sender${n}@n${n}.down.test`));
    assert.equal(discovery.stats().cards, 3);

    // The newest are still there; an old one is simply fetched again.
    web.calls.length = 0;
    await assert.rejects(discovery.resolve('sender10@n10.down.test'));
    assert.deepEqual(web.calls, [], 'the newest failure is still remembered');
    assert.equal((await discovery.resolve('sender1@s1.test')).address, 'sender1@s1.test');
    assert.deepEqual(web.calls, ['https://s1.test/.well-known/adtp/sender1']);
    assert.equal(discovery.stats().cards, 3);
  });

  it('clears out entries that have expired', async () => {
    let now = 1_000_000;
    const web = openWeb();
    const discovery = new Discovery({ http: web.http, resolveTxt: noTxt, now: () => now, cacheTtlMs: 300_000 });
    for (let n = 1; n <= 50; n++) await discovery.resolve(`sender${n}@s${n}.test`);
    for (let n = 1; n <= 50; n++) await assert.rejects(discovery.resolve(`sender${n}@n${n}.down.test`));
    for (let n = 1; n <= 5; n++) await assert.rejects(discovery.directory(`n${n}.down.test`));
    assert.deepEqual(discovery.stats(), { cards: 100, directories: 5, active: 0, waiting: 0 });

    // Two minutes on, the failures (remembered for 30 seconds) have expired; the cards have not.
    now += 120_000;
    await discovery.resolve('later@l1.test');
    assert.deepEqual(discovery.stats(), { cards: 51, directories: 0, active: 0, waiting: 0 });

    // Ten minutes on, everything but the newest lookup has.
    now += 600_000;
    await discovery.resolve('later@l2.test');
    assert.equal(discovery.stats().cards, 1);
  });

  it('still fetches a card again when asked for a fresh copy, at most once a minute', async () => {
    let now = 1_000_000;
    const web = openWeb();
    const discovery = new Discovery({ http: web.http, resolveTxt: noTxt, now: () => now });
    await discovery.resolve('alice@a.test');
    assert.equal((await discovery.resolve('alice@a.test', { fresh: true })).resolved?.retry_after, 60);
    assert.equal(web.calls.length, 1);
    now += 61_000;
    assert.equal((await discovery.resolve('alice@a.test', { fresh: true })).resolved?.retry_after, undefined);
    assert.equal(web.calls.length, 2);
  });
});
