import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVISION_ROWS,
  PROVISION_STEPS,
  PROVISION_TIMEOUTS,
  connectPair,
  decideAfterStepError,
  overallPercent,
  provisionFlow,
  rowForStep,
  timeoutFor,
} from '../lib/provision.ts';

/**
 * Contract of the V3 orchestration (`mobile/lib/provision.ts`, artboard
 * `design/mobile-app-onboarding/03-pairing-progress.html`, protocol
 * `docs/mobile-protocol-spec.md` §2–§4).
 *
 * The native bridge is injected (`deps.call`), so the whole state machine —
 * step order, per-step timeout, the single automatic rollback+retry of the
 * `start` step, the failure the screen shows and the record it logs — is
 * verified without a device.
 */

const PAIR = {
  host: '192.168.1.42',
  port: 22,
  user: 'reaan',
  token: 'inv_7Qp2',
  fp: '66402c9468c58941dd19ffd650bf2b42f9226f83d3bd06ad515d0e5104a77020',
  pw: '',
  code: '',
  dport: 43722,
  proto: '3',
};

/** Fresh-host deps: the probe is overridden (no real LAN fetch in tests) and the
 * binary/release material rides along so upload/verify/start run against the mock. */
const FRESH_HOST_DEPS = {
  daemonRunning: false,
  probeDaemon: async () => true,
  daemonBinaryHex: 'deadbeef',
  releasePubkeyHex: 'aa'.repeat(32),
  releaseManifest: { sha256: 'bb'.repeat(32), signature: 'cc'.repeat(128) },
};

const CREDENTIAL = { type: 'password', value: 'correcta' };

/** Fake bridge: resolves/records every call, scripted by step name. */
function fakeBridge(script = {}) {
  const calls = [];
  return {
    calls,
    async call(fn, payloadJson) {
      const payload = JSON.parse(payloadJson);
      calls.push({ fn, payload });
      if (fn === 'gc_ssh_connect') {
        return JSON.stringify({ ok: true, result: { sessionId: 7, fingerprint: 'ff'.repeat(32) } });
      }
      if (fn === 'gc_device_key_generate') {
        return JSON.stringify({ ok: true, result: { key: { public_hex: 'ab'.repeat(32), secret: {} } } });
      }
      const behaviour = script[payload.step] ?? script[fn] ?? 'ok';
      if (behaviour === 'hang') {
        return new Promise(() => {});
      }
      if (typeof behaviour === 'string' && behaviour !== 'ok') {
        return JSON.stringify({ ok: false, error: { kind: behaviour, message: `falló ${behaviour}` }, raw: '{"exit":1}' });
      }
      if (Array.isArray(behaviour)) {
        const next = behaviour.shift();
        if (next !== 'ok') {
          return JSON.stringify({ ok: false, error: { kind: next, message: `falló ${next}` }, raw: null });
        }
        return JSON.stringify({ ok: true, result: { step: payload.step } });
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
  };
}

const recordedCallbacks = () => {
  const events = [];
  return {
    events,
    onStepStart: (step) => events.push(['start', step]),
    onStepDone: (step, result) => events.push(['done', step, result]),
    onStepError: (step, error, raw, decision) => events.push(['error', step, error.kind, raw, decision]),
  };
};

test('the seven steps run in the frozen order', () => {
  assert.deepEqual(PROVISION_STEPS, [
    'fingerprint-confirm',
    'detect',
    'upload',
    'verify',
    'start',
    'register',
    'tunnel',
  ]);
});

test('each step has the timeout pinned by the artboard', () => {
  assert.equal(timeoutFor('detect'), 10_000);
  assert.equal(timeoutFor('upload'), 120_000);
  assert.equal(timeoutFor('verify'), 5_000);
  assert.equal(timeoutFor('start'), 20_000);
  assert.equal(timeoutFor('register'), 15_000);
  assert.equal(timeoutFor('tunnel'), 15_000);
  assert.equal(timeoutFor('fingerprint-confirm'), PROVISION_TIMEOUTS['fingerprint-confirm']);
  assert.equal(typeof PROVISION_TIMEOUTS['fingerprint-confirm'], 'number');
});

test('only the first start failure is retried after a rollback', () => {
  assert.equal(decideAfterStepError('start', 1), 'retry-with-rollback');
  assert.equal(decideAfterStepError('start', 2), 'surface');
  assert.equal(decideAfterStepError('start', 3), 'surface');
  for (const step of ['fingerprint-confirm', 'detect', 'upload', 'verify', 'register', 'tunnel']) {
    assert.equal(decideAfterStepError(step, 1), 'surface');
  }
});

test('the five visible rows map onto the seven native steps', () => {
  assert.deepEqual(PROVISION_ROWS, ['ssh', 'fingerprint', 'install', 'register', 'tunnel']);
  assert.equal(rowForStep('fingerprint-confirm'), 'fingerprint');
  assert.equal(rowForStep('detect'), 'install');
  assert.equal(rowForStep('upload'), 'install');
  assert.equal(rowForStep('verify'), 'install');
  assert.equal(rowForStep('start'), 'install');
  assert.equal(rowForStep('register'), 'register');
  assert.equal(rowForStep('tunnel'), 'tunnel');
});

test('overall progress is step based over the five visible rows', () => {
  assert.equal(overallPercent(0), 0);
  assert.equal(overallPercent(2), 40);
  assert.equal(overallPercent(5), 100);
  assert.equal(overallPercent(1, 5, 0.6), 32);
  assert.equal(overallPercent(9), 100, 'never above 100');
  assert.equal(overallPercent(-1), 0, 'never below 0');
});

test('the happy path runs every step, reports it and returns the registration', async () => {
  const bridge = fakeBridge();
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger, ...FRESH_HOST_DEPS });

  assert.equal(result.ok, true);
  assert.equal(bridge.calls.length, 6, '5 native provision steps + 1 device key (fingerprint/tunnel are local)');
  assert.deepEqual(
    bridge.calls.filter((entry) => entry.fn === 'gc_provision_step').map((entry) => entry.payload.step),
    ['detect', 'upload', 'verify', 'start', 'register'],
  );
  assert.deepEqual(
    cb.events.map((event) => [event[0], event[1]]),
    PROVISION_STEPS.flatMap((step) => [
      ['start', step],
      ['done', step],
    ]),
  );
  assert.equal(logger.failures.length, 0);
  assert.equal(bridge.calls[0].payload.step, 'detect');
  assert.ok(bridge.calls.find((entry) => entry.fn === 'gc_device_key_generate'), 'the device key is generated before register');
  assert.equal(bridge.calls.find((entry) => entry.payload.step === 'register').payload.devicePubkeyHex, 'ab'.repeat(32));
});

test('a failing step stops the pipeline, logs it and returns the verbatim reason', async () => {
  const bridge = fakeBridge({ upload: 'ChecksumMismatch' });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger, ...FRESH_HOST_DEPS });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'upload');
  assert.equal(result.error.kind, 'ChecksumMismatch');
  assert.equal(result.error.message, 'falló ChecksumMismatch');
  assert.equal(bridge.calls.length, 2, 'verify/start/register/tunnel never run');
  assert.equal(bridge.calls[1].payload.step, 'upload');
  assert.deepEqual(logger.failures, [
    { step: 'upload', error: { kind: 'ChecksumMismatch', message: 'falló ChecksumMismatch' }, raw: '{"exit":1}' },
  ]);
  assert.deepEqual(cb.events.at(-1), ['error', 'upload', 'ChecksumMismatch', '{"exit":1}', 'surface']);
});

test('one start failure rolls back and retries, then the flow finishes', async () => {
  const bridge = fakeBridge({ start: ['PortInUse', 'ok'] });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const result = await provisionFlow(PAIR, CREDENTIAL, cb, { call: bridge.call, logger, ...FRESH_HOST_DEPS });

  assert.equal(result.ok, true);
  const sequence = bridge.calls.map((entry) => entry.payload.step);
  assert.deepEqual(sequence, [
    'detect',
    'upload',
    'verify',
    'start',
    'rollback',
    'start',
    undefined, // gc_device_key_generate carries no step
    'register',
  ]);
  assert.equal(bridge.calls[4].payload.step, 'rollback');
  assert.equal(bridge.calls[5].payload.attempt, 2);
  assert.deepEqual(cb.events.find((event) => event[0] === 'error'), [
    'error',
    'start',
    'PortInUse',
    null,
    'retry-with-rollback',
  ]);
  assert.equal(logger.failures.length, 1, 'the retried attempt is logged once');
});

test('a second start failure is surfaced instead of looped', async () => {
  const bridge = fakeBridge({ start: ['PortInUse', 'PortInUse'] });
  const logger = fakeLogger();

  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), { call: bridge.call, logger, ...FRESH_HOST_DEPS });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'start');
  assert.equal(logger.failures.length, 2);
  assert.equal(
    bridge.calls.filter((entry) => entry.payload.step === 'rollback').length,
    1,
    'rollback happens once',
  );
});

test('a step that hangs times out with the pinned copy and stops the pipeline', async () => {
  const bridge = fakeBridge({ detect: 'hang' });
  const logger = fakeLogger();
  const cb = recordedCallbacks();

  const started = Date.now();
  const result = await provisionFlow(PAIR, CREDENTIAL, cb, {
    call: bridge.call,
    logger,
    daemonRunning: false,
    probeDaemon: async () => true,
    timeouts: { detect: 20 },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'detect');
  assert.equal(result.error.kind, 'Timeout');
  assert.equal(result.error.message, 'No respondió a tiempo. Inténtalo de nuevo.');
  assert.ok(elapsed < 5_000, `timeout fired quickly (took ${elapsed}ms)`);
  assert.deepEqual(
    bridge.calls.map((entry) => entry.payload.step),
    ['detect'],
    'the hung step is never retried and nothing after it runs',
  );
  assert.deepEqual(logger.failures[0].error, { kind: 'Timeout', message: 'No respondió a tiempo. Inténtalo de nuevo.' });
});

test('the bridge returning unparsable JSON fails the step instead of crashing', async () => {
  const logger = fakeLogger();
  const result = await provisionFlow(PAIR, CREDENTIAL, recordedCallbacks(), {
    call: async () => 'no soy json',
    logger,
    daemonRunning: false,
    probeDaemon: async () => true,
    timeouts: { detect: 1_000 },
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
    daemonRunning: false,
    probeDaemon: async () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'detect');
  assert.equal(result.error.kind, 'CoreUnavailable');
  assert.equal(result.error.message, 'libmobile_core.so no está en la build');
  assert.deepEqual(logger.failures[0].step, 'detect');
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
});

test('moshi pairing: the pw from the QR becomes the SSH credential and dport is used', async () => {
  const bridge = fakeBridge();
  const moshiPair = { ...PAIR, pw: 'secreta', dport: 43722 };
  // The screen calls connectPair (gc_ssh_connect) first, then provisionFlow.
  const connection = await connectPair(moshiPair, { type: 'password', value: moshiPair.pw }, {
    call: bridge.call,
    logger: fakeLogger(),
  });
  assert.equal(connection.ok, true);
  const connect = bridge.calls[0];
  assert.equal(connect.fn, 'gc_ssh_connect');
  assert.equal(connect.payload.credential.value, 'secreta');
  assert.equal(connect.payload.port, 22, 'SSH port, not the daemon port');
  const result = await provisionFlow(moshiPair, { type: 'password', value: moshiPair.pw }, recordedCallbacks(), {
    call: bridge.call,
    logger: fakeLogger(),
    ...FRESH_HOST_DEPS,
    sessionId: connection.sessionId,
  });
  assert.equal(result.ok, true);
  const register = bridge.calls.find((entry) => entry.payload.step === 'register');
  assert.equal(register.payload.devicePubkeyHex, 'ab'.repeat(32));
  assert.equal(register.payload.inviteToken, 'inv_7Qp2');
});
