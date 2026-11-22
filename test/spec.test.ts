/**
 * SPEC.md and the code must agree. This checks the parts of the spec that can
 * be checked mechanically: the signed example in Appendix B, the error table
 * in Appendix A, and the example documents in the text.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseCard } from '../src/protocol/cards.js';
import { canonicalize } from '../src/protocol/canonical.js';
import { parseTxtDirectory, parseTxtRecord } from '../src/identity/discovery.js';
import { AUTO_REPLY_DATA_TYPE, DIRECTORY_PATH, INTENTS, MAX_DESCRIPTION_LENGTH, MAX_DIRECTORY_ENTRIES, MAX_ENVELOPE_BYTES, PRIORITIES, RECEIPT_STATUSES } from '../src/protocol/constants.js';
import { parseDirectory } from '../src/protocol/directory.js';
import { validateEnvelope } from '../src/protocol/envelope.js';
import { privateKeyFromSeed, publicKeyFromPrivate, signBytes, signObject, verifySignature, type Signer } from '../src/protocol/signing.js';
import { STATUS_BY_CODE } from '../src/protocol/wire.js';

// The compiled test lives in dist/test; SPEC.md is at the repository root.
const SPEC = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'SPEC.md'), 'utf8');

/** The fenced code blocks under a heading, in order. */
function blocksUnder(heading: string): string[] {
  const start = SPEC.indexOf(heading);
  assert.ok(start >= 0, `SPEC.md has a section "${heading}"`);
  const next = SPEC.indexOf('\n## ', start + heading.length);
  const section = SPEC.slice(start, next === -1 ? undefined : next);
  return [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
}

describe('SPEC.md', () => {
  it('Appendix B: the signed example is what the code produces, and verifies', () => {
    const [seedHex, keyJson, envelopeJson, signedBytes, sha256, signatureJson] = blocksUnder('## Appendix B. A signed example');
    const key = privateKeyFromSeed(Buffer.from(seedHex!, 'hex').toString('base64url'));
    const published = JSON.parse(keyJson!) as { kid: string; alg: 'Ed25519'; public_key: string };
    assert.equal(publicKeyFromPrivate(key), published.public_key, 'the public key belongs to the private key');

    const unsigned = JSON.parse(envelopeJson!) as Record<string, unknown>;
    assert.equal(canonicalize(unsigned), signedBytes, 'the signed bytes are the RFC 8785 form of the envelope');
    assert.equal(Buffer.byteLength(signedBytes!), 434);
    assert.equal(createHash('sha256').update(signedBytes!).digest('hex'), sha256);

    const signer: Signer = { kid: published.kid, sign: (data) => ({ kid: published.kid, signature: signBytes(key, data) }) };
    const signature = JSON.parse(signatureJson!) as unknown;
    assert.deepEqual(signObject(unsigned, signer).signature, signature, 'signing the example gives the signature in the spec');

    const envelope = { ...unsigned, signature };
    assert.deepEqual(verifySignature(envelope, [published], new Date('2026-11-21T10:00:01Z')), { ok: true, kid: published.kid });
    assert.ok(validateEnvelope(envelope).ok, 'and it is a valid envelope');
  });

  it('Appendix A: every error code has the status the code answers with', () => {
    const rows = [...SPEC.slice(SPEC.indexOf('## Appendix A. Error codes')).matchAll(/^\| `([a-z_]+)` \| (\d{3}) \| (yes|no) \|/gm)];
    const documented = Object.fromEntries(rows.map((r) => [r[1]!, Number(r[2])]));
    assert.deepEqual(documented, { ...STATUS_BY_CODE }, 'the table and the code list the same codes with the same statuses');
    assert.ok(rows.length >= 14);
  });

  it('the example card and envelope in the text are valid', () => {
    const card = JSON.parse(blocksUnder('### 3.2 The card')[0]!.replace('"<base64url>"', '"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"')) as Record<string, unknown>;
    const parsed = parseCard(card);
    assert.equal(parsed.endpoint, 'https://adtp.stratuslabs.com/adtp/v0/messages');
    assert.deepEqual(parsed.accepts, [...INTENTS], 'the card lists every intent v0 defines');
    assert.equal(parsed.max_bytes, MAX_ENVELOPE_BYTES);

    const example = blocksUnder('## 4. The envelope')[0]!.replace('"<base64url>"', `"${'A'.repeat(86)}"`);
    const envelope = validateEnvelope(JSON.parse(example));
    assert.ok(envelope.ok, envelope.ok ? '' : envelope.message);
    assert.equal(envelope.value.principal, 'dylan@stratuslabs.com');
  });

  it('the example directory, its DNS record and its limits are what the code reads', () => {
    const [document, record, fallback] = blocksUnder('### 3.3 The directory');
    const directory = parseDirectory(JSON.parse(document!), 'acme.com');
    assert.deepEqual(directory.entries.map((e) => e.address), ['ap@acme.com', 'hello@acme.com']);
    assert.ok(directory.entries.every((e) => e.type && e.description), 'every member of the example survives parsing');

    const value = /"(.*)"/.exec(record!)![1]!;
    assert.equal(parseTxtDirectory(value), `https://adtp.acme.com${DIRECTORY_PATH}`);
    assert.equal(parseTxtRecord(value), 'https://adtp.acme.com/.well-known/adtp/{local}', 'and the same record still gives the card template');
    assert.equal(fallback, `https://<domain>${DIRECTORY_PATH}`);

    const section = SPEC.slice(SPEC.indexOf('### 3.3 The directory'), SPEC.indexOf('## 4. The envelope')).replace(/\s+/g, ' ');
    assert.ok(section.includes(`after the first ${MAX_DIRECTORY_ENTRIES}`));
    assert.ok(section.includes(`at most ${MAX_DESCRIPTION_LENGTH} characters`));
    assert.ok(section.includes(`after ${MAX_DESCRIPTION_LENGTH} characters`));
  });

  it('names the marker for automatic messages the code uses', () => {
    assert.ok(SPEC.includes(`\`${AUTO_REPLY_DATA_TYPE}\``));
  });

  it('names the same intents, priorities and receipt statuses as the code', () => {
    const intents = [...SPEC.slice(SPEC.indexOf('### 4.3 Intents'), SPEC.indexOf('### 4.4 Content')).matchAll(/^\| `([a-z.]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(intents, [...INTENTS]);
    for (const priority of PRIORITIES) assert.ok(SPEC.includes(`\`"${priority}"\``), `priority ${priority}`);
    const statuses = [...SPEC.slice(SPEC.indexOf('## 10. Status receipts'), SPEC.indexOf('## 11. Unknown senders')).matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(statuses.filter((s) => s !== 'status'), [...RECEIPT_STATUSES], 'the rows of the table, without its header');
  });
});
