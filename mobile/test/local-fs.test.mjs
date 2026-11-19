/**
 * T18/T14 — Real device files for local mode (`mobile/lib/local-fs.ts`).
 *
 * The Rust core exposes the frozen pair `fsList`/`fsRead` (contract delivered by
 * the core writer). This seam turns them into the editor's `EditorSource`, so
 * local mode lists and opens what the app is really allowed to read — and every
 * core failure keeps its own honest kind and copy:
 *
 * - `permission_denied` → `no-fs`, naming the real path and the real cause;
 * - `not_found` / `binary` / `too_large` → their own copy, naming the path;
 * - a missing symbol (`CoreUnavailable`) → `no-fs` with the real root, never an
 *   empty project;
 * - a truncated read is refused instead of being shown as the whole file;
 * - every failure is logged `{step, error, raw}`.
 *
 * No device: the core surface is injected, and the tests read the seam through
 * its public interface (`loadTree`/`readFile`), never its internals.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadTree, readFile } from '../lib/local-editor.ts';
import {
  LOCAL_FS_MAX_BYTES,
  LOCAL_FS_MAX_ENTRIES,
  coreLocalFsApi,
  defaultLocalFsApi,
  localFsEditorSource,
  resolveLocalFsApi,
} from '../lib/local-fs.ts';
import { bindCoreNativeBridge } from '../modules/gentle-core/src/abi.ts';

/** The real root shape of an app sandbox project folder. */
const ROOT = '/data/user/0/ai.gentle.movil/files/proyectos/vita-app';

/** The same root as the app resolves it: `expo-file-system` answers a `file://` URI. */
const ROOT_URI = `file://${ROOT}`;

/** Injected core fs surface: records every call, fails with the given error. */
function fakeCore({ entries = [], files = {}, failList = null, failRead = null, onList, onRead } = {}) {
  const calls = { list: [], read: [] };
  return {
    calls,
    async fsList(input) {
      calls.list.push(input);
      if (failList !== null) {
        throw failList;
      }
      if (onList !== undefined) {
        return onList(input);
      }
      return { entries };
    },
    async fsRead(input) {
      calls.read.push(input);
      if (failRead !== null) {
        throw failRead;
      }
      if (onRead !== undefined) {
        return onRead(input);
      }
      if (!(input.path in files)) {
        throw { kind: 'not_found', message: `no such file: ${input.path}` };
      }
      const text = files[input.path];
      return { path: input.path, text, size: text.length, truncated: false };
    },
  };
}

/** Collects the `{step, error, raw}` failures instead of hitting a sink. */
function silentLogger() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
  };
}

const ENTRY = (path, extra = {}) => ({ path, size: 10, kind: 'file', ...extra });

/* ------------------------------------------------------------------ *
 * (a) list: core entries → the editor's tree shape
 * ------------------------------------------------------------------ */

test('(a) fsList entries become the real tree, listed from the project root', async () => {
  const api = fakeCore({
    entries: [
      ENTRY('src/app.ts', { size: 120 }),
      ENTRY('src', { size: null, kind: 'dir' }),
      ENTRY('README.md', { size: 40 }),
    ],
  });

  const state = await loadTree(localFsEditorSource(ROOT, { api }), { logger: silentLogger() });

  assert.equal(state.kind, 'success');
  // A directory with a null size is 0 (its real size), never an invented file size.
  assert.deepEqual(
    state.entries.map((entry) => [entry.path, entry.size, entry.kind]),
    [
      ['src', 0, 'dir'],
      ['README.md', 40, 'file'],
      ['src/app.ts', 120, 'file'],
    ],
  );
  // The core is asked once, with the real root and the project folder itself.
  assert.deepEqual(api.calls.list, [{ root: ROOT, path: '', maxEntries: LOCAL_FS_MAX_ENTRIES }]);
});

/* ------------------------------------------------------------------ *
 * (b) read: core file → the editor's buffer
 * ------------------------------------------------------------------ */

test('(b) fsRead becomes a real buffer with the requested path', async () => {
  const api = fakeCore({ files: { 'src/app.ts': 'const a = 1;' } });

  const read = await readFile(localFsEditorSource(ROOT, { api }), 'src/app.ts', {
    logger: silentLogger(),
  });

  assert.equal(read.kind, 'success');
  assert.equal(read.buffer.path, 'src/app.ts');
  assert.equal(read.buffer.text, 'const a = 1;');
  assert.equal(read.buffer.dirty, false);
  assert.deepEqual(api.calls.read, [
    { root: ROOT, path: 'src/app.ts', maxBytes: LOCAL_FS_MAX_BYTES },
  ]);
});

/* ------------------------------------------------------------------ *
 * (c) the core has no symbols: no-fs naming the real root
 * ------------------------------------------------------------------ */

test('(c) a build without fsList/fsRead is no-fs naming the real root, never empty', async () => {
  const log = silentLogger();
  const source = localFsEditorSource(ROOT, { api: null, logger: log });

  const tree = await loadTree(source, { logger: log });
  assert.equal(tree.kind, 'no-fs');
  assert.match(tree.message, /sin acceso a archivos/i);
  assert.ok(tree.message.includes(ROOT), 'the copy names the real root');
  assert.match(tree.message, /fsList/);
  assert.match(tree.message, /fsRead/);
  assert.equal('entries' in tree, false, 'no empty tree pretending the project is empty');

  const read = await readFile(source, 'src/app.ts', { logger: log });
  assert.equal(read.kind, 'no-fs');
  assert.ok(read.message.includes(ROOT));
  assert.equal('buffer' in read, false, 'no blank buffer pretending an empty file');

  // Every failure is logged as {step, error, raw}.
  const steps = log.failures.map((failure) => failure.step);
  assert.ok(steps.includes('local-fs-list'), `list step logged, got ${steps.join(',')}`);
  assert.ok(steps.includes('local-fs-read'));
  for (const failure of log.failures) {
    assert.equal(typeof failure.step, 'string');
    assert.ok(failure.error instanceof Error);
    assert.ok(failure.raw !== undefined);
  }
});

test('(c) the default core surface of this build is honestly reported, not guessed', async () => {
  const log = silentLogger();
  const state = await loadTree(localFsEditorSource(ROOT, { logger: log }), { logger: log });

  // Either the symbols are missing or the core refuses (CoreUnavailable): both
  // are `no-fs` naming the real root, never a successful empty project.
  assert.equal(state.kind, 'no-fs');
  assert.ok(state.message.includes(ROOT));
});

/* ------------------------------------------------------------------ *
 * (d) permission denied: no-fs with the real path and the real cause
 * ------------------------------------------------------------------ */

test('(d) permission_denied is no-fs naming the real path, the root and the cause', async () => {
  const log = silentLogger();
  const cause = { kind: 'permission_denied', message: 'open failed: EACCES (Permission denied)' };

  const tree = await loadTree(localFsEditorSource(ROOT, { api: fakeCore({ failList: cause }), logger: log }), {
    logger: log,
  });
  assert.equal(tree.kind, 'no-fs');
  assert.match(tree.message, /sin acceso a archivos/i);
  assert.ok(tree.message.includes(ROOT), 'names the real root');
  assert.match(tree.message, /EACCES/, 'names the real cause the core reported');
  assert.match(tree.raw, /permission_denied/);

  const read = await readFile(
    localFsEditorSource(ROOT, { api: fakeCore({ failRead: cause }), logger: log }),
    'src/app.ts',
    { logger: log },
  );
  assert.equal(read.kind, 'no-fs');
  assert.ok(read.message.includes('src/app.ts'), 'names the real file path');
  assert.ok(read.message.includes(ROOT));
  assert.equal('buffer' in read, false);
});

/* ------------------------------------------------------------------ *
 * (e) not found / binary / too large: their own honest copy
 * ------------------------------------------------------------------ */

test('(e) not_found, binary and too_large each keep their own copy naming the path', async () => {
  const cases = [
    ['not_found', /no está en el teléfono/i],
    ['binary', /binario/i],
    ['too_large', /demasiado grande/i],
  ];

  for (const [kind, copy] of cases) {
    const log = silentLogger();
    const cause = { kind, message: `core said ${kind}` };
    const read = await readFile(
      localFsEditorSource(ROOT, { api: fakeCore({ failRead: cause }), logger: log }),
      'src/app.ts',
      { logger: log },
    );

    assert.equal(read.kind, 'error', `${kind} is an error state, never a buffer`);
    assert.match(read.message, copy);
    assert.ok(read.message.includes('src/app.ts'), `${kind} names the real path`);
    assert.match(read.raw ?? '', new RegExp(kind));
    assert.equal('buffer' in read, false);
    assert.ok(log.failures.some((failure) => failure.step === 'local-fs-read'));
  }
});

/* ------------------------------------------------------------------ *
 * (f) a truncated read is refused, never shown as the whole file
 * ------------------------------------------------------------------ */

test('(f) a truncated read is refused instead of being presented as the whole file', async () => {
  const log = silentLogger();
  const api = fakeCore({
    onRead: (input) => ({ path: input.path, text: 'x'.repeat(8), size: 9_000_000, truncated: true }),
  });

  const read = await readFile(localFsEditorSource(ROOT, { api, logger: log }), 'big.txt', {
    logger: log,
  });

  assert.equal(read.kind, 'error');
  assert.match(read.message, /truncad/i);
  assert.ok(read.message.includes('big.txt'));
  assert.match(read.message, new RegExp(String(LOCAL_FS_MAX_BYTES)));
  assert.equal('buffer' in read, false, 'a cut buffer is not opened');
});

/* ------------------------------------------------------------------ *
 * (g) thrown failures map by their typed kind, never by guessing
 * ------------------------------------------------------------------ */

test('(g) a CoreUnavailable rejection is no-fs; an unknown failure keeps its real message', async () => {
  const log = silentLogger();

  const unavailable = Object.assign(new Error('needs the Rust core (mobile-core)'), {
    name: 'CoreUnavailableError',
    kind: 'CoreUnavailable',
  });
  const noCore = await loadTree(
    localFsEditorSource(ROOT, { api: fakeCore({ failList: unavailable }), logger: log }),
    { logger: log },
  );
  assert.equal(noCore.kind, 'no-fs');
  assert.ok(noCore.message.includes(ROOT));
  assert.match(noCore.message, /core/i);

  const boom = new Error('disk on fire');
  const error = await loadTree(
    localFsEditorSource(ROOT, { api: fakeCore({ failList: boom }), logger: log }),
    { logger: log },
  );
  assert.equal(error.kind, 'error');
  assert.match(error.message, /disk on fire/);
  assert.match(error.raw ?? '', /disk on fire/);
});

/* ------------------------------------------------------------------ *
 * (h) a path that leaves the project root never reaches the core
 * ------------------------------------------------------------------ */

test('(h) a path that escapes the project root is refused before the core is called', async () => {
  const log = silentLogger();
  const api = fakeCore({ files: {} });

  for (const path of ['../secreto.txt', '/etc/passwd', 'src/../../fuera.txt', '']) {
    const read = await readFile(localFsEditorSource(ROOT, { api, logger: log }), path, {
      logger: log,
    });
    assert.equal(read.kind, 'error', `"${path}" is refused`);
    assert.match(read.message, /raíz del proyecto|vacía/i);
    assert.equal('buffer' in read, false);
  }
  assert.deepEqual(api.calls.read, [], 'nothing escaped to the core');
});

/* ------------------------------------------------------------------ *
 * (i) malformed core payloads are errors, never an empty success
 * ------------------------------------------------------------------ */

test('(i) a listing that is not an entries array is an error, never an empty project', async () => {
  const log = silentLogger();

  const notAnObject = await loadTree(
    localFsEditorSource(ROOT, { api: fakeCore({ onList: () => '{"entries":[]}' }), logger: log }),
    { logger: log },
  );
  assert.equal(notAnObject.kind, 'error');
  assert.match(notAnObject.message, /no entendemos/i);

  const noEntries = await loadTree(
    localFsEditorSource(ROOT, { api: fakeCore({ onList: () => ({ files: [] }) }), logger: log }),
    { logger: log },
  );
  assert.equal(noEntries.kind, 'error');
  assert.equal('entries' in noEntries, false);

  // An unknown entry kind or a file without a size is refused by name, never
  // turned into a row that looks like the truth.
  const symlink = await loadTree(
    localFsEditorSource(ROOT, {
      api: fakeCore({ entries: [{ path: '.bin', size: null, kind: 'symlink' }] }),
      logger: log,
    }),
    { logger: log },
  );
  assert.equal(symlink.kind, 'error');
  assert.match(symlink.message, /\.bin/);

  const noSize = await loadTree(
    localFsEditorSource(ROOT, { api: fakeCore({ entries: [ENTRY('a.ts', { size: null })] }), logger: log }),
    { logger: log },
  );
  assert.equal(noSize.kind, 'error');
  assert.match(noSize.message, /a\.ts/);
});

test('(i) a read without text is an error, never an empty file', async () => {
  const log = silentLogger();
  const read = await readFile(
    localFsEditorSource(ROOT, { api: fakeCore({ onRead: () => ({ path: 'a.ts', size: 0 }) }), logger: log }),
    'a.ts',
    { logger: log },
  );

  assert.equal(read.kind, 'error');
  assert.match(read.message, /incompleto/i);
  assert.equal('buffer' in read, false);
});

test('(i) a really empty project folder is the empty state, not an error', async () => {
  const state = await loadTree(
    localFsEditorSource(ROOT, { api: fakeCore({ entries: [] }), logger: silentLogger() }),
    { logger: silentLogger() },
  );
  assert.equal(state.kind, 'empty');
});

test('(i) a listing the core had to cut is an error, never a partial project', async () => {
  const log = silentLogger();
  const state = await loadTree(
    localFsEditorSource(ROOT, {
      api: fakeCore({ onList: () => ({ entries: [ENTRY('a.ts')], truncated: true }) }),
      maxEntries: 1,
      logger: log,
    }),
    { logger: log },
  );

  assert.equal(state.kind, 'error');
  assert.match(state.message, /incompleto/i);
  assert.match(state.message, /más de 1 entradas|de 1 entradas/);
  assert.equal('entries' in state, false, 'a cut list is not shown as the whole folder');
});

/* ------------------------------------------------------------------ *
 * (j) the core surface is detected, never assumed
 * ------------------------------------------------------------------ */

test('(j) coreLocalFsApi only accepts a complete surface and keeps its receiver', async () => {
  assert.equal(coreLocalFsApi(null), null);
  assert.equal(coreLocalFsApi({}), null);
  assert.equal(coreLocalFsApi({ fsList: async () => ({ entries: [] }) }), null, 'fsRead missing');

  const candidate = {
    marker: 'real-receiver',
    async fsList() {
      return { entries: [], marker: this.marker };
    },
    async fsRead() {
      return { path: 'a.ts', text: 'x', size: 1, truncated: false };
    },
  };
  const api = coreLocalFsApi(candidate);
  assert.notEqual(api, null);
  const listing = await api.fsList({ root: ROOT, path: '' });
  assert.equal(listing.marker, 'real-receiver', 'methods keep their own `this`');
});

/* ------------------------------------------------------------------ *
 * (k) the default surface is the real ABI layer, never the dev stub
 * ------------------------------------------------------------------ */

test('(k) the default surface reaches a bound native core instead of the throwing stub', async () => {
  const log = silentLogger();
  const payloads = [];
  const bridge = {
    deviceKeyEnsure: async () => '{"ok":true,"result":{}}',
    sshConnectWithDeviceKey: async () => '{"ok":true,"result":{}}',
    sshClose: async () => '{"ok":true,"result":{"closed":true}}',
    async fsList(payloadJson) {
      payloads.push(JSON.parse(payloadJson));
      return JSON.stringify({
        ok: true,
        result: { entries: [{ path: 'src/main.ts', size: 12, kind: 'file' }] },
      });
    },
    async fsRead(payloadJson) {
      payloads.push(JSON.parse(payloadJson));
      return JSON.stringify({
        ok: true,
        result: { path: 'src/main.ts', text: 'export {};\n', size: 11, truncated: false },
      });
    },
  };

  bindCoreNativeBridge(bridge);
  try {
    const tree = await loadTree(localFsEditorSource(ROOT, { logger: log }), { logger: log });
    assert.equal(tree.kind, 'success', 'the ABI layer is the default surface of this build');
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      ['src/main.ts'],
    );

    const read = await readFile(localFsEditorSource(ROOT, { logger: log }), 'src/main.ts', {
      logger: log,
    });
    assert.equal(read.kind, 'success');
    assert.equal(read.buffer.text, 'export {};\n');

    // Both calls asked for the real project root, and none degraded to "no symbols".
    assert.deepEqual(
      payloads.map((payload) => payload.root),
      [ROOT, ROOT],
    );
    assert.deepEqual(log.failures, []);
  } finally {
    bindCoreNativeBridge(null);
  }
});

test('(k) the resolved default is the ABI layer, not the stub of lib/core.ts', async () => {
  bindCoreNativeBridge(null);

  const api = defaultLocalFsApi();
  assert.notEqual(api, null, 'this build exposes both frozen members');
  await assert.rejects(
    () => api.fsList({ root: ROOT, path: '' }),
    (error) => {
      // The dev stub answers `CoreUnavailableError`; the ABI layer answers its own
      // `CoreCallError` naming the missing native library.
      assert.equal(error.name, 'CoreCallError');
      assert.match(error.message, /núcleo nativo|libmobile_core/);
      return true;
    },
  );

  // A surface without the two frozen members is "no symbols", never a partial api.
  assert.equal(resolveLocalFsApi({ fsRead: async () => ({}) }), null);
  assert.equal(resolveLocalFsApi(null), null);
  assert.equal(resolveLocalFsApi({}), null);
});

/* ------------------------------------------------------------------ *
 * (l) the "core unavailable" copy only when the surface is really missing
 * ------------------------------------------------------------------ */

test('(l) a build without the native core says so and never blames the two symbols', async () => {
  bindCoreNativeBridge(null);
  const log = silentLogger();

  // The ABI layer exists, the native library does not: the honest cause is the missing
  // native core, not a missing `fsList`/`fsRead`.
  const state = await loadTree(localFsEditorSource(ROOT, { logger: log }), { logger: log });
  assert.equal(state.kind, 'no-fs');
  assert.ok(state.message.includes(ROOT), 'the copy names the real root');
  assert.match(state.message, /núcleo nativo|libmobile_core/);
  assert.doesNotMatch(state.message, /no expone fsList/);

  // A caller that already knows there are no symbols keeps the capability copy.
  const missing = await loadTree(localFsEditorSource(ROOT, { api: null, logger: log }), {
    logger: log,
  });
  assert.equal(missing.kind, 'no-fs');
  assert.match(missing.message, /no expone fsList\/fsRead/);
});

/* ------------------------------------------------------------------ *
 * (m) roots: the app answers `file://` URIs, the core expects a real path
 * ------------------------------------------------------------------ */

test('(m) a file:// root reaches the core as a canonical device path', async () => {
  const api = fakeCore({ entries: [], files: { 'a.ts': 'x' } });

  const tree = await loadTree(localFsEditorSource(`${ROOT_URI}/`, { api }), {
    logger: silentLogger(),
  });
  assert.equal(tree.kind, 'empty');

  const read = await readFile(localFsEditorSource(ROOT_URI, { api }), 'a.ts', {
    logger: silentLogger(),
  });
  assert.equal(read.kind, 'success');

  // `file:///data/…/` and `/data/…` are the same root: the scheme and the trailing
  // slash never reach the native allowlist.
  assert.deepEqual(api.calls.list, [{ root: ROOT, path: '', maxEntries: LOCAL_FS_MAX_ENTRIES }]);
  assert.deepEqual(api.calls.read, [{
    root: ROOT,
    path: 'a.ts',
    maxBytes: LOCAL_FS_MAX_BYTES,
  }]);
});

test('(m) an impossible root is refused naming the value, before the core is called', async () => {
  const api = fakeCore({ entries: [] });
  const log = silentLogger();

  for (const root of ['', '   ', 'proyectos/vita-app', `file://relative/vita-app`]) {
    const tree = await loadTree(localFsEditorSource(root, { api, logger: log }), { logger: log });
    assert.equal(tree.kind, 'no-fs', `"${root}" is refused`);
    assert.equal('entries' in tree, false, 'no empty project for an impossible root');
    if (root.trim() === '') {
      assert.match(tree.message, /vacía/i);
    } else {
      assert.ok(tree.message.includes(root.trim()), `the copy names "${root}"`);
    }

    const read = await readFile(localFsEditorSource(root, { api, logger: log }), 'a.ts', {
      logger: log,
    });
    assert.equal(read.kind, 'no-fs');
    assert.equal('buffer' in read, false);
  }

  assert.deepEqual(api.calls.list, [], 'an impossible root never reached the core');
  assert.deepEqual(api.calls.read, []);
  assert.ok(log.failures.some((failure) => failure.step === 'local-fs-list'));
  assert.ok(log.failures.some((failure) => failure.step === 'local-fs-read'));
});
