/**
 * Overview real-provider tests (T8c): sessions from the PC map onto the V5
 * view model; every failure mode is a §V5 state, never invented data.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EmptySignal,
  LastGood,
  OfflineSignal,
  StaleSignal,
  bridgeOverviewProvider,
  overviewFromSessions,
  stateFromSignal,
} from '../lib/overview-provider.ts';
// .mjs es JS puro: los `type` imports no existen aquí (Node 26 no strippea .mjs)

const SESSIONS = [
  { id: '1', title: 'feat/auth', status: 'working', hint: 'gentle-movil', updatedAt: '2026-11-18T15:00:00Z' },
  { id: '2', title: 'fix/daemon', status: 'working', hint: 'gentle-shell', updatedAt: '2026-11-18T14:00:00Z' },
  { id: '3', title: 'pregunta del review', status: 'waiting', hint: null, updatedAt: '2026-11-18T13:00:00Z' },
  { id: '4', title: 'chore/deps', status: 'done', hint: 'engram', updatedAt: '2026-11-18T12:00:00Z' },
];

function okChannel(body) {
  const wire = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  return {
    async write() { return 1; },
    async read() { return { bytes: new TextEncoder().encode(wire), eof: true }; },
    async close() {},
  };
}

test('overviewFromSessions maps real statuses onto counts and hints', () => {
  const data = overviewFromSessions(SESSIONS);
  assert.equal(data.working.count, 2);
  assert.deepEqual(data.working.hints, ['gentle-movil', 'gentle-shell']);
  assert.equal(data.waiting.count, 1);
  assert.equal(data.done.count, 1);
});

test('empty PC (zero sessions) maps to the empty state, not zeros-as-success', () => {
  const provider = bridgeOverviewProvider(() => okChannel({ sessions: [] }));
  assert.rejects(provider(), EmptySignal);
});

test('tunnel never opened → offline signal, no fetch attempted', async () => {
  const provider = bridgeOverviewProvider(() => null);
  await assert.rejects(provider(), OfflineSignal);
});

test('channel refuses write (tunnel down) → offline signal', async () => {
  const broken = {
    async write() { throw new Error('session closed by peer'); },
    async read() { return { bytes: new Uint8Array(), eof: false }; },
    async close() {},
  };
  const provider = bridgeOverviewProvider(() => broken);
  await assert.rejects(provider(), OfflineSignal);
});

test('timeout with no previous good answer → offline (nothing cached yet)', async () => {
  const silent = {
    async write() { return 1; },
    read: () => new Promise((resolve) => setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 100)),
    async close() {},
  };
  const provider = bridgeOverviewProvider(() => silent);
  await assert.rejects(provider(), OfflineSignal);
});

test('timeout after a good answer → stale with minutes since it', async () => {
  const lastGood = new LastGood();
  lastGood.mark();
  const silent = {
    async write() { return 1; },
    read: () => new Promise((resolve) => setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 100)),
    async close() {},
  };
  const provider = bridgeOverviewProvider(() => silent, lastGood);
  await assert.rejects(provider(), (error) => {
    assert.ok(error instanceof StaleSignal);
    assert.equal(error.outcome.kind, 'stale');
    assert.ok(error.outcome.minutes >= 1);
    return true;
  });
});

test('success: real sessions + health flow through the provider', async () => {
  const channels = [okChannel({ sessions: SESSIONS }), okChannel({ proto: 1, name: 'tu-pc' })];
  let index = 0;
  const provider = bridgeOverviewProvider(() => channels[index++]);
  const data = await provider();
  assert.equal(data.working.count, 2);
  assert.equal(data.paired.host, 'tu-pc');
});

test('stateFromSignal maps every signal to its §V5 state', () => {
  assert.deepEqual(stateFromSignal(new OfflineSignal({ kind: 'offline' })), { kind: 'offline', data: null });
  assert.deepEqual(stateFromSignal(new EmptySignal({ kind: 'empty' })), { kind: 'empty' });
  const stale = new StaleSignal({ kind: 'stale', minutes: 4, data: overviewFromSessions(SESSIONS) });
  const mapped = stateFromSignal(stale);
  assert.equal(mapped.kind, 'stale');
  assert.equal(mapped.minutes, 4);
  assert.equal(mapped.data.working.count, 2);
  assert.deepEqual(stateFromSignal(new Error('random')), { kind: 'offline', data: null });
});
