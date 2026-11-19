import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONBOARDED_STORAGE_KEY,
  ONBOARDED_FALSE,
  ONBOARDED_TRUE,
  APP_HOME_ROUTE,
  REPAIR_LABEL,
  bootDecision,
  clearOnboarded,
  finishModeChoice,
  finishSuiteStep,
  initialRouteFor,
  markOnboarded,
  rePair,
  readOnboarded,
} from '../lib/onboarding.ts';
import { MODE_STORAGE_KEY, parseMode, readChosenMode, readMode } from '../lib/suite.ts';

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

/**
 * Boot gate (T17, S11/S12): the entry no longer decides on the flag alone.
 *
 * S12 is literal — «cuando uno ya terminó el onboarding que no pase»: the
 * onboarding is only shown when there is NO saved connection at all. A saved
 * pairing sends the app to the home screen and to a real reconnect, with or
 * without the legacy flag; a flag without a pairing must not fake a connection.
 */
const SAVED = {
  id: 'reaan@192.168.0.10:22',
  label: 'reaan@192.168.0.10',
  host: '192.168.0.10',
  port: 22,
  user: 'reaan',
  fingerprint: 'a'.repeat(64),
  deviceKeyFingerprint: 'SHA256:Zm9vYmFyYmF6cXV1eA',
  addedAt: '2026-11-18T12:00:00.000Z',
};

test('h) boot decision table: first launch / onboarded+no connection / onboarded+connection', () => {
  const firstLaunch = bootDecision({ onboarded: false, connection: null, mode: null });
  assert.equal(firstLaunch.kind, 'onboarding');
  assert.equal(firstLaunch.route, '/scan-qr');
  assert.equal(firstLaunch.reconnect, false);
  assert.equal(firstLaunch.route, initialRouteFor(false), 'a fresh install still starts at V1');
  assert.match(firstLaunch.reason, /primer arranque/i);

  const flagOnly = bootDecision({ onboarded: true, connection: null, mode: 'conectado' });
  assert.equal(flagOnly.kind, 'onboarding');
  assert.equal(flagOnly.route, '/scan-qr', 'a flag without a saved pairing is not a connection');
  assert.equal(flagOnly.reconnect, false);
  assert.match(flagOnly.reason, /no queda ninguna conexión guardada/i);

  const onboarded = bootDecision({ onboarded: true, connection: SAVED, mode: 'conectado' });
  assert.equal(onboarded.kind, 'home');
  assert.equal(onboarded.route, '/overview', 'S12: the onboarding does not appear again');
  assert.equal(onboarded.route, APP_HOME_ROUTE);
  assert.equal(onboarded.reconnect, true, 'the home screen reconnects by itself');
  assert.equal(onboarded.connection.id, SAVED.id);
  assert.match(onboarded.reason, /reconecta/i);

  const pairedWithoutFlag = bootDecision({ onboarded: false, connection: SAVED, mode: null });
  assert.equal(pairedWithoutFlag.kind, 'home', 'a real pairing wins over a missing flag');
  assert.equal(pairedWithoutFlag.route, '/overview');
  assert.equal(pairedWithoutFlag.reconnect, true);
  assert.match(pairedWithoutFlag.reason, /flag/i);
});

/**
 * Boot gate, mode-aware (S6/S11/S12, T17 follow-up).
 *
 * The defect this pins, seen on the tablet: with no saved connection the gate
 * always routed to the SSH onboarding — even for a person who chose `local`
 * during the onboarding. Local mode needs no PC at all, so those people were
 * locked out of their own local projects by a QR screen (S12: the onboarding is
 * a once-only thing; S6: local mode is half the product).
 *
 * The rules:
 *
 * - a saved connection always wins over the mode → home + reconnect;
 * - `local` with no saved connection → home, NO reconnect, and the reason says
 *   local needs no PC and a connection can be added later from the menu;
 * - `conectado`/`ambos` with no saved connection → onboarding, existing reason;
 * - no mode chosen (`null`) with no saved connection → onboarding (local is not
 *   assumed), and the reason says exactly that.
 */
const CHOOSABLE_MODES = ['conectado', 'local', 'ambos'];

/** The two reasons the gate already said, verbatim: nothing changed for them. */
const FIRST_LAUNCH_REASON = 'primer arranque sin ninguna conexión guardada';
const PAIRING_LOST_REASON =
  'el onboarding terminó pero no queda ninguna conexión guardada: hay que emparejar de nuevo';

test('i) `local` with no saved connection goes HOME with no reconnect, never to the onboarding', () => {
  for (const onboarded of [false, true]) {
    const decision = bootDecision({ mode: 'local', onboarded, connection: null });

    assert.equal(decision.kind, 'home', `local/onboarded=${onboarded}: local mode needs no PC`);
    assert.equal(decision.route, '/overview');
    assert.equal(decision.route, APP_HOME_ROUTE);
    assert.equal(decision.reconnect, false, 'no PC means no reconnect: no fake «Reconectando»');
    assert.equal(decision.connection, null, 'there is no device to reconnect to');
    assert.match(decision.reason, /modo local/i);
    assert.match(decision.reason, /no necesita ninguna PC/i, 'the reason says why it works offline');
    assert.match(
      decision.reason,
      /menú de conexión/i,
      'the reason says a connection can be added later from the menu',
    );
    assert.doesNotMatch(decision.reason, /emparejar/i, 'nothing has to be paired for local mode');
  }
});

test('j) `conectado`/`ambos` with no saved connection still start the SSH onboarding, same reasons', () => {
  for (const mode of ['conectado', 'ambos']) {
    const first = bootDecision({ mode, onboarded: false, connection: null });
    assert.equal(first.kind, 'onboarding', `${mode}: the connected half needs a PC to pair`);
    assert.equal(first.route, '/scan-qr');
    assert.equal(first.route, initialRouteFor(false));
    assert.equal(first.reconnect, false);
    assert.equal(first.connection, null);
    assert.equal(first.reason, FIRST_LAUNCH_REASON, `${mode} keeps the reason it always had`);

    const pairingLost = bootDecision({ mode, onboarded: true, connection: null });
    assert.equal(pairingLost.kind, 'onboarding', `${mode}: a flag without a pairing is not a pairing`);
    assert.equal(pairingLost.route, '/scan-qr');
    assert.equal(pairingLost.reconnect, false);
    assert.equal(pairingLost.reason, PAIRING_LOST_REASON);
  }
});

test('k) no mode chosen never assumes local: onboarding, and the reason says so', () => {
  const first = bootDecision({ mode: null, onboarded: false, connection: null });
  assert.equal(first.kind, 'onboarding');
  assert.equal(first.route, '/scan-qr');
  assert.equal(first.reconnect, false);
  assert.match(first.reason, /primer arranque sin ninguna conexión guardada/);
  assert.match(first.reason, /no hay ningún modo elegido/i, 'the reason names the missing choice');
  assert.match(first.reason, /no podemos asumir el modo local/i, 'local is not guessed');

  const pairingLost = bootDecision({ mode: null, onboarded: true, connection: null });
  assert.equal(pairingLost.kind, 'onboarding');
  assert.equal(pairingLost.route, '/scan-qr');
  assert.equal(pairingLost.reconnect, false);
  assert.match(pairingLost.reason, /no queda ninguna conexión guardada/i);
  assert.match(pairingLost.reason, /no hay ningún modo elegido/i);
  assert.match(pairingLost.reason, /no podemos asumir el modo local/i);
  assert.doesNotMatch(pairingLost.reason, /no necesita ninguna PC/i, 'local is not assumed');
});

test('l) a saved connection always wins over the mode: home + reconnect for every mode', () => {
  for (const mode of [null, ...CHOOSABLE_MODES]) {
    for (const onboarded of [false, true]) {
      const decision = bootDecision({ mode, onboarded, connection: SAVED });

      assert.equal(decision.kind, 'home', `mode=${mode}/onboarded=${onboarded}`);
      assert.equal(decision.route, '/overview');
      assert.equal(decision.reconnect, true, 'a real pairing reconnects by itself (S12)');
      assert.equal(decision.connection.id, SAVED.id);
      assert.match(decision.reason, /reconecta/i);
    }
  }
});

test('m) saved devices with none active stay home for every mode, never the onboarding', () => {
  for (const mode of [null, ...CHOOSABLE_MODES]) {
    const decision = bootDecision({ mode, onboarded: true, connection: null, saved: 2 });

    assert.equal(decision.kind, 'home', `mode=${mode}`);
    assert.equal(decision.route, '/overview');
    assert.equal(decision.reconnect, false, 'no active device: nothing to reconnect to');
    assert.equal(decision.connection, null);
    assert.match(decision.reason, /ninguna está marcada como activa/i);
  }
});

test('n) the whole mode × connection × onboarded table, row by row', () => {
  for (const mode of [null, ...CHOOSABLE_MODES]) {
    for (const onboarded of [false, true]) {
      for (const connection of [null, SAVED]) {
        const decision = bootDecision({ mode, onboarded, connection });
        const tag = `mode=${mode}/onboarded=${onboarded}/connection=${
          connection === null ? 'none' : 'saved'
        }`;

        if (connection !== null) {
          // A saved connection always wins over the mode.
          assert.equal(decision.kind, 'home', tag);
          assert.equal(decision.route, '/overview', tag);
          assert.equal(decision.reconnect, true, tag);
          assert.equal(decision.connection.id, SAVED.id, tag);
          assert.match(decision.reason, /reconecta/i, tag);
          continue;
        }

        assert.equal(decision.connection, null, `${tag}: nothing to reconnect to`);
        assert.equal(decision.reconnect, false, `${tag}: no reconnect without a saved device`);

        if (mode === 'local') {
          // S6: local mode needs no PC — never the QR onboarding.
          assert.equal(decision.kind, 'home', tag);
          assert.equal(decision.route, '/overview', tag);
          assert.match(decision.reason, /modo local/i, tag);
          assert.match(decision.reason, /menú de conexión/i, tag);
          continue;
        }

        // `conectado`, `ambos` and "no choice" all need a real pairing.
        assert.equal(decision.kind, 'onboarding', tag);
        assert.equal(decision.route, '/scan-qr', tag);
        assert.equal(
          decision.reason.startsWith(onboarded ? PAIRING_LOST_REASON : FIRST_LAUNCH_REASON),
          true,
          `${tag}: keeps the reason it always had`,
        );
        if (mode === null) {
          assert.match(decision.reason, /no podemos asumir el modo local/i, tag);
        } else {
          assert.doesNotMatch(decision.reason, /no podemos asumir/i, tag);
        }
      }
    }
  }
});

/**
 * The mode the entry reads (T17 follow-up): `app/index.tsx` reads
 * `gentle-movil:mode` once with the other boot inputs, through the strict
 * `readChosenMode`. Unlike `readMode` (which falls back to `ambos` for the
 * provisioning flow), a phone that never chose a mode has to reach the gate as
 * `null`, so the gate can say out loud that it will not assume local.
 */
test('o) `readChosenMode` is strict: the three real modes, or null when nothing was chosen', async () => {
  for (const mode of CHOOSABLE_MODES) {
    assert.equal(await readChosenMode(fakeStorage({ [MODE_STORAGE_KEY]: mode })), mode);
  }

  assert.equal(await readChosenMode(fakeStorage()), null, 'a fresh install has chosen nothing');

  for (const raw of ['', 'conectado ', 'LOCAL', 'ambos\n', 'otro', '{}']) {
    const log = fakeLog();
    assert.equal(
      await readChosenMode(fakeStorage({ [MODE_STORAGE_KEY]: raw }), log),
      null,
      `stored ${JSON.stringify(raw)} is not a mode`,
    );
    assert.ok(
      log.entries.some((entry) => entry.step === 'read-chosen-mode'),
      `stored ${JSON.stringify(raw)} is refused and logged`,
    );
    assert.equal(
      log.entries.find((entry) => entry.step === 'read-chosen-mode').raw.raw,
      raw,
      'the real stored value is kept as evidence',
    );
  }

  // The two readers do not change the other: V4's fallback stays `ambos`.
  assert.equal(await readMode(fakeStorage()), 'ambos', 'provisioning keeps its documented default');
  assert.equal(parseMode(null), 'ambos');
  assert.equal(parseMode('local'), 'local');

  // An unreadable store is `null` too (logged, never thrown): the gate then
  // says the choice is missing instead of assuming one.
  const brokenLog = fakeLog();
  const broken = {
    async getItem() {
      throw new Error('storage roto');
    },
    async setItem() {
      throw new Error('storage roto');
    },
  };
  assert.equal(await readChosenMode(broken, brokenLog), null);
  assert.ok(brokenLog.entries.some((entry) => entry.step === 'read-chosen-mode'));

  // And the value the entry hands the gate really is what the gate reads.
  const local = bootDecision({
    mode: await readChosenMode(fakeStorage({ [MODE_STORAGE_KEY]: 'local' })),
    onboarded: true,
    connection: null,
  });
  assert.equal(local.kind, 'home', 'a local phone from storage never sees the QR flow');
  assert.equal(local.reconnect, false);
});
