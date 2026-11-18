//! Daemon provisioning: the step-by-step flow of `docs/mobile-protocol-spec.md` §2, §3 and §5.
//!
//! ## Why one function per step
//!
//! Onboarding V3 shows **one progress step at a time** (detect → upload → verify → start →
//! register), and the user-facing log prints each failure verbatim. So every step is its
//! own `async fn` with its own inputs and its own record, never one monolithic
//! `provision()`: the Kotlin/TS layer drives the sequence, can retry a single step, and
//! `gc_provision_step` maps one call to one visible progress line.
//!
//! ## Offline testability
//!
//! Every step goes through the mockable [`crate::ssh::TransportSession`] boundary:
//! `exec_once` for detection/start/rollback, a subsystem channel for the SFTP upload and a
//! direct-tcpip tunnel channel for the registration HTTP exchange. No step dials russh
//! itself, so the whole flow is scripted in tests with no host and no network.
//!
//! ## SFTP without `russh-sftp`
//!
//! russh 0.54.1 has **no** `sftp` feature: SFTP lives in the separate `russh-sftp` crate,
//! which works on a raw `russh::Channel` and therefore cannot sit behind this crate's
//! object-safe transport traits (the mocks could never drive it). Instead this module
//! speaks the small SFTP v3 subset a daemon upload needs — `INIT`, `OPEN`, `WRITE`,
//! `CLOSE` and `STATUS` — over the `sftp` subsystem channel. It is ~150 lines of
//! fixed-width big-endian framing with no new dependency, and it stays offline-testable.
//!
//! ## Security posture
//!
//! * A binary is never started before [`verify_manifest`] accepted both its SHA-256 and
//!   its ed25519 release signature (§3.2, §8).
//! * The previous binary is copied to `<path>.prev` *before* the upload overwrites it, and
//!   [`rollback`] restores it, which is the §5 failure window.
//! * Every remote path is single-quote escaped before it reaches a shell, so a malicious
//!   or merely odd path cannot inject a command on the host.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device_key::{self, PUBLIC_KEY_LEN};
use crate::error::CoreError;
use crate::fingerprint::{decode_hex, hex_lower, normalize};
use crate::ssh::{Channel, ChannelEvent, ExecOutput, SshSession, DAEMON_PORT};

/// How long [`start_daemon`] waits for the daemon to answer on its port before the caller
/// must [`rollback`] (§5: "if the restart does not answer within 10 s, revert").
pub const START_TIMEOUT: Duration = Duration::from_secs(10);

/// Delay between two readiness probes while waiting for the daemon to come up.
pub const START_PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// Fixed budget for the rollback kill: SIGTERM plus proof that the pid exited (§5, S7).
/// The readiness window may overshoot [`START_TIMEOUT`] by at most this much.
const TERMINATE_TIMEOUT: Duration = Duration::from_secs(2);

/// How long the registration exchange may take before it is reported as a timeout.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Bytes per SFTP `WRITE` packet; keeps a large binary from becoming one huge frame.
pub const SFTP_WRITE_CHUNK: usize = 32 * 1024;

/// Largest SFTP reply packet this client is willing to buffer.
const SFTP_MAX_PACKET: usize = 16 * 1024 * 1024;

/// SFTP v3 protocol version this client speaks.
const SFTP_VERSION: u32 = 3;
/// SFTP v3 `FXP_INIT` (`SSH_FXP_INIT` in the spec's older naming).
const SFTP_INIT: u8 = 1;
/// SFTP v3 `SSH_FXP_VERSION`.
const SFTP_VERSION_PACKET: u8 = 2;
/// SFTP v3 `SSH_FXP_OPEN`.
const SFTP_OPEN: u8 = 3;
/// SFTP v3 `SSH_FXP_CLOSE`.
const SFTP_CLOSE: u8 = 4;
/// SFTP v3 `SSH_FXP_WRITE`.
const SFTP_WRITE: u8 = 6;
/// SFTP v3 `SSH_FXP_STATUS`.
const SFTP_STATUS: u8 = 101;
/// SFTP v3 `SSH_FXP_HANDLE`.
const SFTP_HANDLE: u8 = 102;
/// SFTP v3 open flags: `WRITE | CREAT | TRUNC`.
const SFTP_OPEN_WRITE_CREATE_TRUNCATE: u32 = 2 | 8 | 16;
/// Exit code [`rollback`] uses to report "there is nothing to restore".
const ROLLBACK_NOTHING_TO_RESTORE: u32 = 3;

/// Where the daemon runs: what the host is and which binary slice it needs (§3.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostInfo {
    /// Operating system as [`detect_host`] maps it: `linux` or `darwin`.
    pub os: String,
    /// CPU architecture as [`detect_host`] maps it: `aarch64` or `x86_64`.
    pub arch: String,
    /// Coarse family used by the binary descriptor: `unix`.
    pub family: String,
}

/// Result of [`upload_daemon`]: what landed where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadResult {
    /// Remote path the bytes were written to.
    pub remote_path: String,
    /// Number of bytes uploaded.
    pub bytes_written: u64,
}

/// Result of [`start_daemon`]: the detached process and the port that answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartResult {
    /// PID the host reported for the detached daemon.
    pub pid: u32,
    /// Port of the daemon listener that answered the readiness probe.
    pub port: u16,
}

/// Result of [`register_device`]: the daemon's identity for this phone plus its version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    /// Identifier the daemon assigned to this device (`deviceId`).
    pub device_id: String,
    /// Daemon version read from `/api/context` (`version`).
    pub daemon_version: String,
}

/// Result of [`rollback`]: which path was restored from which backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollbackResult {
    /// Path the previous binary was moved back to.
    pub remote_path: String,
    /// Backup the restore read from (`<remote_path>.prev`).
    pub restored_from: String,
}

/// The signed release manifest of a daemon binary: `{sha256, signature}` (§3.2).
///
/// `sha256` is the lowercase 64-hex digest of the exact bytes to upload; `signature` is
/// the lowercase hex ed25519 signature **over that digest string**, produced with the
/// release key embedded in the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseManifest {
    /// Lowercase 64-hex SHA-256 of the binary, as the release signs it.
    pub sha256: String,
    /// Lowercase hex ed25519 signature over the `sha256` string.
    pub signature: String,
}

/// Result of a successful [`verify_manifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyReport {
    /// SHA-256 actually computed from the bytes (lowercase hex).
    pub sha256: String,
    /// Always `true` in a returned report: a failed check is an [`CoreError`].
    pub verified: bool,
}

/// Detect the host OS and architecture (§3.1) with `uname -s -m`.
///
/// Only the platforms the project ships daemon binaries for are accepted: `linux`/`darwin`
/// × `aarch64`/`x86_64`. Anything else is an `ssh` error naming the observed value, so the
/// onboarding log can show exactly what the host reported.
pub async fn detect_host(session: &SshSession) -> Result<HostInfo, CoreError> {
    let output = session.exec_once("uname -s -m").await?;
    let text = expect_success("uname -s -m", output)?;

    let mut parts = text.split_whitespace();
    let system = parts.next().ok_or_else(|| {
        CoreError::ssh(format!(
            "uname -s -m printed nothing usable: {:?}",
            text.trim()
        ))
    })?;
    let machine = parts.next().ok_or_else(|| {
        CoreError::ssh(format!(
            "uname -s -m did not report a machine type: {:?}",
            text.trim()
        ))
    })?;

    let (os, family) = match system {
        "Linux" => ("linux", "unix"),
        "Darwin" => ("darwin", "unix"),
        other => {
            return Err(CoreError::ssh(format!(
                "unsupported host OS {other:?} (the daemon ships for linux and darwin only)"
            )))
        }
    };
    let arch = match machine {
        "aarch64" | "arm64" => "aarch64",
        "x86_64" | "amd64" => "x86_64",
        other => {
            return Err(CoreError::ssh(format!(
                "unsupported host architecture {other:?} (the daemon ships for aarch64 and x86_64 only)"
            )))
        }
    };

    Ok(HostInfo {
        os: os.to_string(),
        arch: arch.to_string(),
        family: family.to_string(),
    })
}

/// Upload the daemon binary over SFTP and make it executable (§3.2, §3.3).
///
/// Before overwriting `remote_path` the currently installed binary is copied to
/// `<remote_path>.prev`, which is the backup [`rollback`] restores (§5). The upload itself
/// is `INIT`/`OPEN`/`WRITE`/`CLOSE` on the `sftp` subsystem; the execute bit is set with a
/// `chmod 755` over `exec`.
pub async fn upload_daemon(
    session: &SshSession,
    local_bytes: &[u8],
    remote_path: &str,
) -> Result<UploadResult, CoreError> {
    if remote_path.trim().is_empty() {
        return Err(CoreError::ssh("the remote daemon path must not be empty"));
    }
    let quoted = shell_quote(remote_path);

    // §5: keep a restorable copy before the running binary is replaced.
    let backup = posix(&format!(
        "if [ -f {quoted} ]; then cp -f {quoted} {quoted}.prev; fi"
    ));
    let output = session.exec_once(&backup).await?;
    expect_success("backing up the installed daemon", output)?;

    sftp_put(session, local_bytes, remote_path).await?;

    let chmod = posix(&format!("chmod 755 {quoted}"));
    let output = session.exec_once(&chmod).await?;
    expect_success("chmod +x on the uploaded daemon", output)?;

    Ok(UploadResult {
        remote_path: remote_path.to_string(),
        bytes_written: local_bytes.len() as u64,
    })
}

/// Verify an ed25519 release signature over the binary bytes themselves.
///
/// `false` for a wrong key, tampered bytes, a malformed signature or malformed hex: the
/// caller must abort the download, so no failure mode may panic (§3.2).
pub fn verify_release_signature(
    release_pubkey_hex: &str,
    binary_bytes: &[u8],
    signature_hex: &str,
) -> bool {
    let Ok(signature) = decode_hex(signature_hex) else {
        return false;
    };
    device_key::verify(release_pubkey_hex, binary_bytes, &signature)
}

/// Verify the signed release manifest of a daemon binary: checksum first, then signature.
///
/// Order matters for the UI log: a checksum mismatch means a truncated or swapped download
/// and is reported as `crypto` before any signature work, while a signature that does not
/// verify means the manifest (and therefore the binary) was not produced by the release key
/// embedded in the app. Both are hard failures: the caller must not start the binary.
pub fn verify_manifest(
    release_pubkey_hex: &str,
    binary_bytes: &[u8],
    manifest: &ReleaseManifest,
) -> Result<VerifyReport, CoreError> {
    let expected = normalize(&manifest.sha256).ok_or_else(|| {
        CoreError::crypto(
            "release manifest checksum must be the 64-hex sha256 of the daemon binary",
        )
    })?;
    let digest = sha256_hex(binary_bytes);
    if digest != expected {
        return Err(CoreError::crypto(format!(
            "daemon binary checksum mismatch: the signed manifest says {expected}, the bytes hash to {digest}"
        )));
    }

    let signature = decode_hex(&manifest.signature).map_err(|error| {
        CoreError::crypto(format!("release manifest signature is not hex: {error}"))
    })?;
    if !device_key::verify(release_pubkey_hex, expected.as_bytes(), &signature) {
        return Err(CoreError::crypto(
            "the daemon binary was not signed by the release key embedded in this app",
        ));
    }

    Ok(VerifyReport {
        sha256: digest,
        verified: true,
    })
}

/// Lowercase hex SHA-256 of `bytes`, the checksum the release manifest signs.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

/// Start the uploaded daemon detached and wait until its port answers (§3.4).
///
/// Uses the §5 window ([`START_TIMEOUT`]). A daemon that does not answer in time is
/// terminated and reported, and the caller's next step is [`rollback`].
pub async fn start_daemon(
    session: &SshSession,
    remote_path: &str,
    port: u16,
) -> Result<StartResult, CoreError> {
    start_daemon_with_timeout(session, remote_path, port, START_TIMEOUT).await
}

/// [`start_daemon`] with an explicit readiness window, so offline tests do not wait 10 s.
///
/// The window bounds the probe itself, and any failure after the detached start kills that
/// exact pid before returning: a stale daemon must not survive [`rollback`] (§5, S7).
pub async fn start_daemon_with_timeout(
    session: &SshSession,
    remote_path: &str,
    port: u16,
    timeout: Duration,
) -> Result<StartResult, CoreError> {
    if port == 0 {
        return Err(CoreError::ssh("daemon port must be 1..=65535"));
    }
    if remote_path.trim().is_empty() {
        return Err(CoreError::ssh("the remote daemon path must not be empty"));
    }

    let quoted = shell_quote(remote_path);
    // `nohup` + explicit redirection + `&` detaches the daemon from the exec channel, so
    // the exec can close while the daemon keeps running; `echo $!` is the pid to report.
    let command = posix(&format!(
        "nohup {quoted} >/dev/null 2>&1 </dev/null & echo $!"
    ));
    let output = session.exec_once(&command).await?;
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CoreError::ssh(format!(
            "daemon start failed with exit code {}: {stderr}",
            output.exit_code
        )));
    }
    let pid = parse_pid(&String::from_utf8_lossy(&output.stdout))?;

    let started = std::time::Instant::now();
    let mut last_error = String::from("window closed");
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(start_failure(session, pid, port, timeout, &last_error).await);
        }
        // The open is bounded by the remaining window so a stalled host cannot stretch it.
        let pause = match tokio::time::timeout(remaining, session.direct_tcp("127.0.0.1", port))
            .await
        {
            Ok(Ok(channel)) => {
                let _ = channel.close().await;
                return Ok(StartResult { pid, port });
            }
            Ok(Err(error)) => {
                last_error = error.to_string();
                // Recompute instead of reusing the pre-await value, which is now stale.
                timeout.saturating_sub(started.elapsed())
            }
            // The open consumed the whole window: the timeout is now, so never sleep again.
            Err(_) => {
                last_error = "the channel open never completed".to_string();
                return Err(start_failure(session, pid, port, timeout, &last_error).await);
            }
        };
        tokio::time::sleep(START_PROBE_INTERVAL.min(pause)).await;
    }
}

/// Terminate the pid the start reported and build the readiness-timeout error.
///
/// §5: a kill that cannot land, stalls or leaves the pid running is named in the message
/// rather than hidden or turned into a panic (S7).
async fn start_failure(
    session: &SshSession, pid: u32, port: u16, timeout: Duration, reason: &str,
) -> CoreError {
    let outcome = terminate(session, pid).await;
    CoreError::ssh(format!(
        "daemon pid {pid} did not answer on 127.0.0.1:{port} within {} ms ({reason}); {outcome}",
        timeout.as_millis()
    ))
}

/// Kill `pid` and prove it exited, all inside the fixed [`TERMINATE_TIMEOUT`] budget.
///
/// `kill -0` succeeds while the pid is alive, so a failing probe proves the exit; every
/// step is a bounded `exec`, so a host stalled mid-kill cannot hang §5.
async fn terminate(session: &SshSession, pid: u32) -> String {
    let deadline = std::time::Instant::now() + TERMINATE_TIMEOUT;
    match bounded_exec(session, &format!("kill -TERM {pid}"), deadline).await {
        Ok(output) if output.exit_code == 0 => {}
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return format!(
                "terminating pid {pid} failed with exit code {}: {stderr}, so termination could not be confirmed",
                output.exit_code
            );
        }
        Err(error) => {
            return format!(
                "terminating pid {pid} failed ({error}), so termination could not be confirmed"
            )
        }
    }
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return format!(
                "pid {pid} did not exit within {} ms of SIGTERM and may still be running",
                TERMINATE_TIMEOUT.as_millis()
            );
        }
        match bounded_exec(session, &format!("kill -0 {pid}"), deadline).await {
            Ok(output) if output.exit_code != 0 => return format!("pid {pid} was terminated"),
            Ok(_) => {}
            Err(error) => {
                return format!(
                    "pid {pid} was sent SIGTERM but its exit could not be confirmed: {error}"
                )
            }
        }
        let pause = deadline.saturating_duration_since(std::time::Instant::now());
        tokio::time::sleep(START_PROBE_INTERVAL.min(pause)).await;
    }
}

/// Run one `exec` inside the shared termination budget, so a stalled host cannot hang §5.
async fn bounded_exec(
    session: &SshSession, script: &str, deadline: std::time::Instant,
) -> Result<ExecOutput, CoreError> {
    let command = posix(script);
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    match tokio::time::timeout(remaining, session.exec_once(&command)).await {
        Ok(result) => result,
        Err(_) => Err(CoreError::ssh(format!(
            "the command did not complete within {} ms",
            TERMINATE_TIMEOUT.as_millis()
        ))),
    }
}

/// Register this phone with the freshly started daemon (§2.3–§2.5) through the tunnel.
///
/// One `POST /api/pairing/claim` (`{deviceName, invite, ed25519PublicKey}`) with the
/// daemon's own device-surface `Origin` header — its strict Origin guard refuses a POST
/// without one — followed by `GET /api/context` for the daemon version. The tunnel is the
/// SSH direct-tcpip channel to `127.0.0.1:`[`DAEMON_PORT`] (§4), so no host port is exposed.
///
/// Note: the daemon's current claim API persists a bearer token and ignores
/// `ed25519PublicKey`; the field is sent because §2.3 freezes it, and it is what a
/// pubkey-aware daemon will read.
pub async fn register_device(
    session: &SshSession,
    device_pubkey_hex: &str,
    invite_token: &str,
    device_name: &str,
) -> Result<Registration, CoreError> {
    register_device_with_timeout(
        session,
        device_pubkey_hex,
        invite_token,
        device_name,
        HTTP_TIMEOUT,
    )
    .await
}

/// [`register_device`] with an explicit HTTP timeout, so offline tests do not wait 10 s.
pub async fn register_device_with_timeout(
    session: &SshSession,
    device_pubkey_hex: &str,
    invite_token: &str,
    device_name: &str,
    timeout: Duration,
) -> Result<Registration, CoreError> {
    let public_key = decode_hex(device_pubkey_hex)
        .map_err(|error| CoreError::crypto(format!("device public key is not hex: {error}")))?;
    if public_key.len() != PUBLIC_KEY_LEN {
        return Err(CoreError::crypto(format!(
            "device public key must be {PUBLIC_KEY_LEN} bytes, got {}",
            public_key.len()
        )));
    }
    let name = device_name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(CoreError::ssh("device name must be 1-80 characters"));
    }
    if invite_token.trim().is_empty() {
        return Err(CoreError::ssh("the invite token must not be empty"));
    }

    let body = serde_json::json!({
        "deviceName": name,
        "invite": invite_token,
        "ed25519PublicKey": hex_lower(&public_key),
    })
    .to_string();

    let (status, reply) =
        http_json(session, "POST", "/api/pairing/claim", Some(&body), timeout).await?;
    if !(200..300).contains(&status) {
        return Err(CoreError::ssh(format!(
            "the daemon rejected the device registration with HTTP {status}: {}",
            excerpt(&reply)
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&reply).map_err(|error| {
        CoreError::ssh(format!(
            "the daemon registration reply is not JSON ({error}): {}",
            excerpt(&reply)
        ))
    })?;
    let device_id = value
        .get("deviceId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            CoreError::ssh(format!(
                "the daemon registration reply has no deviceId string: {}",
                excerpt(&reply)
            ))
        })?
        .to_string();

    let (status, context) = http_json(session, "GET", "/api/context", None, timeout).await?;
    if !(200..300).contains(&status) {
        return Err(CoreError::ssh(format!(
            "the daemon did not report its version (HTTP {status}): {}",
            excerpt(&context)
        )));
    }
    let context: serde_json::Value = serde_json::from_str(&context).map_err(|error| {
        CoreError::ssh(format!(
            "the daemon /api/context reply is not JSON ({error}): {}",
            excerpt(&context)
        ))
    })?;
    let daemon_version = context
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            CoreError::ssh(format!(
                "the daemon /api/context reply has no version string: {}",
                excerpt(&context.to_string())
            ))
        })?
        .to_string();

    Ok(Registration {
        device_id,
        daemon_version,
    })
}

/// Restore `<remote_path>.prev` over `remote_path` after a failed start (§5).
///
/// The backup is the one [`upload_daemon`] made before it overwrote the installed binary.
/// A host with no `.prev` is reported precisely instead of being treated as success.
pub async fn rollback(
    session: &SshSession,
    remote_path: &str,
) -> Result<RollbackResult, CoreError> {
    if remote_path.trim().is_empty() {
        return Err(CoreError::ssh("the remote daemon path must not be empty"));
    }
    let previous = format!("{remote_path}.prev");
    let quoted = shell_quote(remote_path);
    let quoted_previous = shell_quote(&previous);
    let command = posix(&format!(
        "if [ -f {quoted_previous} ]; then mv -f {quoted_previous} {quoted}; else exit {ROLLBACK_NOTHING_TO_RESTORE}; fi"
    ));
    let output = session.exec_once(&command).await?;
    if output.exit_code == ROLLBACK_NOTHING_TO_RESTORE {
        return Err(CoreError::ssh(format!(
            "cannot roll back: the host has no previous daemon binary at {previous}"
        )));
    }
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CoreError::ssh(format!(
            "rollback failed with exit code {}: {stderr}",
            output.exit_code
        )));
    }
    Ok(RollbackResult {
        remote_path: remote_path.to_string(),
        restored_from: previous,
    })
}

/// Run `script` under `/bin/sh`, whatever the host user's login shell is.
///
/// OpenSSH `exec` runs the user's login shell, which may be fish or csh, where `if ...; then
/// ...; fi`, `&&` and `$!` do not exist. Every compound command therefore goes through
/// `sh -c` with the whole script single-quoted, so daemon provisioning works for any user
/// account and no path is ever interpolated unquoted.
fn posix(script: &str) -> String {
    format!("sh -c {}", shell_quote(script))
}

/// Quote one value for a POSIX shell single-quoted string.
///
/// Remote paths come from the app, so they are never interpolated raw: an embedded `'`
/// becomes `'\''`, which keeps the value a single word even if it carries spaces,
/// semicolons or `$( )`.
fn shell_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for character in value.chars() {
        if character == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(character);
        }
    }
    out.push('\'');
    out
}

/// Turn an `exec` result into its stdout text, or an `ssh` error naming the step.
fn expect_success(step: &str, output: ExecOutput) -> Result<String, CoreError> {
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CoreError::ssh(format!(
            "{step} failed with exit code {}: {stderr}",
            output.exit_code
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Read the pid the detached start reported on its last non-empty stdout line.
fn parse_pid(stdout: &str) -> Result<u32, CoreError> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .and_then(|line| line.parse::<u32>().ok())
        .ok_or_else(|| {
            CoreError::ssh(format!(
                "daemon start did not report a pid (stdout: {:?})",
                stdout.trim()
            ))
        })
}

/// A bounded excerpt of a daemon reply for an error message.
fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(240).collect();
    if trimmed.chars().count() > 240 {
        out.push('…');
    }
    out
}

/// One HTTP/1.1 exchange with the daemon through the direct-tcpip tunnel (§4).
async fn http_json(
    session: &SshSession,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<(u16, String), CoreError> {
    let channel = session
        .direct_tcp("127.0.0.1", DAEMON_PORT)
        .await
        .map_err(|error| {
            CoreError::ssh(format!(
                "cannot open the daemon tunnel on 127.0.0.1:{DAEMON_PORT} for {method} {path}: {error}"
            ))
        })?;

    let host = format!("127.0.0.1:{DAEMON_PORT}");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if let Some(body) = body {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        request.push_str("\r\n");
        request.push_str(body);
    } else {
        request.push_str("\r\n");
    }

    channel.write(request.as_bytes()).await.map_err(|error| {
        CoreError::ssh(format!(
            "cannot write {method} {path} to the daemon through the tunnel: {error}"
        ))
    })?;

    let raw = read_all(&channel, timeout, method, path).await?;
    let (status, body) = parse_http_response(&String::from_utf8_lossy(&raw))?;
    let _ = channel.close().await;
    Ok((status, body))
}

/// Read the tunnel channel until EOF, bounded by `timeout`.
async fn read_all(
    channel: &Channel,
    timeout: Duration,
    method: &str,
    path: &str,
) -> Result<Vec<u8>, CoreError> {
    let started = std::time::Instant::now();
    let mut buffer = Vec::new();
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(timeout_error(method, path, timeout));
        }
        match tokio::time::timeout(remaining, channel.read()).await {
            Err(_) => return Err(timeout_error(method, path, timeout)),
            Ok(Err(error)) => {
                return Err(CoreError::ssh(format!(
                    "tunnel read failed while waiting for {method} {path}: {error}"
                )));
            }
            Ok(Ok(ChannelEvent::Data(bytes))) => buffer.extend_from_slice(&bytes),
            Ok(Ok(ChannelEvent::Eof)) => return Ok(buffer),
            Ok(Ok(ChannelEvent::ExtendedData { ext, .. })) => {
                return Err(CoreError::ssh(format!(
                    "the daemon sent unexpected extended data (ext {ext}) on the tunnel"
                )))
            }
        }
    }
}

/// The timeout message shared by both timeout paths.
fn timeout_error(method: &str, path: &str, timeout: Duration) -> CoreError {
    CoreError::ssh(format!(
        "the daemon did not answer {method} {path} within {} ms",
        timeout.as_millis()
    ))
}

/// Split an HTTP/1.1 response into its status code and body, decoding `chunked` bodies.
fn parse_http_response(raw: &str) -> Result<(u16, String), CoreError> {
    let (head, body) = raw.split_once("\r\n\r\n").ok_or_else(|| {
        CoreError::ssh(format!(
            "malformed HTTP response from the daemon (no header terminator): {}",
            excerpt(raw)
        ))
    })?;

    let status_line = head.split("\r\n").next().unwrap_or_default();
    let mut parts = status_line.split_whitespace();
    parts.next();
    let status = parts
        .next()
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            CoreError::ssh(format!(
                "malformed HTTP status line from the daemon: {status_line:?}"
            ))
        })?;

    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked {
        decode_chunked(body)?
    } else {
        body.to_string()
    };
    Ok((status, body))
}

/// Decode an HTTP/1.1 `chunked` body into its payload text.
fn decode_chunked(body: &str) -> Result<String, CoreError> {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let (size_line, tail) = rest.split_once("\r\n").ok_or_else(|| {
            CoreError::ssh("malformed chunked HTTP body from the daemon (missing chunk size)")
        })?;
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| {
            CoreError::ssh(format!(
                "malformed chunked HTTP body from the daemon (bad chunk size {size_text:?})"
            ))
        })?;
        if size == 0 {
            return Ok(out);
        }
        let chunk = tail.get(..size).ok_or_else(|| {
            CoreError::ssh(
                "malformed chunked HTTP body from the daemon (chunk shorter than its size)",
            )
        })?;
        out.push_str(chunk);
        rest = tail
            .get(size..)
            .and_then(|rest| rest.strip_prefix("\r\n"))
            .ok_or_else(|| {
                CoreError::ssh(
                    "malformed chunked HTTP body from the daemon (missing chunk terminator)",
                )
            })?;
    }
}

/// SFTP v3 channel I/O: framing plus the packet encoding this upload needs.
struct SftpIo {
    channel: Channel,
    pending: Vec<u8>,
}

impl SftpIo {
    /// Frame and send one packet body (`len || body`).
    async fn send(&self, body: &[u8]) -> Result<(), CoreError> {
        let mut framed = Vec::with_capacity(body.len() + 4);
        push_u32(&mut framed, body.len() as u32);
        framed.extend_from_slice(body);
        self.channel
            .write(&framed)
            .await
            .map_err(|error| CoreError::ssh(format!("cannot write to the sftp subsystem: {error}")))
    }

    /// Read the next packet body, buffering partial frames.
    async fn next_packet(&mut self, what: &str) -> Result<Vec<u8>, CoreError> {
        loop {
            if self.pending.len() >= 4 {
                let length = read_u32(&self.pending, 0).unwrap_or(0) as usize;
                if length > SFTP_MAX_PACKET {
                    return Err(CoreError::ssh(format!(
                        "sftp: the host announced an oversized {what} packet ({length} bytes)"
                    )));
                }
                if self.pending.len() >= length + 4 {
                    let body = self.pending[4..length + 4].to_vec();
                    self.pending.drain(..length + 4);
                    return Ok(body);
                }
            }
            match self.channel.read().await.map_err(|error| {
                CoreError::ssh(format!("cannot read the sftp subsystem reply: {error}"))
            })? {
                ChannelEvent::Data(bytes) => self.pending.extend_from_slice(&bytes),
                ChannelEvent::Eof => {
                    return Err(CoreError::ssh(format!(
                        "sftp: the host closed the subsystem before replying to {what}"
                    )))
                }
                ChannelEvent::ExtendedData { ext, .. } => {
                    return Err(CoreError::ssh(format!(
                        "sftp: unexpected extended data (ext {ext}) on the subsystem channel"
                    )))
                }
            }
        }
    }
}

/// Upload `bytes` to `remote_path` over the `sftp` subsystem (§3.3).
async fn sftp_put(session: &SshSession, bytes: &[u8], remote_path: &str) -> Result<(), CoreError> {
    let channel = session.open_subsystem("sftp").await.map_err(|error| {
        CoreError::ssh(format!(
            "cannot open the sftp subsystem for the daemon upload: {error}"
        ))
    })?;
    let mut io = SftpIo {
        channel,
        pending: Vec::new(),
    };

    let mut init = Vec::new();
    init.push(SFTP_INIT);
    push_u32(&mut init, SFTP_VERSION);
    io.send(&init).await?;
    let reply = io.next_packet("init").await?;
    if packet_type(&reply) != Some(SFTP_VERSION_PACKET) {
        return Err(CoreError::ssh(format!(
            "sftp: expected a version reply to init, got packet type {}",
            packet_type(&reply).map_or(-1, i32::from)
        )));
    }
    let version = read_u32(&reply, 1).unwrap_or(0);
    if version != SFTP_VERSION {
        return Err(CoreError::ssh(format!(
            "sftp: the host speaks protocol version {version}, this client needs {SFTP_VERSION}"
        )));
    }

    let mut open = Vec::new();
    open.push(SFTP_OPEN);
    push_u32(&mut open, 1);
    push_string(&mut open, remote_path.as_bytes());
    push_u32(&mut open, SFTP_OPEN_WRITE_CREATE_TRUNCATE);
    push_u32(&mut open, 0);
    io.send(&open).await?;
    let reply = io.next_packet("open").await?;
    if packet_type(&reply) != Some(SFTP_HANDLE) {
        return Err(match expect_status("open", &reply) {
            Err(error) => error,
            // A success status without a handle would leave the upload without a target.
            Ok(()) => {
                CoreError::ssh("sftp: the open reply was a success status without a file handle")
            }
        });
    }
    let handle = read_string(&reply, 5)
        .map(|(handle, _)| handle.to_vec())
        .ok_or_else(|| CoreError::ssh("sftp: the open reply carried no file handle"))?;

    let mut id = 2;
    let mut offset = 0u64;
    for chunk in bytes.chunks(SFTP_WRITE_CHUNK.max(1)) {
        let mut write = Vec::new();
        write.push(SFTP_WRITE);
        push_u32(&mut write, id);
        push_string(&mut write, &handle);
        push_u64(&mut write, offset);
        push_string(&mut write, chunk);
        io.send(&write).await?;
        let reply = io.next_packet("write").await?;
        expect_status("write", &reply)?;
        id += 1;
        offset += chunk.len() as u64;
    }

    let mut close = Vec::new();
    close.push(SFTP_CLOSE);
    push_u32(&mut close, id);
    push_string(&mut close, &handle);
    io.send(&close).await?;
    let reply = io.next_packet("close").await?;
    expect_status("close", &reply)?;

    io.channel
        .close()
        .await
        .map_err(|error| CoreError::ssh(format!("cannot close the sftp subsystem: {error}")))?;
    Ok(())
}

/// Packet type byte of an SFTP reply body.
fn packet_type(body: &[u8]) -> Option<u8> {
    body.first().copied()
}

/// Accept a `STATUS` reply with code `OK`, or build the precise SFTP error.
fn expect_status(what: &str, body: &[u8]) -> Result<(), CoreError> {
    if packet_type(body) != Some(SFTP_STATUS) {
        return Err(CoreError::ssh(format!(
            "sftp: expected a status reply to {what}, got packet type {}",
            packet_type(body).map_or(-1, i32::from)
        )));
    }
    let code = read_u32(body, 5).unwrap_or(u32::MAX);
    if code == 0 {
        return Ok(());
    }
    let message = read_string(body, 9)
        .map(|(text, _)| String::from_utf8_lossy(text).trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "no message".to_string());
    Err(CoreError::ssh(format!(
        "sftp {what} failed with status {code}: {message}"
    )))
}

/// Append a big-endian `u32` to a packet under construction.
fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

/// Append a big-endian `u64` to a packet under construction.
fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

/// Append an SFTP string (length-prefixed bytes) to a packet under construction.
fn push_string(out: &mut Vec<u8>, value: &[u8]) {
    push_u32(out, value.len() as u32);
    out.extend_from_slice(value);
}

/// Read a big-endian `u32` at `at`, or `None` when the packet is too short.
fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(slice))
}

/// Read an SFTP string at `at`, returning the bytes and the offset just past them.
fn read_string(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let length = read_u32(bytes, at)? as usize;
    let start = at + 4;
    let value = bytes.get(start..start.checked_add(length)?)?;
    Some((value, start + length))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_fips_test_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn shell_quote_keeps_a_hostile_path_a_single_word() {
        assert_eq!(shell_quote("daemon"), "'daemon'");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_quote("; rm -rf /"), "'; rm -rf /'");
        assert_eq!(shell_quote("$(id)"), "'$(id)'");
    }

    #[test]
    fn posix_wraps_the_script_in_a_quoted_sh_call() {
        assert_eq!(posix("true"), "sh -c 'true'");
        // An inner single-quoted path stays a literal: only the quote is escaped.
        let script = format!("chmod 755 {}", shell_quote("a b"));
        assert_eq!(posix(&script), "sh -c 'chmod 755 '\\''a b'\\'''");
        // The wrapped script keeps hostile characters literal, never executable.
        let hostile = posix(&format!("nohup {}", shell_quote("$(id);rm -rf /")));
        assert_eq!(hostile, "sh -c 'nohup '\\''$(id);rm -rf /'\\'''");
    }

    #[test]
    fn parse_pid_reads_the_last_reported_line() {
        assert_eq!(parse_pid("1234\n").expect("pid"), 1234);
        assert_eq!(parse_pid("\n4321\n").expect("pid"), 4321);
        let error = parse_pid("not-a-pid\n").expect_err("no pid");
        assert_eq!(error.kind(), "ssh");
        assert!(
            error.to_string().contains("did not report a pid"),
            "{error}"
        );
    }

    #[test]
    fn expect_success_keeps_the_step_and_the_exit_code_in_the_message() {
        let output = ExecOutput {
            exit_code: 2,
            stdout: Vec::new(),
            stderr: b"boom\n".to_vec(),
        };
        let error = expect_success("chmod +x on the uploaded daemon", output).expect_err("fails");
        assert_eq!(error.kind(), "ssh");
        assert_eq!(
            error.to_string(),
            "ssh: chmod +x on the uploaded daemon failed with exit code 2: boom"
        );
    }

    #[test]
    fn http_responses_parse_with_length_and_chunked_bodies() {
        let plain = "HTTP/1.1 200 OK\r\nContent-Length: 26\r\n\r\n{\"deviceId\":\"dev-1\"}";
        assert_eq!(
            parse_http_response(plain).expect("plain"),
            (200, "{\"deviceId\":\"dev-1\"}".to_string())
        );

        let chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n{\"deviceI\r\n7\r\nd\":\"1\"}\r\n0\r\n\r\n";
        assert_eq!(
            parse_http_response(chunked).expect("chunked"),
            (200, "{\"deviceId\":\"1\"}".to_string())
        );
    }

    #[test]
    fn malformed_http_responses_are_ssh_errors() {
        let no_terminator = parse_http_response("HTTP/1.1 200 OK\r\n").expect_err("no body");
        assert_eq!(no_terminator.kind(), "ssh");
        assert!(
            no_terminator.to_string().contains("no header terminator"),
            "{no_terminator}"
        );

        let bad_status = parse_http_response("HTTP/1.1 nope\r\n\r\n").expect_err("bad status");
        assert!(
            bad_status
                .to_string()
                .contains("malformed HTTP status line"),
            "{bad_status}"
        );

        let bad_chunk =
            parse_http_response("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n")
                .expect_err("bad chunk");
        assert!(
            bad_chunk.to_string().contains("bad chunk size"),
            "{bad_chunk}"
        );
    }

    #[test]
    fn sftp_packet_helpers_round_trip() {
        let mut body = vec![SFTP_WRITE];
        push_u32(&mut body, 7);
        push_string(&mut body, b"handle");
        push_u64(&mut body, 42);
        push_string(&mut body, b"payload");
        assert_eq!(packet_type(&body), Some(SFTP_WRITE));
        assert_eq!(read_u32(&body, 1), Some(7));
        assert_eq!(
            read_string(&body, 5).map(|(value, _)| value),
            Some(&b"handle"[..])
        );
        assert_eq!(&body[15..23], &42u64.to_be_bytes());
        assert_eq!(
            read_string(&body, 23).map(|(value, _)| value),
            Some(&b"payload"[..])
        );
        assert_eq!(read_u32(&body, 1_000), None);
        assert_eq!(read_string(&body, 1_000), None);
    }

    #[test]
    fn status_replies_report_the_code_and_the_host_message() {
        let mut body = vec![SFTP_STATUS];
        push_u32(&mut body, 1);
        push_u32(&mut body, 3);
        push_string(&mut body, b"permission denied");
        push_string(&mut body, b"en");
        let error = expect_status("open", &body).expect_err("rejected");
        assert_eq!(error.kind(), "ssh");
        assert_eq!(
            error.to_string(),
            "ssh: sftp open failed with status 3: permission denied"
        );

        let mut ok = vec![SFTP_STATUS];
        push_u32(&mut ok, 1);
        push_u32(&mut ok, 0);
        push_string(&mut ok, b"ok");
        push_string(&mut ok, b"en");
        expect_status("write", &ok).expect("status ok");

        let wrong_type =
            expect_status("close", &[SFTP_HANDLE, 0, 0, 0, 1]).expect_err("wrong type");
        assert!(
            wrong_type.to_string().contains("got packet type 102"),
            "{wrong_type}"
        );
    }
}
