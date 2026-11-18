/**
 * V15/V16 — Local editor tests (artboard
 * `design/mobile-app-core/08-local-editor.html`, `docs/mobile-views-plan.md`
 * §V15/§V16, task T7l).
 *
 * `lib/local-editor.ts` is honest UI over a capability that does not exist yet:
 * the Rust core has no filesystem FFI and the bridge has no fs endpoint. So the
 * editor never invents an empty file, a syntax highlight or a save:
 *
 * - the file list is parsed strictly from whatever the injected source returns,
 *   with dirs first and a typed error naming the offending entry;
 * - a buffer derives `dirty` from `text !== original` (never set by hand) and
 *   closing a dirty one asks first instead of silently dropping the content;
 * - a huge file is cut at a real cap with the `truncado` marker and its hidden
 *   count, never a silent cut;
 * - saving is a `pending: true` intent for `POST /api/fs/write` with the honest
 *   note, so the buffer stays dirty after the tap;
 * - seven honest states: `loading | empty | success | stale | offline | error`
 *   plus `no-fs`, whose copy names the real cause (no fs FFI in the core).
 *
 * No channel and no device are needed: the source is injected, and the two
 * cases that do speak to the bridge use a fake channel carrying the real
 * HTTP/1.1 wire format (same helper as `mobile/test/terminal.test.mjs`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Encode } from '../lib/core.ts';
import {
  DISPLAY_CHAR_CAP,
  FS_READ_PATH,
  FS_TREE_PATH,
  FS_WRITE_PATH,
  LOCAL_EDITOR_ROUTE,
  MISSING_ENDPOINT_COPY,
  NO_FS_MESSAGE,
  SAVE_PENDING_NOTE,
  TAB_SIZE,
  TREE_EMPTY_COPY,
  TreeCache,
  bridgeEditorSource,
  closeBuffer,
  editBuffer,
  expandTabs,
  formatSize,
  loadTree,
  openBuffer,
  orderEntries,
  parseTree,
  readFile,
  renderCode,
  saveIntent,
  treeRows,
} from '../lib/local-editor.ts';

/* ------------------------------------------------------------------ *
 * Fakes (injected source, fake channel, silent logger)
 * ------------------------------------------------------------------ */

/** Injected source: lists `treeBody`, reads the texts in `files`. */
function fakeSource(treeBody, files = {}) {
  const reads = [];
  return {
    reads,
    async list() {
      return { ok: true, body: treeBody };
    },
    async read(path) {
      reads.push(path);
      if (!(path in files)) {
        return { ok: false, failure: { kind: 'bad-response', message: 'sin archivo', raw: path } };
      }
      return { ok: true, body: { path, text: files[path] } };
    },
  };
}

/** Injected source that fails every call with one typed failure. */
function failingSource(failure) {
  return {
    async list() {
      return { ok: false, failure };
    },
    async read() {
      return { ok: false, failure };
    },
  };
}

const TIMEOUT_FAILURE = {
  kind: 'timeout',
  message: 'La PC no respondió a tiempo.',
  raw: '8000ms',
};

/** Answers the first `list()` and times out afterwards (the stale path). */
function flakySource(treeBody) {
  let calls = 0;
  return {
    async list() {
      calls += 1;
      if (calls === 1) {
        return { ok: true, body: treeBody };
      }
      return { ok: false, failure: TIMEOUT_FAILURE };
    },
    async read() {
      return { ok: false, failure: TIMEOUT_FAILURE };
    },
  };
}

/** Full HTTP/1.1 answer in one frame, recording the request line. */
function httpChannel(body, status = 200) {
  const writes = [];
  const wire = `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  return {
    writes,
    async write(payload) {
      writes.push(new TextDecoder().decode(payload));
      return 1;
    },
    async read() {
      return { bytes: utf8Encode(wire), eof: true };
    },
    async close() {},
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

/** Controllable clock for the cache minutes. */
function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

const ENTRY = (path, extra = {}) => ({ path, size: 10, kind: 'file', ...extra });

/* ------------------------------------------------------------------ *
 * (a) strict tree parse + dirs-first ordering
 * ------------------------------------------------------------------ */

test('(a) the tree keeps every real entry and orders dirs first, then alphabetical', async () => {
  const body = {
    entries: [
      ENTRY('src/app.ts', { size: 120 }),
      ENTRY('src/lib', { size: 0, kind: 'dir' }),
      ENTRY('README.md', { size: 40 }),
      ENTRY('src/components', { size: 0, kind: 'dir' }),
    ],
  };

  const state = await loadTree(fakeSource(body), { logger: silentLogger() });
  assert.equal(state.kind, 'success');
  assert.deepEqual(
    state.entries.map((entry) => entry.path),
    ['src/components', 'src/lib', 'README.md', 'src/app.ts'],
  );
  assert.deepEqual(state.entries[0], { path: 'src/components', size: 0, kind: 'dir' });
  assert.equal(state.entries.length, 4, 'no entry is dropped');

  // Display rows: name, depth and a real size label (never a guessed one).
  const rows = treeRows(state.entries);
  assert.deepEqual(
    rows.map((row) => [row.name, row.kind, row.depth, row.sizeLabel]),
    [
      ['components', 'dir', 1, '0 B'],
      ['lib', 'dir', 1, '0 B'],
      ['README.md', 'file', 0, '40 B'],
      ['app.ts', 'file', 1, '120 B'],
    ],
  );
  assert.equal(formatSize(2048), '2.0 kB');
  assert.equal(formatSize(1024 * 1024), '1.0 MB');
  assert.equal(formatSize(-1), '—');
});

/* ------------------------------------------------------------------ *
 * (b) invalid entry → typed error naming it
 * ------------------------------------------------------------------ */

test('(b) an invalid tree entry is a typed error naming it, never a shorter list', async () => {
  const body = {
    entries: [ENTRY('src/ok.ts'), { path: 'src/roto.ts', size: '10', kind: 'file' }],
  };

  const parsed = parseTree(body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.index, 1);
  assert.match(parsed.message, /entrada 2/);
  assert.match(parsed.message, /src\/roto\.ts/);
  assert.match(parsed.raw, /roto/);

  const state = await loadTree(fakeSource(body), { logger: silentLogger() });
  assert.equal(state.kind, 'error');
  assert.match(state.message, /entrada 2/);
  assert.equal('entries' in state, false, 'no partial tree is exposed as truth');

  // A body that is not a tree at all fails the same way, not as an empty tree.
  const wrongShape = await loadTree(fakeSource({ files: [] }), { logger: silentLogger() });
  assert.equal(wrongShape.kind, 'error');
  assert.match(wrongShape.message, /árbol/);
});

/* ------------------------------------------------------------------ *
 * (c)/(d) buffer model: dirty derived from the diff
 * ------------------------------------------------------------------ */

test('(c) opening a real file then editing derives dirty = true', async () => {
  const source = fakeSource({ entries: [ENTRY('src/app.ts')] }, { 'src/app.ts': 'const a = 1;' });

  const read = await readFile(source, 'src/app.ts', { logger: silentLogger() });
  assert.equal(read.kind, 'success');
  assert.equal(read.buffer.path, 'src/app.ts');
  assert.equal(read.buffer.text, 'const a = 1;');
  assert.equal(read.buffer.original, 'const a = 1;');
  assert.equal(read.buffer.dirty, false);
  assert.deepEqual(source.reads, ['src/app.ts'], 'the injected source is the one read');

  const edited = editBuffer(read.buffer, 'const a = 2;');
  assert.equal(edited.dirty, true);
  assert.equal(edited.text, 'const a = 2;');
  assert.equal(edited.original, 'const a = 1;', 'the original is the file, not the last edit');
  assert.equal(read.buffer.text, 'const a = 1;', 'the previous buffer is not mutated');
});

test('(d) editing back to the original text derives dirty = false', () => {
  const buffer = openBuffer('src/app.ts', 'const a = 1;');
  const dirty = editBuffer(buffer, 'const a = 2;');
  assert.equal(dirty.dirty, true);

  const back = editBuffer(dirty, 'const a = 1;');
  assert.equal(back.dirty, false, 'dirty is derived from text !== original');
  assert.equal(back.text, back.original);
});

/* ------------------------------------------------------------------ *
 * (e) closing a dirty buffer asks first
 * ------------------------------------------------------------------ */

test('(e) closing a dirty buffer returns needsConfirm, and the confirm path discards', () => {
  const dirty = editBuffer(openBuffer('src/app.ts', 'x'), 'y');

  const refused = closeBuffer(dirty);
  assert.equal(refused.ok, false);
  assert.equal(refused.needsConfirm, true);
  assert.match(refused.message, /Descartar/i);
  assert.equal(dirty.dirty, true, 'a refused close changes nothing');

  const confirmed = closeBuffer(dirty, true);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.discarded, true);

  const clean = closeBuffer(openBuffer('src/app.ts', 'x'));
  assert.equal(clean.ok, true);
  assert.equal(clean.discarded, false);
});

/* ------------------------------------------------------------------ *
 * (f) real truncation at the cap
 * ------------------------------------------------------------------ */

test('(f) a huge file is cut at the cap with the truncado marker and its count', () => {
  const huge = Array.from({ length: 4_000 }, (_, index) => `linea ${index} ${'x'.repeat(40)}`).join(
    '\n',
  );

  const code = renderCode(huge);
  assert.equal(code.truncated, true);
  assert.ok(code.hidden > 0, 'the marker names how much was hidden');
  assert.ok(code.marker !== null);
  assert.match(code.marker, /truncado/);
  assert.match(code.marker, new RegExp(String(code.hidden)));
  assert.ok(code.lines.length < 4_000, 'the pane stops at the cap');

  // No silent cut: kept text + hidden characters equals the whole display text.
  const kept = code.lines.map((line) => line.text).join('\n');
  assert.equal(huge.startsWith(kept), true);
  assert.equal(kept.length + code.hidden, huge.length);
  assert.deepEqual(
    code.lines.map((line) => line.number),
    code.lines.map((_, index) => index + 1),
  );

  // The cap is real: exactly at it there is no cut, one character over there is.
  assert.equal(renderCode('a'.repeat(DISPLAY_CHAR_CAP)).truncated, false);
  const over = renderCode(`${'a'.repeat(DISPLAY_CHAR_CAP)}b`);
  assert.equal(over.truncated, true);
  assert.equal(over.hidden, DISPLAY_CHAR_CAP + 1 - over.lines.map((line) => line.text).join('\n').length);
});

/* ------------------------------------------------------------------ *
 * (g) local mode: no source → no-fs naming the core FFI
 * ------------------------------------------------------------------ */

test('(g) local mode (no source) is no-fs, naming the missing core fs FFI', async () => {
  const log = silentLogger();
  const state = await loadTree(null, { logger: log });
  assert.equal(state.kind, 'no-fs');
  assert.match(state.message, /sin acceso a archivos/i);
  assert.match(state.message, /core/i);
  assert.match(state.message, /ffi/i);
  assert.match(state.message, /fs_read/);
  assert.equal('entries' in state, false, 'no blank tree that looks like an empty project');

  // The real default source with no tunnel says exactly the same thing.
  const local = await loadTree(bridgeEditorSource(null), { logger: log });
  assert.equal(local.kind, 'no-fs');
  assert.equal(local.message, state.message);

  // Reading in local mode is no-fs too, never an empty buffer.
  const read = await readFile(null, 'src/app.ts', { logger: log });
  assert.equal(read.kind, 'no-fs');
  assert.equal(read.message, NO_FS_MESSAGE);
  assert.equal('buffer' in read, false);
  assert.ok(log.failures.length >= 3, 'every failure is logged with its step');
});

/* ------------------------------------------------------------------ *
 * (h) bridge 501 → error carrying the failure, not an empty buffer
 * ------------------------------------------------------------------ */

test('(h) a bridge 501 is an error carrying the failure, never an empty file', async () => {
  const log = silentLogger();

  // (1) Injected source already reporting the missing capability.
  const missing = {
    kind: 'missing-endpoint',
    message: MISSING_ENDPOINT_COPY,
    raw: `status=501 ${FS_TREE_PATH}`,
  };
  const injected = await loadTree(failingSource(missing), { logger: log });
  assert.equal(injected.kind, 'error');
  assert.equal(injected.message, MISSING_ENDPOINT_COPY);
  assert.match(injected.raw, /501/);
  assert.equal('entries' in injected, false);

  // (2) The real source over a channel that answers 501 (the wire path).
  const listChannel = httpChannel({ error: 'not implemented' }, 501);
  const overWire = await loadTree(bridgeEditorSource(listChannel), { logger: log });
  assert.equal(overWire.kind, 'error');
  assert.equal(overWire.message, MISSING_ENDPOINT_COPY);
  assert.match(overWire.raw, /501/);
  assert.match(listChannel.writes[0], new RegExp(`^GET ${FS_TREE_PATH} `));

  const readChannel = httpChannel({ error: 'not implemented' }, 501);
  const readOverWire = await readFile(bridgeEditorSource(readChannel), 'src/app.ts', { logger: log });
  assert.equal(readOverWire.kind, 'error');
  assert.equal('buffer' in readOverWire, false, 'a 501 is not an empty buffer');
  assert.match(readChannel.writes[0], new RegExp(`^GET ${FS_READ_PATH}\\?path=src%2Fapp\\.ts `));

  // (3) A 200 without a text is still an error: never an empty file pretending
  // to be a real one.
  const emptyBody = await readFile(fakeSource({ entries: [] }, {}), 'src/app.ts', { logger: log });
  assert.equal(emptyBody.kind, 'error');
  const noText = await readFile(
    { async list() { return { ok: true, body: { entries: [] } }; }, async read() { return { ok: true, body: {} }; } },
    'src/app.ts',
    { logger: log },
  );
  assert.equal(noText.kind, 'error');
  assert.equal('buffer' in noText, false);
});

/* ------------------------------------------------------------------ *
 * The bridge's real bodies (declared by the extension) parse without inventing
 * ------------------------------------------------------------------ */

test('the bridge entry shape (type + content) parses, and a symlink is refused by name', async () => {
  const log = silentLogger();
  const source = {
    async list() {
      return {
        ok: true,
        body: {
          path: '',
          truncated: false,
          entries: [
            { name: 'src', path: 'src', type: 'dir', size: null },
            { name: 'app.ts', path: 'src/app.ts', type: 'file', size: 42 },
          ],
        },
      };
    },
    async read() {
      return { ok: true, body: { path: 'src/app.ts', size: 42, encoding: 'utf8', content: 'ok\n' } };
    },
  };

  const tree = await loadTree(source, { logger: log });
  assert.equal(tree.kind, 'success');
  assert.deepEqual(tree.entries, [
    { path: 'src', size: 0, kind: 'dir' },
    { path: 'src/app.ts', size: 42, kind: 'file' },
  ]);

  const read = await readFile(source, 'src/app.ts', { logger: log });
  assert.equal(read.kind, 'success');
  assert.equal(read.buffer.text, 'ok\n');

  // A symlink is neither a file nor a dir: the tree fails naming it instead of
  // pretending an openable file (or a silently dropped entry).
  const symlink = await loadTree(
    {
      async list() {
        return {
          ok: true,
          body: { entries: [{ name: '.bin', path: '.bin', type: 'symlink', size: null }] },
        };
      },
      async read() {
        return { ok: false, failure: { kind: 'bad-response', message: 'x', raw: null } };
      },
    },
    { logger: log },
  );
  assert.equal(symlink.kind, 'error');
  assert.match(symlink.message, /\.bin/);
});

/* ------------------------------------------------------------------ *
 * (i) save intent is pending, never a fake save
 * ------------------------------------------------------------------ */

test('(i) the save intent is pending: true on /api/fs/write and keeps the buffer dirty', () => {
  const buffer = editBuffer(openBuffer('src/app.ts', 'a'), 'b');

  const intent = saveIntent(buffer);
  assert.equal(intent.pending, true);
  assert.equal(intent.method, 'POST');
  assert.equal(intent.route, FS_WRITE_PATH);
  assert.equal(intent.route, '/api/fs/write');
  assert.equal(intent.path, 'src/app.ts');
  assert.equal(intent.text, 'b');
  assert.equal(intent.dirty, true);
  assert.equal(intent.note, SAVE_PENDING_NOTE);
  assert.match(intent.note, /todavía no está conectado/);
  assert.match(intent.note, /fs_write/);

  // Nothing was saved: the buffer is still dirty and still holds the edit.
  assert.equal(buffer.dirty, true);
  assert.equal(buffer.text, 'b');
  assert.equal(LOCAL_EDITOR_ROUTE, '/local-editor');
});

/* ------------------------------------------------------------------ *
 * (j) line numbers + tab expansion
 * ------------------------------------------------------------------ */

test('(j) line numbers are 1-based and tabs expand to the tab size', () => {
  const code = renderCode('\tif (ok) {\n\t\treturn 1;\n}\n');
  const pad = (count) => ' '.repeat(count);

  assert.deepEqual(code.lines, [
    { number: 1, text: `${pad(TAB_SIZE)}if (ok) {` },
    { number: 2, text: `${pad(TAB_SIZE * 2)}return 1;` },
    { number: 3, text: '}' },
    { number: 4, text: '' },
  ]);
  assert.equal(code.truncated, false);
  assert.equal(code.marker, null);
  assert.equal(code.hidden, 0);

  // Column-aware stops, not a fixed replacement.
  assert.equal(expandTabs('\tx'), `${pad(TAB_SIZE)}x`);
  assert.equal(expandTabs('ab\tx'), `ab${pad(TAB_SIZE)}x`);
  assert.equal(expandTabs('a\tb'), `a${pad(TAB_SIZE - 1)}b`);
  assert.equal(expandTabs('sin tabs'), 'sin tabs');
});

/* ------------------------------------------------------------------ *
 * Honest tree states: empty / offline / stale
 * ------------------------------------------------------------------ */

test('empty tree is the empty-project state, never an error and never a fake file', async () => {
  const state = await loadTree(fakeSource({ entries: [] }), { logger: silentLogger() });
  assert.equal(state.kind, 'empty');
  assert.match(TREE_EMPTY_COPY, /Proyecto vacío/);
  assert.equal('entries' in state, false);
});

test('no tunnel is offline with no rows, never an empty project', async () => {
  const state = await loadTree(
    failingSource({ kind: 'offline', message: 'Sin túnel hacia la PC.', raw: null }),
    { logger: silentLogger() },
  );
  assert.equal(state.kind, 'offline');
  assert.equal(state.entries, null);
  assert.equal(state.minutes, null);
});

test('timeout after a good answer is stale with the minutes and the real entries', async () => {
  const c = clock();
  const cache = new TreeCache(c.now);
  const source = flakySource({ entries: [ENTRY('a.ts', { size: 3 })] });

  const first = await loadTree(source, { cache, logger: silentLogger() });
  assert.equal(first.kind, 'success');

  c.advance(120_000);
  const second = await loadTree(source, { cache, logger: silentLogger() });
  assert.equal(second.kind, 'stale');
  assert.equal(second.minutes, 2);
  assert.deepEqual(
    second.entries.map((entry) => entry.path),
    ['a.ts'],
  );
});

test('ordering is stable and case-insensitive inside the dirs/files groups', () => {
  const entries = [
    { path: 'Zeta.ts', size: 1, kind: 'file' },
    { path: 'alfa.ts', size: 1, kind: 'file' },
    { path: 'src', size: 0, kind: 'dir' },
  ];
  assert.deepEqual(
    orderEntries(entries).map((entry) => entry.path),
    ['src', 'alfa.ts', 'Zeta.ts'],
  );
});
