# gentle-core — Expo native module for the Rust core

Thin JNI bridge between the app and `mobile-core` (`libmobile_core.so`). It
contains **no product logic**: it loads the library, forwards JSON documents to
the frozen C ABI, and turns anything that goes wrong into an envelope the TS
layer can render.

```
modules/gentle-core/
├── expo-module.config.json          # autolinked module (com.gentlemovil.core)
├── package.json                     # local module marker
├── index.ts                         # typed facade: callGc(fn, payloadJson)
├── src/abi.ts                       # pure ABI v2 contract (node-testable)
├── src/fs-roots.ts                  # pure SEC-003 root allowlist decision (twin of FsRoots.kt)
├── src/seed-recovery.ts             # pure SEC-004 seed recovery decision
├── android/build.gradle             # expo-module-gradle-plugin, namespace
├── android/src/main/java/com/gentlemovil/core/
│   ├── GcNative.kt                  # System.loadLibrary + extern "C" declarations
│   ├── GcCoreModule.kt              # Expo module: dispatch + envelopes
│   ├── FsRoots.kt                   # SEC-003: which roots gc_fs_* may read
│   └── DeviceSeedStore.kt           # AndroidKeystore AES/GCM seal of the device seed
└── README.md                        # this file
```

## Where `libmobile_core.so` must be copied

The parent/owner copies the built library (arm64-v8a only for v1) to:

```
mobile/android/app/src/main/jniLibs/arm64-v8a/libmobile_core.so
```

Rules:

- Directory name **must** be `arm64-v8a` (the ABI the release build targets:
  `-PreactNativeArchitectures=arm64-v8a`).
- File name **must** be `libmobile_core.so` — `System.loadLibrary("mobile_core")`
  resolves exactly that name.
- Add the other ABI folders (`armeabi-v7a`, `x86_64`) only after the core
  publishes those artifacts.
- The copy is not committed by the agent; it is a build input.

Without the file the module still builds and runs: `GcNative.available` stays
`false`, every call answers

```json
{"ok":false,"error":{"kind":"CoreUnavailable","message":"…"},"raw":null}
```

and `lib/provision.ts` reports a failed step (the screen shows the honest
failure callout, and `lib/logger.ts` persists it). Nothing crashes.

## C ABI expected from `mobile-core`

Each symbol receives/returns a UTF-8 JSON document (`char*`, owned by the core).
The JNI wrapper must copy the `char*` into a `jstring` and free it with
`gc_free`.

### JS-reachable whitelist (SEC-001)

`callGc` accepts **only** the names in `GcCoreModule.jsReachableFunctions`; every other
string answers `{"ok":false,"error":{"kind":"UnknownFunction"}}` before JNI:

```
gc_abi_version  gc_pair_from_qr  gc_ssh_connect  gc_ssh_close  gc_provision_step
gc_fs_list  gc_fs_read  gc_ssh_channel_write  gc_ssh_channel_read  gc_ssh_channel_close
```

The seed-bearing symbols (`gc_device_key_generate`, `gc_device_key_public`,
`gc_ssh_connect_seed`) are **not** on that list and are not exported by `index.ts` either:
`GcCoreModule` calls them itself for `deviceKeyEnsure`/`sshConnectWithDeviceKey`, so the
plaintext device seed never enters the JS runtime. There is no JS-callable API that
answers with a seed, and `mobile/test/core-abi.test.mjs` reads this whitelist out of the
Kotlin source so it cannot quietly grow back.

| Facade call                 | C symbol                | Payload the app sends                                                   |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `callGc('gc_abi_version')`  | `gc_abi_version()`      | none (`{}`)                                                             |
| `callGc('gc_pair_from_qr')` | `gc_pair_from_qr(json)` | `{"uri":"gc://pair?…"}`                                                |
| `callGc('gc_ssh_connect')`  | `gc_ssh_connect(json)`  | `{"pair":{…},"credential":{…}}` (`credential` is `null` on the QR path)  |
| `callGc('gc_provision_step')` | `gc_provision_step(json)` | `{"step":"fingerprint-confirm"…"rollback","pair":{…},"credential":{…},"attempt":1,"sessionId":"…"}` |
| `callGc('gc_ssh_channel_write')` | `gc_ssh_channel_write(json)` | `{"sessionId":N,"channelId":M,"bytes":"<standard base64>"}` |
| `callGc('gc_ssh_channel_read')` | `gc_ssh_channel_read(json)` | `{"sessionId":N,"channelId":M,"timeoutMs":K}` (`timeoutMs` optional; `0` is a non-blocking poll, absent uses the bounded default) |
| `callGc('gc_ssh_channel_close')` | `gc_ssh_channel_close(json)` | `{"sessionId":N,"channelId":M}` |
| `deviceKeyEnsure()`         | `gc_device_key_generate` + `gc_device_key_public` (Kotlin only) | `{}` → `{"ok":true,"result":{"publicHex","fingerprint"}}` |
| `sshConnectWithDeviceKey()` | `gc_ssh_connect_seed(json)` (Kotlin only) | `{"host","port","user","expectedFp","seed":[..32 bytes..]}` (the seed is added by Kotlin from the Keystore) |
| `sshClose()`                | `gc_ssh_close(json)`    | `{"sessionId":N}` → `{"ok":true,"result":{"closed":true}}` |
| `fsList()`                  | `gc_fs_list(json)`      | `{"root":"<absolute dir>","path":"<rel>","maxEntries":N}` |
| `fsRead()`                  | `gc_fs_read(json)`      | `{"root":"<absolute dir>","path":"<rel>","maxBytes":N}` |

### File roots (SEC-003)

`gc_fs_list` / `gc_fs_read` take their root from the caller, so `GcCoreModule.guardFileRoot`
resolves it with `FsRoots.decide` before JNI and rewrites it to its **canonical** path. Only
the app's private directories are allowed (`Context.filesDir`, `Context.cacheDir`); the root
must be one of them or below one on a path boundary (`/files-evil` is not inside `/files`).
Anything else is refused with `invalid_path` (empty, relative, NUL, `..`, unresolvable) or
`outside_root`, and the message names the real root and the real allowed roots. There is no
silent fallback. User-picked SAF trees do not exist yet: `FsRoots.safGrantedRoots` is the
documented (empty) hook where they will be registered, so no SAF path is pretended to work.
The decision table is pinned in plain node against its TS twin `src/fs-roots.ts`
(`mobile/test/core-abi.test.mjs`); canonicalization/symlink resolution only exists on device.

### Backup and identity recovery (SEC-004)

`expo.android.allowBackup: false` in `mobile/app.json` keeps the sealed seed off any backup
cloud (the `android/` directory is generated by `expo prebuild`, so the field is the durable
place). Independently, `deviceKeyEnsure` treats "ciphertext present but the AndroidKeyStore
entry is gone" as "no key": it deletes the stale ciphertext, logs the real cause
(`device key: sealed ciphertext present but the AndroidKeyStore entry is gone …`, no key
material) and mints a fresh identity instead of answering an unrecoverable
`KeystoreUnavailable`. A ciphertext that exists with its entry but does not decrypt stays a
typed failure, so the identity is never rotated silently. The table is `decideSeedLoad` in
`src/seed-recovery.ts`.

The ABI version is **2** since T16/T18 (`gc_abi_version()`): v1 keeps every shape it had,
`gc_ssh_connect` only gained an optional `expectedFp`, and the five new frozen TS calls are
implemented in `index.ts` + `src/abi.ts` over these symbols.

The three channel calls are the app's data path over the tunnel the `tunnel`
provisioning step opened: `channelId` is the `channel_id` that step reported, and
the handle stays valid across calls until `gc_ssh_channel_close`. They answer
`{"ok":true,"result":{"written":N}}`, `{"ok":true,"result":{"bytes":"<base64>","eof":false}}`
and `{"ok":true,"result":{"closed":true}}` respectively; an expired read window
is an empty `bytes` with `eof:false`, never an error.

Response envelope (both directions):

```json
{"ok":true,  "result":{…}, "raw":null}
{"ok":false, "error":{"kind":"ChecksumMismatch","message":"El checksum del daemon no coincide — instalación abortada"},"raw":"…"}
```

`raw` carries the unparsed host output (stderr, JSON body) so the logger can
persist the evidence and the UI shows the verbatim `message`.

## JNI symbols the wrapper must export

JNI mangles names per class, so the wrapper (a ~60-line C file next to the Rust
crate, or `#[no_mangle]` re-exports in `mobile-core`) must export exactly:

| Kotlin declaration               | JNI symbol                                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| `GcNative.gcAbiVersion()`       | `Java_com_gentlemovil_core_GcNative_gcAbiVersion`                |
| `GcNative.gcPairFromQr(String)` | `Java_com_gentlemovil_core_GcNative_gcPairFromQr`                |
| `GcNative.gcSshConnect(String)` | `Java_com_gentlemovil_core_GcNative_gcSshConnect`                |
| `GcNative.gcSshConnectSeed(String)` | `Java_com_gentlemovil_core_GcNative_gcSshConnectSeed`        |
| `GcNative.gcSshClose(String)`    | `Java_com_gentlemovil_core_GcNative_gcSshClose`                  |
| `GcNative.gcDeviceKeyPublic(String)` | `Java_com_gentlemovil_core_GcNative_gcDeviceKeyPublic`       |
| `GcNative.gcFsList(String)`      | `Java_com_gentlemovil_core_GcNative_gcFsList`                    |
| `GcNative.gcFsRead(String)`      | `Java_com_gentlemovil_core_GcNative_gcFsRead`                    |
| `GcNative.gcProvisionStep(String)` | `Java_com_gentlemovil_core_GcNative_gcProvisionStep`         |
| `GcNative.gcSshChannelWrite(String)` | `Java_com_gentlemovil_core_GcNative_gcSshChannelWrite`     |
| `GcNative.gcSshChannelRead(String)` | `Java_com_gentlemovil_core_GcNative_gcSshChannelRead`       |
| `GcNative.gcSshChannelClose(String)` | `Java_com_gentlemovil_core_GcNative_gcSshChannelClose`     |
| `GcNative.gcDeviceKeyGenerate(String)` | `Java_com_gentlemovil_core_GcNative_gcDeviceKeyGenerate` |
| `GcNative.gcFree(long)`         | `Java_com_gentlemovil_core_GcNative_gcFree`                      |

The three channel shims receive one document and split it themselves, exactly
like `gcProvisionStep` splits `sessionId`: `sessionId` and `channelId` become the
C ABI's two `u64` arguments and every other field (`bytes`, `timeoutMs`) is
forwarded untouched. A document without a usable `sessionId` or `channelId`
answers `{"ok":false,"error":{"kind":"input","message":"…"}}` instead of
calling the core or crashing.

The shims live in `mobile-core/src/jni_shim.rs` and are compiled only for
`aarch64-linux-android` with `--features jni-shim`. `mobile-core/build-android.sh`
passes that flag and refuses to install a library that exports no
`Java_com_gentlemovil_core_GcNative_` symbol, so a feature-less build (which used to
produce a `.so` with none of these symbols and made every call fail with
`UnsatisfiedLinkError`) cannot ship again. The document splitter they call lives in
`mobile_core::cabi::split_channel_document` so it is covered by the offline suite.

Kotlin class/method names are the contract: change them **only** together with
the wrapper. If the library loads but a symbol is missing, the module answers
`CoreUnavailable` (see `GcCoreModule.dispatch`) instead of crashing.

## Building

```sh
cd mobile/android
ANDROID_HOME=/mnt/disco900/sonora-mobile-tools/android-sdk \
JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java)))) \
./gradlew assembleRelease -x lint -PreactNativeArchitectures=arm64-v8a --no-daemon
```

The module compiles without `libmobile_core.so` present (it declares `external`
functions; no link-time reference to the Rust library is produced).
