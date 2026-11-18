import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTHORIZED_KEY_COMMENT,
  EXTENSION_HTTP_PORT,
  EXTENSION_LOOPBACK_PORTS,
  EXTENSION_WS_PORT,
  PROVISION_ROWS,
  PROVISION_STEPS,
  PROVISION_TIMEOUTS,
  authorizedKeysScript,
  connectPair,
  loopbackProbeScript,
  overallPercent,
  provisionFlow,
  rowForStep,
  sshEd25519AuthorizedKey,
  timeoutFor,
  verifyHostFingerprint,
} from '../lib/provision.ts';

/**
 * Contract of the V3 orchestration after the pivot (`mobile/lib/provision.ts`,
 * `odd/tasks/gentle-movil-pivote.md` S4/S5/S7).
 *
 * The pivot deleted the daemon: V3 runs connect → fingerprint → detect →
 * register → tunnel over SSH and has **no** upload/verify/start (SFTP) at all.
 * The native bridge is injected (`deps.call`), so step order, the honest stop of
 * every failure, the `{step, error, raw}` log and the composed shell commands are
 * verified without a device and without a host.
 */

const FP = '66402c9468c58941dd19ffd650bf2b42f9226f83d3bd06ad515d0e5104a77020';

const PAIR = {
  host: '192.168.1.42',
  port: 22,
  user: 'reaan',
  token: 'inv_7Qp2',
  fp: FP,
  pw: '',
  code: '',
  dport: 43722,
  proto: '3',
};

const CREDENTIAL = { type: 'password', value: 'correcta' };

/** Device key the fake core hands out (32-byte ed25519 public key, hex). */
const DEVICE_PUBKEY_HEX = 'ab'.repeat(32);

/**
 * Channels the fake core reports after `tunnel` (`TunnelResult.forwards`), one per
 * loopback port: this is the handle the app speaks HTTP/WS through (S4).
 */
const OPENED_FORWARDS = [
  { host: '127.0.0.1', port: EXTENSION_HTTP_PORT, channel_id: 11 },
  { host: '127.0.0.1', port: EXTENSION_WS_PORT, channel_id: 12 },
];

/** Fake bridge: resolves/records every call, scripted by step name. */
function fakeBridge(script = {}) {
  const calls = [];
  return {
    calls,
    async call(fn, payloadJson) {
      const payload = JSON.parse(payloadJson);
      calls.push({ fn, payload });
      if (fn === 'gc_ssh_connect') {
        const connect = script.connect ?? 'ok';
        if (connect === 'hang') {
          return new Promise(() => {});
        }
        if (connect !== 'ok') {
          return JSON.stringify({ ok: false, error: { kind: connect, message: `falló ${connect}` }, raw: '{"exit":1}' });
        }
        const fingerprint = script.fingerprint ?? PAIR.fp;
        return JSON.stringify({ ok: true, result: { sessionId: 7, fingerprint } });
      }
      if (fn === 'gc_device_key_generate') {
        const key = script.deviceKey ?? 'ok';
        if (key !== 'ok') {
          return JSON.stringify({ ok: false, error: { kind: key, message: `falló ${key}` }, raw: null });
        }
        return JSON.stringify({ ok: true, result: { key: { public_hex: DEVICE_PUBKEY_HEX, secret: {} } } });
      }
      const behaviour = script[payload.step] ?? script[fn] ?? 'ok';
      if (behaviour === 'hang') {
        return new Promise(() => {});
      }
      if (behaviour !== 'ok') {
        return JSON.stringify({ ok: false, error: { kind: behaviour, message: `falló ${behaviour}` }, raw: '{"exit":1}' });
      }
      if (payload.step === 'tunnel') {
        return JSON.stringify({ ok: true, step: 'tunnel', result: { forwards: OPENED_FORWARDS } });
      }
      return JSON.stringify({ ok: true, result: { step: payload.step } });
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

/** Callbacks recorder, so the screen's view of the flow is asserted too. */
const recordedCallbacks = () => {
  const events = [];
  return {
    events,
    onStepStart: (step) => events.push(['start', step]),
    onStepDone: (step, result) => events.push(['done', step, result]),
    onStepError: (step, error, raw) => events.push(['error', step, error.kind, raw]),
  };
};

const stepsOf = (bridge) => bridge.calls.map((entry) => entry.payload.step).filter(Boolean);

/* ------------------------------------------------------------------ *
 * The five steps (S4/S5)
 * ------------------------------------------------------------------ */

test('the flow is exactly connect → fingerprint → detect → register → tunnel', () => {
  assert.deepEqual(PROVISION_STEPS, ['connect', 'fingerprint', 'detect', 'register', 'tunnel']);
  assert.equal(EXTENSION_HTTP_PORT, 43721);
  assert.equal(EXTENSION_WS_PORT, 43722);
  assert.deepEqual(EXTENSION_LOOPBACK_PORTS, [43721, 43722]);
});

test('the happy path runs the five steps in order and reports each one', async () => {
  const bridge = fakeBridge();
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, '7');
  // connect is the very first native call of the flow, then the composed steps.
  assert.equal(bridge.calls[0].fn, 'gc_ssh_connect');
  assert.deepEqual(
    bridge.calls.map((entry) => entry.payload.step ?? entry.fn),
    ['gc_ssh_connect', 'detect', 'gc_device_key_generate', 'register', 'tunnel'],
  );
  // detect and register carry the shell command composed in TS (no new ABI).
  const detect = bridge.calls.find((entry) => entry.payload.step === 'detect');
  assert.match(detect.payload.command, /43721/);
  assert.match(detect.payload.command, /43722/);
  const register = bridge.calls.find((entry) => entry.payload.step === 'register');
  assert.equal(register.payload.devicePubkeyHex, DEVICE_PUBKEY_HEX);
  assert.match(register.payload.authorizedKey, /^ssh-ed25519 AAAA/);
  assert.match(register.payload.command, /authorized_keys/);
  const tunnel = bridge.calls.find((entry) => entry.payload.step === 'tunnel');
  assert.deepEqual(tunnel.payload.forwards, [
    { host: '127.0.0.1', port: 43721 },
    { host: '127.0.0.1', port: 43722 },
  ]);
  // Every step is announced and completed, in order, and nothing failed.
  assert.deepEqual(
    cb.events.map((event) => [event[0], event[1]]),
    PROVISION_STEPS.flatMap((step) => [
      ['start', step],
      ['done', step],
    ]),
  );
  assert.equal(logger.failures.length, 0);
  assert.equal(result.registration.authorizedKey, sshEd25519AuthorizedKey(DEVICE_PUBKEY_HEX));
  // The tunnel handles are kept, not discarded: they are how the app speaks HTTP/WS.
  assert.deepEqual(result.tunnel, {
    sessionId: '7',
    channels: [
      { host: '127.0.0.1', port: EXTENSION_HTTP_PORT, channelId: 11 },
      { host: '127.0.0.1', port: EXTENSION_WS_PORT, channelId: 12 },
    ],
  });
});

test('no upload, verify or start step survives the pivot (S5)', () => {
  const forbidden = ['upload', 'verify', 'start', 'rollback'];
  for (const step of forbidden) {
    assert.equal(PROVISION_STEPS.includes(step), false, `${step} is not a step of the flow`);
  }
  // The module cannot send a step the pivot deleted: the literals are gone.
  const source = readFileSync(new URL('../lib/provision.ts', import.meta.url), 'utf8');
  for (const step of forbidden) {
    assert.equal(source.includes(`'${step}'`), false, `provision.ts still names the ${step} step`);
  }
  assert.equal(/sftp_put|gc_sftp|open_subsystem|openSubsystem/i.test(source), false, 'no SFTP path is left in V3');
});

/* ------------------------------------------------------------------ *
 * Honest failures (S7)
 * ------------------------------------------------------------------ */

test('an SSH failure stops the flow at connect, logs it and never touches the host', async () => {
  const bridge = fakeBridge({ connect: 'AuthFailed' });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'connect');
  assert.equal(result.error.kind, 'AuthFailed');
  assert.equal(result.error.message, 'falló AuthFailed');
  assert.deepEqual(bridge.calls.map((entry) => entry.fn), ['gc_ssh_connect'], 'no step runs without a session');
  assert.deepEqual(cb.events, [['start', 'connect'], ['error', 'connect', 'AuthFailed', '{"exit":1}']]);
  assert.deepEqual(logger.failures, [
    { step: 'connect', error: { kind: 'AuthFailed', message: 'falló AuthFailed' }, raw: '{"exit":1}' },
  ]);
});

test('a tunnel failure stops at tunnel after every earlier step succeeded', async () => {
  const bridge = fakeBridge({ tunnel: 'Ssh' });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'tunnel');
  assert.equal(result.error.message, 'falló Ssh');
  assert.deepEqual(stepsOf(bridge), ['detect', 'register', 'tunnel']);
  assert.deepEqual(logger.failures, [
    { step: 'tunnel', error: { kind: 'Ssh', message: 'falló Ssh' }, raw: '{"exit":1}' },
  ]);
  assert.deepEqual(
    cb.events.map((event) => [event[0], event[1]]),
    [
      ['start', 'connect'], ['done', 'connect'],
      ['start', 'fingerprint'], ['done', 'fingerprint'],
      ['start', 'detect'], ['done', 'detect'],
      ['start', 'register'], ['done', 'register'],
      ['start', 'tunnel'], ['error', 'tunnel'],
    ],
  );
});

test('a tunnel without channel handles fails the step instead of reporting a tunnel', async () => {
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, {
    logger,
    call: async (fn, payloadJson) => {
      const payload = JSON.parse(payloadJson);
      if (fn === 'gc_ssh_connect') {
        return JSON.stringify({ ok: true, result: { sessionId: 7, fingerprint: PAIR.fp } });
      }
      if (fn === 'gc_device_key_generate') {
        return JSON.stringify({ ok: true, result: { key: { public_hex: DEVICE_PUBKEY_HEX, secret: {} } } });
      }
      // The core answered ok but reported no opened channel.
      return JSON.stringify({ ok: true, result: payload.step === 'tunnel' ? { forwards: [] } : { step: payload.step } });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'tunnel');
  assert.equal(result.error.kind, 'BadResponse');
  assert.deepEqual(logger.failures.map((entry) => entry.step), ['tunnel']);
  assert.deepEqual(cb.events.at(-1), ['error', 'tunnel', 'BadResponse', { forwards: [] }]);
});

test('a detect failure stops before register and names the step', async () => {
  const bridge = fakeBridge({ detect: 'Ssh' });
  const logger = fakeLogger();

  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'detect');
  assert.deepEqual(stepsOf(bridge), ['detect'], 'register/tunnel never run');
  assert.equal(logger.failures[0].step, 'detect');
});

test('a register failure stops at register and logs the verbatim reason', async () => {
  const bridge = fakeBridge({ register: 'Ssh' });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'register');
  assert.deepEqual(stepsOf(bridge), ['detect', 'register']);
  assert.deepEqual(logger.failures, [
    { step: 'register', error: { kind: 'Ssh', message: 'falló Ssh' }, raw: '{"exit":1}' },
  ]);
  assert.deepEqual(cb.events.at(-1), ['error', 'register', 'Ssh', '{"exit":1}']);
});

test('a device key the core cannot produce fails register instead of installing nothing', async () => {
  const bridge = fakeBridge({ deviceKey: 'Crypto' });
  const logger = fakeLogger();

  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'register');
  assert.equal(result.error.kind, 'Crypto');
  assert.deepEqual(stepsOf(bridge), ['detect'], 'register is never sent without a key');
  assert.equal(logger.failures.length, 1);
});

/* ------------------------------------------------------------------ *
 * Fingerprint (step 2 is local and cannot guess)
 * ------------------------------------------------------------------ */

test('a host key that does not match the QR stops at fingerprint', async () => {
  const bridge = fakeBridge({ fingerprint: 'ff'.repeat(32) });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'fingerprint');
  assert.equal(result.error.kind, 'FingerprintMismatch');
  assert.deepEqual(stepsOf(bridge), [], 'no remote step runs on a mismatched key');
  assert.deepEqual(logger.failures, [
    {
      step: 'fingerprint',
      error: { kind: 'FingerprintMismatch', message: result.error.message },
      raw: { expected: FP, observed: 'ff'.repeat(32) },
    },
  ]);
  assert.deepEqual(cb.events.at(-1), ['error', 'fingerprint', 'FingerprintMismatch', { expected: FP, observed: 'ff'.repeat(32) }]);
});

test('a session that reports no fingerprint stops honestly instead of assuming it matches', async () => {
  const bridge = fakeBridge({ fingerprint: '' });
  const logger = fakeLogger();

  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), { call: bridge.call, logger });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'fingerprint');
  assert.equal(result.error.kind, 'Fingerprint');
  assert.deepEqual(stepsOf(bridge), []);
});

test('the QR fingerprint is compared in any display form', () => {
  const colon = FP.match(/.{2}/g).join(':');
  assert.deepEqual(verifyHostFingerprint(colon, FP), { ok: true, fingerprint: FP });
  assert.deepEqual(verifyHostFingerprint(FP.toUpperCase(), FP), { ok: true, fingerprint: FP });
  assert.deepEqual(verifyHostFingerprint(`SHA256:${FP}`, FP), { ok: true, fingerprint: FP });
  assert.equal(verifyHostFingerprint('no-es-huella', FP).ok, false);
  assert.equal(verifyHostFingerprint(FP, undefined).ok, false);
});

/* ------------------------------------------------------------------ *
 * Preserved behaviour of the surviving surface
 * ------------------------------------------------------------------ */

test('each step has the timeout the flow budget pins', () => {
  assert.equal(timeoutFor('connect'), 10_000);
  assert.equal(timeoutFor('detect'), 15_000);
  assert.equal(timeoutFor('register'), 15_000);
  assert.equal(timeoutFor('tunnel'), 15_000);
  assert.equal(typeof PROVISION_TIMEOUTS.fingerprint, 'number');
  assert.equal(timeoutFor('tunnel', { tunnel: 25 }), 25);
});

test('the five visible rows are the five steps', () => {
  assert.deepEqual(PROVISION_ROWS, ['connect', 'fingerprint', 'detect', 'register', 'tunnel']);
  for (const step of PROVISION_STEPS) {
    assert.equal(rowForStep(step), step);
  }
});

test('overall progress is step based over the five rows', () => {
  assert.equal(overallPercent(0), 0);
  assert.equal(overallPercent(2), 40);
  assert.equal(overallPercent(5), 100);
  assert.equal(overallPercent(1, 5, 0.5), 30);
  assert.equal(overallPercent(9), 100, 'never above 100');
  assert.equal(overallPercent(-1), 0, 'never below 0');
});

test('connectPair returns the session id or the honest failure', async () => {
  const ok = await connectPair(PAIR, CREDENTIAL, {
    call: async () => JSON.stringify({ ok: true, result: { sessionId: 'sess-1', fingerprint: 'SHA256:abc' } }),
  });
  assert.deepEqual(ok, { ok: true, sessionId: 'sess-1', fingerprint: 'SHA256:abc' });

  const failed = await connectPair(PAIR, CREDENTIAL, {
    call: async () => JSON.stringify({ ok: false, error: { kind: 'AuthFailed', message: 'Credenciales rechazadas.' }, raw: null }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, 'AuthFailed');

  const noSession = await connectPair(PAIR, CREDENTIAL, {
    call: async () => JSON.stringify({ ok: true, result: {} }),
  });
  assert.equal(noSession.ok, false);
  assert.equal(noSession.error.kind, 'BadResponse');
});

test('a step that hangs times out with the pinned copy and stops the flow', async () => {
  const bridge = fakeBridge({ detect: 'hang' });
  const logger = fakeLogger();

  const started = Date.now();
  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), {
    call: bridge.call,
    logger,
    timeouts: { detect: 20 },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'detect');
  assert.equal(result.error.kind, 'Timeout');
  assert.equal(result.error.message, 'No respondió a tiempo. Inténtalo de nuevo.');
  assert.ok(elapsed < 5_000, `timeout fired quickly (took ${elapsed}ms)`);
  assert.deepEqual(stepsOf(bridge), ['detect'], 'the hung step is never retried');
  assert.deepEqual(logger.failures[0].error, { kind: 'Timeout', message: 'No respondió a tiempo. Inténtalo de nuevo.' });
});

test('a bridge that answers unparsable JSON fails the step instead of crashing', async () => {
  const logger = fakeLogger();
  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), {
    call: async (fn) =>
      fn === 'gc_ssh_connect'
        ? JSON.stringify({ ok: true, result: { sessionId: 1, fingerprint: PAIR.fp } })
        : 'no soy json',
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'detect');
  assert.equal(result.error.kind, 'BadResponse');
});

test('a rejected bridge call becomes a step failure with its reason', async () => {
  const logger = fakeLogger();
  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), {
    call: async () => {
      throw { kind: 'CoreUnavailable', message: 'libmobile_core.so no está en la build' };
    },
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'connect');
  assert.equal(result.error.kind, 'CoreUnavailable');
  assert.deepEqual(logger.failures[0].step, 'connect');
});

/* ------------------------------------------------------------------ *
 * The composed primitives (no new ABI)
 * ------------------------------------------------------------------ */

test('the loopback probe is valid sh, covers both ports and demands all of them', () => {
  const script = loopbackProbeScript();
  execFileSync('sh', ['-n', '-c', script]);
  assert.match(script, /for _port in 43721 43722; do/);
  assert.match(script, /127\.0\.0\.1/);
  assert.match(script, /\[ "\$_missed" -eq 0 \]/, 'exits non-zero unless every port answered');
  assert.equal(loopbackProbeScript(), script, 'deterministic');
  assert.throws(() => loopbackProbeScript([0]), (error) => error.kind === 'Input');
  assert.throws(() => loopbackProbeScript([]), (error) => error.kind === 'Input');
});

test('the authorized_keys line is the OpenSSH wire form of the ed25519 key', () => {
  // Known vector: 32 zero bytes, i.e. the RFC 4251 blob for that key.
  assert.equal(
    sshEd25519AuthorizedKey('00'.repeat(32)),
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gentle-movil',
  );
  assert.match(sshEd25519AuthorizedKey(DEVICE_PUBKEY_HEX), new RegExp(` ${AUTHORIZED_KEY_COMMENT}$`));
  assert.throws(() => sshEd25519AuthorizedKey('ab'), (error) => error.kind === 'Crypto');
  assert.throws(() => sshEd25519AuthorizedKey('zz'.repeat(32)), (error) => error.kind === 'Crypto');
});

test('register appends the key once, however many times it runs', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'gentle-movil-register-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const line = sshEd25519AuthorizedKey(DEVICE_PUBKEY_HEX);
  const script = authorizedKeysScript(line);
  execFileSync('sh', ['-n', '-c', script]);

  const run = () => execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home } });
  run();
  run();

  const keys = join(home, '.ssh', 'authorized_keys');
  assert.deepEqual(readFileSync(keys, 'utf8').split('\n').filter(Boolean), [line]);

  // A phone with a new key still gets its line: the step appends, it does not skip.
  const other = sshEd25519AuthorizedKey('cd'.repeat(32));
  execFileSync('sh', ['-c', authorizedKeysScript(other)], { env: { ...process.env, HOME: home } });
  assert.deepEqual(readFileSync(keys, 'utf8').split('\n').filter(Boolean), [line, other]);
});