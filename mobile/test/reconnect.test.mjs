/**
 * Reconnect tests (T17, S11/S12) — `mobile/lib/reconnect.ts`.
 *
 * The rule: with a saved connection the app reconnects by itself, key-only
 * (`sshConnectWithDeviceKey` → detect the extension → open the tunnel → store
 * it), skips `register` because the key is already in `authorized_keys`, and
 * reports a typed outcome. Nothing here can invent a success: no tunnel, no
 * channel and no session are all typed failures carrying the real step.
 *
 * Everything is pinned offline: the frozen core surface and the
 * `gc_provision_step` bridge are injected, so no device and no PC are needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindCoreNativeBridge } from '../modules/gentle-core/src/abi.ts';

import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  CONNECTIONS_STORAGE_KEY,
  addConnection,
  recordFromPair,
  setActiveConnection,
} from '../lib/connections.ts';
import {
  HOST_FINGERPRINT_MISSING_COPY,
  RECONNECTING_COPY,
  defaultReconnectCore,
  reconnectFailureCopy,
  reconnectingCopy,
  reconnectFromSaved,
  resolveReconnectCore,
} from '../lib/reconnect.ts';

const HOST_FP = 'a'.repeat(64);
const DEVICE_FP = 'SHA256:Zm9vYmFyYmF6cXV1eA';

const PAIR = {
  host: '192.168.0.10',
  port: 22,
  user: 'reaan',
  fp: HOST_FP,
  pw: 'secreto-de-la-pc',
};

/** Fake AsyncStorage with the registry already holding one paired device. */
async function storageWithConnection(log) {
  const map = new Map();
  const storage = {
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
  const record = recordFromPair(PAIR, DEVICE_FP, Date.parse('2026-11-18T12:00:00.000Z'));
  await addConnection(storage, record, log);
  await setActiveConnection(storage, record.id, log);
  return { storage, record, map };
}

/** Fake scoped logger (`{step, error, raw}` is the shape under test). */
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
  };
  return log;
}

/** One fake `gc_provision_step` bridge that answers per step. */
function fakeBridge(outcomes = {}) {
  const calls = [];
  const call = async (fn, payloadJson) => {
    const payload = JSON.parse(payloadJson);
    calls.push({ fn, payload });
    const answer = outcomes[payload.step] ?? { ok: true, result: {} };
    if (answer.fail !== undefined) {
      return JSON.stringify({ ok: false, error: answer.fail, raw: answer.raw ?? null });
    }
    return JSON.stringify({ ok: true, result: answer.result });
  };
  return { call, calls };
}

/** The default GOOD tunnel answer of the fake bridge. */
const GOOD_FORWARDS = {
  ok: true,
  result: {
    forwards: [
      { host: '127.0.0.1', port: 43721, channel_id: 7 },
      { host: '127.0.0.1', port: 43722, channel_id: 8 },
    ],
  },
};

/** A device-key/call/connect triple that always works. */
function happyDeps(extra = {}) {
  const bridge = fakeBridge({ detect: { ok: true, result: { ports: [43721, 43722] } }, tunnel: GOOD_FORWARDS });
  const connected = [];
  const stored = [];
  const closed = [];
  return {
    bridge,
    connected,
    stored,
    closed,
    deps: {
      call: bridge.call,
      deviceKeyEnsure: async () => ({ publicHex: 'ab'.repeat(32), fingerprint: DEVICE_FP }),
      sshConnectWithDeviceKey: async (input) => {
        connected.push(input);
        // The pinned connect answer always names the host key the handshake verified
        // (SEC-013); `lib/reconnect.ts` requires it before storing a tunnel.
        return { sessionId: '42', fingerprint: HOST_FP };
      },
      sshClose: async (sessionId) => {
        closed.push(sessionId);
        return { closed: true };
      },
      setTunnel: (tunnel) => stored.push(tunnel),
      ...extra,
    },
  };
}

test('a) with no saved connection nothing is attempted and the outcome says so', async () => {
  const log = fakeLog();
  const storage = {
    async getItem() {
      return null;
    },
    async setItem() {},
    async removeItem() {},
  };
  const { deps, connected, bridge, stored } = happyDeps({ storage, log });

  const outcome = await reconnectFromSaved(deps);

  assert.deepEqual(outcome, { kind: 'no-saved-connection' });
  assert.equal(connected.length, 0, 'no SSH session is opened without a saved pairing');
  assert.equal(bridge.calls.length, 0);
  assert.equal(stored.length, 0, 'no tunnel is stored without a tunnel');
});

test('b) a saved connection reconnects key-only: device key → connect → detect → tunnel', async () => {
  const log = fakeLog();
  const { storage, record } = await storageWithConnection(log);
  const { deps, connected, stored, bridge } = happyDeps({ storage, log });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'connected');
  assert.equal(outcome.record.id, record.id);
  assert.equal(outcome.sessionId, '42');

  // The connect seam receives the record's routing facts and its pinned host key.
  assert.deepEqual(connected, [
    { host: '192.168.0.10', port: 22, user: 'reaan', expectedFingerprint: HOST_FP },
  ]);

  // `register` is skipped: the key is already in authorized_keys (S4).
  assert.deepEqual(
    bridge.calls.map((entry) => entry.payload.step),
    ['detect', 'tunnel'],
    'only detect and tunnel run on a reconnect',
  );
  assert.ok(
    !bridge.calls.some((entry) => entry.payload.step === 'register'),
    'a reconnect never re-registers the device key',
  );
  for (const entry of bridge.calls) {
    assert.equal(entry.fn, 'gc_provision_step');
    assert.equal(entry.payload.sessionId, 42, 'the native session id rides in the payload');
  }
  // `detect` really runs the loopback probe the pairing flow uses (same helper).
  const detect = bridge.calls[0].payload;
  assert.deepEqual(detect.ports, [43721, 43722]);
  assert.match(detect.command, /probe_port\(\)/);

  // The tunnel handles are kept: real channels, the HTTP one first.
  assert.deepEqual(outcome.channels, [
    { host: '127.0.0.1', port: 43721, channelId: 7 },
    { host: '127.0.0.1', port: 43722, channelId: 8 },
  ]);
  assert.equal(stored.length, 1, 'the app keeps the tunnel it really opened');
  assert.deepEqual(stored[0], {
    sessionId: '42',
    host: '192.168.0.10',
    httpChannel: { host: '127.0.0.1', port: 43721, channelId: 7 },
  });
  assert.ok(
    log.entries.some((entry) => entry.level === 'info' && /reconectado/i.test(entry.msg)),
    'a real reconnect is logged',
  );
});

test('c) a phone without the paired device key is `no-device-key`, not a doomed SSH attempt', async () => {
  const log = fakeLog();
  const { storage, record } = await storageWithConnection(log);
  const { deps, connected } = happyDeps({
    storage,
    log,
    deviceKeyEnsure: async () => ({ publicHex: 'cd'.repeat(32), fingerprint: 'SHA256:otra-llave' }),
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'no-device-key');
  assert.match(outcome.message, /llave/i);
  assert.equal(outcome.raw.saved, DEVICE_FP);
  assert.equal(outcome.raw.current, 'SHA256:otra-llave');
  assert.equal(connected.length, 0, 'an SSH session with a key the PC never accepted is not opened');
  assert.ok(log.entries.some((entry) => entry.step === 'device-key'));
  assert.equal(record.deviceKeyFingerprint, DEVICE_FP);
});

test('d) a core that cannot read the device key reports `no-device-key` with the real reason', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps } = happyDeps({
    storage,
    log,
    deviceKeyEnsure: async () => {
      throw { kind: 'DeviceKeyUnavailable', message: 'no hay Keystore en esta build' };
    },
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'no-device-key');
  assert.equal(outcome.message, 'no hay Keystore en esta build');
  assert.equal(outcome.raw.kind, 'DeviceKeyUnavailable');
});

test('e) a host key that does not match the stored fingerprint is `fingerprint-mismatch`', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps, stored } = happyDeps({
    storage,
    log,
    sshConnectWithDeviceKey: async () => {
      throw { kind: 'FingerprintMismatch', message: 'la huella del host cambió', observed: 'b'.repeat(64) };
    },
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'fingerprint-mismatch');
  assert.equal(outcome.expected, HOST_FP);
  assert.equal(outcome.observed, 'b'.repeat(64));
  assert.equal(outcome.message, 'la huella del host cambió');
  assert.equal(stored.length, 0);
  assert.ok(log.entries.some((entry) => entry.level === 'error'));
});

test('f) an unreachable PC is `offline` at the connect step, with the core reason verbatim', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps } = happyDeps({
    storage,
    log,
    sshConnectWithDeviceKey: async () => {
      throw { kind: 'Offline', message: 'No se pudo llegar a 192.168.0.10:22.' };
    },
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'offline');
  assert.equal(outcome.step, 'connect');
  assert.equal(outcome.message, 'No se pudo llegar a 192.168.0.10:22.');
  assert.equal(outcome.raw.kind, 'Offline');
});

test('g) a failing detect step keeps its own step and closes the session it opened', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    call: fakeBridge({
      detect: { fail: { kind: 'Exec', message: 'nc/curl no disponibles' }, raw: 'exit=1' },
    }).call,
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'detect');
  assert.equal(outcome.message, 'nc/curl no disponibles');
  assert.equal(outcome.raw.raw, 'exit=1');
  assert.equal(stored.length, 0, 'no tunnel is kept when the extension was never found');
  assert.deepEqual(closed, ['42'], 'the session is closed instead of leaking');
});

test('h) a tunnel that returns no channel is a typed failure, never a fake connection', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    call: fakeBridge({ detect: { ok: true, result: {} }, tunnel: { ok: true, result: { forwards: [] } } }).call,
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'tunnel');
  assert.equal(outcome.message, 'El túnel no devolvió ningún canal abierto.');
  assert.equal(stored.length, 0);
  assert.deepEqual(closed, ['42']);
});

test('i) a tunnel without the HTTP channel is refused by name (43721), not silently kept', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    call: fakeBridge({
      detect: { ok: true, result: {} },
      tunnel: { ok: true, result: { forwards: [{ host: '127.0.0.1', port: 43722, channel_id: 8 }] } },
    }).call,
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'tunnel');
  assert.match(outcome.message, /43721/);
  assert.equal(stored.length, 0);
  assert.deepEqual(closed, ['42']);
});

test('j) a damaged registry is a failure, never "no saved connection" (which would replay the onboarding)', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  // Corrupt the only saved record, exactly like an interrupted write would.
  const active = JSON.parse(await storage.getItem(CONNECTIONS_STORAGE_KEY));
  active[0].fingerprint = 'no-es-una-huella';
  await storage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(active));
  await storage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, active[0].id);
  const { deps, connected } = happyDeps({ storage, log });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'storage');
  assert.match(outcome.message, /dañadas/i);
  assert.equal(connected.length, 0, 'nothing is dialled from a registry that cannot be read');
  assert.ok(
    log.entries.some((entry) => entry.step === 'parse-connection'),
    'the damaged entry is logged with its raw evidence',
  );
});

test('k) an unreadable registry is a failure, not "no saved connection"', async () => {
  const log = fakeLog();
  const storage = {
    async getItem() {
      throw new Error('storage roto');
    },
    async setItem() {},
    async removeItem() {},
  };
  const { deps, connected } = happyDeps({ storage, log });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'storage');
  assert.equal(connected.length, 0);
  assert.ok(log.entries.some((entry) => entry.step === 'read-connections'));
});

test('l) an unexpected throw from the core is a typed failure, never a crash', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps } = happyDeps({
    storage,
    log,
    sshConnectWithDeviceKey: async () => {
      throw new Error('boom');
    },
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'connect');
  assert.equal(outcome.message, 'boom');
});

test('m) the boot copy names the real host and gives a real retry', () => {
  assert.equal(reconnectingCopy('192.168.0.10'), 'Reconectando con 192.168.0.10…');
  assert.equal(RECONNECTING_COPY, 'Reconectando con ');
  assert.equal(reconnectingCopy(''), 'Reconectando con tu-pc…');

  const offline = reconnectFailureCopy({
    kind: 'offline',
    step: 'connect',
    message: 'No se pudo llegar a 192.168.0.10:22.',
    raw: null,
    host: '192.168.0.10',
  });
  assert.equal(offline.retryEnabled, true);
  assert.equal(offline.retryLabel, 'Reintentar');
  assert.equal(offline.step, 'conectar');
  assert.match(offline.text, /192\.168\.0\.10:22/);

  const detect = reconnectFailureCopy({
    kind: 'failed',
    step: 'detect',
    message: 'nc/curl no disponibles',
    raw: null,
    host: '192.168.0.10',
  });
  assert.equal(detect.retryEnabled, true, 'a failed step is retryable');
  assert.match(detect.title, /detección/i);
  assert.match(detect.text, /nc\/curl no disponibles/);

  const mismatch = reconnectFailureCopy({
    kind: 'fingerprint-mismatch',
    expected: HOST_FP,
    observed: 'b'.repeat(64),
    message: 'la huella del host cambió',
    raw: null,
    host: '192.168.0.10',
  });
  assert.match(mismatch.title, /huella/i);
  assert.ok(mismatch.text.includes(HOST_FP), 'the pinned fingerprint is shown');
  assert.ok(mismatch.text.includes('b'.repeat(64)), 'the observed fingerprint is shown');
  assert.equal(mismatch.retryEnabled, false, 'retrying the same key would fail again');

  const noKey = reconnectFailureCopy({
    kind: 'no-device-key',
    message: 'no hay Keystore en esta build',
    raw: null,
    host: '192.168.0.10',
  });
  assert.match(noKey.title, /llave/i);
  assert.equal(noKey.retryEnabled, false);

  const none = reconnectFailureCopy({ kind: 'no-saved-connection' });
  assert.match(none.title, /conexión guardada/i);
  assert.equal(none.retryEnabled, false);
});

test('n) a reconnect picks the device the registry marks active', async () => {
  const log = fakeLog();
  const { storage, map } = await storageWithConnection(log);
  const second = recordFromPair(
    { host: '10.0.0.2', port: 2222, user: 'pi', fp: 'b'.repeat(64) },
    DEVICE_FP,
  );
  await addConnection(storage, second, log);
  await setActiveConnection(storage, second.id, log);
  const { deps, connected } = happyDeps({
    storage,
    log,
    deviceKeyEnsure: async () => ({ publicHex: 'ab'.repeat(32), fingerprint: DEVICE_FP }),
    sshConnectWithDeviceKey: async (input) => {
      connected.push(input);
      throw { kind: 'Offline', message: 'sin red' };
    },
  });

  await reconnectFromSaved(deps);

  assert.deepEqual(connected, [
    { host: '10.0.0.2', port: 2222, user: 'pi', expectedFingerprint: 'b'.repeat(64) },
  ]);
  assert.equal(map.get(ACTIVE_CONNECTION_STORAGE_KEY), second.id);
});

test('o) without the native core the default seam names the real root, never a faked session', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const bridge = fakeBridge({});

  // No core seam injected and no native bridge bound: this build has the ABI layer but not
  // `libmobile_core.so`, so the ABI layer itself answers `CoreUnavailable` naming it — the
  // dev stub of `lib/core.ts` is never asked (T17 hardware defect).
  bindCoreNativeBridge(null);
  const outcome = await reconnectFromSaved({ storage, log, call: bridge.call });

  assert.equal(outcome.kind, 'no-device-key');
  assert.equal(outcome.raw.kind, 'CoreUnavailable', 'the ABI layer answered, not the dev stub');
  assert.match(outcome.message, /libmobile_core\.so/, 'the real cause is named');
  assert.match(outcome.message, /deviceKeyEnsure/, 'and so is the call that needed it');
  assert.equal(outcome.raw.cause, 'native-core-missing');
  assert.equal(bridge.calls.length, 0, 'no provision step runs without the device key');
});

/* ------------------------------------------------------------------ *
 * (t) the resolved surface is the ABI layer, never the throwing stub
 * ------------------------------------------------------------------ */

test('t) defaultReconnectCore is the ABI layer, not the stub of lib/core.ts', async () => {
  bindCoreNativeBridge(null);
  const unbound = defaultReconnectCore();
  assert.notEqual(unbound, null, 'this build exposes the three frozen members');

  // The unbound ABI layer answers its own typed error naming the missing library. The dev
  // stub of `lib/core.ts` answers `CoreUnavailableError` ("… which is not compiled into this
  // build"), so the two are told apart without reading any internals.
  await assert.rejects(
    () => unbound.deviceKeyEnsure(),
    (error) => {
      assert.equal(error.name, 'CoreCallError', 'the dev stub answers `CoreUnavailableError`');
      assert.equal(error.kind, 'CoreUnavailable');
      assert.match(error.message, /libmobile_core\.so/);
      return true;
    },
  );
  await assert.rejects(
    () => unbound.sshClose('42'),
    (error) => error.name === 'CoreCallError' && error.kind === 'CoreUnavailable',
  );

  // And bound: the resolved surface really is the module the Kotlin bridge feeds.
  const trace = [];
  const payloads = [];
  bindCoreNativeBridge(fakeNativeBridge(trace, payloads));
  try {
    const surface = defaultReconnectCore();
    const info = await surface.deviceKeyEnsure();
    assert.deepEqual(info, { publicHex: 'ab'.repeat(32), fingerprint: DEVICE_FP });
    assert.deepEqual(trace, ['device-key'], 'the ABI layer drove the native bridge');
    assert.deepEqual(payloads, [{}]);
  } finally {
    bindCoreNativeBridge(null);
  }
});

test('t) resolveReconnectCore only accepts a complete surface and keeps its receiver', async () => {
  assert.equal(resolveReconnectCore(null), null);
  assert.equal(resolveReconnectCore({}), null);
  assert.equal(
    resolveReconnectCore({ deviceKeyEnsure: async () => ({}) }),
    null,
    'a partial surface is not a surface',
  );

  const candidate = {
    marker: 'real-receiver',
    async deviceKeyEnsure() {
      return { publicHex: 'ab'.repeat(32), fingerprint: this.marker };
    },
    async sshConnectWithDeviceKey() {
      return { sessionId: '7', fingerprint: HOST_FP };
    },
    async sshClose() {
      return { kind: 'closed', sessionId: '7' };
    },
  };
  const surface = resolveReconnectCore(candidate);
  assert.notEqual(surface, null);
  assert.equal((await surface.deviceKeyEnsure()).fingerprint, 'real-receiver', 'methods keep their `this`');
});

/* ------------------------------------------------------------------ *
 * (u) "no surface" is said only when the surface is really absent
 * ------------------------------------------------------------------ */

test('u) a build without the frozen members says so, and blames no missing native core', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const bridge = fakeBridge({});

  // `coreSurface: null` is the caller stating what is true: this JS build has no members at
  // all. That is the only case allowed to answer the surface-missing kind.
  const outcome = await reconnectFromSaved({
    storage,
    log,
    call: bridge.call,
    coreSurface: null,
  });

  assert.equal(outcome.kind, 'no-device-key');
  assert.equal(outcome.raw.kind, 'Unavailable');
  assert.equal(outcome.raw.cause, 'surface-missing');
  assert.match(outcome.message, /deviceKeyEnsure/);
  assert.doesNotMatch(
    outcome.message,
    /libmobile_core/,
    'the native core is not blamed when the JS surface is what is missing',
  );
  assert.equal(bridge.calls.length, 0);
});

test('p) a connect answer without a host fingerprint is `fingerprint-mismatch`, never `connected`', async () => {
  // SEC-013: the core used to answer `ok:true` with `result.fingerprint` missing. A client
  // that only looked at `ok` thought it had a pinned session. Here it cannot: the answer
  // shows no fingerprint, so no tunnel is kept and the session it did open is closed.
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    sshConnectWithDeviceKey: async () => ({ sessionId: '42' }),
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'fingerprint-mismatch');
  assert.equal(outcome.step, 'connect');
  assert.equal(outcome.expected, HOST_FP);
  assert.equal(outcome.observed, null, 'nothing was presented, and that is what it says');
  assert.equal(outcome.message, HOST_FINGERPRINT_MISSING_COPY);
  assert.equal(outcome.raw.kind, 'MissingFingerprint');
  assert.equal(stored.length, 0, 'no tunnel is stored for a session nobody pinned');
  assert.deepEqual(closed, ['42'], 'the session it did open is closed instead of leaked');

  // What the person sees: the pinned key, no observed key, and no retry that cannot work.
  const copy = reconnectFailureCopy(outcome);
  // The title says the fact that happened: nothing was presented, rather than "they differ".
  assert.equal(copy.title, 'El host no presentó su huella');
  assert.ok(copy.text.includes(HOST_FP));
  assert.match(copy.text, /ninguna huella/);
  assert.equal(copy.retryEnabled, false);
});

test('q) a connect answer with a different host fingerprint is `fingerprint-mismatch`', async () => {
  // The pin is enforced inside the core handshake; a core build that reported another key
  // after authenticating must never be read as the pinned session either.
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    sshConnectWithDeviceKey: async () => ({ sessionId: '42', fingerprint: 'b'.repeat(64) }),
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'fingerprint-mismatch');
  assert.equal(outcome.step, 'connect');
  assert.equal(outcome.expected, HOST_FP);
  assert.equal(outcome.observed, 'b'.repeat(64));
  assert.equal(outcome.raw.kind, 'FingerprintMismatch');
  assert.equal(stored.length, 0);
  assert.deepEqual(closed, ['42']);
});

test('r) the core’s own fingerprint-less refusal maps to `fingerprint-mismatch`', async () => {
  // The real hardened core (`cabi.rs` session_answer, SEC-013) answers an `ssh` error and
  // closes the unverified session itself, so there is no handle left to close here.
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const coreMessage =
    'ssh: the handshake reported no usable host key fingerprint, so the unverified session was closed instead of being handed out';
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    sshConnectWithDeviceKey: async () => {
      throw { kind: 'ssh', message: coreMessage };
    },
  });

  const outcome = await reconnectFromSaved(deps);

  assert.equal(outcome.kind, 'fingerprint-mismatch');
  assert.equal(outcome.step, 'connect');
  assert.equal(outcome.expected, HOST_FP);
  assert.equal(outcome.observed, null);
  assert.equal(outcome.message, HOST_FINGERPRINT_MISSING_COPY);
  assert.equal(outcome.raw.kind, 'ssh');
  assert.equal(stored.length, 0);
  assert.deepEqual(closed, [], 'the core already closed it: nothing is closed twice');
  // The core’s own sentence is kept in the log, not thrown away.
  assert.ok(
    log.entries.some((entry) => entry.level === 'error' && entry.error?.message === coreMessage),
    'the core reason is logged verbatim',
  );
});

test('s) a close that reports “removed but not confirmed” is logged and does not mask the real failure', async () => {
  const log = fakeLog();
  const { storage } = await storageWithConnection(log);
  const closeMessage =
    'ssh: session 42 was removed but the transport still reports an open connection: the teardown did not reach the host';
  const { deps, stored, closed } = happyDeps({
    storage,
    log,
    call: fakeBridge({
      detect: { fail: { kind: 'Exec', message: 'nc/curl no disponibles' }, raw: 'exit=1' },
    }).call,
    sshClose: async (sessionId) => {
      closed.push(sessionId);
      return {
        kind: 'removed-unconfirmed',
        sessionId,
        message: closeMessage,
        raw: { kind: 'ssh', message: closeMessage },
      };
    },
  });

  const outcome = await reconnectFromSaved(deps);

  // The failure the person needs stays exactly the one that stopped the reconnect.
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.step, 'detect');
  assert.equal(outcome.message, 'nc/curl no disponibles');
  assert.equal(outcome.raw.raw, 'exit=1');
  assert.equal(stored.length, 0);
  assert.deepEqual(closed, ['42'], 'the close really was attempted');

  // The teardown cause is logged with the real handle and the core’s sentence.
  const closeEntry = log.entries.find((entry) => entry.step === 'connect' && entry.raw?.sessionId === '42');
  assert.ok(closeEntry, 'the unconfirmed teardown is in the log');
  assert.equal(closeEntry.error.kind, 'CloseUnconfirmed');
  assert.equal(closeEntry.error.message, closeMessage);
  assert.equal(closeEntry.raw.reason, 'el handle se liberó pero el transporte no confirmó el cierre');
});

/* ------------------------------------------------------------------ *
 * (v) a real device: the default surface is the ABI layer
 * ------------------------------------------------------------------ */

/** Fake `CoreNativeBridge` of `modules/gentle-core/src/abi.ts`, with its JSON envelopes. */
function fakeNativeBridge(trace, payloads) {
  const record = (step) => (payloadJson) => {
    trace.push(step);
    payloads.push(JSON.parse(payloadJson));
  };
  const ensure = record('device-key');
  const connect = record('connect');
  const close = record('close');
  return {
    async deviceKeyEnsure(payloadJson) {
      ensure(payloadJson);
      return JSON.stringify({
        ok: true,
        result: { publicHex: 'ab'.repeat(32), fingerprint: DEVICE_FP },
      });
    },
    async sshConnectWithDeviceKey(payloadJson) {
      connect(payloadJson);
      return JSON.stringify({ ok: true, result: { sessionId: 42, fingerprint: HOST_FP } });
    },
    async sshClose(payloadJson) {
      close(payloadJson);
      return JSON.stringify({ ok: true, result: { closed: true } });
    },
    async fsList() {
      return JSON.stringify({ ok: false, error: { kind: 'Unsupported', message: 'sin fs' } });
    },
    async fsRead() {
      return JSON.stringify({ ok: false, error: { kind: 'Unsupported', message: 'sin fs' } });
    },
  };
}

test('v) a bound native core reconnects through the default surface, in step order', async () => {
  // The device this defect was found on: the ABI layer and the Kotlin module exist. No core
  // seam is injected here, so the module has to resolve the *real* surface by itself —
  // resolving the legacy `core` binding would answer the throwing stub's `Unavailable`.
  const log = fakeLog();
  const { storage, record } = await storageWithConnection(log);
  const trace = [];
  const payloads = [];
  const bridge = fakeBridge({
    detect: { ok: true, result: { ports: [43721, 43722] } },
    tunnel: GOOD_FORWARDS,
  });
  bindCoreNativeBridge(fakeNativeBridge(trace, payloads));
  try {
    const outcome = await reconnectFromSaved({
      storage,
      log,
      call: (fn, payloadJson) => {
        trace.push(JSON.parse(payloadJson).step);
        return bridge.call(fn, payloadJson);
      },
      setTunnel: (tunnel) => trace.push(`store:${tunnel.sessionId}`),
    });

    assert.equal(outcome.kind, 'connected', 'the real ABI surface connects, it does not refuse');
    assert.equal(outcome.sessionId, '42');
    assert.equal(outcome.record.id, record.id);

    // Same step order as any other reconnect; `register` still skipped.
    assert.deepEqual(trace, ['device-key', 'connect', 'detect', 'tunnel', 'store:42']);
    assert.deepEqual(
      bridge.calls.map((entry) => entry.payload.step),
      ['detect', 'tunnel'],
      'a reconnect never re-registers the device key',
    );

    // Every call reached the core through the ABI layer, with the frozen payload shapes.
    assert.deepEqual(payloads[0], {}, 'deviceKeyEnsure takes no argument');
    assert.deepEqual(payloads[1], {
      host: '192.168.0.10',
      port: 22,
      user: 'reaan',
      expectedFp: HOST_FP,
    });
    assert.deepEqual(
      outcome.channels.map((channel) => channel.port),
      [43721, 43722],
    );
  } finally {
    bindCoreNativeBridge(null);
  }
});
