/**
 * Server-rendered HTML for the admin pages: requests tray, inbox, thread view.
 * No client-side JavaScript; every dynamic value is HTML-escaped.
 */
import { summarizeData } from '../adapters/email.js';
import { INBOX_CHANNEL } from '../config.js';
import type { HeldItem, MessageView } from '../core/store.js';
import { textOf } from '../protocol/envelope.js';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { --bg:#f6f5f2; --panel:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e2dfd8; --accent:#1f5f4a; --accent-ink:#fff; --warn:#8a3b12; --chip:#eeece6; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161614; --panel:#1f1f1c; --ink:#ecebe6; --muted:#a09d95; --line:#33322e; --accent:#58b596; --accent-ink:#10231c; --warn:#e2a274; --chip:#2a2a26; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
header { border-bottom:1px solid var(--line); background:var(--panel); }
.bar { max-width:960px; margin:0 auto; padding:12px 16px; display:flex; flex-wrap:wrap; gap:8px 20px; align-items:center; }
.brand { font-weight:650; letter-spacing:.01em; }
.brand small { font-weight:400; color:var(--muted); margin-left:6px; }
nav { display:flex; gap:4px; flex:1; }
nav a { padding:5px 10px; border-radius:6px; color:var(--ink); text-decoration:none; }
nav a.on { background:var(--chip); font-weight:600; }
main { max-width:960px; margin:0 auto; padding:20px 16px 48px; }
h1 { font-size:20px; margin:0 0 4px; }
p.lede { margin:0 0 18px; color:var(--muted); }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:0 0 12px; }
.meta { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--muted); font-size:13px; margin-bottom:8px; }
.meta b { color:var(--ink); font-weight:600; }
.chip { display:inline-block; padding:1px 8px; border-radius:999px; background:var(--chip); font-size:12px; font-weight:600; white-space:nowrap; }
.chip.warn { color:var(--warn); }
.chip.good { color:var(--accent); }
.body { white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 8px; }
.data { white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.45 ui-monospace,Menlo,Consolas,monospace; color:var(--muted); margin:0 0 8px; }
.actions { display:flex; gap:8px; margin-top:10px; }
form { margin:0; }
button { font:inherit; font-weight:600; padding:6px 14px; border-radius:7px; border:1px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
button:focus-visible, a:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th { text-align:left; font-weight:600; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
th { white-space:nowrap; }
th, td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
td.msg { overflow-wrap:anywhere; min-width:14em; }
th:first-child, td:first-child { padding-left:0; }
th:last-child, td:last-child { padding-right:0; }
td.nowrap { white-space:nowrap; }
td a { color:var(--accent); }
.empty { color:var(--muted); padding:28px 0; text-align:center; }
.login { max-width:380px; margin:12vh auto 0; }
input[type=password] { width:100%; font:inherit; padding:8px 10px; border-radius:7px; border:1px solid var(--line); background:var(--panel); color:var(--ink); margin:6px 0 12px; }
.error { color:var(--warn); margin:0 0 10px; }
.flash { border-left:3px solid var(--accent); padding:8px 12px; background:var(--panel); margin:0 0 16px; border-radius:4px; }
.inbox { border-top:1px solid var(--line); margin-top:12px; padding-top:12px; }
.inbox form.reply { display:flex; flex-direction:column; gap:8px; align-items:flex-start; margin-top:8px; }
textarea { width:100%; font:inherit; padding:8px 10px; border-radius:7px; border:1px solid var(--line); background:var(--bg); color:var(--ink); resize:vertical; }
textarea:focus-visible, select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
form.compose { display:flex; flex-direction:column; gap:14px; align-items:flex-start; max-width:640px; }
form.compose label { display:flex; flex-direction:column; gap:4px; width:100%; font-weight:600; font-size:13px; color:var(--muted); }
input[type=text], select { width:100%; font:inherit; padding:8px 10px; border-radius:7px; border:1px solid var(--line); background:var(--bg); color:var(--ink); }
`;

type Tab = 'tray' | 'inbox' | 'compose' | 'none';

function page(title: string, domain: string, tab: Tab, content: string, signedIn = true): string {
  const nav = signedIn
    ? `<nav aria-label="Sections">
        <a href="/admin/tray"${tab === 'tray' ? ' class="on" aria-current="page"' : ''}>Requests</a>
        <a href="/admin/inbox"${tab === 'inbox' ? ' class="on" aria-current="page"' : ''}>Inbox</a>
        <a href="/admin/compose"${tab === 'compose' ? ' class="on" aria-current="page"' : ''}>New message</a>
      </nav>
      <form method="post" action="/admin/logout"><button type="submit">Sign out</button></form>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ADTP ${esc(domain)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><div class="bar"><span class="brand">ADTP node<small>${esc(domain)}</small></span>${nav}</div></header>
<main>${content}</main>
</body>
</html>`;
}

function when(value: Date | string | null): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function stateChip(state: string): string {
  const cls = ['delivered', 'read', 'replied', 'sent'].includes(state)
    ? ' good'
    : ['failed', 'rejected', 'expired', 'held'].includes(state)
      ? ' warn'
      : '';
  const label = state === 'held' ? 'awaiting approval' : state;
  return `<span class="chip${cls}">${esc(label)}</span>`;
}

export function loginPage(domain: string, error?: string): string {
  return page(
    'Sign in',
    domain,
    'none',
    `<div class="login card">
      <h1>Sign in</h1>
      <p class="lede">Enter this node's admin token.</p>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      <form method="post" action="/admin/login">
        <label for="token">Admin token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
        <button class="primary" type="submit">Sign in</button>
      </form>
    </div>`,
    false,
  );
}

export function trayPage(domain: string, items: HeldItem[], flash?: string): string {
  const cards = items
    .map(({ delivery, message }) => {
      const text = textOf(message.envelope.content);
      const data = summarizeData(message.envelope.content.parts);
      const hidden = `<input type="hidden" name="id" value="${esc(message.id)}"><input type="hidden" name="recipient" value="${esc(delivery.recipient)}"><input type="hidden" name="from" value="${esc(message.from_addr)}">`;
      return `<article class="card">
        <div class="meta">
          <span><b>${esc(message.from_addr)}</b>${message.sender_type ? ` (${esc(message.sender_type)})` : ''}${message.principal ? ` for <b>${esc(message.principal)}</b>` : ''}</span>
          <span>to <b>${esc(delivery.recipient)}</b></span>
          <span class="chip">${esc(message.intent)}</span>
          <span>priority ${esc(message.priority)}</span>
          <span>received ${esc(when(message.created_at))}</span>
          ${message.expires_at ? `<span class="chip warn">expires ${esc(when(message.expires_at))}</span>` : ''}
        </div>
        <p class="body">${esc(text.length > 4000 ? text.slice(0, 4000) + '…' : text)}</p>
        ${data.length > 0 ? `<p class="data">${esc(data.join('\n'))}</p>` : ''}
        <div class="actions">
          <form method="post" action="/admin/tray/approve">${hidden}<button class="primary" type="submit">Approve and trust sender</button></form>
          <form method="post" action="/admin/tray/reject">${hidden}<button type="submit">Reject</button></form>
        </div>
      </article>`;
    })
    .join('\n');
  return page(
    'Requests',
    domain,
    'tray',
    `<h1>Requests</h1>
     <p class="lede">First-contact messages from senders your addresses have not interacted with. Approving delivers the message and trusts the sender from now on.</p>
     ${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
     ${cards || '<p class="empty">Nothing is waiting for approval.</p>'}`,
  );
}

export function inboxPage(domain: string, messages: MessageView[]): string {
  const rows = messages
    .map((m) => {
      const text = textOf(m.envelope.content);
      const states = m.deliveries
        .map((d) => `${stateChip(d.state)}${m.deliveries.length > 1 ? ` <small>${esc(d.recipient)}</small>` : ''}`)
        .join('<br>');
      return `<tr>
        <td class="nowrap">${esc(when(m.created_at))}</td>
        <td class="nowrap">${m.direction === 'in' ? 'received' : 'sent'}</td>
        <td>${esc(m.from_addr)}<br><small>to ${esc(m.to_addrs.join(', '))}</small></td>
        <td><span class="chip">${esc(m.intent)}</span></td>
        <td class="msg"><a href="/admin/threads/${encodeURIComponent(m.thread_id)}">${esc(text.length > 90 ? text.slice(0, 90) + '…' : text)}</a></td>
        <td class="nowrap">${states}</td>
      </tr>`;
    })
    .join('\n');
  return page(
    'Inbox',
    domain,
    'inbox',
    `<h1>Inbox</h1>
     <p class="lede">The most recent messages this node sent and received, with delivery status. Open one to see its whole thread.</p>
     ${
       rows
         ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Direction</th><th>From</th><th>Intent</th><th>Message</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
         : '<p class="empty">No messages yet.</p>'
     }`,
  );
}

/** What the compose form was last submitted with, to show again when it could not be sent. */
export interface ComposeValues {
  from?: string;
  to?: string;
  intent?: string;
  text?: string;
}

/** A form to write a first message from one of this node's addresses. Answers are written on the thread page. */
export function composePage(domain: string, addresses: string[], intents: readonly string[], values: ComposeValues = {}, error?: string): string {
  const option = (value: string, chosen: string | undefined) => `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(value)}</option>`;
  return page(
    'New message',
    domain,
    'compose',
    `<h1>New message</h1>
     <p class="lede">Send from one of this node's addresses. The node signs the message and delivers it; follow it under Inbox.</p>
     ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
     <form class="compose" method="post" action="/admin/compose">
       <label>From <select name="from">${addresses.map((a) => option(a, values.from)).join('')}</select></label>
       <label>To <input type="text" name="to" required autocomplete="off" spellcheck="false" placeholder="name@example.com" value="${esc(values.to ?? '')}"></label>
       <label>Kind of message <select name="intent">${intents.map((i) => option(i, values.intent ?? 'inform')).join('')}</select></label>
       <label>Message <textarea name="text" rows="6" required maxlength="20000">${esc(values.text ?? '')}</textarea></label>
       <button class="primary" type="submit">Send</button>
     </form>`,
  );
}

/**
 * What the owner of an address can do with a message that was delivered to
 * the node's own inbox: say they read it, and answer it. Messages that went
 * out through another channel (email, an agent's feed) are read and answered
 * there, so they get no controls here.
 */
function inboxActions(m: MessageView, threadId: string): string {
  if (m.direction !== 'in' || m.receipt_for) return '';
  return m.deliveries
    .filter((d) => d.channel === INBOX_CHANNEL && (d.state === 'delivered' || d.state === 'read'))
    .map((d) => {
      const hidden =
        `<input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="recipient" value="${esc(d.recipient)}">` +
        `<input type="hidden" name="from" value="${esc(m.from_addr)}"><input type="hidden" name="thread" value="${esc(threadId)}">`;
      const label = `Reply as ${d.recipient}`;
      return `<div class="inbox">
          ${d.state === 'delivered' ? `<form method="post" action="/admin/inbox/read">${hidden}<button type="submit">Mark read</button></form>` : ''}
          <form class="reply" method="post" action="/admin/inbox/reply">${hidden}
            <textarea name="text" rows="3" required maxlength="20000" aria-label="${esc(label)}" placeholder="${esc(label)}"></textarea>
            <button class="primary" type="submit">Send reply</button>
          </form>
        </div>`;
    })
    .join('');
}

export function threadPage(domain: string, threadId: string, messages: MessageView[], flash?: string): string {
  const cards = messages
    .map((m) => {
      const text = textOf(m.envelope.content);
      const data = summarizeData(m.envelope.content.parts);
      const deliveries = m.deliveries
        .map(
          (d) =>
            `<span>${esc(d.recipient)} ${stateChip(d.state)}${d.channel ? ` via ${esc(d.channel)}` : ''}${d.last_error ? ` <small>${esc(d.last_error)}</small>` : ''}</span>`,
        )
        .join('');
      return `<article class="card">
        <div class="meta">
          <span>${m.direction === 'in' ? 'received' : 'sent'} ${esc(when(m.created_at))}</span>
          <span><b>${esc(m.from_addr)}</b>${m.principal ? ` for <b>${esc(m.principal)}</b>` : ''} → ${esc(m.to_addrs.join(', '))}</span>
          <span class="chip">${esc(m.intent)}</span>
          ${m.receipt_for ? '<span class="chip">receipt</span>' : ''}
        </div>
        <p class="body">${esc(text)}</p>
        ${data.length > 0 && !m.receipt_for ? `<p class="data">${esc(data.join('\n'))}</p>` : ''}
        ${deliveries ? `<div class="meta">${deliveries}</div>` : ''}
        ${inboxActions(m, threadId)}
      </article>`;
    })
    .join('\n');
  return page(
    'Thread',
    domain,
    'inbox',
    `<h1>Thread</h1>
     <p class="lede">${esc(threadId)}</p>
     ${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
     ${cards || '<p class="empty">This node holds no messages on this thread.</p>'}`,
  );
}
