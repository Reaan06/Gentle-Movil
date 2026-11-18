/**
 * Contract tests for the `gentle-movil` entrypoint as a *real command*
 * (T4a): installable as a `bin`, runnable from any directory and through a
 * symlink, honest when stdin is not a TTY, and readable when the terminal is
 * not UTF-8. Node only: `node --test cli/test/`.
 *
 * What is pinned here:
 * - the shebang + executable bit, so `~/.local/bin/gentle-movil` works without
 *   `node` in front of it;
 * - self-resolution from `import.meta.url` (never `process.cwd()`), which is
 *   also what makes a symlinked invocation dispatch instead of silently
 *   exiting 0;
 * - `package.json` `bin`/`type`/`engines` and the dependency-free promise;
 * - `pair` never waiting on a stdin that cannot answer: `--invite-only` renders
 *   the QR, plain `pair` fails loudly with exit ≠ 0;
 * - piped output without escape sequences and a plain-text payload fallback
 *   under a non-UTF-8 locale (the QR art uses half blocks);
 * - the fish completion ships with the subcommands it completes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../gentle-movil.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ESCAPE = /\u001b\[/;
const HALF_BLOCKS = /[\u2580\u2584\u2588]/;

/** Run a file as a command (shebang, not `node <file>`) from a foreign cwd. */
function runEntry(entry, args, { env = {}, cwd = tmpdir(), stdin = 'ignore' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [stdin, 'pipe', 'pipe'],
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

/** A scratch directory outside the worktree, removed by the caller. */
function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'gentle-movil-entry-test-'));
}

test('the entrypoint is a shebang executable, not a file you must hand to node', () => {
  const first = readFileSync(CLI, 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node', 'portable shebang, resolved without fnm');

  const mode = statSync(CLI).mode & 0o777;
  assert.ok((mode & 0o111) !== 0, `executable bit is set (mode ${mode.toString(8)})`);
});

test('the entrypoint runs from a directory that is not the repo', async () => {
  const dir = scratch();
  try {
    const result = await runEntry(CLI, ['--help'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^gentle-movil — host-side companion/);
    assert.match(result.stdout, /pair/);
    assert.match(result.stdout, /status/);
    assert.match(result.stdout, /doctor/);
    assert.doesNotMatch(result.stdout, ESCAPE, 'piped help carries no escape sequences');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the entrypoint dispatches when invoked through a symlink', async () => {
  const dir = scratch();
  try {
    const link = path.join(dir, 'gentle-movil');
    symlinkSync(CLI, link);
    const result = await runEntry(link, ['--help'], { cwd: dir });
    assert.equal(result.status, 0, `a symlinked invocation must still dispatch:\n${result.stderr}`);
    assert.match(
      result.stdout,
      /^gentle-movil — host-side companion/,
      'import.meta.url resolution, not process.argv[1] string equality',
    );

    const unknown = await runEntry(link, ['nope'], { cwd: dir });
    assert.equal(unknown.status, 2, 'the lazy command imports still resolve via the symlink');
    assert.match(unknown.stderr, /Unknown command: nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package.json declares the command, the engine and no dependencies', () => {
  const pkgPath = path.join(REPO, 'package.json');
  assert.ok(existsSync(pkgPath), 'the root package.json is what makes the bin installable');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, 'gentle-movil');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'a real semver version');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { 'gentle-movil': 'cli/gentle-movil.mjs' });
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.scripts.test, 'node --test cli/test/');
  assert.equal(pkg.dependencies, undefined, 'the CLI runs with Node alone (S2)');
  assert.equal(pkg.devDependencies, undefined, 'no dependency to install');
});

test('the fish completion ships with the subcommands it completes', () => {
  const completion = path.join(REPO, 'cli', 'completions', 'gentle-movil.fish');
  assert.ok(existsSync(completion), 'completion file is versioned');
  const text = readFileSync(completion, 'utf8');
  for (const command of ['pair', 'status', 'doctor']) {
    const line = text
      .split('\n')
      .find((entry) => entry.includes(`-a ${command} `) || entry.trim().endsWith(`-a ${command}`));
    assert.ok(line, `completion offers \`${command}\``);
    assert.match(line, /-d '[^']+'/, `\`${command}\` carries a one-line description: ${line}`);
  }
  assert.match(text, /-l invite-only/, 'the pair flag is completed too');
});

test('pair --invite-only renders the QR with stdin closed', async () => {
  const result = await runEntry(CLI, ['pair', '--invite-only']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  assert.ok(lines.some((line) => HALF_BLOCKS.test(line)), 'the QR art is present');
  assert.match(result.stdout, /gc:\/\/pair\s+host=/);
  assert.match(result.stdout, /mode: invite-only/);
  assert.doesNotMatch(result.stdout, ESCAPE, 'no escape sequences when stdout is piped');
});

test('pair without --invite-only refuses instead of waiting on a non-TTY stdin', async () => {
  const result = await runEntry(CLI, ['pair']);
  assert.notEqual(result.status, 0, `must fail loudly, not hang:\n${result.stdout}`);
  assert.equal(result.stdout, '', 'nothing is printed as if the pairing had happened');
  assert.match(result.stderr, /--invite-only/, 'the fix is named in the message');
  assert.match(result.stderr, /stdin .*not a TTY|not a TTY.*stdin/i, result.stderr);
});

test('a non-UTF-8 locale degrades to a plain payload instead of broken glyphs', async () => {
  const result = await runEntry(CLI, ['pair', '--invite-only'], {
    env: { LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, HALF_BLOCKS, 'no half blocks outside UTF-8');
  assert.doesNotMatch(result.stdout, ESCAPE, 'no escape sequences when piped');
  assert.match(result.stdout, /gc:\/\/pair\?v=1&/, 'the payload is still usable as text');
  assert.match(result.stdout, /UTF-8/, 'the fallback says why there is no QR art');
});

test('a UTF-8 locale keeps the half-block QR art', async () => {
  const result = await runEntry(CLI, ['pair', '--invite-only'], {
    env: { LC_ALL: 'C.UTF-8', LANG: '', LC_CTYPE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.split('\n').some((line) => HALF_BLOCKS.test(line)),
    'LC_ALL=C.UTF-8 is enough to draw the QR',
  );
});
