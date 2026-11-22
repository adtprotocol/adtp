/**
 * Loads and validates the single node config file (adtp.config.yaml).
 *
 * String values may reference environment variables as ${NAME} or
 * ${NAME:-default}, so secrets (SMTP password, tokens) can stay out of the file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { dialectOf, sqlitePath } from './db/index.js';
import { isValidDomain, isValidLocalPart, parseAddress } from './protocol/address.js';
import { DEFAULT_MAX_AGE_SECONDS, DIRECTORY_PATH, INTENTS, MAX_DESCRIPTION_LENGTH, PRIORITIES, WELL_KNOWN_PREFIX } from './protocol/constants.js';
import { cleanDescription } from './protocol/directory.js';
import type { CardType } from './protocol/types.js';

export interface RouteMatch {
  priority?: string[];
  intent?: string[];
  from_org?: string[];
  sender_type?: string[];
}

export interface Route {
  /** Conditions that must all hold. Absent on the default route. */
  match?: RouteMatch;
  default: boolean;
  channel: string;
  /** Channel-specific destination, e.g. an email address. Never published. Not needed by the `agent` channel. */
  to?: string;
}

/** The built-in channel that hands messages to a local agent through the node's event feed. */
export const AGENT_CHANNEL = 'agent';

/**
 * The built-in channel that keeps a message on the node, for an address whose
 * owner reads it there: on the node's inbox page, or through the local API.
 */
export const INBOX_CHANNEL = 'inbox';

/** Longest automatic reply an address can be given, in characters. */
export const MAX_AUTO_REPLY_LENGTH = 4000;

/** Channels every node has. They need no `channels` section and no `to`. */
export const BUILT_IN_CHANNELS: readonly string[] = [AGENT_CHANNEL, INBOX_CHANNEL];

export interface AddressConfig {
  local: string;
  address: string;
  type: CardType;
  name?: string;
  /** What the address is for, in one line. Published in the directory when the address is listed. */
  description?: string;
  /**
   * True to publish this address in the domain's directory, where anyone can
   * find it. Off unless set: an unlisted address still works for whoever knows it.
   */
  listed?: boolean;
  /** Agents only: the principal this agent acts for. Published in its card. */
  acts_for?: string;
  /**
   * What happens to a first message from a sender this address does not know:
   * `held` (the default) keeps it in the requests tray until someone approves
   * the sender; `open` delivers it at once. Either way a stranger may only
   * send `inform` or `request`, and the first-contact rate limits apply.
   */
  first_contact?: 'held' | 'open';
  /**
   * If set, the node answers each message delivered to this address with this
   * text: once per thread, never in answer to another automatic message, and
   * at most a few times an hour to the same sender.
   */
  auto_reply?: string;
  /**
   * Senders this address already trusts: exact addresses (`bot@acme.com`) or
   * whole domains (`*@acme.com`). Their first message skips the requests tray.
   */
  trusted: string[];
  routes: Route[];
}

/** True if `sender` is on the address's configured allowlist. */
export function isTrustedByConfig(address: AddressConfig, sender: string): boolean {
  const domain = sender.slice(sender.lastIndexOf('@') + 1);
  return address.trusted.includes(sender) || address.trusted.includes(`*@${domain}`);
}

export interface EmailChannelConfig {
  from: string;
  smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  /** Shared secret an inbound-mail webhook must present. Reply ingestion is disabled without it. */
  inbound_token?: string;
  /** Optional Reply-To template; `{token}` is replaced per message, e.g. reply+{token}@in.example.com. */
  reply_to?: string;
  read_receipts: boolean;
}

export interface NodeConfig {
  domain: string;
  /** Base URL other nodes (and mail clients, for read receipts) use to reach this node. */
  public_url: string;
  listen: { host: string; port: number };
  /** sqlite:<absolute path> (the default, under the data directory) or postgres://... */
  database_url: string;
  keys: { path: string; rotation_grace_days: number };
  /** Full access: the admin pages, the requests tray, delegations, and everything an agent may do. */
  admin: { token?: string; token_file: string };
  /** What a local agent needs and no more: send, mark read, follow its events, look things up. */
  agent: { token?: string; token_file: string };
  addresses: AddressConfig[];
  channels: { email?: EmailChannelConfig; [name: string]: unknown };
  rate_limits: { unknown_sender: { per_sender_per_hour: number; per_org_per_hour: number } };
  delivery: { max_attempts: number; backoff_base_seconds: number; backoff_max_seconds: number; poll_interval_ms: number };
  limits: {
    /** A message whose created_at is older than this is refused, whatever its expires_at says. */
    max_age_seconds: number;
    /** Stored messages are deleted this long after they arrived, once they have also expired. */
    retention_days: number;
  };
  delegation: {
    /** Life of a delegation token when the caller does not ask for one. */
    default_ttl_seconds: number;
    /** Longest life this node will sign a delegation token for. */
    max_ttl_seconds: number;
  };
  discovery: { overrides: Record<string, string>; allow_insecure: boolean; cache_ttl_seconds: number };
  plugins: string[];
}

export class ConfigError extends Error {}

/** Port a node listens on unless told otherwise. Public traffic is expected on 443, in front of it. */
export const DEFAULT_PORT = 7387;

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Replaces ${NAME} and ${NAME:-default} in every string of a parsed YAML tree. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, where = 'config'): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
      const found = env[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${where}: environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, env, `${where}[${i}]`));
  if (isObject(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env, `${where}.${k}`);
    return out;
  }
  return value;
}

class Reader {
  constructor(
    private readonly obj: Obj,
    private readonly where: string,
  ) {}

  private at(key: string): string {
    return this.where ? `${this.where}.${key}` : key;
  }

  str(key: string, fallback?: string): string {
    const v = this.obj[key];
    if (v === undefined || v === null || v === '') {
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${this.at(key)} is required`);
    }
    if (typeof v !== 'string' && typeof v !== 'number') throw new ConfigError(`${this.at(key)} must be a string`);
    return String(v);
  }

  optStr(key: string): string | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' && typeof v !== 'number') throw new ConfigError(`${this.at(key)} must be a string`);
    return String(v);
  }

  num(key: string, fallback: number, min = 0): number {
    const v = this.obj[key];
    if (v === undefined || v === null || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < min) throw new ConfigError(`${this.at(key)} must be a number >= ${min}`);
    return n;
  }

  bool(key: string, fallback: boolean): boolean {
    const v = this.obj[key];
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new ConfigError(`${this.at(key)} must be true or false`);
  }

  section(key: string): Reader {
    const v = this.obj[key];
    if (v === undefined || v === null) return new Reader({}, this.at(key));
    if (!isObject(v)) throw new ConfigError(`${this.at(key)} must be a mapping`);
    return new Reader(v, this.at(key));
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined && this.obj[key] !== null;
  }

  raw(key: string): unknown {
    return this.obj[key];
  }
}

function stringList(value: unknown, where: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => {
    if (typeof v !== 'string' && typeof v !== 'number') throw new ConfigError(`${where} must be a string or a list of strings`);
    return String(v).toLowerCase();
  });
}

const MATCH_KEYS = ['priority', 'intent', 'from_org', 'sender_type'] as const;

function parseRoutes(raw: unknown, where: string): Route[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${where} must be a list`);
  const routes: Route[] = [];
  raw.forEach((entry, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(entry)) throw new ConfigError(`${at} must be a mapping`);
    const r = new Reader(entry, at);
    const isDefault = r.bool('default', false);
    let match: RouteMatch | undefined;
    if (r.has('match')) {
      const m = r.raw('match');
      if (!isObject(m)) throw new ConfigError(`${at}.match must be a mapping`);
      match = {};
      for (const key of Object.keys(m)) {
        if (!(MATCH_KEYS as readonly string[]).includes(key)) {
          throw new ConfigError(`${at}.match.${key} is not supported (use ${MATCH_KEYS.join(', ')})`);
        }
        match[key as (typeof MATCH_KEYS)[number]] = stringList(m[key], `${at}.match.${key}`);
      }
      for (const intent of match.intent ?? []) {
        if (!(INTENTS as readonly string[]).includes(intent)) throw new ConfigError(`${at}.match.intent: unknown intent "${intent}"`);
      }
      for (const priority of match.priority ?? []) {
        if (!(PRIORITIES as readonly string[]).includes(priority)) {
          throw new ConfigError(`${at}.match.priority: unknown priority "${priority}" (use ${PRIORITIES.join(', ')})`);
        }
      }
      for (const type of match.sender_type ?? []) {
        if (type !== 'human' && type !== 'agent') throw new ConfigError(`${at}.match.sender_type must be human or agent`);
      }
      if (Object.keys(match).length === 0) match = undefined;
    }
    if (!isDefault && !match) throw new ConfigError(`${at} needs either a non-empty match or default: true`);
    if (isDefault && match) throw new ConfigError(`${at} cannot have both match and default: true`);
    const channel = r.str('channel').toLowerCase();
    const to = r.optStr('to');
    if (!to && !BUILT_IN_CHANNELS.includes(channel)) throw new ConfigError(`${at}.to is required for the ${channel} channel`);
    routes.push({ match, default: isDefault, channel, to });
  });
  if (routes.filter((r) => r.default).length > 1) throw new ConfigError(`${where} has more than one default route`);
  return routes;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env, baseDir = process.cwd()): NodeConfig {
  const tree = interpolateEnv(raw, env);
  if (!isObject(tree)) throw new ConfigError('config must be a YAML mapping');
  const root = new Reader(tree, '');

  const domain = root.str('domain').toLowerCase();
  if (!isValidDomain(domain)) throw new ConfigError(`domain "${domain}" is not a valid domain name`);

  const publicUrl = root.str('public_url', `https://${domain}`).replace(/\/+$/, '');
  try {
    const u = new URL(publicUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    throw new ConfigError(`public_url "${publicUrl}" must be an http(s) URL`);
  }

  const listen = root.section('listen');
  const dataDir = path.resolve(baseDir, root.str('data_dir', env.ADTP_DATA_DIR || './data'));
  const resolveData = (p: string) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));

  // Zero-config default: a SQLite file in the data directory. Point database_url (or
  // DATABASE_URL) at postgres://... to use Postgres instead.
  let databaseUrl = env.DATABASE_URL || root.optStr('database_url') || `sqlite:${path.join(dataDir, 'adtp.db')}`;
  const dialect = dialectOf(databaseUrl);
  if (!dialect) throw new ConfigError('database_url must be sqlite:<path> or postgres://user:password@host/database');
  if (dialect === 'sqlite' && sqlitePath(databaseUrl) !== ':memory:') {
    databaseUrl = `sqlite:${resolveData(sqlitePath(databaseUrl))}`;
  }

  const keys = root.section('keys');
  const admin = root.section('admin');
  const agent = root.section('agent');
  const limits = root.section('limits');
  const delegation = root.section('delegation');

  const rawAddresses = root.raw('addresses');
  if (!Array.isArray(rawAddresses) || rawAddresses.length === 0) {
    throw new ConfigError('addresses must list at least one address hosted by this node');
  }
  const addresses: AddressConfig[] = rawAddresses.map((entry, i) => {
    const at = `addresses[${i}]`;
    if (!isObject(entry)) throw new ConfigError(`${at} must be a mapping`);
    const r = new Reader(entry, at);
    const local = r.str('local').toLowerCase();
    if (!isValidLocalPart(local)) throw new ConfigError(`${at}.local "${local}" is not a valid address local part`);
    const type = r.str('type', 'human').toLowerCase();
    if (type !== 'human' && type !== 'agent') throw new ConfigError(`${at}.type must be human or agent`);

    let actsFor: string | undefined;
    const rawActsFor = r.optStr('acts_for');
    if (rawActsFor) {
      if (type !== 'agent') throw new ConfigError(`${at}.acts_for is only for agents`);
      const principal = parseAddress(rawActsFor.includes('@') ? rawActsFor : `${rawActsFor}@${domain}`);
      if (!principal) throw new ConfigError(`${at}.acts_for "${rawActsFor}" is not a valid address`);
      actsFor = principal.address;
    }

    const rawTrusted = r.raw('trusted');
    if (rawTrusted !== undefined && rawTrusted !== null && !Array.isArray(rawTrusted)) throw new ConfigError(`${at}.trusted must be a list`);
    const trusted = (Array.isArray(rawTrusted) ? rawTrusted : []).map((entry) => {
      const text = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
      if (text.startsWith('*@') && isValidDomain(text.slice(2))) return text;
      const exact = parseAddress(text);
      if (!exact) throw new ConfigError(`${at}.trusted: "${String(entry)}" must be an address (bot@acme.com) or a whole domain (*@acme.com)`);
      return exact.address;
    });

    const description = r.optStr('description');
    const listed = r.bool('listed', false);
    if (listed) {
      // The description is the whole point of an entry: it is how a stranger picks the right address.
      if (!description || !cleanDescription(description)) {
        throw new ConfigError(`${at}.listed needs a description: one line saying what ${local}@${domain} is for`);
      }
      if ([...description].length > MAX_DESCRIPTION_LENGTH) {
        throw new ConfigError(`${at}.description may be at most ${MAX_DESCRIPTION_LENGTH} characters when the address is listed`);
      }
    }

    const firstContact = r.str('first_contact', 'held').toLowerCase();
    if (firstContact !== 'held' && firstContact !== 'open') throw new ConfigError(`${at}.first_contact must be held or open`);
    const autoReply = r.optStr('auto_reply')?.trim() || undefined;
    if (autoReply && [...autoReply].length > MAX_AUTO_REPLY_LENGTH) {
      throw new ConfigError(`${at}.auto_reply may be at most ${MAX_AUTO_REPLY_LENGTH} characters`);
    }

    return {
      local,
      address: `${local}@${domain}`,
      type,
      name: r.optStr('name'),
      description,
      listed,
      first_contact: firstContact,
      auto_reply: autoReply,
      acts_for: actsFor,
      trusted,
      routes: parseRoutes(r.raw('routes'), `${at}.routes`),
    };
  });
  const seen = new Set<string>();
  for (const a of addresses) {
    if (seen.has(a.local)) throw new ConfigError(`addresses: "${a.local}" is listed twice`);
    seen.add(a.local);
  }

  const channelsRaw = root.raw('channels');
  if (channelsRaw !== undefined && channelsRaw !== null && !isObject(channelsRaw)) throw new ConfigError('channels must be a mapping');
  const channels: NodeConfig['channels'] = { ...(isObject(channelsRaw) ? channelsRaw : {}) };
  if (isObject(channelsRaw) && channelsRaw.email !== undefined && channelsRaw.email !== null) {
    const e = root.section('channels').section('email');
    const smtp = e.section('smtp');
    channels.email = {
      from: e.str('from', `ADTP <adtp@${domain}>`),
      smtp: {
        host: smtp.str('host'),
        port: smtp.num('port', 587, 1),
        secure: smtp.bool('secure', false),
        user: smtp.optStr('user'),
        pass: smtp.optStr('pass'),
      },
      inbound_token: e.section('inbound').optStr('token'),
      reply_to: e.optStr('reply_to'),
      read_receipts: e.bool('read_receipts', true),
    };
  }

  const unknown = root.section('rate_limits').section('unknown_sender');
  const delivery = root.section('delivery');
  const discovery = root.section('discovery');

  const overridesRaw = discovery.raw('overrides');
  const overrides: Record<string, string> = {};
  if (overridesRaw !== undefined && overridesRaw !== null) {
    if (!isObject(overridesRaw)) throw new ConfigError('discovery.overrides must map a domain to a card URL template');
    for (const [d, template] of Object.entries(overridesRaw)) {
      if (typeof template !== 'string' || !template.includes('{local}')) {
        throw new ConfigError(`discovery.overrides.${d} must be a URL template containing {local}`);
      }
      overrides[d.toLowerCase()] = template;
    }
  }

  const pluginsRaw = root.raw('plugins');
  if (pluginsRaw !== undefined && pluginsRaw !== null && !Array.isArray(pluginsRaw)) throw new ConfigError('plugins must be a list of module paths');
  const plugins = (Array.isArray(pluginsRaw) ? pluginsRaw : []).map((p) => {
    if (typeof p !== 'string') throw new ConfigError('plugins must be a list of module paths');
    return p.startsWith('.') ? path.resolve(baseDir, p) : p;
  });

  const config: NodeConfig = {
    domain,
    public_url: publicUrl,
    listen: { host: listen.str('host', '0.0.0.0'), port: listen.num('port', DEFAULT_PORT, 0) },
    database_url: databaseUrl,
    keys: {
      path: resolveData(keys.str('path', path.join(dataDir, 'keys', 'keyring.json'))),
      rotation_grace_days: keys.num('rotation_grace_days', 30, 0),
    },
    admin: {
      token: env.ADTP_ADMIN_TOKEN || admin.optStr('token'),
      token_file: resolveData(admin.str('token_file', path.join(dataDir, 'admin-token'))),
    },
    agent: {
      token: env.ADTP_AGENT_TOKEN || agent.optStr('token'),
      token_file: resolveData(agent.str('token_file', path.join(dataDir, 'agent-token'))),
    },
    addresses,
    channels,
    rate_limits: {
      unknown_sender: {
        per_sender_per_hour: unknown.num('per_sender_per_hour', 5, 0),
        per_org_per_hour: unknown.num('per_org_per_hour', 20, 0),
      },
    },
    delivery: {
      max_attempts: delivery.num('max_attempts', 8, 1),
      backoff_base_seconds: delivery.num('backoff_base_seconds', 5, 0),
      backoff_max_seconds: delivery.num('backoff_max_seconds', 3600, 0),
      poll_interval_ms: delivery.num('poll_interval_ms', 1000, 50),
    },
    limits: {
      max_age_seconds: Math.floor(limits.num('max_age_days', DEFAULT_MAX_AGE_SECONDS / 86400, 0.001) * 86400),
      retention_days: limits.num('retention_days', 30, 1),
    },
    delegation: {
      default_ttl_seconds: Math.floor(delegation.num('default_ttl_hours', 24, 0.01) * 3600),
      max_ttl_seconds: Math.floor(delegation.num('max_ttl_hours', 7 * 24, 0.01) * 3600),
    },
    discovery: {
      overrides,
      allow_insecure: discovery.bool('allow_insecure', false),
      cache_ttl_seconds: discovery.num('cache_ttl_seconds', 300, 0),
    },
    plugins,
  };

  if (config.delegation.default_ttl_seconds > config.delegation.max_ttl_seconds) {
    throw new ConfigError('delegation.default_ttl_hours cannot be larger than delegation.max_ttl_hours');
  }
  if (config.admin.token && config.agent.token && config.admin.token === config.agent.token) {
    throw new ConfigError('the agent token must differ from the admin token: it exists so that agents do not hold admin access');
  }
  for (const a of config.addresses) {
    for (const route of a.routes) {
      if (!BUILT_IN_CHANNELS.includes(route.channel) && !config.channels[route.channel]) {
        throw new ConfigError(`addresses: ${a.address} routes to ${route.channel}, but channels.${route.channel} is not configured`);
      }
    }
  }
  return config;
}

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const resolved = path.resolve(file);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file ${resolved}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`config file ${resolved} is not valid YAML: ${(err as Error).message}`);
  }
  return parseConfig(raw, env, path.dirname(resolved));
}

/** The DNS TXT record that lets other nodes discover this node's cards and its directory. */
export function dnsTxtRecord(config: Pick<NodeConfig, 'domain' | 'public_url'>): { name: string; value: string } {
  return {
    name: `_adtp.${config.domain}`,
    value: `v=adtp0; card=${config.public_url}${WELL_KNOWN_PREFIX}{local}; directory=${config.public_url}${DIRECTORY_PATH}`,
  };
}
