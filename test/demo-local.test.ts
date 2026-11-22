/**
 * The demo for someone without Docker: demo/local.js runs both nodes as
 * ordinary processes, and demo/run.sh falls back to it, or says what to
 * install when the machine can run neither.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { freePort } from './helpers.js';

// The compiled test lives in dist/test; the scripts are at the repository root.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LOCAL = path.join(ROOT, 'dist', 'demo', 'local.js');

function run(command: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', (code) => resolve({ code, out }));
  });
}

/** Where a command lives on this machine's PATH. */
function which(tool: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, tool))) return path.join(dir, tool);
  }
  throw new Error(`${tool} is not on the PATH`);
}

/** A stand-in for Docker that is installed but not running. */
const STOPPED_DOCKER = '#!/bin/sh\ncase "$1" in compose) exit 0 ;; info) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;; esac\nexit 1\n';
/** A stand-in for a Node.js too old to run the node. */
const OLD_NODE = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v18.19.0; exit 0; fi\nexit 1\n';

describe('the demo without Docker', () => {
  let dir: string;
  let out: string;
  let ports: string;

  /**
   * A directory to use as PATH: what run.sh itself needs, plus the extras.
   * An extra is a path to link to, or a script to write. No docker and no
   * node unless given, whatever this machine has.
   */
  function pathWith(name: string, extras: Record<string, string> = {}): string {
    const bin = path.join(dir, name);
    mkdirSync(bin);
    for (const tool of ['bash', 'sh', 'dirname', 'basename', 'id', 'sed', 'cat', 'env']) symlinkSync(which(tool), path.join(bin, tool));
    for (const [tool, target] of Object.entries(extras)) {
      if (target.startsWith('#!')) {
        writeFileSync(path.join(bin, tool), target);
        chmodSync(path.join(bin, tool), 0o755);
      } else {
        symlinkSync(target, path.join(bin, tool));
      }
    }
    return bin;
  }
  const script = (bin: string, ...args: string[]) => run(which('bash'), ['demo/run.sh', ...args], { PATH: bin, OUT_DIR: out, ADTP_DEMO_PORTS: ports });

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'adtp-demo-local-'));
    out = path.join(dir, 'out');
    ports = `${await freePort()},${await freePort()}`;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('local.js runs the whole exchange with both nodes as processes, and leaves nothing behind', async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('adtp-demo-') && !name.startsWith('adtp-demo-local-'));
    const result = await run(process.execPath, [LOCAL], { PATH: process.env.PATH ?? '', OUT_DIR: out, ADTP_DEMO_PORTS: ports });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /agent@stratuslabs\.localhost → echo@demo\.adtp\.localhost/);
    assert.match(result.out, /delegation verified: agent@stratuslabs\.localhost acts for dylan@stratuslabs\.localhost/);
    assert.match(result.out, /✓ accepted, delivered, read, and a reply on the same thread/);
    const transcript = JSON.parse(readFileSync(path.join(out, 'transcript.json'), 'utf8')) as { mode: string; from: string; to: string; result: { ok: boolean } };
    assert.deepEqual([transcript.mode, transcript.from, transcript.to, transcript.result.ok], ['send', 'agent@stratuslabs.localhost', 'echo@demo.adtp.localhost', true]);
    const left = readdirSync(tmpdir()).filter((name) => name.startsWith('adtp-demo-') && !name.startsWith('adtp-demo-local-'));
    assert.deepEqual(left, before, 'the nodes\' keys and databases are removed when the run ends');
  });

  it('local.js keeps its nodes away from a database or a key set in the caller\'s shell', async () => {
    // What someone who also runs a real node may have exported.
    const theirs = path.join(dir, 'a-real-node.db');
    const result = await run(process.execPath, [LOCAL], {
      PATH: process.env.PATH ?? '',
      OUT_DIR: out,
      ADTP_DEMO_PORTS: ports,
      DATABASE_URL: `sqlite:${theirs}`,
      ADTP_PRIVATE_KEY: 'not-a-key-and-not-the-demo\'s-business',
      ADTP_DATA_DIR: path.join(dir, 'a-real-node-data'),
      PORT: '1',
    });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /✓ accepted, delivered, read, and a reply on the same thread/);
    assert.equal(existsSync(theirs), false, 'the demo opened its own databases, not this one');
    assert.equal(existsSync(path.join(dir, 'a-real-node-data')), false);
  });

  it('local.js --tamper shows Side B refusing the altered envelope', async () => {
    const result = await run(process.execPath, [LOCAL, '--tamper'], { PATH: process.env.PATH ?? '', OUT_DIR: out, ADTP_DEMO_PORTS: ports });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /✓ Side B refused the tampered envelope/);
  });

  it('local.js says which port is taken, and how to choose others', async () => {
    const taken = Number(ports.split(',')[0]);
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(taken, '127.0.0.1', resolve));
    try {
      const result = await run(process.execPath, [LOCAL], { PATH: process.env.PATH ?? '', OUT_DIR: out, ADTP_DEMO_PORTS: ports });
      assert.equal(result.code, 1);
      assert.match(result.out, new RegExp(`Port ${taken} is in use`));
      assert.match(result.out, /ADTP_DEMO_PORTS=/);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('run.sh without Docker says so and runs the demo with Node.js', async () => {
    const result = await script(pathWith('node-only', { node: process.execPath }));
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Docker is not installed, so the demo runs with Node\.js instead/);
    assert.match(result.out, /✓ accepted, delivered, read, and a reply on the same thread/);
  });

  it('run.sh with Docker installed but not running falls back the same way, and says how to use containers', async () => {
    const result = await script(pathWith('stopped-with-node', { docker: STOPPED_DOCKER, node: process.execPath }));
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Docker is installed but not running, so the demo runs with Node\.js instead/);
    assert.match(result.out, /To use containers, start Docker and run this again/);
    assert.match(result.out, /✓ accepted, delivered, read/);
  });

  it('run.sh --no-docker runs with Node.js without comment', async () => {
    const result = await script(pathWith('asked', { node: process.execPath }), '--no-docker', '--tamper');
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /✓ Side B refused the tampered envelope/);
  });

  it('run.sh with neither Docker nor Node.js says what to install', async () => {
    const result = await script(pathWith('bare'));
    assert.equal(result.code, 1);
    assert.match(result.out, /The demo needs Docker, or Node\.js 22\.20 or newer\. Docker is not installed\. There is no Node\.js on this machine either\./);
    assert.match(result.out, /https:\/\/docs\.docker\.com\/get-docker\//);
    assert.match(result.out, /https:\/\/nodejs\.org\//);
    assert.match(result.out, /Either one is enough/);
    assert.doesNotMatch(result.out, /command not found/, 'never the shell\'s own error');
  });

  it('run.sh with a stopped Docker and no usable Node.js says to start Docker', async () => {
    const none = await script(pathWith('stopped', { docker: STOPPED_DOCKER }));
    assert.equal(none.code, 1);
    assert.match(none.out, /Docker is installed but not running\. Start it/);

    const old = await script(pathWith('stopped-old-node', { docker: STOPPED_DOCKER, node: OLD_NODE }));
    assert.equal(old.code, 1);
    assert.match(old.out, /Docker is installed but not running\. Start it/);
    assert.match(old.out, /The Node\.js here \(v18\.19\.0\) is older than 22\.20/);
  });

  it('run.sh --public and --down without Docker say what applies', async () => {
    const bin = pathWith('public', { node: process.execPath });
    const live = await script(bin, '--public');
    assert.equal(live.code, 1);
    assert.match(live.out, /Docker is not installed, and --public needs it/);
    assert.doesNotMatch(live.out, /nodejs\.org/, 'Node.js would not help here');

    const down = await script(bin, '--down');
    assert.equal(down.code, 0);
    assert.match(down.out, /Nothing to stop/);
  });

  it('run.sh with Docker says it is building the first time, and stays quiet once the image exists', async () => {
    // A stand-in for a working Docker that writes down what it was asked.
    const calls = path.join(dir, 'docker-calls.log');
    const docker = (imageExists: boolean) =>
      `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$1 $2" in\n  "image inspect") exit ${imageExists ? 0 : 1} ;;\n  "compose build") echo "#1 building (stand-in)"; exit 0 ;;\nesac\ncase "$*" in *" run "*) echo "✓ the exchange (stand-in)" ;; esac\nexit 0\n`;
    const asked = () => readFileSync(calls, 'utf8').trim().split('\n').map((line) => line.split(' ').slice(0, 3).join(' '));

    const first = await script(pathWith('docker-first-run', { docker: docker(false) }));
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Building the demo image\. The first time takes a few minutes, longer on a slow connection\. Progress follows\./);
    assert.match(first.out, /#1 building \(stand-in\)/, 'the build\'s own progress is shown');
    assert.match(first.out, /✓ the exchange/);
    const order = asked();
    assert.ok(order.indexOf('compose build stratus-node') > -1 && order.indexOf('compose build stratus-node') < order.findIndex((c) => c.startsWith('compose up')), 'built before the nodes are started');

    rmSync(calls);
    const later = await script(pathWith('docker-later-run', { docker: docker(true) }));
    assert.equal(later.code, 0, later.out);
    assert.doesNotMatch(later.out, /Building the demo image/);
    assert.ok(!asked().some((c) => c.startsWith('compose build')), 'nothing is rebuilt');

    rmSync(calls);
    const rebuilt = await script(pathWith('docker-rebuild', { docker: docker(true) }), '--build');
    assert.match(rebuilt.out, /Building the demo image/);
    assert.ok(asked().includes('compose build stratus-node'), '--build rebuilds even when the image exists');
  });

  it('run.sh --help works from any directory', async () => {
    const result = await script(pathWith('help'), '--help');
    assert.equal(result.code, 0);
    assert.match(result.out, /--no-docker/);
    assert.doesNotMatch(result.out, /set -euo pipefail|No such file/);
  });
});
