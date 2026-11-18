/**
 * V7 — Terminal / control tests (artboard
 * `design/mobile-app-core/03-terminal-control.html`, `docs/mobile-views-plan.md`
 * §V7).
 *
 * `lib/terminal.ts` reads the REAL bridge over the SSH tunnel
 * (`GET /api/exec/history`, protocol §4). Every case here speaks the real
 * HTTP/1.1 wire format through a fake channel (same helpers as
 * `mobile/test/git.test.mjs`) and pins:
 *
 * - the command history ring (append keeps the newest N, clear empties it);
 * - the send descriptor: trimmed, empty rejected, `pending: true` + `/api/exec`,
 *   with the honest note that the endpoint is not served yet;
 * - the output model: raw chunks appended in order, ANSI escapes stripped for
 *   display with the newlines intact, and a real `truncado` marker at the cap;
 * - the exit-code copy (0 ok, non-zero danger with the code, null neutral);
 * - one honest state per outcome (`loading | empty | success | stale | offline |
 *   error`): a missing endpoint is an ERROR carrying its raw evidence, never an
 *   empty success, and no command is ever pretended to have run.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Encode } from '../lib/core.ts';
import {
  CommandHistory,
  EMPTY_COMMAND_COPY,
  EMPTY_COPY,
  EXEC_HISTORY_PATH,
  EXEC_PATH,
  INCOMPLETE_HISTORY_COPY,
  MISSING_ENDPOINT_COPY,
  NOT_SENT_REASON,
  OFFLINE_COPY,
  SEND_PENDING_NOTE,
  appendOutput,
  buildTerminalView,
  exitChip,
  loadHistory,
  renderOutput,
  sendIntent,
  stripAnsi,
  truncationMarker,
} from '../lib/terminal.ts';

/** A full HTTP/1.1 response in one frame (the peer closes right after). */
function okChannel(body, status = 200) {
  const wire = `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
  return {
    async write() {
      return 1;
    },
    async read() {
      return { bytes: utf8Encode(wire), eof: true };
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
      return { bytes: utf8Encode(text), eof: true };
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
      new Promise((resolve) =>
        setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 50),
      ),
    async close() {},
  };
}

/** Tunnel that refuses the write (the core reports no channel). */
function refusedChannel() {
  return {
    async write() {
      return 0;
    },
    async read() {
      return { bytes: new Uint8Array(), eof: true };
    },
    async close() {},
  };
}

/** Records the request line the module wrote, so the path is pinned. */
function recordingChannel(body, status = 200) {
  const channel = okChannel(body, status);
  const writes = [];
  const write = channel.write;
  channel.write = async (payload) => {
    writes.push(new TextDecoder().decode(payload));
    return write(payload);
  };
  channel.writes = writes;
  return channel;
}

/** Collects the `{step, error, raw}` failures instead of hitting the file sink. */
function collectingLogger() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
  };
}

/** A controllable clock for the cache / `at` stamps. */
function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

const ESC = '\u001b';

const entry = (command, extra = {}) => ({
  id: `cmd-${command}`,
  command,
  at: '2026-11-18T14:32:00.000Z',
  status: 'sent',
  exitCode: 0,
  output: 'ok\n',
  ...extra,
});

const PAYLOAD = {
  commands: [
    entry('ls -la', { output: `${ESC}[32mtotal 8${ESC}[0m\n` }),
    entry('bun test', { exitCode: 1, output: `fail\n` }),
    entry('git status', { exitCode: null, output: null, status: 'pending' }),
  ],
};

test('EXEC_HISTORY_PATH / EXEC_PATH are the endpoints the bridge is expected to expose', () => {
  assert.equal(EXEC_HISTORY_PATH, '/api/exec/history');
  assert.equal(EXEC_PATH, '/api/exec');
});

test('(a) history append keeps the newest N and clear empties the ring', () => {
  const history = new CommandHistory(3, clock().now);
  const first = history.append({ command: '  pwd  ' });
  assert.equal(first.command, 'pwd');
  assert.equal(first.status, 'pending');
  assert.equal(first.exitCode, null);
  assert.equal(first.output, null);

  history.append({ command: 'ls' });
  history.append({ command: 'cat a.txt' });
  history.append({ command: 'bun test' });

  const kept = history.entries();
  assert.equal(kept.length, 3);
  // Oldest first, and the oldest command fell off the ring.
  assert.deepEqual(
    kept.map((item) => item.command),
    ['ls', 'cat a.txt', 'bun test'],
  );
  // Ids are unique and monotonic, so a row key never collides.
  assert.equal(new Set(kept.map((item) => item.id)).size, 3);
  assert.notEqual(kept[0].id, kept[1].id);

  history.clear();
  assert.deepEqual(history.entries(), []);
  // The ring survives a clear: the next id is still fresh.
  const after = history.append({ command: 'echo hola' });
  assert.equal(after.command, 'echo hola');
  assert.equal(history.entries().length, 1);
  assert.equal(new Set([...kept.map((i) => i.id), after.id]).size, 4);
});

test('(a) the ring cap never mutates the previous snapshot', () => {
  const history = new CommandHistory(2, clock().now);
  history.append({ command: 'a' });
  const before = history.entries();
  history.append({ command: 'b' });
  history.append({ command: 'c' });
  assert.deepEqual(
    before.map((item) => item.command),
    ['a'],
  );
  assert.deepEqual(
    history.entries().map((item) => item.command),
    ['b', 'c'],
  );
});

test('(b) sendIntent trims, rejects empty and stays honest about the endpoint', () => {
  const intent = sendIntent('  bun test --watch  ');
  assert.equal(intent.ok, true);
  assert.equal(intent.intent.command, 'bun test --watch');
  assert.equal(intent.intent.pending, true);
  assert.equal(intent.intent.method, 'POST');
  assert.equal(intent.intent.route, '/api/exec');
  // The note must name the real gap, not pretend the command ran.
  assert.match(intent.intent.note, /\/api\/exec/);
  assert.match(intent.intent.note, /todavía no está conectado/);
  assert.equal(SEND_PENDING_NOTE, intent.intent.note);

  for (const empty of ['', '   ', '\n\t ']) {
    const rejected = sendIntent(empty);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'empty');
    assert.equal(rejected.message, EMPTY_COMMAND_COPY);
  }
});

test('(b) sendIntent accepts non-string input as empty instead of throwing', () => {
  for (const bad of [undefined, null, 42, {}]) {
    const rejected = sendIntent(bad);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.message, EMPTY_COMMAND_COPY);
  }
});

test('(c) ANSI escapes are stripped for display and the newlines stay', () => {
  const raw = `${ESC}[1m${ESC}[32m✓ ok${ESC}[0m\n${ESC}[31mfail${ESC}[39m\nfin\n`;
  assert.equal(stripAnsi(raw), '✓ ok\nfail\nfin\n');

  // OSC titles and cursor moves are escapes too, not text.
  assert.equal(stripAnsi(`${ESC}]0;título${'\u0007'}hola${ESC}[2K`), 'hola');
  // A CRLF is still one newline, and every line survives.
  const crlf = stripAnsi('uno\r\ndos\r\ntres');
  assert.equal(crlf, 'uno\ndos\ntres');
  assert.equal(crlf.split('\n').length, 3);
  // Nothing to strip: the text is untouched.
  assert.equal(stripAnsi('sin escapes\n'), 'sin escapes\n');
});

test('(c) raw chunks are appended in order, escapes only removed at render time', () => {
  let raw = '';
  for (const chunk of ['a\n', `${ESC}[31mb`, 'c', `${ESC}[0m\n`]) {
    raw = appendOutput(raw, chunk);
  }
  assert.equal(raw, `a\n${ESC}[31mbc${ESC}[0m\n`);
  assert.equal(renderOutput(raw).text, 'a\nbc\n');
});

test('(d) a long output is truncated with a real marker, never silently cut', () => {
  const raw = 'x'.repeat(25);
  const view = renderOutput(raw, 10);
  assert.equal(view.truncated, true);
  assert.equal(view.hidden, 15);
  assert.ok(view.text.startsWith('x'.repeat(10)));
  assert.ok(view.text.endsWith(truncationMarker(15)));
  assert.equal(truncationMarker(15), '… [truncado: 15 caracteres ocultos]');
  assert.match(view.text, /truncado/);

  // Under the cap nothing is marked and nothing is lost.
  const short = renderOutput('hola\n', 10);
  assert.equal(short.truncated, false);
  assert.equal(short.hidden, 0);
  assert.equal(short.text, 'hola\n');

  // Exactly at the cap is still complete.
  const exact = renderOutput('y'.repeat(10), 10);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, 'y'.repeat(10));

  // A singular character reads right, and a null output has nothing to render.
  assert.equal(truncationMarker(1), '… [truncado: 1 carácter oculto]');
  assert.equal(renderOutput(null), null);
});

test('(e) exit-code copy: 0 ok, non-zero danger with the code, null neutral', () => {
  assert.deepEqual(exitChip(0), { label: 'exit 0', tone: 'ok' });
  assert.deepEqual(exitChip(2), { label: 'exit 2', tone: 'danger' });
  assert.deepEqual(exitChip(130), { label: 'exit 130', tone: 'danger' });
  assert.deepEqual(exitChip(null), { label: 'sin código', tone: 'neutral' });
});

test('success: the real payload becomes rows with exit chips and stripped output', async () => {
  const channel = recordingChannel(PAYLOAD);
  const state = await loadHistory(channel, { logger: collectingLogger() });
  assert.equal(state.kind, 'success');
  assert.match(channel.writes[0], /^GET \/api\/exec\/history HTTP\/1\.1/);

  const vm = buildTerminalView(state);
  assert.equal(vm.state, 'success');
  assert.equal(vm.loading, false);
  assert.deepEqual(
    vm.rows.map((row) => [row.command, row.statusLabel, row.exit.label, row.exit.tone]),
    [
      ['ls -la', 'enviado', 'exit 0', 'ok'],
      ['bun test', 'enviado', 'exit 1', 'danger'],
      ['git status', 'en cola', 'sin código', 'neutral'],
    ],
  );
  // Output is display-ready: escapes gone, newlines kept.
  assert.equal(vm.rows[0].output.text, 'total 8\n');
  assert.equal(vm.rows[0].notSent, false);
  assert.equal(vm.rows[2].output, null);
  // The pane shows the newest command that actually produced output.
  assert.equal(vm.pane.command, 'bun test');
  assert.equal(vm.pane.exit.tone, 'danger');
  assert.match(vm.rows[0].atLabel, /^\d{2}:\d{2}$/);
  assert.equal(vm.canSend, true);
  assert.equal(vm.error, null);
  assert.equal(vm.emptyMessage, null);
});

test('success: a typed command that never ran is "no enviado" with the reason', async () => {
  const state = await loadHistory(recordingChannel(PAYLOAD), { logger: collectingLogger() });
  const history = new CommandHistory(5, clock().now);
  const typed = history.append({ command: 'rm -rf dist' });

  const vm = buildTerminalView(state, history.entries());
  assert.equal(vm.notSent.length, 1);
  const [row] = vm.notSent;
  assert.equal(row.command, 'rm -rf dist');
  assert.equal(row.id, typed.id);
  assert.equal(row.statusLabel, 'no enviado');
  assert.equal(row.notSent, true);
  assert.equal(row.reason, NOT_SENT_REASON);
  assert.equal(row.output, null);
  // It is NOT part of the PC history: nothing was executed.
  assert.deepEqual(
    vm.rows.map((item) => item.command),
    ['ls -la', 'bun test', 'git status'],
  );
});

test('(f) an empty history array is the empty state, never success with zeros', async () => {
  const cache = new (await import('../lib/terminal.ts')).HistoryCache();
  const state = await loadHistory(okChannel({ commands: [] }), {
    cache,
    logger: collectingLogger(),
  });
  assert.equal(state.kind, 'empty');
  const vm = buildTerminalView(state);
  assert.equal(vm.state, 'empty');
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.emptyMessage, EMPTY_COPY);
  assert.equal(vm.pane, null);
  assert.equal(vm.paneEmpty, 'Esperando la primera salida…');
  // An empty answer is truth: nothing is kept to fall back to.
  assert.equal(cache.snapshot(), null);
});

test('(f) 404 from the bridge is an honest error naming the missing endpoint', async () => {
  const logger = collectingLogger();
  const channel = recordingChannel({ error: 'not found' }, 404);
  const state = await loadHistory(channel, { logger });

  assert.equal(state.kind, 'error');
  assert.equal(state.message, MISSING_ENDPOINT_COPY);
  assert.match(state.raw, /status=404/);
  assert.match(state.raw, /\/api\/exec\/history/);
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'exec-history-request');
  assert.equal(logger.failures[0].raw, state.raw);

  const vm = buildTerminalView(state);
  assert.equal(vm.state, 'error');
  assert.deepEqual(vm.error, {
    title: 'No pudimos leer el historial',
    message: MISSING_ENDPOINT_COPY,
    raw: state.raw,
  });
  // Never an empty "no commands yet" screen hiding the failure.
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.emptyMessage, null);
  assert.equal(vm.canSend, false);
});

test('(f) any other rejected status keeps its own honest message and raw', async () => {
  const logger = collectingLogger();
  const state = await loadHistory(okChannel({ error: 'boom' }, 500), { logger });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC respondió 500.');
  assert.equal(state.raw, 'status=500 /api/exec/history');
  assert.equal(logger.failures.at(0).raw, 'status=500 /api/exec/history');
});

test('(f) a body without a commands array is an error, never an empty history', async () => {
  const state = await loadHistory(okChannel({ ok: true }), { logger: collectingLogger() });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, INCOMPLETE_HISTORY_COPY);
  assert.match(state.raw, /ok/);
});

test('(f) an invalid entry is an error carrying its raw value, not invented rows', async () => {
  const broken = [
    { id: 'a', command: '', at: '2026-11-18T14:32:00.000Z', status: 'sent', exitCode: 0, output: null },
    { id: 'a', command: 'ls', at: 'ayer', status: 'sent', exitCode: 0, output: null },
    { id: 'a', command: 'ls', at: '2026-11-18T14:32:00.000Z', status: 'exploded', exitCode: 0, output: null },
    { id: 'a', command: 'ls', at: '2026-11-18T14:32:00.000Z', status: 'sent', exitCode: 1.5, output: null },
    { id: 'a', command: 'ls', at: '2026-11-18T14:32:00.000Z', status: 'sent', exitCode: 0, output: 7 },
  ];
  for (const bad of broken) {
    const state = await loadHistory(okChannel({ commands: [bad] }), {
      logger: collectingLogger(),
    });
    assert.equal(state.kind, 'error');
    assert.equal(state.message, INCOMPLETE_HISTORY_COPY);
    assert.ok(state.raw !== null);
  }
});

test('(g) no tunnel is offline with the §V7 copy, never an empty success', async () => {
  const logger = collectingLogger();
  const state = await loadHistory(null, { logger });
  assert.equal(state.kind, 'offline');
  const vm = buildTerminalView(state);
  assert.equal(vm.state, 'offline');
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.banner, OFFLINE_COPY);
  assert.match(vm.bannerHint, /Reconectando/);
  assert.equal(vm.canSend, false);
  assert.equal(vm.emptyMessage, null);
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'tunnel');
});

test('(g) a refused channel write is offline too, not an empty history', async () => {
  const logger = collectingLogger();
  const state = await loadHistory(refusedChannel(), { logger });
  assert.equal(state.kind, 'offline');
  assert.equal(state.entries, null);
  assert.equal(logger.failures.at(0).step, 'exec-history-request');
  assert.equal(logger.failures.at(0).raw, 'write=0');
});

test('(h) broken JSON is an error with the raw body prefix, never an empty history', async () => {
  const logger = collectingLogger();
  const state = await loadHistory(rawChannel('HTTP/1.1 200 OK\r\n\r\n{"commands": ['), { logger });
  assert.equal(state.kind, 'error');
  assert.equal(state.message, 'La PC devolvió un JSON roto.');
  assert.match(state.raw, /\{"commands"/);
  assert.equal(logger.failures.at(0).raw, state.raw);
  assert.equal(buildTerminalView(state).error.raw, state.raw);
});

test('(i) timeout after a good answer is stale with the cached rows and minutes', async () => {
  const { HistoryCache } = await import('../lib/terminal.ts');
  const time = clock();
  const cache = new HistoryCache(time.now);
  const logger = collectingLogger();

  const good = await loadHistory(okChannel(PAYLOAD), { cache, logger });
  assert.equal(good.kind, 'success');

  time.advance(3 * 60_000);
  const state = await loadHistory(silentChannel(), { cache, logger, timeoutMs: 20 });
  assert.equal(state.kind, 'stale');

  const vm = buildTerminalView(state);
  assert.equal(vm.state, 'stale');
  assert.equal(vm.staleChip, 'Datos de hace 3 min');
  assert.equal(vm.frozen, true);
  assert.equal(vm.rows.length, 3);
  assert.equal(vm.canSend, true);
});

test('(i) timeout with nothing cached is offline, never an empty success', async () => {
  const { HistoryCache } = await import('../lib/terminal.ts');
  const state = await loadHistory(silentChannel(), {
    cache: new HistoryCache(),
    logger: collectingLogger(),
    timeoutMs: 20,
  });
  assert.equal(state.kind, 'offline');
  assert.equal(state.entries, null);
});

test('(i) offline after a good answer keeps the history readable and frozen', async () => {
  const { HistoryCache } = await import('../lib/terminal.ts');
  const time = clock();
  const cache = new HistoryCache(time.now);
  const logger = collectingLogger();
  await loadHistory(okChannel(PAYLOAD), { cache, logger });
  time.advance(60_000);

  const state = await loadHistory(null, { cache, logger });
  assert.equal(state.kind, 'offline');
  const vm = buildTerminalView(state);
  assert.equal(vm.frozen, true);
  assert.equal(vm.rows.length, 3);
  assert.equal(vm.staleChip, 'Última vez hace 1 min');
  assert.equal(vm.banner, OFFLINE_COPY);
});

test('loading renders skeletons, not an empty history', () => {
  const vm = buildTerminalView({ kind: 'loading' });
  assert.equal(vm.state, 'loading');
  assert.equal(vm.loading, true);
  assert.deepEqual(vm.rows, []);
  assert.deepEqual(vm.notSent, []);
  assert.equal(vm.emptyMessage, null);
  assert.equal(vm.error, null);
  assert.equal(vm.pane, null);
  assert.equal(vm.paneEmpty, null);
  assert.equal(vm.canSend, false);
});

test('notSent rows stay visible in every state, and are never faked as sent', () => {
  const history = new CommandHistory(5, clock().now);
  history.append({ command: 'deploy' });
  for (const state of [
    { kind: 'loading' },
    { kind: 'empty' },
    { kind: 'offline', entries: null, minutes: null },
    { kind: 'error', message: MISSING_ENDPOINT_COPY, raw: 'status=404' },
  ]) {
    const vm = buildTerminalView(state, history.entries());
    assert.equal(vm.notSent.length, 1);
    assert.equal(vm.notSent[0].statusLabel, 'no enviado');
    assert.equal(vm.notSent[0].reason, NOT_SENT_REASON);
  }
});
