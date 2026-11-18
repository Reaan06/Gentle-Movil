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
├── android/build.gradle             # expo-module-gradle-plugin, namespace
├── android/src/main/java/com/gentlemovil/core/
│   ├── GcNative.kt                  # System.loadLibrary + extern "C" declarations
│   └── GcCoreModule.kt              # Expo module: dispatch + envelopes
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

| Facade call                 | C symbol                | Payload the app sends                                                   |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `callGc('gc_abi_version')`  | `gc_abi_version()`      | none (`{}`)                                                             |
| `callGc('gc_pair_from_qr')` | `gc_pair_from_qr(json)` | `{"uri":"gc://pair?…"}`                                                |
| `callGc('gc_ssh_connect')`  | `gc_ssh_connect(json)`  | `{"pair":{…},"credential":{…}}` (`credential` is `null` on the QR path)  |
| `callGc('gc_provision_step')` | `gc_provision_step(json)` | `{"step":"fingerprint-confirm"…"rollback","pair":{…},"credential":{…},"attempt":1,"sessionId":"…"}` |
| `callGc('gc_device_key_generate')` | `gc_device_key_generate(json)` | `{}` |

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
| `GcNative.gcProvisionStep(String)` | `Java_com_gentlemovil_core_GcNative_gcProvisionStep`         |
| `GcNative.gcDeviceKeyGenerate(String)` | `Java_com_gentlemovil_core_GcNative_gcDeviceKeyGenerate` |
| `GcNative.gcFree(long)`         | `Java_com_gentlemovil_core_GcNative_gcFree`                      |

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
