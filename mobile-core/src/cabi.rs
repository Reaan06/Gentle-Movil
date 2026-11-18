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
//! | [`gc_ssh_connect`] | connect config JSON | `{"ok":true,"sessionId":N}` |
//! | [`gc_provision_step`] | session id + step JSON | `{"ok":true,"step":"…","result":{…}}` |
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
//! ## Session ids
//!
//! The registry is [`MobileCore`]'s own: [`gc_ssh_connect`] allocates the id and
//! [`gc_provision_step`] looks it up in the same map, so ids handed out here are the same
//! ids the frozen `ffi` surface uses.

// The C ABI boundary is the single place where `unsafe` is permitted (see the module docs).
#![allow(unsafe_code)]

use std::ffi::{c_char, CStr, CString};
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::CoreError;
use crate::ffi::{CoreErrorPayload, MobileCore, SessionId};
use crate::fingerprint;
use crate::provision::{
    detect_host, register_device, rollback, start_daemon, upload_daemon, verify_manifest,
    ReleaseManifest,
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
/// Output: `{"ok":true,"sessionId":N}`.
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
        Ok(json!({ "ok": true, "sessionId": session_id }))
    })
}

/// `gc_provision_step(session_id, step_json)`: run exactly one onboarding-V3 step.
///
/// Dispatching by the `step` field keeps one C call per visible progress line:
///
/// | `step` | accepted fields | `result` record |
/// |---|---|---|
/// | `detect` | – | `HostInfo` (`os`, `arch`, `family`) |
/// | `upload` | `remotePath`, `dataHex` | `UploadResult` (`remote_path`, `bytes_written`) |
/// | `verify` | `releasePubkeyHex`, `dataHex`, `manifest` | `VerifyReport` (`sha256`, `verified`) |
/// | `start` | `remotePath`, `port` (default 43722) | `StartResult` (`pid`, `port`) |
/// | `register` | `devicePubkeyHex`, `inviteToken`, `deviceName` | `Registration` (`device_id`, `daemon_version`) |
/// | `rollback` | `remotePath` | `RollbackResult` (`remote_path`, `restored_from`) |
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

/// One provisioning step as it arrives over the ABI.
#[derive(Debug, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
enum ProvisionStep {
    /// `uname -s -m` detection (§3.1).
    Detect,
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
    /// Device registration through the tunnel (§2).
    Register {
        /// Device ed25519 public key, as hex.
        #[serde(rename = "devicePubkeyHex")]
        device_pubkey_hex: String,
        /// Single-use invite token from the QR.
        #[serde(rename = "inviteToken")]
        invite_token: String,
        /// Name the host shows for this phone.
        #[serde(rename = "deviceName")]
        device_name: String,
    },
    /// Restore `<remotePath>.prev` after a failed start (§5).
    Rollback {
        /// Remote path of the daemon binary.
        #[serde(rename = "remotePath")]
        remote_path: String,
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
        ProvisionStep::Detect => {
            let info = detect_host(&session).await.map_err(AbiError::from)?;
            step_result("detect", &info)
        }
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
        } => {
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
