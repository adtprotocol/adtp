/**
 * Scripted walkthrough of the two-node demo.
 *
 * Alice (alice.localhost) sends Bob (bob.localhost) a signed request. Bob has
 * never interacted with Alice, so it waits in his requests tray. Once
 * approved it is delivered by email (caught by Mailpit); Bob opens it and
 * replies, and each step flows back to Alice as a status update.
 *
 * Normally started by run.sh inside the walkthrough's Docker network. To run it
 * from the host against the published ports instead:
 *   ALICE_URL=http://localhost:7390 BOB_URL=http://localhost:7391 \
 *   MAILPIT_URL=http://localhost:8025 node dist/examples/email-tray/walkthrough.js
 */
import { AdtpClient, type DeliveryStatus } from '../../src/client.js';

const ALICE_URL = process.env.ALICE_URL ?? 'http://localhost:7390';
const BOB_URL = process.env.BOB_URL ?? 'http://localhost:7391';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const BOB_INBOUND_TOKEN = process.env.BOB_INBOUND_TOKEN ?? 'demo-inbound-bob';

const alice = new AdtpClient({ baseUrl: ALICE_URL, token: process.env.ALICE_TOKEN ?? 'demo-admin-alice' });
const bob = new AdtpClient({ baseUrl: BOB_URL, token: process.env.BOB_TOKEN ?? 'demo-admin-bob' });

let stepNumber = 0;
const step = (title: string) => console.log(`\n${++stepNumber}. ${title}`);
const show = (line: string) => console.log(`   ${line}`);
const indent = (text: string, prefix = '   | ') => text.split('\n').map((l) => prefix + l).join('\n');

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}
interface MailDetail extends MailSummary {
  From: { Name: string; Address: string };
  Text: string;
}

/** Finds the newest caught email to `address` whose subject or body mentions `needle`. */
async function findMail(address: string, needle: string): Promise<{ mail: MailDetail; raw: string } | null> {
  const list = await json<{ messages: MailSummary[] }>(`${MAILPIT_URL}/api/v1/messages?limit=50`);
  for (const summary of list.messages) {
    if (!summary.To.some((t) => t.Address === address)) continue;
    const mail = await json<MailDetail>(`${MAILPIT_URL}/api/v1/message/${summary.ID}`);
    const raw = await (await fetch(`${MAILPIT_URL}/api/v1/message/${summary.ID}/raw`)).text();
    if (mail.Text.includes(needle) || raw.includes(needle)) return { mail, raw };
  }
  return null;
}

const sentCopy = async (id: string): Promise<DeliveryStatus | undefined> =>
  (await alice.status(id)).copies.find((c) => c.direction === 'out')?.deliveries[0];

async function main(): Promise<void> {
  console.log('ADTP demo: alice@alice.localhost -> bob@bob.localhost');

  step('Both nodes are up, each with its own keys and database');
  for (const [name, url] of [['alice', ALICE_URL], ['bob', BOB_URL]] as const) {
    const health = await until(`${name}'s node`, () => json<{ status: string; domain: string }>(`${url}/healthz`));
    const card = await json<{ address: string; endpoint: string; keys: { kid: string }[] }>(`${url}/.well-known/adtp/${name}`);
    show(`${health.domain}: card for ${card.address} -> endpoint ${card.endpoint}, key ${card.keys[0]?.kid}`);
  }

  step('Alice sends Bob a signed request');
  const text = 'Hi Bob, can you review the launch plan before Friday?';
  const sent = await alice.send({
    from: 'alice@alice.localhost',
    to: 'bob@bob.localhost',
    intent: 'request',
    text,
    data: { document: 'launch-plan-v3', pages: 12, due: 'Friday' },
  });
  show(`message id ${sent.id}`);
  show("Alice's node resolved Bob's card, signed the envelope (Ed25519) and posted it to the endpoint in that card. Bob's node answered with a signed receipt.");
  const afterSend = await until("Bob's node to acknowledge", async () => {
    const d = await sentCopy(sent.id);
    return d && d.state !== 'pending' ? d : null;
  });
  show(`state on Alice's node: ${afterSend.state}`);

  const tray = await bob.request<{ items: { id: string; from: string; intent: string; text: string }[] }>('GET', '/api/v0/tray');
  const held = tray.items.find((i) => i.id === sent.id);
  if (held) {
    step("Bob has never interacted with Alice, so the message waits in Bob's requests tray");
    show(`in the tray: ${held.intent} from ${held.from}: "${held.text}"`);
    show(`emails to bob@example.com so far: ${(await findMail('bob@example.com', sent.id)) ? 1 : 0}`);

    step('Bob approves: deliver this message and trust Alice from now on');
    const approved = await bob.request<{ released: number }>('POST', '/api/v0/tray/approve', { id: sent.id, recipient: 'bob@bob.localhost' });
    show(`approved; ${approved.released} message(s) released for delivery`);
  } else {
    step('Bob already trusts Alice, so the message skips the requests tray');
    show('This state is left over from an earlier run. `bash examples/email-tray/run.sh` without --keep starts clean and shows the tray.');
  }

  step("Bob's node routes the message to his email channel and sends it over SMTP");
  const delivered = await until('the email to reach Mailpit', () => findMail('bob@example.com', sent.id));
  show(`From:    ${delivered.mail.From.Name} <${delivered.mail.From.Address}>`);
  show(`To:      ${delivered.mail.To.map((t) => t.Address).join(', ')}`);
  show(`Subject: ${delivered.mail.Subject}`);
  console.log(indent(delivered.mail.Text.trimEnd()));
  await until("the 'delivered' status", async () => (await sentCopy(sent.id))?.state === 'delivered');
  show("status update received by Alice's node: delivered");

  step('Bob opens the email (his mail client loads the read-receipt image)');
  const token = /adtp\.([a-f0-9]{32})@bob\.localhost/.exec(delivered.raw)?.[1];
  if (!token) throw new Error('could not find the delivery token in the email');
  await fetch(`${BOB_URL}/r/${token}.gif`);
  await until("the 'read' status", async () => (await sentCopy(sent.id))?.state === 'read');
  show("status update received by Alice's node: read");

  step("Bob replies by email; his mail provider hands the reply to the node's inbound webhook");
  const replyText = 'Happy to. I will send comments by Thursday.';
  const hook = await fetch(`${BOB_URL}/hooks/email`, {
    method: 'POST',
    headers: { authorization: `Bearer ${BOB_INBOUND_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Bob <bob@example.com>',
      to: `reply+${token}@bob.localhost`,
      subject: `Re: ${delivered.mail.Subject}`,
      text: `${replyText}\n\nOn Friday, alice@alice.localhost via ADTP wrote:\n> ${text}`,
      headers: { 'In-Reply-To': `<adtp.${token}@bob.localhost>`, 'Message-ID': `<demo-reply-${sent.id}@example.com>` },
    }),
  });
  if (hook.status !== 202) throw new Error(`the inbound webhook answered HTTP ${hook.status}`);
  const reply = (await hook.json()) as { id: string };
  show(`reply became ADTP message ${reply.id} on the same thread`);
  const final = await until("the 'replied' status", async () => {
    const d = await sentCopy(sent.id);
    return d?.state === 'replied' ? d : null;
  });
  show("status update received by Alice's node: replied");
  show(`timeline: delivered ${final.delivered_at}, read ${final.read_at}, replied ${final.replied_at}`);

  step("Bob's reply is delivered to Alice by email (no tray: she wrote to him first)");
  const replyMail = await until("Bob's reply to reach Alice's inbox", () => findMail('alice@example.com', replyText));
  show(`To:      ${replyMail.mail.To.map((t) => t.Address).join(', ')}`);
  show(`Subject: ${replyMail.mail.Subject}`);

  step("The whole conversation, as stored on Alice's node");
  const thread = await alice.request<{ messages: { direction: string; from: string; intent: string; text: string; receipt_for: string | null }[] }>(
    'GET',
    `/api/v0/threads/${sent.thread}`,
  );
  for (const m of thread.messages) {
    show(`${m.direction === 'out' ? 'sent    ' : 'received'}  ${m.intent.padEnd(8)} ${m.from.padEnd(22)} ${m.receipt_for ? `[status update] ${m.text}` : m.text}`);
  }

  console.log('\nDone: signed send, requests tray, approval, email delivery, and delivered/read/replied status updates all worked.');
}

main().catch((err: Error) => {
  console.error(`\nDemo failed: ${err.message}`);
  process.exit(1);
});
