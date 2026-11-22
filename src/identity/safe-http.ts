/**
 * The HTTP client used for every request whose destination is chosen by
 * someone else: fetching cards (URL comes from a sender's DNS record) and
 * posting to a recipient node's endpoint (URL comes from its card).
 *
 * Guards against server-side request forgery:
 * - only http(s); plain http only when explicitly allowed (local dev);
 * - the resolved IP is checked at connect time, so private, loopback and
 *   link-local targets are refused even behind DNS tricks;
 * - redirects are not followed; responses are size- and time-limited.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Permit http:// URLs and private/loopback addresses. For local development only. */
  allowInsecure?: boolean;
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type HttpClient = (url: string, options?: HttpRequestOptions) => Promise<HttpResult>;

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 127], // :: and ::1
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** True for addresses a public node has no business connecting to on someone else's say-so. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP address at all
}

function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address as string, family);
      if (!allowPrivate) {
        const all = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
        const bad = all.find(isPrivateAddress);
        if (bad) {
          return callback(new Error(`refusing to connect to ${hostname}: it resolves to a private address`), address as string, family);
        }
      }
      callback(null, address as string, family);
    });
  };
}

export const httpRequest: HttpClient = (url, options = {}) => {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000, maxBytes = 512 * 1024, allowInsecure = false } = options;

  return new Promise<HttpResult>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error(`invalid URL: ${url}`));
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return reject(new Error(`unsupported URL scheme: ${target.protocol}`));
    }
    if (target.protocol === 'http:' && !allowInsecure) {
      return reject(new Error(`refusing plain http URL ${target.origin} (set discovery.allow_insecure for local development)`));
    }
    if (target.username || target.password) return reject(new Error('URLs with credentials are not allowed'));

    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!allowInsecure && net.isIP(host) && isPrivateAddress(host)) {
      return reject(new Error(`refusing to connect to private address ${host}`));
    }

    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = lib.request(
      target,
      {
        method,
        headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
        lookup: guardedLookup(allowInsecure),
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`response from ${target.host} exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error(`request to ${target.host} timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`request to ${target.host} timed out after ${timeoutMs}ms`)));
    req.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.on('close', () => clearTimeout(deadline));
    if (payload) req.write(payload);
    req.end();
  });
};
