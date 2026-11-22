/**
 * Identifiers: `msg_<ulid>` for messages, `thr_<ulid>` for threads.
 *
 * A ULID is 48 bits of millisecond time followed by 80 random bits, written
 * as 26 Crockford base32 characters, so ids sort by creation time.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now(), random: Buffer = randomBytes(10)): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits, five at a time.
  let value = 0n;
  for (const byte of random.subarray(0, 10)) value = (value << 8n) | BigInt(byte);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(value & 31n)] + rand;
    value >>= 5n;
  }
  return time + rand;
}

export function newMessageId(now?: number): string {
  return 'msg_' + ulid(now);
}

export function newThreadId(now?: number): string {
  return 'thr_' + ulid(now);
}
