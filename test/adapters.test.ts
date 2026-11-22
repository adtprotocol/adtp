import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EmailAdapter, emailAddressOf, stripQuotedReply, summarizeData, type MailTransport } from '../src/adapters/email.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import type { DeliveredItem, RenderContext } from '../src/adapters/types.js';
import type { EmailChannelConfig, Route } from '../src/config.js';
import { backoffMs } from '../src/core/backoff.js';
import { selectRoute } from '../src/core/routing.js';
import { silentLogger } from '../src/log.js';
import { FakeAdapter, signedEnvelope, TestKeys } from './helpers.js';

const keys = new TestKeys();
const TOKEN = 'a'.repeat(32);

const emailConfig: EmailChannelConfig = {
  from: 'ADTP <adtp@b.test>',
  smtp: { host: 'smtp.test', port: 587, secure: false },
  inbound_token: 'hook-secret',
  reply_to: 'reply+{token}@in.b.test',
  read_receipts: true,
};

function recordingTransport() {
  const sent: Record<string, unknown>[] = [];
  const transport: MailTransport = {
    sendMail: async (mail) => {
      sent.push(mail);
      return { messageId: String(mail.messageId), response: '250 ok' };
    },
  };
  return { sent, transport };
}

const adapterWith = (cfg: Partial<EmailChannelConfig> = {}) => {
  const t = recordingTransport();
  return { ...t, adapter: new EmailAdapter({ ...emailConfig, ...cfg }, { domain: 'b.test', public_url: 'https://adtp.b.test' }, t.transport, silentLogger) };
};

const ctx: RenderContext = {
  recipient: 'bob@b.test',
  target: 'bob@mail.test',
  token: TOKEN,
  thread: 'thread-1',
  senderType: 'agent',
  principal: null,
  verified: { signature: keys.kid },
};

describe('routing', () => {
  const routes: Route[] = [
    { match: { priority: ['urgent'], sender_type: ['human'] }, default: false, channel: 'email', to: 'pager@x.test' },
    { match: { intent: ['approval.request', 'request'] }, default: false, channel: 'email', to: 'asks@x.test' },
    { match: { from_org: ['acme.test'] }, default: false, channel: 'email', to: 'acme@x.test' },
    { default: true, channel: 'email', to: 'inbox@x.test' },
  ];
  const facts = { priority: 'normal', intent: 'inform', from_org: 'other.test', sender_type: 'agent' as string | null };

  it('matches on priority, intent, from_org and sender_type', () => {
    assert.equal(selectRoute(routes, { ...facts, priority: 'urgent', sender_type: 'human' })?.to, 'pager@x.test');
    assert.equal(selectRoute(routes, { ...facts, intent: 'approval.request' })?.to, 'asks@x.test');
    assert.equal(selectRoute(routes, { ...facts, from_org: 'ACME.test' })?.to, 'acme@x.test');
  });

  it('requires every condition of a route to hold', () => {
    assert.equal(selectRoute(routes, { ...facts, priority: 'urgent', sender_type: 'agent' })?.to, 'inbox@x.test');
    assert.equal(selectRoute(routes, { ...facts, priority: 'urgent', sender_type: null })?.to, 'inbox@x.test');
  });

  it('takes the first matching route in order, then the default, then nothing', () => {
    assert.equal(selectRoute(routes, { ...facts, intent: 'request', from_org: 'acme.test' })?.to, 'asks@x.test');
    assert.equal(selectRoute(routes, facts)?.to, 'inbox@x.test');
    assert.equal(selectRoute(routes.slice(0, 3), facts), null);
    assert.equal(selectRoute([routes[3]!, routes[1]!], { ...facts, intent: 'request' })?.to, 'asks@x.test', 'the default is a fallback wherever it is listed');
  });
});

describe('backoff', () => {
  it('doubles per attempt up to the cap', () => {
    const noJitter = () => 1;
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffMs(n, 5, 3600, noJitter)), [5000, 10000, 20000, 40000, 80000]);
    assert.equal(backoffMs(30, 5, 3600, noJitter), 3_600_000);
    assert.equal(backoffMs(1000, 5, 3600, noJitter), 3_600_000);
  });

  it('jitters between half and all of the step', () => {
    assert.equal(backoffMs(3, 5, 3600, () => 0), 10000);
    assert.equal(backoffMs(3, 5, 3600, () => 0.5), 15000);
  });
});

describe('email adapter: render', () => {
  const message = signedEnvelope(
    {
      id: 'msg-1',
      thread: 'thread-1',
      from: 'helper@a.test',
      to: ['bob@b.test'],
      intent: 'request',
      priority: 'urgent',
      expires_at: '2026-07-01T00:00:00Z',
      requires_approval: true,
      parts: [
        { type: 'text', text: 'Can you approve the Q3 budget?\nIt is due Friday.' },
        { type: 'data', data: { amount: 12500, currency: 'USD', lines: [{ sku: 'A', qty: 2 }], note: 'x'.repeat(400) } },
        { type: 'file', url: 'https://files.a.test/budget.pdf', name: 'budget.pdf', media_type: 'application/pdf' },
      ],
    },
    keys,
  );

  it('puts the text first and summarizes structured data underneath', () => {
    const { adapter } = adapterWith();
    const mail = adapter.render(message, ctx);

    assert.ok(mail.text.startsWith('Can you approve the Q3 budget?\nIt is due Friday.\n\nDetails\n'), 'the message text opens the email');
    assert.match(mail.text, /amount: 12500/);
    assert.match(mail.text, /lines: \[\{"sku":"A","qty":2\}\]/);
    assert.match(mail.text, /Attachment: budget\.pdf \(application\/pdf\) https:\/\/files\.a\.test\/budget\.pdf/);
    assert.ok(!mail.text.includes('x'.repeat(200)), 'long values are abbreviated');
    assert.ok(mail.text.indexOf('Details') < mail.text.indexOf('From: helper@a.test (agent)'), 'facts come last');
    assert.match(mail.text, /Intent: request\nPriority: urgent\nExpires: 2026-07-01T00:00:00Z\nApproval: /);
    assert.match(mail.text, /Thread: thread-1\nMessage: msg-1/);
  });

  it('addresses and threads the email, and embeds the delivery token', () => {
    const { adapter } = adapterWith();
    const mail = adapter.render(message, ctx);
    assert.equal(mail.to, 'bob@mail.test');
    assert.deepEqual(mail.from, { name: 'helper@a.test via ADTP', address: 'adtp@b.test' });
    assert.equal(mail.subject, '[ADTP request] Can you approve the Q3 budget?');
    assert.equal(mail.messageId, `<adtp.${TOKEN}@b.test>`);
    assert.equal(mail.replyTo, `reply+${TOKEN}@in.b.test`);
    assert.equal(mail.headers['X-ADTP-Message-Id'], 'msg-1');
    assert.equal(mail.headers['X-ADTP-Thread'], 'thread-1');

    const other = adapter.render(signedEnvelope({ thread: 'thread-1', from: 'helper@a.test', to: ['bob@b.test'], text: 'again' }, keys), ctx);
    assert.deepEqual(other.references, mail.references, 'messages on one thread share a References id');
  });

  it('escapes HTML and adds the read beacon only when read receipts are on', () => {
    const hostile = signedEnvelope({ from: 'x@a.test', to: ['bob@b.test'], text: '<script>alert(1)</script> & "quotes"' }, keys);
    const on = adapterWith().adapter.render(hostile, ctx);
    assert.ok(!on.html.includes('<script>'));
    assert.match(on.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
    assert.match(on.html, new RegExp(`<img src="https://adtp\\.b\\.test/r/${TOKEN}\\.gif"`));

    const off = adapterWith({ read_receipts: false });
    assert.ok(!off.adapter.render(hostile, ctx).html.includes('<img'));
    assert.equal(off.adapter.capabilities().read_receipts, false);
  });

  it('names the principal when the sender acts on behalf of someone', () => {
    const mail = adapterWith().adapter.render(message, { ...ctx, principal: 'carol@a.test' });
    assert.match(mail.text, /From: helper@a\.test \(agent, on behalf of carol@a\.test\)/);
  });

  it('delivers through the transport and returns the native id', async () => {
    const { adapter, sent } = adapterWith();
    const receipt = await adapter.deliver(adapter.render(message, ctx));
    assert.equal(receipt.native_id, `<adtp.${TOKEN}@b.test>`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'bob@mail.test');
    assert.equal(sent[0]!.messageId, `<adtp.${TOKEN}@b.test>`);
  });

  it('reports its capabilities', () => {
    assert.deepEqual(adapterWith().adapter.capabilities(), { read_receipts: true, replies: true, structured_data: 'summarized', files: 'linked' });
    assert.equal(adapterWith({ inbound_token: undefined }).adapter.capabilities().replies, false);
  });
});

describe('email adapter: ingest', () => {
  const original = signedEnvelope({ id: 'msg-1', thread: 'thread-1', from: 'helper@a.test', to: ['bob@b.test'], text: 'ping' }, keys);
  const delivered: DeliveredItem = { message: original, thread: 'thread-1', recipient: 'bob@b.test', target: 'bob@mail.test', channel: 'email' };
  const lookup = { findDelivery: async (token: string) => (token === TOKEN ? delivered : null) };

  it('turns a reply into an ADTP message on the same thread', async () => {
    const { adapter } = adapterWith();
    const result = await adapter.ingest(
      {
        from: 'Bob Example <Bob@Mail.test>',
        subject: 'Re: [ADTP inform] ping',
        text: 'pong, thanks!\n\nOn Mon, 1 Jun 2026 at 12:00, helper@a.test via ADTP <adtp@b.test> wrote:\n> ping\n> more',
        headers: { 'In-Reply-To': `<adtp.${TOKEN}@b.test>`, 'Message-ID': '<reply-1@mail.test>' },
      },
      lookup,
    );
    assert.ok(result);
    assert.equal(result.draft.from, 'bob@b.test');
    assert.deepEqual(result.draft.to, ['helper@a.test']);
    assert.equal(result.draft.thread, 'thread-1');
    assert.equal(result.draft.intent, 'inform');
    assert.equal(result.draft.text, 'pong, thanks!');
    assert.deepEqual(result.in_reply_to, { message_id: 'msg-1', from: 'helper@a.test' });
    assert.match(result.draft.id ?? '', /^eml-[a-f0-9]{32}$/, 'a stable id makes redelivered webhooks idempotent');
  });

  it('also matches by the Reply-To plus-address or the References header', async () => {
    const { adapter } = adapterWith();
    const viaTo = await adapter.ingest({ from: 'bob@mail.test', to: `reply+${TOKEN}@in.b.test`, text: 'ok' }, lookup);
    const viaRefs = await adapter.ingest({ from: 'bob@mail.test', references: [`<other@x>`, `<adtp.${TOKEN}@b.test>`], text: 'ok' }, lookup);
    assert.equal(viaTo?.draft.thread, 'thread-1');
    assert.equal(viaRefs?.draft.thread, 'thread-1');
  });

  it('ignores mail that is not a reply to a delivery, or comes from the wrong mailbox', async () => {
    const { adapter } = adapterWith();
    assert.equal(await adapter.ingest({ from: 'bob@mail.test', text: 'hello out of the blue' }, lookup), null);
    assert.equal(await adapter.ingest({ from: 'bob@mail.test', in_reply_to: `<adtp.${'b'.repeat(32)}@b.test>`, text: 'x' }, lookup), null);
    assert.equal(await adapter.ingest({ from: 'mallory@evil.test', in_reply_to: `<adtp.${TOKEN}@b.test>`, text: 'x' }, lookup), null);
    assert.equal(await adapter.ingest({ from: 'bob@mail.test', in_reply_to: `<adtp.${TOKEN}@b.test>`, text: '   ' }, lookup), null);
    assert.equal(await adapter.ingest('not an object', lookup), null);
  });

  it('falls back to the HTML body when there is no text part', async () => {
    const { adapter } = adapterWith();
    const result = await adapter.ingest({ from: 'bob@mail.test', in_reply_to: `<adtp.${TOKEN}@b.test>`, html: '<div>Sounds <b>good</b></div><br>See you' }, lookup);
    assert.equal(result?.draft.text, 'Sounds good\n\nSee you');
  });

  it('authenticates webhooks by shared token', () => {
    const { adapter } = adapterWith();
    const request = (auth?: string, query = '') => ({ headers: auth ? { authorization: auth } : {}, query: new URLSearchParams(query), rawBody: '' });
    assert.equal(adapter.authenticate(request('Bearer hook-secret')), true);
    assert.equal(adapter.authenticate(request(undefined, 'token=hook-secret')), true);
    assert.equal(adapter.authenticate(request('Bearer wrong')), false);
    assert.equal(adapter.authenticate(request()), false);
    assert.equal(adapterWith({ inbound_token: undefined }).adapter.authenticate(request('Bearer ')), false);
  });
});

describe('email helpers', () => {
  it('strips quoted replies in common formats', () => {
    assert.equal(stripQuotedReply('Yes.\r\n\r\nOn Tue, Jun 2, 2026, Alice <a@a.test> wrote:\r\n> question?'), 'Yes.');
    assert.equal(stripQuotedReply('Sure\n\nOn Tue, Jun 2, 2026 at 9:00 AM Alice <a@a.test>\nwrote:\n> q'), 'Sure');
    assert.equal(stripQuotedReply('Done.\n\n-----Original Message-----\nFrom: a@a.test\nq'), 'Done.');
    assert.equal(stripQuotedReply('OK\n\nFrom: Alice <a@a.test>\nSent: Tuesday\nSubject: q'), 'OK');
    assert.equal(stripQuotedReply('Fine\n> quoted\n> more\n'), 'Fine');
    assert.equal(stripQuotedReply('Line one\n\nLine two'), 'Line one\n\nLine two');
    assert.equal(stripQuotedReply('> only a quote'), '> only a quote', 'never returns an empty reply');
  });

  it('extracts bare addresses and summarizes data parts', () => {
    assert.equal(emailAddressOf('Bob Example <Bob@Mail.test>'), 'bob@mail.test');
    assert.equal(emailAddressOf(' bob@mail.test '), 'bob@mail.test');
    assert.deepEqual(summarizeData([{ type: 'text', text: 'ignored' }, { type: 'data', data: { ok: true, n: null, s: 'two  words' } }]), [
      'ok: true',
      'n: null',
      's: two words',
    ]);
  });
});

describe('adapter registry', () => {
  it('instantiates registered channels that are configured', async () => {
    const registry = new AdapterRegistry();
    let seen: unknown;
    registry.register('chat', ({ config }) => {
      seen = config;
      return new FakeAdapter('chat');
    });
    await registry.init({ chat: { webhook: 'https://chat.test/hook' } }, { node: { domain: 'b.test', public_url: 'https://b.test' }, log: silentLogger });
    assert.equal(registry.get('CHAT')?.name, 'chat');
    assert.deepEqual(seen, { webhook: 'https://chat.test/hook' });
    assert.deepEqual(registry.names(), ['chat']);
    assert.throws(() => registry.register('chat', () => new FakeAdapter('chat')), /already registered/);
  });

  it('fails clearly when a configured channel has no adapter', async () => {
    const registry = new AdapterRegistry();
    await assert.rejects(
      registry.init({ slack: { token: 'x' } }, { node: { domain: 'b.test', public_url: 'https://b.test' }, log: silentLogger }),
      /no adapter named "slack" is registered/,
    );
  });

  it('loads plugins that register additional channels', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adtp-plugin-'));
    try {
      const file = path.join(dir, 'pager-plugin.mjs');
      writeFileSync(
        file,
        `export function register(registry) {
           registry.register('pager', ({ config }) => ({
             name: 'pager',
             capabilities: () => ({ read_receipts: false, replies: false, structured_data: 'dropped', files: 'dropped' }),
             render: (message, ctx) => ({ to: ctx.target, text: message.id, number: config.number }),
             deliver: async (payload) => ({ native_id: 'page-' + payload.number }),
             ingest: async () => null,
           }));
         }`,
      );
      const registry = new AdapterRegistry();
      await registry.loadPlugins([file]);
      await registry.init({ pager: { number: 7 } }, { node: { domain: 'b.test', public_url: 'https://b.test' }, log: silentLogger });
      const pager = registry.get('pager');
      assert.ok(pager);
      const payload = await pager.render(signedEnvelope({ id: 'm9', from: 'a@a.test', to: ['bob@b.test'] }, keys), ctx);
      assert.deepEqual(await pager.deliver(payload), { native_id: 'page-7' });

      const bad = path.join(dir, 'bad-plugin.mjs');
      writeFileSync(bad, 'export const nothing = 1;');
      await assert.rejects(new AdapterRegistry().loadPlugins([bad]), /must export a register/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
