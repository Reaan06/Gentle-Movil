/**
 * Connection registry tests (T17, S11/S12) — `mobile/lib/connections.ts`.
 *
 * The rule: one persisted record per paired device (`host`, `port`, `user`,
 * `fingerprint`, `deviceKeyFingerprint`, `label`, `addedAt`) and one persisted
 * active id, in `gentle-movil:connections` + `gentle-movil:connections:active`.
 * The SSH password is NEVER part of a record: pairing hands it to the core and
 * the record keeps only what a key-only reconnect needs.
 *
 * Everything is pinned offline with an injected AsyncStorage double, and a bad
 * payload is repaired honestly (valid entries kept, the rest logged with
 * `{step, error, raw}`) — never silently dropped, never a crash.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  CONNECTIONS_STORAGE_KEY,
  NO_OTHER_CONNECTION_REASON,
  NO_SAVED_CONNECTION_REASON,
  activeConnection,
  addConnection,
  connectionActions,
  connectionId,
  connectionLabel,
  connectionRows,
  parseConnectionRecord,
  readActiveConnection,
  readConnections,
  recordFromPair,
  rememberPairing,
  removeConnection,
  setActiveConnection,
  shortFingerprint,
  writeConnections,
} from '../lib/connections.ts';

const HOST_FP = 'a'.repeat(64);
const HOST_FP_2 = 'b'.repeat(64);
const DEVICE_FP = 'SHA256:Zm9vYmFyYmF6cXV1eA';

/** Fake AsyncStorage: every read/write/remove is recorded. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const calls = [];
  return {
    map,
    calls,
    async getItem(key) {
      calls.push({ op: 'get', key });
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      calls.push({ op: 'set', key, value });
      map.set(key, value);
    },
    async removeItem(key) {
      calls.push({ op: 'remove', key });
      map.delete(key);
    },
    /** Parsed stored registry (or `null` when nothing was written). */
    registry() {
      const raw = map.get(CONNECTIONS_STORAGE_KEY);
      return raw === undefined ? null : JSON.parse(raw);
    },
    /** Stored active id, or `null`. */
    activeId() {
      return map.has(ACTIVE_CONNECTION_STORAGE_KEY) ? map.get(ACTIVE_CONNECTION_STORAGE_KEY) : null;
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
  };
  return log;
}

/** One valid stored record, as the registry writes it. */
function record(overrides = {}) {
  return {
    id: 'reaan@192.168.0.10:22',
    label: 'reaan@192.168.0.10',
    host: '192.168.0.10',
    port: 22,
    user: 'reaan',
    fingerprint: HOST_FP,
    deviceKeyFingerprint: DEVICE_FP,
    addedAt: '2026-11-18T12:00:00.000Z',
    ...overrides,
  };
}

test('a) the two storage keys and the record shape are exactly these', async () => {
  assert.equal(CONNECTIONS_STORAGE_KEY, 'gentle-movil:connections');
  assert.equal(ACTIVE_CONNECTION_STORAGE_KEY, 'gentle-movil:connections:active');

  const storage = fakeStorage();
  const log = fakeLog();
  const added = await addConnection(storage, record(), log);

  assert.equal(added.ok, true);
  assert.deepEqual(Object.keys(storage.registry()[0]).sort(), [
    'addedAt',
    'deviceKeyFingerprint',
    'fingerprint',
    'host',
    'id',
    'label',
    'port',
    'user',
  ]);
  assert.equal(storage.activeId(), null, 'adding a device does not silently activate it');
});

test('b) a pairing record never keeps the password, only what a key-only reconnect needs', () => {
  const pair = {
    host: '192.168.0.10',
    port: 22,
    user: 'reaan',
    fp: HOST_FP,
    pw: 'secreto-de-la-pc',
    token: 'invite-token',
    code: '1234',
  };

  const created = recordFromPair(pair, DEVICE_FP, Date.parse('2026-11-18T12:00:00.000Z'));

  assert.ok(created, 'valid pairing facts produce a record');
  assert.deepEqual(created, {
    id: 'reaan@192.168.0.10:22',
    label: 'reaan@192.168.0.10',
    host: '192.168.0.10',
    port: 22,
    user: 'reaan',
    fingerprint: HOST_FP,
    deviceKeyFingerprint: DEVICE_FP,
    addedAt: '2026-11-18T12:00:00.000Z',
  });
  const serialized = JSON.stringify(created);
  assert.ok(!serialized.includes('secreto-de-la-pc'), 'the SSH password is never stored');
  assert.ok(!serialized.includes('invite-token'), 'the one-time invite is never stored');
  assert.ok(!('pw' in created) && !('password' in created) && !('secret' in created));

  // A fingerprint shown with separators/prefix is normalized to the compact hex
  // form the reconnect compares against.
  assert.equal(
    recordFromPair({ ...pair, fp: `SHA256:${'AA:'.repeat(31)}AA` }).fingerprint,
    'a'.repeat(64),
  );

  // Strict: facts that cannot produce a usable record are refused, not guessed.
  assert.equal(recordFromPair({ ...pair, host: '' }), null);
  assert.equal(recordFromPair({ ...pair, port: 0 }), null);
  assert.equal(recordFromPair({ ...pair, user: '  ' }), null);
  assert.equal(recordFromPair({ ...pair, fp: 'no-es-una-huella' }), null);
});

test('c) identifiers, labels and short fingerprints are derived, never invented', () => {
  assert.equal(connectionId({ host: '10.0.0.2', port: 2222, user: 'pi' }), 'pi@10.0.0.2:2222');
  assert.equal(connectionLabel(record()), 'reaan@192.168.0.10');
  assert.equal(shortFingerprint(HOST_FP), 'aaaa…aaaa');
  assert.equal(shortFingerprint(''), '');
});

test('d) a valid payload round-trips through the registry', async () => {
  const storage = fakeStorage();
  const log = fakeLog();

  const first = record();
  const second = record({
    id: 'pi@10.0.0.2:2222',
    label: 'tablet-lab',
    host: '10.0.0.2',
    port: 2222,
    user: 'pi',
    fingerprint: HOST_FP_2,
  });

  await addConnection(storage, first, log);
  await addConnection(storage, second, log);

  const read = await readConnections(storage, log);

  assert.equal(read.ok, true);
  assert.deepEqual(read.records, [first, second], 'order is preserved');
  assert.equal(read.repaired, false);
});

test('e) a bad payload is repaired honestly: valid entries kept, the rest logged with raw evidence', async () => {
  const log = fakeLog();

  // 1) Not an array at all.
  const notAnArray = fakeStorage({ [CONNECTIONS_STORAGE_KEY]: '{"host":"192.168.0.10"}' });
  const empty = await readConnections(notAnArray, log);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.repaired, true);
  const notArrayFailure = log.entries.find((entry) => entry.step === 'parse-connections');
  assert.ok(notArrayFailure, 'a payload that is not a list is logged');
  assert.equal(notArrayFailure.raw.raw, '{"host":"192.168.0.10"}');

  // 2) Garbage JSON.
  const garbage = fakeStorage({ [CONNECTIONS_STORAGE_KEY]: 'no-es-json' });
  const garbageRead = await readConnections(garbage, fakeLog());
  assert.deepEqual(garbageRead.records, []);
  assert.equal(garbageRead.repaired, true);

  // 3) Mixed list: the three broken entries are dropped and logged, the good one survives.
  const mixed = fakeStorage({
    [CONNECTIONS_STORAGE_KEY]: JSON.stringify([
      record(),
      { ...record({ id: 'sin-puerto' }), port: '22' },
      { ...record({ id: 'sin-huella' }), fingerprint: 'zz' },
      { ...record({ id: 'sin-fecha' }), addedAt: 'ayer' },
    ]),
  });
  const mixedLog = fakeLog();
  const repaired = await readConnections(mixed, mixedLog);

  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.records, [record()], 'only the well-formed record survives');
  const rejected = mixedLog.entries.filter((entry) => entry.step === 'parse-connection');
  assert.equal(rejected.length, 3, 'each rejected entry is logged on its own');
  assert.equal(rejected[0].raw.index, 1);
  assert.equal(rejected[0].raw.entry.port, '22', 'the raw entry is kept as evidence');
});

test('f) a stored secret never reaches a record: it is dropped by the strict rebuild', async () => {
  const storage = fakeStorage({
    [CONNECTIONS_STORAGE_KEY]: JSON.stringify([{ ...record(), pw: 'secreto-de-la-pc' }]),
  });
  const log = fakeLog();

  const read = await readConnections(storage, log);

  assert.deepEqual(read.records, [record()]);
  assert.ok(!JSON.stringify(read.records).includes('secreto-de-la-pc'));
  assert.ok(
    log.entries.some((entry) => entry.level === 'warn' && /contraseña|password/i.test(entry.msg)),
    'a stored password is reported, not silently kept',
  );
});

test('g) an unreadable store is reported as a failure, not as "no saved connection"', async () => {
  const log = fakeLog();
  const broken = {
    async getItem() {
      throw new Error('storage roto');
    },
    async setItem() {
      throw new Error('storage roto');
    },
    async removeItem() {
      throw new Error('storage roto');
    },
  };

  const read = await readConnections(broken, log);

  assert.equal(read.ok, false);
  assert.deepEqual(read.records, []);
  assert.ok(log.entries.some((entry) => entry.step === 'read-connections'));
});

test('h) adding the same device updates it in place and keeps its original addedAt', async () => {
  const storage = fakeStorage();
  const log = fakeLog();

  await addConnection(storage, record(), log);
  const updated = await addConnection(
    storage,
    record({ label: 'mi-pc', addedAt: '2026-11-19T00:00:00.000Z' }),
    log,
  );

  assert.equal(updated.ok, true);
  assert.equal(updated.replaced, true);
  assert.equal(storage.registry().length, 1, 'the same host/port/user is one record');
  assert.equal(storage.registry()[0].label, 'mi-pc');
  assert.equal(
    storage.registry()[0].addedAt,
    '2026-11-18T12:00:00.000Z',
    'the original pairing date is not rewritten',
  );

  const second = await addConnection(
    storage,
    record({ id: 'pi@10.0.0.2:22', host: '10.0.0.2', user: 'pi' }),
    log,
  );
  assert.equal(second.replaced, false);
  assert.equal(storage.registry().length, 2);
});

test('i) removing a connection clears the active id only when it was the active one', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const first = record();
  const second = record({ id: 'pi@10.0.0.2:22', host: '10.0.0.2', user: 'pi' });
  await addConnection(storage, first, log);
  await addConnection(storage, second, log);
  await setActiveConnection(storage, second.id, log);

  const other = await removeConnection(storage, first.id, log);

  assert.equal(other.ok, true);
  assert.equal(other.removed, true);
  assert.equal(other.activeCleared, false);
  assert.equal(storage.activeId(), second.id, 'the active device is untouched');
  assert.deepEqual(storage.registry(), [second]);

  const active = await removeConnection(storage, second.id, log);

  assert.equal(active.removed, true);
  assert.equal(active.activeCleared, true);
  assert.equal(storage.activeId(), null, 'the active id is gone with its record');
  assert.deepEqual(storage.registry(), []);

  const unknown = await removeConnection(storage, 'no-existe', log);
  assert.equal(unknown.removed, false);
  assert.ok(
    log.entries.some((entry) => entry.step === 'remove-connection'),
    'removing something that is not there is logged, not pretended',
  );
});

test('j) an active id that is not in the registry is refused, never activated', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  await addConnection(storage, record(), log);

  const refused = await setActiveConnection(storage, 'no-existe', log);

  assert.equal(refused.ok, false);
  assert.equal(refused.active, null);
  assert.equal(typeof refused.reason, 'string');
  assert.equal(storage.activeId(), null);
  assert.ok(log.entries.some((entry) => entry.step === 'set-active-connection'));

  const accepted = await setActiveConnection(storage, record().id, log);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.active.id, record().id);
  assert.equal(storage.activeId(), record().id);
});

test('k) reading the active connection repairs a dangling active id', async () => {
  const storage = fakeStorage({ [ACTIVE_CONNECTION_STORAGE_KEY]: 'reaan@otra-pc:22' });
  const log = fakeLog();
  await addConnection(storage, record(), log);

  const read = await readActiveConnection(storage, log);

  assert.equal(read.ok, true);
  assert.deepEqual(read.records, [record()]);
  assert.equal(read.active, null, 'a dangling id never resolves to another device');
  assert.equal(storage.activeId(), null, 'the dangling id is cleared');
  assert.ok(log.entries.some((entry) => entry.step === 'read-active-connection'));

  // With a real id the active record is the one it names.
  await setActiveConnection(storage, record().id, log);
  const active = await readActiveConnection(storage, log);
  assert.equal(active.active.id, record().id);
  assert.equal(activeConnection(active.records, record().id).host, '192.168.0.10');
  assert.equal(activeConnection(active.records, null), null);
});

test('l) a failed write is reported, never pretended', async () => {
  const log = fakeLog();
  const broken = {
    async getItem() {
      return null;
    },
    async setItem() {
      throw new Error('disco lleno');
    },
    async removeItem() {
      throw new Error('disco lleno');
    },
  };

  assert.equal(await writeConnections(broken, [record()], log), false);
  assert.equal((await addConnection(broken, record(), log)).ok, false);
  assert.ok(log.entries.some((entry) => entry.step === 'persist-connections'));
});

test('m) the connection menu offers the three real actions and says why one is unavailable', () => {
  const active = record();

  const none = connectionActions([], null);
  assert.deepEqual(
    none.map((action) => action.id),
    ['reconnect', 'switch', 'add-device'],
  );
  assert.deepEqual(
    none.map((action) => action.label),
    ['Reconectar', 'Cambiar de conexión', 'Agregar otro dispositivo'],
  );
  assert.equal(none[0].enabled, false);
  assert.equal(none[0].reason, NO_SAVED_CONNECTION_REASON);
  assert.equal(none[1].enabled, false);
  assert.equal(none[1].reason, NO_SAVED_CONNECTION_REASON);
  assert.equal(none[2].enabled, true, 'pairing another device is always possible');
  assert.equal(none[2].reason, null);

  const one = connectionActions([active], active);
  assert.equal(one[0].enabled, true);
  assert.equal(one[0].reason, null);
  assert.equal(one[1].enabled, false);
  assert.equal(one[1].reason, NO_OTHER_CONNECTION_REASON);

  const two = connectionActions([active, record({ id: 'pi@10.0.0.2:22', host: '10.0.0.2' })], active);
  assert.ok(two.every((action) => action.enabled), 'with a second device every action works');
  assert.ok(two.every((action) => action.reason === null));
});

test('n) the menu rows mark the active device and show real host data', () => {
  const active = record();
  const other = record({ id: 'pi@10.0.0.2:22', host: '10.0.0.2', port: 2222, user: 'pi', label: 'tablet-lab' });

  const rows = connectionRows([active, other], active.id);

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, active: row.active })),
    [
      { id: active.id, active: true },
      { id: other.id, active: false },
    ],
  );
  assert.equal(rows[0].label, 'reaan@192.168.0.10');
  assert.equal(rows[0].detail, 'reaan@192.168.0.10:22 · aaaa…aaaa');
  assert.equal(rows[1].label, 'tablet-lab');
  assert.equal(rows[1].detail, 'pi@10.0.0.2:2222 · aaaa…aaaa');
});

test('o) the strict parser accepts the exact shape and nothing else', () => {
  assert.deepEqual(parseConnectionRecord(record()), record());
  assert.equal(parseConnectionRecord(null), null);
  assert.equal(parseConnectionRecord('record'), null);
  assert.equal(parseConnectionRecord(record({ id: '' })), null);
  assert.equal(parseConnectionRecord(record({ label: '' })), null);
  assert.equal(parseConnectionRecord(record({ host: '' })), null);
  assert.equal(parseConnectionRecord(record({ user: '' })), null);
  assert.equal(parseConnectionRecord(record({ fingerprint: 'abc' })), null);
  assert.equal(parseConnectionRecord(record({ addedAt: 12 })), null);
  assert.equal(parseConnectionRecord(record({ deviceKeyFingerprint: 7 })), null);
  assert.equal(
    parseConnectionRecord(record({ deviceKeyFingerprint: '' })).deviceKeyFingerprint,
    '',
    'a pairing that reported no device-key fingerprint is kept as empty, not invented',
  );
});

test('(p) a finished pairing is remembered and marked active', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const result = await rememberPairing(
    storage,
    { host: '192.168.2.9', port: 22, user: 'reaan', fp: HOST_FP, pw: 'no-se-guarda' },
    { log, now: 1_700_000_000_000 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.notEqual(result.id, null);

  const registry = storage.registry();
  assert.equal(registry.length, 1);
  assert.equal(registry[0].host, '192.168.2.9');
  assert.equal(registry[0].user, 'reaan');
  assert.equal(storage.activeId(), result.id);

  // The password never reaches storage, not even as a stray field.
  const stored = JSON.stringify(registry);
  assert.equal(stored.includes('no-se-guarda'), false);
  assert.equal(/pw|password|passphrase|secret|token/.test(stored), false);
  assert.equal(log.entries.some((entry) => entry.msg === 'connection remembered'), true);
});

test('(q) an incomplete pairing is not remembered and says why', async () => {
  const storage = fakeStorage();
  const log = fakeLog();
  const result = await rememberPairing(
    storage,
    { host: '', port: 22, user: 'reaan', fp: HOST_FP },
    { log },
  );
  assert.equal(result.ok, false);
  assert.equal(result.id, null);
  assert.match(result.reason, /no traía host/);
  assert.equal(storage.registry(), null);
  const failure = log.entries.find((entry) => entry.step === 'remember-pairing');
  assert.notEqual(failure, undefined);
});
