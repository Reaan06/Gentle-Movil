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
 * - the real send: trimmed, empty rejected without a request, `POST /api/exec`
 *   with its JSON body on the wire, the real `exitCode`/`output` appended to the
 *   ring on 200, and one honest copy per refusal (`exec_disabled`,
 *   `shell_unsupported`, `invalid_command`, `payload_too_large`,
 *   `command_spawn_failed`) or link failure (offline, timeout);
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
  AGENT_NOTE,
  CommandHistory,
  COMMAND_SPAWN_FAILED_COPY,
  DURATION_CAP_COPY,
  EMPTY_COMMAND_COPY,
  EMPTY_COPY,
  ENDED_LABEL,
  EXEC_DISABLED_COPY,
  EXEC_DISABLED_NOTE,
  EXEC_HISTORY_PATH,
  EXEC_PATH,
  IDLE_LABEL,
  INCOMPLETE_HISTORY_COPY,
  INVALID_COMMAND_COPY,
  MISSING_ENDPOINT_COPY,
  NO_AGENT_REASON,
  NOT_SENT_REASON,
  OFFLINE_COPY,
  PAYLOAD_TOO_LARGE_COPY,
  RUNNING_LABEL,
  SENDING_COPY,
  SEND_BROKEN_COPY,
  SEND_OFFLINE_COPY,
  SEND_REFUSED_TITLE,
  SEND_TIMEOUT_COPY,
  SEND_UNREACHABLE_TITLE,
  SHELL_UNSUPPORTED_COPY,
  TRANSCRIPT_STATES,
  agentHeader,
  appendOutput,
  buildTerminalView,
  durationCopy,
  exitChip,
  loadHistory,
  renderOutput,
  sendIntent,
  stripAnsi,
  transcriptEvents,
  transcriptState,
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

test('(b) sendIntent trims, rejects empty without a request and posts over the channel', async () => {
  const history = new CommandHistory(5, clock().now);
  const channel = recordingChannel({ id: 'cmd-1', exitCode: 0, output: 'ok\n' });
  const sent = await sendIntent('  bun test --watch  ', {
    channel,
    history,
    logger: collectingLogger(),
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.entry.command, 'bun test --watch');

  for (const empty of ['', '   ', '\n\t ']) {
    const silent = recordingChannel({ id: 'nope', exitCode: 0, output: null });
    const rejected = await sendIntent(empty, { channel: silent, history });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'empty');
    assert.equal(rejected.message, EMPTY_COMMAND_COPY);
    // Validation happens before the wire: nothing was written to the PC.
    assert.deepEqual(silent.writes, []);
  }
});

test('(b) sendIntent accepts non-string input as empty instead of throwing', async () => {
  for (const bad of [undefined, null, 42, {}]) {
    const rejected = await sendIntent(bad);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'empty');
    assert.equal(rejected.message, EMPTY_COMMAND_COPY);
  }
});

/* ------------------------------------------------------------------ *
 * T7o — the send is a real POST /api/exec (protocol §4.1)
 * ------------------------------------------------------------------ */

/** A §4.1 refusal: `status` plus `{"error":{"code","message"}}`. */
function refusalChannel(status, code, message) {
  return recordingChannel({ error: { code, message } }, status);
}

test('(a) 403 exec_disabled: the honest opt-in copy and NO ring entry', async () => {
  const history = new CommandHistory(5, clock().now);
  const logger = collectingLogger();
  const channel = refusalChannel(403, 'exec_disabled', 'running commands is disabled');

  const result = await sendIntent('ls', { channel, history, logger });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exec_disabled');
  // The exact copy the spec pins: the missing opt-in, named.
  assert.equal(
    result.message,
    'Enviar está desactivado en tu PC: la extensión necesita GENTLE_MOVIL_ALLOW_EXEC=1.',
  );
  assert.equal(result.message, EXEC_DISABLED_COPY);
  // And it says nothing ran: the PC refused before spawning anything.
  assert.equal(result.note, EXEC_DISABLED_NOTE);
  assert.match(result.note, /no se ejecutó nada/i);
  // The PC refused — not the phone: the card says so.
  assert.equal(result.blame, 'pc');
  assert.equal(result.title, SEND_REFUSED_TITLE);
  // Nothing enters the ring, so no row pretends the command ran.
  assert.equal(history.size(), 0);
  // But the refusal is logged with its evidence.
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'exec-send');
  assert.match(String(logger.failures[0].raw), /code=exec_disabled/);
});

test('(b) 200: the ring keeps the REAL exit code and output, status sent', async () => {
  const history = new CommandHistory(5, clock().now);
  const logger = collectingLogger();
  const channel = recordingChannel({ id: 'cmd-m9x1-1', exitCode: 0, output: 'hola\n' });

  const result = await sendIntent('echo hola', { channel, history, logger });
  assert.equal(result.ok, true);
  assert.equal(result.entry.id, 'cmd-m9x1-1');
  assert.equal(result.entry.command, 'echo hola');
  assert.equal(result.entry.status, 'sent');
  assert.equal(result.entry.exitCode, 0);
  assert.equal(result.entry.output, 'hola\n');
  assert.deepEqual(result.exit, { label: 'exit 0', tone: 'ok' });
  assert.equal(result.output.text, 'hola\n');

  // The ring holds exactly that one entry, and the row is a real result.
  assert.deepEqual(history.entries(), [result.entry]);
  const vm = buildTerminalView({ kind: 'empty' }, history.entries());
  assert.deepEqual(
    vm.rows.map((row) => [row.command, row.statusLabel, row.exit.label, row.notSent]),
    [['echo hola', 'enviado', 'exit 0', false]],
  );
  assert.equal(vm.pane.command, 'echo hola');
  assert.equal(vm.pane.output.text, 'hola\n');
  // A real result is not a "no enviado" row.
  assert.deepEqual(vm.notSent, []);
  // Nothing failed, so the log stayed quiet.
  assert.deepEqual(logger.failures, []);
});

test('(c) 400 shell_unsupported: pipes are refused, nothing runs', async () => {
  const history = new CommandHistory(5, clock().now);
  const result = await sendIntent('ls | wc -l', {
    channel: refusalChannel(400, 'shell_unsupported', 'the command needs a shell'),
    history,
    logger: collectingLogger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shell_unsupported');
  assert.equal(result.message, SHELL_UNSUPPORTED_COPY);
  assert.match(result.message, /pipes/);
  assert.match(result.message, /redirecciones/);
  assert.equal(result.blame, 'pc');
  assert.match(result.note, /no se ejecutó nada/i);
  assert.equal(history.size(), 0);
});

test('(c) 400 invalid_command has its own copy', async () => {
  const history = new CommandHistory(5, clock().now);
  const result = await sendIntent('ls', {
    channel: refusalChannel(400, 'invalid_command', 'command is empty'),
    history,
    logger: collectingLogger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_command');
  assert.equal(result.message, INVALID_COMMAND_COPY);
  assert.equal(history.size(), 0);
});

test('(d) 413 payload_too_large: its own copy, no ring entry', async () => {
  const history = new CommandHistory(5, clock().now);
  const logger = collectingLogger();
  const result = await sendIntent('x'.repeat(100), {
    channel: refusalChannel(413, 'payload_too_large', 'the body exceeds 16384 bytes'),
    history,
    logger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'payload_too_large');
  assert.equal(result.message, PAYLOAD_TOO_LARGE_COPY);
  assert.equal(result.status, 413);
  assert.equal(history.size(), 0);
  assert.match(String(logger.failures[0].raw), /413/);
});

test('(e) 502 command_spawn_failed: never a fake 200 with a null code', async () => {
  const history = new CommandHistory(5, clock().now);
  const result = await sendIntent('no-such-binary --flag', {
    channel: refusalChannel(502, 'command_spawn_failed', 'spawn no-such-binary ENOENT'),
    history,
    logger: collectingLogger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'command_spawn_failed');
  assert.equal(result.message, COMMAND_SPAWN_FAILED_COPY);
  assert.match(result.message, /no pudo arrancar/);
  assert.equal(result.status, 502);
  assert.match(result.raw, /ENOENT/);
  assert.equal(history.size(), 0);
});

test('(f) a non-zero exit code is a real result with the danger tone', async () => {
  const history = new CommandHistory(5, clock().now);
  const channel = recordingChannel({
    id: 'cmd-fail-1',
    exitCode: 1,
    output: `${ESC}[31mfail${ESC}[0m\n`,
  });
  const result = await sendIntent('bun test', { channel, history, logger: collectingLogger() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.exit, { label: 'exit 1', tone: 'danger' });
  // Display-ready output: escapes gone, the real exit code kept.
  assert.equal(result.output.text, 'fail\n');
  assert.equal(result.entry.exitCode, 1);

  const vm = buildTerminalView({ kind: 'empty' }, history.entries());
  assert.deepEqual(vm.rows.map((row) => [row.exit.label, row.exit.tone]), [['exit 1', 'danger']]);
  assert.equal(vm.pane.exit.tone, 'danger');
  assert.equal(vm.pane.output.text, 'fail\n');
  // The transcript tone follows the same real code.
  const ended = transcriptState(
    history.entries().map((entry) => ({ ...entry, at: T0 })),
    { now: T0 },
  );
  assert.equal(ended.tone, 'danger');
  assert.deepEqual(ended.exit, { label: 'exit 1', tone: 'danger' });
});

test('(g) no tunnel: the send fails offline without a request or a ring entry', async () => {
  const history = new CommandHistory(5, clock().now);
  const logger = collectingLogger();
  const result = await sendIntent('ls', { channel: null, history, logger });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'offline');
  assert.equal(result.message, SEND_OFFLINE_COPY);
  assert.match(result.message, /no salió del teléfono/);
  // The phone could not reach the PC: the card never blames the PC.
  assert.equal(result.blame, 'link');
  assert.equal(result.title, SEND_UNREACHABLE_TITLE);
  assert.equal(result.note, null);
  assert.equal(history.size(), 0);
  assert.equal(logger.failures.length, 1);
  assert.equal(logger.failures[0].step, 'exec-send');

  // A tunnel that refuses the write is offline too, with its raw evidence.
  const refused = await sendIntent('ls', { channel: refusedChannel(), history, logger });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'offline');
  assert.equal(history.size(), 0);
});

test('(g) a silent tunnel is a timeout that never claims the command did not run', async () => {
  const history = new CommandHistory(5, clock().now);
  const result = await sendIntent('sleep 40', {
    channel: silentChannel(),
    history,
    timeoutMs: 20,
    logger: collectingLogger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.message, SEND_TIMEOUT_COPY);
  assert.match(result.message, /pudo haber corrido/);
  assert.equal(result.blame, 'link');
  assert.equal(history.size(), 0);
});

test('(g) a broken 200 body is never a fabricated result', async () => {
  const history = new CommandHistory(5, clock().now);
  const bodies = [
    { id: 'x' },
    { id: 'x', exitCode: 1.5, output: null },
    { id: 'x', exitCode: 0, output: 7 },
  ];
  for (const body of bodies) {
    const result = await sendIntent('ls', {
      channel: recordingChannel(body),
      history,
      logger: collectingLogger(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'broken');
    assert.equal(result.message, SEND_BROKEN_COPY);
    assert.match(result.note, /revisá el historial/);
  }
  assert.equal(history.size(), 0);
});

test('(h) the request really is POST /api/exec with the JSON body on the wire', async () => {
  const history = new CommandHistory(5, clock().now);
  const channel = recordingChannel({ id: 'cmd-1', exitCode: 0, output: 'x\n' });
  const result = await sendIntent('  ls -la "mi carpeta"  ', {
    channel,
    history,
    logger: collectingLogger(),
  });
  assert.equal(result.ok, true);

  assert.equal(channel.writes.length, 1);
  const wire = channel.writes[0];
  const body = JSON.stringify({ command: 'ls -la "mi carpeta"' });
  assert.match(wire, /^POST \/api\/exec HTTP\/1\.1\r\n/);
  assert.equal(/^GET /.test(wire), false);
  assert.match(wire, /Content-Type: application\/json\r\n/);
  assert.ok(wire.includes(`Content-Length: ${Buffer.byteLength(body)}\r\n`));
  // The body is the trimmed command, exactly once, after the blank line.
  assert.ok(wire.endsWith(`\r\n\r\n${body}`));
  assert.equal(wire.split('{"command"').length - 1, 1);
});

test('SENDING_COPY is the real progress line of the dock', () => {
  assert.equal(SENDING_COPY, 'Enviando…');
});

test('the stale "endpoint not served" claim is gone from the module', async () => {
  const terminal = await import('../lib/terminal.ts');
  assert.equal('SEND_PENDING_NOTE' in terminal, false);
  // Nothing in the exported copy still says the endpoint does not exist.
  for (const [name, value] of Object.entries(terminal)) {
    if (typeof value !== 'string') continue;
    assert.equal(/todavía no expone POST \/api\/exec/i.test(value), false, name);
    assert.equal(/todavía no está conectado/i.test(value), false, name);
  }
  assert.equal(/todavía no expone POST/i.test(terminal.NOT_SENT_REASON), false);
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

/* ------------------------------------------------------------------ *
 * T7n — transcript derived from the real history only
 * ------------------------------------------------------------------ */

/** One real history entry (the shape `GET /api/exec/history` serves). */
const realEntry = (extra = {}) => ({
  id: 'cmd-1',
  command: 'bun test',
  at: Date.parse('2026-11-18T14:32:00.000Z'),
  status: 'sent',
  exitCode: 0,
  output: null,
  ...extra,
});

const T0 = Date.parse('2026-11-18T14:32:00.000Z');

test('(a) transcript: a pending newest entry is running with the real elapsed time', () => {
  const entries = [
    realEntry({ id: 'c1', command: 'ls', at: T0, status: 'sent', exitCode: 0 }),
    realEntry({ id: 'c2', command: 'bun test', at: T0 + 30_000, status: 'pending', exitCode: null }),
  ];
  const state = transcriptState(entries, { now: T0 + 42_000 });

  assert.equal(state.kind, 'running');
  assert.equal(state.label, RUNNING_LABEL);
  assert.equal(state.label, 'en curso');
  assert.equal(state.tone, 'running');
  // Elapsed is measured from the pending entry's real stamp, not invented.
  assert.equal(state.timeLabel, 'hace');
  assert.equal(state.time, '12 segundos');
  assert.equal(state.exit, null);
  assert.equal(state.command, 'bun test');
  assert.equal(state.from, 2);

  // A clock that went backwards never reads a negative elapsed time.
  assert.equal(transcriptState(entries, { now: T0 }).time, '0 segundos');
});

test('(a) transcript: an older pending entry does not keep a finished session running', () => {
  const entries = [
    realEntry({ id: 'c1', command: 'git status', at: T0, status: 'pending', exitCode: null }),
    realEntry({ id: 'c2', command: 'ls', at: T0 + 1_000, status: 'sent', exitCode: 0 }),
  ];
  assert.equal(transcriptState(entries, { now: T0 + 60_000 }).kind, 'ended');
});

test('(b) transcript: a sent exit 0 entry is ended with the ok chip', () => {
  const entries = [
    realEntry({ id: 'c1', command: 'ls', at: T0 }),
    realEntry({ id: 'c2', command: 'pwd', at: T0 + 60_000 }),
  ];
  const state = transcriptState(entries, { now: T0 + 600_000 });

  assert.equal(state.kind, 'ended');
  assert.equal(state.label, ENDED_LABEL);
  assert.equal(state.label, 'terminado');
  assert.equal(state.tone, 'ok');
  assert.deepEqual(state.exit, { label: 'exit 0', tone: 'ok' });
  // The span between the first and the last real stamp, never a guess.
  assert.equal(state.timeLabel, 'duró');
  assert.equal(state.time, '1 minuto');
  assert.equal(state.command, 'pwd');

  // One single entry has no span: no duration is invented.
  const single = transcriptState([realEntry({ id: 'c9' })], { now: T0 + 60_000 });
  assert.equal(single.kind, 'ended');
  assert.equal(single.time, null);
  assert.equal(single.timeLabel, null);
});

test('(c) transcript: a failed entry is ended with the danger chip', () => {
  const failed = transcriptState(
    [realEntry({ id: 'c1', command: 'bun test', status: 'failed', exitCode: 2 })],
    { now: T0 + 5_000 },
  );
  assert.equal(failed.kind, 'ended');
  assert.equal(failed.tone, 'danger');
  assert.deepEqual(failed.exit, { label: 'exit 2', tone: 'danger' });

  // A failed command without a code keeps the neutral chip, not an invented 1.
  const noCode = transcriptState(
    [realEntry({ id: 'c1', status: 'failed', exitCode: null })],
    { now: T0 },
  );
  assert.equal(noCode.kind, 'ended');
  assert.equal(noCode.tone, 'neutral');
  assert.deepEqual(noCode.exit, { label: 'sin código', tone: 'neutral' });
});

test('(d) transcript: empty history is idle, never running', () => {
  const state = transcriptState([], { now: T0 });
  assert.equal(state.kind, 'idle');
  assert.equal(state.label, IDLE_LABEL);
  assert.equal(state.kind === 'running', false);
  assert.equal(state.time, null);
  assert.equal(state.timeLabel, null);
  assert.equal(state.exit, null);
  assert.equal(state.command, null);
  assert.equal(state.from, 0);

  // The same evidence through the view model: an empty history is idle.
  assert.equal(buildTerminalView({ kind: 'empty' }).transcript.kind, 'idle');
});

test('(e) no agent data: the honest reason, and no fabricated waiting state', () => {
  assert.equal(AGENT_NOTE, 'sin eventos del agente');
  assert.deepEqual([...TRANSCRIPT_STATES], ['running', 'ended', 'idle']);
  assert.equal(TRANSCRIPT_STATES.includes('waiting'), false);
  // The reason names the real gap: command history, no agent stream, V9 owns it.
  assert.match(NO_AGENT_REASON, /no expone/);
  assert.match(NO_AGENT_REASON, /V9/);
  assert.match(NO_AGENT_REASON, /\/api\/exec\/history/);
  assert.equal(/esperando al agente/i.test(NO_AGENT_REASON), false);

  const samples = [
    [],
    [realEntry({ id: 'p1', status: 'pending', exitCode: null })],
    [realEntry({ id: 's1', status: 'sent', exitCode: 0 })],
    [realEntry({ id: 'f1', status: 'failed', exitCode: 1 })],
  ];
  for (const entries of samples) {
    const state = transcriptState(entries, { now: T0 + 1_000 });
    assert.equal(state.agentNote, AGENT_NOTE);
    assert.equal(state.agentReason, NO_AGENT_REASON);
    // Only evidence-backed states, and the state carries no waiting kind at all.
    assert.ok(TRANSCRIPT_STATES.includes(state.kind));
    assert.equal('waiting' in state, false);
  }

  const vm = buildTerminalView({ kind: 'success', entries: [realEntry()] });
  assert.equal(vm.transcript.agentNote, AGENT_NOTE);
  assert.equal(vm.transcript.agentReason, NO_AGENT_REASON);
  assert.equal(vm.transcript.kind, 'ended');
});

test('(f) agent header: pi · <model> only when the payload carries a real model', async () => {
  // The served history has no model field: the header stays `shell`.
  const plain = await loadHistory(okChannel(PAYLOAD), { logger: collectingLogger() });
  const shell = buildTerminalView(plain).transcript.agent;
  assert.equal(shell.agent, 'pi');
  assert.equal(shell.model, null);
  assert.equal(shell.label, 'shell');

  // A real model in the payload is the only thing that names the agent.
  const carried = await loadHistory(okChannel({ model: 'opus-4.5', commands: PAYLOAD.commands }), {
    logger: collectingLogger(),
  });
  const named = buildTerminalView(carried).transcript.agent;
  assert.equal(named.agent, 'pi');
  assert.equal(named.model, 'opus-4.5');
  assert.equal(named.label, 'pi · opus-4.5');

  // Anything that is not a usable model name never becomes a header.
  for (const bad of [null, undefined, '', '   ', 42, {}, []]) {
    assert.equal(agentHeader(bad).label, 'shell');
    assert.equal(agentHeader(bad).model, null);
  }
  assert.equal(agentHeader(' opus-4.5 ').label, 'pi · opus-4.5');
});

test('(g) transcript events follow the real `at` ascending, whatever the array order', () => {
  const entries = [
    realEntry({ id: 'c3', command: 'git status', at: T0 + 120_000 }),
    realEntry({
      id: 'c1',
      command: 'ls',
      at: T0,
      output: `${ESC}[32mok${ESC}[0m\n`,
    }),
    realEntry({
      id: 'c2',
      command: 'bun test',
      at: T0 + 60_000,
      status: 'failed',
      exitCode: 1,
      output: 'boom\n',
    }),
  ];
  const events = transcriptEvents(entries);

  const times = events.map((event) => event.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(
    events.filter((event) => event.kind === 'command').map((event) => event.command),
    ['ls', 'bun test', 'git status'],
  );
  // One command event per entry, plus its output (only when it produced one)
  // and its status line, in that order for the same real stamp.
  assert.deepEqual(
    events.map((event) => event.kind),
    ['command', 'output', 'status', 'command', 'output', 'status', 'command', 'status'],
  );
  // Output is display-ready: escapes stripped, newlines kept, real glyphs.
  assert.equal(events[0].text, 'ls');
  assert.equal(events[0].glyph, '$');
  assert.equal(events[1].text, 'ok\n');
  assert.match(events[1].atLabel, /^\d{2}:\d{2}$/);
  assert.equal(events[4].text, 'boom\n');
  assert.deepEqual(events[5].exit, { label: 'exit 1', tone: 'danger' });
  assert.equal(events[5].statusLabel, 'falló');
  assert.deepEqual(events[7].exit, { label: 'exit 0', tone: 'ok' });
  // Keys are unique and stable, and the caller's array is left untouched.
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['c3', 'c1', 'c2'],
  );

  // A long output is truncated with the existing marker, never silently cut.
  const long = transcriptEvents([realEntry({ id: 'long', output: 'x'.repeat(25) })], 10);
  const output = long.find((event) => event.kind === 'output');
  assert.equal(output.truncated, true);
  assert.equal(output.hidden, 15);
  assert.match(output.text, /truncado: 15 caracteres ocultos/);

  // No entries, no events: nothing is invented between entries.
  assert.deepEqual(transcriptEvents([]), []);
});

test('(h) duration copy: singular/plural, and a capped ceiling', () => {
  assert.equal(durationCopy(0), '0 segundos');
  assert.equal(durationCopy(1_000), '1 segundo');
  assert.equal(durationCopy(45_000), '45 segundos');
  assert.equal(durationCopy(60_000), '1 minuto');
  assert.equal(durationCopy(120_000), '2 minutos');
  assert.equal(durationCopy(90_000), '1 minuto 30 segundos');
  assert.equal(durationCopy(3_600_000), '1 hora');
  assert.equal(durationCopy(2 * 3_600_000 + 5 * 60_000), '2 horas 5 minutos');
  // Capped: an absurd span reads as a ceiling, never as an invented precision.
  assert.equal(durationCopy(24 * 3_600_000), 'más de 24 horas');
  assert.equal(durationCopy(72 * 3_600_000), DURATION_CAP_COPY);
  // A clock that went backwards or a broken number never reads negative/NaN.
  assert.equal(durationCopy(-5_000), '0 segundos');
  assert.equal(durationCopy(Number.NaN), '0 segundos');
});

test('PRESERVE: the model the PC named survives the cache on a stale read', async () => {
  const { HistoryCache } = await import('../lib/terminal.ts');
  const time = clock();
  const cache = new HistoryCache(time.now);
  const logger = collectingLogger();

  await loadHistory(okChannel({ model: 'opus-4.5', commands: PAYLOAD.commands }), { cache, logger });
  time.advance(2 * 60_000);
  const state = await loadHistory(silentChannel(), { cache, logger, timeoutMs: 20 });
  assert.equal(state.kind, 'stale');

  const vm = buildTerminalView(state, [], Date.parse('2026-11-18T14:32:00.000Z') + 120_000);
  assert.deepEqual(
    vm.rows.map((row) => [row.command, row.exit.label]),
    [
      ['ls -la', 'exit 0'],
      ['bun test', 'exit 1'],
      ['git status', 'sin código'],
    ],
  );
  assert.equal(vm.pane.command, 'bun test');
  assert.equal(vm.staleChip, 'Datos de hace 2 min');
  // The shared PAYLOAD ends in a `pending` entry: the transcript is running.
  assert.equal(vm.transcript.kind, 'running');
  assert.equal(vm.transcript.time, '2 minutos');
  assert.equal(vm.transcript.agent.label, 'pi · opus-4.5');
});

test('PRESERVE: non-sent local commands never enter the transcript events', async () => {
  const state = await loadHistory(okChannel(PAYLOAD), { logger: collectingLogger() });
  const history = new CommandHistory(5, clock().now);
  history.append({ command: 'rm -rf dist' });

  const vm = buildTerminalView(state, history.entries());
  assert.equal(vm.notSent.length, 1);
  assert.deepEqual(
    [...new Set(vm.events.filter((event) => event.kind === 'command').map((event) => event.command))],
    ['ls -la', 'bun test', 'git status'],
  );
  assert.equal(
    vm.events.some((event) => event.text.includes('rm -rf dist')),
    false,
  );
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
