/**
 * V5 — Overview dashboard logic (artboard
 * `design/mobile-app-core/01-overview.html`, `docs/mobile-views-plan.md` §V5).
 *
 * Imports only the RN-free module `../lib/overview.ts` (Node cannot load .tsx
 * nor react-native). Every rule of the §V5 states table that is expressible at
 * the logic level is pinned here; the screen is only the rendering shell.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEMO_OVERVIEW,
  buildOverview,
  chartBars,
  formatTokens,
  syncLine,
} from '../lib/overview.ts';

test('formatTokens uses es-AR style (comma decimal, k suffix)', () => {
  assert.equal(formatTokens(117700), '117,7k');
  assert.equal(formatTokens(31200), '31,2k');
  assert.equal(formatTokens(9400), '9,4k');
});

test('success view model: artboard demo data, tiles wide-first', () => {
  const vm = buildOverview({ kind: 'success', data: DEMO_OVERVIEW });
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
  const bars = chartBars(DEMO_OVERVIEW.tokens.days);
  const max = Math.max(...DEMO_OVERVIEW.tokens.days.map((d) => d.value));
  const today = bars[bars.length - 1];
  assert.equal(today.today, true);
  assert.ok(today.height > bars[0].height);
  for (const bar of bars) {
    const day = DEMO_OVERVIEW.tokens.days[bars.indexOf(bar)];
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

test('empty state: zero tiles and first-session card copy', () => {
  const vm = buildOverview({ kind: 'empty' });
  assert.equal(vm.state, 'empty');
  assert.equal(vm.emptyCard, 'Aún no hay sesiones. Crea la primera.');
  assert.equal(vm.tiles[0].count, 0);
  assert.equal(vm.actions.every((a) => !a.disabled), true);
});

test('stale state: numbers kept, amber chip copy with minutes', () => {
  const vm = buildOverview({ kind: 'stale', minutes: 3, data: DEMO_OVERVIEW });
  assert.equal(vm.state, 'stale');
  assert.equal(vm.staleChip, 'Datos de hace 3 min');
  assert.equal(vm.tiles[0].count, 2);
});

test('offline state: reconectando copy, disabled actions, grey dot', () => {
  const vm = buildOverview({ kind: 'offline', data: DEMO_OVERVIEW });
  assert.equal(vm.state, 'offline');
  assert.equal(vm.syncLine, 'Reconectando…');
  assert.equal(vm.actions.every((a) => a.disabled), true);
  assert.equal(vm.pairDot, 'grey');
});

test('action descriptors: pending routes, honest tap intent', () => {
  const vm = buildOverview({ kind: 'success', data: DEMO_OVERVIEW });
  const nueva = vm.actions.find((a) => a.id === 'new-session');
  const cambios = vm.actions.find((a) => a.id === 'changes');
  assert.equal(nueva.route, '/new-session');
  assert.equal(nueva.pending, true);
  assert.equal(cambios.route, '/changes');
  assert.equal(cambios.pending, true);
});
