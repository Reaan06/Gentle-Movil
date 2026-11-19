//! C ABI layer: the functions a Kotlin/JNI wrapper loads from `libmobile_core.so`.
//!
//! ## Why this module is allowed to use `unsafe`
//!
//! The crate denies `unsafe_code` everywhere else. Crossing a C ABI is the one boundary
//! where pointer ownership cannot be expressed in Rust types: input `*const c_char` is
//! borrowed for the call, output `*mut c_char` is **owned by the caller** and must be
//! released with [`gc_free`]. Every `unsafe` block below exists only to state that
//! contract, and no other module opts in.
//!
//! ## Shape
//!
//! Everything is JSON strings plus a version number, so the Kotlin side needs no
//! generated bindings and the surface can evolve behind [`ABI_VERSION`]:
//!
//! | function | input | output |
//! |---|---|---|
//! | [`gc_abi_version`] | – | `u32` ([`ABI_VERSION`]) |
//! | [`gc_pair_from_qr`] | URI | `{"ok":true,"pair":{...}}` |
//! | [`gc_ssh_connect`] | connect config JSON | `{"ok":true,"sessionId":N,"result":{"sessionId":N,"fingerprint":"…"}}` |
//! | [`gc_ssh_connect_seed`] | connect config + `seed` + `expectedFp` | same envelope as [`gc_ssh_connect`] |
//! | [`gc_ssh_close`] | session id | `{"ok":true,"result":{"closed":true}}` |
//! | [`gc_provision_step`] | session id + step JSON | `{"ok":true,"step":"…","result":{…}}` |
//! | [`gc_ssh_channel_write`] | session id + channel id + `{"bytes":"<base64>"}` | `{"ok":true,"result":{"written":N}}` |
//! | [`gc_ssh_channel_read`] | session id + channel id + optional `{"timeoutMs":N}` | `{"ok":true,"result":{"bytes":"<base64>","eof":false}}` |
//! | [`gc_ssh_channel_close`] | session id + channel id | `{"ok":true,"result":{"closed":true}}` |
//! | [`gc_device_key_generate`] | – | `{"ok":true,"key":{"public_hex":"…","secret":{"secret_seed":[..]}}}` |
//! | [`gc_device_key_public`] | `{"seed":[..32 bytes]}` | `{"ok":true,"result":{"publicHex":"…","fingerprint":"SHA256:…"}}` |
//! | [`gc_fs_list`] | `{"root":"…","path":"<rel>","maxEntries":N}` | `{"ok":true,"result":{"entries":[{path,size,kind}],"truncated":false}}` |
//! | [`gc_fs_read`] | `{"root":"…","path":"<rel>","maxBytes":N}` | `{"ok":true,"result":{"path","text","size","truncated"}}` |
//! | [`gc_free`] | pointer from any `gc_*` | – |
//!
//! Failures always use the same envelope:
//! `{"ok":false,"error":{"kind":"<kind>","message":"<verbatim UI text>"}}`, where `kind` is
//! one of the frozen [`crate::error::CoreError`] kinds (`invalid_qr`, `ssh`,
//! `io`, `crypto`, `unsupported_version`, `not_found`, `permission_denied`, `too_large`,
//! `binary`, `invalid_path`, `outside_root`) or one of this layer's two own kinds: `input`
//! (malformed ABI JSON or a null pointer) and `panic` (a caught panic).
//!
//! ## Secrets never travel back
//!
//! [`gc_device_key_generate`] is the **only** symbol whose answer carries the device seed,
//! and it exists so the native shell can seal it in the platform keystore; the TypeScript
//! facade rejects any answer that still carries it. [`gc_ssh_connect_seed`] takes a seed
//! and answers only the session id and the host fingerprint — the seed appears in no
//! answer, no error message and no log line produced here.
//!
//! ## The seal format the native shell must implement (SEC-011)
//!
//! The sealing code is Kotlin (`GcCoreModule` / `DeviceSeedStore`), so this crate cannot
//! enforce it; the contract below is what that code must do, and the Rust half keeps its
//! side of it (the seed reaches the shell once, and every Rust copy wipes itself):
//!
//! * **AES-256/GCM** with a key generated inside the AndroidKeyStore and marked
//!   non-exportable. The key never leaves the keystore, so the ciphertext in `filesDir` is
//!   useless on its own and `allowBackup` does not leak an identity.
//! * A **random 12-byte nonce per seal**, never reused with the same key; it is stored next
//!   to the ciphertext. Reusing a nonce with GCM is a total confidentiality and integrity
//!   break, not a minor defect.
//! * A **format/version byte** is the first byte of the sealed blob (`0x01` for this
//!   contract). A blob with an unknown version byte must be refused — never sealed over, and
//!   never decrypted on a best-effort guess — so a later format can be introduced without
//!   silently reading old bytes as if they were the new layout.
//! * **Associated data is mandatory and domain-separated**: GCM must be invoked with AAD
//!   `b"gentle-movil/device-seed/v1"` (the same string as the version byte, so a blob can
//!   never be decrypted as another kind of record even if a key is ever reused). Decrypting
//!   with empty AAD, or with AAD that was not passed at seal time, must fail — that failure
//!   is the test that this discipline is actually in place.
//! * The decrypted plaintext is exactly [`crate::device_key::SECRET_SEED_LEN`] bytes and is
//!   handed to a [`crate::device_key::StoredKey`], which wipes it on drop.
//!
//! ## Envelopes never promise a field they do not send (SEC-013)
//!
//! `ok: true` means the record under `result`/`key`/`pair` carries every field this module
//! documents. When a value cannot be produced — a handshake that reported no usable host
//! key, for instance — the answer is an error envelope, and any session opened on the way is
//! torn down instead of being handed out as a trusted handle.
//!
//! ## Panics never cross the boundary
//!
//! Every entry point runs its body inside [`std::panic::catch_unwind`]. Any panic becomes an
//! `{"ok":false,"error":{"kind":"panic","message":"…"}}` answer, so a Kotlin caller never
//! sees an unwinding stack across `extern "C"` (which would abort the process).
//!
//! ## Session and channel ids
//!
//! The registry is [`MobileCore`]'s own: [`gc_ssh_connect`] allocates the session id,
//! [`gc_provision_step`]'s `tunnel` step allocates the channel ids and
//! [`gc_ssh_channel_read`] / [`gc_ssh_channel_write`] / [`gc_ssh_channel_close`] address
//! exactly those ids in the same map, so ids handed out here are the same ids the frozen
//! `ffi` surface uses. Channels therefore survive across separate calls: nothing is
//! reopened per call.
//!
//! ## Byte payloads
//!
//! Bytes cross this boundary as standard (padded) RFC 4648 base64 inside the JSON envelope
//! (`{"bytes":"<base64>"}`), because the native shells and the TS runtime all decode it
//! natively.

// The C ABI boundary is the single place where `unsafe` is permitted (see the module docs).
#![allow(unsafe_code)]

use std::ffi::{c_char, CStr, CString};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroize;

use crate::device_key::StoredKey;
use crate::error::CoreError;
use crate::ffi::{ChannelId, CoreErrorPayload, MobileCore, SessionId};
use crate::fingerprint;
use crate::provision::{
    detect_host, register_device, rollback, run_step_command, start_daemon, upload_daemon,
    verify_manifest, OpenForward, ReleaseManifest, TunnelForward, TunnelResult,
};
use crate::ssh::Transport;
use crate::ssh::{SshCredential, DAEMON_PORT};

/// Version of this C ABI. Bump it whenever an existing function changes shape; Kotlin
/// compares it with [`gc_abi_version`] before it registers its handlers.
///
/// * **1** — pairing, connect, provisioning steps, tunnel channels, device key.
/// * **2** — the T16/T18 slice: [`gc_ssh_connect_seed`] (device-key reconnect that requires
///   a pinned host key), [`gc_ssh_close`] (session teardown), [`gc_device_key_public`]
///   (re-derive the public half of a keystore-sealed seed) and the device file surface
///   [`gc_fs_list`] / [`gc_fs_read`].
///
/// Existing functions keep their v1 shapes; `gc_ssh_connect` only gained an *optional*
/// `expectedFp`, which old documents omit and which then keeps the trust-on-first-use
/// behaviour of v1.
pub const ABI_VERSION: u32 = 2;

/// Kind reported for a malformed ABI input (bad JSON, missing field, null pointer).
const KIND_INPUT: &str = "input";
/// Kind reported for a panic caught at the boundary.
const KIND_PANIC: &str = "panic";
/// Kind reported when a JSON record cannot be encoded (should be unreachable).
const KIND_INTERNAL: &str = "internal";

/// Read window used by [`gc_ssh_channel_read`] when the app omits `timeoutMs`.
///
/// A bounded default keeps a stalled host from blocking a native thread forever (§7): the
/// app keeps the tunnel open and reads again, instead of waiting on a dead socket.
pub const DEFAULT_READ_TIMEOUT_MS: u64 = 30_000;

/// Process-wide facade, so every `gc_*` call shares one session registry.
static CORE: Mutex<Option<Arc<MobileCore>>> = Mutex::new(None);

/// Process-wide tokio runtime driving the async core from synchronous C calls.
static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();

/// An error already shaped for the ABI envelope.
struct AbiError {
    kind: String,
    message: String,
}

impl AbiError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
        }
    }

    fn input(message: impl Into<String>) -> Self {
        Self::new(KIND_INPUT, message)
    }
}

impl From<CoreErrorPayload> for AbiError {
    fn from(payload: CoreErrorPayload) -> Self {
        Self {
            kind: payload.kind,
            message: payload.message,
        }
    }
}

impl From<CoreError> for AbiError {
    fn from(error: CoreError) -> Self {
        Self::from(CoreErrorPayload::from(error))
    }
}

/// `gc_abi_version`: the version of the JSON envelopes this library speaks.
///
/// Kotlin must compare this with the version it was compiled against and refuse to run on
/// a mismatch instead of guessing field names.
#[no_mangle]
pub extern "C" fn gc_abi_version() -> u32 {
    ABI_VERSION
}

/// `gc_pair_from_qr(uri)`: parse a scanned `gc://pair?v=1` invitation (§1).
///
/// Output: `{"ok":true,"pair":PairInfo}` where `PairInfo` is the frozen record
/// (`version`, `host`, `port`, `user`, `token`, `fingerprint`, `daemon_protocol_minor`).
#[no_mangle]
pub extern "C" fn gc_pair_from_qr(uri: *const c_char) -> *mut c_char {
    json_call(|| {
        let uri = read_str(uri)?;
        let core = core_arc()?;
        let info = core.pair_from_qr(uri.to_string()).map_err(AbiError::from)?;
        Ok(json!({ "ok": true, "pair": info }))
    })
}

/// `gc_ssh_connect(cfg_json)`: open an authenticated SSH session.
///
/// Input (`SshConnectConfig`):
/// ```json
/// { "host": "192.168.1.42", "port": 22, "user": "reaan",
///   "credential": { "kind": "password", "value": "…" } }
/// ```
/// `port` defaults to 22; `credential` is the frozen `SshCredential`
/// (`{"kind":"password","value":"…"}` or
/// `{"kind":"key","value":{"private":[..],"passphrase":null}}`). `expectedFp` is
/// optional: with it the handshake only accepts that host key (the reconnect path), without
/// it the first pairing keeps the trust-on-first-use behaviour of ABI v1.
///
/// Output: `{"ok":true,"sessionId":N,"result":{"sessionId":N,"fingerprint":"<64 hex>"}}`.
///
/// `result.fingerprint` is the SHA-256 of the host key the handshake actually saw, in
/// lowercase compact hex — exactly what `mobile/lib/provision.ts` normalizes and compares
/// with the QR's `fp` (TOFU, §1/§8). It is **always** present: a handshake that reported no
/// usable host key used to answer `ok:true` with the field silently missing, which left the
/// app unable to confirm anything and holding a session nobody verified. That answer is now
/// an `ssh` error and the session is closed (SEC-013). The top-level
/// `sessionId` stays for the frozen v1 readers; new readers use the `result` record.
///
/// The whole handshake is bounded by [`crate::ffi::CONNECT_TIMEOUT`]: a host that accepts the
/// TCP connection and then says nothing answers an `ssh` error naming the target and the
/// window instead of holding the single native queue forever (SEC-010).
#[no_mangle]
pub extern "C" fn gc_ssh_connect(cfg_json: *const c_char) -> *mut c_char {
    json_call(|| {
        let config = read_str(cfg_json)?;
        let config: SshConnectConfig = serde_json::from_str(config).map_err(|error| {
            AbiError::input(format!("ssh connect config is not valid: {error}"))
        })?;
        let core = core_arc()?;
        let session_id = match config.expected_fingerprint {
            Some(expected_fingerprint) => block_on(core.ssh_connect_pinned(
                config.host,
                config.port,
                config.user,
                config.credential,
                expected_fingerprint,
            ))?,
            None => block_on(core.ssh_connect(
                config.host,
                config.port,
                config.user,
                config.credential,
            ))?,
        }
        .map_err(AbiError::from)?;
        session_answer(&core, session_id)
    })
}

/// `gc_ssh_connect_seed(cfg_json)`: reconnect with the **device key**, pinned to the host.
///
/// Input (`SshConnectSeedConfig`):
/// ```json
/// { "host": "192.168.1.42", "port": 22, "user": "reaan",
///   "seed": [..32 bytes..], "expectedFp": "<64 hex or aa:bb:…>" }
/// ```
///
/// The credential is built **inside** the core (`SshCredential::Key` from
/// `Ed25519Keypair::from_seed`), so no key text has to travel from JS. `expectedFp` is
/// **required**: a `{"kind":"key"}` connect without a pin must be refused instead of
/// silently trusting whatever host key answers, which is the defect this symbol closes.
/// A missing, blank or unparsable `expectedFp` is an `input` error; a pin that does not
/// match the handshake is an `ssh` error naming both fingerprints.
///
/// Output: the same envelope as [`gc_ssh_connect`]. The seed appears in no answer, no error
/// message and no log line.
#[no_mangle]
pub extern "C" fn gc_ssh_connect_seed(cfg_json: *const c_char) -> *mut c_char {
    json_call(|| {
        let config = read_str(cfg_json)?;
        let config: SshConnectSeedConfig = serde_json::from_str(config).map_err(|error| {
            AbiError::input(format!("ssh seed connect config is not valid: {error}"))
        })?;
        let expected_fingerprint = config.expected_fingerprint.trim().to_string();
        if expected_fingerprint.is_empty() {
            return Err(AbiError::input(
                "the seed connect needs expectedFp: a key-only connection must be pinned to the paired host key",
            ));
        }
        let seed = StoredKey {
            secret_seed: config.seed,
        };
        let core = core_arc()?;
        let session_id = block_on(core.ssh_connect_seed(
            config.host,
            config.port,
            config.user,
            seed,
            expected_fingerprint,
        ))?
        .map_err(AbiError::from)?;
        session_answer(&core, session_id)
    })
}

/// `gc_ssh_close(session_id)`: disconnect the session and free its id and channels.
///
/// Output: `{"ok":true,"result":{"closed":true}}` **only when the transport really let go**
/// (SEC-012): the disconnect is awaited and the transport is then asked whether it still
/// holds the connection. A transport that answers "still connected" gets the `ssh` error
/// envelope naming that fact, never a clean `closed: true` nobody achieved. The registry
/// entry is gone before the disconnect is awaited, so the id is stale afterwards and a second
/// close answers the `ssh` error envelope naming the unknown id — an honest typed error, not
/// a second "closed".
#[no_mangle]
pub extern "C" fn gc_ssh_close(session_id: u64) -> *mut c_char {
    let session_id = SessionId::from(session_id);
    json_call(|| {
        let core = core_arc()?;
        block_on(core.session_close(session_id))?.map_err(AbiError::from)?;
        Ok(json!({ "ok": true, "result": { "closed": true } }))
    })
}

/// The shared success envelope of the two connect symbols.
///
/// The `fingerprint` field is promised by the table above, so it must be there: if the
/// handshake reported no usable host key the session is closed and the call answers an
/// `ssh` error instead of an `ok: true` record with a missing field (SEC-013).
fn session_answer(core: &MobileCore, session_id: SessionId) -> Result<Value, AbiError> {
    let observed = core
        .session_fingerprint_compact(session_id)
        .map_err(AbiError::from)?;
    let Some(host_fingerprint) = fingerprint::normalize(&observed) else {
        // Nothing verified this host, so nothing may keep a handle to it.
        let _ = block_on(core.session_close(session_id));
        return Err(AbiError::from(CoreError::ssh(
            "the handshake reported no usable host key fingerprint, so the unverified session was closed instead of being handed out",
        )));
    };
    Ok(json!({
        "ok": true,
        "sessionId": session_id,
        "result": { "sessionId": session_id, "fingerprint": host_fingerprint },
    }))
}

/// `gc_device_key_public(payload_json)`: derive the public half of a stored seed.
///
/// Input: `{"seed":[..32 bytes..]}` — the seed the native module just decrypted from its
/// keystore-sealed file. Output:
/// `{"ok":true,"result":{"publicHex":"<64 hex>","fingerprint":"SHA256:…"}}`.
///
/// This is what makes `deviceKeyEnsure` idempotent: the module mints once, seals the seed,
/// and every later call re-derives the **same** public half instead of generating a second
/// identity. Neither the seed nor any part of it is echoed back.
#[no_mangle]
pub extern "C" fn gc_device_key_public(payload_json: *const c_char) -> *mut c_char {
    json_call(|| {
        let payload = read_str(payload_json)?;
        let payload: DeviceSeed = serde_json::from_str(payload).map_err(|error| {
            AbiError::input(format!("device seed payload is not valid: {error}"))
        })?;
        let seed = StoredKey {
            secret_seed: payload.seed,
        };
        let public_hex =
            crate::device_key::public_hex_from_secret(&seed).map_err(AbiError::from)?;
        let fingerprint = crate::device_key::fingerprint_sha256(&seed).map_err(AbiError::from)?;
        Ok(json!({
            "ok": true,
            "result": { "publicHex": public_hex, "fingerprint": fingerprint },
        }))
    })
}

/// `gc_fs_list(payload_json)`: one level of device files inside `root`.
///
/// Input: `{"root":"<absolute dir>","path":"<rel>","maxEntries":N}`. `path` defaults to
/// `""` (the root itself) and `maxEntries` to [`crate::fs::DEFAULT_MAX_ENTRIES`].
///
/// `root` is **caller-declared**, so it must be absolute: a blank root is an `input` error and
/// a relative one is `invalid_path`, because a relative root resolves against the process
/// working directory (`/` on Android) and `root: "etc"` would read `/etc` (SEC-003). The
/// Android allowlist of *which* absolute directories are acceptable lives in the native
/// shell, not here.
///
/// Output: `{"ok":true,"result":{"entries":[{"path","size","kind"}],"truncated":bool}}`
/// with paths **relative to `root`** (the absolute device path never leaks into the UI),
/// directories first and then by name. `size` is `null` for anything that is not a regular
/// file. The directory is read only until one entry past the window exists — the rest is
/// never materialised (SEC-006). Failures are the typed [`crate::fs`] errors: `not_found`,
/// `permission_denied`, `invalid_path`, `outside_root`, `io`.
#[no_mangle]
pub extern "C" fn gc_fs_list(payload_json: *const c_char) -> *mut c_char {
    json_call(|| {
        let payload = read_str(payload_json)?;
        let payload: FsListConfig = serde_json::from_str(payload)
            .map_err(|error| AbiError::input(format!("fs list payload is not valid: {error}")))?;
        if payload.root.trim().is_empty() {
            return Err(AbiError::input(
                "the fs list payload needs a non-empty root",
            ));
        }
        let max_entries = payload
            .max_entries
            .unwrap_or(crate::fs::DEFAULT_MAX_ENTRIES);
        let listing = crate::fs::list(Path::new(&payload.root), &payload.path, max_entries)
            .map_err(AbiError::from)?;
        Ok(json!({ "ok": true, "result": listing }))
    })
}

/// `gc_fs_read(payload_json)`: read a device file as UTF-8 text inside `root`.
///
/// Input: `{"root":"<absolute dir>","path":"<rel>","maxBytes":N}`. `maxBytes` defaults
/// to [`crate::fs::DEFAULT_MAX_BYTES`]. `root` follows the same rule as `gc_fs_list`: absolute
/// or `invalid_path` (SEC-003).
///
/// Output: `{"ok":true,"result":{"path","text","size","truncated"}}` where `size` is
/// the **real** file size and `truncated` says the text is only its first `maxBytes` bytes.
/// Binary content is `binary` (never lossy-decoded), a file past
/// [`crate::fs::HARD_MAX_BYTES`] is `too_large` with its real size, and anything that is not a
/// regular file (a directory, a FIFO, a socket, a device) is `io` naming its kind — a FIFO is
/// never opened, because opening one with no writer blocks the single native queue (SEC-005).
/// A file whose path was swapped after the containment check is refused through its opened
/// descriptor (SEC-007).
#[no_mangle]
pub extern "C" fn gc_fs_read(payload_json: *const c_char) -> *mut c_char {
    json_call(|| {
        let payload = read_str(payload_json)?;
        let payload: FsReadConfig = serde_json::from_str(payload)
            .map_err(|error| AbiError::input(format!("fs read payload is not valid: {error}")))?;
        if payload.root.trim().is_empty() {
            return Err(AbiError::input(
                "the fs read payload needs a non-empty root",
            ));
        }
        let max_bytes = payload.max_bytes.unwrap_or(crate::fs::DEFAULT_MAX_BYTES);
        let read = crate::fs::read_text(Path::new(&payload.root), &payload.path, max_bytes)
            .map_err(AbiError::from)?;
        Ok(json!({ "ok": true, "result": read }))
    })
}

/// `gc_provision_step(session_id, step_json)`: run exactly one onboarding-V3 step.
///
/// Dispatching by the `step` field keeps one C call per visible progress line:
///
/// | `step` | accepted fields | `result` record |
/// |---|---|---|
/// | `detect` | `command` (optional) | `CommandResult` (`exit_code`, `stdout`, `stderr`), or `HostInfo` (`os`, `arch`, `family`) without `command` |
/// | `upload` | `remotePath`, `dataHex` | `UploadResult` (`remote_path`, `bytes_written`) |
/// | `verify` | `releasePubkeyHex`, `dataHex`, `manifest` | `VerifyReport` (`sha256`, `verified`) |
/// | `start` | `remotePath`, `port` (default 43722) | `StartResult` (`pid`, `port`) |
/// | `register` | `command`/`script` (pivot), else `devicePubkeyHex`, `inviteToken`, `deviceName` | `CommandResult`, or `Registration` (`device_id`, `daemon_version`) |
/// | `rollback` | `remotePath` | `RollbackResult` (`remote_path`, `restored_from`) |
/// | `tunnel` | `forwards` (`[{host, port}]`) | `TunnelResult` (`forwards: [{host, port, channel_id}]`) |
///
/// `detect` with a `command` (the loopback probe of the pivot, S4/S5), `register` with a
/// `command` (or `script`: the idempotent `authorized_keys` install) run that script through
/// the `exec` primitive under `sh -c`; a non-zero exit is an `ssh` error naming the code and
/// output, so the flow never falls through to the next step. `tunnel` opens one
/// `direct-tcpip` channel per forward with the existing tunnel primitive and reports the
/// channel handle, which is how the app reaches the extension's loopback ports (the core
/// binds no local port). Every pre-pivot step keeps its exact behaviour.
///
/// `manifest` is the signed release manifest `{"sha256":"<64 hex>","signature":"<hex>"}`,
/// whose signature covers the `sha256` string (§3.2).
///
/// The three provisioning steps are bound to each other: `upload` records the digest of the
/// bytes it wrote for `remotePath`, `verify` marks the digest it actually accepted, and
/// `start` refuses a `remotePath` whose recorded digest was never verified — so verifying one
/// payload cannot authorize an uploaded one. A `start` on an unverified path answers
/// `{"ok":false,"error":{"kind":"ssh",…}}` and runs nothing on the host.
///
/// Output: `{"ok":true,"step":"detect","result":{…}}`.
#[no_mangle]
pub extern "C" fn gc_provision_step(session_id: u64, step_json: *const c_char) -> *mut c_char {
    let session_id = SessionId::from(session_id);
    json_call(|| {
        let step = read_str(step_json)?;
        let step: ProvisionStep = serde_json::from_str(step)
            .map_err(|error| AbiError::input(format!("provision step is not valid: {error}")))?;
        let core = core_arc()?;
        block_on(run_step(&core, session_id, step))?
    })
}

/// `gc_ssh_channel_write(session_id, channel_id, payload_json)`: send bytes on a tunnel
/// channel that the `tunnel` step opened.
///
/// Input: `{"bytes":"<base64>"}`, standard (padded) base64 of the payload. Output:
/// `{"ok":true,"result":{"written":N}}` with the number of bytes handed to the transport.
///
/// The channel is the one `gc_provision_step`'s `tunnel` step reported as `channel_id` and
/// it is held by the process-wide registry, so the bytes reach the very channel that step
/// opened — nothing is reopened here.
///
/// An empty payload, a payload that is not standard base64, an unknown session id and an
/// unknown channel id each answer the normal error envelope (`input` for the payload,
/// `ssh` for the handles); none of them panics (S7).
#[no_mangle]
pub extern "C" fn gc_ssh_channel_write(
    session_id: u64,
    channel_id: u64,
    payload_json: *const c_char,
) -> *mut c_char {
    let session_id = SessionId::from(session_id);
    let channel_id = ChannelId::from(channel_id);
    json_call(|| {
        let payload = read_str(payload_json)?;
        let payload: ChannelWrite = serde_json::from_str(payload).map_err(|error| {
            AbiError::input(format!("channel write payload is not valid: {error}"))
        })?;
        let bytes = base64_decode(&payload.bytes)?;
        if bytes.is_empty() {
            return Err(AbiError::input(
                "the channel write payload needs at least one byte",
            ));
        }
        let written = bytes.len();
        let core = core_arc()?;
        core.session(session_id).map_err(AbiError::from)?;
        block_on(core.channel_write(channel_id, bytes))?.map_err(AbiError::from)?;
        Ok(json!({ "ok": true, "result": { "written": written } }))
    })
}

/// `gc_ssh_channel_read(session_id, channel_id, payload_json)`: read from a tunnel channel.
///
/// Input: `{"timeoutMs":N}` (optional). A null pointer, `null` or an absent `timeoutMs`
/// uses [`DEFAULT_READ_TIMEOUT_MS`]; `timeoutMs: 0` is a non-blocking poll.
///
/// Output: `{"ok":true,"result":{"bytes":"<base64>","eof":false}}`. The three outcomes
/// are distinct:
///
/// | outcome | `bytes` | `eof` |
/// |---|---|---|
/// | data arrived | the bytes, base64 | `false` |
/// | nothing arrived inside `timeoutMs` | `""` | `false` (a timeout is **not** an error) |
/// | the host closed the channel | `""` | `true` |
///
/// The call never blocks past `timeoutMs`. Unknown session and channel ids answer the
/// `ssh` error envelope (S7).
#[no_mangle]
pub extern "C" fn gc_ssh_channel_read(
    session_id: u64,
    channel_id: u64,
    payload_json: *const c_char,
) -> *mut c_char {
    let session_id = SessionId::from(session_id);
    let channel_id = ChannelId::from(channel_id);
    json_call(|| {
        let timeout = read_channel_timeout(payload_json)?;
        let core = core_arc()?;
        core.session(session_id).map_err(AbiError::from)?;
        let read = block_on(core.channel_read_with_timeout(channel_id, timeout))?
            .map_err(AbiError::from)?;
        Ok(json!({
            "ok": true,
            "result": { "bytes": base64_encode(&read.bytes), "eof": read.eof },
        }))
    })
}

/// `gc_ssh_channel_close(session_id, channel_id)`: close a tunnel channel and free its id.
///
/// Output: `{"ok":true,"result":{"closed":true}}`. The id is stale afterwards, so a later
/// read, write or close on it answers the `ssh` error envelope naming the unknown id
/// instead of touching a dead channel.
#[no_mangle]
pub extern "C" fn gc_ssh_channel_close(session_id: u64, channel_id: u64) -> *mut c_char {
    let session_id = SessionId::from(session_id);
    let channel_id = ChannelId::from(channel_id);
    json_call(|| {
        let core = core_arc()?;
        core.session(session_id).map_err(AbiError::from)?;
        block_on(core.channel_close(channel_id))?.map_err(AbiError::from)?;
        Ok(json!({ "ok": true, "result": { "closed": true } }))
    })
}

/// `gc_device_key_generate()`: create the phone's ed25519 identity (§2.1).
///
/// Output: `{"ok":true,"key":{"public_hex":"<64 hex>","secret":{"secret_seed":[..32 bytes]}}}`.
///
/// The native shell seals `secret_seed` in the Keystore (see this module's seal-format
/// contract) and never forwards it to JS. This is the **one** place the seed is serialized:
/// [`StoredKey`] is neither `Serialize` nor `Clone`, so the bytes are read through
/// [`StoredKey::expose_seed`](crate::device_key::StoredKey::expose_seed) and the value wipes
/// itself as soon as this call returns.
#[no_mangle]
pub extern "C" fn gc_device_key_generate() -> *mut c_char {
    json_call(|| {
        let core = core_arc()?;
        let pair = core.device_key_generate();
        Ok(json!({
            "ok": true,
            "key": {
                "public_hex": pair.public_hex,
                "secret": { "secret_seed": pair.secret.expose_seed() },
            },
        }))
    })
}

/// `gc_free(ptr)`: release a string returned by any `gc_*` function.
///
/// Passing `null` is a no-op. Calling it twice on the same pointer is undefined behaviour,
/// exactly like `free`, so the Kotlin wrapper must null its handle after releasing.
///
/// The bytes are **zeroed before the allocation is released** (SEC-009): one of the answers
/// this frees is the device seed on its way to the keystore, and leaving it in a freed heap
/// block is exactly the kind of copy that survives a crash dump.
///
/// # Safety
///
/// `ptr` must be either null or a pointer returned by one of the `gc_*` functions that has
/// not been freed yet. Any other value is undefined behaviour.
#[no_mangle]
// The pointer contract is Kotlin's to keep; this frozen v1 export cannot spell Rust's unsafe.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub extern "C" fn gc_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ptr` came from `CString::into_raw` inside `into_c_string` and owns a
    // CString allocation; reconstructing it reclaims that allocation exactly once. The null
    // check above keeps the empty-pointer call safe.
    release_answer(unsafe { CString::from_raw(ptr) });
}

/// Zero an answer's bytes in place and release its allocation.
///
/// `into_bytes_with_nul` hands back the very buffer the `CString` owned, so the wipe lands on
/// the heap block that held the JSON (which may have carried the device seed) rather than on
/// a copy of it.
fn release_answer(answer: CString) {
    let mut bytes = answer.into_bytes_with_nul();
    bytes.zeroize();
}

/// Replace the process-wide facade with a caller-provided transport.
///
/// Test-only seam: the offline ABI tests need the mock transport the public core exposes,
/// while production always uses the russh one. Hidden from the docs on purpose.
#[doc(hidden)]
pub fn install_test_transport(transport: Arc<dyn Transport>) {
    let core = Arc::new(MobileCore::with_transport(transport));
    let mut slot = lock_core();
    *slot = Some(core);
}

/// The SSH connect config the ABI accepts.
#[derive(Debug, Deserialize)]
struct SshConnectConfig {
    /// Host IP address or hostname.
    host: String,
    /// SSH port; defaults to the protocol default of 22.
    #[serde(default = "default_ssh_port")]
    port: u16,
    /// SSH user.
    user: String,
    /// Credential, in the frozen tagged-JSON encoding.
    credential: SshCredential,
    /// Host key the handshake must present, for an already-paired connection.
    #[serde(default, rename = "expectedFp")]
    expected_fingerprint: Option<String>,
}

/// The device-key connect config [`gc_ssh_connect_seed`] accepts.
///
/// No `Debug` derive on purpose: this record holds the device seed, and a struct that can
/// be printed is a struct that eventually ends up in a log line (S7).
#[derive(Deserialize)]
struct SshConnectSeedConfig {
    /// Host IP address or hostname.
    host: String,
    /// SSH port; defaults to the protocol default of 22.
    #[serde(default = "default_ssh_port")]
    port: u16,
    /// SSH user.
    user: String,
    /// The 32-byte ed25519 seed the native module decrypted from the keystore.
    seed: Vec<u8>,
    /// Host key the handshake must present (required for a key-only connect).
    #[serde(default, rename = "expectedFp")]
    expected_fingerprint: String,
}

/// The seed payload [`gc_device_key_public`] accepts.
#[derive(Deserialize)]
struct DeviceSeed {
    /// The 32-byte ed25519 seed.
    seed: Vec<u8>,
}

/// The payload [`gc_fs_list`] accepts.
#[derive(Debug, Deserialize)]
struct FsListConfig {
    /// Absolute directory the caller allows (the app's private directory, a picked folder).
    root: String,
    /// Path relative to `root`; defaults to the root itself.
    #[serde(default)]
    path: String,
    /// Entry window; defaults to [`crate::fs::DEFAULT_MAX_ENTRIES`].
    #[serde(default, rename = "maxEntries")]
    max_entries: Option<usize>,
}

/// The payload [`gc_fs_read`] accepts.
#[derive(Debug, Deserialize)]
struct FsReadConfig {
    /// Absolute directory the caller allows.
    root: String,
    /// Path relative to `root`; the root itself is a directory, so it cannot be read.
    #[serde(default)]
    path: String,
    /// Byte window; defaults to [`crate::fs::DEFAULT_MAX_BYTES`].
    #[serde(default, rename = "maxBytes")]
    max_bytes: Option<u64>,
}

/// The SSH port used when the config omits it.
fn default_ssh_port() -> u16 {
    crate::qr::DEFAULT_PORT
}

/// The write payload [`gc_ssh_channel_write`] accepts.
#[derive(Debug, Deserialize)]
struct ChannelWrite {
    /// Payload bytes as standard (padded) base64.
    bytes: String,
}

/// The read payload [`gc_ssh_channel_read`] accepts.
#[derive(Debug, Deserialize)]
struct ChannelReadOptions {
    /// How long the read may wait, in milliseconds; absent uses [`DEFAULT_READ_TIMEOUT_MS`].
    #[serde(default, rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

/// Decode the optional read payload into the window a read may wait.
///
/// A null pointer, an empty document and an absent `timeoutMs` all mean "the default
/// window", so a caller that has nothing to say about timing still gets a bounded read.
fn read_channel_timeout(payload_json: *const c_char) -> Result<Duration, AbiError> {
    let default = Duration::from_millis(DEFAULT_READ_TIMEOUT_MS);
    if payload_json.is_null() {
        return Ok(default);
    }
    let payload = read_str(payload_json)?;
    if payload.trim().is_empty() {
        return Ok(default);
    }
    let options: ChannelReadOptions = serde_json::from_str(payload)
        .map_err(|error| AbiError::input(format!("channel read payload is not valid: {error}")))?;
    Ok(Duration::from_millis(
        options.timeout_ms.unwrap_or(DEFAULT_READ_TIMEOUT_MS),
    ))
}

/// One Kotlin channel document, split into the arguments the channel ABI calls want.
///
/// Kotlin speaks one JSON document per call (`GcCoreModule` passes strings only), while
/// [`gc_ssh_channel_write`] / [`gc_ssh_channel_read`] / [`gc_ssh_channel_close`] take the
/// two handles as separate `u64` arguments. This is the single place that knows the
/// document's shape, so the JNI shim splits nothing itself and a malformed document is
/// reported once, in one wording.
///
/// Hidden from the docs on purpose: it is the JNI layer's marshalling seam, not part of
/// the frozen C ABI surface the Kotlin module links against.
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelCall {
    /// Session handle `gc_ssh_connect` returned to the app.
    pub session_id: u64,
    /// Channel handle the `tunnel` step reported as `channel_id`.
    pub channel_id: u64,
    /// The rest of the document (the channel-specific payload), re-encoded as JSON.
    pub payload: String,
}

/// Why a channel document could not be split into the handles the ABI needs.
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelDocumentError {
    /// Verbatim text the `input` envelope carries.
    pub message: String,
}

impl ChannelDocumentError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Split `{"sessionId":N,"channelId":M,…payload}` into the channel ABI's arguments.
///
/// The payload keeps every other field, so `bytes` (write) and `timeoutMs` (read) reach
/// the ABI exactly as the app wrote them; a read document without `timeoutMs` therefore
/// forwards `{}` and keeps the ABI's bounded default window, while `timeoutMs: 0` stays
/// the non-blocking poll.
///
/// Handles must be non-negative integers — a JSON number, or a non-blank numeric string
/// from a bridge that stringifies ids. Anything else is refused by name instead of
/// silently becoming session 0, which would address the wrong channel.
#[doc(hidden)]
pub fn split_channel_document(input: &str) -> Result<ChannelCall, ChannelDocumentError> {
    let mut document: Value = serde_json::from_str(input).map_err(|error| {
        ChannelDocumentError::new(format!("the channel document is not valid JSON: {error}"))
    })?;
    let Value::Object(object) = &mut document else {
        return Err(ChannelDocumentError::new(
            "the channel document must be a JSON object",
        ));
    };
    let session_id = take_handle(object, "sessionId", "channel")?;
    let channel_id = take_handle(object, "channelId", "channel")?;
    Ok(ChannelCall {
        session_id,
        channel_id,
        payload: document.to_string(),
    })
}

/// Split `{"sessionId":N,…}` into the session handle [`gc_ssh_close`] takes.
///
/// [`split_channel_document`] needs both handles; a teardown document carries only the
/// session, so it gets its own splitter next to the payload it feeds.
#[doc(hidden)]
pub fn split_session_document(input: &str) -> Result<u64, ChannelDocumentError> {
    let document: Value = serde_json::from_str(input).map_err(|error| {
        ChannelDocumentError::new(format!("the session document is not valid JSON: {error}"))
    })?;
    let Value::Object(mut object) = document else {
        return Err(ChannelDocumentError::new(
            "the session document must be a JSON object",
        ));
    };
    take_handle(&mut object, "sessionId", "session")
}

/// Remove `key` from `object` and read it as a handle, or name what was wrong.
///
/// `document` is the noun the error uses (`"channel"` or `"session"`), so a caller reads
/// which of the two document shapes it sent wrong instead of a generic complaint.
fn take_handle(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    document: &str,
) -> Result<u64, ChannelDocumentError> {
    let value = object.remove(key).ok_or_else(|| {
        ChannelDocumentError::new(format!("the {document} document needs a numeric {key}"))
    })?;
    let handle = match &value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    };
    handle.ok_or_else(|| {
        ChannelDocumentError::new(format!(
            "the {document} document needs a numeric {key}, not {value}"
        ))
    })
}

/// Standard alphabet of RFC 4648 base64, the encoding every byte payload uses here.
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard (padded) base64 of `bytes`.
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = u32::from(chunk.get(1).copied().unwrap_or(0));
        let third = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (first << 16) | (second << 8) | third;
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// Decode standard (padded) base64, reporting malformed input as an `input` error.
///
/// Strict on purpose: whitespace, unpadded groups, padding outside the last group and any
/// character outside the alphabet are refused, so the app learns its payload was wrong
/// instead of the core guessing what it meant.
fn base64_decode(text: &str) -> Result<Vec<u8>, AbiError> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(AbiError::input(
            "the bytes payload is not standard base64: its length is not a multiple of 4",
        ));
    }
    let groups = bytes.len() / 4;
    let mut out = Vec::with_capacity(groups * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index + 1 == groups;
        let mut triple = 0u32;
        let mut padding = 0usize;
        for (position, byte) in chunk.iter().enumerate() {
            let value = if *byte == b'=' {
                // Padding belongs to the last group only, in its last two positions.
                if !last || position < 2 {
                    return Err(AbiError::input(
                        "the bytes payload is not standard base64: unexpected padding",
                    ));
                }
                padding += 1;
                0
            } else {
                base64_value(*byte).ok_or_else(|| {
                    AbiError::input(
                        "the bytes payload is not standard base64: it contains a character outside the alphabet",
                    )
                })?
            };
            triple = (triple << 6) | u32::from(value);
        }
        out.push((triple >> 16) as u8);
        if padding < 2 {
            out.push((triple >> 8) as u8);
        }
        if padding < 1 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

/// Value of one base64 character, or `None` when it is outside the alphabet.
fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// One provisioning step as it arrives over the ABI.
#[derive(Debug, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
enum ProvisionStep {
    /// `uname -s -m` detection (§3.1); with `command`, the pivot's loopback probe (S4).
    Detect {
        /// Shell script the TS flow composed; absent for the legacy host detection.
        #[serde(default)]
        command: Option<String>,
    },
    /// SFTP upload plus `chmod +x` (§3.2, §3.3).
    Upload {
        /// Remote path of the daemon binary.
        #[serde(rename = "remotePath")]
        remote_path: String,
        /// Binary bytes as lowercase/uppercase hex.
        #[serde(rename = "dataHex")]
        data_hex: String,
    },
    /// Checksum plus release-signature verification (§3.2).
    Verify {
        /// Ed25519 release public key embedded in the app, as hex.
        #[serde(rename = "releasePubkeyHex")]
        release_pubkey_hex: String,
        /// Binary bytes as hex.
        #[serde(rename = "dataHex")]
        data_hex: String,
        /// Signed manifest of those bytes.
        manifest: ReleaseManifest,
    },
    /// Detached start plus port readiness (§3.4).
    Start {
        /// Remote path of the daemon binary.
        #[serde(rename = "remotePath")]
        remote_path: String,
        /// Daemon listener port; defaults to 43722.
        #[serde(default = "default_daemon_port")]
        port: u16,
    },
    /// Device registration through the tunnel (§2), or the pivot's `authorized_keys`
    /// install when the step carries `command`/`script` instead (S4).
    Register {
        /// Device ed25519 public key, as hex.
        #[serde(default, rename = "devicePubkeyHex")]
        device_pubkey_hex: Option<String>,
        /// Single-use invite token from the QR.
        #[serde(default, rename = "inviteToken")]
        invite_token: Option<String>,
        /// Name the host shows for this phone.
        #[serde(default, rename = "deviceName")]
        device_name: Option<String>,
        /// Shell script to run instead of the daemon claim (`script` is an accepted alias).
        #[serde(default, alias = "script")]
        command: Option<String>,
    },
    /// Restore `<remotePath>.prev` after a failed start (§5).
    Rollback {
        /// Remote path of the daemon binary.
        #[serde(rename = "remotePath")]
        remote_path: String,
    },
    /// Open the app's forwards to the extension's loopback ports (§4, S4).
    Tunnel {
        /// Forwards to open, in order.
        forwards: Vec<TunnelForward>,
    },
}

/// The daemon listener port used when a `start` step omits it.
fn default_daemon_port() -> u16 {
    DAEMON_PORT
}

/// Run one parsed step against the session registry.
async fn run_step(
    core: &MobileCore,
    session_id: SessionId,
    step: ProvisionStep,
) -> Result<Value, AbiError> {
    let session = core.session(session_id).map_err(AbiError::from)?;
    match step {
        ProvisionStep::Detect { command } => match command {
            // Pivot (S4): the app composes the loopback probe, the core runs it.
            Some(command) => {
                let result = run_step_command(&session, "detect", &command)
                    .await
                    .map_err(AbiError::from)?;
                step_result("detect", &result)
            }
            None => {
                let info = detect_host(&session).await.map_err(AbiError::from)?;
                step_result("detect", &info)
            }
        },
        ProvisionStep::Upload {
            remote_path,
            data_hex,
        } => {
            let bytes = fingerprint::decode_hex(&data_hex)?;
            let result = upload_daemon(&session, &bytes, &remote_path)
                .await
                .map_err(AbiError::from)?;
            step_result("upload", &result)
        }
        ProvisionStep::Verify {
            release_pubkey_hex,
            data_hex,
            manifest,
        } => {
            let bytes = fingerprint::decode_hex(&data_hex)?;
            let report =
                verify_manifest(&release_pubkey_hex, &bytes, &manifest).map_err(AbiError::from)?;
            step_result("verify", &report)
        }
        ProvisionStep::Start { remote_path, port } => {
            let result = start_daemon(&session, &remote_path, port)
                .await
                .map_err(AbiError::from)?;
            step_result("start", &result)
        }
        ProvisionStep::Register {
            device_pubkey_hex,
            invite_token,
            device_name,
            command,
        } => {
            // Pivot (S4): the app composed the `authorized_keys` install, so run it.
            if let Some(command) = command.filter(|command| !command.trim().is_empty()) {
                let result = run_step_command(&session, "register", &command)
                    .await
                    .map_err(AbiError::from)?;
                return step_result("register", &result);
            }
            let (Some(device_pubkey_hex), Some(invite_token), Some(device_name)) =
                (device_pubkey_hex, invite_token, device_name)
            else {
                return Err(AbiError::input(
                    "the register step needs a command (or script) to run, or devicePubkeyHex, inviteToken and deviceName for the daemon claim",
                ));
            };
            let result = register_device(&session, &device_pubkey_hex, &invite_token, &device_name)
                .await
                .map_err(AbiError::from)?;
            step_result("register", &result)
        }
        ProvisionStep::Rollback { remote_path } => {
            let result = rollback(&session, &remote_path)
                .await
                .map_err(AbiError::from)?;
            step_result("rollback", &result)
        }
        ProvisionStep::Tunnel { forwards } => {
            if forwards.is_empty() {
                return Err(AbiError::input(
                    "the tunnel step needs at least one forward ({host, port})",
                ));
            }
            let mut opened = Vec::with_capacity(forwards.len());
            for forward in forwards {
                forward.validate().map_err(AbiError::from)?;
                // Existing tunnel primitive (and its channel registry), one channel per
                // forward: the app reads and writes each through its channel id.
                let host = forward.host.trim().to_string();
                let channel_id = core
                    .ssh_direct_tcp(session_id, host.clone(), forward.port)
                    .await
                    .map_err(AbiError::from)?;
                opened.push(OpenForward {
                    host,
                    port: forward.port,
                    channel_id,
                });
            }
            step_result("tunnel", &TunnelResult { forwards: opened })
        }
    }
}

/// Wrap a step record in the uniform success envelope.
fn step_result<T: serde::Serialize>(step: &str, result: &T) -> Result<Value, AbiError> {
    let result = serde_json::to_value(result).map_err(|error| {
        AbiError::new(
            KIND_INTERNAL,
            format!("cannot encode {step} result: {error}"),
        )
    })?;
    Ok(json!({ "ok": true, "step": step, "result": result }))
}

/// Run a boundary body, turning its value, error or panic into an owned JSON `CString`.
fn json_call(body: impl FnOnce() -> Result<Value, AbiError>) -> *mut c_char {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    let value = match outcome {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => json!({
            "ok": false,
            "error": { "kind": error.kind, "message": error.message }
        }),
        Err(panic) => json!({
            "ok": false,
            "error": { "kind": KIND_PANIC, "message": panic_message(panic) }
        }),
    };
    into_c_string(value.to_string())
}

/// Best-effort text of a caught panic payload.
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return format!("the core panicked: {message}");
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return format!("the core panicked: {message}");
    }
    "the core panicked without a message".to_string()
}

/// Move a JSON document into a heap `CString` the caller owns until [`gc_free`].
fn into_c_string(text: String) -> *mut c_char {
    // JSON never contains a NUL byte: every string in it is produced from Rust data, and
    // the only C input strings are NUL-free by construction. The fallback keeps the
    // function total anyway.
    let cstring = CString::new(text).unwrap_or_else(|_| {
        CString::new(format!(
            "{{\"ok\":false,\"error\":{{\"kind\":\"{KIND_INTERNAL}\",\"message\":\"result contained a NUL byte\"}}}}"
        ))
        .expect("literal is NUL-free")
    });
    cstring.into_raw()
}

// ===========================================================================
// JNI marshalling seam
// ===========================================================================
//
// [`crate::jni_shim`] is Android-only (`cfg(all(target_os = "android", feature =
// "jni-shim"))`), so none of it can run in the offline suite — yet the defect it has to
// avoid lives exactly there: `JNIEnv::new_string` fails while a Java exception is pending,
// the shim answered `null`, and `GcCoreModule` turned that into `EmptyResponse` ("el núcleo
// no devolvió nada para «gc_ssh_connect»"), throwing away an answer the core had produced.
//
// Every decision that does not need a `JNIEnv` is therefore made here, under the offline
// tests: which text to marshal, what to answer when the core returns no pointer, and which
// envelope to retry with when the JVM refuses that text (S7: honest state, never a null).
// The shim keeps only the two JNI calls and the exception bookkeeping around them.

/// What the shim saw when the JVM refused to create a string for the answer.
///
/// The shim fills it from the JNI call itself; everything that shapes the fallback envelope
/// from it is host-compiled and tested, so the wording cannot regress on the device.
#[doc(hidden)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarshalFailure {
    /// A Java exception was already pending when the shim tried to marshal, and the shim
    /// cleared it first: leaving it pending is exactly what made every later answer null.
    pub pending_exception_cleared: bool,
    /// The JVM's own description of the refusal; empty when the shim has none.
    pub reason: String,
}

/// The JVM refused to create a string for the core's answer.
const MARSHALL_REFUSED: &str = "the JVM could not create a string for the core's answer";
/// A stale exception was found pending before marshalling and cleared.
const PENDING_EXCEPTION_CLEARED: &str =
    "a pending JVM exception from an earlier JNI call was cleared first";
/// The C ABI answered a null pointer, which it never does.
const MISSING_ANSWER: &str = "the native core returned no answer";

/// One `{"ok":false,"error":{…}}` document, always NUL-free because `serde_json` escapes
/// control characters (`\u0000`) instead of emitting them.
fn envelope(kind: &str, message: &str) -> String {
    json!({ "ok": false, "error": { "kind": kind, "message": message } }).to_string()
}

/// Envelope the shim answers when the C ABI returned no pointer at all.
///
/// Unreachable through [`json_call`] (which always allocates a `CString`), so it is a
/// tripwire: even that branch answers a real error document instead of `null`.
#[doc(hidden)]
pub fn missing_answer_envelope() -> String {
    envelope(KIND_INTERNAL, MISSING_ANSWER)
}

/// Envelope the shim answers when the JVM refuses to create a string for the answer.
///
/// It names the failure itself, plus — when the shim had to clear one first — the stale
/// exception that used to make the whole answer disappear, plus the JVM's own reason.
#[doc(hidden)]
pub fn answer_refused_envelope(failure: &MarshalFailure) -> String {
    let mut message = String::from(MARSHALL_REFUSED);
    if failure.pending_exception_cleared {
        message.push_str("; ");
        message.push_str(PENDING_EXCEPTION_CLEARED);
    }
    if !failure.reason.is_empty() {
        message.push_str(": ");
        message.push_str(&failure.reason);
    }
    envelope(KIND_INTERNAL, &message)
}

/// Envelope the shim answers when the Kotlin argument itself could not be read.
///
/// `GetStringUTFChars` failure is an *input* problem of this call (a null or foreign
/// `jstring`, or a throwable it raised), so it is reported with the ABI's `input` kind and
/// the cause in the message — never as a misleading "the JSON is empty" parse error.
#[doc(hidden)]
pub fn refused_input_envelope(reason: &str) -> String {
    envelope(
        KIND_INPUT,
        &format!("the JVM could not read the call's argument: {reason}"),
    )
}

/// Text the shim marshals first for one `gc_*` answer.
///
/// `Some(text)` is the C ABI's own answer, forwarded unchanged; `None` means the ABI handed
/// back a null pointer and the shim answers [`missing_answer_envelope`].
#[doc(hidden)]
pub fn primary_answer_text(answer: Option<&str>) -> String {
    match answer {
        Some(text) => text.to_string(),
        None => missing_answer_envelope(),
    }
}

/// Read the answer string a `gc_*` call returned and release it, NUL-terminated as the ABI
/// promises. `None` for a null pointer.
///
/// Freeing here (and not in Kotlin) keeps the ownership rule the shim already relies on:
/// Kotlin receives a *copy* as a `jstring`, so it must never call `gc_free`.
#[doc(hidden)]
// Consumes the pointer a gc_* export just produced; the contract is gc_free's, not a Rust API.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn take_answer_text(raw: *mut c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    // SAFETY: `raw` was produced by `CString::into_raw` inside this module and is valid
    // until it is released below, exactly the contract `gc_free` documents.
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    // Kotlin received a copy, so the C string is released now: keeping it for a later
    // `gc_free` would leak one allocation per call. A poisoned drop must not unwind across
    // the JVM boundary, hence the `catch_unwind`. The bytes are zeroed first (SEC-009): the
    // copy that reaches the JVM is the JVM's to wipe, but this allocation is ours.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        release_answer(CString::from_raw(raw));
    }));
    Some(text)
}

/// Borrow one NUL-terminated input string for the duration of the call.
fn read_str<'a>(ptr: *const c_char) -> Result<&'a str, AbiError> {
    if ptr.is_null() {
        return Err(AbiError::input("the argument pointer is null"));
    }
    // SAFETY: the caller guarantees a valid NUL-terminated string for the duration of the
    // call (CString or a JNI-owned buffer); we only borrow it and never free it.
    let c_str = unsafe { CStr::from_ptr(ptr) };
    c_str
        .to_str()
        .map_err(|error| AbiError::input(format!("the argument is not valid UTF-8: {error}")))
}

/// Lock the facade slot, recovering from a poisoned mutex instead of panicking.
fn lock_core() -> std::sync::MutexGuard<'static, Option<Arc<MobileCore>>> {
    match CORE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The shared facade, created on first use with the real russh transport.
fn core_arc() -> Result<Arc<MobileCore>, AbiError> {
    let mut slot = lock_core();
    if let Some(core) = slot.as_ref() {
        return Ok(Arc::clone(core));
    }
    let core = Arc::new(MobileCore::new());
    *slot = Some(Arc::clone(&core));
    Ok(core)
}

/// The process-wide runtime, or the reason it could not be created.
fn runtime() -> Result<&'static tokio::runtime::Runtime, AbiError> {
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("mobile-core-abi")
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| {
            AbiError::new(
                KIND_INTERNAL,
                format!("cannot start the core runtime: {error}"),
            )
        })
}

/// Drive one future to completion on the shared runtime.
fn block_on<F: Future>(future: F) -> Result<F::Output, AbiError> {
    Ok(runtime()?.block_on(future))
}
