/**
 * V18 — Settings tests (artboard `design/mobile-app-core/10-settings.html`,
 * `docs/mobile-views-plan.md` §V18, task T7i).
 *
 * `lib/settings.ts` builds the whole view model from REAL state already on the
 * phone — the `gentle-movil:mode` and `gentle-movil:suite` records written by
 * the onboarding, the active tunnel from `lib/tunnel-store.ts`, and the app
 * info the caller passes in — plus the real constants of `lib/logger.ts`.
 *
 * No AsyncStorage and no device: the storage is an injected async reader, the
 * tunnel is an injected snapshot, and the assertions pin the honesty rules:
 *
 * - nothing stored is "not installed", never an error, and never a guessed mode;
 * - a corrupt record is a `storageError` state with RETRY, never silently empty
 *   values pretending to be facts (`Sin datos`, not `No instalado`);
 * - every destination that is not built yet says `pending: true` with its route;
 * - the diagnostics copy carries the real log file name, ring capacity and
 *   rotation limit from `lib/logger.ts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOG_CAPACITY,
  LOG_DIR,
  LOG_FILE,
  LOG_ROTATE_BYTES,
} from '../lib/logger.ts';
import {
  MODE_STORAGE_KEY,
  SUITE_ROUTE,
  SUITE_STORAGE_KEY,
  serializeSuiteRecord,
} from '../lib/suite.ts';
import {
  EXPORT_ROUTE,
  INSTALLED_LABEL,
  MODE_ROUTE,
  NO_MODE_LABEL,
  NOT_INSTALLED_LABEL,
  SIN_TUNEL_LABEL,
  TUNNEL_ROUTE,
  UNKNOWN_LABEL,
  loadSettings,
} from '../lib/settings.ts';

/** App/build info the caller knows (`expo-constants` in the screen). */
const APP = { version: '0.1.0', build: '42' };

/** Injected AsyncStorage reader: records every key it was asked for. */
function fakeReader(values = {}) {
  const map = new Map(Object.entries(values));
  const reads = [];
  return {
    reads,
    async read(key) {
      reads.push(key);
      return map.has(key) ? map.get(key) : null;
    },
  };
}

/** Failure sink that keeps the `{step, error, raw}` records it received. */
function fakeLog() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
  };
}

/** Dependencies of one load: no tunnel, the real app info, a recording log. */
function deps(extra = {}) {
  return { tunnel: null, app: APP, logger: fakeLog(), ...extra };
}

/** Every action descriptor the sections expose, in render order. */
function actionsOf(vm) {
  return vm.sections.flatMap((section) =>
    section.rows.map((row) => row.action).filter((action) => action !== null),
  );
}

/** Suite row values in artboard order (`gentle-shell`, `engram`, `gentle-ai`). */
function suiteValues(vm) {
  return vm.suite.map((row) => row.value);
}

test('(a) full record → stored mode and all three components installed', async () => {
  const storage = fakeReader({
    [MODE_STORAGE_KEY]: 'local',
    [SUITE_STORAGE_KEY]: serializeSuiteRecord({
      gentleShell: true,
      engram: true,
      gentleAi: true,
    }),
  });

  const vm = await loadSettings(storage.read, deps());

  assert.equal(vm.mode, 'local');
  assert.equal(vm.modeLabel, 'Local');
  assert.equal(vm.storageError, null);
  assert.deepEqual(
    vm.suite.map((row) => row.component),
    ['gentle-shell', 'engram', 'gentle-ai'],
  );
  assert.deepEqual(vm.suite.map((row) => row.installed), [true, true, true]);
  assert.deepEqual(suiteValues(vm), [INSTALLED_LABEL, INSTALLED_LABEL, INSTALLED_LABEL]);
  // The three real components also reach the rendered section.
  const suiteSection = vm.sections.find((section) => section.id === 'suite');
  assert.deepEqual(
    suiteSection.rows.filter((row) => row.value !== '').map((row) => row.value),
    [INSTALLED_LABEL, INSTALLED_LABEL, INSTALLED_LABEL],
  );
  assert.deepEqual(storage.reads.sort(), [MODE_STORAGE_KEY, SUITE_STORAGE_KEY].sort());
});

test('(b) empty storage → Sin elegir + No instalado, and it is NOT an error', async () => {
  const storage = fakeReader();
  const log = fakeLog();

  const vm = await loadSettings(storage.read, deps({ logger: log }));

  assert.equal(vm.mode, null);
  assert.equal(vm.modeLabel, NO_MODE_LABEL);
  assert.equal(vm.storageError, null);
  assert.deepEqual(vm.suite.map((row) => row.installed), [false, false, false]);
  assert.deepEqual(suiteValues(vm), [
    NOT_INSTALLED_LABEL,
    NOT_INSTALLED_LABEL,
    NOT_INSTALLED_LABEL,
  ]);
  // An empty store is a fact, not a failure: nothing is logged as one.
  assert.deepEqual(log.failures, []);
  assert.equal(vm.suiteKnown, true);
});

test('(c) partial record → mixed installed / not installed rows', async () => {
  const storage = fakeReader({
    [MODE_STORAGE_KEY]: 'ambos',
    // The shape the task names: kebab spelling, one component installed.
    [SUITE_STORAGE_KEY]: JSON.stringify({
      'gentle-shell': true,
      engram: false,
      gentleAi: false,
    }),
  });

  const vm = await loadSettings(storage.read, deps());

  assert.equal(vm.modeLabel, 'Ambos');
  assert.equal(vm.storageError, null);
  assert.deepEqual(vm.suite.map((row) => row.installed), [true, false, false]);
  assert.deepEqual(suiteValues(vm), [
    INSTALLED_LABEL,
    NOT_INSTALLED_LABEL,
    NOT_INSTALLED_LABEL,
  ]);
});

test('(d) corrupt JSON → honest storageError, never silently empty', async () => {
  const storage = fakeReader({
    [MODE_STORAGE_KEY]: 'local',
    [SUITE_STORAGE_KEY]: '{"gentleShell": true,,,',
  });
  const log = fakeLog();

  const vm = await loadSettings(storage.read, deps({ logger: log }));

  assert.notEqual(vm.storageError, null);
  assert.deepEqual(vm.storageError.keys, [SUITE_STORAGE_KEY]);
  assert.ok(vm.storageError.message.length > 0, 'the platform message is kept verbatim');
  assert.equal(vm.storageError.title, 'No pudimos leer el almacenamiento');
  assert.match(vm.storageError.detail, /gentle-movil:suite/);
  // Retrying is real (it re-reads the store), so it is not a pending route.
  assert.equal(vm.storageError.action.label, 'Reintentar');
  assert.equal(vm.storageError.action.pending, false);
  // The corrupt record is unknown, not "not installed": nothing is claimed.
  assert.equal(vm.suiteKnown, false);
  assert.deepEqual(suiteValues(vm), [UNKNOWN_LABEL, UNKNOWN_LABEL, UNKNOWN_LABEL]);
  // The mode key read fine, so it still shows the stored truth.
  assert.equal(vm.modeLabel, 'Local');
  // The failure goes to the log with the key it came from.
  assert.equal(log.failures.length, 1);
  assert.equal(log.failures[0].raw.key, SUITE_STORAGE_KEY);
});

test('(d2) a throwing reader → same honest storageError state', async () => {
  const log = fakeLog();
  const read = async (key) => {
    if (key === MODE_STORAGE_KEY) {
      throw new Error('AsyncStorage no disponible');
    }
    return null;
  };

  const vm = await loadSettings(read, deps({ logger: log }));

  assert.notEqual(vm.storageError, null);
  assert.deepEqual(vm.storageError.keys, [MODE_STORAGE_KEY]);
  assert.equal(vm.storageError.message, 'AsyncStorage no disponible');
  assert.equal(vm.modeKnown, false);
  assert.equal(vm.modeLabel, UNKNOWN_LABEL);
  assert.equal(vm.storageError.action.pending, false);
});

test('(e) tunnel present → the real host and forwarded ports', async () => {
  const storage = fakeReader({ [MODE_STORAGE_KEY]: 'conectado' });
  const tunnel = { sessionId: 'sess-7', host: 'reaan-pc', ports: [43721] };

  const vm = await loadSettings(storage.read, deps({ tunnel }));

  assert.equal(vm.tunnel.present, true);
  assert.equal(vm.tunnel.host, 'reaan-pc');
  assert.deepEqual(vm.tunnel.ports, [43721]);
  assert.equal(vm.tunnel.sessionId, 'sess-7');
  assert.equal(vm.tunnel.value, 'reaan-pc');
  assert.match(vm.tunnel.detail, /43721/);
  assert.match(vm.tunnel.detail, /sess-7/);

  const tunnelSection = vm.sections.find((section) => section.id === 'tunel');
  const stateRow = tunnelSection.rows.find((row) => row.id === 'tunel-estado');
  assert.equal(stateRow.value, 'reaan-pc');
  assert.match(stateRow.detail, /43721/);
});

test('(f) no tunnel → Sin túnel, with no invented host or port', async () => {
  const storage = fakeReader();

  const vm = await loadSettings(storage.read, deps());

  assert.equal(vm.tunnel.present, false);
  assert.equal(vm.tunnel.host, null);
  assert.deepEqual(vm.tunnel.ports, []);
  assert.equal(vm.tunnel.sessionId, null);
  assert.equal(vm.tunnel.value, SIN_TUNEL_LABEL);

  const tunnelSection = vm.sections.find((section) => section.id === 'tunel');
  const stateRow = tunnelSection.rows.find((row) => row.id === 'tunel-estado');
  assert.equal(stateRow.value, SIN_TUNEL_LABEL);
  assert.doesNotMatch(stateRow.detail, /43721/);
});

test('(g) every unbuilt destination is pending and names its route', async () => {
  const storage = fakeReader({
    [MODE_STORAGE_KEY]: 'ambos',
    [SUITE_STORAGE_KEY]: serializeSuiteRecord({
      gentleShell: true,
      engram: false,
      gentleAi: false,
    }),
  });

  const vm = await loadSettings(storage.read, deps());
  const actions = actionsOf(vm);
  const pending = actions.filter((action) => action.pending);

  assert.deepEqual(
    pending.map((action) => action.route).sort(),
    [EXPORT_ROUTE, MODE_ROUTE, SUITE_ROUTE, TUNNEL_ROUTE].sort(),
  );
  for (const action of pending) {
    assert.equal(action.pending, true);
    assert.ok(action.label.length > 0);
    // An action that cannot happen must say so, not fail silently.
    assert.ok(
      typeof action.note === 'string' && action.note.length > 0,
      `pending action ${action.label} has no honest note`,
    );
  }
  // The only wired action is the storage retry, and it lives on the error state.
  assert.equal(vm.storageError, null);
  assert.ok(actions.every((action) => action.pending));

  // The tunnel action changes copy with the real state, same pending route.
  const vmWithTunnel = await loadSettings(
    storage.read,
    deps({ tunnel: { sessionId: 's', host: 'pc', ports: [43721] } }),
  );
  const tunnelActions = actionsOf(vmWithTunnel).filter(
    (action) => action.route === TUNNEL_ROUTE,
  );
  assert.equal(tunnelActions.length, 1);
  assert.equal(tunnelActions[0].pending, true);
  assert.notEqual(tunnelActions[0].label, pending.find((a) => a.route === TUNNEL_ROUTE).label);
});

test('(h) diagnostics copy carries the real log file, capacity and rotation', async () => {
  const storage = fakeReader({ [MODE_STORAGE_KEY]: 'ambos' });

  const vm = await loadSettings(storage.read, deps());

  const rotateLabel = `${Math.round(LOG_ROTATE_BYTES / 1024)} KB`;
  assert.equal(vm.diagnostics.logFile, LOG_FILE);
  assert.equal(vm.diagnostics.logPath, `${LOG_DIR}/${LOG_FILE}`);
  assert.equal(vm.diagnostics.capacity, LOG_CAPACITY);
  assert.equal(vm.diagnostics.rotateBytes, LOG_ROTATE_BYTES);
  assert.equal(vm.diagnostics.rotateLabel, rotateLabel);

  // The export text is built from those constants, not from literals.
  assert.match(vm.exportText, new RegExp(LOG_FILE.replace('.', '\\.')));
  assert.ok(vm.exportText.includes(String(LOG_CAPACITY)));
  assert.ok(vm.exportText.includes(rotateLabel));
  assert.ok(vm.exportText.includes('0.1.0'));
  assert.ok(vm.exportText.includes('build 42'));
  // Real state reaches the copy: no tunnel and the stored mode.
  assert.ok(vm.exportText.includes(SIN_TUNEL_LABEL));
  assert.ok(vm.exportText.includes('Ambos'));

  // The export action is the honest pending one.
  const exportAction = actionsOf(vm).find((action) => action.route === EXPORT_ROUTE);
  assert.equal(exportAction.pending, true);
});
