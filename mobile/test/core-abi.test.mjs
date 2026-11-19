/**
 * Contract tests of the frozen ABI v2 TypeScript surface (T16/T18).
 *
 * The point of these tests is the pair of promises the slice makes to the app:
 *
 * 1. the device seed never appears in a value or an error message that reaches JS, and
 * 2. a failure is a typed `CoreCallError`, never a fabricated value.
 *
 * The native bridge is faked here, so the whole layer runs in plain node. What stays
 * device-only is the Keystore itself: the persistence proof is
 * `mobile/modules/gentle-core/android/.../DeviceSeedStore.kt` (encrypt/decrypt with a
 * non-exportable AndroidKeyStore key) plus the Rust `gc_device_key_public` test, which
 * derives the same public key from the same seed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as abiSurface from '../modules/gentle-core/src/abi.ts';
import {
  CoreCallError,
  bindCoreNativeBridge,
  coreNativeBridgeBound,
  deviceKeyEnsure,
  fsList,
  fsRead,
  parseEnvelope,
  sshClose,
  sshConnectWithDeviceKey,
} from '../modules/gentle-core/src/abi.ts';
import {
  decideFsRoot,
  fsRootOutsideMessage,
  insideFsRoot,
  normalizeDeviceRoot,
  normalizeFsRoot,
} from '../modules/gentle-core/src/fs-roots.ts';
import { KEYSTORE_ENTRY_GONE_LOG, decideSeedLoad } from '../modules/gentle-core/src/seed-recovery.ts';

/** Deterministic 32-byte seed, so "the seed leaked" is an exact assertion. */
const SEED = Array.from({ length: 32 }, (_unused, index) => index + 1);
const SEED_AS_JSON = JSON.stringify(SEED);
const SEED_AS_HEX = SEED.map((byte) => byte.toString(16).padStart(2, '0')).join('');
const PUBLIC_HEX = 'aa'.repeat(32);
const FINGERPRINT = 'SHA256:Nh0Me49Zh9fDw/VYUfq43IJmI1T+XrjiYONPND8GzaM';
const HOST_FP = '66402c9468c58941dd19ffd650bf2b42f9226f83d3bd06ad515d0e5104a77020';
/** The same host key in the display form (`aa:bb:…`) the core may answer with. */
const HOST_FP_COLONS = HOST_FP.match(/.{2}/g).join(':');

/** Answers every call with a fixed document per method, recording the payloads. */
function fakeBridge(answers) {
  const calls = [];
  const make = (method) => async (payloadJson) => {
    calls.push({ method, payloadJson });
    const answer = answers[method];
    if (typeof answer === 'function') {
      return answer(payloadJson);
    }
    return JSON.stringify(answer ?? { ok: false, error: { kind: 'Unknown', message: 'sin mock' } });
  };
  return {
    calls,
    bridge: {
      deviceKeyEnsure: make('deviceKeyEnsure'),
      sshConnectWithDeviceKey: make('sshConnectWithDeviceKey'),
      sshClose: make('sshClose'),
      fsList: make('fsList'),
      fsRead: make('fsRead'),
    },
  };
}

/** Never leak the seed through a value or a message under test. */
function assertNoSeed(value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!rendered.includes(SEED_AS_JSON), `the seed leaked: ${rendered}`);
  assert.ok(!rendered.includes(SEED_AS_HEX), `the seed leaked: ${rendered}`);
  assert.ok(!rendered.includes('secret_seed'), `secret material leaked: ${rendered}`);
}

test('no bridge bound: every v2 call fails with CoreUnavailable instead of inventing data', async () => {
  bindCoreNativeBridge(null);
  assert.equal(coreNativeBridgeBound(), false);

  const calls = [
    () => deviceKeyEnsure(),
    () => sshConnectWithDeviceKey({ host: 'h', port: 22, user: 'u', expectedFingerprint: HOST_FP }),
    () => sshClose('1'),
    () => fsList({ root: '/files', path: '' }),
    () => fsRead({ root: '/files', path: 'a.ts' }),
  ];
  for (const call of calls) {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof CoreCallError, String(error));
      assert.equal(error.kind, 'CoreUnavailable');
      return true;
    });
  }
});

test('deviceKeyEnsure answers exactly the public key and the fingerprint', async () => {
  const { bridge, calls } = fakeBridge({
    deviceKeyEnsure: { ok: true, result: { publicHex: PUBLIC_HEX, fingerprint: FINGERPRINT } },
  });
  bindCoreNativeBridge(bridge);
  assert.equal(coreNativeBridgeBound(), true);

  const info = await deviceKeyEnsure();
  assert.deepEqual(info, { publicHex: PUBLIC_HEX, fingerprint: FINGERPRINT });
  assert.deepEqual(Object.keys(info).sort(), ['fingerprint', 'publicHex']);
  assertNoSeed(info);
  // The Kotlin method receives no seed: it reads it from the Keystore itself.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'deviceKeyEnsure');
  assert.equal(calls[0].payloadJson, '{}');
});

test('deviceKeyEnsure reuses the persisted identity: two ensures agree', async () => {
  // What the native side does on the second call: decrypt the sealed seed and re-derive
  // the same public half (gc_device_key_public). The TS layer must therefore see the same
  // identity twice, not a second one.
  const { bridge } = fakeBridge({
    deviceKeyEnsure: { ok: true, result: { publicHex: PUBLIC_HEX, fingerprint: FINGERPRINT } },
  });
  bindCoreNativeBridge(bridge);

  const first = await deviceKeyEnsure();
  const second = await deviceKeyEnsure();
  assert.deepEqual(first, second);
  assert.equal(first.publicHex, second.publicHex);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('deviceKeyEnsure refuses an answer that still carries the seed', async () => {
  const { bridge } = fakeBridge({
    deviceKeyEnsure: {
      ok: true,
      result: {
        publicHex: PUBLIC_HEX,
        fingerprint: FINGERPRINT,
        secret: { secret_seed: SEED },
      },
    },
  });
  bindCoreNativeBridge(bridge);

  await assert.rejects(
    () => deviceKeyEnsure(),
    (error) => {
      assert.ok(error instanceof CoreCallError);
      assert.equal(error.kind, 'Contract');
      assert.match(error.message, /material secreto/);
      assertNoSeed(error.message);
      return true;
    },
  );
});

test('deviceKeyEnsure refuses an answer without a usable public key', async () => {
  const { bridge } = fakeBridge({
    deviceKeyEnsure: { ok: true, result: { publicHex: 'abc', fingerprint: FINGERPRINT } },
  });
  bindCoreNativeBridge(bridge);
  await assert.rejects(() => deviceKeyEnsure(), (error) => {
    assert.equal(error.kind, 'Contract');
    return true;
  });
});

test('sshConnectWithDeviceKey sends the pin and never a seed', async () => {
  const { bridge, calls } = fakeBridge({
    sshConnectWithDeviceKey: {
      ok: true,
      sessionId: 7,
      // SEC-013: the connect record always names the host key the handshake verified.
      result: { sessionId: 7, fingerprint: HOST_FP_COLONS },
    },
  });
  bindCoreNativeBridge(bridge);

  const session = await sshConnectWithDeviceKey({
    host: ' 192.168.1.42 ',
    port: 2222,
    user: 'reaan',
    expectedFingerprint: HOST_FP_COLONS,
  });
  // The verified host key is part of the session, in compact hex.
  assert.deepEqual(session, { sessionId: '7', fingerprint: HOST_FP });

  const payload = JSON.parse(calls[0].payloadJson);
  assert.deepEqual(payload, {
    host: '192.168.1.42',
    port: 2222,
    user: 'reaan',
    expectedFp: HOST_FP,
  });
  // A key-only connect is pinned, and the seed stays in the Keystore: it is not this
  // layer's to send.
  assert.equal(payload.seed, undefined);
  assert.equal(payload.expectedFp, HOST_FP);
});

test('sshConnectWithDeviceKey refuses a connect without a usable pin', async () => {
  const { bridge, calls } = fakeBridge({});
  bindCoreNativeBridge(bridge);

  for (const expectedFingerprint of ['', '   ', 'not-a-fingerprint', 'aa:bb']) {
    await assert.rejects(
      () => sshConnectWithDeviceKey({ host: 'h', port: 22, user: 'u', expectedFingerprint }),
      (error) => {
        assert.ok(error instanceof CoreCallError);
        assert.equal(error.kind, 'Input');
        assert.match(error.message, /no se puede reconectar sin fijarla|SHA-256/);
        return true;
      },
    );
  }
  assert.equal(calls.length, 0, 'nothing may reach the core without a pin');
});

test('sshConnectWithDeviceKey validates host, user and port', async () => {
  const { bridge } = fakeBridge({});
  bindCoreNativeBridge(bridge);

  const cases = [
    { host: '  ', port: 22, user: 'u', expectedFingerprint: HOST_FP },
    { host: 'h', port: 22, user: '', expectedFingerprint: HOST_FP },
    { host: 'h', port: 0, user: 'u', expectedFingerprint: HOST_FP },
    { host: 'h', port: 70_000, user: 'u', expectedFingerprint: HOST_FP },
    { host: 'h', port: 22.5, user: 'u', expectedFingerprint: HOST_FP },
  ];
  for (const input of cases) {
    await assert.rejects(() => sshConnectWithDeviceKey(input), (error) => {
      assert.equal(error.kind, 'Input');
      return true;
    });
  }
});

test('a connect answer without a usable host fingerprint is a typed failure, never a session', async () => {
  // SEC-013: `result.fingerprint` is promised by the table, so an `ok:true` answer that
  // omits it (the pre-hardening core shape) must not be readable as a pinned session.
  const cases = [
    { label: 'ausente', field: undefined, reason: /el campo «fingerprint» no vino/ },
    { label: 'vacío', field: '   ', reason: /llegó vacío/ },
    { label: 'no-hex', field: 'SHA256:abc', reason: /llegó «SHA256:abc»/ },
  ];
  for (const entry of cases) {
    const result = { sessionId: 7 };
    if (entry.field !== undefined) {
      result.fingerprint = entry.field;
    }
    const fake = fakeBridge({
      sshConnectWithDeviceKey: { ok: true, sessionId: 7, result },
    });
    bindCoreNativeBridge(fake.bridge);

    await assert.rejects(
      () =>
        sshConnectWithDeviceKey({
          host: 'h',
          port: 22,
          user: 'u',
          expectedFingerprint: HOST_FP,
        }),
      (error) => {
        assert.ok(error instanceof CoreCallError, entry.label);
        assert.equal(error.kind, 'Contract', entry.label);
        // The refusal names what came instead of the fingerprint.
        assert.match(error.message, /huella del host/, entry.label);
        assert.match(error.message, entry.reason, entry.label);
        return true;
      },
    );

    // The handle the core handed out is not silently forgotten: it is closed here.
    assert.equal(fake.calls.length, 2, entry.label);
    assert.equal(fake.calls[1].method, 'sshClose', entry.label);
    assert.equal(fake.calls[1].payloadJson, JSON.stringify({ sessionId: 7 }), entry.label);
  }
});

test('sshConnectWithDeviceKey reports a refused pin as a typed ssh failure', async () => {
  const { bridge } = fakeBridge({
    sshConnectWithDeviceKey: {
      ok: false,
      error: {
        kind: 'ssh',
        message: `ssh: host key does not match the pinned fingerprint: expected ${HOST_FP}, observed ${'bb'.repeat(32)} (possible man-in-the-middle)`,
      },
    },
  });
  bindCoreNativeBridge(bridge);

  await assert.rejects(
    () =>
      sshConnectWithDeviceKey({
        host: 'h',
        port: 22,
        user: 'u',
        expectedFingerprint: HOST_FP,
      }),
    (error) => {
      assert.equal(error.kind, 'ssh');
      assert.match(error.message, /pinned fingerprint/);
      assertNoSeed(error.message);
      return true;
    },
  );
});

test('sshClose only reports a close the core really confirmed', async () => {
  const { bridge, calls } = fakeBridge({
    sshClose: { ok: true, result: { closed: true } },
  });
  bindCoreNativeBridge(bridge);

  assert.deepEqual(await sshClose('7'), { kind: 'closed', sessionId: '7' });
  assert.equal(calls[0].payloadJson, JSON.stringify({ sessionId: 7 }));

  // A non-numeric handle never reaches the core.
  await assert.rejects(() => sshClose('abc'), (error) => {
    assert.equal(error.kind, 'Input');
    return true;
  });

  // An answer that does not confirm the close is a contract failure, not a success.
  bindCoreNativeBridge(
    fakeBridge({ sshClose: { ok: true, result: { closed: false } } }).bridge,
  );
  await assert.rejects(() => sshClose('7'), (error) => {
    assert.equal(error.kind, 'Contract');
    return true;
  });

  // Closing twice (the honest typed error from the core) surfaces unchanged.
  bindCoreNativeBridge(
    fakeBridge({
      sshClose: { ok: false, error: { kind: 'ssh', message: 'ssh: unknown session id 7' } },
    }).bridge,
  );
  await assert.rejects(() => sshClose('7'), (error) => {
    assert.equal(error.kind, 'ssh');
    assert.match(error.message, /unknown session id/);
    return true;
  });
});

test('sshClose keeps a handle-removed-but-unconfirmed teardown as its own outcome', async () => {
  // `gc_ssh_close` removes the registry entry **before** awaiting the disconnect, so a
  // transport that still believes it is connected answers an `ssh` error after the handle
  // is already gone (`mobile-core/src/ffi.rs` session_close, SEC-012). That is not the same
  // fact as "still open", and it is not a generic error either: it is a value.
  const message =
    'ssh: session 7 was removed but the transport still reports an open connection: the teardown did not reach the host';
  bindCoreNativeBridge(
    fakeBridge({ sshClose: { ok: false, error: { kind: 'ssh', message } } }).bridge,
  );

  const outcome = await sshClose('7');

  assert.deepEqual(outcome, {
    kind: 'removed-unconfirmed',
    sessionId: '7',
    message,
    raw: { kind: 'ssh', message },
  });
  // It neither throws nor claims a `closed` the transport never confirmed.
  assert.equal(outcome.closed, undefined);
});

test('fsList maps the core entries and refuses an unknown kind', async () => {
  const { bridge, calls } = fakeBridge({
    fsList: {
      ok: true,
      result: {
        entries: [
          { path: 'src', size: null, kind: 'dir' },
          { path: 'src/main.ts', size: 42, kind: 'file' },
        ],
        truncated: false,
      },
    },
  });
  bindCoreNativeBridge(bridge);

  const listing = await fsList({ root: '/data/files', path: 'src', maxEntries: 20 });
  assert.deepEqual(listing, {
    entries: [
      { path: 'src', size: null, kind: 'dir' },
      { path: 'src/main.ts', size: 42, kind: 'file' },
    ],
  });
  assert.deepEqual(JSON.parse(calls[0].payloadJson), {
    root: '/data/files',
    path: 'src',
    maxEntries: 20,
  });

  // The frozen contract has two kinds; anything else is a contract failure, never a guess.
  bindCoreNativeBridge(
    fakeBridge({
      fsList: {
        ok: true,
        result: { entries: [{ path: 'link', size: 1, kind: 'symlink' }], truncated: false },
      },
    }).bridge,
  );
  await assert.rejects(() => fsList({ root: '/data/files', path: '' }), (error) => {
    assert.equal(error.kind, 'Contract');
    assert.match(error.message, /tipo desconocido/);
    return true;
  });

  // A missing root never reaches the core.
  await assert.rejects(() => fsList({ root: '   ', path: '' }), (error) => {
    assert.equal(error.kind, 'Input');
    return true;
  });
});

test('fsList surfaces the typed file errors with their own kind', async () => {
  for (const kind of ['not_found', 'permission_denied', 'invalid_path', 'outside_root']) {
    bindCoreNativeBridge(
      fakeBridge({
        fsList: { ok: false, error: { kind, message: `${kind}: src` } },
      }).bridge,
    );
    await assert.rejects(() => fsList({ root: '/data/files', path: 'src' }), (error) => {
      assert.equal(error.kind, kind);
      return true;
    });
  }
});

test('fsRead reports the real size and the truncation flag', async () => {
  const { bridge, calls } = fakeBridge({
    fsRead: {
      ok: true,
      result: { path: 'src/main.ts', text: 'export {};\n', size: 4096, truncated: true },
    },
  });
  bindCoreNativeBridge(bridge);

  const read = await fsRead({ root: '/data/files', path: 'src/main.ts', maxBytes: 11 });
  assert.deepEqual(read, {
    path: 'src/main.ts',
    text: 'export {};\n',
    size: 4096,
    truncated: true,
  });
  assert.deepEqual(JSON.parse(calls[0].payloadJson), {
    root: '/data/files',
    path: 'src/main.ts',
    maxBytes: 11,
  });
});

test('fsRead refuses a binary file instead of decoding it', async () => {
  bindCoreNativeBridge(
    fakeBridge({
      fsRead: { ok: false, error: { kind: 'binary', message: 'binary file: logo.png is not text' } },
    }).bridge,
  );
  await assert.rejects(() => fsRead({ root: '/data/files', path: 'logo.png' }), (error) => {
    assert.equal(error.kind, 'binary');
    assert.match(error.message, /not text/);
    // No replacement-character text was produced for it.
    assert.equal(error.text, undefined);
    return true;
  });
});

test('fsRead refuses a file past the hard cap and reports its real size', async () => {
  bindCoreNativeBridge(
    fakeBridge({
      fsRead: {
        ok: false,
        error: {
          kind: 'too_large',
          message: 'file too large: huge.bin is 8388609 bytes (limit 8388608)',
        },
      },
    }).bridge,
  );
  await assert.rejects(() => fsRead({ root: '/data/files', path: 'huge.bin' }), (error) => {
    assert.equal(error.kind, 'too_large');
    assert.match(error.message, /8388609/);
    return true;
  });
});

test('a broken envelope is a contract failure, never a default value', async () => {
  bindCoreNativeBridge(fakeBridge({ deviceKeyEnsure: () => 'not json' }).bridge);
  await assert.rejects(() => deviceKeyEnsure(), (error) => {
    assert.equal(error.kind, 'Contract');
    return true;
  });

  bindCoreNativeBridge(fakeBridge({ deviceKeyEnsure: () => '' }).bridge);
  await assert.rejects(() => deviceKeyEnsure(), (error) => {
    assert.equal(error.kind, 'NativeError');
    return true;
  });

  // A thrown native call becomes a NativeError instead of escaping as something else.
  bindCoreNativeBridge(
    fakeBridge({
      deviceKeyEnsure: () => {
        throw new Error('UnsatisfiedLinkError');
      },
    }).bridge,
  );
  await assert.rejects(() => deviceKeyEnsure(), (error) => {
    assert.ok(error instanceof CoreCallError);
    assert.equal(error.kind, 'NativeError');
    return true;
  });

  assert.throws(() => parseEnvelope('x', '{"ok":true}'), (error) => {
    assert.equal(error.kind, 'Contract');
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * SEC-001 — the device seed has no JS-reachable producer
 *
 * The audit found the plaintext seed reachable twice: `gc_device_key_generate` was on the
 * `callGc` whitelist and `deviceKeyGenerate` was exported to the runtime. The refusal now
 * lives in the producer (the Kotlin whitelist), so these tests read the sources that
 * *define* the JS surface and fail if the key-material path grows back. The behavioural
 * half ("an answer that carries the seed is refused") is the `deviceKeyEnsure` test above.
 * ------------------------------------------------------------------ */

/** Absolute URL of a file inside the native module. */
function moduleSource(relativePath) {
  return readFileSync(new URL(relativePath, new URL('../modules/gentle-core/', import.meta.url)), 'utf8');
}

/** Absolute URL of a file directly under `mobile/`. */
function mobileSource(relativePath) {
  return readFileSync(new URL(relativePath, new URL('../', import.meta.url)), 'utf8');
}

/** The names `GcCoreModule.callGc` accepts, read from the Kotlin source. */
function kotlinJsReachableFunctions() {
  const text = moduleSource('android/src/main/java/com/gentlemovil/core/GcCoreModule.kt');
  const start = text.indexOf('jsReachableFunctions: Set<String> = setOf(');
  assert.notEqual(start, -1, 'the JS-reachable whitelist disappeared from GcCoreModule.kt');
  const end = text.indexOf('\n  )', start);
  assert.notEqual(end, -1, 'the JS-reachable whitelist is not a closed `setOf(…)` block');
  return [...text.slice(start, end).matchAll(/"(gc_[a-z_]+)"/g)].map((match) => match[1]);
}

/** The `AsyncFunction("…")` names the module registers with the JS runtime. */
function kotlinAsyncFunctions() {
  const text = moduleSource('android/src/main/java/com/gentlemovil/core/GcCoreModule.kt');
  return [...text.matchAll(/AsyncFunction\("([A-Za-z]+)"\)/g)].map((match) => match[1]);
}

test('no JS-reachable core function can answer with a seed or a secret', () => {
  const reachable = kotlinJsReachableFunctions();
  assert.deepEqual(
    [...reachable].sort(),
    [
      'gc_abi_version',
      'gc_fs_list',
      'gc_fs_read',
      'gc_pair_from_qr',
      'gc_provision_step',
      'gc_ssh_channel_close',
      'gc_ssh_channel_read',
      'gc_ssh_channel_write',
      'gc_ssh_close',
      'gc_ssh_connect',
    ],
    'the JS-reachable whitelist changed: it must stay the non-secret surface',
  );
  // The three seed symbols: one answers the seed, one takes it, one derives from it.
  for (const seedSymbol of [
    'gc_device_key_generate',
    'gc_device_key_public',
    'gc_ssh_connect_seed',
  ]) {
    assert.equal(
      reachable.includes(seedSymbol),
      false,
      `${seedSymbol} is JS-reachable again through callGc`,
    );
  }
  // ...and no AsyncFunction smuggles the same path in as a convenience method.
  const asyncFunctions = kotlinAsyncFunctions();
  assert.deepEqual(
    [...asyncFunctions].sort(),
    [
      'abiVersion',
      'callGc',
      'deviceKeyEnsure',
      'fsList',
      'fsRead',
      'pairFromQr',
      'provisionStep',
      'sshChannelClose',
      'sshChannelRead',
      'sshChannelWrite',
      'sshClose',
      'sshConnect',
      'sshConnectWithDeviceKey',
    ],
    'the module exposes an AsyncFunction the frozen TS contract does not have',
  );
  assert.equal(
    asyncFunctions.some((name) => /generate|seed/i.test(name)),
    false,
    'an AsyncFunction that mints or carries the seed is exported to JS again',
  );
});

test('the TS facade does not export a seed-producing call', () => {
  // `index.ts`'s `GcFunction` union is the JS-facing name list.
  const index = moduleSource('index.ts');
  const unionStart = index.indexOf('export type GcFunction =');
  assert.notEqual(unionStart, -1, 'index.ts lost its GcFunction union');
  const unionEnd = index.indexOf(';', unionStart);
  const unionNames = [...index.slice(unionStart, unionEnd).matchAll(/'(gc_[a-z_]+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...unionNames].sort(), [...kotlinJsReachableFunctions()].sort());
  assert.equal(/\bdeviceKeyGenerate\b/.test(index), false, 'index.ts exports deviceKeyGenerate again');
  assert.equal(
    /\bdeviceKeyGenerate\b/.test(mobileSource('lib/core.ts')),
    false,
    'lib/core.ts offers deviceKeyGenerate again',
  );
  assert.equal(
    /\bDeviceKeyPair\b/.test(mobileSource('lib/core.ts')),
    false,
    'lib/core.ts still describes a "generate and hand back the keypair" value',
  );

  // The runtime export surface of the pure ABI layer: no function that could answer key
  // material, and nothing beyond the frozen list.
  const exported = Object.keys(abiSurface).sort();
  assert.deepEqual(exported, [
    'CoreCallError',
    'bindCoreNativeBridge',
    'compactFingerprint',
    'coreNativeBridgeBound',
    'deviceKeyEnsure',
    'fsList',
    'fsRead',
    'parseEnvelope',
    'sshClose',
    'sshConnectWithDeviceKey',
  ]);
  for (const name of exported) {
    if (typeof abiSurface[name] !== 'function') {
      continue;
    }
    assert.equal(
      /generate|seed/i.test(name),
      false,
      `the ABI layer exports «${name}», which looks like a seed path`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * SEC-003 — the file root allowlist
 *
 * The authoritative decision is `FsRoots.kt` on the device (it is the trust boundary), and
 * `src/fs-roots.ts` is its plain-node twin: same refusals, same kinds, same messages. These
 * tests pin the table; the Kotlin structural test below proves the guard is actually wired
 * into the only path JS can take.
 * ------------------------------------------------------------------ */

const FILES_DIR = '/data/user/0/com.anonymous.gentlemovil/files';
const CACHE_DIR = '/data/user/0/com.anonymous.gentlemovil/cache';
const ALLOWED_ROOTS = [FILES_DIR, CACHE_DIR];

test('an app-private root and anything below it are allowed', () => {
  for (const root of [
    FILES_DIR,
    `${FILES_DIR}/`,
    `${FILES_DIR}//projects`,
    `${FILES_DIR}/projects/p1`,
    CACHE_DIR,
    '/data/user/0/com.anonymous.gentlemovil/files/./projects',
  ]) {
    const decision = decideFsRoot(root, ALLOWED_ROOTS);
    assert.equal(decision.ok, true, `${root} was refused`);
  }
  // Normalized, not echoed: `.`, `//` and a trailing `/` never reach the native layer.
  assert.deepEqual(decideFsRoot(`${FILES_DIR}/projects/`, ALLOWED_ROOTS), {
    ok: true,
    root: `${FILES_DIR}/projects`,
  });
  assert.deepEqual(normalizeFsRoot('//data//user/0/x/files/'), {
    ok: true,
    root: '/data/user/0/x/files',
  });
});

test('a root outside the app refused, naming the real root and the real allowed roots', () => {
  for (const root of [
    '/etc',
    '/sdcard',
    '/sdcard/Download',
    '/', // well formed, but the allowlist is not the whole filesystem
    '/data/user/0/com.anonymous.gentlemovil', // the parent: not ours to walk
    '/data/user/0/com.anonymous.gentlemovil/files-evil', // prefix trap
    '/data/user/0/com.anonymous.gentlemovil/files2',
  ]) {
    const decision = decideFsRoot(root, ALLOWED_ROOTS);
    assert.equal(decision.ok, false, `${root} was allowed`);
    assert.equal(decision.kind, 'outside_root');
    assert.equal(decision.requested, root);
    assert.deepEqual(decision.allowedRoots, ALLOWED_ROOTS);
    assert.equal(
      decision.message,
      fsRootOutsideMessage(root, ALLOWED_ROOTS),
    );
    // The refusal is honest: the real root and the real allowlist are both in the text.
    assert.ok(decision.message.includes(root), `the message hides the refused root: ${decision.message}`);
    for (const allowed of ALLOWED_ROOTS) {
      assert.ok(
        decision.message.includes(allowed),
        `the message hides the allowed root ${allowed}: ${decision.message}`,
      );
    }
    // No silent fallback: nothing came back that the caller could read instead.
    assert.equal(decision.root, undefined);
  }
});

/* ------------------------------------------------------------------ *
 * SEC-003 — roots arrive as `file://` URIs from the app's own APIs
 * ------------------------------------------------------------------ */

test('a file:// root is normalized to its device path, never forwarded as a URI', () => {
  // The app resolves its documents dir with `expo-file-system`, which answers a
  // `file://` URI. The core and the native allowlist expect the canonical path.
  for (const [requested, expected] of [
    ['file:///data/user/0/x/files', '/data/user/0/x/files'],
    ['file:///data/user/0/x/files/', '/data/user/0/x/files'],
    ['file:///data/user/0/x/files//', '/data/user/0/x/files'],
    ['file:////data//user/0/x/files', '/data/user/0/x/files'],
    ['/data/user/0/x/files/', '/data/user/0/x/files'],
    ['/data/user/0/x/files', '/data/user/0/x/files'],
  ]) {
    assert.deepEqual(normalizeDeviceRoot(requested), { ok: true, root: expected }, requested);
  }
  // The allowlist sees the same normalized path, so a URI cannot slip past it.
  assert.deepEqual(decideFsRoot(`file://${FILES_DIR}/proyectos/vita-app/`, ALLOWED_ROOTS), {
    ok: true,
    root: `${FILES_DIR}/proyectos/vita-app`,
  });
});

test('an empty or relative root is refused naming the value it arrived with', () => {
  for (const [requested, expected] of [
    ['', /Falta la raíz absoluta/],
    ['   ', /Falta la raíz absoluta/],
    ['etc', /«etc» no es una ruta absoluta/],
    ['proyectos/vita-app', /«proyectos\/vita-app» no es una ruta absoluta/],
    ['file://', /«file:\/\/» no es una ruta absoluta/],
    ['file://relative/vita-app', /«file:\/\/relative\/vita-app» no es una ruta absoluta/],
    [`file://${FILES_DIR}/../../etc`, /sube con «\.\.»/],
  ]) {
    const decision = normalizeDeviceRoot(requested);
    assert.equal(decision.ok, false, `${requested} was allowed`);
    assert.equal(decision.kind, 'invalid_path');
    assert.match(decision.message, expected);
    assert.equal(decision.root, undefined);
  }
  // A NUL byte is refused and never echoed into the message.
  const nul = normalizeDeviceRoot(`file://${FILES_DIR}/a\u0000b`);
  assert.equal(nul.ok, false);
  assert.equal(nul.kind, 'invalid_path');
  assert.equal(nul.message.includes('\u0000'), false);
});

test('fsList and fsRead send the canonical path of a file:// root', async () => {
  const { bridge, calls } = fakeBridge({
    fsList: { ok: true, result: { entries: [], truncated: false } },
    fsRead: { ok: true, result: { path: 'a.ts', text: '', size: 0, truncated: false } },
  });
  bindCoreNativeBridge(bridge);

  await fsList({ root: `file://${FILES_DIR}/`, path: '' });
  await fsRead({ root: `file://${FILES_DIR}/proyectos/vita-app/`, path: 'a.ts' });

  assert.deepEqual(JSON.parse(calls[0].payloadJson), { root: FILES_DIR, path: '' });
  assert.deepEqual(JSON.parse(calls[1].payloadJson), {
    root: `${FILES_DIR}/proyectos/vita-app`,
    path: 'a.ts',
  });
  // The scheme never reaches the bridge, so the native allowlist judges a real path.
  for (const call of calls) {
    assert.equal(JSON.parse(call.payloadJson).root.startsWith('/'), true);
  }
});

/* ------------------------------------------------------------------ *
 * SEC-003 — refusals
 * ------------------------------------------------------------------ */

test('a root that cannot be resolved is invalid_path, never a rewritten path', () => {
  const cases = [
    ['', /Falta la raíz absoluta/],
    ['   ', /Falta la raíz absoluta/],
    ['etc', /no es una ruta absoluta/],
    ['files', /no es una ruta absoluta/],
    [`${FILES_DIR}/../../etc`, /sube con «\.\.»/],
    [`${FILES_DIR}/..`, /sube con «\.\.»/],
    ['..', /no es una ruta absoluta/],
  ];
  for (const [root, expected] of cases) {
    const decision = decideFsRoot(root, ALLOWED_ROOTS);
    assert.equal(decision.ok, false, `${root} was allowed`);
    assert.equal(decision.kind, 'invalid_path');
    assert.match(decision.message, expected);
    assert.equal(decision.root, undefined);
  }
  // A NUL byte is refused and never echoed into the message.
  const nul = decideFsRoot(`${FILES_DIR}/a\u0000b`, ALLOWED_ROOTS);
  assert.equal(nul.ok, false);
  assert.equal(nul.kind, 'invalid_path');
  assert.equal(nul.message.includes('\u0000'), false);
});

test('nothing is allowed when the device reports no allowed root', () => {
  const decision = decideFsRoot(FILES_DIR, []);
  assert.equal(decision.ok, false);
  assert.equal(decision.kind, 'outside_root');
  assert.match(decision.message, /\(ninguna\)/);
  // A non-absolute allowlist entry is a bug, not a wildcard: it is dropped, not honoured.
  assert.equal(decideFsRoot(FILES_DIR, ['files']).ok, false);
});

test('insideFsRoot only walks down a path boundary', () => {
  assert.equal(insideFsRoot(`${FILES_DIR}/a`, FILES_DIR), true);
  assert.equal(insideFsRoot(FILES_DIR, FILES_DIR), true);
  assert.equal(insideFsRoot(`${FILES_DIR}-evil`, FILES_DIR), false);
  assert.equal(insideFsRoot('/data', FILES_DIR), false);
  assert.equal(insideFsRoot('/a', '/'), true);
});

test('fsList and fsRead refuse an impossible root before it reaches the bridge', async () => {
  const { bridge, calls } = fakeBridge({
    fsList: { ok: true, result: { entries: [], truncated: false } },
    fsRead: { ok: true, result: { path: 'a.ts', text: '', size: 0, truncated: false } },
  });
  bindCoreNativeBridge(bridge);

  // `/` is well formed, so the TS layer forwards it and the native allowlist refuses it;
  // what cannot cross the bridge at all is a root that is not an absolute, non-escaping path.
  for (const root of ['etc', `${FILES_DIR}/../../etc`, 'a/../b', '../etc']) {
    await assert.rejects(() => fsList({ root, path: '' }), (error) => {
      assert.ok(error instanceof CoreCallError);
      assert.equal(error.kind, 'invalid_path');
      assert.ok(error.message.length > 0);
      return true;
    });
    await assert.rejects(() => fsRead({ root, path: 'a.ts' }), (error) => {
      assert.equal(error.kind, 'invalid_path');
      return true;
    });
  }
  assert.equal(calls.length, 0, 'an impossible root crossed the bridge');

  // A well-formed root is normalized on the way in; the allowlist itself is native.
  await fsList({ root: `${FILES_DIR}/`, path: '' });
  assert.deepEqual(JSON.parse(calls[0].payloadJson), { root: FILES_DIR, path: '' });
});

test('the Kotlin guard is wired into the only path JavaScript can take', () => {
  const kotlin = moduleSource('android/src/main/java/com/gentlemovil/core/GcCoreModule.kt');
  const roots = moduleSource('android/src/main/java/com/gentlemovil/core/FsRoots.kt');

  // The decision object exists, resolves against the app's private directories and holds
  // the single documented (empty) SAF hook instead of pretending SAF works.
  assert.match(roots, /filesDir/);
  assert.match(roots, /cacheDir/);
  assert.match(roots, /fun decide\(/);
  assert.match(roots, /private fun safGrantedRoots[\s\S]*?emptyList\(\)/);
  assert.match(roots, /KIND_OUTSIDE_ROOT = "outside_root"/);
  assert.match(roots, /KIND_INVALID_PATH = "invalid_path"/);

  // dispatch is the only JS entry point; it guards both file symbols before invoke.
  assert.match(kotlin, /fn != "gc_fs_list" && fn != "gc_fs_read"/);
  assert.match(kotlin, /FsRoots\.decide\(/);
  assert.match(kotlin, /FsRoots\.allowedRoots\(/);
  assert.match(kotlin, /guardFileRoot\(fn, payload\)/);
  // The canonical root replaces the caller's, so the core never sees the raw string.
  assert.match(kotlin, /put\("root", decision\.root\.absolutePath\)/);
  // A refusal is an envelope, never a fallback directory.
  assert.match(kotlin, /is Forwarding\.Refuse -> failureEnvelope\(guarded\.kind, guarded\.message\)/);
});

/* ------------------------------------------------------------------ *
 * SEC-004 — the identity is recoverable, and it does not leave the device
 * ------------------------------------------------------------------ */

test('a sealed seed without its Keystore entry is "no key", not a permanent brick', () => {
  assert.deepEqual(decideSeedLoad({ ciphertextPresent: false, keystoreEntryPresent: false }), {
    action: 'mint-fresh-identity',
    reason: 'no-sealed-seed',
    discardCiphertext: false,
  });
  assert.deepEqual(decideSeedLoad({ ciphertextPresent: false, keystoreEntryPresent: true }), {
    action: 'mint-fresh-identity',
    reason: 'no-sealed-seed',
    discardCiphertext: false,
  });
  // The restore case the audit named: ciphertext came back, the non-exportable key did not.
  assert.deepEqual(decideSeedLoad({ ciphertextPresent: true, keystoreEntryPresent: false }), {
    action: 'mint-fresh-identity',
    reason: 'keystore-entry-gone',
    discardCiphertext: true,
  });
  // Healthy device: read the sealed seed, do not mint a second identity.
  assert.deepEqual(decideSeedLoad({ ciphertextPresent: true, keystoreEntryPresent: true }), {
    action: 'read-sealed-seed',
  });
  // Unreadable with the entry present stays a typed failure: no silent rotation.
  assert.deepEqual(
    decideSeedLoad({ ciphertextPresent: true, keystoreEntryPresent: true, ciphertextReadable: false }),
    { action: 'report-unreadable', reason: 'unreadable-sealed-seed' },
  );
  // The log line names the state, never key material.
  assert.match(KEYSTORE_ENTRY_GONE_LOG, /AndroidKeyStore entry is gone/);
  assert.equal(KEYSTORE_ENTRY_GONE_LOG.includes('seed'), false);
});

test('the Android module applies the recovery instead of an opaque KeystoreUnavailable', () => {
  const kotlin = moduleSource('android/src/main/java/com/gentlemovil/core/GcCoreModule.kt');
  const store = moduleSource('android/src/main/java/com/gentlemovil/core/DeviceSeedStore.kt');

  // The store distinguishes "entry gone" from "file unreadable".
  assert.match(store, /class MissingKeystoreEntryException/);
  assert.match(store, /throw MissingKeystoreEntryException\(/);

  // deviceKeyEnsure routes the seed through the recovery, discards the stale ciphertext,
  // logs the real cause with the shared message and mints fresh.
  assert.match(kotlin, /catch \(error: DeviceSeedStore\.MissingKeystoreEntryException\)/);
  assert.match(kotlin, /DeviceSeedStore\.delete\(file\)/);
  assert.match(kotlin, /Log\.w\(LOG_TAG, KEYSTORE_ENTRY_GONE_LOG\)/);
  assert.match(kotlin, /private fun seedForIdentity\(file: File\): ByteArray/);
  assert.match(kotlin, /val seed = seedForIdentity\(file\)/);
  // The same text as `KEYSTORE_ENTRY_GONE_LOG`, so a device report is searchable.
  const kotlinLog = kotlin
    .slice(kotlin.indexOf('const val KEYSTORE_ENTRY_GONE_LOG ='))
    .split('\n  }')[0]
    .replace(/const val KEYSTORE_ENTRY_GONE_LOG =/, '')
    .replace(/[\n\r\t ]+/g, ' ')
    .replace(/\s*\+\s*/g, '')
    .replace(/"/g, '')
    .trim();
  assert.equal(kotlinLog, KEYSTORE_ENTRY_GONE_LOG);
});

test('the log line never carries an answer body', () => {
  const kotlin = moduleSource('android/src/main/java/com/gentlemovil/core/GcCoreModule.kt');
  // `describeAnswer` is the only thing interpolated into a log call.
  assert.match(kotlin, /Log\.d\(LOG_TAG, "\$fn \$\{describeAnswer\(response\)\}"\)/);
  assert.equal(
    /Log\.[a-z]\("?[A-Za-z]*"?[^)]*\$response/.test(kotlin),
    false,
    'a log call interpolates the raw response again',
  );
});

test('the backup policy is off, and the packaging plugin is still declared', () => {
  const appJson = JSON.parse(mobileSource('app.json'));
  // android/ is generated by `expo prebuild`: this field is the durable place for it.
  assert.equal(appJson.expo.android.allowBackup, false);
  assert.equal(
    JSON.stringify(appJson).includes('"allowBackup":true'),
    false,
    'a generated/manifest-style allowBackup=true is back in app.json',
  );
  // PRESERVE: the prebuild plugin that keeps `expo.useLegacyPackaging=true` is untouched.
  assert.ok(
    appJson.expo.plugins.includes('./plugins/with-legacy-packaging'),
    'the legacy packaging plugin disappeared from app.json',
  );
});
