/**
 * V14 — Local projects tests (artboard
 * `design/mobile-app-core/07-local-projects.html`, `docs/mobile-views-plan.md`
 * §V14, task T7k).
 *
 * `lib/local-projects.ts` is honest UI over facts that really exist on the
 * phone:
 *
 * - the project list is the `gentle-movil:local-projects` record the person
 *   actually created — nothing is invented, and an empty store is an empty
 *   state, not a failure;
 * - a corrupt store or an invalid entry inside a valid array is a typed error
 *   that names what is wrong (the index), never a silently dropped project;
 * - git facts (`branch`, dirty count, last commit) do not exist yet: the core
 *   Rust does not expose gitoxide, so every row carries `gitFacts: null` with
 *   the literal reason `sin datos de git` — never a fake branch or a fake
 *   `0 cambios`;
 * - opening a project is a `pending: true` intent for `/local-editor`, because
 *   the editor belongs to the next slice.
 *
 * T15 (delete) and T18 (real device files) additions:
 *
 * - deleting a project is a confirmation, never one tap, removes only the
 *   `gentle-movil:local-projects` record through the existing model, reconciles
 *   the active/last-opened project when the deleted one was it, and says out
 *   loud that the phone's files are NOT touched;
 * - every row can show what the device really has (`N entradas` or the honest
 *   reason), read through the injected core fs surface; nothing becomes an
 *   `0 entradas` success.
 *
 * No AsyncStorage and no device: storage is an injected reader/writer and the
 * core fs surface is injected too, so this file pins the parsing, ordering,
 * validation, persistence and honesty rules.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DELETE_CANCEL_LABEL,
  DELETE_CONFIRM_LABEL,
  DELETE_CONFIRM_TITLE,
  DELETE_FILES_UNTOUCHED_NOTE,
  DELETE_LABEL,
  GIT_FACTS_UNKNOWN_REASON,
  LOCAL_EDITOR_ROUTE,
  LOCAL_PROJECTS_ROUTE,
  LOCAL_PROJECTS_STORAGE_KEY,
  RETRY_LABEL,
  activeProjectId,
  buildProjectsView,
  createProjectIntent,
  deleteProjectIntent,
  diskFactFromTree,
  loadProjectDisk,
  loadProjects,
  openProjectIntent,
  projectRootFor,
  saveProjects,
} from '../lib/local-projects.ts';

/** A project as the store holds it (the shape V14 writes). */
function project(overrides = {}) {
  return {
    id: 'p1',
    name: 'gentle-movil',
    path: 'proyectos/gentle-movil',
    createdAt: '2026-11-01T10:00:00.000Z',
    lastOpenedAt: null,
    ...overrides,
  };
}

/** Injected storage: reads and writes share one map, so round-trip is real. */
function fakeStorage(initial = null) {
  const map = new Map();
  if (initial !== null) {
    map.set(LOCAL_PROJECTS_STORAGE_KEY, initial);
  }
  const reads = [];
  const writes = [];
  return {
    map,
    reads,
    writes,
    async read(key) {
      reads.push(key);
      return map.has(key) ? map.get(key) : null;
    },
    async write(key, value) {
      writes.push({ key, value });
      map.set(key, value);
    },
  };
}

/** Reader that throws (unreadable store, not a missing key). */
const throwingReader = async () => {
  throw new Error('storage unavailable');
};

/* (a) empty storage is a fact, not a failure */

test('(a) empty storage → empty state, not an error', async () => {
  const storage = fakeStorage();
  const state = await loadProjects(storage.read);
  const vm = buildProjectsView(state);

  assert.deepEqual(state, { kind: 'loaded', projects: [] });
  assert.equal(vm.status, 'empty');
  assert.equal(vm.error, null);
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.count, 0);
  assert.equal(vm.empty.title, 'Todavía no hay proyectos');
  assert.equal(vm.empty.message, 'Aún no hay proyectos. Clona un repositorio o crea uno.');
  assert.ok(storage.reads.includes(LOCAL_PROJECTS_STORAGE_KEY));
});

test('(a) an unreadable store is an error state, not an empty one', async () => {
  const state = await loadProjects(throwingReader);
  const vm = buildProjectsView(state);

  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'storage unavailable');
  assert.equal(vm.status, 'error');
  assert.equal(vm.empty, null);
});

/* (b) ordering: last opened first, unknown last */

test('(b) two projects → last-opened-first ordering with unknown last', async () => {
  const storage = fakeStorage(
    JSON.stringify([
      project({ id: 'old', name: 'alfa', lastOpenedAt: '2026-11-10T10:00:00.000Z' }),
      project({ id: 'never', name: 'beta', lastOpenedAt: null }),
      project({ id: 'recent', name: 'zeta', lastOpenedAt: '2026-11-18T10:00:00.000Z' }),
    ]),
  );

  const vm = buildProjectsView(await loadProjects(storage.read));

  assert.equal(vm.status, 'success');
  assert.deepEqual(
    vm.rows.map((row) => row.id),
    ['recent', 'old', 'never'],
  );
  assert.equal(vm.count, 3);
  assert.equal(vm.countLabel, '3 proyectos');
  assert.equal(vm.rows.at(-1).lastOpenedLabel, 'sin abrir');
});

test('(b) never-opened projects fall back to alphabetical order', async () => {
  const storage = fakeStorage(
    JSON.stringify([
      project({ id: 'z', name: 'zeta' }),
      project({ id: 'a', name: 'Alfa' }),
      project({ id: 'm', name: 'medio' }),
    ]),
  );

  const vm = buildProjectsView(await loadProjects(storage.read));

  assert.deepEqual(
    vm.rows.map((row) => row.name),
    ['Alfa', 'medio', 'zeta'],
  );
  assert.equal(vm.countLabel, '3 proyectos');
});

/* (c) corrupt store → honest error with Reintentar */

test('(c) corrupt JSON → error state + Reintentar present', async () => {
  const storage = fakeStorage('{no soy json');
  const state = await loadProjects(storage.read);
  const vm = buildProjectsView(state);

  assert.equal(state.kind, 'error');
  assert.equal(state.index, null);
  assert.equal(vm.status, 'error');
  assert.equal(vm.error.title, 'No pudimos leer los proyectos');
  assert.equal(vm.error.action.label, RETRY_LABEL);
  assert.equal(vm.error.action.pending, false);
  assert.equal(vm.error.action.route, LOCAL_PROJECTS_ROUTE);
  assert.match(vm.error.message, /JSON/);
  assert.deepEqual(vm.rows, []);
});

test('(c) a JSON object instead of an array is an error, never an empty list', async () => {
  const vm = buildProjectsView(await loadProjects(fakeStorage('{"projects":[]}').read));

  assert.equal(vm.status, 'error');
  assert.equal(vm.error.message, 'El almacenamiento no tiene una lista de proyectos.');
});

/* (d) an invalid entry inside a valid array is a typed error naming the index */

test('(d) invalid entry inside a valid array → typed error naming the index', async () => {
  const storage = fakeStorage(
    JSON.stringify([
      project({ id: 'p1' }),
      project({ id: 'p2', name: '   ' }),
      project({ id: 'p3' }),
    ]),
  );

  const state = await loadProjects(storage.read);
  const vm = buildProjectsView(state);

  assert.equal(state.kind, 'error');
  assert.equal(state.index, 1);
  assert.match(state.message, /proyecto 2/);
  assert.equal(vm.status, 'error');
  assert.match(vm.error.detail, /proyecto 2/);
  assert.match(vm.error.message, /proyecto 2/);
  // The two valid projects are not rendered as if the list were fine.
  assert.deepEqual(vm.rows, []);
});

test('(d) an entry with a bad field type is rejected, never coerced', async () => {
  const storage = fakeStorage(
    JSON.stringify([project({ id: 'ok' }), { ...project({ id: 7 }), name: 'roto' }]),
  );

  const state = await loadProjects(storage.read);

  assert.equal(state.kind, 'error');
  assert.equal(state.index, 1);
  assert.match(state.message, /proyecto 2/);
});

/* (e) create validation */

test('(e) empty name → typed per-field error', () => {
  const result = createProjectIntent('', []);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    { field: 'name', code: 'empty', message: 'Poné un nombre al proyecto.' },
  ]);
});

test('(e) whitespace-only name → typed per-field error', () => {
  const result = createProjectIntent('   \t  ', []);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    { field: 'name', code: 'empty', message: 'Poné un nombre al proyecto.' },
  ]);
});

test('(e) duplicate name is rejected case-insensitively', () => {
  const existing = [project({ id: 'p1', name: 'Gentle-Movil' })];
  const result = createProjectIntent('  gentle-movil ', existing);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    { field: 'name', code: 'duplicate', message: 'Ya existe un proyecto con ese nombre.' },
  ]);
});

test('(e) a valid name is trimmed and becomes a real project', () => {
  const result = createProjectIntent('  Vita App  ', [], {
    id: 'nuevo',
    now: '2026-11-18T12:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.project, {
    id: 'nuevo',
    name: 'Vita App',
    path: 'proyectos/Vita-App',
    createdAt: '2026-11-18T12:00:00.000Z',
    lastOpenedAt: null,
  });
});

/* (f) save then load round-trip */

test('(f) save then load round-trip keeps every field', async () => {
  const storage = fakeStorage();
  const projects = [
    project({ id: 'a', name: 'alfa', lastOpenedAt: '2026-11-18T09:00:00.000Z' }),
    project({ id: 'b', name: 'beta', path: 'proyectos/beta' }),
  ];

  const saved = await saveProjects(storage.write, projects);
  assert.deepEqual(saved, { ok: true });
  assert.deepEqual(storage.writes, [
    { key: LOCAL_PROJECTS_STORAGE_KEY, value: JSON.stringify(projects) },
  ]);

  const state = await loadProjects(storage.read);
  assert.deepEqual(state, { kind: 'loaded', projects });

  const vm = buildProjectsView(state);
  assert.deepEqual(
    vm.rows.map((row) => [row.id, row.name, row.path]),
    [
      ['a', 'alfa', 'proyectos/gentle-movil'],
      ['b', 'beta', 'proyectos/beta'],
    ],
  );
});

test('(f) a failing write is reported, never thrown', async () => {
  const result = await saveProjects(async () => {
    throw new Error('disk full');
  }, [project()]);

  assert.deepEqual(result, { ok: false, message: 'disk full' });
});

/* (g) git facts are honestly unknown until the core exposes gitoxide */

test('(g) every project carries the honest sin datos de git reason', async () => {
  const storage = fakeStorage(
    JSON.stringify([project({ id: 'p1' }), project({ id: 'p2', name: 'beta' })]),
  );
  const vm = buildProjectsView(await loadProjects(storage.read));

  assert.equal(vm.rows.length, 2);
  for (const row of vm.rows) {
    assert.equal(row.gitFacts, null);
    assert.equal(row.gitFactsReason, GIT_FACTS_UNKNOWN_REASON);
    assert.equal(row.gitFactsReason, 'sin datos de git');
    assert.match(row.gitFactsDetail, /gitoxide/);
  }
  assert.match(vm.gitNote, /sin datos de git/);
});

/* (h) open intent is honest about the editor not existing yet */

test('(h) open intent carries pending: true and /local-editor with the id', () => {
  const intent = openProjectIntent(project({ id: 'p42', name: 'vita-app' }));

  assert.equal(intent.pending, true);
  assert.equal(intent.route, LOCAL_EDITOR_ROUTE);
  assert.equal(intent.route, '/local-editor');
  assert.equal(intent.projectId, 'p42');
  assert.match(intent.note, /todavía no está/);
});

/* ------------------------------------------------------------------ *
 * (i) T15 — delete: a confirmation step, the record only, and the real files
 * stay untouched
 * ------------------------------------------------------------------ */

/** Two projects: one opened recently, one never opened. */
function twoProjects() {
  return [
    project({ id: 'p1', name: 'alfa', lastOpenedAt: '2026-11-10T10:00:00.000Z' }),
    project({ id: 'p2', name: 'beta', path: 'proyectos/beta', lastOpenedAt: null }),
  ];
}

test('(i) delete needs a confirmation step: one tap removes nothing', () => {
  const projects = twoProjects();

  const refused = deleteProjectIntent('p1', projects);

  assert.equal(refused.ok, false);
  assert.equal(refused.needsConfirm, true);
  assert.match(refused.message, /alfa/);
  assert.match(refused.message, /no se tocan/, 'the copy says the files are not touched');
  assert.equal(projects.length, 2, 'the list the caller holds is untouched');
});

test('(i) a confirmed delete removes only that record, and says so plainly', () => {
  const projects = twoProjects();

  const result = deleteProjectIntent('p1', projects, { confirm: true });

  assert.equal(result.ok, true);
  assert.equal(result.removed.id, 'p1');
  assert.deepEqual(
    result.projects.map((entry) => entry.id),
    ['p2'],
    'only the deleted record is gone',
  );
  assert.match(result.note, /no se tocan/);
  assert.match(result.note, /ficha del proyecto/);
  // Nothing physical is announced: deleting the folder is a separate action.
  assert.match(DELETE_FILES_UNTOUCHED_NOTE, /no se tocan/);
  assert.match(DELETE_FILES_UNTOUCHED_NOTE, /todavía no está conectada/);
  assert.equal(DELETE_LABEL, 'Eliminar');
  assert.equal(DELETE_CONFIRM_TITLE, '¿Eliminar el proyecto?');
  assert.equal(DELETE_CONFIRM_LABEL, 'Eliminar de la lista');
  assert.equal(DELETE_CANCEL_LABEL, 'Cancelar');
});

test('(i) deleting an id that is not in the record removes nothing, honestly', () => {
  const projects = twoProjects();

  const result = deleteProjectIntent('no-existe', projects, { confirm: true });

  assert.equal(result.ok, false);
  assert.equal(result.needsConfirm, false);
  assert.match(result.message, /ya no está en la lista/);
  assert.match(result.message, /no hay nada que eliminar/);
});

test('(i) the active/last-opened project is reconciled when the deleted one was it', () => {
  const projects = [
    project({ id: 'old', name: 'alfa', lastOpenedAt: '2026-11-10T10:00:00.000Z' }),
    project({ id: 'recent', name: 'beta', lastOpenedAt: '2026-11-18T10:00:00.000Z' }),
    project({ id: 'never', name: 'zeta', lastOpenedAt: null }),
  ];
  assert.equal(activeProjectId(projects), 'recent', 'the newest open is the active one');

  const deleted = deleteProjectIntent('recent', projects, { confirm: true, activeId: 'recent' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.activeCleared, true);
  assert.equal(deleted.activeId, 'old', 'the next last-opened project becomes active');

  // Another project keeps the active pointer exactly as it was.
  const other = deleteProjectIntent('never', projects, { confirm: true, activeId: 'recent' });
  assert.equal(other.ok, true);
  assert.equal(other.activeCleared, false);
  assert.equal(other.activeId, 'recent');

  // Deleting the only project leaves no active project, never a dangling id.
  const last = deleteProjectIntent('only', [project({ id: 'only' })], { confirm: true });
  assert.equal(last.ok, true);
  assert.equal(last.activeId, null);
  assert.deepEqual(last.projects, []);
});

test('(i) delete round-trips through the store: the record really loses the entry', async () => {
  const storage = fakeStorage(JSON.stringify(twoProjects()));
  const loaded = await loadProjects(storage.read);

  const result = deleteProjectIntent('p1', loaded.projects, { confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(await saveProjects(storage.write, result.projects), { ok: true });

  const after = await loadProjects(storage.read);
  assert.deepEqual(
    after.projects.map((entry) => entry.id),
    ['p2'],
  );
  const vm = buildProjectsView(after);
  assert.equal(vm.count, 1);
  assert.equal(vm.countLabel, '1 proyecto');
  assert.deepEqual(
    vm.rows.map((row) => row.name),
    ['beta'],
  );
});

test('(i) the view model carries the delete affordance and its confirmation copy', () => {
  const vm = buildProjectsView({ kind: 'loaded', projects: twoProjects() });

  assert.equal(vm.delete.label, DELETE_LABEL);
  assert.equal(vm.delete.confirmTitle, DELETE_CONFIRM_TITLE);
  assert.equal(vm.delete.confirmLabel, DELETE_CONFIRM_LABEL);
  assert.equal(vm.delete.cancelLabel, DELETE_CANCEL_LABEL);
  assert.match(vm.delete.filesNote, /no se tocan/);
});

/* ------------------------------------------------------------------ *
 * (j) T18 — the real device root, and what each row really has
 * ------------------------------------------------------------------ */

test('(j) the project root is the app documents dir plus the recorded path', () => {
  const rooted = projectRootFor('proyectos/vita-app', 'file:///data/user/0/ai.gentle.movil/files/');
  assert.equal(rooted.ok, true);
  assert.equal(rooted.root, 'file:///data/user/0/ai.gentle.movil/files/proyectos/vita-app');

  const normalized = projectRootFor('proyectos/x', '/docs//');
  assert.equal(normalized.ok, true);
  assert.equal(normalized.root, '/docs/proyectos/x');

  // A path that would leave the app sandbox is refused, never glued on.
  for (const escaping of ['../fuera', 'proyectos/../../fuera', '/fuera']) {
    const refused = projectRootFor(escaping, '/docs');
    assert.equal(refused.ok, false, `"${escaping}" is refused`);
    assert.match(refused.message, /sale de la carpeta de la app|absoluta/i);
  }

  const missingPath = projectRootFor('   ', '/docs');
  assert.equal(missingPath.ok, false);
  assert.match(missingPath.message, /no tiene una ruta registrada/);

  const missingBase = projectRootFor('proyectos/x', '');
  assert.equal(missingBase.ok, false);
  assert.match(missingBase.message, /carpeta de la app/);
});

test('(j) every row shows what the device really has, or the honest reason', () => {
  const entries = (count) =>
    Array.from({ length: count }, (_, index) => ({ path: `f${index}.ts`, size: 1, kind: 'file' }));

  assert.deepEqual(diskFactFromTree({ kind: 'success', entries: entries(2) }), {
    kind: 'entries',
    count: 2,
    label: '2 entradas',
    reason: null,
  });
  assert.equal(diskFactFromTree({ kind: 'success', entries: entries(1) }).label, '1 entrada');
  assert.deepEqual(diskFactFromTree({ kind: 'empty' }), {
    kind: 'empty',
    count: 0,
    label: 'carpeta vacía',
    reason: null,
  });

  const stale = diskFactFromTree({ kind: 'stale', entries: entries(3), minutes: 4 });
  assert.equal(stale.kind, 'entries');
  assert.equal(stale.count, 3);
  assert.match(stale.label, /de hace 4 min/);

  // A capability gap keeps the real message, never a zero count.
  const noFs = diskFactFromTree({
    kind: 'no-fs',
    message: 'Sin acceso a archivos: esta build no expone fsList/fsRead',
    raw: 'root=/docs/proyectos/x',
  });
  assert.equal(noFs.kind, 'unavailable');
  assert.equal(noFs.count, null);
  assert.equal(noFs.label, 'sin datos');
  assert.match(noFs.reason, /Sin acceso a archivos/);

  const failure = diskFactFromTree({ kind: 'error', message: 'permiso denegado', raw: 'EACCES' });
  assert.equal(failure.kind, 'unavailable');
  assert.match(failure.reason, /permiso denegado/);

  const offline = diskFactFromTree({ kind: 'offline', entries: null, minutes: null });
  assert.equal(offline.kind, 'unavailable');
  assert.match(offline.reason, /sin conexión|no respondió/i);

  // Rows carry the fact; a row that was not read yet says so instead of `0`.
  const vm = buildProjectsView(
    { kind: 'loaded', projects: [project({ id: 'p1' })] },
    { disk: { p1: { kind: 'entries', count: 3, label: '3 entradas', reason: null } } },
  );
  assert.equal(vm.rows[0].disk.label, '3 entradas');

  const unread = buildProjectsView({ kind: 'loaded', projects: [project({ id: 'p1' })] });
  assert.equal(unread.rows[0].disk.kind, 'unavailable');
  assert.match(unread.rows[0].disk.reason, /todavía no leímos/);
});

test('(j) loadProjectDisk reads each project root through the injected core surface', async () => {
  const calls = [];
  const api = {
    async fsList(input) {
      calls.push(input);
      return { entries: [{ path: 'a.ts', size: 4, kind: 'file' }] };
    },
    async fsRead() {
      throw new Error('not used');
    },
  };

  const facts = await loadProjectDisk([project({ id: 'p1', path: 'proyectos/uno' })], {
    documentsDir: '/docs',
    api,
  });

  assert.equal(facts.p1.kind, 'entries');
  assert.equal(facts.p1.count, 1);
  assert.deepEqual(calls[0].root, '/docs/proyectos/uno');
  assert.equal(calls[0].path, '');

  // No documents dir → every row says why, never `0 entradas`.
  const unresolvable = await loadProjectDisk([project({ id: 'p1', path: 'proyectos/uno' })], {
    documentsDir: null,
    api,
  });
  assert.equal(unresolvable.p1.kind, 'unavailable');
  assert.match(unresolvable.p1.reason, /carpeta de la app/);

  // A core without the fs symbols is the honest reason, not an empty project.
  const noSymbols = await loadProjectDisk([project({ id: 'p1', path: 'proyectos/uno' })], {
    documentsDir: '/docs',
    api: null,
  });
  assert.equal(noSymbols.p1.kind, 'unavailable');
  assert.match(noSymbols.p1.reason, /fsList/);
});
