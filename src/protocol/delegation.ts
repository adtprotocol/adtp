/**
 * Delegation tokens: "agent X may act for principal Y", signed by Y's key.
 *
 * Format: a compact JWS (JWT) with `alg: EdDSA`.
 *   header:  { alg: "EdDSA", typ: "adtp-delegation+jwt", kid }
 *   payload: { iss, sub, aud, scope, jti, iat, exp }
 *
 *   iss    the principal's address
 *   sub    the agent's address (the envelope's `from`)
 *   aud    "adtp" (any node), or the origin of the one node the token is good at
 *   scope  the intents the agent may send for the principal
 *   jti    unique id of the token, which is what a revocation names
 */
import { randomBytes } from 'node:crypto';
import { DELEGATION_AUDIENCE, DELEGATION_TOKEN_TYP, INTENTS, MAX_CLOCK_SKEW_SECONDS } from './constants.js';
import { b64url, fromB64url, keyIsValid, verifyBytes, type Signer } from './signing.js';
import type { PublishedKey } from './types.js';

export interface DelegationClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  scope: string[];
  jti: string;
  iat: number;
  exp: number;
}

export interface MintDelegationInput {
  principal: string;
  agent: string;
  /** Intents the agent may send for the principal. */
  scope: readonly string[];
  ttlSeconds: number;
  /** Defaults to "adtp": valid at any node. Pass a node origin (https://adtp.example.com) to bind the token to it. */
  audience?: string;
  jti?: string;
  now?: Date;
}

export function newDelegationId(): string {
  return 'dlg_' + randomBytes(12).toString('base64url');
}

export function mintDelegation(input: MintDelegationInput, signer: Signer): { token: string; claims: DelegationClaims } {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims: DelegationClaims = {
    iss: input.principal,
    sub: input.agent,
    aud: input.audience ?? DELEGATION_AUDIENCE,
    scope: [...input.scope],
    jti: input.jti ?? newDelegationId(),
    iat,
    exp: iat + Math.floor(input.ttlSeconds),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  // The key id is part of the signed header, so it has to be known before signing. If the
  // key rotates between asking for the id and signing, sign once more under the new id.
  for (let attempt = 0; attempt < 2; attempt++) {
    const kid = signer.kid;
    const signingInput = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: DELEGATION_TOKEN_TYP, kid }), 'utf8')) + '.' + payload;
    const made = signer.sign(Buffer.from(signingInput, 'ascii'));
    if (made.kid === kid) return { token: signingInput + '.' + b64url(made.signature), claims };
  }
  throw new Error('the signing key changed twice while a delegation token was being signed');
}

export type DelegationCheck =
  | { ok: true; claims: DelegationClaims }
  /** `unknown_key`: worth one fresh look at the principal's card before giving up. */
  | { ok: false; message: string; unknown_key?: boolean };

export interface VerifyDelegationInput {
  token: string;
  /** Principal named in the envelope's on_behalf_of. */
  principal: string;
  /** The envelope's `from`: the agent claiming to act for the principal. */
  agent: string;
  /** The envelope's intent, which the token's scope must cover. */
  intent: string;
  /** Audiences this node answers to: "adtp" and its own origin. */
  audiences: readonly string[];
  /** The principal's published keys. */
  keys: PublishedKey[];
  now: Date;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fromB64url(segment).toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads a token's claims without checking anything. For finding its `jti`; never a basis for trust. */
export function peekDelegation(token: string): Partial<DelegationClaims> | null {
  const segments = token.split('.');
  return segments.length === 3 ? (decodeJson(segments[1]!) as Partial<DelegationClaims> | null) : null;
}

export function verifyDelegation(input: VerifyDelegationInput): DelegationCheck {
  const fail = (message: string): DelegationCheck => ({ ok: false, message });
  const segments = input.token.split('.');
  if (segments.length !== 3) return fail('delegation token is not a compact JWS');
  const [headerSeg, payloadSeg, signatureSeg] = segments as [string, string, string];

  const header = decodeJson(headerSeg);
  const claims = decodeJson(payloadSeg);
  if (!header || !claims) return fail('delegation token is not valid JSON');
  if (header.alg !== 'EdDSA') return fail('delegation token must use alg EdDSA');
  if (header.typ !== DELEGATION_TOKEN_TYP) return fail(`delegation token typ must be ${DELEGATION_TOKEN_TYP}`);
  if (typeof header.kid !== 'string' || header.kid.length === 0) return fail('delegation token header needs a kid');

  const key = input.keys.find((k) => k.kid === header.kid);
  if (!key || !keyIsValid(key, input.now)) {
    return { ok: false, message: 'delegation token is signed with a key the principal does not publish', unknown_key: true };
  }
  if (!verifyBytes(key.public_key, Buffer.from(`${headerSeg}.${payloadSeg}`, 'ascii'), fromB64url(signatureSeg))) {
    return fail('delegation token signature does not verify');
  }

  const { iss, sub, aud, scope, jti, iat, exp } = claims;
  if (typeof iss !== 'string' || iss.toLowerCase() !== input.principal) {
    return fail('delegation token was not issued by the named principal');
  }
  if (typeof sub !== 'string' || sub.toLowerCase() !== input.agent) {
    return fail('delegation token does not name the sender as the delegate');
  }
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
  if (audiences.length === 0) return fail('delegation token needs an aud');
  if (!audiences.some((a) => input.audiences.includes(a))) return fail('delegation token is not meant for this node (aud)');
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((s) => typeof s !== 'string')) {
    return fail('delegation token needs a scope listing the intents it covers');
  }
  if (!(scope as string[]).includes(input.intent)) return fail(`delegation token does not cover the intent "${input.intent}"`);
  if (typeof jti !== 'string' || jti.length === 0) return fail('delegation token needs a jti');
  if (typeof exp !== 'number' || typeof iat !== 'number') return fail('delegation token needs numeric iat and exp');
  const nowSeconds = input.now.getTime() / 1000;
  if (nowSeconds >= exp) return fail('delegation token has expired');
  if (iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return fail('delegation token is not valid yet');

  return { ok: true, claims: { iss, sub, aud: aud as string | string[], scope: scope as string[], jti, iat, exp } };
}

/** Checks a scope given by a caller: a non-empty list of known intents. Returns it de-duplicated, or null. */
export function parseScope(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const scope: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(INTENTS as readonly string[]).includes(entry)) return null;
    if (!scope.includes(entry)) scope.push(entry);
  }
  return scope;
}
