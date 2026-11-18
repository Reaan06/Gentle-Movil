import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALREADY_INSTALLED_NOTE,
  CONTINUE_ANYWAY_LABEL,
  CONTINUE_LABEL,
  DEFAULT_SELECTION,
  EMPTY_SELECTION,
  INSTALLED_LABEL,
  MISSING_LABEL,
  MISSING_REASON,
  MODE_STORAGE_KEY,
  NOTHING_SELECTED_LABEL,
  OVERVIEW_ROUTE,
  PROBE_NOTE,
  PROBE_RAW_UNSUPPORTED,
  QR_ROUTE,
  REPROBE_LABEL,
  SUITE_COMPONENTS,
  SUITE_ROUTE,
  SUITE_STORAGE_KEY,
  UNSUPPORTED_LABEL,
  UNSUPPORTED_REASON,
  installLabel,
  normalizeCapability,
  parseMode,
  parseSuiteRecord,
  primaryAction,
  readMode,
  recordProbe,
  routeAfterSuite,
  routeForMode,
  rowLabel,
  rowNote,
  rowSelectable,
  runSuiteProbe,
  selectedComponents,
  selectedCount,
  serializeSuiteRecord,
  toggleComponent,
} from '../lib/suite.ts';

/**
 * Contract of V21 — the suite **capability probe** (`docs/mobile-views-plan.md`
 * §V21, artboard `design/mobile-app-onboarding/05-suite-install.html`, task
 * T7p).
 *
 * The pure logic lives in `mobile/lib/suite.ts` (no React Native import), so the
 * selection rules, the probe runner, the honest per-answer log and the
 * `gentle-movil:suite` persistence are pinned without a device and without
 * rendering: the probe, the storage and the logger are all injected.
 *
 * The rule this file exists for: a component is `instalado` **only** when a
 * real install exists. There is no simulated installer any more, so nothing may
 * ever be persisted as `true` without a real `installed` answer.
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

/** Probe fake: scripted per component, records the call order. */
function fakeProbe(script = {}) {
  const calls = [];
  return {
    calls,
    async probe(component) {
      calls.push(component);
      const step = script[component];
      if (typeof step === 'function') {
        return step(component);
      }
      return step ?? { state: 'unsupported', raw: `probe:${component}`, reason: null };
    },
  };
}

/** True when any persisted write claims a component is installed. */
function anyPersistedTrue(writes) {
  return writes.some((record) => Object.values(record).some((value) => value === true));
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

test('b) tapping gentle-ai off leaves two components picked', () => {
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

test('d) the default probe answers unsupported for everything and persists no `true`', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const transitions = [];

  const result = await runSuiteProbe({
    components: selectedComponents(DEFAULT_SELECTION),
    probe: recordProbe(storage, log),
    storage,
    log,
    onState: (component, state) => transitions.push(`${component}:${state}`),
  });

  assert.deepEqual(transitions, [
    'gentle-shell:probing',
    'gentle-shell:unsupported',
    'engram:probing',
    'engram:unsupported',
    'gentle-ai:probing',
    'gentle-ai:unsupported',
  ]);
  assert.equal(SUITE_STORAGE_KEY, 'gentle-movil:suite', 'Ajustes reads this exact key later');
  assert.deepEqual(result.installed, [], 'nothing is installed on this phone yet');
  assert.deepEqual(result.missing, [], 'no real check can say it is missing either');
  assert.deepEqual(result.unsupported, ['gentle-shell', 'engram', 'gentle-ai']);
  assert.deepEqual(result.record, { gentleShell: false, engram: false, gentleAi: false });

  assert.deepEqual(storage.suite(), { gentleShell: false, engram: false, gentleAi: false });
  assert.equal(
    anyPersistedTrue(storage.suiteWrites()),
    false,
    'an unsupported probe never persists `true` for any component',
  );

  // The honest log keeps every probe answer plus its raw evidence.
  const answers = log.entries.filter((entry) => entry.data && 'state' in entry.data && entry.msg.startsWith('revisión de'));
  assert.deepEqual(
    answers.map((entry) => [entry.data.component, entry.data.state, entry.data.raw]),
    [
      ['gentle-shell', 'unsupported', PROBE_RAW_UNSUPPORTED],
      ['engram', 'unsupported', PROBE_RAW_UNSUPPORTED],
      ['gentle-ai', 'unsupported', PROBE_RAW_UNSUPPORTED],
    ],
    'every probe answer is logged with {component, state, raw}',
  );
  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.component, outcome.state, outcome.reason]),
    [
      ['gentle-shell', 'unsupported', UNSUPPORTED_REASON],
      ['engram', 'unsupported', UNSUPPORTED_REASON],
      ['gentle-ai', 'unsupported', UNSUPPORTED_REASON],
    ],
    'the real cause travels with the answer',
  );

  // Row copy: no disponible + the real reason.
  assert.equal(UNSUPPORTED_LABEL, 'no disponible');
  assert.equal(rowLabel('unsupported'), 'no disponible');
  assert.equal(rowNote('unsupported', null), UNSUPPORTED_REASON);
  assert.equal(rowNote('unsupported', 'causa medida'), 'causa medida');

  // The CTA is the honest continue, never a promise of installing.
  const action = primaryAction(DEFAULT_SELECTION, {
    canInstall: false,
    states: { 'gentle-shell': 'unsupported', engram: 'unsupported', 'gentle-ai': 'unsupported' },
  });
  assert.deepEqual(action, {
    kind: 'continue',
    label: CONTINUE_ANYWAY_LABEL,
    targets: [],
    honestContinue: true,
    enabled: true,
  });
  assert.equal(CONTINUE_ANYWAY_LABEL, 'Continuar igual →');
  assert.equal(
    action.label.toLowerCase().includes('instalar'),
    false,
    'the CTA never promises an install this build cannot do',
  );
  assert.ok(PROBE_NOTE.includes(UNSUPPORTED_REASON), 'the screen note carries the real cause');
});

test('e) one installed component shows instalado and is never re-installed', async () => {
  const storage = fakeStorage({
    [SUITE_STORAGE_KEY]: serializeSuiteRecord({
      gentleShell: true,
      engram: false,
      gentleAi: false,
    }),
  });
  const log = fakeLog();

  const result = await runSuiteProbe({
    components: selectedComponents(DEFAULT_SELECTION),
    probe: recordProbe(storage, log),
    storage,
    log,
  });

  assert.deepEqual(result.installed, ['gentle-shell'], 'only the real install is reported installed');
  assert.deepEqual(result.unsupported, ['engram', 'gentle-ai']);
  assert.deepEqual(result.record, { gentleShell: true, engram: false, gentleAi: false });

  assert.equal(INSTALLED_LABEL, 'instalado');
  assert.equal(rowLabel('installed'), 'instalado');
  assert.equal(rowNote('installed', null), null, 'an installed row carries no excuse note');
  assert.equal(rowSelectable('installed'), false, 'an installed row is locked: nothing to install there');
  assert.equal(rowSelectable('missing'), true);
  assert.equal(rowSelectable('unsupported'), true);

  const states = { 'gentle-shell': 'installed', engram: 'unsupported', 'gentle-ai': 'unsupported' };
  const honest = primaryAction(DEFAULT_SELECTION, { canInstall: false, states });
  assert.equal(honest.kind, 'continue');
  assert.equal(honest.label, CONTINUE_ANYWAY_LABEL);
  assert.equal(honest.targets.includes('gentle-shell'), false);

  // Even with a real installer, an installed component is not a target.
  const withInstaller = primaryAction(DEFAULT_SELECTION, { canInstall: true, states });
  assert.deepEqual(withInstaller.targets, [], 'unsupported rows are not install targets either');

  const mixed = primaryAction(DEFAULT_SELECTION, {
    canInstall: true,
    states: { 'gentle-shell': 'installed', engram: 'missing', 'gentle-ai': 'missing' },
  });
  assert.equal(mixed.kind, 'install');
  assert.deepEqual(mixed.targets, ['engram', 'gentle-ai']);
  assert.equal(mixed.label, 'Instalar 2 componentes →');
});

test('f) a missing component is no instalado with its reason and nothing is persisted true', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const probe = fakeProbe({
    'gentle-shell': { state: 'missing', raw: 'which gentle-shell: 1', reason: 'no está en el teléfono' },
    engram: { state: 'missing', raw: 'which engram: 1', reason: null },
  });

  const result = await runSuiteProbe({
    components: ['gentle-shell', 'engram'],
    probe: probe.probe,
    storage,
    log,
  });

  assert.deepEqual(result.missing, ['gentle-shell', 'engram']);
  assert.deepEqual(result.installed, []);
  assert.equal(MISSING_LABEL, 'no instalado');
  assert.equal(rowLabel('missing'), 'no instalado');
  assert.equal(rowNote('missing', 'no está en el teléfono'), 'no está en el teléfono');
  assert.equal(rowNote('missing', null), MISSING_REASON);
  assert.equal(rowNote('missing', '   '), MISSING_REASON);

  assert.deepEqual(storage.suite(), { gentleShell: false, engram: false, gentleAi: false });
  assert.equal(anyPersistedTrue(storage.suiteWrites()), false);
  assert.deepEqual(
    log.entries
      .filter((entry) => entry.msg.endsWith('no está instalado'))
      .map((entry) => entry.data.component),
    ['gentle-shell', 'engram'],
    'a missing answer is logged with its raw evidence',
  );

  const action = primaryAction(DEFAULT_SELECTION, {
    canInstall: false,
    states: { 'gentle-shell': 'missing', engram: 'missing', 'gentle-ai': 'missing' },
  });
  assert.equal(action.honestContinue, true);
  assert.equal(action.label, CONTINUE_ANYWAY_LABEL);
});

test('g) a corrupt, malformed or throwing answer is unsupported and never persisted as true', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const probe = fakeProbe({
    'gentle-shell': { state: 'installé', raw: 'typo' },
    engram: () => true,
    'gentle-ai': () => {
      throw new Error('el puente nativo no contestó');
    },
  });

  const result = await runSuiteProbe({
    components: selectedComponents(DEFAULT_SELECTION),
    probe: probe.probe,
    storage,
    log,
  });

  assert.deepEqual(result.installed, [], 'a malformed answer is never an installed answer');
  assert.deepEqual(result.unsupported, ['gentle-shell', 'engram', 'gentle-ai']);
  assert.deepEqual(result.record, { gentleShell: false, engram: false, gentleAi: false });
  assert.deepEqual(storage.suite(), { gentleShell: false, engram: false, gentleAi: false });
  assert.equal(anyPersistedTrue(storage.suiteWrites()), false);

  const steps = log.entries.filter((entry) => entry.step).map((entry) => entry.step);
  assert.ok(steps.includes('probe-gentle-shell'), 'the invalid state is logged honestly');
  assert.ok(steps.includes('probe-engram'), 'a bare `true` is not an installed answer');
  const thrown = log.entries.find((entry) => entry.step === 'probe-gentle-ai');
  assert.ok(thrown, 'a throwing probe is logged as a failure');
  assert.equal(thrown.error.message, 'el puente nativo no contestó');

  assert.equal(normalizeCapability('installed'), 'installed');
  assert.equal(normalizeCapability('missing'), 'missing');
  assert.equal(normalizeCapability('unsupported'), 'unsupported');
  for (const invalid of ['installed ', 'Instalado', true, 1, null, undefined, {}, ['installed']]) {
    assert.equal(normalizeCapability(invalid), 'unsupported', `${JSON.stringify(invalid)} is not installed`);
  }

  // An unreadable store cannot prove anything either: unsupported, logged.
  const brokenLog = fakeLog();
  const brokenStore = {
    async getItem() {
      throw new Error('storage roto');
    },
    async setItem() {},
  };
  const brokenRun = await runSuiteProbe({
    components: ['gentle-shell'],
    probe: recordProbe(brokenStore, brokenLog),
    storage: brokenStore,
    log: brokenLog,
  });
  assert.deepEqual(brokenRun.installed, []);
  assert.ok(brokenLog.entries.some((entry) => entry.step === 'read-suite'));
});

test('h) the honest continue is the only exit: routes and copy', () => {
  assert.equal(OVERVIEW_ROUTE, '/overview');
  assert.equal(SUITE_ROUTE, '/suite-install');
  assert.equal(QR_ROUTE, '/scan-qr');

  assert.equal(routeForMode('ambos'), '/suite-install');
  assert.equal(routeForMode('local'), '/suite-install');
  assert.equal(routeForMode('conectado'), '/scan-qr');

  assert.equal(routeAfterSuite('ambos'), '/overview');
  assert.equal(routeAfterSuite('local'), '/overview');
  assert.equal(routeAfterSuite('conectado'), '/overview');

  assert.equal(CONTINUE_LABEL, 'Continuar →');
  assert.equal(NOTHING_SELECTED_LABEL, 'Elegí un componente');
  assert.equal(REPROBE_LABEL, 'Volver a revisar');
  assert.ok(ALREADY_INSTALLED_NOTE.includes('no se vuelve a instalar'));

  assert.deepEqual(
    primaryAction(EMPTY_SELECTION, { canInstall: false, states: {} }),
    {
      kind: 'continue',
      label: NOTHING_SELECTED_LABEL,
      targets: [],
      honestContinue: false,
      enabled: false,
    },
    'nothing selected disables the CTA',
  );

  const allInstalled = primaryAction(
    { 'gentle-shell': true, engram: true, 'gentle-ai': false },
    { canInstall: false, states: { 'gentle-shell': 'installed', engram: 'installed' } },
  );
  assert.deepEqual(allInstalled, {
    kind: 'continue',
    label: CONTINUE_LABEL,
    targets: [],
    honestContinue: false,
    enabled: true,
  });

  assert.equal(parseMode('local'), 'local');
  assert.equal(parseMode('ambos'), 'ambos');
  assert.equal(parseMode('conectado'), 'conectado');
  assert.equal(parseMode(null), 'ambos', 'no stored mode falls back to the artboard default');
  assert.equal(parseMode('cualquier cosa'), 'ambos');
});

test('i) the persisted mode is read from gentle-movil:mode', async () => {
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

test('j) the suite key round-trips and a corrupt record means "not installed"', () => {
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
});

test('k) a failed persist is logged and never aborts the probe', async () => {
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

  const result = await runSuiteProbe({
    components: selectedComponents(DEFAULT_SELECTION),
    probe: recordProbe(broken, log),
    storage: broken,
    log,
  });

  assert.deepEqual(result.unsupported, ['gentle-shell', 'engram', 'gentle-ai']);
  assert.deepEqual(result.installed, [], 'a storage failure never turns into a fake install');
  assert.ok(
    log.entries.some((entry) => entry.step === 'persist-suite'),
    'the failed write is logged honestly',
  );
  assert.equal(writeAttempts, 3, 'every settled component is still persisted once');
});
