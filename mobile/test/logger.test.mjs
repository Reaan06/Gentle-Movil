import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOG_CAPACITY,
  LOG_ROTATE_BYTES,
  createLogger,
  describeError,
  failureData,
  levelRank,
  logPathFor,
  ringAppend,
  rotatedPathFor,
  rotationDecision,
  serializeEntry,
  shouldWrite,
} from '../lib/logger.ts';

/**
 * Contract of the structured logger (V3 support, `mobile/lib/logger.ts`).
 *
 * The logger is the only place the app records backend failures, so these tests
 * pin: the in-memory ring (last 500 entries, oldest dropped), the level gate,
 * the exact one-line serialization, the rotation decision at 512 KB, the
 * `{step, error, raw}` failure shape, and the sink wiring (errors persist,
 * other levels never touch the file). The file sink is injected, so nothing
 * here needs a React Native runtime or a real filesystem.
 */

/** Mock sink that records every operation in call order. */
function recordingSink(initialSize = 0) {
  const ops = [];
  return {
    ops,
    async size(path) {
      ops.push({ op: 'size', path });
      return initialSize;
    },
    async append(path, line) {
      ops.push({ op: 'append', path, line });
    },
    async rotate(path) {
      ops.push({ op: 'rotate', path });
    },
  };
}

test('ring buffer keeps the newest entries and drops the oldest', () => {
  let buffer = [];
  for (let i = 0; i < 4; i += 1) {
    buffer = ringAppend(buffer, i, 3);
  }
  assert.deepEqual(buffer, [1, 2, 3]);
});

test('ring buffer capacity defaults to 500 entries', () => {
  assert.equal(LOG_CAPACITY, 500);
  let buffer = [];
  for (let i = 0; i < 700; i += 1) {
    buffer = ringAppend(buffer, i);
  }
  assert.equal(buffer.length, 500);
  assert.equal(buffer[0], 200);
  assert.equal(buffer[499], 699);
});

test('ringAppend never mutates the buffer it receives', () => {
  const before = [1, 2];
  const after = ringAppend(before, 3, 2);
  assert.deepEqual(before, [1, 2]);
  assert.deepEqual(after, [2, 3]);
});

test('level gate suppresses entries below the minimum level', () => {
  assert.deepEqual(LOG_CAPACITY > 0, true);
  assert.equal(shouldWrite('debug', 'debug'), true);
  assert.equal(shouldWrite('debug', 'info'), false);
  assert.equal(shouldWrite('info', 'warn'), false);
  assert.equal(shouldWrite('warn', 'info'), true);
  assert.equal(shouldWrite('error', 'debug'), true);
  assert.deepEqual(levelRank, { debug: 0, info: 1, warn: 2, error: 3 });
});

test('serializeEntry writes a single JSON line with an ISO timestamp', () => {
  const line = serializeEntry({
    ts: 1_766_000_000_000,
    level: 'error',
    tag: 'pairing',
    msg: 'falló el paso',
    data: { step: 'upload' },
  });
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.trimEnd().includes('\n'), false, 'a log record is exactly one line');
  const parsed = JSON.parse(line.trimEnd());
  assert.deepEqual(parsed, {
    ts: 1_766_000_000_000,
    at: new Date(1_766_000_000_000).toISOString(),
    level: 'error',
    tag: 'pairing',
    msg: 'falló el paso',
    data: { step: 'upload' },
  });
});

test('serializeEntry omits data when the entry carries none', () => {
  const parsed = JSON.parse(serializeEntry({ ts: 0, level: 'info', tag: 'app', msg: 'listo' }));
  assert.equal('data' in parsed, false);
});

test('rotationDecision appends below the limit and rotates when the line would cross it', () => {
  assert.equal(LOG_ROTATE_BYTES, 512 * 1024);
  assert.equal(rotationDecision(0, 10), 'append');
  assert.equal(rotationDecision(LOG_ROTATE_BYTES - 10, 5), 'append');
  assert.equal(rotationDecision(LOG_ROTATE_BYTES - 10, 10), 'append', 'exactly at the limit still appends');
  assert.equal(rotationDecision(LOG_ROTATE_BYTES - 10, 11), 'rotate-first');
  assert.equal(rotationDecision(LOG_ROTATE_BYTES, 1), 'rotate-first');
});

test('describeError normalizes Error, core kind objects and plain strings', () => {
  assert.deepEqual(describeError(new TypeError('boom')), { name: 'TypeError', message: 'boom' });
  assert.deepEqual(describeError({ kind: 'CoreUnavailable', message: 'no lib' }), {
    name: 'CoreUnavailable',
    message: 'no lib',
  });
  assert.deepEqual(describeError({ kind: 'Closed' }), { name: 'Closed', message: '' });
  assert.deepEqual(describeError('sin conexión'), { name: 'Error', message: 'sin conexión' });
  assert.deepEqual(describeError(undefined), { name: 'Error', message: 'undefined' });
});

test('failureData always produces the {step, error, raw} shape', () => {
  const data = failureData('upload', new Error('checksum'), '{"raw":1}');
  assert.deepEqual(data, {
    step: 'upload',
    error: { name: 'Error', message: 'checksum' },
    raw: '{"raw":1}',
  });
  assert.equal(failureData('verify', new Error('bad'), undefined).raw, null, 'raw defaults to null');
});

test('logPathFor and rotatedPathFor build the document-directory paths', () => {
  assert.equal(logPathFor('file:///docs/'), 'file:///docs/logs/gentle-movil.log');
  assert.equal(logPathFor('file:///docs'), 'file:///docs/logs/gentle-movil.log');
  assert.equal(rotatedPathFor('file:///docs/logs/gentle-movil.log'), 'file:///docs/logs/gentle-movil.log.1');
});

test('the logger keeps entries in memory and mirror is optional', async () => {
  const log = createLogger({ console: false, now: () => 1_766_000_000_000 });
  log.info('hola');
  log.error('rompió', { step: 'detect' });
  const entries = log.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, 'info');
  assert.equal(entries[1].level, 'error');
  assert.equal(entries[1].tag, 'app');
});

test('entries below the minimum level never reach the ring', () => {
  const log = createLogger({ console: false, min: 'warn' });
  log.debug('ruido');
  log.info('ruido');
  log.warn('vale');
  assert.deepEqual(
    log.entries().map((entry) => entry.level),
    ['warn'],
  );
});

test('the scoped logger writes to the same ring with its own tag', () => {
  const log = createLogger({ console: false, tag: 'app' });
  const scoped = log.tag('provision');
  scoped.error('falló');
  log.info('sigue');
  assert.deepEqual(
    log.entries().map((entry) => [entry.tag, entry.msg]),
    [
      ['provision', 'falló'],
      ['app', 'sigue'],
    ],
  );
});

test('error entries are persisted through the injected sink, in order', async () => {
  const sink = recordingSink();
  const log = createLogger({
    console: false,
    sink,
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
    now: () => 1_766_000_000_000,
  });
  log.error('uno');
  log.error('dos');
  await log.flush();
  const appends = sink.ops.filter((entry) => entry.op === 'append');
  assert.equal(appends.length, 2);
  assert.equal(JSON.parse(appends[0].line).msg, 'uno');
  assert.equal(JSON.parse(appends[1].line).msg, 'dos');
  assert.equal(appends[0].path, 'file:///docs/logs/gentle-movil.log');
});

test('non-error levels never touch the log file', async () => {
  const sink = recordingSink();
  const log = createLogger({
    console: false,
    sink,
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
  });
  log.debug('a');
  log.info('b');
  log.warn('c');
  await log.flush();
  assert.deepEqual(sink.ops, []);
});

test('an error line that would cross 512 KB rotates the file before appending', async () => {
  const sink = recordingSink(LOG_ROTATE_BYTES - 10);
  const log = createLogger({
    console: false,
    sink,
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
    now: () => 1_766_000_000_000,
  });
  log.error('línea larga', { padding: 'x'.repeat(40) });
  await log.flush();
  const order = sink.ops.map((entry) => entry.op);
  assert.deepEqual(order, ['size', 'rotate', 'append']);
  assert.equal(sink.ops[1].path, 'file:///docs/logs/gentle-movil.log');
});

test('a small error line below the limit does not rotate', async () => {
  const sink = recordingSink(1000);
  const log = createLogger({
    console: false,
    sink,
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
  });
  log.error('chico');
  await log.flush();
  assert.deepEqual(
    sink.ops.map((entry) => entry.op),
    ['size', 'append'],
  );
});

test('logger.failure records logger.error with the {step, error, raw} shape', async () => {
  const sink = recordingSink();
  const log = createLogger({
    console: false,
    sink,
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
  });
  log.failure('upload', { kind: 'ChecksumMismatch', message: 'El checksum del daemon no coincide' }, '{"exit":1}');
  await log.flush();
  const entry = log.entries()[0];
  assert.equal(entry.level, 'error');
  assert.deepEqual(entry.data, {
    step: 'upload',
    error: { name: 'ChecksumMismatch', message: 'El checksum del daemon no coincide' },
    raw: '{"exit":1}',
  });
  assert.equal(JSON.parse(sink.ops[1].line).data.step, 'upload');
});

test('a failing sink never rejects the caller nor the flush', async () => {
  const log = createLogger({
    console: false,
    sink: {
      async size() {
        throw new Error('EACCES');
      },
      async append() {
        throw new Error('EACCES');
      },
      async rotate() {
        throw new Error('EACCES');
      },
    },
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
  });
  assert.doesNotThrow(() => log.error('aun así'));
  await log.flush();
  assert.equal(log.entries().length, 1);
});

test('the ring survives 600 errors and keeps the newest 500', async () => {
  const sink = recordingSink();
  const log = createLogger({
    console: false,
    sink,
    resolveLogPath: async () => 'file:///docs/logs/gentle-movil.log',
  });
  for (let i = 0; i < 600; i += 1) {
    log.error(`fallo ${i}`);
  }
  const entries = log.entries();
  assert.equal(entries.length, 500);
  assert.equal(entries[0].msg, 'fallo 100');
  assert.equal(entries[499].msg, 'fallo 599');
});
