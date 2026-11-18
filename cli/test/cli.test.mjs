/**
 * Offline contract tests for the `gentle-movil` CLI (no daemon, no network
 * beyond loopback). Node only: `node --test cli/test/`.
 *
 * What is pinned here:
 * - the `gc://pair` payload shape the app parses (`mobile/lib/qr-parse.ts`);
 * - status exit codes for "nothing listening" and "extension reachable" on the
 *   loopback ports (43721 device surface / 43722 by default);
 * - doctor's four S9 checks and its honest non-zero exit when the extension is
 *   absent;
 * - the self-contained QR renderer (no npm dependency: the CLI must run with
 *   Node alone).
 *
 * The extension ports can be overridden with `GENTLE_MOVIL_PORTS` (documented in
 * docs/cli.md) so the probe tests never collide with a real running extension.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPairUri,
  hostFingerprint,
  randomCode,
  randomToken,
  SSH_FINGERPRINT_HEX_LEN,
} from '../lib/pairing.mjs';
import { encodeQr, renderTerminalQr } from '../lib/qr.mjs';

const CLI = fileURLToPath(new URL('../gentle-movil.mjs', import.meta.url));
const FP = 'a1'.repeat(32);

/**
 * Run the CLI without blocking the test event loop: the reachable-extension
 * tests keep an in-process HTTP server alive, and a synchronous spawn would
 * starve it until the child exited (the probe would then see a bare TCP
 * listener instead of the HTTP answer).
 */
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 20_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Reserve a loopback port and release it, so "nothing listens" is deterministic. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** An HTTP 204 listener on a fresh loopback port (a reachable extension stand-in). */
function listeningServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** The query params a QR parser must find, in the order the CLI writes them. */
function pairParams(uri) {
  assert.match(uri, /^gc:\/\/pair\?v=1&/, `scheme/action/version: ${uri}`);
  return new URL(uri).searchParams;
}

test('pair payload keeps the gc://pair?v=1 contract the app parses', () => {
  const uri = buildPairUri({
    host: '192.168.1.42',
    port: 22,
    user: 'reaan',
    token: 'inv_TESTTOKEN',
    fp: FP,
    pw: 'p@ss word',
  });

  const params = pairParams(uri);
  assert.equal(params.get('v'), '1');
  assert.equal(params.get('host'), '192.168.1.42');
  assert.equal(params.get('port'), '22');
  assert.equal(params.get('user'), 'reaan');
  assert.equal(params.get('token'), 'inv_TESTTOKEN');
  assert.equal(params.get('fp'), FP, '64-hex SHA-256 host fingerprint');
  // moshi model: the SSH password rides percent-encoded, the app decodes `pw`.
  assert.equal(params.get('pw'), 'p@ss word');
  assert.equal(params.get('code'), null, 'the password mode does not send a code');
  assert.equal(params.get('dport'), '43722', 'extension device surface');
});

test('pair payload falls back to invite-only code without a password', () => {
  const uri = buildPairUri({
    host: '10.0.0.7',
    port: 22,
    user: 'u',
    token: 'inv_X',
    fp: FP,
    code: 'WXYZ-9876',
  });
  const params = pairParams(uri);
  assert.equal(params.get('pw'), null, 'invite-only payload carries no password');
  assert.equal(params.get('code'), 'WXYZ-9876');
});

test('pair token and code are local, per-invocation values', () => {
  const tokens = [randomToken(), randomToken()];
  assert.match(tokens[0], /^inv_[0-9a-f]{32}$/);
  assert.notEqual(tokens[0], tokens[1], 'a new invocation gets a new token');

  const codes = [randomCode(), randomCode()];
  assert.match(codes[0], /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.notEqual(codes[0], codes[1], 'a new invocation gets a new code');
});

test('pair fingerprint is SHA-256 over the host key blob', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gentle-movil-cli-test-'));
  try {
    const keyBody = Buffer.from('test-ed25519-host-key').toString('base64');
    const keyPath = path.join(scratch, 'ssh_host_ed25519_key.pub');
    writeFileSync(keyPath, `ssh-ed25519 ${keyBody} host\n`);
    const fp = hostFingerprint({ candidates: [keyPath] });
    const expected = createHash('sha256').update(Buffer.from(keyBody, 'base64')).digest('hex');
    assert.equal(fp, expected);
    assert.equal(fp.length, SSH_FINGERPRINT_HEX_LEN);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the QR renderer is self-contained and produces a valid matrix', () => {
  const payload = 'gc://pair?v=1&host=h&user=u&token=t&fp=' + FP;
  const { size, modules } = encodeQr(payload);
  assert.equal((size - 17) % 4, 0, 'QR size is 4*version+17');
  assert.equal(modules.length, size * size);

  // Finder patterns: 7x7 dark border around a 3x3 dark core at three corners.
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(modules[y0 * size + x0 + i], 1, `finder top border at ${x0},${y0}`);
      assert.equal(modules[(y0 + 6) * size + x0 + i], 1, 'finder bottom border');
      assert.equal(modules[(y0 + i) * size + x0], 1, 'finder left border');
      assert.equal(modules[(y0 + i) * size + x0 + 6], 1, 'finder right border');
    }
    assert.equal(modules[(y0 + 1) * size + x0 + 1], 0, 'finder separator ring');
  }
  // Timing pattern alternates on row 6 and column 6.
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6 * size + i], i % 2 === 0 ? 1 : 0, `timing row at ${i}`);
  }

  const rendered = renderTerminalQr(payload, { isTTY: false });
  const lines = rendered.split('\n').filter((line) => line.length > 0);
  const width = size + 4; // 2-module quiet zone on each side
  assert.ok(lines.every((line) => line.length === width), 'quiet zone keeps a square code');
  assert.match(rendered, /^[ \u2580\u2584\u2588\n]+$/, 'half-block terminal art only');
});

test('help and unknown commands stay offline and non-crashing', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pair/);
  assert.match(help.stdout, /status/);
  assert.match(help.stdout, /doctor/);

  const unknown = await runCli(['nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command: nope/);
});

test('status exits 1 with an honest line when nothing listens on loopback', async () => {
  const ports = [await freePort(), await freePort()];
  const result = await runCli(['status'], { GENTLE_MOVIL_PORTS: ports.join(',') });
  assert.equal(result.status, 1, result.stderr);
  for (const port of ports) {
    assert.match(result.stdout, new RegExp(`127\\.0\\.0\\.1:${port}`), `port ${port} is named`);
  }
  assert.match(result.stdout, /nothing listening/, result.stdout);
  assert.equal(result.stderr, '');
});

test('status exits 0 when the extension answers on every loopback port', async () => {
  const servers = [await listeningServer(), await listeningServer()];
  try {
    const ports = servers.map((entry) => entry.port).join(',');
    const result = await runCli(['status'], { GENTLE_MOVIL_PORTS: ports });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HTTP 204/, 'the HTTP answer is reported per port');
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});

test('doctor prints the four S9 checks and fails honestly without the extension', async () => {
  const ports = [await freePort(), await freePort()];
  const result = await runCli(['doctor'], { GENTLE_MOVIL_PORTS: ports.join(',') });
  assert.equal(result.status, 1, 'a missing extension is a failed preflight');
  assert.equal(result.stderr, '', 'checks report on stdout, no stack traces');

  const checks = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('\u2713 ') || line.startsWith('\u2717 '));
  assert.equal(checks.length, 4, `expected four checks:\n${result.stdout}`);
  assert.ok(checks[0].includes('sshd'), 'check 1: sshd active');
  assert.ok(checks[1].includes('host key'), 'check 2: host key readable');
  assert.ok(checks[2].includes('LAN'), 'check 3: LAN address');
  assert.ok(checks[3].includes('extension'), 'check 4: extension on loopback');
  assert.match(result.stdout, /127\.0\.0\.1/, 'the extension check names the loopback surface');
});

test('doctor passes its extension check when a listener answers on loopback', async () => {
  const servers = [await listeningServer(), await listeningServer()];
  try {
    const ports = servers.map((entry) => entry.port).join(',');
    const result = await runCli(['doctor'], { GENTLE_MOVIL_PORTS: ports });
    const extensionLine = result.stdout
      .split('\n')
      .find((line) => line.includes('extension'));
    assert.ok(extensionLine, result.stdout);
    assert.match(extensionLine, /^\u2713 /, `extension check must pass: ${extensionLine}`);
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});
