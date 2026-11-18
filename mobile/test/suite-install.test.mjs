import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SELECTION,
  EMPTY_SELECTION,
  MODE_STORAGE_KEY,
  SUITE_COMPONENTS,
  SUITE_STORAGE_KEY,
  installLabel,
  parseMode,
  parseSuiteRecord,
  readMode,
  retryLabel,
  routeAfterSuite,
  routeForMode,
  runSuiteInstall,
  selectedComponents,
  selectedCount,
  serializeSuiteRecord,
  toggleComponent,
} from '../lib/suite.ts';

/**
 * Contract of V21 — the suite installer (`docs/mobile-views-plan.md` §V21,
 * artboard `design/mobile-app-onboarding/05-suite-install.html`, owner
 * amendment L10).
 *
 * The pure logic lives in `mobile/lib/suite.ts` (no React Native import), so
 * selection rules, the per-component install runner, the `{component, ok|fail,
 * raw}` log and the `gentle-movil:suite` persistence are pinned without a
 * device and without rendering: the installer, the storage and the logger are
 * all injected.
 */

/** Fake AsyncStorage: records every write so per-component persistence is visible. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    map,
    writes,
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
      writes.push({ key, value });
    },
    /** Parsed value of the suite key, or `null` when never written. */
    suite() {
      const raw = map.get(SUITE_STORAGE_KEY);
      return raw === undefined ? null : JSON.parse(raw);
    },
    /** Parsed value of every suite write, oldest first. */
    suiteWrites() {
      return writes
        .filter((write) => write.key === SUITE_STORAGE_KEY)
        .map((write) => JSON.parse(write.value));
    },
  };
}

/** Fake scoped logger: keeps every record so the honest log is assertable. */
function fakeLog() {
  const entries = [];
  const log = {
    entries,
    info(msg, data) {
      entries.push({ level: 'info', msg, data });
    },
    warn(msg, data) {
      entries.push({ level: 'warn', msg, data });
    },
    error(msg, data) {
      entries.push({ level: 'error', msg, data });
    },
    failure(step, error, raw) {
      entries.push({ level: 'error', msg: 'failure', step, error, raw });
    },
    tag() {
      return log;
    },
  };
  return log;
}

/** Installer fake: scripted per component, records the call order. */
function fakeInstaller(script = {}) {
  const calls = [];
  return {
    calls,
    async install(component) {
      calls.push(component);
      const step = script[component];
      if (typeof step === 'function') {
        return step(component);
      }
      return step ?? { ok: true, raw: `install:${component}` };
    },
  };
}

test('a) default state selects the three components of the artboard', () => {
  assert.deepEqual(DEFAULT_SELECTION, {
    'gentle-shell': true,
    engram: true,
    'gentle-ai': true,
  });
  assert.deepEqual(
    SUITE_COMPONENTS.map((row) => row.component),
    ['gentle-shell', 'engram', 'gentle-ai'],
    'artboard order is authoritative',
  );
  assert.deepEqual(
    SUITE_COMPONENTS.map((row) => row.description),
    [
      'El agente: chat, código, automatizaciones',
      'Memoria persistente entre sesiones',
      'Trabajos y subagentes en segundo plano',
    ],
  );
  assert.deepEqual(selectedComponents(DEFAULT_SELECTION), ['gentle-shell', 'engram', 'gentle-ai']);
  assert.equal(selectedCount(DEFAULT_SELECTION), 3);
  assert.equal(installLabel(selectedCount(DEFAULT_SELECTION)), 'Instalar 3 componentes →');
});

test('b) tapping gentle-ai off leaves two components to install', () => {
  const next = toggleComponent(DEFAULT_SELECTION, 'gentle-ai');

  assert.deepEqual(next, { 'gentle-shell': true, engram: true, 'gentle-ai': false });
  assert.deepEqual(selectedComponents(next), ['gentle-shell', 'engram']);
  assert.equal(selectedCount(next), 2);
  assert.equal(installLabel(selectedCount(next)), 'Instalar 2 componentes →');
  assert.deepEqual(
    DEFAULT_SELECTION,
    { 'gentle-shell': true, engram: true, 'gentle-ai': true },
    'the reducer never mutates the previous selection',
  );
  assert.equal(selectedCount(EMPTY_SELECTION), 0, 'zero picked disables the primary CTA');
});

test('c) unchecking engram unchecks gentle-shell, re-checking gentle-shell re-checks engram', () => {
  const withoutEngram = toggleComponent(DEFAULT_SELECTION, 'engram');
  assert.deepEqual(withoutEngram, { 'gentle-shell': false, engram: false, 'gentle-ai': true });
  assert.equal(selectedCount(withoutEngram), 1);
  assert.equal(installLabel(selectedCount(withoutEngram)), 'Instalar 1 componente →');

  const back = toggleComponent(withoutEngram, 'gentle-shell');
  assert.deepEqual(back, { 'gentle-shell': true, engram: true, 'gentle-ai': true });
  assert.equal(selectedCount(back), 3);

  const shellOff = toggleComponent(DEFAULT_SELECTION, 'gentle-shell');
  assert.deepEqual(
    shellOff,
    { 'gentle-shell': false, engram: true, 'gentle-ai': true },
    'engram stands alone: turning gentle-shell off keeps the memory',
  );
});

test('d) install success marks each row installing then ok and persists all true', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const installer = fakeInstaller();
  const transitions = [];

  const result = await runSuiteInstall({
    components: selectedComponents(DEFAULT_SELECTION),
    install: installer.install,
    storage,
    log,
    onState: (component, state) => transitions.push(`${component}:${state}`),
  });

  assert.deepEqual(transitions, [
    'gentle-shell:installing',
    'gentle-shell:ok',
    'engram:installing',
    'engram:ok',
    'gentle-ai:installing',
    'gentle-ai:ok',
  ]);
  assert.equal(SUITE_STORAGE_KEY, 'gentle-movil:suite', 'Ajustes reads this exact key later');
  assert.deepEqual(result.ok, ['gentle-shell', 'engram', 'gentle-ai']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.record, { gentleShell: true, engram: true, gentleAi: true });

  assert.deepEqual(storage.suite(), { gentleShell: true, engram: true, gentleAi: true });
  assert.deepEqual(
    storage.suiteWrites(),
    [
      { gentleShell: true, engram: false, gentleAi: false },
      { gentleShell: true, engram: true, gentleAi: false },
      { gentleShell: true, engram: true, gentleAi: true },
    ],
    'the suite key is written after every component settles, in artboard order',
  );

  const attempts = log.entries.filter((entry) => entry.data && 'ok' in entry.data);
  assert.deepEqual(
    attempts.map((entry) => [entry.data.component, entry.data.ok, entry.data.raw]),
    [
      ['gentle-shell', true, 'install:gentle-shell'],
      ['engram', true, 'install:engram'],
      ['gentle-ai', true, 'install:gentle-ai'],
    ],
    'every attempt logs {component, ok, raw}',
  );
});

test('e) one component fails: only its row fails, retry targets it and persistence flips false→true', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  let attempts = 0;
  const installer = fakeInstaller({
    'gentle-ai': () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('sin espacio en el sandbox'), { kind: 'enospc' });
      }
      return { ok: true, raw: 'install:gentle-ai#2' };
    },
  });
  const states = new Map();

  const first = await runSuiteInstall({
    components: selectedComponents(DEFAULT_SELECTION),
    install: installer.install,
    storage,
    log,
    onState: (component, state) => states.set(component, state),
  });

  assert.equal(states.get('gentle-shell'), 'ok');
  assert.equal(states.get('engram'), 'ok');
  assert.equal(states.get('gentle-ai'), 'fail', 'only the failing row shows the danger state');
  assert.deepEqual(first.failed, ['gentle-ai']);
  assert.deepEqual(first.ok, ['gentle-shell', 'engram']);
  assert.deepEqual(first.record, { gentleShell: true, engram: true, gentleAi: false });
  assert.deepEqual(storage.suite(), { gentleShell: true, engram: true, gentleAi: false });
  assert.equal(retryLabel(first.failed), 'Reintentar gentle-ai');

  const failure = log.entries.find((entry) => entry.step && entry.step.includes('gentle-ai'));
  assert.ok(failure, 'a failed component is logged as an honest failure');
  assert.equal(failure.step, 'install-gentle-ai');
  assert.equal(failure.error.message, 'sin espacio en el sandbox', 'the real reason is kept');
  assert.equal(failure.raw, null, 'a throw carries no raw output');
  assert.ok(
    log.entries.some((entry) => entry.data && entry.data.component === 'gentle-ai' && entry.data.ok === false),
    'the failed attempt is logged as {component, ok:false, raw}',
  );
  assert.equal(attempts, 1, 'a failing component is attempted once, the others are not disturbed');

  const retry = await runSuiteInstall({
    components: first.failed,
    install: installer.install,
    storage,
    log,
  });

  assert.deepEqual(retry.ok, ['gentle-ai']);
  assert.deepEqual(retry.failed, []);
  assert.deepEqual(retry.record, { gentleShell: true, engram: true, gentleAi: true });
  assert.deepEqual(storage.suite(), { gentleShell: true, engram: true, gentleAi: true });
  assert.deepEqual(installer.calls, ['gentle-shell', 'engram', 'gentle-ai', 'gentle-ai']);
});

test('f) continue anyway proceeds with what succeeded and keeps the failure persisted', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const installer = fakeInstaller({
    'gentle-ai': () => ({ ok: false, raw: 'exit 1: sin permisos' }),
  });

  const result = await runSuiteInstall({
    components: selectedComponents(DEFAULT_SELECTION),
    install: installer.install,
    storage,
    log,
  });

  assert.deepEqual(result.failed, ['gentle-ai']);
  assert.deepEqual(storage.suite(), { gentleShell: true, engram: true, gentleAi: false });
  assert.equal(routeAfterSuite('ambos'), '/scan-qr', 'ambos continues to the QR scan');
  assert.equal(routeAfterSuite('local'), null, 'local stays on the screen: route still pending');
  assert.equal(routeAfterSuite('conectado'), '/scan-qr');
});

test('g) mode routing sends both modes to the suite installer and connected straight to the QR', () => {
  assert.equal(routeForMode('ambos'), '/suite-install');
  assert.equal(routeForMode('local'), '/suite-install');
  assert.equal(routeForMode('conectado'), '/scan-qr');

  assert.equal(parseMode('local'), 'local');
  assert.equal(parseMode('ambos'), 'ambos');
  assert.equal(parseMode('conectado'), 'conectado');
  assert.equal(parseMode(null), 'ambos', 'no stored mode falls back to the artboard default');
  assert.equal(parseMode('cualquier cosa'), 'ambos');
});

test('g2) the persisted mode is read from gentle-movil:mode', async () => {
  assert.equal(MODE_STORAGE_KEY, 'gentle-movil:mode', 'the key V4 already persisted is unchanged');
  const storage = fakeStorage({ [MODE_STORAGE_KEY]: 'local' });
  assert.equal(await readMode(storage), 'local');

  const empty = fakeStorage();
  assert.equal(await readMode(empty), 'ambos');

  const broken = {
    async getItem() {
      throw new Error('storage roto');
    },
    async setItem() {},
  };
  const log = fakeLog();
  assert.equal(await readMode(broken, log), 'ambos', 'an unreadable store never crashes the screen');
  assert.ok(
    log.entries.some((entry) => entry.step === 'read-mode'),
    'the failed read is logged honestly',
  );
});

test('h) the suite key round-trips and a broken store is logged instead of thrown', async () => {
  assert.deepEqual(parseSuiteRecord(null), { gentleShell: false, engram: false, gentleAi: false });
  assert.deepEqual(parseSuiteRecord('{'), { gentleShell: false, engram: false, gentleAi: false });
  assert.deepEqual(
    parseSuiteRecord(serializeSuiteRecord({ gentleShell: true, engram: false, gentleAi: true })),
    { gentleShell: true, engram: false, gentleAi: true },
  );
  assert.deepEqual(
    parseSuiteRecord('{"gentleShell":"sí","engram":1}'),
    { gentleShell: false, engram: false, gentleAi: false },
    'only real booleans count as installed',
  );

  const log = fakeLog();
  let writeAttempts = 0;
  const broken = {
    async getItem() {
      return null;
    },
    async setItem() {
      writeAttempts += 1;
      throw new Error('disco lleno');
    },
  };
  const installer = fakeInstaller();

  const result = await runSuiteInstall({
    components: selectedComponents(DEFAULT_SELECTION),
    install: installer.install,
    storage: broken,
    log,
  });

  assert.deepEqual(result.ok, ['gentle-shell', 'engram', 'gentle-ai'], 'a storage failure never aborts the install');
  assert.ok(
    log.entries.some((entry) => entry.step === 'persist-suite'),
    'the failed write is logged honestly',
  );
  assert.equal(writeAttempts, 3, 'every settled component is still persisted once');
});
