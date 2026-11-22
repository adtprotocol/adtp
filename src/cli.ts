#!/usr/bin/env node
/**
 * adtp: the node's command line.
 *
 *   adtp start                      run the node (default)
 *   adtp keys show                  print the public keys and the DNS TXT record
 *   adtp keys rotate                generate a new signing key; the old one stays valid for the grace period
 *   adtp delegate --principal alice --agent bot@agents.example [--scope inform,request] [--ttl-hours 24]
 *   adtp revoke <jti>               take a delegation token back
 *   adtp send --from a@x --to b@y --text "..." [--intent inform] [--thread id] [--priority p] [--in-reply-to id]
 *   adtp status <message-id>
 *   adtp resolve <address> [--public]
 *   adtp directory <domain> [--public]
 *
 * Common flags: --config <file> (default ./adtp.config.yaml or $ADTP_CONFIG);
 * commands that talk to a running node also take --url and --token (default:
 * this node's listen port and admin token).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AdtpClient, type SendInput } from './client.js';
import { ConfigError, dnsTxtRecord, loadConfig, type NodeConfig } from './config.js';
import { AdtpNode } from './core/node.js';
import { openDatabase } from './db/index.js';
import { createApp } from './http/app.js';
import { StaticTokens } from './http/tokens.js';
import { Keyring } from './identity/keyring.js';
import { createLogger, parseLogLevel } from './log.js';
import { DELEGATION_AUDIENCE } from './protocol/constants.js';
import { mintDelegation, parseScope } from './protocol/delegation.js';
import { parseAddress } from './protocol/address.js';
import type { ResolvedCard } from './protocol/types.js';

const VERSION = '0.1.0';

const USAGE = `usage: adtp <command> [options]

  start                        run the node (the default command)
  keys show                    print the public keys and the DNS TXT record to publish
  keys rotate                  switch to a new signing key; the old one keeps verifying for the grace period
  delegate                     sign a token letting an agent send for one of this node's addresses
      --principal <local or address>  --agent <address>
      [--scope inform,request,status]  [--ttl-hours 24]  [--audience <node origin>]
  revoke <jti>                 take a delegation token back before it expires (needs the running node)
  send                         send a message through a running node
      --from <address>  --to <address> (repeatable)  --text <text>
      [--intent inform]  [--thread <id>]  [--priority low|normal|urgent]  [--expires-at <RFC 3339 time>]
      [--in-reply-to <message-id>]   answer a received message: it is marked replied, and its sender is told
  status <message-id>          show per-recipient delivery state
  resolve <address>            show how this node finds an address: DNS record, card URL, endpoint, keys
      [--public]               for one of this node's own addresses: look it up the way other nodes do
  directory <domain>           show who can be written to at a domain: the addresses it lists, and what each is for
      [--public]               for this node's own domain: look it up the way other nodes do

options
  -c, --config <file>          config file (default: $ADTP_CONFIG or ./adtp.config.yaml)
      --url <url> --token <t>  for revoke/send/status/resolve/directory: the node to talk to (default: this node)`;

function loadKeyring(config: NodeConfig) {
  return Keyring.load({
    path: config.keys.path,
    graceDays: config.keys.rotation_grace_days,
    envPrivateKey: process.env.ADTP_PRIVATE_KEY || undefined,
  });
}

/**
 * A token comes from the environment or the config file, or else from a file
 * the node creates on first run. It is written to disk, never to the log.
 */
function resolveToken(which: { token?: string; token_file: string }): { token: string; source: string } {
  if (which.token) return { token: which.token, source: 'configuration' };
  const file = which.token_file;
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return { token, source: file };
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return { token, source: file };
}

function printIdentity(config: NodeConfig, keyring: Keyring, out: (line: string) => void): void {
  const txt = dnsTxtRecord(config);
  out(`ADTP node for ${config.domain}`);
  out('');
  out('Addresses:');
  for (const a of config.addresses) out(`  ${a.address}  (${a.type}${a.listed ? ', listed' : ''})  ${config.public_url}/.well-known/adtp/${a.local}`);
  out('');
  const listed = config.addresses.filter((a) => a.listed).length;
  out(`Directory: ${config.public_url}/.well-known/adtp  (${listed === 0 ? 'empty: no address is listed' : `${listed} listed`})`);
  out('');
  out('Public keys (published in every card):');
  for (const k of keyring.publicKeys()) {
    out(`  ${k.kid}  ${k.public_key}${k.not_after ? `  (rotated out, verifies until ${k.not_after})` : '  (active)'}`);
  }
  out('');
  out('DNS: add this TXT record so other nodes can find your addresses and your directory:');
  out(`  ${txt.name}.  TXT  "${txt.value}"`);
  if (config.public_url === `https://${config.domain}`) {
    out(`  (optional here: cards are already served at the fallback location https://${config.domain}/.well-known/adtp/)`);
  }
  out('');
}

async function start(config: NodeConfig): Promise<void> {
  const log = createLogger(parseLogLevel(process.env.LOG_LEVEL));
  const { keyring, created, rotatedFromEnv } = loadKeyring(config);
  const admin = resolveToken(config.admin);
  const agent = resolveToken(config.agent);
  if (admin.token === agent.token) throw new ConfigError('the agent token must differ from the admin token');
  const where = (t: { source: string }) => (t.source === 'configuration' ? 'from configuration' : `stored in ${t.source}`);

  printIdentity(config, keyring, (line) => process.stdout.write(line + '\n'));
  process.stdout.write(`Admin UI: ${config.public_url}/admin  (admin token: ${where(admin)})\n`);
  process.stdout.write(`Agents use the agent token (${where(agent)}), which cannot reach the admin pages.\n\n`);
  if (created) log.info('generated a new Ed25519 signing key', { kid: keyring.kid, keyring: config.keys.path });
  if (rotatedFromEnv) log.info('ADTP_PRIVATE_KEY changed: the previous key stays valid for the grace period', { kid: keyring.kid });

  const db = openDatabase(config.database_url);
  process.stdout.write(`Database: ${db.location}\n\n`);
  await db.waitUntilReady(log);
  await db.migrate(log);

  const node = await AdtpNode.create({ config, db, keys: keyring, log });
  if (db.dialect === 'sqlite') {
    // Node 22 labels node:sqlite experimental. Said once, here, instead of as a runtime warning on every start.
    log.info('using SQLite through node:sqlite, which Node 22 marks experimental; see README, "Database"');
  }
  const server = createApp({ node, tokens: new StaticTokens({ admin: admin.token, agent: agent.token }), log, version: VERSION });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, resolve);
  });
  node.worker.start();
  log.info('node started', {
    domain: config.domain,
    database: db.location,
    listen: `${config.listen.host}:${config.listen.port}`,
    addresses: config.addresses.length,
    channels: node.core.adapters.names(),
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    server.close();
    server.closeIdleConnections?.();
    await node.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function clientFor(config: NodeConfig | null, values: { url?: string; token?: string }): AdtpClient {
  // `||` on purpose: an environment variable set to the empty string means "not set".
  const baseUrl = values.url || process.env.ADTP_URL || (config ? `http://127.0.0.1:${config.listen.port}` : undefined);
  const token = values.token || process.env.ADTP_ADMIN_TOKEN || (config ? resolveToken(config.admin).token : undefined);
  if (!baseUrl || !token) throw new ConfigError('need --url and --token (or a readable config file)');
  return new AdtpClient({ baseUrl, token });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h' },
      url: { type: 'string' },
      token: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string', multiple: true },
      intent: { type: 'string' },
      text: { type: 'string' },
      thread: { type: 'string' },
      priority: { type: 'string' },
      'expires-at': { type: 'string' },
      'in-reply-to': { type: 'string' },
      principal: { type: 'string' },
      agent: { type: 'string' },
      'ttl-hours': { type: 'string' },
      scope: { type: 'string' },
      audience: { type: 'string' },
      public: { type: 'boolean' },
    },
  });
  const [command = 'start', sub] = positionals;
  const configPath = values.config || process.env.ADTP_CONFIG || 'adtp.config.yaml';
  const out = (line: string) => process.stdout.write(line + '\n');

  if (values.help || command === 'help') {
    out(USAGE);
    return;
  }

  switch (command) {
    case 'start':
      return start(loadConfig(configPath));

    case 'keys': {
      const config = loadConfig(configPath);
      const { keyring } = loadKeyring(config);
      if (sub === 'rotate') {
        const result = keyring.rotate();
        out(`New active key: ${result.kid}`);
        out(`Previous key ${result.previous} stays valid for verification until ${result.previousValidUntil}.`);
        out('A running node picks the new key up within a few seconds. No DNS change is needed.');
        out('');
      } else if (sub !== undefined && sub !== 'show') {
        throw new ConfigError(`unknown keys command "${sub}" (use show or rotate)`);
      }
      printIdentity(config, keyring, out);
      return;
    }

    case 'delegate': {
      const config = loadConfig(configPath);
      const principal = parseAddress(values.principal?.includes('@') ? values.principal : `${values.principal}@${config.domain}`);
      const agent = parseAddress(values.agent);
      if (!principal || !config.addresses.some((a) => a.address === principal.address)) {
        throw new ConfigError('--principal must be an address hosted on this node');
      }
      if (!agent) throw new ConfigError('--agent must be a full address (local@domain)');
      const hours = Number(values['ttl-hours'] ?? config.delegation.default_ttl_seconds / 3600);
      if (!Number.isFinite(hours) || hours <= 0) throw new ConfigError('--ttl-hours must be a positive number');
      if (hours * 3600 > config.delegation.max_ttl_seconds) {
        throw new ConfigError(`--ttl-hours may be at most ${config.delegation.max_ttl_seconds / 3600} on this node (delegation.max_ttl_hours)`);
      }
      const scope = parseScope((values.scope ?? 'inform,request,status').split(',').map((part) => part.trim()));
      if (!scope) throw new ConfigError('--scope must be a comma-separated list of intents, e.g. inform,request');
      const { keyring } = loadKeyring(config);
      const { token, claims } = mintDelegation(
        { principal: principal.address, agent: agent.address, scope, ttlSeconds: Math.floor(hours * 3600), audience: values.audience ?? DELEGATION_AUDIENCE },
        keyring.signer(principal.address),
      );
      out(token);
      // Everything but the token goes to stderr, so `adtp delegate ... > token.txt` captures only the token.
      process.stderr.write(`\n${agent.address} may send ${scope.join(', ')} for ${principal.address} until ${new Date(claims.exp * 1000).toISOString()}.\n`);
      process.stderr.write(`To take it back before then: adtp revoke ${claims.jti}\n`);
      return;
    }

    case 'revoke': {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      if (!sub) throw new ConfigError('revoke needs the id (jti) of a delegation token');
      const result = await clientFor(config, values).request<{ already_revoked: boolean }>('POST', `/api/v0/delegations/${encodeURIComponent(sub)}/revoke`, {});
      out(result.already_revoked ? `${sub} was already revoked.` : `${sub} is revoked. This node no longer sends or accepts messages that carry it.`);
      return;
    }

    case 'send': {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      if (!values.from || !values.to?.length || !values.text) throw new ConfigError('send needs --from, --to and --text');
      const result = await clientFor(config, values).send({
        from: values.from,
        to: values.to,
        intent: values.intent ?? 'inform',
        text: values.text,
        thread: values.thread,
        priority: values.priority as SendInput['priority'],
        expires_at: values['expires-at'],
        in_reply_to: values['in-reply-to'],
      });
      out(JSON.stringify(result, null, 2));
      return;
    }

    case 'resolve': {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      if (!sub) throw new ConfigError('resolve needs an address');
      const query = `address=${encodeURIComponent(sub)}&fresh=true${values.public ? '&external=true' : ''}`;
      const card = await clientFor(config, values).request<ResolvedCard>('GET', `/api/v0/resolve?${query}`);
      const via = card.resolved;
      out(`${card.address} resolves:`);
      if (via?.dns_record) out(`  found via   DNS  ${via.dns_record.name}  TXT  "${via.dns_record.value}"`);
      else if (via?.method === 'well-known') out('  found via   the well-known URL (no _adtp TXT record was found)');
      else if (via?.method === 'override') out('  found via   a discovery override in this node\'s config (no DNS lookup)');
      else if (via?.method === 'local') out('  found via   this node\'s own config (the address is hosted here; use --public to see what others see)');
      if (via?.card_url) out(`  card        ${via.card_url}`);
      if (via?.retry_after) out(`              (the copy fetched a moment ago; it can be fetched again in ${via.retry_after}s)`);
      out(`  endpoint    ${card.endpoint}`);
      out(`  type        ${card.type ?? 'not stated'}${card.acts_for ? ` (acts for ${card.acts_for})` : ''}`);
      out(`  accepts     ${card.accepts.join(', ')} (up to ${card.max_bytes} bytes)`);
      out(`  keys        ${card.keys.map((k) => k.kid + (k.not_after ? ` (until ${k.not_after})` : '')).join(', ')}`);
      return;
    }

    case 'directory': {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      if (!sub) throw new ConfigError('directory needs a domain, e.g. adtp directory acme.com');
      const directory = await clientFor(config, values).directory(sub, { external: values.public === true });
      const via = directory.resolved;
      out(`${directory.domain} lists ${directory.entries.length === 1 ? '1 address' : `${directory.entries.length} addresses`}:`);
      for (const entry of directory.entries) {
        out(`  ${entry.address}${entry.type ? `  (${entry.type})` : ''}`);
        if (entry.description) out(`      ${entry.description}`);
      }
      if (via?.dns_record) out(`found via  DNS  ${via.dns_record.name}  TXT  "${via.dns_record.value}"`);
      else if (via?.method === 'well-known') out('found via  the well-known URL (the _adtp TXT record names no directory)');
      else if (via?.method === 'override') out('found via  a discovery override in this node\'s config (no DNS lookup)');
      else if (via?.method === 'local') out('found via  this node\'s own config (the domain is hosted here; use --public to see what others see)');
      if (via?.url) out(`directory  ${via.url}`);
      return;
    }

    case 'status': {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      if (!sub) throw new ConfigError('status needs a message id');
      out(JSON.stringify(await clientFor(config, values).status(sub), null, 2));
      return;
    }

    default:
      throw new ConfigError(`unknown command "${command}" (try: adtp help)`);
  }
}

main().catch((err: Error) => {
  // Config and usage problems are the user's to fix: show the message, not a stack trace.
  process.stderr.write(`adtp: ${err.message}\n`);
  process.exit(1);
});
