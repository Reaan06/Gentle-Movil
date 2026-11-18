/**
 * V13 — Git changes tests (artboard `design/mobile-app-core/09-git-changes.html`,
 * `docs/mobile-views-plan.md` §V13).
 *
 * `lib/git.ts` reads the REAL bridge over the SSH tunnel (`GET /api/git/status`,
 * protocol §4). Every case here speaks the real HTTP/1.1 wire format through a
 * fake channel (same helpers as `mobile/test/bridge.test.mjs`) and pins:
 *
 * - the staged/unstaged split, then the `Modificados / Nuevos / Borrados /
 *   Renombrados` sections, with the file rows sorted by path inside a section;
 * - the `N archivos · +X −Y` total line, computed from the real numbers;
 * - one honest state per outcome (`loading | empty | success | stale |
 *   offline | error`), never an invented file, diff or stat;
 * - an extension that does not expose the endpoint yet is an ERROR carrying the
 *   failure, never an empty "no changes" success.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Encode } from '../lib/core.ts';
import {
  ChangesCache,
  GIT_STATUS_PATH,
  buildChangesView,
  changeTotals,
  diffRoute,
  groupFiles,
  loadChanges,
  parseChanges,
  summaryLine,
} from '../lib/git.ts';

/** A full HTTP/1.1 response in one frame (the peer closes right after). */
function okChannel(body, status = 200) {
  const wire = `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: utf8Encode(wire), eof: true };
    },
    async close() {},
  };
}

/** Raw bytes on the wire, for malformed answers. */
function rawChannel(text) {
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: utf8Encode(text), eof: true };
    },
    async close() {},
  };
}

/** Tunnel that is up but never answers (the timeout path). */
function silentChannel() {
  return {
    async write() {
      return 1;
    },
    read: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 50),
      ),
    async close() {},
  };
}

/** Tunnel that refuses the write (the core reports no channel). */
function refusedChannel() {
  return {
    async write() {
      return 0;
    },
    async read() {
      return { bytes: new Uint8Array(), eof: true };
    },
    async close() {},
  };
}

/** Records the request line the module wrote, so the path is pinned. */
function recordingChannel(body, status = 200) {
  const channel = okChannel(body, status);
  const writes = [];
  const write = channel.write;
  channel.write = async (payload) => {
    writes.push(new TextDecoder().decode(payload));
    return write(payload);
  };
  channel.writes = writes;
  return channel;
}

const file = (path, status, additions, deletions, staged) => ({
  path,
  status,
  additions,
  deletions,
  staged,
});

/** Collects the `{step, error, raw}` failures instead of hitting the file sink. */
function collectingLogger() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
  };
}

const PAYLOAD = {
  workspace: '/home/reaan/Contrib/gentle-movil',
  branch: 'feat/auth-login',
  ahead: 2,
  behind: 0,
  files: [
    file('src/a.ts', 'modified', 3, 1, true),
    file('test/b.test.ts', 'added', 8, 0, false),
    file('src/old.ts', 'deleted', 0, 12, true),
    file('src/c.ts', 'modified', 1, 1, false),
  ],
};

test('GIT_STATUS_PATH is the endpoint the bridge is expected to expose (protocol §4)', () => {
  assert.equal(GIT_STATUS_PATH, '/api/git/status');
});

test('(a) mixed files split into staged/unstaged, then by status, with real totals', async () => {
  const channel = recordingChannel(PAYLOAD);
  const state = await loadChanges(channel, { logger: collectingLogger() });
  assert.equal(state.kind, 'success');
  assert.match(channel.writes[0], /^GET \/api\/git\/status HTTP\/1\.1/);

  const vm = buildChangesView(state);
  assert.equal(vm.state, 'success');
  assert.equal(vm.groups.length, 2);

  const [staged, unstaged] = vm.groups;
  assert.equal(staged.id, 'staged');
  assert.equal(staged.title, 'Preparados');
  assert.equal(unstaged.id, 'unstaged');
  assert.equal(unstaged.title, 'Sin preparar');

  // Staged: one modified, one deleted, in §V13 section order.
  assert.deepEqual(
    staged.sections.map((s) => [s.id, s.title, s.rows.map((r) => r.path)]),
    [
      ['modified', 'Modificados', ['src/a.ts']],
      ['deleted', 'Borrados', ['src/old.ts']],
    ],
  );
  // Unstaged: the new file and the other modified one.
  assert.deepEqual(
    unstaged.sections.map((s) => [s.id, s.rows.map((r) => r.path)]),
    [
      ['modified', ['src/c.ts']],
      ['added', ['test/b.test.ts']],
    ],
  );

  // Totals are summed from the real numbers, never guessed.
  assert.deepEqual(vm.totals, { files: 4, additions: 12, deletions: 14 });
  assert.equal(vm.summary, '4 archivos · +12 −14');
  assert.equal(vm.branch, 'feat/auth-login');
  assert.equal(vm.ahead, 2);
  assert.equal(vm.behind, 0);
});

test('(b) rows sort by path inside a section and sections keep the §V13 order', async () => {
  const state = await loadChanges(
    okChannel({
      files: [
        file('src/z-last.ts', 'modified', 1, 0, true),
        file('README.md', 'renamed', 0, 0, true),
        file('src/a-first.ts', 'modified', 2, 0, true),
        file('src/gone.ts', 'deleted', 0, 4, true),
        file('src/new.ts', 'added', 5, 0, true),
        file('docs/spec.md', 'modified', 1, 1, true),
      ],
    }),
    { logger: collectingLogger() },
  );
  assert.equal(state.kind, 'success');
  const [staged] = buildChangesView(state).groups;
  assert.deepEqual(
    staged.sections.map((s) => [s.id, s.rows.map((r) => r.path)]),
    [
      ['modified', ['docs/spec.md', 'src/a-first.ts', 'src/z-last.ts']],
      ['added', ['src/new.ts']],
      ['deleted', ['src/gone.ts']],
      ['renamed', ['README.md']],
    ],
  );
});

test('(b) grouping is a pure function over parsed files (stable, no fetch)', async () => {
  const parsed = parseChanges(PAYLOAD);
  assert.equal(parsed.ok, true);
  const groups = groupFiles(parsed.payload.files);
  assert.deepEqual(
    groups.map((g) => [g.id, g.rows.length]),
    [
      ['staged', 2],
      ['unstaged', 2],
    ],
  );
  // Rows carry the artboard glyph/status copy and the +/− delta.
  const [first] = groups[0].sections[0].rows;
  assert.equal(first.glyph, 'M');
  assert.equal(first.statusLabel, 'Modificado');
  assert.equal(first.delta, '+3 −1');
});

test('(c) a clean tree is the empty state, never success with zeros', async () => {
  const cache = new ChangesCache();
  const state = await loadChanges(okChannel({ files: [] }), { cache, logger: collectingLogger() });
  assert.equal(state.kind, 'empty');
  const vm = buildChangesView(state);
  assert.equal(vm.state, 'empty');
  assert.deepEqual(vm.groups, []);
  assert.equal(vm.totals, null);
  assert.equal(vm.summary, null);
  assert.equal(vm.emptyMessage, 'Sin cambios en este workspace.');
  // A clean answer is truth: nothing is kept to fall back to.
  assert.equal(cache.snapshot(), null);
});

test('(d) no tunnel is offline with the §V13 copy, never an empty success', async () => {
  const logger = collectingLogger();
  const state = await loadChanges(null, { logger });
  assert.equal(state.kind, 'offline');
  const vm = buildChangesView(state);
  assert.equal(vm.state, 'offline');
  assert.equal(vm.groups.length, 0);
  assert.equal(vm.banner, 'Requiere conexión — git se ejecuta en tu PC.');
  assert.match(vm.bannerHint, /Reconectando/);
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'tunnel');
});

test('(d) a refused channel write is offline too, not an empty tree', async () => {
  const logger = collectingLogger();
  const state = await loadChanges(refusedChannel(), { logger });
  assert.equal(state.kind, 'offline');
  assert.equal(state.payload, null);
  assert.equal(logger.failures.at(0).step, 'git-status-request');
  assert.equal(logger.failures.at(0).raw, 'write=0');
});

test('(e) 404 from the bridge is an honest error naming the missing endpoint', async () => {
  const logger = collectingLogger();
  const channel = recordingChannel({ error: 'not found' }, 404);
  const state = await loadChanges(channel, { logger });

  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La extensión no expone los cambios todavía');
  assert.match(state.raw, /status=404/);
  assert.match(state.raw, /\/api\/git\/status/);
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'git-status-request');
  assert.equal(logger.failures[0].raw, state.raw);

  const vm = buildChangesView(state);
  assert.equal(vm.state, 'error');
  assert.deepEqual(vm.error, {
    title: 'No pudimos leer los cambios',
    message: 'La extensión no expone los cambios todavía',
    raw: state.raw,
  });
  // The failure is an error card, never an empty "no changes" screen.
  assert.deepEqual(vm.groups, []);
  assert.notEqual(vm.emptyMessage, 'Sin cambios en este workspace.');
});

test('(e) any other rejected status keeps its own honest message and raw', async () => {
  const logger = collectingLogger();
  const state = await loadChanges(okChannel({ error: 'boom' }, 500), { logger });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC respondió 500.');
  assert.equal(state.raw, 'status=500 /api/git/status');
  assert.equal(logger.failures.at(0).raw, 'status=500 /api/git/status');
});

test('(f) broken JSON is an error with the raw body prefix, never an empty tree', async () => {
  const logger = collectingLogger();
  const state = await loadChanges(rawChannel('HTTP/1.1 200 OK\r\n\r\n{"files": ['), { logger });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC devolvió un JSON roto.');
  assert.match(state.raw, /\{"files"/);
  assert.equal(logger.failures.at(0).raw, state.raw);
  assert.equal(buildChangesView(state).error.raw, state.raw);
});

test('(f) a body without a files array is an error, never an empty tree', async () => {
  const state = await loadChanges(okChannel({ branch: 'main' }), { logger: collectingLogger() });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC devolvió datos incompletos sobre los cambios.');
  assert.match(state.raw, /branch/);
});

test('(h) an invalid file entry is an error carrying its path, not invented stats', async () => {
  for (const bad of [
    { path: 'src/x.ts', status: 'modified', additions: 'many', deletions: 0, staged: false },
    { path: 'src/x.ts', status: 'exploded', additions: 1, deletions: 0, staged: false },
    { path: 'src/x.ts', status: 'modified', additions: 1, deletions: 0 },
  ]) {
    const state = await loadChanges(okChannel({ files: [bad] }), { logger: collectingLogger() });
    assert.equal(state.kind, 'error');
    assert.equal(state.message, 'La PC devolvió datos incompletos sobre los cambios.');
    assert.match(state.raw, /src\/x\.ts/);
  }
});

test('(g) timeout after a good answer is stale with the cached rows and minutes', async () => {
  const cache = new ChangesCache();
  const logger = collectingLogger();
  const good = await loadChanges(okChannel(PAYLOAD), { cache, logger });
  assert.equal(good.kind, 'success');

  const state = await loadChanges(silentChannel(), { cache, logger, timeoutMs: 20 });
  assert.equal(state.kind, 'stale');
  const vm = buildChangesView(state);
  assert.equal(vm.state, 'stale');
  assert.equal(vm.staleChip, 'Datos de hace 1 min');
  assert.equal(vm.frozen, true);
  assert.equal(vm.summary, '4 archivos · +12 −14');
  assert.equal(vm.groups.length, 2);
});

test('(g) offline after a good answer keeps the rows readable and frozen', async () => {
  const cache = new ChangesCache();
  const logger = collectingLogger();
  await loadChanges(okChannel(PAYLOAD), { cache, logger });
  const state = await loadChanges(null, { cache, logger });
  assert.equal(state.kind, 'offline');
  const vm = buildChangesView(state);
  assert.equal(vm.frozen, true);
  assert.equal(vm.groups.flatMap((g) => g.rows).length, 4);
  assert.equal(vm.staleChip, 'Última vez hace 1 min');
  assert.equal(vm.banner, 'Requiere conexión — git se ejecuta en tu PC.');
});

test('(g) the summary line uses es-AR singular copy for a single file', () => {
  assert.equal(changeTotals([file('a.ts', 'modified', 2, 1, false)]).files, 1);
  assert.equal(summaryLine({ files: 1, additions: 2, deletions: 1 }), '1 archivo · +2 −1');
  assert.equal(summaryLine({ files: 0, additions: 0, deletions: 0 }), '0 archivos · +0 −0');
});

test('loading renders skeletons, not an empty tree', () => {
  const vm = buildChangesView({ kind: 'loading' });
  assert.equal(vm.state, 'loading');
  assert.equal(vm.loading, true);
  assert.deepEqual(vm.groups, []);
  assert.equal(vm.emptyMessage, null);
  assert.equal(vm.error, null);
});

test('diffRoute points at the pending diff view with the path encoded', () => {
  assert.equal(diffRoute('src/a b.ts'), '/git-changes/src%2Fa%20b.ts');
});
