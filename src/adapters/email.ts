/**
 * Email channel adapter.
 *
 * Outbound: renders an ADTP message as a readable email (the message text
 * first, structured data summarized underneath) and sends it over SMTP.
 *
 * Inbound: replies come back through a webhook (POST /hooks/email) fed by
 * whatever receives the node's mail (an inbound-parse service, a mail server
 * pipe script, ...). A reply is matched to the delivery it answers by the
 * per-delivery token embedded in the outgoing Message-ID and Reply-To.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { EmailChannelConfig } from '../config.js';
import type { Logger } from '../log.js';
import { textOf } from '../protocol/envelope.js';
import type { Envelope, Part } from '../protocol/types.js';
import type {
  AdapterCapabilities,
  AdapterFactory,
  ChannelAdapter,
  DeliveryReceipt,
  IngestContext,
  IngestedMessage,
  RenderContext,
  WebhookRequest,
} from './types.js';

export interface EmailPayload {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  replyTo?: string;
  references: string[];
  headers: Record<string, string>;
}

/** The slice of a nodemailer transport this adapter uses; tests substitute their own. */
export interface MailTransport {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string; response?: string }>;
  close?(): void;
}

/** The JSON an inbound-mail webhook posts for one received email. */
export interface InboundEmailEvent {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  message_id?: unknown;
  in_reply_to?: unknown;
  references?: unknown;
  headers?: unknown;
}

const TOKEN_RE = /(?:adtp\.|\+)([a-f0-9]{32})@/gi;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/** Extracts the bare address from `Name <addr@host>` or `addr@host`. */
export function emailAddressOf(value: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

/** One line per top-level key of each data part; long or nested values are abbreviated. */
export function summarizeData(parts: Part[]): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'data') {
      const entries = Object.entries(part.data);
      for (const [key, value] of entries.slice(0, 20)) {
        const shown = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(`${key}: ${truncate(String(shown ?? 'null').replace(/\s+/g, ' '), 160)}`);
      }
      if (entries.length > 20) lines.push(`… and ${entries.length - 20} more fields`);
    } else if (part.type === 'file') {
      const name = part.name ?? 'unnamed file';
      const type = part.media_type ? ` (${part.media_type})` : '';
      lines.push(`Attachment: ${name}${type} ${part.url}`);
    }
  }
  return lines;
}

/**
 * Removes the quoted original from an email reply, leaving what the person
 * actually wrote. Heuristic: cut at the first "On ... wrote:" / "Original
 * Message" marker, then drop trailing quoted lines.
 */
export function stripQuotedReply(input: string): string {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    const next = (lines[i + 1] ?? '').trim();
    if (
      /^On\b.*\bwrote:$/i.test(line) ||
      (/^On\b/i.test(line) && /wrote:$/i.test(next) && !/^>/.test(next)) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^_{10,}$/.test(line) ||
      (/^From:\s/i.test(line) && /^(Sent|Date):\s/i.test(next))
    ) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut);
  while (kept.length > 0 && /^\s*(>.*)?$/.test(kept[kept.length - 1] ?? '')) kept.pop();
  const result = kept.join('\n').trim();
  return result.length > 0 ? result : input.trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

function tokensIn(...values: unknown[]): string[] {
  const found: string[] = [];
  for (const value of values) {
    const text = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
    for (const match of text.matchAll(TOKEN_RE)) {
      const token = match[1]?.toLowerCase();
      if (token && !found.includes(token)) found.push(token);
    }
  }
  return found;
}

function header(headers: unknown, name: string): unknown {
  if (!isObject(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

export class EmailAdapter implements ChannelAdapter<EmailPayload> {
  readonly name = 'email';
  private readonly fromAddress: string;

  constructor(
    private readonly cfg: EmailChannelConfig,
    private readonly node: { domain: string; public_url: string },
    private readonly transport: MailTransport,
    private readonly log?: Logger,
  ) {
    this.fromAddress = emailAddressOf(cfg.from);
  }

  capabilities(): AdapterCapabilities {
    return {
      read_receipts: this.cfg.read_receipts,
      replies: Boolean(this.cfg.inbound_token),
      structured_data: 'summarized',
      files: 'linked',
    };
  }

  render(message: Envelope, ctx: RenderContext): EmailPayload {
    const body = textOf(message.content).replaceAll('\u0000', '');
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    const extras = summarizeData(message.content.parts);

    const who = ctx.principal
      ? `${message.from} (${ctx.senderType ?? 'sender'}, on behalf of ${ctx.principal})`
      : `${message.from}${ctx.senderType ? ` (${ctx.senderType})` : ''}`;
    const facts: string[] = [
      `From: ${who}`,
      `To: ${ctx.recipient}`,
      `Intent: ${message.intent}`,
      `Priority: ${message.priority ?? 'normal'}`,
    ];
    if (message.expires_at) facts.push(`Expires: ${message.expires_at}`);
    if (message.requires_approval) facts.push('Approval: the sender asks for your explicit approval');
    facts.push(`Thread: ${ctx.thread}`, `Message: ${message.id}`);
    const footer = this.capabilities().replies
      ? 'Reply to this email to answer on the same thread.'
      : 'Delivered by your ADTP node.';

    const textSections = [body];
    if (extras.length > 0) textSections.push('Details\n' + extras.map((l) => `  ${l}`).join('\n'));
    textSections.push('-- \n' + facts.join('\n') + '\n\n' + footer);
    const text = textSections.join('\n\n') + '\n';

    const pixel = this.cfg.read_receipts
      ? `<img src="${escapeHtml(`${this.node.public_url}/r/${ctx.token}.gif`)}" width="1" height="1" alt="" style="display:none">`
      : '';
    const html =
      '<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">' +
      `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>` +
      (extras.length > 0
        ? `<p style="margin:16px 0 4px;font-weight:600">Details</p><div style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px">${escapeHtml(extras.join('\n'))}</div>`
        : '') +
      `<hr style="border:none;border-top:1px solid #ddd;margin:20px 0 12px"><div style="white-space:pre-wrap;font-size:13px;color:#555">${escapeHtml(facts.join('\n') + '\n\n' + footer)}</div>` +
      pixel +
      '</body></html>';

    const threadRef = `<adtp-thread.${createHash('sha256').update(ctx.thread).digest('hex').slice(0, 32)}@${this.node.domain}>`;
    const payload: EmailPayload = {
      from: { name: `${message.from} via ADTP`, address: this.fromAddress },
      to: ctx.target,
      subject: `[ADTP ${message.intent}] ${truncate(firstLine.trim(), 90)}`,
      text,
      html,
      messageId: `<adtp.${ctx.token}@${this.node.domain}>`,
      references: [threadRef],
      headers: {
        'X-ADTP-Message-Id': message.id,
        'X-ADTP-Thread': ctx.thread,
        'X-ADTP-Intent': message.intent,
        'X-ADTP-From': message.from,
      },
    };
    if (this.cfg.reply_to) payload.replyTo = this.cfg.reply_to.replaceAll('{token}', ctx.token);
    return payload;
  }

  async deliver(payload: EmailPayload): Promise<DeliveryReceipt> {
    const info = await this.transport.sendMail({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      messageId: payload.messageId,
      replyTo: payload.replyTo,
      references: payload.references,
      headers: payload.headers,
    });
    return { native_id: info.messageId ?? payload.messageId, detail: info.response };
  }

  authenticate(request: WebhookRequest): boolean {
    const expected = this.cfg.inbound_token;
    if (!expected) return false;
    const auth = request.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    const presented = bearer ?? request.query.get('token') ?? '';
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
  }

  /** Turns an inbound email into an ADTP reply on the thread of the delivery it answers. */
  async ingest(event: unknown, ctx: IngestContext): Promise<IngestedMessage | null> {
    if (!isObject(event)) return null;
    const mail = event as InboundEmailEvent;

    const tokens = tokensIn(
      mail.in_reply_to,
      mail.references,
      header(mail.headers, 'In-Reply-To'),
      header(mail.headers, 'References'),
      mail.to,
      header(mail.headers, 'To'),
    );
    if (tokens.length === 0) return null;

    const rawText = typeof mail.text === 'string' && mail.text.trim() ? mail.text : typeof mail.html === 'string' ? htmlToText(mail.html) : '';
    const text = stripQuotedReply(rawText);
    if (!text) return null;

    const sender = typeof mail.from === 'string' ? emailAddressOf(mail.from) : '';

    for (const token of tokens) {
      const item = await ctx.findDelivery(token);
      if (!item || item.channel !== this.name) continue;
      if (!item.target || emailAddressOf(item.target) !== sender) {
        this.log?.warn('ignored email reply from an address the message was not delivered to', {
          message_id: item.message.id,
          recipient: item.recipient,
        });
        return null;
      }
      const nativeId = typeof mail.message_id === 'string' ? mail.message_id : header(mail.headers, 'Message-ID');
      const draft: IngestedMessage['draft'] = {
        from: item.recipient,
        to: [item.message.from.toLowerCase()],
        thread: item.thread,
        intent: 'inform',
        text,
      };
      if (typeof nativeId === 'string' && nativeId.trim()) {
        draft.id = 'eml-' + createHash('sha256').update(`${token}|${nativeId.trim()}`).digest('hex').slice(0, 32);
      }
      return { draft, in_reply_to: { message_id: item.message.id, from: item.message.from } };
    }
    return null;
  }

  close(): void {
    this.transport.close?.();
  }
}

export function createSmtpTransport(cfg: EmailChannelConfig): MailTransport {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }) as unknown as MailTransport;
}

export const emailAdapterFactory: AdapterFactory = ({ config, node, log }) => {
  const cfg = config as EmailChannelConfig;
  return new EmailAdapter(cfg, node, createSmtpTransport(cfg), log);
};
