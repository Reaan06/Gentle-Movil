/**
 * V9 waiting inbox tests (T7e) — the inbox reads the REAL bridge over the SSH
 * tunnel, so every case here speaks the real wire format through a fake channel
 * (same helpers as `mobile/test/bridge.test.mjs`) and pins that:
 *
 * - the PC publishes `busy | idle | unknown` and no question (§9.3), so no real
 *   session becomes a card and no `waiting` status is ever invented;
 * - the card mapping and the relative waiting copy are honest, singular and
 *   plural (pure functions, fed directly);
 * - no pending question is the `empty` state with its reason, never a success
 *   with zeros and never `Todo en marcha`;
 * - a missing tunnel is `offline`, a broken body is `error` with the failure
 *   message and the raw evidence, a timeout after a good answer is `stale`;
 * - the answer action is still a pending route (nothing is sent).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Encode } from '../lib/core.ts';
import { LastGood } from '../lib/overview-provider.ts';
import {
  INBOX_EMPTY_COPY,
  INBOX_EMPTY_REASON,
  answerIntent,
  buildInbox,
  inboxItemFromSession,
  inboxItemsFromSessions,
  loadInbox,
  waitingCopy,
  waitingMinutes,
} from '../lib/waiting.ts';

/** Fixed clock so every relative copy is deterministic. */
const NOW = Date.parse('2026-11-18T15:20:00Z');

const OK_WIRE = (body) =>
  utf8Encode(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  );

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
    async write() {
      return 1;
    },
    read: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 50),
      ),
    async close() {},
  };
}

/** The real `/api/sessions` payload: a bare array with the three §9.3 states. */
function sessions() {
  return [
    {
      id: 's1',
      title: 'feat/auth-login',
      status: 'busy',
      hint: 'gentle-movil',
      updatedAt: '2026-11-18T15:16:00Z',
    },
    {
      id: 's2',
      title: 'fix/daemon-retry',
      status: 'busy',
      hint: 'gentle-shell',
      updatedAt: '2026-11-18T15:18:00Z',
    },
    {
      id: 's3',
      title: 'chore/deps',
      status: 'idle',
      hint: 'engram',
      updatedAt: '2026-11-18T15:19:00Z',
    },
    {
      id: 's4',
      title: 'pregunta sin texto',
      status: 'unknown',
      hint: null,
      updatedAt: '2026-11-18T15:12:00Z',
    },
  ];
}

/**
 * The cards a bridge that exposes pending questions would produce. Built with
 * `inboxItemFromSession` directly: §9.3 has no question source yet, so this is
 * render-model fixture data, never a fabricated wire payload.
 */
function cachedCards() {
  return [
    inboxItemFromSession(
      {
        id: 's1',
        title: 'feat/auth-login',
        status: 'busy',
        hint: 'gentle-movil',
        updatedAt: '2026-11-18T15:16:00Z',
        question: '¿Uso bcrypt o argon2 para los hashes?',
      },
      NOW,
    ),
    inboxItemFromSession(
      {
        id: 's4',
        title: 'pregunta sin texto',
        status: 'unknown',
        hint: null,
        updatedAt: '2026-11-18T15:12:00Z',
      },
      NOW,
    ),
  ];
}

test('(a) a §9.3 session list produces no card: the PC publishes no question', () => {
  // No published state (`busy` / `idle` / `unknown`) is promoted into an inbox
  // item, and no `waiting` state is invented to fill the screen.
  assert.deepEqual(inboxItemsFromSessions(sessions(), NOW), []);
});

test('(a) one session maps onto its card: title, hint, label, question', () => {
  const [withQuestion, withoutQuestion] = cachedCards();
  assert.equal(withQuestion.id, 's1');
  assert.equal(withQuestion.title, 'feat/auth-login');
  assert.equal(withQuestion.projectHint, 'gentle-movil');
  assert.equal(withQuestion.sessionLabel, 'gentle-movil');
  assert.equal(withQuestion.question, '¿Uso bcrypt o argon2 para los hashes?');
  assert.equal(withQuestion.waitingMinutes, 4);
  assert.equal(withQuestion.waitingFor, 'esperando hace 4 min');
  assert.equal(withoutQuestion.projectHint, null);
  assert.equal(withoutQuestion.sessionLabel, 'pregunta sin texto');
  assert.equal(withoutQuestion.question, null);
});

test('(a) a blank or non-string question is no question block, not empty text', () => {
  const base = {
    title: 't',
    status: 'busy',
    hint: null,
    updatedAt: '2026-11-18T15:16:00Z',
  };
  assert.equal(inboxItemFromSession({ ...base, id: 'b1', question: '   ' }, NOW).question, null);
  assert.equal(inboxItemFromSession({ ...base, id: 'b2', question: null }, NOW).question, null);
  assert.equal(inboxItemFromSession({ ...base, id: 'b3' }, NOW).question, null);
  assert.equal(
    inboxItemFromSession({ ...base, id: 'b4', question: '  ¿Sigo?  ' }, NOW).question,
    '¿Sigo?',
  );
});

test('(b) waiting copy: singular for 1 min/h/día, plural above', () => {
  assert.equal(waitingCopy(0), 'esperando hace menos de 1 min');
  assert.equal(waitingCopy(1), 'esperando hace 1 min');
  assert.equal(waitingCopy(4), 'esperando hace 4 min');
  assert.equal(waitingCopy(59), 'esperando hace 59 min');
  assert.equal(waitingCopy(60), 'esperando hace 1 h');
  assert.equal(waitingCopy(185), 'esperando hace 3 h');
  assert.equal(waitingCopy(24 * 60), 'esperando hace 1 día');
  assert.equal(waitingCopy(3 * 24 * 60), 'esperando hace 3 días');
  assert.equal(waitingCopy(null), 'esperando');
});

test('(b) waiting minutes come from updatedAt with an injectable clock', () => {
  assert.equal(waitingMinutes('2026-11-18T15:16:00Z', NOW), 4);
  // A timestamp in the future (clock skew) clamps at 0 instead of going negative.
  assert.equal(waitingMinutes('2026-11-18T15:40:00Z', NOW), 0);
  assert.equal(waitingMinutes('no-es-una-fecha', NOW), null);

  const base = { title: 't', status: 'busy', hint: null };
  const four = inboxItemFromSession(
    { ...base, id: 's1', updatedAt: '2026-11-18T15:16:00Z' },
    NOW,
  );
  assert.equal(four.waitingMinutes, 4);
  assert.equal(four.waitingFor, 'esperando hace 4 min');

  const unknown = inboxItemFromSession({ ...base, id: 's2', updatedAt: '?' }, NOW);
  assert.equal(unknown.waitingMinutes, null);
  assert.equal(unknown.waitingFor, 'esperando');
});

test('(c) no pending question → empty with the reason, never success with zeros', async () => {
  // The exact payload the extension serves today: real sessions, no question.
  const channel = scriptedChannel([OK_WIRE(sessions())]);
  const state = await loadInbox(channel, { now: NOW });
  assert.equal(state.kind, 'empty');
  assert.deepEqual(state.items, []);

  const vm = buildInbox(state);
  assert.equal(vm.emptyCard, INBOX_EMPTY_COPY);
  assert.equal(INBOX_EMPTY_COPY, `Sin datos: ${INBOX_EMPTY_REASON}.`);
  assert.equal(vm.emptyCard.includes(INBOX_EMPTY_REASON), true);
  // The old artboard copy claimed a measurement the PC never made.
  assert.equal(vm.emptyCard.includes('Todo en marcha'), false);
  assert.equal(vm.countLine, 'Nada esperándote');
  assert.equal(vm.errorCard, null);
});

test('success: plural header copy counts questions and pending cards', () => {
  const [withQuestion, withoutQuestion] = cachedCards();
  const items = [withQuestion, { ...withoutQuestion, question: '¿Sigo con el refactor?' }];
  const vm = buildInbox({ kind: 'success', items });
  assert.equal(vm.state, 'success');
  assert.equal(vm.items.length, 2);
  assert.equal(vm.countLine, '2 preguntas abiertas');
  assert.equal(vm.pendingChip, '2 pendientes');
  assert.equal(vm.answerEnabled, true);
  assert.equal(vm.emptyCard, null);
});

test('success: singular header copy for one question and one pending card', () => {
  const vm = buildInbox({ kind: 'success', items: [cachedCards()[0]] });
  // Only `s1` carries a question, so the header counts one open question...
  assert.equal(vm.countLine, '1 pregunta abierta');
  // ...while the pending chip counts every card waiting on the human.
  assert.equal(vm.pendingChip, '1 pendiente');
  assert.equal(vm.answerEnabled, true);
  assert.equal(vm.emptyCard, null);
  assert.equal(vm.staleChip, null);
});

test('(d) offline: no tunnel → offline state with cached cards and answers disabled', async () => {
  const cached = cachedCards();
  const state = await loadInbox(null, { cached, now: NOW });
  assert.equal(state.kind, 'offline');
  assert.equal(state.items.length, 2);

  const vm = buildInbox(state);
  assert.equal(vm.offlineChip, 'Reconectando…');
  assert.equal(vm.answerEnabled, false);
  assert.equal(vm.answerOffNote, 'Requiere conexión');
});

test('(d) offline: a channel that refuses the write is offline, not an empty inbox', async () => {
  const channel = scriptedChannel([]);
  channel.write = async () => 0;
  const state = await loadInbox(channel, { now: NOW });
  assert.equal(state.kind, 'offline');
  assert.deepEqual(state.items, []);
  assert.equal(buildInbox(state).answerEnabled, false);
});

test('(e) broken JSON → error state with failure.message and the raw evidence', async () => {
  const channel = scriptedChannel([utf8Encode('HTTP/1.1 200 OK\r\n\r\n{"sessions": [')]);
  const state = await loadInbox(channel, { now: NOW });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC devolvió un JSON roto.');
  assert.match(state.raw, /^\{"sessions"/);

  const vm = buildInbox(state);
  assert.deepEqual(vm.errorCard, {
    message: 'La PC devolvió un JSON roto.',
    raw: state.raw,
  });
  assert.equal(vm.emptyCard, null);
  assert.equal(vm.answerEnabled, false);
});

test('(e) a body without a sessions array is an error, never an empty inbox', async () => {
  const channel = scriptedChannel([OK_WIRE({ nope: true })]);
  const state = await loadInbox(channel, { now: NOW });
  assert.equal(state.kind, 'error');
  // One parse owner: `bridgeSessions` reports the invalid list, the inbox does
  // not re-implement the check (and never turns it into an empty success).
  assert.equal(state.message, 'La PC devolvió una lista de sesiones inválida.');
  assert.match(state.raw, /nope/);
  const vm = buildInbox(state);
  assert.equal(vm.emptyCard, null);
  assert.equal(vm.answerEnabled, false);
});

test('timeout after a good answer → stale chip with the cards kept', async () => {
  const lastGood = new LastGood();
  lastGood.mark();
  const cached = cachedCards();
  const state = await loadInbox(silentChannel(), {
    cached,
    lastGood,
    timeoutMs: 10,
    now: NOW,
  });
  assert.equal(state.kind, 'stale');
  assert.equal(state.minutes, 1);
  assert.equal(state.items.length, 2);

  const vm = buildInbox(state);
  assert.equal(vm.staleChip, 'Datos de hace 1 min');
  assert.equal(vm.answerEnabled, true);
});

test('timeout with nothing cached → offline, never a fake empty inbox', async () => {
  const state = await loadInbox(silentChannel(), { timeoutMs: 10, now: NOW });
  assert.equal(state.kind, 'offline');
  assert.deepEqual(state.items, []);
});

test('loading renders skeletons, not an empty inbox', () => {
  const vm = buildInbox({ kind: 'loading' });
  assert.equal(vm.state, 'loading');
  assert.deepEqual(vm.items, []);
  assert.equal(vm.emptyCard, null);
  assert.equal(vm.staleChip, null);
  assert.equal(vm.errorCard, null);
  assert.equal(vm.answerEnabled, false);
});

test('(f) answerIntent is pending and points at the answer route', () => {
  const intent = answerIntent('s1');
  assert.equal(intent.sessionId, 's1');
  assert.equal(intent.pending, true);
  assert.equal(intent.route, '/waiting-inbox/s1/answer');
  assert.equal(typeof intent.pendingNote, 'string');
  assert.ok(intent.pendingNote.length > 0);
});
