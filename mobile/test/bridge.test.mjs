/**
 * Bridge client tests — real wire format over a fake channel (protocol §4/§6).
 * `lib/bridge.ts` must speak HTTP/1.1 exactly; these tests pin request bytes,
 * response parsing and every typed failure (S7: nothing invented, nothing
 * swallowed).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BRIDGE_HTTP_PORT,
  bridgeHealth,
  bridgeRequest,
  bridgeSessions,
  buildGetRequest,
  buildPostRequest,
  isOfflineError,
  splitResponse,
} from '../lib/bridge.ts';
import { utf8Decode, utf8Encode } from '../lib/core.ts';

const OK_WIRE = (body) =>
  utf8Encode(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  );

/** Scripted channel: answers each read with the queued chunks, then eof. */
function scriptedChannel(chunks, opts = {}) {
  const log = [];
  let index = 0;
  return {
    log,
    async write(payload) {
      log.push(['write', utf8Decode(payload)]);
      return payload.length;
    },
    async read() {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        log.push(['read', chunk instanceof Uint8Array ? utf8Decode(chunk) : chunk]);
        return { bytes: chunk instanceof Uint8Array ? chunk : utf8Encode(chunk), eof: false };
      }
      log.push(['read-eof']);
      return { bytes: new Uint8Array(), eof: true };
    },
    async close() {
      log.push(['close']);
      if (opts.closeThrows) {
        throw new Error('close refused');
      }
    },
  };
}

test('BRIDGE_HTTP_PORT is the protocol port 43721', () => {
  assert.equal(BRIDGE_HTTP_PORT, 43721);
});

test('buildGetRequest writes the exact §4 wire bytes', () => {
  const wire = utf8Decode(buildGetRequest('/api/sessions', '127.0.0.1'));
  assert.equal(
    wire,
    'GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept: application/json\r\n\r\n',
  );
});

test('buildPostRequest writes a real JSON POST with its Content-Length', async () => {
  const body = { command: 'ls -la' };
  const wire = utf8Decode(buildPostRequest('/api/exec', '127.0.0.1', body));
  assert.equal(
    wire,
    'POST /api/exec HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' +
      'Accept: application/json\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(JSON.stringify(body))}\r\n\r\n` +
      JSON.stringify(body),
  );

  // The same bytes on a live call: `bridgeRequest` defaults to GET, so a POST
  // request must be asked for explicitly (protocol §4.1).
  const channel = scriptedChannel([OK_WIRE({ id: 'cmd-1', exitCode: 0, output: null })]);
  const result = await bridgeRequest(channel, '/api/exec', { method: 'POST', body });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  const wrote = channel.log.find(([op]) => op === 'write');
  assert.match(wrote[1], /^POST \/api\/exec HTTP\/1\.1/);
  assert.ok(wrote[1].endsWith(`\r\n\r\n${JSON.stringify(body)}`));
});

test('splitResponse parses status + body', () => {
  const parsed = splitResponse(OK_WIRE({ sessions: [] }));
  assert.equal(parsed.status, 200);
  assert.deepEqual(JSON.parse(parsed.body), { sessions: [] });
  assert.equal(splitResponse(utf8Encode('garbage')), null);
});

test('bridgeSessions returns the real payload on 200', async () => {
  const payload = {
    sessions: [
      {
        id: 's1',
        title: 'feat/auth',
        status: 'working',
        hint: 'gentle-movil',
        updatedAt: '2026-11-18T15:00:00Z',
      },
    ],
  };
  const channel = scriptedChannel([OK_WIRE(payload)]);
  const result = await bridgeSessions(channel);
  assert.equal(result.ok, true);
  assert.equal(result.body.sessions[0].title, 'feat/auth');
  const wrote = channel.log.find(([op]) => op === 'write');
  assert.match(wrote[1], /^GET \/api\/sessions HTTP\/1\.1/);
  assert.ok(channel.log.some(([op]) => op === 'close'));
});

test('bridgeHealth parses the identity body', async () => {
  const channel = scriptedChannel([OK_WIRE({ proto: 1, name: 'gentle-pi-extension', version: '0.1.0' })]);
  const result = await bridgeHealth(channel);
  assert.equal(result.ok, true);
  assert.equal(result.body.proto, 1);
});

test('offline: write refused (tunnel down) is typed, not empty success', async () => {
  const channel = scriptedChannel([]);
  channel.write = async () => 0;
  const result = await bridgeRequest(channel, '/api/sessions');
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'offline');
  assert.equal(result.failure.raw, 'write=0');
});

test('offline: core/channel exception maps to offline with the error kept', async () => {
  const channel = scriptedChannel([]);
  channel.write = async () => {
    throw new Error('session closed by peer');
  };
  const result = await bridgeRequest(channel, '/api/sessions');
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'offline');
  assert.match(String(result.failure.error), /session closed/);
});

test('isOfflineError recognises CoreUnavailableError-style failures', () => {
  const coreError = Object.assign(new Error('channel 3 unavailable'), { name: 'CoreUnavailableError' });
  assert.equal(isOfflineError(coreError), true);
  assert.equal(isOfflineError(new Error('random')), false);
});

test('timeout: silence past the deadline is typed with raw evidence', async () => {
  // A genuinely silent channel: read never returns bytes, just hangs.
  const channel = {
    async write() {
      return 1;
    },
    read: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ bytes: new Uint8Array(), eof: false }), 100),
      ),
    async close() {},
  };
  const result = await bridgeRequest(channel, '/api/sessions', { timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'timeout');
  assert.match(result.failure.raw, /20ms/);
});

test('bad-response: non-HTTP garbage is typed with the raw prefix', async () => {
  const channel = scriptedChannel([utf8Encode('<html>not http</html>')]);
  const result = await bridgeRequest(channel, '/api/sessions');
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'bad-response');
  assert.match(result.failure.raw, /<html>/);
});

test('bad-response: broken JSON body is typed with the body prefix', async () => {
  const channel = scriptedChannel([utf8Encode('HTTP/1.1 200 OK\r\n\r\n{"sessions": [')]);
  const result = await bridgeSessions(channel);
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'bad-response');
  assert.match(result.failure.raw, /{"sessions"/);
});

test('chunked response: headers then body across frames still parses', async () => {
  const payload = { sessions: [] };
  const body = JSON.stringify(payload);
  const channel = scriptedChannel([
    utf8Encode('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'),
    utf8Encode(body.slice(0, 8)),
    utf8Encode(body.slice(8)),
  ]);
  const result = await bridgeSessions(channel);
  assert.equal(result.ok, true);
  assert.deepEqual(result.body, payload);
});

test('close failure never masks the successful result (S7)', async () => {
  const channel = scriptedChannel([OK_WIRE({ proto: 1, name: 'x' })], { closeThrows: true });
  const result = await bridgeHealth(channel);
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------------ *
 * Response framing (hardware: every call returned an EMPTY body)
 *
 * The PC answers `Connection: keep-alive` (measured on the host: `/api/health`
 * 74 B, `/api/sessions` 10349 B, `/api/automations` 18 B, all with
 * `content-length`), so the response must end where its own framing says —
 * never where the peer closes and never at whatever the channel delivered.
 * ------------------------------------------------------------------ */

/** The real `/api/health` body the host serves (74 bytes). */
const REAL_HEALTH = { app: 'gentle-shell', bridge: 'gentle-movil', proto: 1, version: '0.1.0' };

/** HTTP response whose body is framed by its own `Content-Length`. */
function lengthWire(body, status = 200) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return (
    `HTTP/1.1 ${status} OK\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    '\r\n' +
    payload
  );
}

/**
 * Keep-alive peer: delivers the queued frames and then stays open (empty
 * frames, `eof: false`), exactly like the host's `node:http` server does once
 * the response is complete.
 */
function keepAliveChannel(frames, opts = {}) {
  const queued = frames.map((frame) => (frame instanceof Uint8Array ? frame : utf8Encode(frame)));
  const log = [];
  let index = 0;
  return {
    log,
    async write(payload) {
      log.push(['write', utf8Decode(payload)]);
      return payload.length;
    },
    async read() {
      if (index < queued.length) {
        const bytes = queued[index++];
        log.push(['read', utf8Decode(bytes)]);
        return { bytes, eof: false };
      }
      log.push(['read-idle']);
      return { bytes: new Uint8Array(), eof: false };
    },
    async close() {
      log.push(['close']);
      if (opts.closeThrows) {
        throw new Error('close refused');
      }
    },
  };
}

test('keep-alive: a Content-Length response is complete without the peer closing', async () => {
  const channel = keepAliveChannel([lengthWire(REAL_HEALTH)]);
  const result = await bridgeHealth(channel, { timeoutMs: 500 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.body, REAL_HEALTH);
  assert.ok(
    !channel.log.some(([op]) => op === 'read-idle'),
    'the body ends at Content-Length, not at a read that had to wait for eof',
  );
  assert.ok(
    channel.log.some(([op]) => op === 'close'),
    'a one-shot exchange closes its channel: the next request opens its own',
  );
});

test('keep-alive: bytes the peer sent after the body never leak into the JSON', async () => {
  // A keep-alive connection may carry more bytes (a pipelined answer, a stray
  // frame). The response ends at the length it declared.
  const channel = keepAliveChannel([`${lengthWire(REAL_HEALTH)}HTTP/1.1 200 OK\r\n\r\nstray`]);
  const result = await bridgeHealth(channel, { timeoutMs: 500 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.body, REAL_HEALTH);
});

test('chunked: a Transfer-Encoding body is decoded instead of fed to JSON.parse', async () => {
  const body = JSON.stringify({ sessions: [] });
  const chunked = `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
  const channel = keepAliveChannel([
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
    chunked.slice(0, 6),
    chunked.slice(6),
  ]);
  const result = await bridgeSessions(channel, { timeoutMs: 500 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.body.sessions, []);
});

test('a body cut short by the peer is channel-closed, never broken JSON', async () => {
  const payload = JSON.stringify(REAL_HEALTH);
  const wire = lengthWire(payload);
  // The channel closes 5 bytes before the body its Content-Length promised.
  const channel = scriptedChannel([wire.slice(0, wire.length - 5)]);
  const result = await bridgeHealth(channel);

  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'channel-closed');
  assert.doesNotMatch(result.failure.message, /rota/i, 'a short read is not a broken answer');
  assert.doesNotMatch(result.failure.message, /JSON/i);
  assert.match(result.failure.raw, new RegExp(`de ${Buffer.byteLength(payload)}B`));
});

test('the hardware symptom: a channel that answers nothing is channel-closed, not an empty body', async () => {
  // Exactly what the tablet saw after the tunnel was already consumed: the
  // first read answers eof with zero bytes.
  const channel = scriptedChannel([]);
  const result = await bridgeSessions(channel);

  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'channel-closed');
  assert.doesNotMatch(result.failure.message, /rota/i);
  assert.notEqual(result.failure.raw, '', 'the failure carries real evidence, never an empty string');
  assert.match(result.failure.raw, /0B/);
  assert.match(result.failure.message, /cerró/);
});

test('an empty body is named as empty, with its status in the raw evidence', async () => {
  const channel = keepAliveChannel(['HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n']);
  const result = await bridgeRequest(channel, '/api/health', { timeoutMs: 200 });

  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'bad-response');
  assert.match(result.failure.message, /vacía/);
  assert.match(result.failure.raw, /status=200/);
});

test('the request still asks the PC to close: one response per channel', () => {
  // `Connection: close` is the framing this tunnel supports (the app opens one
  // direct-tcpip channel per request), so the request must keep asking for it.
  for (const wire of [
    utf8Decode(buildGetRequest('/api/health', '127.0.0.1')),
    utf8Decode(buildPostRequest('/api/exec', '127.0.0.1', { command: 'ls' })),
  ]) {
    assert.match(wire, /\r\nConnection: close\r\n/);
    assert.doesNotMatch(wire, /keep-alive/i);
  }
});
