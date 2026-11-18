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
//! | [`gc_provision_step`] | session id + step JSON | `{"ok":true,"step":"…","result":{…}}` |
//! | [`gc_ssh_channel_write`] | session id + channel id + `{"bytes":"<base64>"}` | `{"ok":true,"result":{"written":N}}` |
//! | [`gc_ssh_channel_read`] | session id + channel id + optional `{"timeoutMs":N}` | `{"ok":true,"result":{"bytes":"<base64>","eof":false}}` |
//! | [`gc_ssh_channel_close`] | session id + channel id | `{"ok":true,"result":{"closed":true}}` |
//! | [`gc_device_key_generate`] | – | `{"ok":true,"key":{"public_hex":"…","secret":{"secret_seed":[..]}}}` |
//! | [`gc_free`] | pointer from any `gc_*` | – |
//!
//! Failures always use the same envelope:
//! `{"ok":false,"error":{"kind":"<kind>","message":"<verbatim UI text>"}}`, where `kind` is
//! one of the frozen [`crate::error::CoreError`] kinds (`invalid_qr`, `ssh`,
//! `io`, `crypto`, `unsupported_version`) or one of this layer's two own kinds: `input`
//! (malformed ABI JSON or a null pointer) and `panic` (a caught panic).
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
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

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
pub const ABI_VERSION: u32 = 1;

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
/// `{"kind":"key","value":{"private":[..],"passphrase":null}}`).
///
/// Output: `{"ok":true,"sessionId":N,"result":{"sessionId":N,"fingerprint":"<64 hex>"}}`.
///
/// `result.fingerprint` is the SHA-256 of the host key the handshake actually saw, in
/// lowercase compact hex — exactly what `mobile/lib/provision.ts` normalizes and compares
/// with the QR's `fp` (TOFU, §1/§8). It is **omitted** when the transport reported no key,
/// so the app fails honestly instead of reading an invented value. The top-level
/// `sessionId` stays for the frozen v1 readers; new readers use the `result` record.
#[no_mangle]
pub extern "C" fn gc_ssh_connect(cfg_json: *const c_char) -> *mut c_char {
    json_call(|| {
        let config = read_str(cfg_json)?;
        let config: SshConnectConfig = serde_json::from_str(config).map_err(|error| {
            AbiError::input(format!("ssh connect config is not valid: {error}"))
        })?;
        let core = core_arc()?;
        let session_id =
            block_on(core.ssh_connect(config.host, config.port, config.user, config.credential))?
                .map_err(AbiError::from)?;
        let host_fingerprint = fingerprint::normalize(
            &core
                .session_fingerprint_compact(session_id)
                .map_err(AbiError::from)?,
        );
        let answer = match host_fingerprint {
            Some(host_fingerprint) => json!({
                "ok": true,
                "sessionId": session_id,
                "result": { "sessionId": session_id, "fingerprint": host_fingerprint },
            }),
            // No key was reported: the field is absent, never a placeholder value.
            None => json!({
                "ok": true,
                "sessionId": session_id,
                "result": { "sessionId": session_id },
            }),
        };
        Ok(answer)
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
/// The native shell writes `secret_seed` to the Keystore and never forwards it to JS.
#[no_mangle]
pub extern "C" fn gc_device_key_generate() -> *mut c_char {
    json_call(|| {
        let core = core_arc()?;
        let pair = core.device_key_generate();
        Ok(json!({ "ok": true, "key": pair }))
    })
}

/// `gc_free(ptr)`: release a string returned by any `gc_*` function.
///
/// Passing `null` is a no-op. Calling it twice on the same pointer is undefined behaviour,
/// exactly like `free`, so the Kotlin wrapper must null its handle after releasing.
///
/// # Safety
///
/// `ptr` must be either null or a pointer returned by one of the `gc_*` functions that has
/// not been freed yet. Any other value is undefined behaviour.
#[no_mangle]
pub extern "C" fn gc_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ptr` came from `CString::into_raw` inside `into_c_string` and owns a
    // CString allocation; reconstructing and dropping it frees that allocation exactly
    // once. The null check above keeps the empty-pointer call safe.
    drop(unsafe { CString::from_raw(ptr) });
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
    let options: ChannelReadOptions = serde_json::from_str(payload).map_err(|error| {
        AbiError::input(format!("channel read payload is not valid: {error}"))
    })?;
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
    let session_id = take_handle(object, "sessionId")?;
    let channel_id = take_handle(object, "channelId")?;
    Ok(ChannelCall {
        session_id,
        channel_id,
        payload: document.to_string(),
    })
}

/// Remove `key` from `object` and read it as a handle, or name what was wrong.
fn take_handle(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<u64, ChannelDocumentError> {
    let value = object.remove(key).ok_or_else(|| {
        ChannelDocumentError::new(format!("the channel document needs a numeric {key}"))
    })?;
    let handle = match &value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    };
    handle.ok_or_else(|| {
        ChannelDocumentError::new(format!(
            "the channel document needs a numeric {key}, not {value}"
        ))
    })
}

/// Standard alphabet of RFC 4648 base64, the encoding every byte payload uses here.
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard (padded) base64 of `bytes`.
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
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
pub fn take_answer_text(raw: *mut c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    // SAFETY: `raw` was produced by `CString::into_raw` inside this module and is valid
    // until it is released below, exactly the contract `gc_free` documents.
    let text = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    // Kotlin received a copy, so the C string is released now: keeping it for a later
    // `gc_free` would leak one allocation per call. A poisoned drop must not unwind across
    // the JVM boundary, hence the `catch_unwind`.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        drop(CString::from_raw(raw));
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
