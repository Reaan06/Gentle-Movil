/**
 * V6 — Sessions list tests (artboard `design/mobile-app-core/02-sessions-list.html`,
 * `docs/mobile-views-plan.md` §V6).
 *
 * `lib/sessions.ts` must build the list from a *real* `GET /api/sessions` over
 * the tunnel channel: filter counts, updated-desc order, relative copy, and one
 * honest state per outcome. Nothing here is simulated — the fake channel speaks
 * the real HTTP/1.1 wire format and every failure case asserts the state the
 * screen shows (S7: no invented rows, no zeros-as-success).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SessionsCache,
  buildSessionsView,
  filterChips,
  filterCounts,
  filterSessions,
  loadSessions,
  pillFor,
  relativeTime,
  sortSessions,
} from '../lib/sessions.ts';

const encoder = new TextEncoder();

/** A full HTTP/1.1 response in one frame (the peer closes right after). */
function okChannel(body, status = 200) {
  const wire = `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: encoder.encode(wire), eof: true };
    },
    async close() {},
  };
}

/** Raw bytes on the wire, for malformed answers. */
function rawChannel(text) {
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: encoder.encode(text), eof: true };
    },
    async close() {},
  };
}

/** Tunnel that is up but never answers (the timeout path). */
function silentChannel() {
  return {
    async write() {
      return 1;
    },
    read: () =>
      new Promise((resolve) => setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 60)),
    async close() {},
  };
}

/** Records `{step, error, raw}` the way `logger.tag('sessions-list')` does. */
function recordingLogger() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
  };
}

const session = (id, status, title, updatedAt, hint = 'gentle-movil') => ({
  id,
  title,
  status,
  hint,
  updatedAt,
});

const FOUR = [
  session('s1', 'working', 'feat/auth-login', '2026-11-18T15:00:00Z'),
  session('s2', 'waiting', 'fix/daemon-retry', '2026-11-18T14:58:00Z'),
  session('s3', 'done', 'chore/ota-config', '2026-11-18T14:12:00Z'),
  session('s4', 'done', 'docs/mobile-protocol', '2026-11-17T21:40:00Z'),
];

test('(a) 4 sessions → one count per §V6 filter, counts sum to All', () => {
  const counts = filterCounts(FOUR);
  assert.deepEqual(counts, { all: 4, working: 1, waiting: 1, done: 2 });
  assert.equal(counts.working + counts.waiting + counts.done, counts.all);
});

test('(a) filter chips carry the artboard labels, counts and the active flag', () => {
  const chips = filterChips(FOUR, 'working');
  assert.deepEqual(
    chips.map((chip) => [chip.id, chip.label, chip.count, chip.active]),
    [
      ['all', 'Todas', 4, false],
      ['working', 'Trabajando', 1, true],
      ['waiting', 'Esperando', 1, false],
      ['done', 'Terminadas', 2, false],
    ],
  );
});

test('(g) All filter includes every visible status', () => {
  const ids = filterSessions(FOUR, 'all').map((s) => s.id);
  assert.deepEqual(ids.sort(), ['s1', 's2', 's3', 's4']);
  assert.equal(filterSessions(FOUR, 'working').length, 1);
  assert.equal(filterSessions(FOUR, 'waiting').length, 1);
  assert.equal(filterSessions(FOUR, 'done').length, 2);
});

test('(g) archived sessions leave the list, so All equals the status sum', () => {
  const withArchived = [...FOUR, session('s9', 'archived', 'chore/old', '2026-11-16T10:00:00Z')];
  const counts = filterCounts(withArchived);
  assert.deepEqual(counts, { all: 4, working: 1, waiting: 1, done: 2 });
  assert.equal(filterSessions(withArchived, 'all').some((s) => s.id === 's9'), false);
});

test('(b) most recently updated first, ISO parsed as instants', () => {
  const shuffled = [FOUR[3], FOUR[0], FOUR[2], FOUR[1]];
  assert.deepEqual(
    sortSessions(shuffled).map((s) => s.id),
    ['s1', 's2', 's3', 's4'],
  );
  // A row with an unusable timestamp sorts last instead of winning.
  const broken = [...FOUR, session('bad', 'done', 'sin fecha', 'not-a-date')];
  assert.equal(sortSessions(broken).at(-1).id, 'bad');
  // The source array is never mutated.
  assert.equal(shuffled[0].id, 's4');
});

test('(c) relative copy: singular and plural in minutes, hours and days', () => {
  const now = Date.parse('2026-11-18T16:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(20_000), now), 'hace menos de 1 min');
  assert.equal(relativeTime(ago(60_000), now), 'hace 1 min');
  assert.equal(relativeTime(ago(2 * 60_000), now), 'hace 2 min');
  assert.equal(relativeTime(ago(60 * 60_000), now), 'hace 1 hora');
  assert.equal(relativeTime(ago(3 * 60 * 60_000), now), 'hace 3 horas');
  assert.equal(relativeTime(ago(24 * 60 * 60_000), now), 'hace 1 día');
  assert.equal(relativeTime(ago(3 * 24 * 60 * 60_000), now), 'hace 3 días');
});

test('(d) an empty PC is the empty state, never success with zeros', async () => {
  const log = recordingLogger();
  const state = await loadSessions(okChannel({ sessions: [] }), { logger: log });
  assert.deepEqual(state, { kind: 'empty' });
  assert.equal(log.failures.length, 0);

  const vm = buildSessionsView(state);
  assert.equal(vm.state, 'empty');
  assert.equal(vm.emptyMessage, 'Aún no hay sesiones.');
  assert.equal(vm.creatable, true);
  assert.deepEqual(vm.rows, []);
});

test('(e) no tunnel at all is offline, with the failure logged', async () => {
  const log = recordingLogger();
  const state = await loadSessions(null, { logger: log });
  assert.deepEqual(state, { kind: 'offline', sessions: null, minutes: null });
  assert.equal(log.failures.length, 1);
  assert.equal(log.failures[0].step, 'tunnel');
  assert.equal(log.failures[0].raw, null);
  assert.match(String(log.failures[0].error), /túnel|tunnel/i);

  const vm = buildSessionsView(state);
  assert.equal(vm.state, 'offline');
  assert.equal(vm.banner, 'Reconectando…');
  assert.deepEqual(vm.rows, []);
});

test('(e) a tunnel that refuses the write is offline, not an empty success', async () => {
  const log = recordingLogger();
  const broken = {
    async write() {
      throw new Error('session closed by peer');
    },
    async read() {
      return { bytes: new Uint8Array(), eof: false };
    },
    async close() {},
  };
  const state = await loadSessions(broken, { logger: log });
  assert.equal(state.kind, 'offline');
  assert.equal(log.failures.length, 1);
  assert.equal(log.failures[0].step, 'sessions-request');
  assert.match(String(JSON.stringify(log.failures[0].raw ?? '')), /session closed|offline/i);
});

test('(f) broken JSON is an error state carrying the failure message and raw', async () => {
  const log = recordingLogger();
  const state = await loadSessions(rawChannel('HTTP/1.1 200 OK\r\n\r\n{"sessions": ['), {
    logger: log,
  });
  assert.equal(state.kind, 'error');
  assert.match(state.message, /JSON roto/);
  assert.match(state.raw, /\{"sessions"/);
  assert.equal(log.failures.length, 1);
  assert.equal(log.failures[0].step, 'sessions-request');
  assert.match(String(log.failures[0].raw), /\{"sessions"/);
});

test('(f) a non-JSON answer is an error state, never a partial list', async () => {
  const state = await loadSessions(rawChannel('<html>not http</html>'), {
    logger: recordingLogger(),
  });
  assert.equal(state.kind, 'error');
  assert.match(state.message, /respuesta rota/);
  assert.match(state.raw, /<html>/);
});

test('(f) an extension that rejects the request is an error with its status', async () => {
  const state = await loadSessions(okChannel({ error: 'unauthorized' }, 401), {
    logger: recordingLogger(),
  });
  assert.equal(state.kind, 'error');
  assert.match(state.message, /401/);
});

test('a 200 with no sessions array is an error, not an empty list', async () => {
  const state = await loadSessions(okChannel({ sessions: 'nope' }), {
    logger: recordingLogger(),
  });
  assert.equal(state.kind, 'error');
  assert.match(state.message, /lista de sesiones inválida/);
});

test('timeout with no previous answer is offline (nothing truthful to show)', async () => {
  const state = await loadSessions(silentChannel(), {
    logger: recordingLogger(),
    cache: new SessionsCache(),
    timeoutMs: 20,
  });
  assert.equal(state.kind, 'offline');
  assert.equal(state.sessions, null);
});

test('timeout after a good answer is stale with the cached rows and minutes', async () => {
  const cache = new SessionsCache();
  const log = recordingLogger();
  const good = await loadSessions(okChannel({ sessions: FOUR }), { cache, logger: log });
  assert.equal(good.kind, 'success');

  const state = await loadSessions(silentChannel(), { cache, logger: log, timeoutMs: 20 });
  assert.equal(state.kind, 'stale');
  assert.equal(state.sessions.length, 4);
  assert.ok(state.minutes >= 1);

  const vm = buildSessionsView(state, 'all');
  assert.equal(vm.staleChip, `Datos de hace ${state.minutes} min`);
  assert.equal(vm.rows.length, 4);
  assert.equal(vm.rows.every((row) => row.frozen), true);
});

test('offline after a good answer keeps the rows readable and frozen', async () => {
  const cache = new SessionsCache();
  await loadSessions(okChannel({ sessions: FOUR }), { cache, logger: recordingLogger() });
  const state = await loadSessions(null, { cache, logger: recordingLogger() });
  assert.equal(state.kind, 'offline');
  assert.equal(state.sessions.length, 4);
  assert.ok(state.minutes >= 1);

  const vm = buildSessionsView(state);
  assert.equal(vm.state, 'offline');
  assert.equal(vm.banner, 'Reconectando…');
  assert.equal(vm.staleChip, `Última vez hace ${state.minutes} min`);
  assert.equal(vm.rows.every((row) => row.frozen), true);
});

test('success maps real rows onto the §V6 row view model, newest first', async () => {
  const log = recordingLogger();
  const state = await loadSessions(okChannel({ sessions: [FOUR[3], FOUR[0], FOUR[1], FOUR[2]] }), {
    logger: log,
  });
  assert.equal(state.kind, 'success');
  assert.equal(log.failures.length, 0);

  const vm = buildSessionsView(state, 'all');
  assert.equal(vm.state, 'success');
  assert.equal(vm.summary, '1 trabajando · 1 esperando · 2 terminadas');
  assert.deepEqual(
    vm.rows.map((row) => row.id),
    ['s1', 's2', 's3', 's4'],
  );
  const [working, waiting, done] = vm.rows;
  assert.equal(working.pill.label, 'Trabajando');
  assert.equal(working.pill.tone, 'working');
  assert.equal(working.hint, 'gentle-movil');
  assert.match(working.relative, /^hace /);
  assert.equal(working.route, '/session/s1');
  assert.equal(working.attention, false);
  assert.equal(waiting.pill.label, 'Esperando');
  assert.equal(waiting.pill.tone, 'waiting');
  assert.equal(waiting.attention, true);
  assert.equal(done.pill.label, 'Terminada');
  assert.equal(done.pill.tone, 'ok');
});

test('a session with no hint falls back to the title, never an empty line', async () => {
  const payload = { sessions: [{ ...FOUR[0], hint: null }] };
  const state = await loadSessions(okChannel(payload), { logger: recordingLogger() });
  const vm = buildSessionsView(state);
  assert.equal(vm.rows[0].hint, 'feat/auth-login');
});

test('an unknown status shows its raw value on a muted pill, not a made-up one', () => {
  assert.deepEqual(pillFor('working'), { label: 'Trabajando', tone: 'working' });
  assert.deepEqual(pillFor('queued'), { label: 'queued', tone: 'muted' });
});

test('an empty filter says why it is empty without claiming the PC is empty', async () => {
  const state = await loadSessions(okChannel({ sessions: FOUR }), { logger: recordingLogger() });
  const vm = buildSessionsView(state, 'waiting');
  assert.equal(vm.rows.length, 1);
  const workingOnly = buildSessionsView(
    { kind: 'success', sessions: [FOUR[0]] },
    'done',
  );
  assert.equal(workingOnly.rows.length, 0);
  assert.equal(workingOnly.emptyMessage, 'No hay sesiones terminadas.');
  assert.equal(workingOnly.creatable, false);
});

test('loading shows no rows and no chips (no zeros pretending to be data)', () => {
  const vm = buildSessionsView({ kind: 'loading' });
  assert.equal(vm.state, 'loading');
  assert.equal(vm.loading, true);
  assert.deepEqual(vm.rows, []);
  assert.deepEqual(vm.chips, []);
  assert.equal(vm.error, null);
});

test('error state exposes the card copy and raw evidence', async () => {
  const state = await loadSessions(rawChannel('HTTP/1.1 200 OK\r\n\r\n{"sessions": ['), {
    logger: recordingLogger(),
  });
  const vm = buildSessionsView(state);
  assert.equal(vm.state, 'error');
  assert.match(vm.error.message, /JSON roto/);
  assert.match(vm.error.raw, /\{"sessions"/);
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.creatable, false);
});
