/**
 * The demo without Docker: both nodes, the echo agent and the driver run as
 * ordinary processes on this machine. It is the same code and the same two
 * configs as the Docker demo (demo/local/*.config.yaml). Only how the two
 * nodes reach each other differs: ports on localhost instead of container
 * names.
 *
 *   node dist/demo/local.js             send the demo message and follow it to the reply
 *   node dist/demo/local.js --tamper    corrupt one byte in transit and show Side B rejecting it
 *   node dist/demo/local.js --watch     transcribe the next message a real agent sends through Side A
 *
 * `bash demo/run.sh` starts this when Docker is not available, or with --no-docker.
 * Each run starts from nothing and removes its data when it ends.
 *
 * Environment: ADTP_DEMO_PORTS ("7388,7389"), OUT_DIR (where transcripts go).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';

// The compiled file lives in dist/demo; the configs are in the repository's demo/local.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');

interface Side {
  name: 'stratus' | 'echo';
  domain: string;
  port: number;
  adminToken: string;
  agentToken: string;
}

const [stratusPort, echoPort] = (process.env.ADTP_DEMO_PORTS ?? '7388,7389').split(',').map((p) => Number(p.trim()));
if (!Number.isInteger(stratusPort) || !Number.isInteger(echoPort) || stratusPort === echoPort) {
  console.error('ADTP_DEMO_PORTS must name two different ports, for example 7388,7389');
  process.exit(2);
}
const stratus: Side = { name: 'stratus', domain: 'stratuslabs.localhost', port: stratusPort!, adminToken: 'demo-stratus-admin', agentToken: 'demo-stratus-agent' };
const echo: Side = { name: 'echo', domain: 'demo.adtp.localhost', port: echoPort!, adminToken: 'demo-echo-admin', agentToken: 'demo-echo-agent' };
const url = (side: Side) => `http://127.0.0.1:${side.port}`;

const children: ChildProcess[] = [];
let dataDir: string | null = null;

function cleanUp(): void {
  for (const child of children) child.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** The side's config from demo/local, with the other node reached on localhost instead of by container name. */
function writeConfig(side: Side, other: Side, dir: string): string {
  const config = parseYaml(readFileSync(path.join(ROOT, 'demo', 'local', `${side.name}.config.yaml`), 'utf8')) as Record<string, unknown>;
  config.public_url = url(side);
  config.listen = { host: '127.0.0.1', port: side.port };
  config.discovery = { allow_insecure: true, overrides: { [other.domain]: `${url(other)}/.well-known/adtp/{local}` } };
  const file = path.join(dir, `${side.name}.config.yaml`);
  writeFileSync(file, toYaml(config));
  return file;
}

/**
 * What a demo process is started with: the few variables any program needs,
 * and nothing else from this shell. A node reads its settings from its
 * environment (DATABASE_URL, ADTP_PRIVATE_KEY, ...), and the demo's nodes must
 * never pick up the database or the key of a real one.
 */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Starts a child and keeps what it prints, to show if it fails. */
function start(script: string, args: string[], env: Record<string, string>): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [path.join(DIST, script), ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()));
  children.push(child);
  return { child, output: () => text };
}

async function waitUntilHealthy(side: Side, node: { child: ChildProcess; output: () => string }): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (node.child.exitCode !== null) throw new Error(`the ${side.name} node stopped while starting:\n${node.output()}`);
    try {
      if ((await fetch(`${url(side)}/healthz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the ${side.name} node did not start within 30 seconds:\n${node.output()}`);
}

/**
 * The echo agent only sees messages that arrive after it started following
 * its feed, so the driver must not send before the agent says it is ready.
 */
async function waitUntilReady(agent: { child: ChildProcess; output: () => string }): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (agent.output().includes('ready: waiting for messages')) return;
    if (agent.child.exitCode !== null) throw new Error(`the echo agent stopped while starting:\n${agent.output()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the echo agent was not ready within 30 seconds:\n${agent.output()}`);
}

async function main(): Promise<number> {
  for (const side of [stratus, echo]) {
    if (!(await portIsFree(side.port))) {
      console.error(`Port ${side.port} is in use, so the ${side.name} node cannot start there.`);
      console.error('If the Docker demo is running, stop it with: bash demo/run.sh --down');
      console.error('Or choose other ports: ADTP_DEMO_PORTS=17388,17389 bash demo/run.sh --no-docker');
      return 1;
    }
  }
  dataDir = mkdtempSync(path.join(tmpdir(), 'adtp-demo-'));

  const nodes = ([[stratus, echo], [echo, stratus]] as const).map(([side, other]) => {
    const node = start('src/cli.js', ['start', '--config', writeConfig(side, other, dataDir!)], {
      ADTP_DATA_DIR: path.join(dataDir!, side.name),
      ADTP_ADMIN_TOKEN: side.adminToken,
      ADTP_AGENT_TOKEN: side.agentToken,
      LOG_LEVEL: 'warn',
    });
    return { side, node };
  });
  for (const { side, node } of nodes) await waitUntilHealthy(side, node);

  // Side B's scripted agent: talks only to its own node's API, with the agent token.
  const agent = start('demo/echo-agent.js', [], { ADTP_NODE_URL: url(echo), ADTP_AGENT_TOKEN: echo.agentToken, ADTP_ADDRESS: `echo@${echo.domain}` });
  await waitUntilReady(agent);

  // The driver plays the Stratus agent's part and prints the transcript, straight to this terminal.
  const driver = spawn(process.execPath, [path.join(DIST, 'demo', 'run.js'), ...process.argv.slice(2)], {
    env: {
      ...process.env,
      STRATUS_NODE_URL: url(stratus),
      STRATUS_TOKEN: stratus.agentToken,
      FROM_ADDRESS: `agent@${stratus.domain}`,
      TO_ADDRESS: `echo@${echo.domain}`,
      OUT_DIR: process.env.OUT_DIR ?? path.join(ROOT, 'demo'),
      ...(process.stdout.isTTY && !process.env.FORCE_COLOR ? { FORCE_COLOR: '1' } : {}),
    },
    stdio: 'inherit',
  });
  children.push(driver);
  const code = await new Promise<number>((resolve) => driver.once('exit', (exit) => resolve(exit ?? 1)));
  if (code !== 0 && agent.child.exitCode !== null) console.error(`\nThe echo agent had stopped:\n${agent.output()}`);
  return code;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

main()
  .then((code) => {
    cleanUp();
    process.exit(code);
  })
  .catch((err: Error) => {
    console.error(err.message);
    cleanUp();
    process.exit(1);
  });
