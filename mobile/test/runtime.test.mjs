import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_DEFAULT_TIMEOUT_MS,
  RUNTIME_MISSING_COPY,
  RUNTIME_TIMEOUT_COPY,
  RUNTIME_UNSUPPORTED_COPY,
  gentleAiVersion,
  nodeVersion,
  runGentleAi,
  runNode,
} from '../lib/runtime.ts';

/**
 * Contract of the bundled phone runtime (T9a, `odd/tasks/mobile-app.md`).
 *
 * `mobile/lib/runtime.ts` wraps the two native calls of the `GentleRuntime`
 * Expo module (`runNode`, `runGentleAi`), which exec `nativeLibraryDir/libnode.so`
 * and `nativeLibraryDir/libgentle_ai.so` with `LD_LIBRARY_PATH` pointing at the
 * same directory (see `scripts/fetch-runtime.sh`).
 *
 * The tests below drive it with a fake native call, so they pin the promise the
 * screen will rely on: **nothing throws and nothing is invented**. A real answer
 * becomes a version, and every other outcome (module absent, missing binary,
 * timeout, non-zero exit, broken envelope) becomes one typed failure with the
 * raw evidence for `lib/logger.ts`.
 */

/** Envelope the Kotlin module answers for a process that ran fine. */
const OK_NODE = JSON.stringify({ ok: true, exitCode: 0, stdout: 'v24.22.3\n', stderr: '' });

/** Records every native call the fake receives. */
function fakeNative(answer) {
  const calls = [];
  const call = async (method, args, timeoutMs) => {
    calls.push({ method, args, timeoutMs });
    return typeof answer === 'function' ? answer(method, args, timeoutMs) : answer;
  };
  return { calls, deps: { call } };
}

test('nodeVersion reports the exact version line the binary prints', async () => {
  const { calls, deps } = fakeNative(OK_NODE);

  const result = await nodeVersion(deps);

  assert.deepEqual(result, {
    ok: true,
    version: 'v24.22.3',
    failure: null,
    raw: 'v24.22.3\n',
  });
  assert.deepEqual(calls, [
    { method: 'runNode', args: ['--version'], timeoutMs: RUNTIME_DEFAULT_TIMEOUT_MS },
  ]);
});

test('gentleAiVersion accepts the line gentle-ai really prints', async () => {
  const { calls, deps } = fakeNative(
    JSON.stringify({ ok: true, exitCode: 0, stdout: 'gentle-ai 4.6.0\n', stderr: '' }),
  );

  const result = await gentleAiVersion(deps);

  assert.deepEqual(result, {
    ok: true,
    version: 'gentle-ai 4.6.0',
    failure: null,
    raw: 'gentle-ai 4.6.0\n',
  });
  assert.deepEqual(calls, [
    { method: 'runGentleAi', args: ['--version'], timeoutMs: RUNTIME_DEFAULT_TIMEOUT_MS },
  ]);
});

test('a stdout that is not a version is a typed failure, never a made-up version', async () => {
  const { deps } = fakeNative(
    JSON.stringify({ ok: true, exitCode: 0, stdout: 'Segmentation fault\n', stderr: '' }),
  );

  const result = await nodeVersion(deps);

  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.equal(result.failure?.kind, 'malformed');
  assert.equal(result.raw, 'Segmentation fault\n');
});

test('a non-zero exit keeps the real exit code, stdout and stderr', async () => {
  const { deps } = fakeNative(
    JSON.stringify({
      ok: false,
      exitCode: 1,
      stdout: 'partial',
      stderr: 'node: bad option',
      error: { kind: 'ExitCode', message: 'libnode.so terminó con código 1' },
    }),
  );

  const result = await runNode(['--bad-option'], deps);

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'partial');
  assert.equal(result.stderr, 'node: bad option');
  assert.equal(result.failure?.kind, 'exit');
  assert.equal(result.failure?.message, 'libnode.so terminó con código 1');
});

test('a timeout is its own typed failure, with the copy the screen shows', async () => {
  const { deps } = fakeNative(
    JSON.stringify({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: { kind: 'Timeout', message: 'libnode.so no terminó en 15000 ms' },
    }),
  );

  const result = await runNode(['-e', 'setInterval(() => {}, 1000)'], {
    ...deps,
    timeoutMs: 15000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.failure?.kind, 'timeout');
  // Nothing came out of either stream: no evidence to show, not a fake "".
  assert.equal(result.failure?.raw, null);
});

test('a timeout copy is always shown when the native error carries none', async () => {
  const { deps } = fakeNative(
    JSON.stringify({ ok: false, exitCode: null, stdout: '', stderr: '', error: { kind: 'Timeout' } }),
  );

  const result = await runNode([], deps);

  assert.equal(result.failure?.kind, 'timeout');
  assert.equal(result.failure?.message, RUNTIME_TIMEOUT_COPY);
});

test('an absent native module is `unsupported`, never a throw', async () => {
  const result = await nodeVersion({ call: null });

  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.equal(result.failure?.kind, 'unsupported');
  assert.equal(result.failure?.message, RUNTIME_UNSUPPORTED_COPY);
});

test('the real default path is `unsupported` off device (no GentleRuntime module)', async () => {
  // No injected call: this resolves the real `modules/gentle-core` binding,
  // which has no native module under `node --test`. It must degrade, not throw.
  const result = await nodeVersion();

  assert.equal(result.ok, false);
  assert.equal(result.failure?.kind, 'unsupported');
});

test('the missing-binary answer names the path the loader looked at', async () => {
  const { deps } = fakeNative(
    JSON.stringify({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: {
        kind: 'RuntimeMissing',
        message: 'No está libnode.so en /data/app/x/lib/arm64',
      },
    }),
  );

  const result = await runNode(['--version'], deps);

  assert.equal(result.failure?.kind, 'missing');
  assert.match(result.failure?.message ?? '', /libnode\.so/);
  assert.equal(RUNTIME_MISSING_COPY.length > 0, true);
});

test('every native failure kind maps to one typed kind', async () => {
  const cases = [
    ['RuntimeMissing', 'missing'],
    ['NotExtracted', 'not-extracted'],
    ['NotExecutable', 'not-executable'],
    ['SpawnFailed', 'spawn'],
    ['Timeout', 'timeout'],
    ['ExitCode', 'exit'],
    ['SomethingTheFutureAdded', 'spawn'],
  ];

  for (const [wire, expected] of cases) {
    const { deps } = fakeNative(
      JSON.stringify({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: { kind: wire, message: `falla ${wire}` },
      }),
    );
    const result = await runNode([], deps);
    assert.equal(result.failure?.kind, expected, `${wire} must map to ${expected}`);
    assert.equal(result.failure?.message, `falla ${wire}`);
  }
});

test('a malformed envelope is a typed `malformed` failure, never a payload', async () => {
  const answers = [
    'not json at all',
    '',
    '{"ok":true}',
    '{"ok":true,"exitCode":0,"stdout":"v24.22.3"}',
    '{"ok":"yes","exitCode":0,"stdout":"v24.22.3","stderr":""}',
    '{"ok":true,"exitCode":"0","stdout":"v24.22.3","stderr":""}',
    '["v24.22.3"]',
    'null',
    undefined,
    {},
  ];

  for (const answer of answers) {
    const { deps } = fakeNative(answer);
    const result = await nodeVersion(deps);
    assert.equal(result.ok, false, `answer ${String(answer)} must not succeed`);
    assert.equal(result.version, null);
    assert.equal(result.failure?.kind, 'malformed', `answer ${String(answer)} is malformed`);
  }
});

test('a native call that throws becomes `spawn` with the error text', async () => {
  const deps = {
    call: async () => {
      throw new Error('Cannot find native module GentleRuntime');
    },
  };

  const result = await runNode(['--version'], deps);

  assert.equal(result.ok, false);
  assert.equal(result.failure?.kind, 'spawn');
  assert.match(result.failure?.message ?? '', /GentleRuntime/);
  assert.equal(result.failure?.raw, 'Cannot find native module GentleRuntime');
});

test('argv reaches the binary untouched — no shell, no interpolation', async () => {
  const argv = ['-e', 'console.log("hola; rm -rf /" && 1 + 1)', '$HOME', 'a b'];
  const { calls, deps } = fakeNative(OK_NODE.replace('v24.22.3', 'done'));

  await runNode(argv, deps);

  assert.deepEqual(calls[0].args, argv);
  assert.equal(typeof calls[0].args[2], 'string');
});

test('a custom timeout travels with the call', async () => {
  const { calls, deps } = fakeNative(OK_NODE);

  await runGentleAi(['--help'], { ...deps, timeoutMs: 2000 });

  assert.deepEqual(calls, [{ method: 'runGentleAi', args: ['--help'], timeoutMs: 2000 }]);
});
