import test from 'node:test';
import assert from 'node:assert/strict';

import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../lib/core.ts';
import {
  CHANNEL_READ_TIMEOUT_MS,
  EXTENSION_HTTP_PORT,
  EXTENSION_WS_PORT,
  GC_FUNCTIONS,
  base64Encode as provisionBase64Encode,
  channelClose,
  channelRead,
  channelWrite,
  closeTunnel,
  httpOverTunnel,
  inspectHttpResponse,
  parseTunnelChannels,
  tunnelChannelFor,
} from '../lib/provision.ts';

/**
 * Contract of the tunnel channel I/O (`mobile/lib/core.ts` bindings +
 * `mobile/lib/provision.ts` helpers, `odd/tasks/gentle-movil-pivote.md` S4/S7).
 *
 * The `tunnel` step opens one SSH `direct-tcpip` channel per loopback port and
 * reports each handle as `channel_id`. The app talks HTTP/WS through those
 * handles with `gc_ssh_channel_write` / `gc_ssh_channel_read` /
 * `gc_ssh_channel_close`; these tests pin the byte codec, the request/response
 * exchange, and the honest failure of every channel that is closed, unknown,
 * silent or malformed — all offline, over a scripted bridge.
 */

/** Tunnel the core reported after `tunnel` (session 7, ports 43721/43722). */
const TUNNEL = {
  sessionId: '7',
  channels: [
    { host: '127.0.0.1', port: EXTENSION_HTTP_PORT, channelId: 11 },
    { host: '127.0.0.1', port: EXTENSION_WS_PORT, channelId: 12 },
  ],
};

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** One scripted read answer: text, an empty timeout, eof, or an error envelope. */
function frame(spec) {
  if (typeof spec === 'string') {
    return { bytes: b64(spec), eof: false };
  }
  if (spec.empty === true) {
    return { bytes: '', eof: false };
  }
  if (spec.eof === true) {
    return { bytes: '', eof: true };
  }
  if (spec.error) {
    return { error: spec.error };
  }
  return { bytes: spec.base64 ?? '', eof: spec.eof === true };
}

/** Fake bridge: answers the three channel calls from a scripted read queue. */
function scriptedBridge(frames = []) {
  const pending = frames.map(frame);
  const calls = [];
  return {
    calls,
    pending,
    async call(fn, payloadJson) {
      const payload = JSON.parse(payloadJson);
      calls.push({ fn, payload });
      if (fn === GC_FUNCTIONS.channelWrite) {
        return JSON.stringify({ ok: true, result: { written: Buffer.from(payload.bytes, 'base64').length } });
      }
      if (fn === GC_FUNCTIONS.channelClose) {
        return JSON.stringify({ ok: true, result: { closed: true } });
      }
      if (fn !== GC_FUNCTIONS.channelRead) {
        throw new Error(`unexpected bridge call ${fn}`);
      }
      const next = pending.length > 0 ? pending.shift() : { bytes: '', eof: true };
      if (next.error) {
        return JSON.stringify({ ok: false, error: next.error, raw: null });
      }
      return JSON.stringify({ ok: true, result: { bytes: next.bytes, eof: next.eof } });
    },
  };
}

/** Fake logger recording every failure call. */
function fakeLogger() {
  const failures = [];
  return {
    failures,
    failure(step, error, raw) {
      failures.push({ step, error, raw });
    },
    info() {},
  };
}

/** The one response the exchange tests read. */
const BODY = '{"ok":true,"sessions":[]}';
const RESPONSE = [
  'HTTP/1.1 200 OK',
  'Content-Type: application/json',
  `Content-Length: ${Buffer.byteLength(BODY)}`,
  '',
  BODY,
].join('\r\n');

const REQUEST = 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n';

/* ------------------------------------------------------------------ *
 * Byte payloads (base64 on the ABI, S4)
 * ------------------------------------------------------------------ */

test('base64 round-trips every byte payload the channel carries', () => {
  const samples = [
    new Uint8Array(0),
    Uint8Array.of(0),
    Uint8Array.of(0, 255, 254),
    Uint8Array.of(255, 255, 255),
    Uint8Array.from({ length: 256 }, (_, index) => index),
    Uint8Array.from(utf8Encode('Ñ ✓ 🙂 \r\n')),
  ];
  for (const bytes of samples) {
    const encoded = base64Encode(bytes);
    // Standard padded base64, byte for byte the encoding the Rust core uses.
    assert.equal(encoded, Buffer.from(bytes).toString('base64'), `encodes ${bytes.length} bytes as standard base64`);
    assert.equal(
      provisionBase64Encode(bytes),
      encoded,
      'the flow module and the core contract cannot drift apart on the encoding',
    );
    assert.deepEqual(Array.from(base64Decode(encoded)), Array.from(bytes), `decodes ${bytes.length} bytes back`);
  }
  // The core may answer unpadded, and a caller may paste it with whitespace.
  assert.deepEqual(Array.from(base64Decode('AQI')), [1, 2]);
  assert.deepEqual(Array.from(base64Decode('AQ ID\r\n')), [1, 2, 3]);
  assert.deepEqual(Array.from(base64Decode('')), []);
});

test('a malformed base64 frame is a typed Frame error, never a silent empty payload', () => {
  for (const bad of ['@@@', 'AQ*I', 'A', '====', 'AQID=']) {
    assert.throws(
      () => base64Decode(bad),
      (error) => error.kind === 'Frame' && typeof error.message === 'string' && error.message.length > 0,
      `${JSON.stringify(bad)} is refused`,
    );
  }
});

test('utf8 helpers need no TextEncoder (Hermes has none)', () => {
  for (const text of ['', 'GET / HTTP/1.1', 'Ñ ✓ 🙂', 'a'.repeat(1000)]) {
    assert.deepEqual(Array.from(utf8Encode(text)), Array.from(Buffer.from(text, 'utf8')));
    assert.equal(utf8Decode(Buffer.from(text, 'utf8')), text);
  }
  // A lone surrogate never throws; it becomes the replacement character.
  assert.equal(utf8Decode(utf8Encode('\ud800')), '\ufffd');
});

/* ------------------------------------------------------------------ *
 * The three bindings (write / read / close)
 * ------------------------------------------------------------------ */

test('the bindings carry the session and channel handles the tunnel reported', async () => {
  const bridge = scriptedBridge([{ empty: true }]);
  const channel = TUNNEL.channels[0];

  const written = await channelWrite(TUNNEL.sessionId, channel, utf8Encode(REQUEST), { call: bridge.call });
  assert.deepEqual(written, { ok: true, written: REQUEST.length });
  assert.equal(bridge.calls[0].fn, GC_FUNCTIONS.channelWrite);
  assert.equal(bridge.calls[0].payload.sessionId, 7);
  assert.equal(bridge.calls[0].payload.channelId, 11);
  assert.equal(Buffer.from(bridge.calls[0].payload.bytes, 'base64').toString('utf8'), REQUEST);

  const read = await channelRead(TUNNEL.sessionId, channel, 0, { call: bridge.call });
  assert.deepEqual(read, { ok: true, bytes: new Uint8Array(0), eof: false });
  assert.equal(bridge.calls[1].fn, GC_FUNCTIONS.channelRead);
  assert.equal(bridge.calls[1].payload.timeoutMs, 0);

  const closed = await channelClose(TUNNEL.sessionId, channel, { call: bridge.call });
  assert.deepEqual(closed, { ok: true });
  assert.equal(bridge.calls[2].fn, GC_FUNCTIONS.channelClose);
  assert.equal(bridge.calls[2].payload.channelId, 11);
});

test('an empty write is refused as input before it reaches the core', async () => {
  const bridge = scriptedBridge();
  const refused = await channelWrite(TUNNEL.sessionId, TUNNEL.channels[0], new Uint8Array(0), { call: bridge.call });

  assert.equal(refused.ok, false);
  assert.equal(refused.error.kind, 'Input');
  assert.deepEqual(bridge.calls, [], 'nothing is sent on the wire');
});

/* ------------------------------------------------------------------ *
 * Request/response over the tunnel (S4)
 * ------------------------------------------------------------------ */

test('a request/response exchange writes the request then reads until the response is complete', async () => {
  const bridge = scriptedBridge([{ empty: true }, RESPONSE.slice(0, 48), RESPONSE.slice(48)]);

  const result = await httpOverTunnel(TUNNEL, EXTENSION_HTTP_PORT, REQUEST, { deps: { call: bridge.call } });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(utf8Decode(result.response), RESPONSE, 'the whole response is assembled in order');
  assert.equal(result.complete, true);
  assert.equal(result.eof, false);
  assert.equal(result.frames, 3);

  // Write first, on the channel of that port, then read the same channel.
  assert.equal(bridge.calls[0].fn, GC_FUNCTIONS.channelWrite);
  assert.equal(bridge.calls[0].payload.channelId, 11);
  assert.deepEqual(
    bridge.calls.slice(1).map((entry) => entry.fn),
    [GC_FUNCTIONS.channelRead, GC_FUNCTIONS.channelRead, GC_FUNCTIONS.channelRead],
    'one read per frame: write, then keep reading until Content-Length is satisfied',
  );
  for (const call of bridge.calls.slice(1)) {
    assert.equal(call.payload.sessionId, 7);
    assert.equal(call.payload.channelId, 11);
    assert.equal(call.payload.timeoutMs, CHANNEL_READ_TIMEOUT_MS);
  }
});

test('a read timeout is an empty frame with eof:false, not an error', async () => {
  // First read answers the core's own timeout outcome, second one delivers the body.
  const bridge = scriptedBridge([{ empty: true }, { empty: true }, RESPONSE]);

  const result = await httpOverTunnel(TUNNEL, EXTENSION_HTTP_PORT, REQUEST, { deps: { call: bridge.call } });

  assert.equal(result.ok, true, 'a timeout inside the exchange is not a failure');
  assert.equal(utf8Decode(result.response), RESPONSE);
  assert.equal(result.frames, 3);

  // The primitive reports the timeout verbatim: empty bytes, no eof, no error.
  const poll = await channelRead(TUNNEL.sessionId, TUNNEL.channels[0], 0, { call: scriptedBridge([{ empty: true }]).call });
  assert.deepEqual(poll, { ok: true, bytes: new Uint8Array(0), eof: false });
});

test('a response with no framing headers is complete when the peer closes the channel', async () => {
  const head = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n';
  const bridge = scriptedBridge([head + 'hola', { eof: true }]);

  const result = await httpOverTunnel(TUNNEL, EXTENSION_HTTP_PORT, REQUEST, { deps: { call: bridge.call } });

  assert.equal(result.ok, true);
  assert.equal(result.eof, true);
  assert.equal(result.complete, true);
  assert.equal(utf8Decode(result.response), `${head}hola`);
});

test('a port the tunnel never opened fails before any byte is written', async () => {
  const bridge = scriptedBridge();

  const result = await httpOverTunnel(TUNNEL, 9999, REQUEST, { deps: { call: bridge.call } });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'NoChannel');
  assert.match(result.error.message, /9999/);
  assert.deepEqual(bridge.calls, []);
});

/* ------------------------------------------------------------------ *
 * Honest failures of a channel (S7)
 * ------------------------------------------------------------------ */

test('an unknown channel surfaces the core reason and stops the exchange', async () => {
  const logger = fakeLogger();
  const bridge = scriptedBridge([
    { error: { kind: 'ssh', message: 'ssh: unknown channel id 99' } },
  ]);
  const stale = { sessionId: '7', channels: [{ host: '127.0.0.1', port: EXTENSION_HTTP_PORT, channelId: 99 }] };

  const result = await httpOverTunnel(stale, EXTENSION_HTTP_PORT, REQUEST, {
    deps: { call: bridge.call, logger },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { kind: 'ssh', message: 'ssh: unknown channel id 99' });
  assert.deepEqual(logger.failures, [
    {
      step: 'channel',
      error: { kind: 'ssh', message: 'ssh: unknown channel id 99' },
      raw: { port: EXTENSION_HTTP_PORT, channelId: 99, raw: null },
    },
  ]);
});

test('a channel call that never answers is bounded instead of hanging forever', async () => {
  const logger = fakeLogger();
  const started = Date.now();
  const result = await httpOverTunnel(TUNNEL, EXTENSION_HTTP_PORT, REQUEST, {
    deps: { call: async () => new Promise(() => {}), logger, channelGuardMarginMs: 20, channelCallTimeoutMs: 20 },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'Timeout');
  assert.equal(result.error.message, 'No respondió a tiempo. Inténtalo de nuevo.');
  assert.ok(elapsed < 5_000, `the guard fired instead of waiting forever (took ${elapsed}ms)`);
  assert.equal(logger.failures.length, 1);
});

test('a malformed read frame is a showable error, not a crash', async () => {
  const logger = fakeLogger();
  const bridge = scriptedBridge([{ base64: 'no-*-base64', eof: false }]);

  const result = await httpOverTunnel(TUNNEL, EXTENSION_HTTP_PORT, REQUEST, {
    deps: { call: bridge.call, logger },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'Frame');
  assert.equal(logger.failures[0].step, 'channel');

  // A frame without the `bytes` field is malformed too (never read as empty).
  const noBytes = await channelRead(TUNNEL.sessionId, TUNNEL.channels[0], 0, {
    call: async () => JSON.stringify({ ok: true, result: { eof: false } }),
  });
  assert.equal(noBytes.ok, false);
  assert.equal(noBytes.error.kind, 'BadResponse');
});

test('a response with no HTTP head at all is refused as malformed', async () => {
  const bridge = scriptedBridge(['not-http', { eof: true }]);

  const result = await httpOverTunnel(TUNNEL, EXTENSION_HTTP_PORT, REQUEST, { deps: { call: bridge.call } });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'Frame');
});

/* ------------------------------------------------------------------ *
 * Keeping and releasing the handles (S4)
 * ------------------------------------------------------------------ */

test('the tunnel step result is kept as typed channel handles, or refused when absent', () => {
  const channels = parseTunnelChannels({
    forwards: [
      { host: '127.0.0.1', port: 43721, channel_id: 11 },
      { host: '127.0.0.1', port: 43722, channel_id: 12 },
    ],
  });
  assert.deepEqual(channels, TUNNEL.channels);
  assert.deepEqual(tunnelChannelFor(TUNNEL, EXTENSION_HTTP_PORT), TUNNEL.channels[0]);
  assert.deepEqual(tunnelChannelFor(TUNNEL, EXTENSION_WS_PORT), TUNNEL.channels[1]);
  assert.equal(tunnelChannelFor(TUNNEL, 9999), null);

  // A result without handles is a failure, never an empty tunnel that looks open.
  assert.throws(() => parseTunnelChannels({ step: 'tunnel' }), (error) => error.kind === 'BadResponse');
  assert.throws(() => parseTunnelChannels({ forwards: [] }), (error) => error.kind === 'BadResponse');
  assert.throws(() => parseTunnelChannels(undefined), (error) => error.kind === 'BadResponse');
  assert.throws(
    () => parseTunnelChannels({ forwards: [{ host: '127.0.0.1', port: 43721 }] }),
    (error) => error.kind === 'BadResponse',
  );
});

test('closing the tunnel closes every channel and reports what actually closed', async () => {
  const bridge = scriptedBridge();
  const report = await closeTunnel(TUNNEL, { call: bridge.call });

  assert.deepEqual(report, { ok: true, closed: [EXTENSION_HTTP_PORT, EXTENSION_WS_PORT], errors: [] });
  assert.deepEqual(
    bridge.calls.map((entry) => [entry.fn, entry.payload.channelId]),
    [
      [GC_FUNCTIONS.channelClose, 11],
      [GC_FUNCTIONS.channelClose, 12],
    ],
  );

  // One channel already closed: the other one still closes, and the failure is reported.
  const partial = await closeTunnel(TUNNEL, {
    call: async (fn, payloadJson) => {
      const payload = JSON.parse(payloadJson);
      if (payload.channelId === 11) {
        return JSON.stringify({ ok: false, error: { kind: 'ssh', message: 'ssh: unknown channel id 11' }, raw: null });
      }
      return JSON.stringify({ ok: true, result: { closed: true } });
    },
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.closed, [EXTENSION_WS_PORT]);
  assert.deepEqual(partial.errors, [
    { port: EXTENSION_HTTP_PORT, error: { kind: 'ssh', message: 'ssh: unknown channel id 11' } },
  ]);
});

/* ------------------------------------------------------------------ *
 * Response framing (pure)
 * ------------------------------------------------------------------ */

test('inspectHttpResponse tells when a response still needs bytes', () => {
  const text = (value) => utf8Encode(value);

  const head = inspectHttpResponse(text('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab'));
  assert.deepEqual({ status: head.status, complete: head.complete }, { status: 200, complete: false });

  const done = inspectHttpResponse(text('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabcde'));
  assert.deepEqual({ status: done.status, complete: done.complete }, { status: 200, complete: true });

  const chunked = inspectHttpResponse(text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'));
  assert.equal(chunked.complete, true);

  const noBody = inspectHttpResponse(text('HTTP/1.1 204 No Content\r\n\r\n'));
  assert.deepEqual({ status: noBody.status, complete: noBody.complete }, { status: 204, complete: true });

  const partialHead = inspectHttpResponse(text('HTTP/1.1 200 OK\r\nContent-'));
  assert.deepEqual({ status: partialHead.status, complete: partialHead.complete }, { status: null, complete: false });

  // No framing header: only the peer closing the channel can finish it.
  const unframed = inspectHttpResponse(text('HTTP/1.1 200 OK\r\n\r\nhola'));
  assert.deepEqual({ status: unframed.status, complete: unframed.complete }, { status: 200, complete: false });
});
