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
