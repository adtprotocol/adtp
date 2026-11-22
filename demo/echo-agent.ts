/**
 * Side B: a scripted agent. For every request it receives it
 *   1. logs what arrived and what its node verified,
 *   2. marks the message read,
 *   3. replies on the same thread with an `inform`.
 *
 * It talks only to its own node (ADTP_NODE_URL) and never sees a signing key.
 *
 * It only sees messages that arrive after it started following its feed. It
 * says "ready" on its output once it does, and, if ADTP_READY_FILE names a
 * file, creates that file then: a container health check can wait for it.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { createAdtpTool } from '../integrations/stratus/adtp-tool.js';

const address = process.env.ADTP_ADDRESS ?? 'echo@demo.adtp.localhost';
const color = process.stdout.isTTY || process.env.FORCE_COLOR ? (code: number, s: string) => `\x1b[${code}m${s}\x1b[0m` : (_: number, s: string) => s;
const log = (line: string) => console.log(`${color(2, new Date().toISOString().slice(11, 23))}  ${color(35, address)}  ${line}`);

const readyFile = process.env.ADTP_READY_FILE;
if (readyFile) rmSync(readyFile, { force: true }); // left over from an earlier run of this container

const adtp = createAdtpTool({
  nodeUrl: process.env.ADTP_NODE_URL ?? 'http://localhost:7387',
  token: process.env.ADTP_AGENT_TOKEN ?? '',
  address,
  onError: (err) => log(color(31, `node unreachable, retrying: ${err.message}`)),
});

adtp.adtp_on_message(async (message) => {
  const sender = message.on_behalf_of ? `${message.from} acting for ${message.on_behalf_of}` : message.from;
  log(`${color(1, 'received')} ${message.intent} ${message.id} from ${sender}`);
  log(`  "${message.text}"`);
  log(color(32, `  signature verified (key ${message.verified?.signature})`));
  if (message.verified?.delegation) log(color(32, `  delegation verified (signed by ${message.verified.delegation})`));
  if (message.intent !== 'request') return; // answer requests only, so two echo agents cannot ping-pong forever

  await adtp.adtp_mark_read(message.id, message.from);
  log('marked read');

  const reply = await adtp.adtp_send(message.from, 'inform', `Received your ${message.intent}, signature verified for ${sender}.`, undefined, {
    thread: message.thread,
    in_reply_to: message.id,
  });
  log(`replied with ${reply.id} on ${reply.thread}`);
});

await adtp.whenReady();
if (readyFile) writeFileSync(readyFile, '');
log('ready: waiting for messages');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void adtp.stop().then(() => process.exit(0)));
