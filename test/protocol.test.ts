import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeAddress, parseAddress } from '../src/protocol/address.js';
import { canonicalize } from '../src/protocol/canonical.js';
import { buildCard, parseCard } from '../src/protocol/cards.js';
import { ADTP_CONTENT_TYPE, INTENTS, MAX_ENVELOPE_BYTES } from '../src/protocol/constants.js';
import { mintDelegation, parseScope, peekDelegation, verifyDelegation } from '../src/protocol/delegation.js';
import { parseTimestamp, receiptOf, receiptParts, textOf, validateEnvelope } from '../src/protocol/envelope.js';
import { newMessageId, newThreadId, ulid } from '../src/protocol/ids.js';
import { contentHash, keyIsValid, signEnvelope, signingInput, signObject, verifySignature } from '../src/protocol/signing.js';
import { parseResponse, statusFor, toResponse } from '../src/protocol/wire.js';
import type { Ack, Envelope } from '../src/protocol/types.js';
import { signedEnvelope, TEST_EPOCH, TestKeys, unsignedEnvelope } from './helpers.js';

const NOW = new Date(TEST_EPOCH);

describe('canonical JSON (RFC 8785)', () => {
  it('sorts keys, drops whitespace and undefined members', () => {
    assert.equal(canonicalize({ b: 1, a: [true, null, 'x'], c: undefined, aa: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"aa":{"y":2,"z":1},"b":1}');
  });

  it('gives the same bytes regardless of key order', () => {
    assert.equal(canonicalize({ x: { b: 2, a: 1 }, y: 1 }), canonicalize({ y: 1, x: { a: 1, b: 2 } }));
  });

  it('refuses values JSON cannot represent', () => {
    assert.throws(() => canonicalize({ n: Number.NaN }));
    assert.throws(() => canonicalize({ f: () => 1 }));
    assert.throws(() => canonicalize({ s: 'half a pair: \ud83d' }), /not valid Unicode/);
    assert.throws(() => canonicalize({ ['\ude00']: 1 }), /not valid Unicode/);
  });

  // RFC 8785, section 3.2.2 and 3.2.4: the worked example, input and expected output.
  it('serializes the primitive types as in the RFC example (3.2.2)', () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        ' "literals": [null, true, false]}',
    ) as unknown;
    const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    assert.equal(canonicalize(input), expected);
    // The same output as bytes: UTF-8, with the euro sign as e2 82 ac and the control character still escaped.
    assert.equal(
      Buffer.from(canonicalize(input), 'utf8').toString('hex'),
      '7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d',
    );
  });

  // RFC 8785, section 3.2.3: property names sort by UTF-16 code units, not by code point or locale.
  it('sorts property names by UTF-16 code units as in the RFC example (3.2.3)', () => {
    const input = JSON.parse(
      '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One",' +
        ' "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", "\\u00f6": "Latin Small Letter O With Diaeresis"}',
    ) as Record<string, string>;
    // Read the order off the output text itself: a parsed object would list the key "1" first whatever the text says.
    const canonical = canonicalize(input);
    const order = Object.values(input).sort((a, b) => canonical.indexOf(a) - canonical.indexOf(b));
    assert.deepEqual(order, [
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
    assert.ok(canonical.startsWith('{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":'));
  });

  // RFC 8785, appendix B: IEEE 754 double (hex) -> its JSON serialization.
  it('serializes numbers as in the RFC table (appendix B)', () => {
    const samples: [string, string][] = [
      ['0000000000000000', '0'], // zero
      ['8000000000000000', '0'], // minus zero
      ['0000000000000001', '5e-324'], // smallest positive number
      ['8000000000000001', '-5e-324'], // smallest negative number
      ['7fefffffffffffff', '1.7976931348623157e+308'], // largest positive number
      ['ffefffffffffffff', '-1.7976931348623157e+308'], // largest negative number
      ['4340000000000000', '9007199254740992'], // largest positive integer
      ['c340000000000000', '-9007199254740992'], // largest negative integer
      ['4430000000000000', '295147905179352830000'], // about 2**68
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'], // round to even
    ];
    for (const [hex, expected] of samples) {
      assert.equal(canonicalize(Buffer.from(hex, 'hex').readDoubleBE(0)), expected, hex);
    }
    // NaN and Infinity have no JSON form: canonicalization must fail, not guess.
    for (const hex of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000']) {
      assert.throws(() => canonicalize(Buffer.from(hex, 'hex').readDoubleBE(0)), /non-finite/, hex);
    }
  });
});

describe('addresses', () => {
  it('parses and normalizes local@domain', () => {
    assert.deepEqual(parseAddress(' Alice@Example.COM '), { local: 'alice', domain: 'example.com', address: 'alice@example.com' });
    assert.equal(normalizeAddress('bot+tag@agents.example'), 'bot+tag@agents.example');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['alice', '@example.com', 'alice@', 'a b@example.com', 'alice@exa mple.com', 'alice@-bad.com', 42, null]) {
      assert.equal(parseAddress(bad), null, String(bad));
    }
  });
});

describe('envelope validation', () => {
  const keys = new TestKeys();
  const valid = (): Envelope => signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], intent: 'request', text: 'hi' }, keys);

  it('accepts a well-formed envelope and normalizes its fields', () => {
    const env = signedEnvelope({ from: 'Alice@A.test', to: ['bob@b.test', 'BOB@b.test'], text: 'hi' }, keys);
    const result = validateEnvelope(env);
    assert.ok(result.ok);
    assert.equal(result.value.from, 'alice@a.test');
    assert.deepEqual(result.value.to, ['bob@b.test']);
    assert.equal(result.value.thread, env.id);
    assert.equal(result.value.priority, 'normal');
    assert.equal(result.value.createdAt.toISOString(), TEST_EPOCH);
    assert.equal(result.value.envelope, env, 'the envelope itself is passed through untouched');
  });

  it('accepts the example envelope from SPEC.md', () => {
    const { token } = mintDelegation(
      { principal: 'dylan@stratuslabs.com', agent: 'agent@stratuslabs.com', scope: ['request'], ttlSeconds: 3600 },
      keys,
    );
    const unsigned = {
      adtp: '0',
      id: 'msg_01KAGZ4Q8Y5V7W3N9M2T6R0XEB',
      thread: 'thr_01KAGZ4Q8Y5V7W3N9M2T6R0XEC',
      from: 'agent@stratuslabs.com',
      on_behalf_of: 'dylan@stratuslabs.com',
      to: ['echo@demo.adtp.dev'],
      intent: 'request' as const,
      priority: 'normal' as const,
      created_at: '2026-11-21T10:00:00Z',
      expires_at: '2026-11-28T10:00:00Z',
      requires_approval: false,
      content: {
        parts: [
          { type: 'text' as const, text: 'Hello from Stratus Labs. This is the first ADTP message. Please confirm receipt.' },
          { type: 'data' as const, data: { type: 'demo.ping', sent_at: '2026-11-21T10:00:00Z' } },
          { type: 'file' as const, url: 'https://stratuslabs.com/files/brief.pdf', name: 'brief.pdf', media_type: 'application/pdf', size: 48213 },
        ],
      },
      delegation: token,
    };
    const result = validateEnvelope(signEnvelope(unsigned, keys));
    assert.ok(result.ok, result.ok ? '' : result.message);
    assert.equal(result.value.principal, 'dylan@stratuslabs.com');
    assert.equal(result.value.thread, 'thr_01KAGZ4Q8Y5V7W3N9M2T6R0XEC');
    assert.deepEqual(Object.keys(result.value.envelope.signature), ['alg', 'kid', 'value']);
  });

  it('accepts every defined intent and rejects others', () => {
    for (const intent of INTENTS) {
      assert.ok(validateEnvelope({ ...valid(), intent }).ok, intent);
    }
    for (const intent of ['shout', '', 'approval', undefined]) {
      const result = validateEnvelope({ ...valid(), intent });
      assert.ok(!result.ok);
      assert.match(result.message, /^intent:/);
    }
  });

  it('requires each required field', () => {
    for (const field of ['adtp', 'id', 'from', 'to', 'intent', 'created_at', 'content', 'signature'] as const) {
      const env: Record<string, unknown> = { ...valid() };
      delete env[field];
      const result = validateEnvelope(env);
      assert.ok(!result.ok, `missing ${field} must be rejected`);
      assert.match(result.message, new RegExp(`^${field}`));
    }
  });

  it('takes low, normal and urgent as priorities, and nothing else', () => {
    for (const priority of ['low', 'normal', 'urgent']) assert.ok(validateEnvelope({ ...valid(), priority }).ok, priority);
    for (const priority of ['high', 'URGENT', '', 3, null]) {
      const result = validateEnvelope({ ...valid(), priority });
      assert.ok(!result.ok, String(priority));
      assert.match(result.message, /^priority: must be one of low, normal, urgent/);
    }
    const unstated = { ...valid() } as Record<string, unknown>;
    delete unstated.priority;
    const result = validateEnvelope(unstated);
    assert.ok(result.ok);
    assert.equal(result.value.priority, 'normal', 'normal is the default');
  });

  it('needs RFC 3339 timestamps, and gives a message without expires_at seven days', () => {
    assert.ok(parseTimestamp('2026-06-01T12:00:00Z'));
    assert.ok(parseTimestamp('2026-06-01T14:00:00.250+02:00'));
    for (const bad of ['2026-06-01', '2026-06-01 12:00:00', 'tomorrow', '2026-06-01T12:00:00', 1780315200, null]) {
      assert.equal(parseTimestamp(bad), null, String(bad));
      assert.ok(!validateEnvelope({ ...valid(), created_at: bad }).ok, `created_at ${String(bad)}`);
    }
    assert.ok(!validateEnvelope({ ...valid(), expires_at: 'tomorrow' }).ok);

    const open = validateEnvelope(valid());
    assert.ok(open.ok);
    assert.equal(open.value.expiresAt.toISOString(), '2026-06-08T12:00:00.000Z', 'created_at + 7 days');
    const stated = validateEnvelope({ ...valid(), expires_at: '2026-06-02T00:00:00Z' });
    assert.ok(stated.ok);
    assert.equal(stated.value.expiresAt.toISOString(), '2026-06-02T00:00:00.000Z');
  });

  it('takes text, data and file-by-URL parts, and requires at least one non-empty text part', () => {
    const withParts = (parts: unknown[]) => validateEnvelope({ ...valid(), content: { parts } });
    const text = { type: 'text', text: 'see attached' };
    assert.ok(withParts([text, { type: 'data', data: { a: 1 } }, { type: 'file', url: 'https://a.test/f.pdf', name: 'f.pdf', media_type: 'application/pdf', size: 10 }]).ok);

    for (const parts of [[{ type: 'data', data: { a: 1 } }], [{ type: 'text', text: '   ' }], []]) {
      const result = withParts(parts);
      assert.ok(!result.ok);
      assert.match(result.message, /content\.parts/);
    }
    assert.ok(!withParts([text, { type: 'file', name: 'no-url.pdf' }]).ok, 'a file part is a reference: it needs a url');
    assert.ok(!withParts([text, { type: 'file', url: 'file:///etc/passwd' }]).ok, 'only http(s) urls');
    assert.ok(!withParts([text, { type: 'file', url: 'https://a.test/f', bytes: 'aGVsbG8=' , size: -1 }]).ok);
    assert.ok(!withParts([text, { type: 'video', url: 'https://a.test/v' }]).ok, 'unknown part types are refused');
    assert.ok(!withParts([{ kind: 'text', text: 'hi' }]).ok, 'the marker is "type"');
  });

  it('rejects bad recipients, versions, delegation fields and signatures', () => {
    const signature = valid().signature;
    assert.ok(!validateEnvelope({ ...valid(), to: [] }).ok);
    assert.ok(!validateEnvelope({ ...valid(), to: ['nope'] }).ok);
    assert.ok(!validateEnvelope({ ...valid(), adtp: '1' }).ok);
    assert.ok(!validateEnvelope({ ...valid(), on_behalf_of: 'not an address' }).ok);
    assert.ok(!validateEnvelope({ ...valid(), on_behalf_of: { principal: 'carol@c.test' } }).ok);
    assert.ok(!validateEnvelope({ ...valid(), delegation: 'a.token.without-a-principal' }).ok, 'delegation needs on_behalf_of');
    assert.ok(!validateEnvelope({ ...valid(), signature: signature.value }).ok, 'signature is an object');
    assert.ok(!validateEnvelope({ ...valid(), signature: { ...signature, value: 'too-short' } }).ok);
    assert.ok(!validateEnvelope({ ...valid(), signature: { alg: 'Ed25519', value: signature.value } }).ok, 'signature needs a kid');
    assert.ok(!validateEnvelope({ ...valid(), signature: { ...signature, alg: 'RS256' } }).ok, 'Ed25519 only');
    assert.ok(!validateEnvelope({ ...valid(), id: 'has spaces' }).ok);
    assert.ok(!validateEnvelope('not an object').ok);
  });

  it('reports the message id when it can read one', () => {
    const env = valid();
    const result = validateEnvelope({ ...env, intent: 'bogus' });
    assert.ok(!result.ok);
    assert.equal(result.id, env.id);
    const unreadable = validateEnvelope({ intent: 'inform' });
    assert.ok(!unreadable.ok);
    assert.equal(unreadable.id, null);
  });

  it('joins text parts and recognizes status receipts', () => {
    const env = signedEnvelope(
      { from: 'a@a.test', to: ['b@b.test'], intent: 'status', parts: receiptParts({ message_id: 'm1', status: 'read', at: NOW.toISOString() }) },
      keys,
    );
    assert.deepEqual(receiptOf(env), { message_id: 'm1', status: 'read', at: NOW.toISOString() });
    assert.match(textOf(env.content), /m1 was read/);
    const failed = signedEnvelope(
      { from: 'a@a.test', to: ['b@b.test'], intent: 'status', parts: receiptParts({ message_id: 'm1', status: 'failed', at: NOW.toISOString() }) },
      keys,
    );
    assert.equal(receiptOf(failed)?.status, 'failed');
    assert.match(textOf(failed.content), /m1 could not be delivered/);
    assert.equal(receiptOf(signedEnvelope({ from: 'a@a.test', to: ['b@b.test'], intent: 'status', text: 'half way there' }, keys)), null);
    assert.equal(receiptOf({ ...env, intent: 'inform' }), null, 'only status messages can be receipts');
  });
});

describe('ids', () => {
  it('makes msg_ and thr_ ids from ULIDs', () => {
    assert.match(newMessageId(), /^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(newThreadId(), /^thr_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(newMessageId(), newMessageId());
  });

  it('encodes time first, so ids sort by creation time', () => {
    const zero = Buffer.alloc(10);
    assert.equal(ulid(0, zero), '0'.repeat(26));
    assert.equal(ulid(1, zero).slice(0, 10), '0000000001');
    assert.equal(ulid(32, zero).slice(0, 10), '0000000010');
    assert.equal(ulid(0, Buffer.alloc(10, 0xff)).slice(10), 'Z'.repeat(16));
    assert.ok(ulid(Date.parse('2026-01-01')) < ulid(Date.parse('2026-01-02')));
  });
});

describe('signatures', () => {
  const keys = new TestKeys();

  it('signs with an object that names the algorithm and the key', () => {
    const env = signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], text: 'pay 10' }, keys);
    assert.equal(env.signature.alg, 'Ed25519');
    assert.equal(env.signature.kid, keys.kid);
    assert.match(env.signature.value, /^[A-Za-z0-9_-]{86}$/);
    assert.deepEqual(verifySignature(env, keys.publicKeys(), NOW), { ok: true, kid: keys.kid });
  });

  it('detects tampering with any field', () => {
    const env = signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'], text: 'pay 10' }, keys);
    const invalid = { ok: false, reason: 'invalid' };
    const tampered: Envelope = { ...env, content: { parts: [{ type: 'text', text: 'pay 1000' }] } };
    assert.deepEqual(verifySignature(tampered, keys.publicKeys(), NOW), invalid);
    assert.deepEqual(verifySignature({ ...env, to: ['mallory@m.test'] }, keys.publicKeys(), NOW), invalid);
    assert.deepEqual(verifySignature({ ...env, expires_at: '2099-01-01T00:00:00Z' }, keys.publicKeys(), NOW), invalid);
    assert.deepEqual(verifySignature({ ...env, created_at: '2026-06-02T12:00:00Z' }, keys.publicKeys(), NOW), invalid, 'created_at is signed');
    assert.deepEqual(verifySignature({ ...env, on_behalf_of: 'ceo@a.test' }, keys.publicKeys(), NOW), invalid);
  });

  it('covers every field except the signature itself, regardless of key order', () => {
    const unsigned = unsignedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] });
    const env = signEnvelope(unsigned, keys);
    assert.deepEqual(signingInput(env), signingInput(unsigned));
    const reordered = Object.fromEntries(Object.entries(env).reverse()) as unknown as Envelope;
    assert.ok(verifySignature(reordered, keys.publicKeys(), NOW).ok);
    assert.equal(contentHash(reordered), contentHash(unsigned), 'the content hash is over the same bytes');
    assert.notEqual(contentHash({ ...unsigned, intent: 'request' }), contentHash(unsigned));
  });

  it('uses the key the signature names, and no other', () => {
    const env = signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, keys);
    const other = new TestKeys();
    assert.deepEqual(verifySignature(env, other.publicKeys(), NOW), { ok: false, reason: 'unknown_key' }, 'the card does not list that key id');
    assert.deepEqual(verifySignature(env, [], NOW), { ok: false, reason: 'unknown_key' });

    // The right key published under another id is not tried: there is no "try them all".
    const renamed = [{ ...keys.publicKeys()[0]!, kid: 'some-other-id' }];
    assert.deepEqual(verifySignature(env, renamed, NOW), { ok: false, reason: 'unknown_key' });
    // A wrong key published under the right id fails outright.
    const impostor = [{ ...other.publicKeys()[0]!, kid: keys.kid }];
    assert.deepEqual(verifySignature(env, impostor, NOW), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifySignature({ ...env, signature: 'abc' }, keys.publicKeys(), NOW), { ok: false, reason: 'malformed' });
  });

  it('honours a rotated key only until its not_after', () => {
    const env = signedEnvelope({ from: 'alice@a.test', to: ['bob@b.test'] }, keys);
    const newer = new TestKeys();
    const published = [...newer.publicKeys(), { ...keys.publicKeys()[0]!, not_after: '2026-06-10T00:00:00Z' }];
    assert.ok(verifySignature(env, published, new Date('2026-06-09T00:00:00Z')).ok);
    assert.deepEqual(verifySignature(env, published, new Date('2026-06-11T00:00:00Z')), { ok: false, reason: 'unknown_key' });
    assert.equal(keyIsValid(published[1]!, new Date('2026-06-11T00:00:00Z')), false);
  });

  it('signs any object the same way, which is how receipts are signed', () => {
    const receipt = signObject({ adtp: '0', id: 'm1', from: 'alice@a.test', by: 'bob@b.test', status: 'accepted', at: NOW.toISOString() }, keys);
    assert.ok(verifySignature(receipt, keys.publicKeys(), NOW).ok);
    assert.deepEqual(verifySignature({ ...receipt, status: 'queued' }, keys.publicKeys(), NOW), { ok: false, reason: 'invalid' });
  });
});

describe('delegation tokens', () => {
  const principalKeys = new TestKeys();
  const base = { principal: 'carol@c.test', agent: 'bot@agents.test' };
  const check = { ...base, intent: 'request', audiences: ['adtp', 'https://b.test'], keys: principalKeys.publicKeys(), now: NOW };
  const mint = (extra: Partial<Parameters<typeof mintDelegation>[0]> = {}) =>
    mintDelegation({ ...base, scope: ['inform', 'request'], ttlSeconds: 3600, now: NOW, ...extra }, principalKeys);
  const { token, claims } = mint();

  it('carries issuer, subject, audience, scope, a unique id and a lifetime', () => {
    assert.deepEqual(Object.keys(claims), ['iss', 'sub', 'aud', 'scope', 'jti', 'iat', 'exp']);
    assert.equal(claims.aud, 'adtp');
    assert.deepEqual(claims.scope, ['inform', 'request']);
    assert.equal(claims.exp - claims.iat, 3600);
    assert.match(claims.jti, /^dlg_[A-Za-z0-9_-]{16}$/);
    assert.notEqual(mint().claims.jti, claims.jti, 'every token has its own id');
    assert.equal(peekDelegation(token)?.jti, claims.jti);
    assert.equal(peekDelegation('garbage'), null);
  });

  it('verifies a token signed by the principal for this agent', () => {
    const result = verifyDelegation({ ...check, token });
    assert.ok(result.ok, result.ok ? '' : result.message);
    assert.deepEqual(result.claims, claims);
  });

  it('rejects a token for a different agent or principal', () => {
    assert.ok(!verifyDelegation({ ...check, agent: 'other@agents.test', token }).ok);
    assert.ok(!verifyDelegation({ ...check, principal: 'dave@c.test', token }).ok);
  });

  it('rejects an intent the scope does not cover', () => {
    assert.ok(verifyDelegation({ ...check, intent: 'inform', token }).ok);
    const result = verifyDelegation({ ...check, intent: 'commit', token });
    assert.ok(!result.ok);
    assert.match(result.message, /does not cover the intent "commit"/);
  });

  it('honours the audience: "adtp" anywhere, a node origin only at that node', () => {
    const bound = mint({ audience: 'https://b.test' }).token;
    assert.ok(verifyDelegation({ ...check, token: bound }).ok, 'this node is https://b.test');
    const elsewhere = verifyDelegation({ ...check, audiences: ['adtp', 'https://other.test'], token: bound });
    assert.ok(!elsewhere.ok);
    assert.match(elsewhere.message, /not meant for this node/);
    assert.ok(verifyDelegation({ ...check, audiences: ['adtp', 'https://other.test'], token }).ok, 'aud "adtp" is valid at any node');
  });

  it('requires aud, scope and jti', () => {
    // Signs arbitrary claims the way a careless or older issuer might.
    const forge = (payload: Record<string, unknown>): string => {
      const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'adtp-delegation+jwt', kid: principalKeys.kid })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${head}.${body}.${principalKeys.sign(Buffer.from(`${head}.${body}`, 'ascii')).signature.toString('base64url')}`;
    };
    assert.ok(verifyDelegation({ ...check, token: forge({ ...claims }) }).ok, 'the forge itself makes valid tokens');
    for (const missing of ['aud', 'scope', 'jti'] as const) {
      const partial: Record<string, unknown> = { ...claims };
      delete partial[missing];
      const result = verifyDelegation({ ...check, token: forge(partial) });
      assert.ok(!result.ok, `a token without ${missing} must be refused`);
      assert.match(result.message, new RegExp(missing));
    }
    assert.ok(!verifyDelegation({ ...check, token: forge({ ...claims, scope: [] }) }).ok, 'an empty scope covers nothing');
    assert.ok(verifyDelegation({ ...check, token: forge({ ...claims, aud: ['https://x.test', 'adtp'] }) }).ok, 'aud may be a list');
  });

  it('rejects expired tokens, foreign keys and tampering', () => {
    const later = new Date(NOW.getTime() + 2 * 3600 * 1000);
    assert.ok(!verifyDelegation({ ...check, token, now: later }).ok);
    const foreign = verifyDelegation({ ...check, token, keys: new TestKeys().publicKeys() });
    assert.ok(!foreign.ok && foreign.unknown_key, 'a key id the card does not list is worth one fresh look at the card');

    const [h, p, s] = token.split('.') as [string, string, string];
    const forgedClaims = Buffer.from(JSON.stringify({ ...claims, exp: 9999999999 })).toString('base64url');
    const forged = verifyDelegation({ ...check, token: `${h}.${forgedClaims}.${s}` });
    assert.ok(!forged.ok && !forged.unknown_key);
    assert.ok(!verifyDelegation({ ...check, token: `${h}.${p}` }).ok);
    assert.ok(!verifyDelegation({ ...check, token: 'garbage' }).ok);
  });

  it('a token signed by the agent itself is not a delegation', () => {
    const agentKeys = new TestKeys();
    const selfIssued = mintDelegation({ ...base, scope: ['request'], ttlSeconds: 3600, now: NOW }, agentKeys).token;
    assert.ok(!verifyDelegation({ ...check, token: selfIssued }).ok);
  });

  it('still verifies after the principal rotates, while the old key is published', () => {
    const rotated = [...new TestKeys().publicKeys(), { ...principalKeys.publicKeys()[0]!, not_after: '2026-06-10T00:00:00Z' }];
    assert.ok(verifyDelegation({ ...check, token, keys: rotated }).ok);
    assert.ok(!verifyDelegation({ ...check, token, keys: rotated, now: new Date('2026-06-11T00:00:00Z') }).ok);
  });

  it('checks a scope given by a caller', () => {
    assert.deepEqual(parseScope(['inform', 'request', 'inform']), ['inform', 'request']);
    for (const bad of [[], ['shout'], 'inform', undefined, [1]]) assert.equal(parseScope(bad), null);
  });
});

describe('wire: answers to a POSTed envelope', () => {
  const keys = new TestKeys();
  const stored: Ack = signObject(
    { adtp: '0', id: 'm1', from: 'alice@a.test', by: 'bob@b.test', status: 'accepted' as const, recipients: { 'bob@b.test': { status: 'accepted' as const } }, verified: { signature: 'k1' }, at: NOW.toISOString() },
    keys,
  );
  const refusal = (code: string, extra: Partial<NonNullable<Ack['reason']>> = {}): Ack => ({
    adtp: '0',
    id: 'm1',
    status: 'rejected',
    reason: { code, message: `${code} happened`, ...extra },
    at: NOW.toISOString(),
  });
  const roundTrip = (ack: Ack, duplicate = false) => {
    const response = toResponse(ack, duplicate);
    return { response, parsed: parseResponse(response.status, response.headers, JSON.stringify(response.body)) };
  };

  it('answers 202 with the signed receipt, and 200 with the same receipt for a repeat', () => {
    const first = roundTrip(stored);
    assert.equal(first.response.status, 202);
    assert.equal(first.response.headers['content-type'], ADTP_CONTENT_TYPE);
    assert.deepEqual(first.response.body, stored);
    assert.ok(first.parsed.kind === 'receipt');
    assert.ok(verifySignature(first.parsed.ack, keys.publicKeys(), NOW).ok, 'the receipt survives the trip with its signature intact');

    const again = roundTrip(stored, true);
    assert.equal(again.response.status, 200);
    assert.deepEqual(again.response.body, stored);
  });

  it('maps each refusal to its HTTP status and a { error, message, retryable } body', () => {
    const expected: Record<string, number> = {
      invalid_envelope: 400,
      bad_signature: 401,
      delegation_invalid: 403,
      not_trusted: 403,
      unknown_recipient: 404,
      id_conflict: 409,
      expired: 410,
      too_large: 413,
      rate_limited: 429,
    };
    for (const [code, status] of Object.entries(expected)) {
      const { response, parsed } = roundTrip(refusal(code));
      assert.equal(response.status, status, code);
      assert.deepEqual(response.body, { error: code, message: `${code} happened`, retryable: false });
      assert.ok(parsed.kind === 'refused');
      assert.equal(parsed.reason.code, code);
      // A sender retries on retryable: true, on 429 and on 5xx. Nothing else.
      assert.equal(parsed.reason.retryable, status === 429, code);
    }
    assert.equal(statusFor({ code: 'something_new', message: 'x', retryable: true }), 503);
    assert.equal(statusFor({ code: 'something_new', message: 'x' }), 400);
  });

  it('sends Retry-After with a rate limit, and reads it back', () => {
    const { response, parsed } = roundTrip(refusal('rate_limited', { retryable: true, retry_after: 1234.2 }));
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '1235');
    assert.deepEqual(response.body, { error: 'rate_limited', message: 'rate_limited happened', retryable: true });
    assert.ok(parsed.kind === 'refused');
    assert.equal(parsed.reason.retry_after, 1235);
  });

  it('carries per-recipient refusals when every recipient was turned away', () => {
    const ack: Ack = {
      ...refusal('rate_limited', { retryable: true }),
      recipients: {
        'ghost@b.test': { status: 'rejected', reason: { code: 'unknown_recipient', message: 'no such mailbox' } },
        'bob@b.test': { status: 'rejected', reason: { code: 'rate_limited', message: 'slow down', retryable: true } },
      },
    };
    const { parsed } = roundTrip(ack);
    assert.ok(parsed.kind === 'refused');
    assert.equal(parsed.recipients?.['ghost@b.test']?.reason?.code, 'unknown_recipient');
    assert.equal(parsed.recipients?.['ghost@b.test']?.reason?.retryable, false);
    assert.equal(parsed.recipients?.['bob@b.test']?.reason?.retryable, true);
  });

  it('treats answers that make no sense as refusals, retryable only where a retry could help', () => {
    const noReceipt = parseResponse(200, {}, '<html>welcome</html>');
    assert.ok(noReceipt.kind === 'refused' && noReceipt.reason.code === 'bad_receipt' && noReceipt.reason.retryable);
    const unsigned = parseResponse(202, {}, JSON.stringify({ id: 'm1', status: 'accepted' }));
    assert.ok(unsigned.kind === 'refused', 'a receipt must be signed');

    const gateway = parseResponse(502, {}, 'Bad Gateway');
    assert.ok(gateway.kind === 'refused' && gateway.reason.code === 'http_502' && gateway.reason.retryable);
    const notFound = parseResponse(404, {}, 'Not Found');
    assert.ok(notFound.kind === 'refused' && notFound.reason.code === 'http_404' && !notFound.reason.retryable);
    const flagged = parseResponse(409, {}, JSON.stringify({ error: 'busy', message: 'try later', retryable: true }));
    assert.ok(flagged.kind === 'refused' && flagged.reason.retryable, 'retryable: true is honoured on any status');
  });
});

describe('cards', () => {
  const keys = new TestKeys();
  const endpoint = 'https://adtp.b.test/adtp/v0/messages';

  it('builds a card with where to send, how to verify, and what is accepted', () => {
    const card = buildCard({ address: 'bob@b.test', type: 'human' }, endpoint, keys.publicKeys());
    assert.deepEqual(card, {
      adtp: '0',
      address: 'bob@b.test',
      endpoint,
      keys: keys.publicKeys(),
      accepts: [...INTENTS],
      max_bytes: 262144,
      type: 'human',
    });
    assert.deepEqual(parseCard(card), { address: 'bob@b.test', type: 'human', endpoint, keys: keys.publicKeys(), accepts: [...INTENTS], max_bytes: MAX_ENVELOPE_BYTES });
  });

  it('publishes the principal an agent acts for', () => {
    const card = buildCard({ address: 'agent@s.test', type: 'agent', acts_for: 'dylan@s.test' }, endpoint, keys.publicKeys());
    assert.equal(card.type, 'agent');
    assert.equal(card.acts_for, 'dylan@s.test');
    assert.equal(parseCard(card).acts_for, 'dylan@s.test');
    assert.equal(buildCard({ address: 'bob@b.test', type: 'human', acts_for: 'x@s.test' }, endpoint, keys.publicKeys()).acts_for, undefined, 'agents only');
  });

  it('reads a minimal card, filling in what it leaves out', () => {
    const minimal = { adtp: '0', address: 'Bob@B.test', endpoint, keys: keys.publicKeys() };
    assert.deepEqual(parseCard(minimal), { address: 'bob@b.test', type: null, endpoint, keys: keys.publicKeys(), accepts: [...INTENTS], max_bytes: MAX_ENVELOPE_BYTES });
    assert.deepEqual(parseCard({ ...minimal, accepts: ['inform'], max_bytes: 1000 }).accepts, ['inform']);
    assert.equal(parseCard({ ...minimal, accepts: ['inform'], max_bytes: 1000 }).max_bytes, 1000);
    const mixed = [...keys.publicKeys(), { kid: 'pq-1', alg: 'ML-DSA-65', public_key: 'AAAA' }];
    assert.deepEqual(parseCard({ ...minimal, keys: mixed }).keys, keys.publicKeys(), 'keys of an unknown algorithm are skipped');
  });

  it('rejects documents that are not usable cards', () => {
    const good = { adtp: '0', address: 'bob@b.test', endpoint, keys: keys.publicKeys() };
    assert.throws(() => parseCard({ name: 'something else', url: 'https://x.test' }), /adtp/);
    assert.throws(() => parseCard({ ...good, adtp: '1' }), /adtp/);
    assert.throws(() => parseCard({ ...good, endpoint: 'ftp://b.test' }), /endpoint/);
    assert.throws(() => parseCard({ ...good, address: 'nope' }), /address/);
    assert.throws(() => parseCard({ ...good, keys: 'none' }), /keys/);
    assert.throws(() => parseCard({ ...good, keys: [...keys.publicKeys(), ...keys.publicKeys()] }), /keys/, 'a key id names exactly one key');
    assert.throws(() => parseCard({ ...good, max_bytes: -5 }), /max_bytes/);
    assert.throws(() => parseCard({ ...good, accepts: 'inform' }), /accepts/);
    assert.throws(() => parseCard('hello'), /not a JSON object/);
  });
});
