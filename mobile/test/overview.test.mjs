/**
 * V5 — Overview dashboard logic (artboard
 * `design/mobile-app-core/01-overview.html`, `docs/mobile-views-plan.md` §V5).
 *
 * Imports only the RN-free module `../lib/overview.ts` (Node cannot load .tsx
 * nor react-native). Every rule of the §V5 states table that is expressible at
 * the logic level is pinned here; the screen is only the rendering shell.
 *
 * T7q rule: a metric the bridge does not report is `null` and renders
 * "sin datos" with its reason. It is never 0 and never a fabricated series.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MEASURED_OVERVIEW,
  NOTHING_MEASURED,
  NO_CHANGES_REASON,
  NO_DONE_REASON,
  NO_PENDING_REASON,
  NO_TOKENS_REASON,
  buildOverview,
  connectionChip,
  chartBars,
  formatTokens,
  syncLine,
} from '../lib/overview.ts';

test('formatTokens uses es-AR style (comma decimal, k suffix)', () => {
  assert.equal(formatTokens(117700), '117,7k');
  assert.equal(formatTokens(31200), '31,2k');
  assert.equal(formatTokens(9400), '9,4k');
});

test('success view model: measured data, tiles wide-first', () => {
  const vm = buildOverview({ kind: 'success', data: MEASURED_OVERVIEW });
  assert.equal(vm.state, 'success');
  assert.deepEqual(vm.tiles.map((t) => t.id), ['working', 'waiting', 'done']);
  assert.equal(vm.tiles[0].wide, true);
  assert.equal(vm.tiles[0].count, 2);
  assert.equal(vm.tiles[0].hint, 'feat/auth-login · fix/daemon-retry');
  assert.equal(vm.tiles[1].count, 1);
  assert.equal(vm.tiles[1].attention, true);
  assert.equal(vm.tiles[2].count, 12);
  assert.equal(vm.tiles[2].hint, '11 con cambios · 1 sin push');
});

test('chart bars: proportional heights, today (last day) flagged accent', () => {
  const days = MEASURED_OVERVIEW.tokens.days;
  const bars = chartBars(days);
  const max = Math.max(...days.map((d) => d.value));
  const today = bars[bars.length - 1];
  assert.equal(today.today, true);
  assert.ok(today.height > bars[0].height);
  for (const bar of bars) {
    const day = days[bars.indexOf(bar)];
    assert.ok(Math.abs(bar.height - day.value / max) < 1e-9);
  }
});

test('sync line: seconds, minutes and singular/plural devices', () => {
  assert.equal(
    syncLine(12, 1),
    'Sincronizado hace 12 s · 1 dispositivo emparejado',
  );
  assert.equal(
    syncLine(90, 1),
    'Sincronizado hace 1 min · 1 dispositivo emparejado',
  );
  assert.equal(
    syncLine(12, 2),
    'Sincronizado hace 12 s · 2 dispositivos emparejados',
  );
});

test('sync line: an unmeasured part says so, it never becomes 0', () => {
  assert.equal(syncLine(12, null), 'Sincronizado hace 12 s · dispositivos sin datos');
  assert.equal(syncLine(null, 1), 'Sincronizado · 1 dispositivo emparejado');
  assert.equal(syncLine(null, null), 'Sincronizado · dispositivos sin datos');
  assert.equal(syncLine(12, null).includes('0 dispositivo'), false);
});

test('empty state: zero tiles and first-session card copy', () => {
  const vm = buildOverview({ kind: 'empty' });
  assert.equal(vm.state, 'empty');
  assert.equal(vm.emptyCard, 'Aún no hay sesiones. Crea la primera.');
  assert.equal(vm.tiles[0].count, 0);
  assert.equal(vm.actions.every((a) => !a.disabled), true);
});

test('stale state: numbers kept, amber chip copy with minutes', () => {
  const vm = buildOverview({ kind: 'stale', minutes: 3, data: MEASURED_OVERVIEW });
  assert.equal(vm.state, 'stale');
  assert.equal(vm.staleChip, 'Datos de hace 3 min');
  assert.equal(vm.tiles[0].count, 2);
});

test('offline state: reconectando copy, disabled actions, grey dot', () => {
  const vm = buildOverview({ kind: 'offline', data: MEASURED_OVERVIEW });
  assert.equal(vm.state, 'offline');
  assert.equal(vm.syncLine, 'Reconectando…');
  assert.equal(vm.actions.every((a) => a.disabled), true);
  assert.equal(vm.pairDot, 'grey');
});

test('tokens panel renders the measured series and its formatted totals', () => {
  const vm = buildOverview({ kind: 'success', data: MEASURED_OVERVIEW });
  assert.equal(vm.tokens.available, true);
  assert.equal(vm.tokens.total, '117,7k');
  assert.equal(vm.tokens.today, '31,2k');
  assert.equal(vm.tokens.sessions, '4 sesiones');
  assert.equal(vm.tokens.chart.length, 7);
});

test('unmeasured metrics are null and render "sin datos" with the reason', () => {
  const vm = buildOverview({ kind: 'success', data: NOTHING_MEASURED });
  // Tokens: no usage source on the extension.
  assert.equal(vm.tokens.available, false);
  assert.equal(vm.tokens.reason, NO_TOKENS_REASON);
  assert.deepEqual(vm.tokens.chart, []);
  // Esperando: §9.3 publishes no pending question, so the tile is null with
  // its reason — never 0 and never the idle/unknown count.
  const waiting = vm.tiles.find((t) => t.id === 'waiting');
  assert.equal(waiting.count, null);
  assert.equal(waiting.attention, false);
  assert.equal(waiting.hint, NO_PENDING_REASON);
  // Terminadas: no finished-session source, so the tile is null with its
  // reason instead of a measured zero.
  const done = vm.tiles.find((t) => t.id === 'done');
  assert.equal(done.count, null);
  assert.equal(done.hint, NO_DONE_REASON);
  // Devices: only when the health payload reports a number.
  assert.ok(vm.syncLine.includes('dispositivos sin datos'));
  // The real measured count still renders: Trabajando is 0 because the PC said
  // so, not because the metric is missing.
  assert.equal(vm.tiles.find((t) => t.id === 'working').count, 0);
});

test('done tile with real sessions but no counters says "sin datos"', () => {
  const data = { ...NOTHING_MEASURED, done: { count: 3, unit: 'esta semana', withChanges: null, withoutPush: null } };
  const vm = buildOverview({ kind: 'success', data });
  const done = vm.tiles.find((t) => t.id === 'done');
  assert.equal(done.count, 3);
  assert.ok(done.hint.includes('sin datos'));
  assert.ok(done.hint.includes(NO_CHANGES_REASON));
  assert.equal(done.hint.includes('0 con cambios'), false);
});

test('loading and offline states never invent a token series', () => {
  for (const state of [{ kind: 'loading' }, { kind: 'offline', data: null }]) {
    const vm = buildOverview(state);
    assert.equal(vm.tokens.available, false);
    assert.deepEqual(vm.tokens.chart, []);
    assert.equal(typeof vm.tokens.reason, 'string');
  }
});

test('action descriptors point at the screens that exist', () => {
  const vm = buildOverview({ kind: 'success', data: MEASURED_OVERVIEW });
  const nueva = vm.actions.find((a) => a.id === 'new-session');
  const cambios = vm.actions.find((a) => a.id === 'changes');
  // /git-changes exists: the action navigates instead of pretending.
  assert.equal(cambios.route, '/git-changes');
  assert.equal(cambios.pending, false);
  // /new-session still has no screen, and says exactly that.
  assert.equal(nueva.route, '/new-session');
  assert.equal(nueva.pending, true);
  assert.ok(nueva.pendingReason.includes('/new-session'));
});

/**
 * The connection chip (T17, S11): Overview's chip is the door to the connection
 * menu, so it has to say the real state of the tunnel and the real host — and
 * never invent a host it does not know.
 */
test('connection chip: real state, real host, and it opens the connection menu', () => {
  const success = buildOverview({ kind: 'success', data: MEASURED_OVERVIEW });

  const live = connectionChip(success, '192.168.0.10');
  assert.equal(live.text, 'Live · 192.168.0.10');
  assert.equal(live.dot, 'green');
  assert.match(live.accessibilityLabel, /menú de conexión/i);
  assert.equal(live.accessibilityHint, 'Reconectar, cambiar de conexión o agregar otro dispositivo');

  const stale = connectionChip(buildOverview({ kind: 'stale', minutes: 7, data: MEASURED_OVERVIEW }), '192.168.0.10');
  assert.equal(stale.text, 'Live · 192.168.0.10 · hace 7 min');
  assert.equal(stale.dot, 'green');

  const offline = connectionChip(buildOverview({ kind: 'offline', data: null }), '192.168.0.10');
  assert.equal(offline.text, 'Sin conexión · 192.168.0.10');
  assert.equal(offline.dot, 'grey');

  const loading = connectionChip(buildOverview({ kind: 'loading' }), '192.168.0.10');
  assert.equal(loading.text, 'Reconectando… · 192.168.0.10');
  assert.equal(loading.dot, 'grey');

  // The host the data reported is used when the caller has none; an unknown
  // host is said out loud instead of printing a made-up name.
  assert.equal(connectionChip(success).text, 'Live · tu-pc');
  assert.equal(connectionChip(success, null).text, 'Live · sin datos');
  assert.equal(
    connectionChip(buildOverview({ kind: 'offline', data: null }), '   ').text,
    'Sin conexión · sin datos',
  );
});
