/**
 * Offline contract tests for the `gentle-movil` CLI (no daemon, no network
 * beyond loopback). Node only: `node --test cli/test/`.
 *
 * What is pinned here:
 * - the `gc://pair` payload shape the app parses (`mobile/lib/qr-parse.ts`);
 * - status exit codes for the three loopback states (43721 control surface /
 *   43722 device surface by default): bridge identity confirmed, a port that
 *   answers with something else (the real camera-preview impostor), and nothing
 *   listening at all;
 * - doctor's four S9 checks and its honest non-zero exit when the extension is
 *   absent or when the port answers as something that is not the bridge;
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
import { encodeQr, renderQrBlock, renderTerminalQr, terminalColumns } from '../lib/qr.mjs';

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

/** The identity document the bridge contract fixes (both sides implement it). */
const BRIDGE_HEALTH = {
  app: 'gentle-shell',
  bridge: 'gentle-movil',
  proto: 1,
  version: '0.4.1',
};

/** A fresh loopback HTTP server started by the test itself, on an ephemeral port. */
function stubServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

/** A real bridge stand-in: `GET /api/health` answers the contract document. */
function bridgeServer(overrides = {}) {
  return stubServer((req, res) => {
    if (req.url !== '/api/health') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ ...BRIDGE_HEALTH, ...overrides }));
  });
}

/**
 * The impostor from the real incident: a leftover Rust daemon answering 200 on
 * the extension port with a camera-preview page (etag `camera-v2-preview-v1`).
 * Nothing about this response is the bridge, yet it is a perfectly good HTTP 200.
 */
function impostorServer() {
  return stubServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('etag', 'camera-v2-preview-v1');
    res.statusCode = 200;
    res.end('<!doctype html><title>camera preview</title>');
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
  // password-in-the-QR model: `pw` rides percent-encoded, the app decodes it.
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

  // `columns: 200` pins the wide layout: the renderer reads the real terminal
  // width (or `COLUMNS`) by default, and this test is about the matrix.
  const rendered = renderTerminalQr(payload, { isTTY: false, columns: 200 });
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
    const line = result.stdout
      .split('\n')
      .find((entry) => entry.includes(`127.0.0.1:${port}`));
    assert.ok(line, `port ${port} is named:\n${result.stdout}`);
    assert.match(line, /^\s*\u2717 /, `nothing listening is a ✗ line: ${line}`);
    assert.match(line, /unreachable/, line);
    assert.match(line, /ECONNREFUSED \u2014 nothing listening/, line);
  }
  assert.match(result.stdout, /extension: not reachable/, result.stdout);
  assert.equal(result.stderr, '');
});

test('status exits 0 only when every loopback port identifies as the bridge', async () => {
  const servers = [await bridgeServer(), await bridgeServer()];
  try {
    const ports = servers.map((entry) => entry.port).join(',');
    const result = await runCli(['status'], { GENTLE_MOVIL_PORTS: ports });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const { port } of servers) {
      const line = result.stdout
        .split('\n')
        .find((entry) => entry.includes(`127.0.0.1:${port}`));
      assert.ok(line, `port ${port} is named:\n${result.stdout}`);
      assert.match(line, /^\s*\u2713 /, `bridge identity is a ✓ line: ${line}`);
      assert.match(line, /reachable/, line);
      assert.match(line, /app=gentle-shell bridge=gentle-movil proto=1/, line);
      assert.match(line, /version 0\.4\.1/, line);
    }
    assert.match(result.stdout, /extension: reachable/, result.stdout);
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});

test('status reports a port that answers as an impostor, never as success', async () => {
  const servers = [await bridgeServer(), await impostorServer()];
  try {
    const [bridge, impostor] = servers;
    const result = await runCli(['status'], {
      GENTLE_MOVIL_PORTS: servers.map((entry) => entry.port).join(','),
    });
    assert.equal(result.status, 1, 'an answering impostor port is not a reachable bridge');
    assert.equal(result.stderr, '');

    const bridgeLine = result.stdout
      .split('\n')
      .find((line) => line.includes(`127.0.0.1:${bridge.port}`));
    assert.match(bridgeLine, /^\s*\u2713 /, `the real bridge still passes: ${bridgeLine}`);

    const impostorLine = result.stdout
      .split('\n')
      .find((line) => line.includes(`127.0.0.1:${impostor.port}`));
    assert.ok(impostorLine, `impostor port is named:\n${result.stdout}`);
    assert.match(impostorLine, /^\s*\u2717 /, `an impostor is a ✗ line: ${impostorLine}`);
    assert.match(impostorLine, /not the bridge/, impostorLine);
    assert.match(impostorLine, /port answering, but it is not the Gentle Shell bridge/, impostorLine);
    assert.match(impostorLine, /HTTP 200/, 'the misleading 200 is reported as what was seen');
    assert.match(impostorLine, /content-type text\/html/, impostorLine);
    assert.match(impostorLine, /etag camera-v2-preview-v1/, impostorLine);
    assert.doesNotMatch(impostorLine, /reachable/, 'never claims the impostor is reachable');

    assert.match(result.stdout, /extension: not the bridge/, result.stdout);
    assert.doesNotMatch(result.stdout, /extension: reachable/, result.stdout);
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});

test('status rejects a document that only partly carries the identity', async () => {
  const servers = [
    await bridgeServer({ proto: 2 }),
    await bridgeServer({ bridge: 'other-bridge' }),
  ];
  try {
    const result = await runCli(['status'], {
      GENTLE_MOVIL_PORTS: servers.map((entry) => entry.port).join(','),
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /proto=2/, 'the observed proto is named');
    assert.match(result.stdout, /bridge="other-bridge"/, 'the observed bridge is named');
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});

test('status keeps GENTLE_MOVIL_PORTS validation loud (exit 2)', async () => {
  const result = await runCli(['status'], { GENTLE_MOVIL_PORTS: 'nope,43721' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GENTLE_MOVIL_PORTS is invalid/);
  assert.equal(result.stdout, '');
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

test('doctor passes its extension check when the bridge identifies itself', async () => {
  const servers = [await bridgeServer(), await bridgeServer()];
  try {
    const ports = servers.map((entry) => entry.port).join(',');
    const result = await runCli(['doctor'], { GENTLE_MOVIL_PORTS: ports });
    const extensionLine = result.stdout
      .split('\n')
      .find((line) => line.includes('extension'));
    assert.ok(extensionLine, result.stdout);
    assert.match(extensionLine, /^\u2713 /, `extension check must pass: ${extensionLine}`);
    assert.match(extensionLine, /app=gentle-shell bridge=gentle-movil proto=1/, extensionLine);
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});

test('doctor fails its extension check on a port answering as an impostor', async () => {
  const servers = [await bridgeServer(), await impostorServer()];
  try {
    const result = await runCli(['doctor'], {
      GENTLE_MOVIL_PORTS: servers.map((entry) => entry.port).join(','),
    });
    assert.equal(result.status, 1, 'an impostor is a failed preflight');
    assert.equal(result.stderr, '', 'checks report on stdout, no stack traces');

    const extensionLine = result.stdout
      .split('\n')
      .find((line) => line.includes('extension'));
    assert.ok(extensionLine, result.stdout);
    assert.match(extensionLine, /^\u2717 /, `impostor must fail the check: ${extensionLine}`);
    assert.match(extensionLine, /port answering, but it is not the Gentle Shell bridge/, extensionLine);
    assert.match(extensionLine, /etag camera-v2-preview-v1/, extensionLine);
    assert.doesNotMatch(extensionLine, /app=gentle-shell/, 'no identity claim on a failed line');
  } finally {
    for (const { server } of servers) await closeServer(server);
  }
});

/** Lines made only of QR half blocks and spaces: the drawn code, nothing else. */
const ART_ONLY = /^[ \u2580\u2584\u2588]+$/;

/** One full pairing URI, as `pair` builds it (invite-only shape). */
function invitePayload() {
  return buildPairUri({
    host: '192.168.1.42',
    port: 22,
    user: 'reaan',
    token: `inv_${'ab'.repeat(16)}`,
    fp: FP,
    code: 'WXYZ-9876',
  });
}

test('the terminal QR fits a narrow terminal and reports how it shrank', () => {
  const payload = invitePayload();
  const { size } = encodeQr(payload);

  const wide = renderQrBlock(payload, { isTTY: false, columns: 200 });
  assert.equal(wide.note, null, 'a terminal that fits the code needs no shrink line');
  assert.ok(
    wide.art.split('\n').every((line) => line.length === size + 4),
    'the 2-module quiet zone is kept when there is room',
  );

  // One column narrower than the preferred art, down to the bare matrix.
  for (const columns of [size + 4, size + 3, size + 2, size + 1, size]) {
    const { art } = renderQrBlock(payload, { isTTY: false, columns });
    const lines = art.split('\n');
    assert.ok(lines.every((line) => line.length <= columns), `no art line wraps at ${columns}`);
    assert.ok(
      lines.some((line) => /[\u2580\u2584\u2588]/.test(line)),
      `the code is still drawn at ${columns} columns`,
    );
    assert.ok(lines.every((line) => ART_ONLY.test(line)), 'the art is the only thing drawn');
  }

  const snug = renderQrBlock(payload, { isTTY: false, columns: size + 2 });
  assert.match(
    snug.note ?? '',
    new RegExp(`quiet zone 2 → 1, art ${size + 2} columns wide`),
    `the shrink is reported in one line: ${snug.note}`,
  );

  // Narrower than the matrix itself: wrapping would be unscannable, so the code
  // is not drawn and the reason is named.
  const tooNarrow = renderQrBlock(payload, { isTTY: false, columns: size - 1 });
  assert.doesNotMatch(tooNarrow.art, /[\u2580\u2584\u2588]/, 'no wrapped art');
  assert.match(tooNarrow.art, new RegExp(`needs ${size} columns`), 'the needed width is named');
  assert.match(tooNarrow.art, /^gc:\/\/pair\?v=1&/m, 'the payload stays available as text');
});

test('the terminal width comes from the TTY, then COLUMNS, then 80', () => {
  assert.equal(terminalColumns({ stream: { columns: 42 }, env: { COLUMNS: '70' } }), 42);
  assert.equal(terminalColumns({ stream: {}, env: { COLUMNS: '70' } }), 70);
  assert.equal(terminalColumns({ stream: {}, env: {} }), 80);
  assert.equal(terminalColumns({ stream: {}, env: { COLUMNS: 'wide' } }), 80, 'garbage is ignored');
});

test('pair --invite-only never draws art wider than COLUMNS', async () => {
  for (const columns of [60, 40]) {
    const result = await runCli(['pair', '--invite-only'], {
      COLUMNS: String(columns),
      LC_ALL: 'C.UTF-8',
      LANG: '',
      LC_CTYPE: '',
    });
    assert.equal(result.status, 0, result.stderr);

    const art = result.stdout
      .split('\n')
      .filter((line) => ART_ONLY.test(line) && line.trim() !== '');
    assert.ok(
      art.every((line) => line.length <= columns),
      `no art line exceeds ${columns} columns: ${art.map((line) => line.length).join(',')}`,
    );
    if (columns === 60) {
      assert.ok(art.length > 0, 'a 60-column terminal is wide enough to draw the code');
    } else {
      assert.equal(art.length, 0, '40 columns cannot hold a 41+ module code');
      assert.match(result.stdout, /too narrow/, 'the narrow terminal is explained honestly');
    }
    assert.doesNotMatch(result.stdout, /\u001b\[/, 'piped output carries no escapes');
  }
});

test('the narrow fallback prints the same payload the QR encodes', async () => {
  const result = await runCli(['pair', '--invite-only'], {
    COLUMNS: '40',
    LC_ALL: 'C.UTF-8',
    LANG: '',
    LC_CTYPE: '',
  });
  assert.equal(result.status, 0, result.stderr);

  const uri = result.stdout.split('\n').find((line) => line.startsWith('gc://pair?v=1&'));
  assert.ok(uri, `the payload is printed as text:\n${result.stdout}`);
  const params = pairParams(uri);
  assert.equal(params.get('v'), '1');
  assert.match(
    params.get('fp') ?? '',
    /^[0-9a-f]{64}$/,
    '64-hex fingerprint: the form the app parser accepts',
  );
  assert.equal(params.get('pw'), null, 'invite-only carries no password');
  assert.match(params.get('code') ?? '', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(params.get('token') ?? '', /^inv_[0-9a-f]{32}$/);
  assert.equal(params.get('dport'), '43722');
});
