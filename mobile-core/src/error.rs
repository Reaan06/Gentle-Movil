//! Error type of the core.
//!
//! Every fallible entry point of this crate returns [`CoreError`]. The variants are
//! the ones frozen by `docs/mobile-protocol-spec.md` §6, and each one maps to a
//! stable [`kind`](CoreError::kind) string so the TypeScript layer can branch on the
//! kind instead of parsing messages.
//!
//! This is the only error type in the library: internal helpers use the
//! `CoreError::invalid_qr` / `CoreError::ssh` / `CoreError::crypto` constructors so
//! the message shape stays consistent, and the FFI facade converts the value into a
//! plain [`crate::ffi::CoreErrorPayload`] record.

use thiserror::Error;

/// `InvalidQr` kind: the scanned URI is not a usable `gc://pair?v=1` invitation.
pub const KIND_INVALID_QR: &str = "invalid_qr";
/// `Ssh` kind: transport, authentication or channel failure.
pub const KIND_SSH: &str = "ssh";
/// `Io` kind: local operating-system failure.
pub const KIND_IO: &str = "io";
/// `Crypto` kind: key material or signature failure.
pub const KIND_CRYPTO: &str = "crypto";
/// `UnsupportedVersion` kind: the QR declares a major version this build cannot route.
pub const KIND_UNSUPPORTED_VERSION: &str = "unsupported_version";
/// `NotFound` kind: the requested file or directory does not exist.
pub const KIND_NOT_FOUND: &str = "not_found";
/// `PermissionDenied` kind: the operating system refused access to the path.
pub const KIND_PERMISSION_DENIED: &str = "permission_denied";
/// `TooLarge` kind: the file exceeds the byte cap the caller allowed.
pub const KIND_TOO_LARGE: &str = "too_large";
/// `Binary` kind: the file is not UTF-8 text, so it cannot be shown in an editor.
pub const KIND_BINARY: &str = "binary";
/// `InvalidPath` kind: the relative path is absolute, empty, or walks upwards.
pub const KIND_INVALID_PATH: &str = "invalid_path";
/// `OutsideRoot` kind: the resolved path leaves the root the caller allowed.
pub const KIND_OUTSIDE_ROOT: &str = "outside_root";

/// Error returned by every fallible operation of the core.
#[derive(Debug, Error)]
pub enum CoreError {
    /// The pairing URI is malformed or fails the §1 validation rules.
    #[error("invalid pairing QR: {reason}")]
    InvalidQr {
        /// Human-readable reason, safe to show in the pairing UI.
        reason: String,
    },

    /// The SSH layer failed: connection, host key, authentication or channel error.
    #[error("ssh: {reason}")]
    Ssh {
        /// Human-readable reason, safe to show in the connection UI.
        reason: String,
    },

    /// Local I/O failed.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// Key material could not be parsed or a signature could not be produced.
    #[error("crypto: {0}")]
    Crypto(String),

    /// The pairing URI carries a major version this build does not implement.
    #[error("unsupported pairing QR major version {found} (this build speaks v1)")]
    UnsupportedVersion {
        /// Major version found in the URI.
        found: u32,
    },

    /// The requested path does not exist.
    #[error("not found: {path}")]
    NotFound {
        /// Path as the caller named it, safe to show in the UI.
        path: String,
    },

    /// The operating system refused access to the path.
    #[error("permission denied: {path}")]
    PermissionDenied {
        /// Path as the caller named it, safe to show in the UI.
        path: String,
    },

    /// The file is bigger than the byte cap the caller allowed.
    ///
    /// The real size is reported so the UI can say how big the file is instead of
    /// pretending it was empty.
    #[error("file too large: {path} is {size} bytes (limit {max})")]
    TooLarge {
        /// Path as the caller named it.
        path: String,
        /// Real size of the file, in bytes.
        size: u64,
        /// Cap the caller allowed, in bytes.
        max: u64,
    },

    /// The file is not UTF-8 text (or carries a NUL byte), so it cannot be opened as text.
    #[error("binary file: {path} is not text")]
    Binary {
        /// Path as the caller named it.
        path: String,
    },

    /// The relative path the caller sent is not a safe relative path.
    #[error("invalid path: {reason}")]
    InvalidPath {
        /// Human-readable reason, safe to show in the UI.
        reason: String,
    },

    /// The resolved path leaves the root the caller allowed (typically a symlink escape).
    #[error("path outside root: {path}")]
    OutsideRoot {
        /// Path as the caller named it.
        path: String,
    },
}

impl CoreError {
    /// Build an [`CoreError::InvalidQr`].
    pub fn invalid_qr(reason: impl Into<String>) -> Self {
        Self::InvalidQr {
            reason: reason.into(),
        }
    }

    /// Build an [`CoreError::Ssh`].
    pub fn ssh(reason: impl Into<String>) -> Self {
        Self::Ssh {
            reason: reason.into(),
        }
    }

    /// Build an [`CoreError::Crypto`].
    pub fn crypto(reason: impl Into<String>) -> Self {
        Self::Crypto(reason.into())
    }

    /// Build a [`CoreError::NotFound`].
    pub fn not_found(path: impl Into<String>) -> Self {
        Self::NotFound { path: path.into() }
    }

    /// Build a [`CoreError::PermissionDenied`].
    pub fn permission_denied(path: impl Into<String>) -> Self {
        Self::PermissionDenied { path: path.into() }
    }

    /// Build a [`CoreError::TooLarge`].
    pub fn too_large(path: impl Into<String>, size: u64, max: u64) -> Self {
        Self::TooLarge {
            path: path.into(),
            size,
            max,
        }
    }

    /// Build a [`CoreError::Binary`].
    pub fn binary(path: impl Into<String>) -> Self {
        Self::Binary { path: path.into() }
    }

    /// Build a [`CoreError::InvalidPath`].
    pub fn invalid_path(reason: impl Into<String>) -> Self {
        Self::InvalidPath {
            reason: reason.into(),
        }
    }

    /// Build a [`CoreError::OutsideRoot`].
    pub fn outside_root(path: impl Into<String>) -> Self {
        Self::OutsideRoot { path: path.into() }
    }

    /// Stable machine-readable kind, used by the FFI payload and the TS bindings.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidQr { .. } => KIND_INVALID_QR,
            Self::Ssh { .. } => KIND_SSH,
            Self::Io(_) => KIND_IO,
            Self::Crypto(_) => KIND_CRYPTO,
            Self::UnsupportedVersion { .. } => KIND_UNSUPPORTED_VERSION,
            Self::NotFound { .. } => KIND_NOT_FOUND,
            Self::PermissionDenied { .. } => KIND_PERMISSION_DENIED,
            Self::TooLarge { .. } => KIND_TOO_LARGE,
            Self::Binary { .. } => KIND_BINARY,
            Self::InvalidPath { .. } => KIND_INVALID_PATH,
            Self::OutsideRoot { .. } => KIND_OUTSIDE_ROOT,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_is_stable_for_every_variant() {
        assert_eq!(CoreError::invalid_qr("x").kind(), "invalid_qr");
        assert_eq!(CoreError::ssh("x").kind(), "ssh");
        assert_eq!(CoreError::crypto("x").kind(), "crypto");
        assert_eq!(CoreError::Io(std::io::Error::other("boom")).kind(), "io");
        assert_eq!(
            CoreError::UnsupportedVersion { found: 2 }.kind(),
            "unsupported_version"
        );
    }

    #[test]
    fn the_file_system_kinds_are_stable() {
        assert_eq!(CoreError::not_found("a.ts").kind(), "not_found");
        assert_eq!(
            CoreError::permission_denied("b").kind(),
            "permission_denied"
        );
        assert_eq!(CoreError::too_large("c", 9, 4).kind(), "too_large");
        assert_eq!(CoreError::binary("d").kind(), "binary");
        assert_eq!(CoreError::invalid_path("e").kind(), "invalid_path");
        assert_eq!(CoreError::outside_root("f").kind(), "outside_root");

        assert_eq!(CoreError::not_found("a.ts").to_string(), "not found: a.ts");
        assert_eq!(
            CoreError::permission_denied("a.ts").to_string(),
            "permission denied: a.ts"
        );
        assert_eq!(
            CoreError::too_large("a.bin", 1_048_576, 1024).to_string(),
            "file too large: a.bin is 1048576 bytes (limit 1024)"
        );
        assert_eq!(
            CoreError::binary("logo.png").to_string(),
            "binary file: logo.png is not text"
        );
        assert_eq!(
            CoreError::invalid_path("the path walks upwards").to_string(),
            "invalid path: the path walks upwards"
        );
        assert_eq!(
            CoreError::outside_root("../etc/passwd").to_string(),
            "path outside root: ../etc/passwd"
        );
    }

    #[test]
    fn messages_keep_the_frozen_prefixes() {
        assert_eq!(
            CoreError::invalid_qr("missing host").to_string(),
            "invalid pairing QR: missing host"
        );
        assert_eq!(
            CoreError::ssh("auth rejected").to_string(),
            "ssh: auth rejected"
        );
        assert_eq!(
            CoreError::crypto("bad seed").to_string(),
            "crypto: bad seed"
        );
        assert_eq!(
            CoreError::UnsupportedVersion { found: 2 }.to_string(),
            "unsupported pairing QR major version 2 (this build speaks v1)"
        );
    }

    #[test]
    fn io_errors_convert_through_the_from_impl() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        let err: CoreError = io.into();
        assert_eq!(err.kind(), KIND_IO);
        assert!(err.to_string().contains("nope"));
    }
}
