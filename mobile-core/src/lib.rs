//! Gentle Movil Rust core.
//!
//! Thin, stable native core behind the phone app: QR pairing, ed25519 device identity,
//! release-signature verification and the SSH transport (session, direct-tcpip tunnel,
//! one-shot exec). It implements the **frozen v1 FFI surface** of
//! `docs/mobile-protocol-spec.md` §6; the stack that consumes it is frozen in
//! `docs/mobile-app-stack.md`.
//!
//! ## Module tree
//!
//! | module | responsibility |
//! |---|---|
//! | [`error`] | [`CoreError`] — the single error type, with stable [`kind`](CoreError::kind) strings |
//! | [`qr`] | `gc://pair?v=1` parsing and the [`PairInfo`] summary record (§1) |
//! | [`fingerprint`] | host key fingerprint encoding: compact hex and `aa:bb:…` display form |
//! | [`device_key`] | ed25519 device identity, signing and `cryptoVerify` (§2, §3.2) |
//! | [`ssh`] | russh transport behind mockable traits: connect, host key, tunnel, exec (§4) |
//! | [`provision`] | the daemon-provisioning steps of §2/§3/§5, one async fn per UI step |
//! | [`cabi`] | the C ABI layer a Kotlin/JNI wrapper loads from `libmobile_core.so` |
//! | [`ffi`] | [`MobileCore`]: the owned, generic-free, FFI-ready facade of the frozen surface |
//!
//! ## OTA rule (`docs/mobile-app-stack.md`, "Regla de oro de la OTA")
//!
//! This crate is deliberately thin and stable: `connect`, `read`, `write`, `exec`, `pair`,
//! device keys and signature verification. Every product rule (UI, daemon protocol
//! parsing, automations, modes) lives in TypeScript so EAS Update can ship it without a
//! store build.
//!
//! ## Offline testability
//!
//! No test needs a network or an SSH server. Parsing, fingerprints, device keys, error
//! mapping and the whole session/channel bookkeeping run against in-memory mocks of the
//! [`ssh::Transport`] traits; russh itself is only reached through [`ssh::RusshTransport`],
//! which the unit tests never dial.

#![deny(missing_docs)]
// Denied, not forbidden: [`cabi`] is the single module allowed to opt in to `unsafe`,
// because the C ABI boundary is the one place where pointer ownership has to be declared
// by hand. Every other module stays `unsafe`-free.
#![deny(unsafe_code)]

pub mod cabi;
pub mod device_key;
pub mod error;
pub mod ffi;
pub mod fingerprint;
#[cfg(all(target_os = "android", feature = "jni-shim"))]
pub mod jni_shim;
pub mod provision;
pub mod qr;
pub mod ssh;

pub use device_key::{DeviceKeyPair, StoredKey};
pub use error::CoreError;
pub use ffi::{ChannelId, CoreErrorPayload, MobileCore, SessionId};
pub use provision::{
    detect_host, register_device, rollback, start_daemon, upload_daemon, verify_manifest,
    verify_release_signature, HostInfo, Registration, ReleaseManifest, RollbackResult, StartResult,
    UploadResult, VerifyReport,
};
pub use qr::PairInfo;
pub use ssh::{Channel, ConnectRequest, ExecOutput, SshCredential, SshSession};
