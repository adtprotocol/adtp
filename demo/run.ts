/**
 * The demo driver: plays the Stratus agent's part through the same ADTP tool
 * the real agent uses, and prints a timestamped transcript of everything that
 * happens. Also writes the transcript to transcript.md and transcript.json.
 *
 *   node dist/demo/run.js            send the demo message and follow it to the reply
 *   node dist/demo/run.js --tamper   corrupt one byte in transit and show Side B rejecting it
 *   node dist/demo/run.js --watch    do not send; transcribe the next message the real agent sends
 *
 * Environment: STRATUS_NODE_URL, STRATUS_TOKEN (Side A's agent token),
 * FROM_ADDRESS, TO_ADDRESS, OUT_DIR (where transcripts go), TIMEOUT_MS,
 * MAX_SECONDS (fail if slower).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAdtpTool, type AdtpMessage, type AdtpStatus } from '../integrations/stratus/adtp-tool.js';
import { ADTP_CONTENT_TYPE } from '../src/protocol/constants.js';
import { parseResponse } from '../src/protocol/wire.js';
import type { Envelope, ResolvedCard } from '../src/protocol/types.js';

const NODE_URL = process.env.STRATUS_NODE_URL ?? 'http://localhost:7388';
const TOKEN = process.env.STRATUS_TOKEN ?? '';
const FROM = process.env.FROM_ADDRESS ?? 'agent@stratuslabs.localhost';
const TO = process.env.TO_ADDRESS ?? 'echo@demo.adtp.localhost';
const OUT_DIR = process.env.OUT_DIR ?? path.join(process.cwd(), 'demo');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? '30000');
const MAX_SECONDS = process.env.MAX_SECONDS ? Number(process.env.MAX_SECONDS) : null;
const MODE: 'send' | 'tamper' | 'watch' = process.argv.includes('--tamper') ? 'tamper' : process.argv.includes('--watch') ? 'watch' : 'send';

const TEXT = 'Hello from Stratus Labs. This is the first ADTP message. Please confirm receipt.';

// ---- transcript ---------------------------------------------------------------------------

type Actor = 'stratus' | 'side-b';

interface Entry {
  /** When it happened, ISO 8601. For Side B's steps this is Side B's own clock. */
  at: string;
  /** Milliseconds since the run started (discovery included), as observed on Side A. */
  elapsed_ms: number;
  actor: Actor;
  step: string;
  text: string;
  detail?: unknown;
}

const useColor = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const ACTOR_COLOR: Record<Actor, string> = { stratus: '36', 'side-b': '35' };

const entries: Entry[] = [];
let startedAt = Date.now();

function record(actor: Actor, step: string, text: string, opts: { at?: string; detail?: unknown; ok?: boolean; bad?: boolean } = {}): void {
  const entry: Entry = { at: opts.at ?? new Date().toISOString(), elapsed_ms: Date.now() - startedAt, actor, step, text };
  if (opts.detail !== undefined) entry.detail = opts.detail;
  entries.push(entry);
  const body = opts.bad ? paint('31', text) : opts.ok ? paint('32', text) : text;
  console.log(
    `${paint('2', entry.at.slice(11, 23))}  ${paint('2', `+${(entry.elapsed_ms / 1000).toFixed(3)}s`)}  ` +
      `${paint(ACTOR_COLOR[actor], actor.padEnd(7))}  ${paint('1', step.padEnd(9))}  ${body}`,
  );
}

const block = (text: string) => console.log(text.split('\n').map((l) => paint('2', '    │ ') + l).join('\n'));

const shorten = (value: string, keep = 16) => (value.length > keep * 2 + 3 ? `${value.slice(0, keep)}…${value.slice(-8)}` : value);

/** The envelope as shown on screen and in transcript.md: signature and delegation token shortened. */
function forDisplay(envelope: Envelope): Record<string, unknown> {
  return {
    ...envelope,
    ...(envelope.delegation ? { delegation: shorten(envelope.delegation) } : {}),
    signature: { ...envelope.signature, value: shorten(envelope.signature.value) },
  };
}

// ---- steps -----------------------------------------------------------------------------------

const adtp = createAdtpTool({ nodeUrl: NODE_URL, token: TOKEN, address: FROM, onError: () => {} });

/** Waits until the node answers, and returns the time by the node's own clock (from its Date header; this machine's if it sends none). */
async function waitForNode(): Promise<number> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${NODE_URL}/healthz`);
      if (res.ok) {
        const nodeTime = Date.parse(res.headers.get('date') ?? '');
        return Number.isNaN(nodeTime) ? Date.now() : nodeTime;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`the Stratus node at ${NODE_URL} is not answering`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function discover(): Promise<ResolvedCard> {
  let card: ResolvedCard;
  try {
    card = await adtp.api<ResolvedCard>('GET', `/api/v0/resolve?address=${encodeURIComponent(TO)}&fresh=true`);
  } catch (err) {
    throw new Error(
      `${TO} could not be discovered. Is the other side's node up, and is its _adtp TXT record (or its well-known URL) published?\n  ${(err as Error).message}`,
    );
  }
  const via = card.resolved;
  if (via?.dns_record) {
    record('stratus', 'discover', `DNS  ${via.dns_record.name}  TXT  "${via.dns_record.value}"`, { detail: via });
  } else if (via?.method === 'well-known') {
    record('stratus', 'discover', `no _adtp TXT record for ${TO.split('@')[1]}; using the well-known fallback`, { detail: via });
  } else if (via?.method === 'override') {
    record('stratus', 'discover', `local mode: discovery override for ${TO.split('@')[1]} (no DNS lookup)`, { detail: via });
  }
  record('stratus', 'card', `${via?.card_url ?? '(local)'}  →  endpoint ${card.endpoint}, key ${card.keys.map((k) => k.kid).join(', ')}`, {
    detail: { address: card.address, type: card.type, endpoint: card.endpoint, keys: card.keys, accepts: card.accepts, max_bytes: card.max_bytes, acts_for: card.acts_for },
  });
  return card;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** When a message was created, read off its id: in msg_<ulid> the first ten characters are the time. Null for an id of another shape. */
function createdAt(messageId: string): number | null {
  const ulid = /^msg_([0-9A-HJKMNP-TV-Z]{10})[0-9A-HJKMNP-TV-Z]{16}$/.exec(messageId);
  if (!ulid) return null;
  let ms = 0;
  for (const char of ulid[1]!) ms = ms * 32 + ULID_ALPHABET.indexOf(char);
  return ms;
}

function showEnvelope(envelope: Envelope, label: string): void {
  record('stratus', 'envelope', label, { detail: forDisplay(envelope) });
  block(JSON.stringify(forDisplay(envelope), null, 2));
}

interface Outcome {
  ok: boolean;
  summary: string;
  elapsed_ms: number;
  envelope?: Envelope;
  reply?: AdtpMessage;
  statuses: Record<string, string>;
}

/**
 * Sends (or, with --watch, waits for the real agent to send) and follows the
 * message to its reply. `since` is the node's clock when the run began: with
 * --watch, a status for a message created before that belongs to an earlier
 * message (a late "failed" or "read", say) and is not the one being waited for.
 */
async function sendAndFollow(since: number): Promise<Outcome> {
  const statuses: Record<string, string> = {};
  let messageId: string | null = null;
  let thread: string | null = null;
  let reply: AdtpMessage | undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const check = () => {
    if (statuses.accepted && statuses.delivered && statuses.read && reply) finish?.();
  };

  // Events can arrive before the send call has even returned. They are held
  // until the envelope is on screen, so the transcript reads in causal order.
  let live = false;
  const held: (() => void)[] = [];
  const whenLive = (fn: () => void) => (live ? fn() : void held.push(fn));
  let sawFirst: ((s: AdtpStatus) => void) | undefined;
  const firstStatus = new Promise<AdtpStatus>((resolve) => (sawFirst = resolve));

  const onStatus = (s: AdtpStatus) => {
    if (s.message_id !== messageId) return;
    statuses[s.status] = s.at;
    const failed = ['rejected', 'failed', 'expired'].includes(s.status);
    let text = '';
    if (s.status === 'accepted' || s.status === 'queued') {
      text = s.verified ? `signature verified (key ${s.verified.signature})` : 'envelope stored';
      if (s.verified?.delegation) text += `; delegation verified: ${FROM} acts for ${s.verified.delegation}`;
      if (s.receipt) text += `; signed receipt from ${s.receipt.by} checked`;
      if (s.status === 'queued') text += '; held for approval (the sender is not on the allowlist)';
    } else if (s.status === 'delivered') text = `handed to ${s.recipient}`;
    else if (s.status === 'read') text = `${s.recipient} marked it read`;
    else if (s.status === 'replied') text = `${s.recipient} answered`;
    else text = s.reason ? `${s.reason.code}: ${s.reason.message}` : (s.detail ?? '');
    // "failed" and "expired" are Side A's own node giving up; everything else is reported by Side B.
    const actor: Actor = s.status === 'failed' || s.status === 'expired' ? 'stratus' : 'side-b';
    record(actor, s.status, text, { at: s.at, detail: s, ok: !failed, bad: failed });
    // A failure ends the run; so does a message parked in the requests tray, which waits for a person.
    if (failed || s.status === 'queued') finish?.();
    check();
  };
  const onMessage = (m: AdtpMessage) => {
    if (m.thread !== thread) return;
    reply = m;
    record('side-b', 'reply', `${m.intent} from ${m.from} on ${m.thread}`, { at: m.at, detail: m });
    block(`"${m.text}"`);
    if (m.verified) record('stratus', 'verify', `reply signature verified (key ${m.verified.signature})`, { ok: true });
    check();
  };

  adtp.adtp_on_status((s) => {
    const created = createdAt(s.message_id);
    if (created === null || created >= since) sawFirst?.(s);
    whenLive(() => onStatus(s));
  });
  adtp.adtp_on_message((m) => whenLive(() => onMessage(m)));
  await adtp.whenReady();

  if (MODE === 'watch') {
    console.log(paint('2', `Waiting for ${FROM} to send a message (ask the Stratus agent to use adtp_send)…\n`));
    const first = await firstStatus;
    startedAt = Date.now();
    messageId = first.message_id;
    thread = first.thread;
    record('stratus', 'send', `the Stratus agent sent ${messageId} on ${thread}`);
  } else {
    const sent = await adtp.adtp_send(TO, 'request', TEXT, { type: 'demo.ping', sent_at: new Date().toISOString() });
    messageId = sent.id;
    thread = sent.thread;
    record('stratus', 'send', `adtp_send → ${sent.id} on ${sent.thread}`, { detail: sent });
  }

  const stored = await adtp.api<{ copies: { direction: string; envelope: Envelope }[] }>('GET', `/api/v0/messages/${messageId}`);
  const envelope = stored.copies.find((c) => c.direction === 'out')?.envelope;
  if (envelope) showEnvelope(envelope, `signed by the node for ${FROM}`);
  live = true;
  for (const fn of held.splice(0)) fn();

  // A message the other side cannot accept yet is retried quietly by the node. Say why, early,
  // rather than leaving the operator to wait for the timeout.
  const stuck = async (): Promise<string | null> => {
    const copy = await adtp.api<{ copies: { direction: string; deliveries: { state: string; attempts: number; last_error: string | null }[] }[] }>(
      'GET',
      `/api/v0/messages/${messageId}`,
    );
    const d = copy.copies.find((c) => c.direction === 'out')?.deliveries[0];
    return d && d.state === 'pending' && d.last_error ? `attempt ${d.attempts} did not get through; the node will retry: ${d.last_error}` : null;
  };
  const early = setTimeout(() => {
    if (Object.keys(statuses).length > 0) return;
    void stuck().then((why) => why && record('stratus', 'retrying', why, { bad: true }), () => {});
  }, Math.min(3000, TIMEOUT_MS / 2));

  const timedOut = await Promise.race([done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), TIMEOUT_MS))]);
  clearTimeout(early);
  const lastError = timedOut ? await stuck().catch(() => null) : null;
  const elapsed_ms = entries.at(-1)?.elapsed_ms ?? Date.now() - startedAt;

  const missing = ['accepted', 'delivered', 'read'].filter((s) => !statuses[s]);
  const sameThread = reply?.thread === thread;
  const ok = !timedOut && missing.length === 0 && Boolean(reply) && sameThread;
  let summary: string;
  if (ok) summary = `accepted, delivered, read, and a reply on the same thread in ${(elapsed_ms / 1000).toFixed(2)}s`;
  else if (statuses.queued) summary = `Side B stored the message but is holding it for approval: ${FROM} is not on ${TO}'s trusted list`;
  else if (timedOut) {
    summary = `timed out after ${TIMEOUT_MS / 1000}s; missing: ${[...missing, ...(reply ? [] : ['reply'])].join(', ') || 'nothing'}`;
    if (lastError) summary += `\n  ${lastError}`;
  }
  else summary = `the message did not complete: ${Object.keys(statuses).join(', ') || 'no status received'}`;
  return { ok, summary, elapsed_ms, envelope, reply, statuses };
}

/** Signs the demo message, corrupts one byte as an attacker in transit would, and posts it to Side B. */
async function tamper(card: ResolvedCard): Promise<Outcome> {
  const signed = await adtp.api<{ envelope: Envelope }>('POST', '/api/v0/messages', {
    from: FROM,
    to: TO,
    intent: 'request',
    text: TEXT,
    data: { type: 'demo.ping', sent_at: new Date().toISOString() },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    dry_run: true,
  });
  showEnvelope(signed.envelope, `signed by the node for ${FROM} (not sent)`);

  // Flip the lowest bit of one byte of the message text: "Hello" becomes "Iello".
  const bytes = Buffer.from(JSON.stringify(signed.envelope), 'utf8');
  const offset = bytes.indexOf(TEXT);
  if (offset < 0) throw new Error('could not find the message text in the envelope');
  const before = bytes.subarray(offset, offset + 5).toString();
  bytes[offset] = bytes[offset]! ^ 0x01;
  const tampered = JSON.parse(bytes.toString('utf8')) as Envelope;
  record('stratus', 'tamper', `one byte changed in transit: "${before}…" → "${bytes.subarray(offset, offset + 5).toString()}…" (signature untouched)`, {
    detail: { byte_offset: offset, before, after: bytes.subarray(offset, offset + 5).toString() },
  });

  const res = await fetch(card.endpoint, {
    method: 'POST',
    headers: { 'content-type': ADTP_CONTENT_TYPE },
    body: JSON.stringify(tampered),
  });
  const body = await res.text();
  const answer = parseResponse(res.status, Object.fromEntries(res.headers), body);
  const refused = answer.kind === 'refused';
  record(
    'side-b',
    refused ? 'rejected' : 'error',
    refused ? `HTTP ${res.status}  ${answer.reason.code}: ${answer.reason.message}` : `unexpected answer: HTTP ${res.status} with a receipt`,
    { detail: { http_status: res.status, body: JSON.parse(body) as unknown }, ok: false, bad: true },
  );
  const ok = refused && answer.reason.code === 'bad_signature';
  return {
    ok,
    summary: ok ? 'Side B refused the tampered envelope: the signature no longer matches' : 'Side B did NOT reject the tampered envelope with a signature error',
    elapsed_ms: Date.now() - startedAt,
    envelope: tampered,
    statuses: {},
  };
}

// ---- output files --------------------------------------------------------------------------------

function writeTranscripts(card: ResolvedCard, outcome: Outcome): string[] {
  const name = MODE === 'tamper' ? 'transcript.tamper' : 'transcript';
  const title = MODE === 'tamper' ? 'ADTP v0 demo: a tampered message is rejected' : 'ADTP v0 demo: one signed message, end to end';
  const json = {
    demo: 'adtp-v0',
    mode: MODE,
    from: FROM,
    to: TO,
    result: { ok: outcome.ok, summary: outcome.summary, elapsed_ms: outcome.elapsed_ms, statuses: outcome.statuses },
    discovery: card,
    envelope: outcome.envelope ?? null,
    reply: outcome.reply ?? null,
    timeline: entries,
  };

  const rows = entries.map((e) => `| ${e.at.slice(11, 23)} | +${(e.elapsed_ms / 1000).toFixed(3)}s | ${e.actor} | ${e.step} | ${e.text.replace(/\|/g, '\\|')} |`);
  const md = [
    `# ${title}`,
    '',
    `\`${FROM}\` → \`${TO}\``,
    '',
    `**Result:** ${outcome.ok ? '✅' : '❌'} ${outcome.summary}`,
    '',
    '## Timeline',
    '',
    '| Time (UTC) | Elapsed | Side | Step | What happened |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    ...(outcome.envelope
      ? [`## The ${MODE === 'tamper' ? 'tampered ' : ''}envelope`, '', 'Signature and delegation token shortened for display.', '', '```json', JSON.stringify(forDisplay(outcome.envelope), null, 2), '```', '']
      : []),
    ...(outcome.reply ? ['## The reply', '', `From \`${outcome.reply.from}\` on thread \`${outcome.reply.thread}\`:`, '', `> ${outcome.reply.text}`, ''] : []),
  ].join('\n');

  mkdirSync(OUT_DIR, { recursive: true });
  const files = [path.join(OUT_DIR, `${name}.md`), path.join(OUT_DIR, `${name}.json`)];
  writeFileSync(files[0]!, md);
  writeFileSync(files[1]!, JSON.stringify(json, null, 2) + '\n');
  return files;
}

// ---- main -----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(paint('1', `ADTP v0 demo${MODE === 'tamper' ? ' (tamper test)' : ''}`) + `  ${paint('36', FROM)} → ${paint('35', TO)}\n`);
  const nodeTime = await waitForNode();
  startedAt = Date.now();
  const card = await discover();
  const outcome = MODE === 'tamper' ? await tamper(card) : await sendAndFollow(nodeTime);
  await adtp.stop();

  let ok = outcome.ok;
  let summary = outcome.summary;
  if (ok && MAX_SECONDS !== null && outcome.elapsed_ms > MAX_SECONDS * 1000) {
    ok = false;
    summary += ` (slower than the ${MAX_SECONDS}s budget)`;
  }
  console.log('\n' + (ok ? paint('32', `✓ ${summary}`) : paint('31', `✗ ${summary}`)));

  try {
    const files = writeTranscripts(card, { ...outcome, ok, summary });
    console.log(paint('2', `transcript written to ${files.join(' and ')}`));
  } catch (err) {
    console.log(paint('33', `could not write transcript files to ${OUT_DIR}: ${(err as Error).message}`));
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err: Error) => {
  console.error(paint('31', `\nDemo failed: ${err.message}`));
  process.exit(1);
});
