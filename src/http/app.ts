/**
 * The node's HTTP surface.
 *
 *   public       POST /adtp/v0/messages           node to node: one signed envelope in, a signed receipt out
 *                GET  /.well-known/adtp/{local}    cards
 *                GET  /.well-known/adtp            the directory: the addresses this domain lists
 *                GET  /healthz                    health check
 *                GET  /r/{token}.gif              read-receipt beacon
 *   channel      POST /hooks/{channel}            native events from a channel (e.g. email replies)
 *   agent token  /api/v0/messages, /events, /threads, /resolve, /directory   what a local agent needs
 *   admin token  /api/v0/tray, /api/v0/delegations   everything else in the JSON API
 *                /admin/...                       web UI (requests tray, inbox, threads)
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { OperationError } from '../core/context.js';
import { eventJson } from '../core/events.js';
import type { AdtpNode } from '../core/node.js';
import type { Draft } from '../core/sender.js';
import type { MessageView } from '../core/store.js';
import type { Logger } from '../log.js';
import { parseAddress } from '../protocol/address.js';
import { ADTP_CONTENT_TYPE, ADTP_VERSION, DIRECTORY_PATH, INTENTS, MAX_ENVELOPE_BYTES, MESSAGES_PATH, PRIORITIES, type Priority } from '../protocol/constants.js';
import { textOf } from '../protocol/envelope.js';
import { toResponse } from '../protocol/wire.js';
import type { Ack } from '../protocol/types.js';
import { composePage, inboxPage, loginPage, threadPage, trayPage } from './admin-ui.js';
import { HttpError, parseCookies, parseJson, readBody, redirect, Router, sendHtml, sendJson, type Ctx } from './router.js';
import { sameSecret, StaticTokens, type Role, type TokenVerifier } from './tokens.js';

export interface AppOptions {
  node: AdtpNode;
  /** Who a bearer token belongs to. Defaults to the two fixed tokens below. */
  tokens?: TokenVerifier;
  adminToken?: string;
  agentToken?: string;
  log: Logger;
  version?: string;
}

/** Intents a delegation covers when the caller does not say. */
const DEFAULT_DELEGATION_SCOPE = ['inform', 'request', 'status'];

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SESSION_COOKIE = 'adtp_admin';
/** Longest a single events request is held open. Stays under the server's request timeout. */
const MAX_EVENT_WAIT_SECONDS = 25;

const TRAY_NOTICES: Record<string, string> = {
  approved: 'Approved. The message is being delivered and the sender is now trusted.',
  rejected: 'Rejected. The message will not be delivered.',
  expired: 'That message expired and can no longer be delivered.',
  not_pending: 'That message is no longer awaiting approval.',
  not_found: 'That message is not in the requests tray.',
};

const INBOX_NOTICES: Record<string, string> = {
  read: 'Marked read. The sender is being told.',
  already_read: 'That message was already marked read.',
  replied: 'Reply sent. It is on its way, and the sender is being told their message was answered.',
  sent: 'Sent. The state below changes as the other node takes the message and delivers it; reload to see it.',
  empty: 'A reply needs some text.',
  failed: 'The reply could not be sent. The node\'s log says why.',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Builds a Draft from an API request body, checking the type of every field the caller supplied. */
export function draftFromBody(body: Record<string, unknown>): Draft {
  const bad = (field: string, expected: string): never => {
    throw new HttpError(400, `${field} must be ${expected}`, 'invalid_request');
  };
  const optionalString = (field: string): string | undefined => {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : bad(field, 'a string');
  };

  if (typeof body.from !== 'string') bad('from', 'an address');
  const to = typeof body.to === 'string' ? [body.to] : body.to;
  if (!Array.isArray(to) || to.some((t) => typeof t !== 'string')) bad('to', 'an address or a list of addresses');
  if (typeof body.intent !== 'string') bad('intent', 'a string');
  if (body.text !== undefined && typeof body.text !== 'string') bad('text', 'a string');

  const draft: Draft = {
    from: body.from as string,
    to: to as string[],
    intent: body.intent as Draft['intent'],
    text: (body.text as string | undefined) ?? '',
    id: optionalString('id'),
    thread: optionalString('thread'),
    expires_at: optionalString('expires_at'),
  };
  if (body.priority !== undefined && body.priority !== null) {
    if (!(PRIORITIES as readonly unknown[]).includes(body.priority)) bad('priority', `one of ${PRIORITIES.join(', ')}`);
    draft.priority = body.priority as Priority;
  }
  if (body.requires_approval !== undefined) {
    if (typeof body.requires_approval !== 'boolean') bad('requires_approval', 'a boolean');
    draft.requires_approval = body.requires_approval as boolean;
  }
  if (body.data !== undefined && body.data !== null) {
    const data = Array.isArray(body.data) ? body.data : [body.data];
    if (data.some((d) => !isObject(d))) bad('data', 'an object or a list of objects');
    draft.data = data as Record<string, unknown>[];
  }
  // Three cases: a principal, absent (the agent's configured acts_for applies), and an explicit
  // null, which says "send as this address itself" and must not be folded into "absent".
  if (body.on_behalf_of === null) {
    draft.on_behalf_of = null;
  } else {
    const principal = optionalString('on_behalf_of');
    if (principal !== undefined) draft.on_behalf_of = principal;
  }
  const delegation = optionalString('delegation');
  if (delegation !== undefined) draft.delegation = delegation;
  return draft;
}

/** The JSON shape of a stored message in API responses. */
export function messageJson(m: MessageView): Record<string, unknown> {
  return {
    direction: m.direction,
    id: m.id,
    thread: m.thread_id,
    from: m.from_addr,
    on_behalf_of: m.principal,
    to: m.to_addrs,
    intent: m.intent,
    priority: m.priority,
    expires_at: m.expires_at,
    requires_approval: m.requires_approval,
    sender_type: m.sender_type,
    receipt_for: m.receipt_for,
    created_at: m.created_at,
    text: textOf(m.envelope.content),
    parts: m.envelope.content.parts,
    deliveries: m.deliveries,
    envelope: m.envelope,
  };
}

export function createApp(opts: AppOptions): Server {
  const { node, log } = opts;
  if (!opts.tokens && !opts.adminToken) throw new Error('createApp needs a token verifier or an admin token');
  const tokens: TokenVerifier = opts.tokens ?? new StaticTokens({ admin: opts.adminToken!, agent: opts.agentToken });
  const domain = node.config.domain;
  const secureCookies = node.config.public_url.startsWith('https://');
  const publicHost = new URL(node.config.public_url).host;
  const router = new Router();

  // ---- auth helpers ------------------------------------------------------------------

  // Browser sessions are signed with a key that lives only in this process: a restart signs everyone out.
  const sessionKey = randomBytes(32);
  const SESSION_SECONDS = 12 * 60 * 60;
  const newSession = (): string => {
    const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    return `${expires}.${createHmac('sha256', sessionKey).update(expires).digest('hex')}`;
  };
  const hasSession = (req: IncomingMessage): boolean => {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
    const dot = cookie.indexOf('.');
    if (dot <= 0) return false;
    const expires = cookie.slice(0, dot);
    if (!/^\d+$/.test(expires) || Number(expires) * 1000 <= Date.now()) return false;
    return sameSecret(cookie.slice(dot + 1), createHmac('sha256', sessionKey).update(expires).digest('hex'));
  };

  const roleOf = async (req: IncomingMessage): Promise<Role | null> => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) return null;
    return tokens.verify(auth.slice(7).trim());
  };
  /** Endpoints a local agent may use. Returns the caller's role: an agent token is held to agent addresses. */
  const requireAgent = async (ctx: Ctx): Promise<Role> => {
    const role = await roleOf(ctx.req);
    if (!role) throw new HttpError(401, 'missing or invalid token', 'unauthorized');
    return role;
  };
  const requireAdmin = async (ctx: Ctx): Promise<void> => {
    const role = await roleOf(ctx.req);
    if (!role) throw new HttpError(401, 'missing or invalid token', 'unauthorized');
    if (role !== 'admin') throw new HttpError(403, 'this needs the admin token; an agent token cannot do it', 'forbidden');
  };
  /** With an agent token, `address` must be one of this node's agents: the token is not a key to people's mailboxes. */
  const agentAddress = (role: Role, address: string, what: string): void => {
    if (role === 'admin') return;
    const hosted = node.core.domains.lookup(parseAddress(address)?.address ?? '');
    if (hosted?.type !== 'agent') throw new HttpError(403, `an agent token can only ${what} an agent address hosted on this node`, 'forbidden');
  };
  /** Browser pages: needs the session cookie; state-changing requests must also come from this origin. */
  const requireSession = (ctx: Ctx): boolean => {
    if (!hasSession(ctx.req)) {
      redirect(ctx.res, '/admin/login');
      return false;
    }
    if (ctx.req.method === 'POST') {
      const site = ctx.req.headers['sec-fetch-site'];
      const origin = ctx.req.headers.origin;
      if (typeof site === 'string') {
        // The browser's own word on where the request came from. Pages cannot set or change this
        // header, and it does not depend on the referrer policy or on what a proxy does to Host.
        if (site !== 'same-origin') throw new HttpError(403, 'cross-origin request refused', 'forbidden');
      } else if (typeof origin === 'string') {
        // A browser that does not send Sec-Fetch-Site: compare the Origin header instead.
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          /* malformed, or "null" (an origin the browser would not name): treated as a mismatch */
        }
        // Behind a reverse proxy the Host header may be internal, so the public URL's host counts too.
        if (originHost !== ctx.req.headers.host && originHost !== publicHost) {
          throw new HttpError(403, 'cross-origin request refused', 'forbidden');
        }
      }
    }
    return true;
  };
  const form = async (ctx: Ctx): Promise<URLSearchParams> => new URLSearchParams(await ctx.body());
  const jsonBody = async (ctx: Ctx): Promise<Record<string, unknown>> => {
    const parsed = parseJson(await ctx.body());
    if (!isObject(parsed)) throw new HttpError(400, 'request body must be a JSON object', 'invalid_json');
    return parsed;
  };
  const str = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`, 'invalid_request');
    return value;
  };

  // ---- public --------------------------------------------------------------------------

  router.get('/healthz', async ({ res }) => {
    try {
      await node.store.ping();
      sendJson(res, 200, { status: 'ok', domain, adtp: ADTP_VERSION, version: opts.version ?? '0' });
    } catch {
      sendJson(res, 503, { status: 'unavailable', reason: 'database unreachable' });
    }
  });

  router.get('/.well-known/adtp/:local', ({ res, params }) => {
    const card = node.card(`${params.local ?? ''}@${domain}`);
    if (!card) return sendJson(res, 404, { error: 'not_found', message: 'no such address on this node' });
    sendJson(res, 200, card, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
  });

  // The directory: the addresses this domain lists, for anyone who asks. Empty if none are listed.
  router.get(DIRECTORY_PATH, ({ res }) => {
    sendJson(res, 200, node.publishedDirectory(domain), { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
  });

  // Node to node: one signed envelope in; a signed receipt, or an error body, out.
  router.post(MESSAGES_PATH, async ({ req, res }) => {
    const answer = (ack: Ack, duplicate = false) => {
      const response = toResponse(ack, duplicate);
      sendJson(res, response.status, response.body, response.headers);
    };
    const refuse = (code: string, message: string, retryable = false) =>
      answer({ adtp: ADTP_VERSION, id: null, status: 'rejected', reason: { code, message, retryable }, at: new Date().toISOString() });

    const mediaType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== ADTP_CONTENT_TYPE) {
      req.resume();
      return refuse('unsupported_media_type', `Content-Type must be ${ADTP_CONTENT_TYPE}`);
    }
    let text: string;
    try {
      text = await readBody(req, MAX_ENVELOPE_BYTES);
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) return refuse('too_large', `an envelope may be at most ${MAX_ENVELOPE_BYTES} bytes`);
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return refuse('invalid_envelope', 'the request body is not JSON');
    }
    try {
      const { ack, duplicate } = await node.handle(raw);
      answer(ack, duplicate);
    } catch (err) {
      // Nothing was acknowledged; the sender's node will retry.
      log.error('inbound pipeline failed', { error: (err as Error).message });
      refuse('internal', 'internal error', true);
    }
  });

  router.get('/r/:token', async ({ res, params }) => {
    const token = (params.token ?? '').replace(/\.gif$/i, '');
    if (/^[a-f0-9]{32}$/.test(token)) {
      await node.markRead(token).catch((err: Error) => log.error('read beacon failed', { error: err.message }));
    }
    // Same response whether or not the token exists.
    res.writeHead(200, { 'content-type': 'image/gif', 'content-length': PIXEL.length, 'cache-control': 'no-store, private' });
    res.end(PIXEL);
  });

  // ---- channel webhooks ---------------------------------------------------------------------

  router.post('/hooks/:channel', async (ctx) => {
    const adapter = node.core.adapters.get(ctx.params.channel ?? '');
    const rawBody = await ctx.body();
    if (!adapter?.authenticate || !adapter.authenticate({ headers: ctx.req.headers, query: ctx.url.searchParams, rawBody })) {
      throw new HttpError(401, 'webhook not authorized', 'unauthorized');
    }
    const submitted = await node.ingest(adapter.name, parseJson(rawBody));
    if (!submitted) return sendJson(ctx.res, 202, { accepted: false, reason: 'the event did not match a delivered message' });
    sendJson(ctx.res, 202, { accepted: true, id: submitted.id, thread: submitted.thread, duplicate: !submitted.created });
  });

  // ---- local JSON API: what a local agent needs (agent token or admin token) ---------------------

  router.post('/api/v0/messages', async (ctx) => {
    const role = await requireAgent(ctx);
    const body = await jsonBody(ctx);
    const draft = draftFromBody(body);
    agentAddress(role, draft.from, 'send from');
    if (role !== 'admin' && typeof draft.on_behalf_of === 'string' && !draft.delegation) {
      // The node signs delegations for principals it hosts. An agent token gets that only for the principal the agent is configured to act for.
      const sender = node.core.domains.lookup(parseAddress(draft.from)?.address ?? '');
      if (parseAddress(draft.on_behalf_of)?.address !== sender?.acts_for) {
        throw new HttpError(403, 'an agent token can only send on behalf of the principal the agent is configured to act for', 'forbidden');
      }
    }
    if (body.dry_run === true) {
      // Sign only: nothing is stored or sent. Lets a caller inspect exactly what would go on the wire.
      const envelope = await node.preview(draft);
      return sendJson(ctx.res, 200, { id: envelope.id, thread: envelope.thread, created: false, dry_run: true, envelope });
    }
    const inReplyTo = body.in_reply_to;
    if (inReplyTo !== undefined && inReplyTo !== null && typeof inReplyTo !== 'string') {
      throw new HttpError(400, 'in_reply_to must be a message id', 'invalid_request');
    }
    const submitted = await node.submit(draft, { inReplyTo: inReplyTo ?? undefined });
    sendJson(ctx.res, submitted.created ? 201 : 200, submitted);
  });

  router.post('/api/v0/messages/:id/read', async (ctx) => {
    const role = await requireAgent(ctx);
    const body = await jsonBody(ctx);
    const recipient = str(body.recipient, 'recipient');
    agentAddress(role, recipient, 'mark messages read for');
    const from = body.from === undefined || body.from === null ? undefined : str(body.from, 'from');
    const changed = await node.markReadBy(ctx.params.id ?? '', recipient, from);
    sendJson(ctx.res, 200, { read: true, changed });
  });

  // The feed a local agent follows: messages handed to it and status updates for what it sent.
  router.get('/api/v0/events', async (ctx) => {
    const role = await requireAgent(ctx);
    const query = ctx.url.searchParams;
    const address = str(query.get('address'), 'address');
    agentAddress(role, address, 'read the events of');
    const afterParam = query.get('after') ?? '0';
    if (afterParam === 'latest') {
      return sendJson(ctx.res, 200, { events: [], cursor: await node.latestEvent(address) });
    }
    const after = Number(afterParam);
    const wait = Number(query.get('wait') ?? '0');
    const limit = Number(query.get('limit') ?? '100');
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'after must be a sequence number or "latest"', 'invalid_request');
    if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, 'wait must be a number of seconds', 'invalid_request');
    if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer', 'invalid_request');
    const rows = await node.events(address, after, { limit, waitMs: Math.min(wait, MAX_EVENT_WAIT_SECONDS) * 1000 });
    sendJson(ctx.res, 200, { events: rows.map(eventJson), cursor: rows.at(-1)?.seq ?? after });
  });

  // How an address resolves from this node: discovery method, card URL, endpoint and keys.
  router.get('/api/v0/resolve', async (ctx) => {
    await requireAgent(ctx);
    const address = str(ctx.url.searchParams.get('address'), 'address');
    try {
      const query = ctx.url.searchParams;
      const card = await node.resolve(address, { fresh: query.get('fresh') === 'true', external: query.get('external') === 'true' });
      sendJson(ctx.res, 200, card);
    } catch (err) {
      throw new HttpError(502, (err as Error).message, 'unresolvable');
    }
  });

  // Who can be written to at a domain: its directory, as found from this node.
  router.get('/api/v0/directory', async (ctx) => {
    await requireAgent(ctx);
    const name = str(ctx.url.searchParams.get('domain'), 'domain');
    let directory;
    try {
      directory = await node.directory(name, { external: ctx.url.searchParams.get('external') === 'true' });
    } catch (err) {
      if (err instanceof OperationError) throw err;
      throw new HttpError(502, (err as Error).message, 'unresolvable');
    }
    sendJson(ctx.res, 200, directory);
  });

  router.get('/api/v0/messages/:id', async (ctx) => {
    await requireAgent(ctx);
    const copies = await node.status(ctx.params.id ?? '');
    if (copies.length === 0) throw new HttpError(404, 'no message with this id on this node', 'not_found');
    sendJson(ctx.res, 200, { id: ctx.params.id, copies: copies.map(messageJson) });
  });

  router.get('/api/v0/threads/:thread', async (ctx) => {
    await requireAgent(ctx);
    const messages = await node.thread(ctx.params.thread ?? '');
    sendJson(ctx.res, 200, { thread: ctx.params.thread, messages: messages.map(messageJson) });
  });

  // ---- local JSON API: admin token only ---------------------------------------------------------

  router.get('/api/v0/tray', async (ctx) => {
    await requireAdmin(ctx);
    const items = await node.tray();
    sendJson(ctx.res, 200, {
      items: items.map(({ delivery, message }) => ({
        id: message.id,
        recipient: delivery.recipient,
        thread: message.thread_id,
        from: message.from_addr,
        on_behalf_of: message.principal,
        sender_type: message.sender_type,
        intent: message.intent,
        priority: message.priority,
        expires_at: message.expires_at,
        received_at: message.created_at,
        text: textOf(message.envelope.content),
      })),
    });
  });

  const optionalFrom = (body: Record<string, unknown>): string | undefined =>
    body.from === undefined || body.from === null ? undefined : str(body.from, 'from');

  router.post('/api/v0/tray/approve', async (ctx) => {
    await requireAdmin(ctx);
    const body = await jsonBody(ctx);
    sendJson(ctx.res, 200, await node.approve(str(body.id, 'id'), str(body.recipient, 'recipient'), optionalFrom(body)));
  });

  router.post('/api/v0/tray/reject', async (ctx) => {
    await requireAdmin(ctx);
    const body = await jsonBody(ctx);
    await node.reject(str(body.id, 'id'), str(body.recipient, 'recipient'), optionalFrom(body));
    sendJson(ctx.res, 200, { rejected: true });
  });

  // Signs "agent may send these intents for principal". Good for a day unless ttl_seconds says otherwise.
  router.post('/api/v0/delegations', async (ctx) => {
    await requireAdmin(ctx);
    const body = await jsonBody(ctx);
    if (body.ttl_seconds !== undefined && typeof body.ttl_seconds !== 'number') throw new HttpError(400, 'ttl_seconds must be a number', 'invalid_request');
    if (body.audience !== undefined && typeof body.audience !== 'string') throw new HttpError(400, 'audience must be a string', 'invalid_request');
    const grant = node.delegate(str(body.principal, 'principal'), str(body.agent, 'agent'), {
      ttlSeconds: body.ttl_seconds as number | undefined,
      scope: body.scope ?? DEFAULT_DELEGATION_SCOPE,
      audience: body.audience as string | undefined,
    });
    sendJson(ctx.res, 201, grant);
  });

  // Takes a delegation back. Idempotent: revoking twice is not an error.
  router.post('/api/v0/delegations/:jti/revoke', async (ctx) => {
    await requireAdmin(ctx);
    const jti = ctx.params.jti ?? '';
    const revoked = await node.revokeDelegation(jti);
    sendJson(ctx.res, 200, { jti, revoked: true, already_revoked: !revoked });
  });

  // ---- web UI (session cookie) ----------------------------------------------------------------

  router.get('/', ({ res }) => redirect(res, '/admin/tray'));
  router.get('/admin', ({ res }) => redirect(res, '/admin/tray'));

  router.get('/admin/login', ({ req, res }) => {
    if (hasSession(req)) return redirect(res, '/admin/tray');
    sendHtml(res, 200, loginPage(domain));
  });

  router.post('/admin/login', async (ctx) => {
    const token = (await form(ctx)).get('token') ?? '';
    if ((await tokens.verify(token)) !== 'admin') {
      log.warn('admin sign-in failed', { remote: ctx.req.socket.remoteAddress });
      return sendHtml(ctx.res, 401, loginPage(domain, 'That token is not correct.'));
    }
    const cookie = `${SESSION_COOKIE}=${newSession()}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_SECONDS}${secureCookies ? '; Secure' : ''}`;
    redirect(ctx.res, '/admin/tray', { 'set-cookie': cookie });
  });

  router.post('/admin/logout', ({ res }) => {
    redirect(res, '/admin/login', { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0` });
  });

  router.get('/admin/tray', async (ctx) => {
    if (!requireSession(ctx)) return;
    // Only fixed texts are shown: the query string never reaches the page.
    const text = TRAY_NOTICES[ctx.url.searchParams.get('done') ?? ''];
    sendHtml(ctx.res, 200, trayPage(domain, await node.tray(), text));
  });

  const trayAction = (action: 'approve' | 'reject') => async (ctx: Ctx) => {
    if (!requireSession(ctx)) return;
    const fields = await form(ctx);
    const id = fields.get('id') ?? '';
    const recipient = fields.get('recipient') ?? '';
    const from = fields.get('from') || undefined;
    let done = action === 'approve' ? 'approved' : 'rejected';
    try {
      if (action === 'approve') await node.approve(id, recipient, from);
      else await node.reject(id, recipient, from);
    } catch (err) {
      if (!(err instanceof OperationError)) throw err;
      done = err.code;
    }
    redirect(ctx.res, `/admin/tray?done=${encodeURIComponent(done)}`);
  };
  router.post('/admin/tray/approve', trayAction('approve'));
  router.post('/admin/tray/reject', trayAction('reject'));

  router.get('/admin/inbox', async (ctx) => {
    if (!requireSession(ctx)) return;
    sendHtml(ctx.res, 200, inboxPage(domain, await node.recent(100)));
  });

  router.get('/admin/threads/:thread', async (ctx) => {
    if (!requireSession(ctx)) return;
    const thread = ctx.params.thread ?? '';
    // Only fixed texts are shown: the query string never reaches the page.
    const text = INBOX_NOTICES[ctx.url.searchParams.get('done') ?? ''];
    sendHtml(ctx.res, 200, threadPage(domain, thread, await node.thread(thread), text));
  });

  // Writing a first message from one of this node's addresses.
  const hostedAddresses = (): string[] => node.core.domains.list().map((a) => a.address);
  router.get('/admin/compose', async (ctx) => {
    if (!requireSession(ctx)) return;
    sendHtml(ctx.res, 200, composePage(domain, hostedAddresses(), INTENTS));
  });
  router.post('/admin/compose', async (ctx) => {
    if (!requireSession(ctx)) return;
    const fields = await form(ctx);
    const values = { from: fields.get('from') ?? '', to: (fields.get('to') ?? '').trim(), intent: fields.get('intent') ?? 'inform', text: fields.get('text') ?? '' };
    try {
      const intent = INTENTS.find((known) => known === values.intent);
      if (!intent) throw new OperationError('invalid_message', 'Choose a kind of message from the list.');
      const sent = await node.submit({ from: values.from, to: [values.to], intent, text: values.text });
      redirect(ctx.res, `/admin/threads/${encodeURIComponent(sent.thread)}?done=sent`);
    } catch (err) {
      if (!(err instanceof OperationError)) throw err;
      // The node's own wording of what is wrong with the message; escaped like everything else on the page.
      sendHtml(ctx.res, 400, composePage(domain, hostedAddresses(), INTENTS, values, err.message));
    }
  });

  // The inbox channel's reader: the owner of an address says they read a message, or answers it.
  const inboxAction = (action: 'read' | 'reply') => async (ctx: Ctx) => {
    if (!requireSession(ctx)) return;
    const fields = await form(ctx);
    const id = fields.get('id') ?? '';
    const recipient = fields.get('recipient') ?? '';
    const from = fields.get('from') ?? '';
    const thread = fields.get('thread') ?? '';
    let done: string;
    if (action === 'read') {
      done = (await node.markReadBy(id, recipient, from || undefined)) ? 'read' : 'already_read';
    } else {
      const text = (fields.get('text') ?? '').trim();
      if (!text) done = 'empty';
      else {
        try {
          await node.submit({ from: recipient, to: [from], intent: 'inform', text, thread }, { inReplyTo: { message_id: id, from } });
          done = 'replied';
        } catch (err) {
          if (!(err instanceof OperationError)) throw err;
          log.warn('reply from the inbox page failed', { id, recipient, error: err.code });
          done = 'failed';
        }
      }
    }
    redirect(ctx.res, `/admin/threads/${encodeURIComponent(thread)}?done=${done}`);
  };
  router.post('/admin/inbox/read', inboxAction('read'));
  router.post('/admin/inbox/reply', inboxAction('reply'));

  // ---- dispatch ----------------------------------------------------------------------------------

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The request target is attacker-controlled and need not be a valid URL ("GET //[").
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://node.invalid');
    } catch {
      return sendJson(res, 400, { error: 'bad_request', message: 'malformed request target' });
    }
    const found = router.match(req.method ?? 'GET', url.pathname);
    if (found === null) return sendJson(res, 404, { error: 'not_found', message: 'no such endpoint' });
    if (found === 'method') return sendJson(res, 405, { error: 'method_not_allowed', message: 'method not allowed' });

    let cached: Promise<string> | undefined;
    const ctx: Ctx = { req, res, url, params: found.params, body: () => (cached ??= readBody(req)) };
    try {
      await found.handler(ctx);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message });
      if (err instanceof OperationError) return sendJson(res, err.httpStatus, { error: err.code, message: err.message });
      log.error('request failed', { method: req.method, path: url.pathname, error: (err as Error).message });
      sendJson(res, 500, { error: 'internal', message: 'internal error' });
    }
  };

  const server = createServer((req, res) => {
    // Last line of defence: whatever goes wrong while handling one request, the
    // rejection is caught here and never becomes an unhandled one that ends the process.
    handle(req, res).catch((err: Error) => {
      log.error('request handling crashed', { method: req.method, error: err.message });
      try {
        if (res.headersSent) res.destroy();
        else sendJson(res, 500, { error: 'internal', message: 'internal error' });
      } catch {
        res.destroy();
      }
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}
