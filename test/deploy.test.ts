/**
 * The ways to deploy a node (the image's own config, Render, Fly.io) must agree
 * on what a node needs: the same variables, the same disk, the same port.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from '../src/config.js';

// The compiled test lives in dist/test; these files are at the repository root.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const ENV_CONFIG = path.join(ROOT, 'deploy', 'env.config.yaml');

/** The variables the image's config cannot start without: `${NAME}` with no default. */
const required = [...new Set([...read('deploy/env.config.yaml').matchAll(/^[^#\n]*\$\{([A-Z_]+)\}/gm)].map((m) => m[1]!))];
const minimal = { ADTP_DOMAIN: 'example.com', ADTP_PUBLIC_URL: 'https://adtp.example.com', ADTP_LOCAL: 'you' };

describe('deploying: the image\'s config', () => {
  it('starts from three variables and nothing else', () => {
    assert.deepEqual(required.sort(), ['ADTP_DOMAIN', 'ADTP_LOCAL', 'ADTP_PUBLIC_URL']);
    const config = loadConfig(ENV_CONFIG, minimal);
    assert.deepEqual(config.addresses.map((a) => [a.address, a.type, a.listed, a.first_contact, a.auto_reply, a.routes[0]?.channel]), [
      ['you@example.com', 'human', false, 'held', undefined, 'inbox'],
    ]);
    assert.throws(() => loadConfig(ENV_CONFIG, { ...minimal, ADTP_DOMAIN: undefined }), /environment variable ADTP_DOMAIN is not set/);
  });

  it('listens where the platform says, or on 7387', () => {
    assert.equal(loadConfig(ENV_CONFIG, minimal).listen.port, 7387);
    assert.equal(loadConfig(ENV_CONFIG, { ...minimal, PORT: '10000' }).listen.port, 10000);
  });

  it('is what the image starts with, and the image can be built to run as root', () => {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /COPY deploy\/env\.config\.yaml \.\/adtp\.config\.yaml/);
    assert.match(dockerfile, /ARG RUN_AS=node\nUSER \$\{RUN_AS\}/);
    // The health check asks the port the config listens on, not a fixed one.
    assert.match(dockerfile, /HEALTHCHECK[^\n]*\\\n\s*CMD wget [^\n]*127\.0\.0\.1:\$\{PORT:-7387\}\/healthz/);
  });
});

describe('deploying: Render', () => {
  const [service] = (parseYaml(read('render.yaml')) as { services: Record<string, any>[] }).services;
  const vars = new Map<string, Record<string, unknown>>((service!.envVars as Record<string, unknown>[]).map((v) => [v.key as string, v]));

  it('is one Docker web service with the node\'s disk and health check', () => {
    assert.deepEqual([service!.type, service!.runtime, service!.numInstances], ['web', 'docker', 1]);
    assert.equal(service!.healthCheckPath, '/healthz');
    assert.equal(service!.disk.mountPath, '/data', 'where the node keeps its key and messages');
    assert.equal(service!.autoDeploy, false, 'a node is not redeployed by someone else\'s push');
  });

  it('asks for exactly what the node cannot start without, and generates the tokens', () => {
    const asked = [...vars].filter(([, v]) => v.sync === false).map(([key]) => key);
    assert.deepEqual(asked.sort(), [...required].sort());
    assert.equal(vars.get('ADTP_ADMIN_TOKEN')?.generateValue, true);
    assert.equal(vars.get('ADTP_AGENT_TOKEN')?.generateValue, true);
    assert.equal(vars.get('RUN_AS')?.value, 'root', 'passed to the image build, so the node can write to the disk');
    assert.ok(!vars.has('PORT'), 'Render sets PORT itself, and the node listens there');
  });
});

describe('deploying: Fly.io', () => {
  const fly = read('fly.toml');
  const script = read('deploy/fly/launch.sh');

  it('routes to the port the node listens on, keeps one machine running, and mounts the disk', () => {
    assert.match(fly, /\[env\]\n\s*PORT = "7387"/);
    assert.match(fly, /internal_port = 7387/);
    assert.match(fly, /destination = "\/data"/);
    assert.match(fly, /auto_stop_machines = false/);
    assert.match(fly, /RUN_AS = "root"/);
  });

  it('sets every variable the node cannot start without', () => {
    for (const name of required) assert.ok(script.includes(`"${name}=`), `launch.sh sets ${name}`);
  });
});

describe('deploying: the guide', () => {
  const guide = read('deploy/README.md');

  it('names every variable the image reads', () => {
    const all = [...new Set([...read('deploy/env.config.yaml').matchAll(/^[^#\n]*\$\{([A-Z_]+)/gm)].map((m) => m[1]!))];
    for (const name of all) assert.ok(guide.includes(`\`${name}\``), `deploy/README.md explains ${name}`);
  });

  it('gives the Render button the public repository', () => {
    assert.ok(guide.includes('https://render.com/deploy?repo=https://github.com/adtprotocol/adtp'));
  });
});

describe('deploying: what stays out of an image, and off the network', () => {
  it('keeps credential files out of the build, wherever they are', () => {
    const ignored = read('.dockerignore').split('\n').map((line) => line.trim());
    // The guides have people create .env files beside the Compose files under demo/ and examples/.
    for (const rule of ['**/.env', '**/.env.*', '**/*.env', '**/keyring.json', '**/admin-token', '**/agent-token', 'demo/raw']) {
      assert.ok(ignored.includes(rule), `.dockerignore has ${rule}`);
    }
    // And the stage the node image is built from takes only source files from those directories.
    const build = read('Dockerfile').split(/^FROM /m).find((stage) => /^\S+ AS build\n/.test(stage))!;
    assert.doesNotMatch(build, /^COPY (demo|examples) /m);
    assert.match(build, /^COPY demo\/\*\.ts \.\/demo\/$/m);
  });

  it('publishes the quickstart on this machine only, unless told otherwise', () => {
    const compose = parseYaml(read('docker-compose.yml')) as { services: Record<string, { ports?: string[] }> };
    assert.deepEqual(compose.services.node!.ports, ['${ADTP_BIND:-127.0.0.1}:${ADTP_HTTP_PORT:-7387}:7387']);
    assert.deepEqual(compose.services.mailpit!.ports, ['127.0.0.1:${MAILPIT_UI_PORT:-8025}:8025']);
  });
});

describe('releasing', () => {
  it('states one version: package.json, its lockfile, and what the node reports', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> };
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.version, version);
    assert.equal(lock.packages['']!.version, version);
    assert.match(read('src/cli.ts'), new RegExp(`const VERSION = '${version.replaceAll('.', '\\.')}';`));
  });
});

