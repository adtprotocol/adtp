/**
 * The node's Ed25519 keys, and the `KeyStore` seam they sit behind.
 *
 * The default store, `Keyring`, has one keypair that signs for every address
 * the node hosts (the same model as a mail server's DKIM key). Keys live in a
 * single JSON file (mode 0600): exactly one active key with its private half,
 * plus rotated-out keys that keep only their public half and a `not_after`
 * until which others may still verify signatures against them.
 *
 * Private key material is never logged and never leaves this module: callers
 * get a `Signer` that can sign but cannot export the key.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  generateKeyPair,
  kidFor,
  privateKeyFromSeed,
  publicKeyFromPrivate,
  signBytes,
  type Signer,
} from '../protocol/signing.js';
import type { PublishedKey } from '../protocol/types.js';
import type { KeyObject } from 'node:crypto';

export interface Rotation {
  kid: string;
  previous: string;
  previousValidUntil: string | null;
}

/**
 * Where signing keys come from. The node asks per address, so an
 * implementation may keep one key for everything (as `Keyring` does) or a key
 * per address or per domain.
 */
export interface KeyStore {
  /** Signs for `address` with its active key. */
  signer(address: string): Signer;
  /** Keys to publish in the address's card: the active key first, then rotated-out keys that still verify. */
  publicKeys(address: string): PublishedKey[];
  /** Makes a new key the active one for `address`. The old one keeps verifying for a grace period. */
  rotate(address: string): Rotation;
}

interface StoredKey {
  kid: string;
  public_key: string;
  /** base64url 32-byte seed. Present only on the active key, and absent when the key comes from the environment. */
  private_key?: string;
  created_at: string;
  /** Set when the key was rotated out. */
  not_after?: string;
}

interface KeyringFile {
  version: 1;
  active: string;
  keys: StoredKey[];
}

export interface KeyringOptions {
  path: string;
  graceDays: number;
  /** base64url 32-byte seed supplied via ADTP_PRIVATE_KEY; overrides the file's active key. */
  envPrivateKey?: string;
  now?: () => Date;
}

export interface KeyringLoadResult {
  keyring: Keyring;
  /** True when this call generated the node's very first key. */
  created: boolean;
  /** True when a new environment key replaced the previous active key. */
  rotatedFromEnv: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class Keyring implements KeyStore, Signer {
  private file!: KeyringFile;
  private activeKey!: KeyObject;
  private loadedMtimeMs = 0;
  private lastStatAt = 0;

  private constructor(private readonly opts: KeyringOptions) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  static load(opts: KeyringOptions): KeyringLoadResult {
    const keyring = new Keyring(opts);
    let created = false;
    let rotatedFromEnv = false;

    if (existsSync(opts.path)) {
      keyring.file = keyring.read();
    } else {
      created = true;
      keyring.file = { version: 1, active: '', keys: [] };
    }

    if (opts.envPrivateKey) {
      const key = privateKeyFromSeed(opts.envPrivateKey);
      const publicKey = publicKeyFromPrivate(key);
      const kid = kidFor(publicKey);
      if (keyring.file.active !== kid) {
        rotatedFromEnv = keyring.file.active !== '';
        keyring.retireActive();
        keyring.file.keys = keyring.file.keys.filter((k) => k.kid !== kid);
        keyring.file.keys.push({ kid, public_key: publicKey, created_at: keyring.now().toISOString() });
        keyring.file.active = kid;
        keyring.write();
      }
      keyring.activeKey = key;
    } else if (created) {
      keyring.addGeneratedKey();
      keyring.write();
      keyring.activeKey = keyring.loadActiveFromFile();
    } else {
      keyring.activeKey = keyring.loadActiveFromFile();
    }

    keyring.noteMtime();
    return { keyring, created, rotatedFromEnv };
  }

  private read(): KeyringFile {
    const parsed = JSON.parse(readFileSync(this.opts.path, 'utf8')) as KeyringFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys) || typeof parsed.active !== 'string') {
      throw new Error(`keyring file ${this.opts.path} has an unexpected format`);
    }
    return parsed;
  }

  private write(): void {
    const dir = path.dirname(this.opts.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.opts.path);
  }

  private noteMtime(): void {
    try {
      this.loadedMtimeMs = statSync(this.opts.path).mtimeMs;
    } catch {
      this.loadedMtimeMs = 0;
    }
  }

  private loadActiveFromFile(): KeyObject {
    const active = this.file.keys.find((k) => k.kid === this.file.active);
    if (!active?.private_key) {
      throw new Error(
        `keyring ${this.opts.path} has no private key for the active key; set ADTP_PRIVATE_KEY or restore the file`,
      );
    }
    return privateKeyFromSeed(active.private_key);
  }

  private addGeneratedKey(): string {
    const pair = generateKeyPair();
    const kid = kidFor(pair.publicKey);
    this.file.keys.push({ kid, public_key: pair.publicKey, private_key: pair.privateKey, created_at: this.now().toISOString() });
    this.file.active = kid;
    return kid;
  }

  /** Marks the current active key as rotated out: its private half is dropped and it verifies until the grace period ends. */
  private retireActive(): void {
    const current = this.file.keys.find((k) => k.kid === this.file.active);
    if (!current) return;
    delete current.private_key;
    current.not_after = new Date(this.now().getTime() + this.opts.graceDays * DAY_MS).toISOString();
  }

  /** Picks up a rotation performed by another process (e.g. `adtp keys rotate` while the node runs). */
  private refreshIfChanged(): void {
    if (this.opts.envPrivateKey) return;
    const nowMs = Date.now();
    if (nowMs - this.lastStatAt < 2000) return;
    this.lastStatAt = nowMs;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.opts.path).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    const file = this.read();
    const active = file.keys.find((k) => k.kid === file.active);
    if (!active?.private_key) return;
    this.file = file;
    this.activeKey = privateKeyFromSeed(active.private_key);
    this.loadedMtimeMs = mtimeMs;
  }

  get kid(): string {
    this.refreshIfChanged();
    return this.file.active;
  }

  sign(data: Buffer): { kid: string; signature: Buffer } {
    this.refreshIfChanged();
    return { kid: this.file.active, signature: signBytes(this.activeKey, data) };
  }

  /** One key signs for every address, so the address does not matter here. */
  signer(_address?: string): Signer {
    return this;
  }

  /** Keys to publish in cards: the active key plus rotated-out keys still inside their grace period. */
  publicKeys(_address?: string): PublishedKey[] {
    this.refreshIfChanged();
    const now = this.now().getTime();
    const out: PublishedKey[] = [];
    for (const k of this.file.keys) {
      if (k.kid === this.file.active) {
        out.unshift({ kid: k.kid, alg: 'Ed25519', public_key: k.public_key });
      } else if (k.not_after && Date.parse(k.not_after) >= now) {
        out.push({ kid: k.kid, alg: 'Ed25519', public_key: k.public_key, not_after: k.not_after });
      }
    }
    return out;
  }

  /**
   * Generates a new active key. The previous key stays published (public half
   * only) until the grace period ends, then is dropped from the file.
   */
  rotate(_address?: string): Rotation {
    if (this.opts.envPrivateKey) {
      throw new Error('the active key comes from ADTP_PRIVATE_KEY; rotate by setting a new value and restarting the node');
    }
    const previous = this.file.active;
    this.retireActive();
    const now = this.now().getTime();
    this.file.keys = this.file.keys.filter((k) => k.kid === previous || !k.not_after || Date.parse(k.not_after) >= now);
    const kid = this.addGeneratedKey();
    this.write();
    this.activeKey = this.loadActiveFromFile();
    this.noteMtime();
    const prev = this.file.keys.find((k) => k.kid === previous);
    return { kid, previous, previousValidUntil: prev?.not_after ?? null };
  }
}
