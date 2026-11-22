/**
 * Exponential backoff with jitter.
 *
 * The nth failed attempt waits between half of and all of
 * min(max, base * 2^(n-1)) seconds, so retries from many messages spread out
 * instead of arriving together.
 */
export function backoffMs(attempt: number, baseSeconds: number, maxSeconds: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  const ceiling = Math.min(maxSeconds, baseSeconds * 2 ** exponent) * 1000;
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}
