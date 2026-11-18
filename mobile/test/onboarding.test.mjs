import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONBOARDED_STORAGE_KEY,
  ONBOARDED_FALSE,
  ONBOARDED_TRUE,
  REPAIR_LABEL,
  clearOnboarded,
  finishModeChoice,
  finishSuiteStep,
  initialRouteFor,
  markOnboarded,
  rePair,
  readOnboarded,
} from '../lib/onboarding.ts';

/**
 * Contract of the onboarding exit (`docs/mobile-views-plan.md` §V4/§V21, task
 * T7p).
 *
 * The rule: the app remembers that the onboarding finished (`gentle-movil:onboarded`)
 * and the entry stops sending the person back to the QR scan; `/overview` is
 * where a finished onboarding lands. The flag is storage-injected, so all of
 * this is pinned offline — and a corrupt value must never trap the person and
 * never throw.
 */

/** Fake AsyncStorage: records every write so the flag is assertable. */
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
    /** Raw stored value of the onboarding key, or `null`. */
    flag() {
      return map.has(ONBOARDED_STORAGE_KEY) ? map.get(ONBOARDED_STORAGE_KEY) : null;
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

test('a) the flag key and the two entry routes are exactly these', () => {
  assert.equal(ONBOARDED_STORAGE_KEY, 'gentle-movil:onboarded');
  assert.equal(initialRouteFor(true), '/overview', 'an onboarded phone opens the dashboard');
  assert.equal(initialRouteFor(false), '/scan-qr', 'a fresh phone starts at the QR scan');
});

test('b) `conectado` writes the flag and lands on /overview', async () => {
  const storage = fakeStorage();
  const log = fakeLog();

  const exit = await finishModeChoice(storage, 'conectado', log);

  assert.deepEqual(exit, { route: '/overview', onboardedNow: true });
  assert.equal(storage.flag(), ONBOARDED_TRUE);
  assert.equal(ONBOARDED_TRUE, 'true');
  assert.equal(await readOnboarded(storage), true);
  assert.equal(initialRouteFor(true), exit.route, 'the next cold start opens the same place');
  assert.deepEqual(
    storage.writes.map((write) => write.key),
    [ONBOARDED_STORAGE_KEY],
    'nothing else is written by this step',
  );
});

test('c) `ambos` and `local` go to the suite step and only the suite step finishes the onboarding', async () => {
  for (const mode of ['ambos', 'local']) {
    const storage = fakeStorage();
    const log = fakeLog();

    const exit = await finishModeChoice(storage, mode, log);

    assert.deepEqual(exit, { route: '/suite-install', onboardedNow: false });
    assert.equal(storage.flag(), null, `${mode} does not claim the onboarding is done`);

    const route = await finishSuiteStep(storage, log);

    assert.equal(route, '/overview', `${mode} continues into the app, not back to the QR`);
    assert.equal(storage.flag(), ONBOARDED_TRUE);
    assert.equal(await readOnboarded(storage), true);
    assert.equal(initialRouteFor(true), '/overview');
  }
});

test('d) only the exact stored `true` means onboarded', async () => {
  const cases = [
    [null, false],
    ['true', true],
    [' true ', true],
    ['false', false],
    ['TRUE', false],
    ['yes', false],
    ['1', false],
    ['{}', false],
    ['', false],
  ];

  for (const [raw, expected] of cases) {
    const storage = fakeStorage(raw === null ? {} : { [ONBOARDED_STORAGE_KEY]: raw });
    const log = fakeLog();
    assert.equal(await readOnboarded(storage, log), expected, `stored ${JSON.stringify(raw)}`);
  }
});

test('e) a corrupt value is treated as not onboarded AND logged, never thrown', async () => {
  const storage = fakeStorage({ [ONBOARDED_STORAGE_KEY]: 'quizás' });
  const log = fakeLog();

  const onboarded = await readOnboarded(storage, log);

  assert.equal(onboarded, false);
  assert.equal(initialRouteFor(onboarded), '/scan-qr', 'a corrupt flag starts at the QR scan');
  const failure = log.entries.find((entry) => entry.step === 'read-onboarded');
  assert.ok(failure, 'the corrupt value is logged honestly');
  assert.equal(failure.raw.raw, 'quizás', 'the real stored value is kept as evidence');

  // An unreadable store is the same: not onboarded, logged, no throw.
  const brokenLog = fakeLog();
  const broken = {
    async getItem() {
      throw new Error('storage roto');
    },
    async setItem() {
      throw new Error('storage roto');
    },
  };
  assert.equal(await readOnboarded(broken, brokenLog), false);
  assert.ok(brokenLog.entries.some((entry) => entry.step === 'read-onboarded'));
  assert.equal(initialRouteFor(false), '/scan-qr');
});

test('f) re-pairing clears the flag and sends the person back to the QR scan', async () => {
  const storage = fakeStorage({ [ONBOARDED_STORAGE_KEY]: ONBOARDED_TRUE });
  const log = fakeLog();
  assert.equal(await readOnboarded(storage), true);

  const route = await rePair(storage, log);

  assert.deepEqual(route, { route: '/scan-qr', cleared: true }, 'the re-pair action really returns to the QR scan');
  assert.equal(storage.flag(), ONBOARDED_FALSE);
  assert.equal(ONBOARDED_FALSE, 'false');
  assert.equal(await readOnboarded(storage), false, 'the next launch starts at the QR again');
  assert.equal(initialRouteFor(false), '/scan-qr');
  assert.equal(REPAIR_LABEL, 'Volver a emparejar', 'the Ajustes row this action backs');

  assert.equal(await clearOnboarded(storage, log), true);
  assert.equal(storage.flag(), ONBOARDED_FALSE);
});

test('g) a failing write is logged and never blocks the flow', async () => {
  const log = fakeLog();
  const broken = {
    async getItem() {
      return null;
    },
    async setItem() {
      throw new Error('disco lleno');
    },
  };

  assert.equal(await markOnboarded(broken, log), false);
  assert.equal(await clearOnboarded(broken, log), false);
  assert.ok(log.entries.some((entry) => entry.step === 'persist-onboarded'));
  assert.ok(log.entries.some((entry) => entry.step === 'clear-onboarded'));

  // The exit still happens: the person is not trapped by a broken store.
  assert.equal(await finishSuiteStep(broken, log), '/overview');
  assert.deepEqual(await finishModeChoice(broken, 'conectado', log), {
    route: '/overview',
    onboardedNow: false,
  }, 'a failed write is reported honestly, not as a stored flag');
  assert.deepEqual(await rePair(broken, log), { route: '/scan-qr', cleared: false });
});
