/**
 * V20 global connection-state tests (T7g) — the states come from the REAL
 * tunnel and bridge, so every case here speaks the real HTTP/1.1 wire format
 * through a fake channel (same helpers as `mobile/test/bridge.test.mjs`) and
 * pins that:
 *
 * - no tunnel → `offline` with the reconnect copy and a pending reconnect;
 * - `/api/health` identity → `live` with the identity copy (proto + version);
 * - a proto mismatch → `incompatible` carrying BOTH protos in the copy;
 * - `401`/`403` → `unauthorized`, including a non-JSON 401 body;
 * - a timeout with a previous good answer → `stale` with the minutes;
 * - a timeout with nothing good before → `offline`, never a fake `live`;
 * - the retry descriptor of a reconnect is honestly `pending: true`;
 * - every status has non-empty es-AR copy (the QA gallery renders all of them);
 * - one check performs exactly ONE `/api/health` request (no polling loop).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Encode } from '../lib/core.ts';
import {
  APP_PROTO,
  CONNECTION_STATUSES,
  checkConnection,
  connectionCopy,
  deriveConnection,
  evidenceLine,
  initialConnection,
  parseHealthIdentity,
  previewConnection,
  retryIntent,
  staleMinutes,
} from '../lib/connection.ts';

/** Fixed clock so every relative copy is deterministic. */
const NOW = Date.parse('2026-11-18T15:20:00Z');

const OK_WIRE = (body) =>
  utf8Encode(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  );

const IDENTITY = {
  app: 'gentle-shell',
  bridge: 'gentle-movil',
  proto: APP_PROTO,
  version: '0.5.9',
};

/** Scripted channel: answers each read with the queued chunks, then eof. */
function scriptedChannel(chunks) {
  const log = [];
  let index = 0;
  return {
    log,
    async write(payload) {
      log.push(['write', payload.length]);
      return payload.length;
    },
    async read() {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        return { bytes: chunk instanceof Uint8Array ? chunk : utf8Encode(chunk), eof: false };
      }
      log.push(['read-eof']);
      return { bytes: new Uint8Array(), eof: true };
    },
    async close() {},
  };
}

/** A channel that never answers: the read window is what ends the call. */
function silentChannel() {
  return {
    writes: 0,
    async write(payload) {
      this.writes += 1;
      return payload.length;
    },
    read: () =>
      new Promise((resolve) => setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 100)),
    async close() {},
  };
}

/** Failure sink that keeps what the module logged (`{step, error, raw}`). */
function recordingLogger() {
  const entries = [];
  return {
    entries,
    failure(step, error, raw) {
      entries.push({ step, error, raw });
    },
  };
}

const EMPTY_OPTIONS = { now: NOW, lastGoodAt: null, host: 'tu-pc' };

/* ------------------------------------------------------------------ *
 * (a) no tunnel → offline + reconnect copy
 * ------------------------------------------------------------------ */

test('(a) no tunnel is offline with the reconnect copy', async () => {
  const log = recordingLogger();
  const result = await checkConnection(null, { ...EMPTY_OPTIONS, logger: log });

  assert.equal(result.model.status, 'offline');
  assert.equal(result.copy.tone, 'danger');
  assert.match(result.copy.text, /Sin conexión con tu-pc/);
  assert.match(result.copy.text, /PC esté encendida/);
  assert.equal(result.copy.retryLabel, 'Reintentar');
  assert.equal(result.retry.kind, 'reconnect');
  // Nothing was invented as evidence: no identity, no proto, no minutes.
  assert.equal(result.model.identity, null);
  assert.equal(result.model.protos, null);
  assert.equal(result.model.minutes, null);
  assert.equal(log.entries[0].step, 'tunnel');
});

test('(a2) a channel that refuses the write is offline, not an empty success', async () => {
  const channel = scriptedChannel([]);
  channel.write = async () => 0;
  const log = recordingLogger();
  const result = await checkConnection(channel, { ...EMPTY_OPTIONS, logger: log });

  assert.equal(result.model.status, 'offline');
  assert.equal(result.model.failure, 'offline');
  assert.equal(log.entries[0].step, 'health-request');
  assert.equal(log.entries[0].raw, 'write=0');
});

/* ------------------------------------------------------------------ *
 * (b) health ok → live with identity copy
 * ------------------------------------------------------------------ */

test('(b) a real /api/health identity is live with the identity copy', async () => {
  const channel = scriptedChannel([OK_WIRE(IDENTITY)]);
  const log = recordingLogger();
  const result = await checkConnection(channel, { ...EMPTY_OPTIONS, logger: log });

  assert.equal(result.model.status, 'live');
  assert.equal(result.copy.tone, 'ok');
  assert.deepEqual(result.model.identity, {
    proto: APP_PROTO,
    name: 'gentle-shell',
    version: '0.5.9',
  });
  // The copy carries the host, the identity name, the version and the proto.
  assert.match(result.copy.text, /Conectado a tu-pc/);
  assert.match(result.copy.text, /gentle-shell 0\.5\.9/);
  assert.match(result.copy.text, /proto 1/);
  assert.equal(log.entries.length, 0);

  const wired = channel.log.find(([op]) => op === 'write');
  assert.ok(wired, 'the real request was written');
});

test('(b2) identity is parsed from the protocol §9.2 payload (app/bridge)', () => {
  assert.deepEqual(parseHealthIdentity(IDENTITY), {
    proto: 1,
    name: 'gentle-shell',
    version: '0.5.9',
  });
  // No proto at all is not an identity: another server could answer this.
  assert.equal(parseHealthIdentity({ app: 'gentle-shell' }), null);
  assert.equal(parseHealthIdentity(null), null);
  assert.equal(parseHealthIdentity('HTTP/1.1 200 OK'), null);
});

test('(b3) one check writes exactly one /api/health request (no polling loop)', async () => {
  const channel = scriptedChannel([OK_WIRE(IDENTITY)]);
  await checkConnection(channel, EMPTY_OPTIONS);
  const writes = channel.log.filter(([op]) => op === 'write');
  assert.equal(writes.length, 1);
});

/* ------------------------------------------------------------------ *
 * (c) proto mismatch → incompatible carrying both protos
 * ------------------------------------------------------------------ */

test('(c) a newer bridge proto is incompatible and the copy carries both protos', async () => {
  const channel = scriptedChannel([OK_WIRE({ ...IDENTITY, proto: 2, version: '0.6.0' })]);
  const result = await checkConnection(channel, EMPTY_OPTIONS);

  assert.equal(result.model.status, 'incompatible');
  assert.deepEqual(result.model.protos, { app: APP_PROTO, bridge: 2 });
  assert.equal(result.copy.tone, 'danger');
  assert.match(result.copy.text, /proto 2/);
  assert.match(result.copy.text, /proto 1/);
  assert.match(result.copy.text, /0\.6\.0/);
});

/* ------------------------------------------------------------------ *
 * (d) 401/403 → unauthorized
 * ------------------------------------------------------------------ */

test('(d) a 401 answer is unauthorized, never live and never offline', async () => {
  const channel = scriptedChannel([
    utf8Encode('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"error":"unauthorized"}'),
  ]);
  const log = recordingLogger();
  const result = await checkConnection(channel, { ...EMPTY_OPTIONS, logger: log });

  assert.equal(result.model.status, 'unauthorized');
  assert.equal(result.model.httpStatus, 401);
  assert.equal(result.copy.tone, 'danger');
  assert.match(result.copy.text, /401/);
  assert.match(result.copy.text, /emparejar/);
  assert.equal(log.entries[0].step, 'health-status');
});

test('(d2) a 403 answer is unauthorized too', async () => {
  const channel = scriptedChannel([
    utf8Encode('HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"error":"forbidden"}'),
  ]);
  const result = await checkConnection(channel, EMPTY_OPTIONS);
  assert.equal(result.model.status, 'unauthorized');
  assert.equal(result.model.httpStatus, 403);
});

test('(d3) a status line kept in the raw prefix still maps to unauthorized', async () => {
  // No blank line, so the response never parses as HTTP: `bridge.ts` keeps the
  // whole prefix as raw evidence and the status line is the only proof left.
  const channel = scriptedChannel([
    utf8Encode('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: SSH\r\n'),
  ]);
  const result = await checkConnection(channel, EMPTY_OPTIONS);
  assert.equal(result.model.status, 'unauthorized');
  assert.equal(result.model.httpStatus, 401);
});

test('(d4) a broken 401 body loses the status, so the state is unknown — never a guess', async () => {
  // `bridge.ts` owns the framing: a 401 whose body is not JSON is reported as
  // `bad-response` with the BODY prefix, so the status is gone. Claiming
  // `unauthorized` here would be a guess; `unknown` with the raw evidence is the truth.
  const channel = scriptedChannel([
    utf8Encode('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nno sos vos'),
  ]);
  const log = recordingLogger();
  const result = await checkConnection(channel, { ...EMPTY_OPTIONS, logger: log });
  assert.equal(result.model.status, 'unknown');
  assert.equal(result.model.failure, 'bad-response');
  assert.match(String(log.entries[0].raw), /no sos vos/);
});

/* ------------------------------------------------------------------ *
 * (e)/(f) timeout: stale with minutes vs offline
 * ------------------------------------------------------------------ */

test('(e) a timeout after a good answer is stale with the honest minutes', async () => {
  const result = await checkConnection(silentChannel(), {
    now: NOW,
    lastGoodAt: NOW - 7 * 60_000,
    host: 'tu-pc',
    timeoutMs: 20,
  });

  assert.equal(result.model.status, 'stale');
  assert.equal(result.model.minutes, 7);
  assert.equal(result.copy.tone, 'warning');
  assert.match(result.copy.text, /última vez hace 7 min/);
  assert.equal(result.copy.retryLabel, 'Reintentar');
});

test('(e2) minutes are at least 1 and never negative when the clock skews', async () => {
  assert.equal(staleMinutes(NOW, NOW), 1);
  assert.equal(staleMinutes(NOW - 90_000, NOW), 1);
  assert.equal(staleMinutes(NOW + 90_000, NOW), 1);
  assert.equal(staleMinutes(NOW - 59 * 60_000, NOW), 59);
  assert.equal(staleMinutes(null, NOW), null);
  assert.equal(staleMinutes(Number.NaN, NOW), null);
});

test('(f) a timeout with nothing good before is offline, never stale', async () => {
  const result = await checkConnection(silentChannel(), {
    now: NOW,
    lastGoodAt: null,
    host: 'tu-pc',
    timeoutMs: 20,
  });

  assert.equal(result.model.status, 'offline');
  assert.equal(result.model.minutes, null);
  assert.equal(result.model.failure, 'timeout');
});

/* ------------------------------------------------------------------ *
 * (g) retry descriptor
 * ------------------------------------------------------------------ */

test('(g) the reconnect descriptor is pending: true and says so honestly', async () => {
  const result = await checkConnection(null, EMPTY_OPTIONS);
  assert.equal(result.retry.kind, 'reconnect');
  assert.equal(result.retry.pending, true);
  assert.match(result.retry.note, /todavía no está conectado/);

  // A recheck IS wired (the screen re-runs checkConnection), so it is not pending.
  const live = retryIntent(previewConnection('live'));
  assert.equal(live.kind, 'recheck');
  assert.equal(live.pending, false);
});

/* ------------------------------------------------------------------ *
 * (h) every status has real es-AR copy
 * ------------------------------------------------------------------ */

test('(h) every §V20 status has non-empty es-AR copy and a tone', () => {
  const tones = new Set(['ok', 'warning', 'danger', 'muted']);
  assert.deepEqual(
    [...CONNECTION_STATUSES],
    ['unknown', 'connecting', 'live', 'stale', 'offline', 'incompatible', 'unauthorized'],
  );

  for (const status of CONNECTION_STATUSES) {
    const copy = connectionCopy(previewConnection(status));
    assert.equal(copy.status, status, `${status} copy keeps its status`);
    assert.ok(copy.title.trim().length > 0, `${status} has a title`);
    assert.ok(copy.text.trim().length > 0, `${status} has a text`);
    assert.ok(tones.has(copy.tone), `${status} has a known tone`);
    assert.ok(!/[{}]/.test(copy.text), `${status} has no unfilled placeholder`);
    assert.ok(!/\bnull\b|\bundefined\b/.test(copy.text), `${status} leaks no null`);
  }

  assert.equal(connectionCopy(previewConnection('live')).tone, 'ok');
  assert.equal(connectionCopy(previewConnection('stale')).tone, 'warning');
  assert.equal(connectionCopy(previewConnection('connecting')).tone, 'warning');
  assert.equal(connectionCopy(previewConnection('unknown')).tone, 'muted');
  assert.equal(connectionCopy(previewConnection('offline')).tone, 'danger');
  assert.equal(connectionCopy(previewConnection('incompatible')).tone, 'danger');
  assert.equal(connectionCopy(previewConnection('unauthorized')).tone, 'danger');

  // Live needs no retry button; every other state offers one.
  assert.equal(connectionCopy(previewConnection('live')).retryLabel, null);
  assert.ok(connectionCopy(previewConnection('offline')).retryLabel !== null);
});

/* ------------------------------------------------------------------ *
 * Honest evidence + the pre-check states
 * ------------------------------------------------------------------ */

test('a broken answer is unknown with the failure message, never live', async () => {
  const channel = scriptedChannel([utf8Encode('<html>not a bridge</html>')]);
  const log = recordingLogger();
  const result = await checkConnection(channel, { ...EMPTY_OPTIONS, logger: log });

  assert.equal(result.model.status, 'unknown');
  assert.equal(result.model.failure, 'bad-response');
  assert.match(result.copy.text, /No pudimos verificar el puente/);
  assert.equal(log.entries[0].step, 'health-request');
  assert.match(String(log.entries[0].raw), /<html>/);

  // A 200 with a body that is not an identity is not a bridge either.
  const impostor = scriptedChannel([OK_WIRE({ hello: 'world' })]);
  const second = await checkConnection(impostor, EMPTY_OPTIONS);
  assert.equal(second.model.status, 'unknown');
  assert.match(second.copy.text, /identidad/);
});

test('a non-2xx answer that is neither auth nor identity is unknown with the status', async () => {
  const channel = scriptedChannel([
    utf8Encode('HTTP/1.1 500 Boom\r\nContent-Type: application/json\r\n\r\n{"error":"boom"}'),
  ]);
  const log = recordingLogger();
  const result = await checkConnection(channel, { ...EMPTY_OPTIONS, logger: log });

  assert.equal(result.model.status, 'unknown');
  assert.equal(result.model.failure, 'protocol-status');
  assert.match(result.copy.text, /500/);
  assert.equal(log.entries[0].step, 'health-status');
});

test('initial and connecting models are honest pre-check states', () => {
  assert.equal(initialConnection().status, 'unknown');
  assert.equal(initialConnection().identity, null);
  assert.equal(connectionCopy(initialConnection()).retryLabel, 'Reintentar');
  assert.equal(connectionCopy(previewConnection('connecting')).status, 'connecting');
  assert.match(connectionCopy(previewConnection('connecting')).text, /reconectando/i);
  assert.equal(connectionCopy(previewConnection('connecting')).retryLabel, null);
});

test('evidenceLine reports proto, version, minutes and failures only when present', () => {
  assert.equal(evidenceLine(initialConnection()), null);

  const stale = deriveConnection({
    tunnel: true,
    failure: { kind: 'timeout', message: 'La PC no respondió a tiempo.', raw: '20ms, 0B' },
    lastGoodAt: NOW - 7 * 60_000,
    now: NOW,
  });
  assert.equal(stale.status, 'stale');
  const line = evidenceLine(stale);
  assert.match(line, /última vez=7 min/);

  const incompatible = previewConnection('incompatible');
  const mismatch = evidenceLine(incompatible);
  assert.match(mismatch, /app-proto=1/);
  assert.match(mismatch, /puente-proto=2/);
  assert.match(mismatch, /versión=0\.6\.0/);

  const live = previewConnection('live');
  assert.match(evidenceLine(live), /proto=1/);
  assert.match(evidenceLine(live), /name=gentle-shell/);
});

test('the host is copied as given and defaults to tu-pc when absent', () => {
  const model = previewConnection('offline');
  assert.match(connectionCopy(model, { host: 'casa-pc' }).text, /casa-pc/);
  assert.match(connectionCopy(model).text, /tu-pc/);
  assert.match(connectionCopy(model, { host: '   ' }).text, /tu-pc/);
});
