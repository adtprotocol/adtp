import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, dnsTxtRecord, interpolateEnv, isTrustedByConfig, parseConfig } from '../src/config.js';

const base = () => ({
  domain: 'Example.com',
  public_url: 'https://adtp.example.com/',
  database_url: 'postgres://adtp:adtp@db/adtp',
  addresses: [
    {
      local: 'Dylan',
      type: 'human',
      routes: [
        { match: { priority: ['urgent'], sender_type: 'agent' }, channel: 'email', to: 'urgent@example.com' },
        { match: { intent: 'approval.request', from_org: 'Acme.com' }, channel: 'email', to: 'approvals@example.com' },
        { default: true, channel: 'email', to: 'dylan@example.com' },
      ],
    },
    { local: 'assistant', type: 'agent', name: 'Assistant' },
  ],
  channels: { email: { from: 'ADTP <adtp@example.com>', smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: '${SMTP_PASS}' } } },
});

describe('config', () => {
  it('parses a full config and applies defaults', () => {
    const config = parseConfig(base(), { SMTP_PASS: 'hunter2' }, '/srv/adtp');
    assert.equal(config.domain, 'example.com');
    assert.equal(config.public_url, 'https://adtp.example.com');
    assert.deepEqual(config.addresses.map((a) => [a.address, a.type]), [
      ['dylan@example.com', 'human'],
      ['assistant@example.com', 'agent'],
    ]);
    assert.deepEqual(config.addresses[0]!.routes[0], {
      match: { priority: ['urgent'], sender_type: ['agent'] },
      default: false,
      channel: 'email',
      to: 'urgent@example.com',
    });
    assert.deepEqual(config.addresses[0]!.routes[1]!.match, { intent: ['approval.request'], from_org: ['acme.com'] });
    assert.equal(config.channels.email!.smtp.pass, 'hunter2');
    assert.equal(config.channels.email!.read_receipts, true);
    assert.equal(config.keys.path, '/srv/adtp/data/keys/keyring.json');
    assert.equal(config.admin.token_file, '/srv/adtp/data/admin-token');
    assert.equal(config.agent.token_file, '/srv/adtp/data/agent-token');
    assert.equal(config.listen.port, 7387);
    assert.equal(config.keys.rotation_grace_days, 30);
    assert.deepEqual(config.limits, { max_age_seconds: 7 * 86400, retention_days: 30 });
    assert.deepEqual(config.delegation, { default_ttl_seconds: 24 * 3600, max_ttl_seconds: 7 * 24 * 3600 });
    assert.deepEqual(config.rate_limits.unknown_sender, { per_sender_per_hour: 5, per_org_per_hour: 20 });
    assert.equal(config.delivery.max_attempts, 8);
    assert.equal(config.discovery.allow_insecure, false);
  });

  it('defaults to a SQLite file in the data directory, with nothing to configure', () => {
    const c = base() as any;
    delete c.database_url;
    assert.equal(parseConfig(c, { SMTP_PASS: 'x' }, '/srv/adtp').database_url, 'sqlite:/srv/adtp/data/adtp.db');
    assert.equal(parseConfig(c, { SMTP_PASS: 'x', ADTP_DATA_DIR: '/data' }, '/srv/adtp').database_url, 'sqlite:/data/adtp.db');
    assert.equal(parseConfig({ ...c, data_dir: '/var/lib/adtp' }, { SMTP_PASS: 'x' }, '/srv/adtp').database_url, 'sqlite:/var/lib/adtp/adtp.db');
  });

  it('switches to Postgres with one setting, and resolves relative SQLite paths', () => {
    const c = base() as any;
    assert.equal(parseConfig(c, { SMTP_PASS: 'x' }).database_url, 'postgres://adtp:adtp@db/adtp');
    assert.equal(parseConfig({ ...c, database_url: 'sqlite:./var/node.db' }, { SMTP_PASS: 'x' }, '/srv/adtp').database_url, 'sqlite:/srv/adtp/var/node.db');
    assert.equal(parseConfig({ ...c, database_url: 'sqlite::memory:' }, { SMTP_PASS: 'x' }).database_url, 'sqlite::memory:');
    assert.equal(parseConfig({ ...c, database_url: 'sqlite:./x.db' }, { SMTP_PASS: 'x', DATABASE_URL: 'postgresql://env/db' }).database_url, 'postgresql://env/db');
  });

  it('lets the environment supply the database URL and the two tokens', () => {
    const env = { SMTP_PASS: 'x', DATABASE_URL: 'postgres://env/db', ADTP_ADMIN_TOKEN: 'admin-from-env', ADTP_AGENT_TOKEN: 'agent-from-env' };
    const config = parseConfig({ ...base(), database_url: undefined }, env);
    assert.equal(config.database_url, 'postgres://env/db');
    assert.equal(config.admin.token, 'admin-from-env');
    assert.equal(config.agent.token, 'agent-from-env');
    assert.throws(
      () => parseConfig(base(), { ...env, ADTP_AGENT_TOKEN: 'admin-from-env' }),
      /agent token must differ from the admin token/,
      'one token for both roles would defeat the split',
    );
  });

  it('reads the replay window, retention and delegation lifetimes', () => {
    const config = parseConfig(
      { ...base(), limits: { max_age_days: 2, retention_days: 10 }, delegation: { default_ttl_hours: 1, max_ttl_hours: 48 } },
      { SMTP_PASS: 'x' },
    );
    assert.deepEqual(config.limits, { max_age_seconds: 2 * 86400, retention_days: 10 });
    assert.deepEqual(config.delegation, { default_ttl_seconds: 3600, max_ttl_seconds: 48 * 3600 });
    assert.throws(() => parseConfig({ ...base(), delegation: { default_ttl_hours: 48, max_ttl_hours: 24 } }, { SMTP_PASS: 'x' }), /cannot be larger than/);
    assert.throws(() => parseConfig({ ...base(), limits: { retention_days: 0 } }, { SMTP_PASS: 'x' }), /retention_days must be a number >= 1/);
  });

  it('interpolates ${VAR} and ${VAR:-default}, and fails on unset variables', () => {
    assert.deepEqual(interpolateEnv({ a: '${X}', b: ['${Y:-fallback}', 3], c: 'pre-${X}-post' }, { X: 'val' }), {
      a: 'val',
      b: ['fallback', 3],
      c: 'pre-val-post',
    });
    assert.throws(() => parseConfig(base(), {}), /SMTP_PASS is not set/);
  });

  it('explains what is wrong with an invalid config', () => {
    const bad = (mutate: (c: any) => void, pattern: RegExp) => {
      const c = base();
      mutate(c);
      assert.throws(() => parseConfig(c, { SMTP_PASS: 'x' }), (err: Error) => err instanceof ConfigError && pattern.test(err.message), String(pattern));
    };
    bad((c) => delete c.domain, /domain is required/);
    bad((c) => (c.domain = 'not a domain'), /not a valid domain/);
    bad((c) => (c.addresses = []), /at least one address/);
    bad((c) => (c.addresses[0].local = 'has space'), /not a valid address local part/);
    bad((c) => (c.addresses[1].type = 'robot'), /must be human or agent/);
    bad((c) => c.addresses.push({ local: 'dylan' }), /listed twice/);
    bad((c) => (c.addresses[0].routes[0].match.channel = 'x'), /match\.channel is not supported/);
    bad((c) => (c.addresses[0].routes[1].match.intent = 'shout'), /unknown intent/);
    bad((c) => (c.addresses[0].routes[0].match.priority = 'high'), /unknown priority "high" \(use low, normal, urgent\)/);
    bad((c) => c.addresses[0].routes.push({ default: true, channel: 'email', to: 'x@example.com' }), /more than one default route/);
    bad((c) => c.addresses[0].routes.push({ channel: 'email', to: 'x@example.com' }), /needs either a non-empty match or default/);
    bad((c) => delete c.channels.email, /channels\.email is not configured/);
    bad((c) => (c.discovery = { overrides: { 'b.test': 'http://b/no-placeholder' } }), /\{local\}/);
    bad((c) => (c.delivery = { max_attempts: 0 }), /max_attempts must be a number >= 1/);
    bad((c) => (c.database_url = 'mysql://db/adtp'), /database_url must be sqlite:<path> or postgres:/);
  });

  it('parses agents: acts_for, the trusted allowlist and the agent channel', () => {
    const c = base() as any;
    c.addresses = [
      { local: 'dylan', type: 'human' },
      {
        local: 'agent',
        type: 'agent',
        acts_for: 'Dylan',
        trusted: ['Echo@Demo.ADTP.dev', '*@Partner.com'],
        routes: [{ default: true, channel: 'agent' }],
      },
      { local: 'roaming', type: 'agent', acts_for: 'ceo@elsewhere.com' },
    ];
    delete c.channels;
    const config = parseConfig(c, {});
    const agent = config.addresses[1]!;
    assert.equal(agent.acts_for, 'dylan@example.com', 'a bare local part means an address on this domain');
    assert.deepEqual(agent.trusted, ['echo@demo.adtp.dev', '*@partner.com']);
    assert.deepEqual(agent.routes, [{ match: undefined, default: true, channel: 'agent', to: undefined }], 'the agent channel needs no destination');
    assert.equal(config.addresses[2]!.acts_for, 'ceo@elsewhere.com');
    assert.deepEqual(config.addresses[0]!.trusted, []);

    assert.equal(isTrustedByConfig(agent, 'echo@demo.adtp.dev'), true);
    assert.equal(isTrustedByConfig(agent, 'anyone@partner.com'), true);
    assert.equal(isTrustedByConfig(agent, 'other@demo.adtp.dev'), false);
    assert.equal(isTrustedByConfig(agent, 'x@notpartner.com'), false);
  });

  it('rejects bad agent settings', () => {
    const bad = (mutate: (c: any) => void, pattern: RegExp) => {
      const c = base();
      mutate(c);
      assert.throws(() => parseConfig(c, { SMTP_PASS: 'x' }), (err: Error) => err instanceof ConfigError && pattern.test(err.message), String(pattern));
    };
    bad((c) => (c.addresses[0].acts_for = 'boss'), /acts_for is only for agents/);
    bad((c) => (c.addresses[1].acts_for = 'not an address'), /not a valid address/);
    bad((c) => (c.addresses[1].trusted = 'bot@acme.com'), /trusted must be a list/);
    bad((c) => (c.addresses[1].trusted = ['acme.com']), /must be an address \(bot@acme\.com\) or a whole domain/);
    bad((c) => (c.addresses[1].routes = [{ default: true, channel: 'email' }]), /to is required for the email channel/);
    bad((c) => (c.addresses[1].routes = [{ default: true, channel: 'slack', to: '#general' }]), /channels\.slack is not configured/);
  });

  it('builds the DNS TXT record to publish', () => {
    assert.deepEqual(dnsTxtRecord({ domain: 'example.com', public_url: 'https://adtp.example.com' }), {
      name: '_adtp.example.com',
      value: 'v=adtp0; card=https://adtp.example.com/.well-known/adtp/{local}; directory=https://adtp.example.com/.well-known/adtp',
    });
  });
});
