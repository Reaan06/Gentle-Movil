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
 * No AsyncStorage and no device: storage is an injected reader/writer, so this
 * file pins the parsing, ordering, validation, persistence and honesty rules.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GIT_FACTS_UNKNOWN_REASON,
  LOCAL_EDITOR_ROUTE,
  LOCAL_PROJECTS_ROUTE,
  LOCAL_PROJECTS_STORAGE_KEY,
  RETRY_LABEL,
  buildProjectsView,
  createProjectIntent,
  loadProjects,
  openProjectIntent,
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
