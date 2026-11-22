/**
 * The four seams a wrapper replaces (ARCHITECTURE.md, "Seams"), exercised
 * through the package's public entry point: keys, storage, which addresses
 * are served, and who a token belongs to. Nothing here adds tenancy to the
 * node; it only shows the node asks through the interfaces and nowhere else.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  AdapterRegistry,
  AdtpNode,
  ConfigDomainResolver,
  createApp,
  SqlStore,
  verifySignature,
  type AddressConfig,
  type DomainResolver,
  type KeyStore,
  type Role,
  type Signer,
  type Store,
  type TokenVerifier,
} from '../src/index.js';
import { silentLogger } from '../src/log.js';
import { Clock, createTestDb, dbAvailable, FakeAdapter, freePort, signedEnvelope, StaticResolver, testConfig, TestKeys, type TestDb } from './helpers.js';

const skip = (await dbAvailable()) ? false : 'the test database is not reachable';

/** A key per address, where the default store has one key for everything. */
class PerAddressKeys implements KeyStore {
  readonly keys = new Map<string, TestKeys>();
  private of(address: string): TestKeys {
    let keys = this.keys.get(address);
    if (!keys) this.keys.set(address, (keys = new TestKeys()));
    return keys;
  }
  signer(address: string): Signer {
    return this.of(address);
  }
  publicKeys(address: string) {
    return this.of(address).publicKeys();
  }
  rotate(): never {
    throw new Error('not needed here');
  }
}

/** Serves two domains from one node, which the config file cannot express. */
class TwoDomains implements DomainResolver {
  private readonly first: ConfigDomainResolver;
  private readonly second: ConfigDomainResolver;
  constructor(addresses: AddressConfig[]) {
    const moved = addresses.map((a) => ({ ...a, address: `${a.local}@second.test` }));
    this.first = new ConfigDomainResolver('b.test', addresses);
    this.second = new ConfigDomainResolver('second.test', moved);
  }
  lookup(address: string) {
    return this.first.lookup(address) ?? this.second.lookup(address);
  }
  serves(domain: string) {
    return this.first.serves(domain) || this.second.serves(domain);
  }
  list() {
    return [...this.first.list(), ...this.second.list()];
  }
}

describe('seams', { skip }, () => {
  let db: TestDb;
  let node: AdtpNode;
  let server: Server | undefined;
  const clock = new Clock();
  const alice = new TestKeys();
  const resolver = new StaticResolver().add(alice.card('alice@a.test'));
  const adapters = () => {
    const registry = new AdapterRegistry();
    registry.set(new FakeAdapter('email'));
    return registry;
  };

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
    await node?.close();
    await db.drop();
  });

  it('KeyStore: each address can have its own key, in its card, on its envelopes and on its receipts', async () => {
    const keys = new PerAddressKeys();
    node = await AdtpNode.create({ config: testConfig('b.test'), db: db.conn, keys, resolver, adapters: adapters(), now: clock.now });

    const bobKid = keys.keys.get('bob@b.test')?.kid ?? node.card('bob@b.test')!.keys[0]!.kid;
    assert.equal(node.card('bob@b.test')!.keys[0]!.kid, bobKid);
    assert.notEqual(node.card('helper@b.test')!.keys[0]!.kid, bobKid, 'two addresses, two keys');

    const fromBob = await node.preview({ from: 'bob@b.test', to: ['alice@a.test'], intent: 'inform', text: 'signed as bob' });
    assert.equal(fromBob.signature.kid, bobKid);
    assert.ok(verifySignature(fromBob, node.publicKeys('bob@b.test'), clock.now()).ok);
    assert.equal(verifySignature(fromBob, node.publicKeys('helper@b.test'), clock.now()).ok, false);

    // A receipt is signed with the key of the recipient it names in `by`.
    const ack = await node.receive(signedEnvelope({ from: 'alice@a.test', to: ['helper@b.test'], text: 'hello helper' }, alice));
    assert.equal(ack.by, 'helper@b.test');
    assert.ok(verifySignature(ack, node.publicKeys('helper@b.test'), clock.now()).ok);
    assert.equal(verifySignature(ack, node.publicKeys('bob@b.test'), clock.now()).ok, false);
  });

  it('DomainResolver: the node serves whatever addresses the resolver says are its own', async () => {
    const config = testConfig('b.test');
    const domains = new TwoDomains(config.addresses);
    node = await AdtpNode.create({ config, db: db.conn, keys: new TestKeys(), domains, resolver, adapters: adapters(), now: clock.now });

    assert.equal(node.card('bob@second.test')?.address, 'bob@second.test');
    assert.equal(node.card('bob@third.test'), null);

    const ack = await node.receive(signedEnvelope({ from: 'alice@a.test', to: ['bob@second.test'], text: 'to the second domain' }, alice));
    assert.equal(ack.status, 'queued');
    assert.equal(ack.by, 'bob@second.test');
    const elsewhere = await node.receive(signedEnvelope({ from: 'alice@a.test', to: ['bob@third.test'], text: 'not here' }, alice));
    assert.equal(elsewhere.reason?.code, 'unknown_recipient');

    // And it can send from them.
    const sent = await node.submit({ from: 'helper@second.test', to: ['alice@a.test'], intent: 'inform', text: 'from the second domain' });
    assert.equal((await node.status(sent.id))[0]!.from_addr, 'helper@second.test');
  });

  it('Store: the node runs on any object with the store surface, and needs no database of its own', async () => {
    const real = new SqlStore(db.conn);
    const calls = new Set<string>();
    const store = new Proxy(real, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        calls.add(String(property));
        return value.bind(target);
      },
    }) as Store;
    node = await AdtpNode.create({ config: testConfig('b.test'), keys: new TestKeys(), store, resolver, adapters: adapters(), now: clock.now });

    const env = signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], text: 'through the seam' }, alice);
    assert.equal((await node.receive(env)).status, 'queued');
    await node.approve(env.id, 'bob@b.test');
    await node.worker.drain();
    assert.equal((await node.status(env.id))[0]!.deliveries[0]!.state, 'delivered');
    for (const method of ['getMessage', 'saveMessage', 'bumpRate', 'approveSender', 'claimDue', 'transition', 'messageViews']) {
      assert.ok(calls.has(method), `${method} went through the store`);
    }
    await assert.rejects(AdtpNode.create({ config: testConfig('b.test'), keys: new TestKeys() }), /needs a database \(db\) or a store/);
  });

  it('TokenVerifier: the HTTP surface asks it who a token belongs to', async () => {
    node = await AdtpNode.create({ config: testConfig('b.test'), db: db.conn, keys: new TestKeys(), resolver, adapters: adapters(), now: clock.now });
    const seen: string[] = [];
    const tokens: TokenVerifier = {
      // Stands in for a lookup in someone else's token table.
      verify: async (token): Promise<Role | null> => {
        seen.push(token);
        return token === 'tenant-admin' ? 'admin' : token === 'tenant-agent' ? 'agent' : null;
      },
    };
    server = createApp({ node, tokens, log: silentLogger });
    const port = await freePort();
    await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve));
    const get = async (path: string, token: string) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } })).status;

    assert.equal(await get('/api/v0/tray', 'tenant-admin'), 200);
    assert.equal(await get('/api/v0/tray', 'tenant-agent'), 403);
    assert.equal(await get('/api/v0/tray', 'someone-else'), 401);
    assert.equal(await get('/api/v0/events?address=helper@b.test', 'tenant-agent'), 200);
    assert.deepEqual(seen, ['tenant-admin', 'tenant-agent', 'someone-else', 'tenant-agent']);
    assert.throws(() => createApp({ node, log: silentLogger }), /needs a token verifier or an admin token/);
  });
});
