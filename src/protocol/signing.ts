import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalize } from './canonical.js';
import { SIGNATURE_ALG } from './constants.js';
import type { Envelope, PublishedKey, Signature, UnsignedEnvelope } from './types.js';

/**
 * Anything that can sign with an address's active key. Private key material
 * never leaves the implementation. `sign` returns the id of the key it used
 * together with the signature, so the two can never disagree across a rotation.
 */
export interface Signer {
  readonly kid: string;
  sign(data: Buffer): { kid: string; signature: Buffer };
}

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function b64url(data: Buffer): string {
  return data.toString('base64url');
}

export function fromB64url(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

/** Generates an Ed25519 keypair as base64url raw public key and base64url 32-byte seed. */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return { publicKey: pub.x as string, privateKey: jwk.d as string };
}

export function privateKeyFromSeed(seedB64url: string): KeyObject {
  const seed = fromB64url(seedB64url);
  if (seed.length !== 32) throw new Error('Ed25519 private key must be a 32-byte seed (base64url)');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function publicKeyFromPrivate(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: 'jwk' }).x as string;
}

export function publicKeyObject(publicKeyB64url: string): KeyObject {
  if (fromB64url(publicKeyB64url).length !== 32) throw new Error('Ed25519 public key must be 32 bytes (base64url)');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64url }, format: 'jwk' });
}

/** The key ids this node gives its own keys: a short fingerprint of the public key. Other nodes may name theirs differently. */
export function kidFor(publicKeyB64url: string): string {
  return 'ed25519-' + createHash('sha256').update(fromB64url(publicKeyB64url)).digest('hex').slice(0, 16);
}

export function signBytes(privateKey: KeyObject, data: Buffer): Buffer {
  return sign(null, data, privateKey);
}

export function verifyBytes(publicKeyB64url: string, data: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, data, publicKeyObject(publicKeyB64url), signature);
  } catch {
    return false;
  }
}

/** The bytes a signature covers: the canonical JSON (RFC 8785) of the object without its `signature` member. */
export function signingInput(signed: object): Buffer {
  const { signature: _ignored, ...unsigned } = signed as Record<string, unknown>;
  return Buffer.from(canonicalize(unsigned), 'utf8');
}

/** SHA-256 of the signed bytes, in hex: two envelopes with the same hash say exactly the same thing. */
export function contentHash(envelope: UnsignedEnvelope | Envelope): string {
  return createHash('sha256').update(signingInput(envelope)).digest('hex');
}

/** Returns `unsigned` with a `signature` member made by `signer`. Used for envelopes and for acceptance receipts. */
export function signObject<T extends object>(unsigned: T, signer: Signer): T & { signature: Signature } {
  const { kid, signature } = signer.sign(signingInput(unsigned));
  return { ...unsigned, signature: { alg: SIGNATURE_ALG, kid, value: b64url(signature) } };
}

export function signEnvelope(unsigned: UnsignedEnvelope, signer: Signer): Envelope {
  return signObject(unsigned, signer);
}

/** True if the key may still be used to verify signatures at `now`. */
export function keyIsValid(key: PublishedKey, now: Date): boolean {
  if (key.alg !== SIGNATURE_ALG) return false;
  if (key.not_after === undefined) return true;
  const until = Date.parse(key.not_after);
  return !Number.isNaN(until) && now.getTime() <= until;
}

export type SignatureCheck =
  | { ok: true; kid: string }
  /** `unknown_key`: the signer's card (as we have it) lists no usable key with that id. Worth one fresh look at the card. */
  | { ok: false; reason: 'malformed' | 'unknown_key' | 'invalid' };

export function isSignature(value: unknown): value is Signature {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return s.alg === SIGNATURE_ALG && typeof s.kid === 'string' && s.kid.length > 0 && typeof s.value === 'string';
}

/**
 * Verifies the `signature` member of an envelope or receipt against the
 * signer's published keys. The signature names its key (`kid`); only that key
 * is tried, and only while it is valid.
 */
export function verifySignature(signed: object, keys: PublishedKey[], now: Date): SignatureCheck {
  const signature = (signed as { signature?: unknown }).signature;
  if (!isSignature(signature)) return { ok: false, reason: 'malformed' };
  const key = keys.find((k) => k.kid === signature.kid);
  if (!key || !keyIsValid(key, now)) return { ok: false, reason: 'unknown_key' };
  const bytes = fromB64url(signature.value);
  if (bytes.length !== 64) return { ok: false, reason: 'malformed' };
  return verifyBytes(key.public_key, signingInput(signed), bytes) ? { ok: true, kid: key.kid } : { ok: false, reason: 'invalid' };
}
