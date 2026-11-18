//! Offline integration tests for the provisioning flow and the C ABI layer.
//!
//! Every step runs against a scripted in-memory [`Transport`]: no SSH server, no daemon,
//! no network. The script answers `execOnce` with queued [`ExecOutput`]s, the `sftp`
//! subsystem with queued SFTP v3 reply packets and the tunnel with queued HTTP responses,
//! so the assertions can be about the exact sequence the core produced.

use std::collections::VecDeque;
use std::ffi::{CStr, CString};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;

use mobile_core::cabi;
use mobile_core::device_key;
use mobile_core::provision::{
    detect_host, register_device_with_timeout, rollback, sha256_hex, start_daemon,
    start_daemon_with_timeout, upload_daemon, verify_manifest, verify_release_signature,
    ReleaseManifest,
};
use mobile_core::ssh::{
    BoxFuture, ChannelEvent, ConnectRequest, ExecOutput, SshCredential, SshSession, Transport,
    TransportChannel, TransportSession,
};

const FP: &str = "aa11bb22cc33dd44ee55ff6600778899aa11bb22cc33dd44ee55ff6600778899";
const REMOTE_PATH: &str = "/home/reaan/.gentle-movil/daemon";
/// Remote path the C ABI test uses. The provisioning registry is process-wide and keyed by
/// path, so this test needs a path no other test uploads to.
const ABI_REMOTE_PATH: &str = "/home/reaan/.gentle-movil/daemon-abi";
const DEVICE_PUBKEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const INVITE: &str = "inv_7Qp2";

// --------------------------------------------------------------------------------------
// Scripted transport
// --------------------------------------------------------------------------------------

/// How the mock answers the next `direct_tcpip` call.
enum TcpReply {
    /// A channel that yields these events, then EOF.
    Events(Vec<ChannelEvent>),
    /// The tunnel cannot be opened (the daemon port does not answer yet).
    Failure(String),
    /// The channel open never completes, like a host that stops answering mid-handshake.
    Stall,
}

/// The shared script and the observed traffic.
#[derive(Default)]
struct Shared {
    exec: Mutex<VecDeque<ExecOutput>>,
    exec_commands: Mutex<Vec<String>>,
    tcp: Mutex<VecDeque<TcpReply>>,
    sftp: Mutex<VecDeque<ChannelEvent>>,
    tcp_writes: Mutex<Vec<Vec<u8>>>,
    tcp_targets: Mutex<Vec<(String, u16)>>,
    sftp_writes: Mutex<Vec<Vec<u8>>>,
    /// Commands whose `execOnce` never completes (a host stalled mid-command).
    stalled_exec: Mutex<Vec<String>>,
    /// Host key fingerprint the scripted handshake reports (`""` = it saw no key).
    fingerprint: Mutex<String>,
}

impl Shared {
    fn push_exec(&self, output: ExecOutput) {
        self.exec.lock().expect("exec queue").push_back(output);
    }

    fn pop_exec(&self) -> ExecOutput {
        self.exec
            .lock()
            .expect("exec queue")
            .pop_front()
            .unwrap_or_else(|| panic!("unscripted execOnce call"))
    }

    fn push_tcp(&self, reply: TcpReply) {
        self.tcp.lock().expect("tcp queue").push_back(reply);
    }

    /// Make every `execOnce` whose command contains `needle` never return, like a host that
    /// stalls mid-command.
    fn stall_exec_containing(&self, needle: &str) {
        self.stalled_exec
            .lock()
            .expect("stall")
            .push(needle.to_string());
    }

    fn pop_tcp(&self) -> TcpReply {
        self.tcp
            .lock()
            .expect("tcp queue")
            .pop_front()
            .unwrap_or_else(|| panic!("unscripted direct_tcpip call"))
    }

    fn push_sftp(&self, events: Vec<ChannelEvent>) {
        let mut queue = self.sftp.lock().expect("sftp queue");
        queue.extend(events);
    }

    fn commands(&self) -> Vec<String> {
        self.exec_commands.lock().expect("commands").clone()
    }

    fn written_tcp(&self) -> Vec<Vec<u8>> {
        self.tcp_writes.lock().expect("writes").clone()
    }

    /// `(host, port)` of every direct-tcpip open the core requested.
    fn tcp_targets(&self) -> Vec<(String, u16)> {
        self.tcp_targets.lock().expect("targets").clone()
    }

    fn written_sftp(&self) -> Vec<Vec<u8>> {
        self.sftp_writes.lock().expect("writes").clone()
    }
}

struct ScriptedTransport {
    shared: Arc<Shared>,
}

impl Transport for ScriptedTransport {
    fn connect<'a>(
        &'a self,
        _request: &'a ConnectRequest,
    ) -> BoxFuture<'a, Result<Box<dyn TransportSession>, mobile_core::CoreError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(
            async move { Ok(Box::new(ScriptedSession { shared }) as Box<dyn TransportSession>) },
        )
    }
}

struct ScriptedSession {
    shared: Arc<Shared>,
}

impl TransportSession for ScriptedSession {
    fn host_key_fingerprint(&self) -> String {
        self.shared
            .fingerprint
            .lock()
            .expect("fingerprint")
            .clone()
    }

    fn exec_once<'a>(
        &'a self,
        command: &'a str,
    ) -> BoxFuture<'a, Result<ExecOutput, mobile_core::CoreError>> {
        self.shared
            .exec_commands
            .lock()
            .expect("commands")
            .push(command.to_string());
        let stalled = self.shared.stalled_exec.lock().expect("stall");
        if stalled.iter().any(|needle| command.contains(needle.as_str())) {
            return Box::pin(std::future::pending());
        }
        drop(stalled);
        let output = self.shared.pop_exec();
        Box::pin(async move { Ok(output) })
    }

    fn direct_tcpip<'a>(
        &'a self,
        target_host: &'a str,
        target_port: u16,
    ) -> BoxFuture<'a, Result<Box<dyn TransportChannel>, mobile_core::CoreError>> {
        self.shared
            .tcp_targets
            .lock()
            .expect("targets")
            .push((target_host.to_string(), target_port));
        let reply = self.shared.pop_tcp();
        match reply {
            TcpReply::Failure(reason) => {
                Box::pin(async move { Err(mobile_core::CoreError::ssh(reason)) })
            }
            TcpReply::Stall => Box::pin(std::future::pending()),
            TcpReply::Events(events) => {
                let channel = TcpChannel {
                    shared: Arc::clone(&self.shared),
                    pending: AsyncMutex::new(events.into()),
                };
                Box::pin(async move { Ok(Box::new(channel) as Box<dyn TransportChannel>) })
            }
        }
    }

    fn open_subsystem<'a>(
        &'a self,
        name: &'a str,
    ) -> BoxFuture<'a, Result<Box<dyn TransportChannel>, mobile_core::CoreError>> {
        let supported = name == "sftp";
        let channel = SftpChannel {
            shared: Arc::clone(&self.shared),
        };
        Box::pin(async move {
            if supported {
                Ok(Box::new(channel) as Box<dyn TransportChannel>)
            } else {
                Err(mobile_core::CoreError::ssh(format!(
                    "the mock has no {name} subsystem"
                )))
            }
        })
    }
}

/// Tunnel channel: yields the scripted HTTP events, records the request bytes.
struct TcpChannel {
    shared: Arc<Shared>,
    pending: AsyncMutex<VecDeque<ChannelEvent>>,
}

impl TransportChannel for TcpChannel {
    fn read<'a>(&'a self) -> BoxFuture<'a, Result<ChannelEvent, mobile_core::CoreError>> {
        Box::pin(async move {
            let mut pending = self.pending.lock().await;
            Ok(pending.pop_front().unwrap_or(ChannelEvent::Eof))
        })
    }

    fn write<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<(), mobile_core::CoreError>> {
        self.shared
            .tcp_writes
            .lock()
            .expect("writes")
            .push(bytes.to_vec());
        Box::pin(async { Ok(()) })
    }

    fn close(&self) -> BoxFuture<'_, Result<(), mobile_core::CoreError>> {
        Box::pin(async { Ok(()) })
    }
}

/// SFTP subsystem channel: yields the scripted reply packets, records request packets.
struct SftpChannel {
    shared: Arc<Shared>,
}

impl TransportChannel for SftpChannel {
    fn read<'a>(&'a self) -> BoxFuture<'a, Result<ChannelEvent, mobile_core::CoreError>> {
        let next = self
            .shared
            .sftp
            .lock()
            .expect("sftp queue")
            .pop_front()
            .unwrap_or(ChannelEvent::Eof);
        Box::pin(async move { Ok(next) })
    }

    fn write<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<(), mobile_core::CoreError>> {
        self.shared
            .sftp_writes
            .lock()
            .expect("writes")
            .push(bytes.to_vec());
        Box::pin(async { Ok(()) })
    }

    fn close(&self) -> BoxFuture<'_, Result<(), mobile_core::CoreError>> {
        Box::pin(async { Ok(()) })
    }
}

// --------------------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------------------

fn shared() -> Arc<Shared> {
    Arc::new(Shared {
        fingerprint: Mutex::new(FP.to_string()),
        ..Shared::default()
    })
}

async fn mock_session(shared: &Arc<Shared>) -> SshSession {
    let transport = ScriptedTransport {
        shared: Arc::clone(shared),
    };
    SshSession::connect_with(
        &transport,
        ConnectRequest::new("host", 22, "reaan", SshCredential::Password("pw".into())),
    )
    .await
    .expect("scripted session")
}

fn exec_ok(stdout: &str) -> ExecOutput {
    ExecOutput {
        exit_code: 0,
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
    }
}

fn exec_fail(code: u32, stderr: &str) -> ExecOutput {
    ExecOutput {
        exit_code: code,
        stdout: Vec::new(),
        stderr: stderr.as_bytes().to_vec(),
    }
}

/// Frame one SFTP packet body (`u32` length prefix).
fn frame(body: Vec<u8>) -> ChannelEvent {
    let mut framed = (body.len() as u32).to_be_bytes().to_vec();
    framed.extend(body);
    ChannelEvent::Data(framed)
}

fn sftp_init_reply() -> ChannelEvent {
    frame(vec![2, 0, 0, 0, 3])
}

fn sftp_handle_reply(id: u32, handle: &[u8]) -> ChannelEvent {
    let mut body = vec![102];
    body.extend(id.to_be_bytes());
    body.extend((handle.len() as u32).to_be_bytes());
    body.extend(handle);
    frame(body)
}

fn sftp_status(id: u32, code: u32, message: &str) -> ChannelEvent {
    let mut body = vec![101];
    body.extend(id.to_be_bytes());
    body.extend(code.to_be_bytes());
    body.extend((message.len() as u32).to_be_bytes());
    body.extend(message.as_bytes());
    body.extend(0u32.to_be_bytes());
    frame(body)
}

fn sftp_ok_sequence(writes: usize) -> Vec<ChannelEvent> {
    let mut events = vec![sftp_init_reply(), sftp_handle_reply(1, b"h1")];
    for index in 0..writes {
        events.push(sftp_status(index as u32 + 2, 0, "ok"));
    }
    events.push(sftp_status(writes as u32 + 2, 0, "ok"));
    events
}

fn http_response(status: u16, reason: &str, body: &str) -> ChannelEvent {
    let raw = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    ChannelEvent::Data(raw.into_bytes())
}

fn claim_response(device_id: &str) -> ChannelEvent {
    http_response(
        200,
        "OK",
        &format!(r#"{{"deviceId":"{device_id}","token":"device-token"}}"#),
    )
}

fn context_response(version: &str) -> ChannelEvent {
    http_response(
        200,
        "OK",
        &format!(r#"{{"remote":true,"version":"{version}"}}"#),
    )
}

/// Script the exec calls of one full happy-path run.
fn script_happy_exec(shared: &Shared, pid: u32) {
    shared.push_exec(exec_ok("Linux aarch64\n"));
    shared.push_exec(exec_ok("")); // backup copy
    shared.push_exec(exec_ok("")); // chmod +x
    shared.push_exec(exec_ok(&format!("{pid}\n"))); // detached start
}

/// Script the tunnel calls of one full happy-path run.
fn script_happy_tcp(shared: &Shared) {
    shared.push_tcp(TcpReply::Events(vec![])); // readiness probe
    shared.push_tcp(TcpReply::Events(vec![claim_response("dev-1")]));
    shared.push_tcp(TcpReply::Events(vec![context_response("0.6.2")]));
}

/// A binary plus its signed release manifest, signed by `release`.
fn signed_binary(release: &device_key::DeviceKeyPair, bytes: &[u8]) -> ReleaseManifest {
    let digest = sha256_hex(bytes);
    let signature = device_key::sign(&release.secret, digest.as_bytes()).expect("signable");
    ReleaseManifest {
        sha256: digest,
        signature: mobile_core::fingerprint::hex_lower(&signature),
    }
}

/// The exact string the core builds for a compound remote command: `sh -c` plus one
/// single-quoted script, with every inner quote escaped.
fn posix_command(script: &str) -> String {
    format!("sh -c '{}'", script.replace('\'', "'\\''"))
}

// --------------------------------------------------------------------------------------
// Step tests
// --------------------------------------------------------------------------------------

#[tokio::test]
async fn detect_host_maps_linux_and_darwin() {
    let script = shared();
    script.push_exec(exec_ok("Linux aarch64\n"));
    let session = mock_session(&script).await;
    let info = detect_host(&session).await.expect("detected");
    assert_eq!(info.os, "linux");
    assert_eq!(info.arch, "aarch64");
    assert_eq!(info.family, "unix");
    assert_eq!(script.commands(), vec!["uname -s -m".to_string()]);
    drop(session);

    let darwin = shared();
    darwin.push_exec(exec_ok("Darwin x86_64\n"));
    let session = mock_session(&darwin).await;
    let info = detect_host(&session).await.expect("detected");
    assert_eq!(info.os, "darwin");
    assert_eq!(info.arch, "x86_64");
}

#[tokio::test]
async fn detect_host_aliases_arm64_and_amd64() {
    let script = shared();
    script.push_exec(exec_ok("Linux arm64\n"));
    let info = detect_host(&mock_session(&script).await)
        .await
        .expect("aliased");
    assert_eq!(info.arch, "aarch64");

    let script = shared();
    script.push_exec(exec_ok("Linux amd64\n"));
    let info = detect_host(&mock_session(&script).await)
        .await
        .expect("aliased");
    assert_eq!(info.arch, "x86_64");
}

#[tokio::test]
async fn detect_host_rejects_unsupported_architectures_and_oses() {
    let script = shared();
    script.push_exec(exec_ok("Linux armv7l\n"));
    let error = detect_host(&mock_session(&script).await)
        .await
        .expect_err("unsupported");
    assert_eq!(error.kind(), "ssh");
    assert!(
        error
            .to_string()
            .contains("unsupported host architecture \"armv7l\""),
        "{error}"
    );

    let script = shared();
    script.push_exec(exec_ok("FreeBSD x86_64\n"));
    let error = detect_host(&mock_session(&script).await)
        .await
        .expect_err("unsupported");
    assert!(
        error
            .to_string()
            .contains("unsupported host OS \"FreeBSD\""),
        "{error}"
    );
}

#[tokio::test]
async fn detect_host_reports_uname_failures_verbatim() {
    let script = shared();
    script.push_exec(exec_fail(2, "uname: not found\n"));
    let error = detect_host(&mock_session(&script).await)
        .await
        .expect_err("uname failed");
    assert_eq!(error.kind(), "ssh");
    assert_eq!(
        error.to_string(),
        "ssh: uname -s -m failed with exit code 2: uname: not found"
    );

    let script = shared();
    script.push_exec(exec_ok("Linux\n"));
    let error = detect_host(&mock_session(&script).await)
        .await
        .expect_err("no machine type");
    assert!(
        error.to_string().contains("did not report a machine type"),
        "{error}"
    );
}

#[tokio::test]
async fn upload_daemon_backs_up_sftp_puts_and_chmods() {
    let script = shared();
    script.push_exec(exec_ok(""));
    script.push_exec(exec_ok(""));
    script.push_sftp(sftp_ok_sequence(2));
    let session = mock_session(&script).await;

    // Two chunks -> two WRITE packets and two status replies on top of open/close.
    let bytes = vec![7u8; 40_000];
    let result = upload_daemon(&session, &bytes, REMOTE_PATH)
        .await
        .expect("uploaded");
    assert_eq!(result.bytes_written, 40_000);
    assert_eq!(result.remote_path, REMOTE_PATH);

    let commands = script.commands();
    assert_eq!(commands.len(), 2, "{commands:?}");
    assert_eq!(
        commands[0],
        posix_command(&format!(
            "if [ -f '{REMOTE_PATH}' ]; then cp -f '{REMOTE_PATH}' '{REMOTE_PATH}'.prev; fi"
        ))
    );
    assert_eq!(
        commands[1],
        posix_command(&format!("chmod 755 '{REMOTE_PATH}'"))
    );

    let sftp = script.written_sftp();
    assert_eq!(sftp.len(), 5, "init + open + 2 writes + close");
    for (index, expected) in [1u8, 3, 6, 6, 4].into_iter().enumerate() {
        let body = &sftp[index];
        let length = u32::from_be_bytes(body[0..4].try_into().expect("length")) as usize;
        assert_eq!(length + 4, body.len(), "packet {index} framing");
        assert_eq!(body[4], expected, "packet {index} type");
    }
    // The OPEN packet names the quoted remote path.
    assert!(
        sftp[1]
            .windows(REMOTE_PATH.len())
            .any(|window| window == REMOTE_PATH.as_bytes()),
        "open packet must carry the remote path"
    );
}

#[tokio::test]
async fn upload_daemon_surfaces_sftp_rejection_with_its_status() {
    let script = shared();
    script.push_exec(exec_ok(""));
    script.push_sftp(vec![
        sftp_init_reply(),
        sftp_status(1, 3, "permission denied"),
    ]);
    let error = upload_daemon(&mock_session(&script).await, b"daemon", REMOTE_PATH)
        .await
        .expect_err("rejected");
    assert_eq!(error.kind(), "ssh");
    assert_eq!(
        error.to_string(),
        "ssh: sftp open failed with status 3: permission denied"
    );
    assert_eq!(script.commands().len(), 1, "no chmod after a failed upload");
}

#[tokio::test]
async fn upload_daemon_reports_an_sftp_channel_that_closes_early() {
    let script = shared();
    script.push_exec(exec_ok(""));
    let session = mock_session(&script).await;
    let error = upload_daemon(&session, b"daemon", REMOTE_PATH)
        .await
        .expect_err("no replies");
    assert!(
        error
            .to_string()
            .contains("closed the subsystem before replying"),
        "{error}"
    );
}

#[test]
fn verify_manifest_accepts_a_matching_checksum_and_signature() {
    let release = device_key::generate();
    let bytes = b"daemon-binary-bytes";
    let manifest = signed_binary(&release, bytes);

    let report = verify_manifest(&release.public_hex, bytes, &manifest).expect("verified");
    assert!(report.verified);
    assert_eq!(report.sha256, sha256_hex(bytes));
    assert_eq!(manifest.sha256, report.sha256);
}

#[test]
fn checksum_mismatch_aborts_before_any_signature_work() {
    let release = device_key::generate();
    let manifest = signed_binary(&release, b"daemon-binary-bytes");
    let error =
        verify_manifest(&release.public_hex, b"tampered-bytes", &manifest).expect_err("mismatch");
    assert_eq!(error.kind(), "crypto");
    assert!(error.to_string().contains("checksum mismatch"), "{error}");
    assert!(
        error.to_string().contains(&manifest.sha256),
        "the signed checksum must be named: {error}"
    );
}

#[test]
fn manifest_signature_must_come_from_the_release_key() {
    let release = device_key::generate();
    let other = device_key::generate();
    let bytes = b"daemon-binary-bytes";
    let manifest = signed_binary(&other, bytes);

    let error = verify_manifest(&release.public_hex, bytes, &manifest).expect_err("foreign key");
    assert_eq!(error.kind(), "crypto");
    assert!(
        error.to_string().contains("not signed by the release key"),
        "{error}"
    );

    let broken = ReleaseManifest {
        sha256: manifest.sha256,
        signature: "zz".to_string(),
    };
    let error = verify_manifest(&release.public_hex, bytes, &broken).expect_err("bad hex");
    assert!(error.to_string().contains("not hex"), "{error}");

    let short = ReleaseManifest {
        sha256: "abcd".to_string(),
        signature: manifest.signature,
    };
    let error = verify_manifest(&release.public_hex, bytes, &short).expect_err("short digest");
    assert!(error.to_string().contains("64-hex sha256"), "{error}");
}

#[test]
fn verify_release_signature_checks_the_bytes_themselves() {
    let release = device_key::generate();
    let payload = b"daemon-binary-bytes";
    let signature = device_key::sign(&release.secret, payload).expect("signable");
    let signature_hex = mobile_core::fingerprint::hex_lower(&signature);

    assert!(verify_release_signature(
        &release.public_hex,
        payload,
        &signature_hex
    ));
    assert!(!verify_release_signature(
        &release.public_hex,
        b"other-bytes",
        &signature_hex
    ));
    assert!(!verify_release_signature(
        &release.public_hex,
        payload,
        "not-hex"
    ));
    assert!(!verify_release_signature("nope", payload, &signature_hex));
}

// --------------------------------------------------------------------------------------
// The provisioning registry binds upload -> verify -> start
// --------------------------------------------------------------------------------------

/// Script and run one upload of `bytes` to `path`, returning the session that did it.
async fn upload_for(script: &Arc<Shared>, path: &str, bytes: &[u8]) -> SshSession {
    script.push_exec(exec_ok("")); // backup copy
    script.push_exec(exec_ok("")); // chmod +x
    script.push_sftp(sftp_ok_sequence(1));
    let session = mock_session(script).await;
    upload_daemon(&session, bytes, path).await.expect("uploaded");
    session
}

/// Assert `start` refused because these bytes were never verified, and that the host ran
/// nothing for the refused start (`uploaded_commands` is what the uploads themselves ran).
fn assert_unverified(
    error: mobile_core::CoreError,
    path: &str,
    script: &Shared,
    uploaded_commands: usize,
) {
    assert_eq!(error.kind(), "ssh");
    let message = error.to_string();
    assert!(
        message.contains("was not verified by this process"),
        "{message}"
    );
    assert!(message.contains(path), "the message must name the path: {message}");
    let commands = script.commands();
    assert!(
        !commands.iter().any(|command| command.contains("nohup")),
        "a refused start must not execute anything: {commands:?}"
    );
    assert_eq!(commands.len(), uploaded_commands, "{commands:?}");
}

#[tokio::test]
async fn start_refuses_a_path_that_was_uploaded_but_never_verified() {
    // Every registry test uses its own remote path: the registry is process-wide and the
    // offline suite runs these tests in parallel.
    let path = "/tmp/gc-provision-registry/never-verified/daemon";
    let script = shared();
    let session = upload_for(&script, path, &[0xa1u8; 64]).await;

    let error = start_daemon(&session, path, 43722)
        .await
        .expect_err("an unverified upload must not start");
    assert_unverified(error, path, &script, 2);
}

#[tokio::test]
async fn verifying_different_bytes_does_not_authorize_the_uploaded_path() {
    let path = "/tmp/gc-provision-registry/other-bytes/daemon";
    let release = device_key::generate();
    let script = shared();
    let session = upload_for(&script, path, &[0xb2u8; 64]).await;

    // A legitimate, correctly signed *other* payload: verifying it must authorize nothing.
    let other = vec![0xb3u8; 48];
    let manifest = signed_binary(&release, &other);
    let report = verify_manifest(&release.public_hex, &other, &manifest).expect("other verified");
    assert!(report.verified);

    let error = start_daemon(&session, path, 43722)
        .await
        .expect_err("verifying other bytes must not authorize the upload");
    assert_unverified(error, path, &script, 2);
}

#[tokio::test]
async fn start_runs_a_path_whose_uploaded_bytes_were_verified() {
    let path = "/tmp/gc-provision-registry/verified/daemon";
    let release = device_key::generate();
    let binary = vec![0xc3u8; 96];
    let manifest = signed_binary(&release, &binary);

    let script = shared();
    let session = upload_for(&script, path, &binary).await;
    script.push_exec(exec_ok("6060\n")); // detached start
    script.push_tcp(TcpReply::Events(vec![])); // readiness probe answers

    verify_manifest(&release.public_hex, &binary, &manifest).expect("verified");
    // Verifying twice is idempotent and keeps the path startable.
    verify_manifest(&release.public_hex, &binary, &manifest).expect("still verified");

    let started = start_daemon(&session, path, 43722)
        .await
        .expect("a verified upload starts");
    assert_eq!(started.pid, 6060);
    assert_eq!(started.port, 43722);

    let commands = script.commands();
    assert_eq!(commands.len(), 3, "{commands:?}");
    assert!(commands[2].starts_with("sh -c 'nohup "), "{}", commands[2]);
}

#[tokio::test]
async fn re_uploading_after_verification_returns_the_path_to_unverified() {
    let path = "/tmp/gc-provision-registry/re-uploaded/daemon";
    let release = device_key::generate();
    let binary = vec![0xd4u8; 72];
    let manifest = signed_binary(&release, &binary);

    let script = shared();
    let session = upload_for(&script, path, &binary).await;

    verify_manifest(&release.public_hex, &binary, &manifest).expect("verified");
    // The bytes on the host were rewritten, so the earlier verification no longer covers them.
    upload_for(&script, path, &binary).await;

    let error = start_daemon(&session, path, 43722)
        .await
        .expect_err("a re-upload is unverified again");
    assert_unverified(error, path, &script, 4);
}

#[tokio::test]
async fn start_reports_the_detached_pid_and_port() {
    let script = shared();
    script.push_exec(exec_ok("4242\n"));
    script.push_tcp(TcpReply::Events(vec![]));
    let session = mock_session(&script).await;

    let result = start_daemon_with_timeout(
        &session,
        REMOTE_PATH,
        43722,
        std::time::Duration::from_millis(50),
    )
    .await
    .expect("started");
    assert_eq!(result.pid, 4242);
    assert_eq!(result.port, 43722);
    assert_eq!(
        script.commands(),
        vec![posix_command(&format!(
            "nohup '{REMOTE_PATH}' >/dev/null 2>&1 </dev/null & echo $!"
        ))]
    );
}

#[tokio::test]
async fn start_timeout_reports_and_rollback_restores_the_previous_binary() {
    let script = shared();
    script.push_exec(exec_ok("700\n"));
    for _ in 0..4 {
        script.push_tcp(TcpReply::Failure("connection refused".to_string()));
    }
    script.push_exec(exec_ok("")); // kill -TERM of the pid that never answered
    script.push_exec(exec_fail(1, "")); // kill -0: the pid is gone
    script.push_exec(exec_ok("")); // rollback mv

    let session = mock_session(&script).await;
    let error = start_daemon_with_timeout(
        &session,
        REMOTE_PATH,
        43722,
        std::time::Duration::from_millis(60),
    )
    .await
    .expect_err("never answered");
    assert_eq!(error.kind(), "ssh");
    assert!(
        error
            .to_string()
            .contains("daemon pid 700 did not answer on 127.0.0.1:43722"),
        "{error}"
    );

    let restored = rollback(&session, REMOTE_PATH).await.expect("rolled back");
    assert_eq!(restored.remote_path, REMOTE_PATH);
    assert_eq!(
        restored.restored_from,
        "/home/reaan/.gentle-movil/daemon.prev"
    );
    let commands = script.commands();
    assert_eq!(commands[1], posix_command("kill -TERM 700"));
    assert_eq!(commands[2], posix_command("kill -0 700"));
    assert!(
        commands[3].contains("mv -f") && commands[3].contains("daemon.prev"),
        "{}",
        commands[3]
    );
}

#[tokio::test]
async fn start_timeout_terminates_the_exact_pid_it_started() {
    let script = shared();
    script.push_exec(exec_ok("700\n"));
    script.push_tcp(TcpReply::Failure("connection refused".to_string()));
    script.push_tcp(TcpReply::Failure("connection refused".to_string()));
    script.push_exec(exec_ok("")); // kill -TERM 700
    script.push_exec(exec_fail(1, "")); // kill -0: the pid is gone
    let session = mock_session(&script).await;
    let error =
        start_daemon_with_timeout(&session, REMOTE_PATH, 43722, Duration::from_millis(50))
            .await
            .expect_err("never answered");
    assert!(error.to_string().contains("pid 700 was terminated"), "{error}");
    assert_eq!(script.commands()[1], posix_command("kill -TERM 700"));
    assert_eq!(script.commands()[2], posix_command("kill -0 700"));
}

#[tokio::test]
async fn a_pid_that_survives_sigterm_is_reported_as_unconfirmed() {
    let script = shared();
    script.push_exec(exec_ok("700\n"));
    script.push_tcp(TcpReply::Failure("connection refused".to_string()));
    // SIGTERM lands and every `kill -0` succeeds: the daemon ignores TERM and keeps running.
    for _ in 0..48 {
        script.push_exec(exec_ok(""));
    }
    let session = mock_session(&script).await;
    let error = start_daemon_with_timeout(&session, REMOTE_PATH, 43722, Duration::from_millis(50))
        .await
        .expect_err("never answered")
        .to_string();
    assert!(
        error.contains("did not exit within") && error.contains("may still be running"),
        "a surviving pid must be named: {error}"
    );
    assert!(!error.contains("was terminated"), "{error}");
    let probe = posix_command("kill -0 700");
    let commands = script.commands();
    assert_eq!(commands[1], posix_command("kill -TERM 700"));
    assert!(
        commands.len() > 2 && commands[2..].iter().all(|command| *command == probe),
        "the poll must only probe the exact pid: {commands:?}"
    );
}

#[tokio::test]
async fn start_readiness_window_expires_while_a_channel_open_stalls() {
    let script = shared();
    script.push_exec(exec_ok("700\n"));
    script.push_tcp(TcpReply::Stall);
    script.push_exec(exec_fail(1, "no such process\n"));
    let session = mock_session(&script).await;
    let window = Duration::from_secs(1);
    let started = std::time::Instant::now();
    let stalled = start_daemon_with_timeout(&session, REMOTE_PATH, 43722, window);
    let outcome = tokio::time::timeout(Duration::from_secs(5), stalled)
        .await
        .expect("the readiness window must expire even when the channel open stalls");
    let elapsed = started.elapsed();
    let message = outcome.expect_err("no daemon answered").to_string();
    assert!(
        message.contains("the channel open never completed")
            && message.contains("terminating pid 700 failed"),
        "{message}"
    );
    // The stalled open consumed the whole window, so the recorded sequence is exactly the
    // start and the kill: no probe step after it.
    assert_eq!(script.commands().len(), 2, "{:?}", script.commands());
    // And no sleep on the stale pre-await `remaining`, which would add up to
    // START_PROBE_INTERVAL of overshoot past the window.
    assert!(
        elapsed < window + Duration::from_millis(180),
        "the timeout must return at the window, not after a stale sleep: {elapsed:?}"
    );
    assert_eq!(script.commands()[1], posix_command("kill -TERM 700"));
}

#[tokio::test]
async fn a_stalled_kill_still_returns_the_timeout_error_bounded() {
    let script = shared();
    script.push_exec(exec_ok("700\n"));
    script.push_tcp(TcpReply::Failure("connection refused".to_string()));
    script.stall_exec_containing("kill -TERM"); // the kill itself never completes
    let session = mock_session(&script).await;
    let started = std::time::Instant::now();
    let stalled = start_daemon_with_timeout(&session, REMOTE_PATH, 43722, Duration::from_millis(60));
    let outcome = tokio::time::timeout(Duration::from_secs(10), stalled)
        .await
        .expect("a stalled kill must not hang the timeout path");
    let message = outcome.expect_err("no daemon answered").to_string();
    assert!(
        message.contains("daemon pid 700 did not answer on 127.0.0.1:43722"),
        "{message}"
    );
    assert!(
        message.contains("termination could not be confirmed"),
        "the message must stay honest when the kill stalls: {message}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the bounded kill must return promptly: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn rollback_reports_a_host_without_a_backup() {
    let script = shared();
    script.push_exec(exec_fail(3, ""));
    let error = rollback(&mock_session(&script).await, REMOTE_PATH)
        .await
        .expect_err("nothing to restore");
    assert!(
        error.to_string().contains("no previous daemon binary"),
        "{error}"
    );
}

#[tokio::test]
async fn start_reports_a_start_that_printed_no_pid() {
    let script = shared();
    script.push_exec(exec_ok("garbage\n"));
    let error = start_daemon_with_timeout(
        &mock_session(&script).await,
        REMOTE_PATH,
        43722,
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("no pid");
    assert!(
        error.to_string().contains("did not report a pid"),
        "{error}"
    );
}

#[tokio::test]
async fn register_device_posts_the_claim_and_reads_the_version() {
    let script = shared();
    script.push_tcp(TcpReply::Events(vec![claim_response("dev-1")]));
    script.push_tcp(TcpReply::Events(vec![context_response("0.6.2")]));
    let session = mock_session(&script).await;

    let registration = register_device_with_timeout(
        &session,
        DEVICE_PUBKEY,
        INVITE,
        "Phone",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect("registered");
    assert_eq!(registration.device_id, "dev-1");
    assert_eq!(registration.daemon_version, "0.6.2");

    let writes = script.written_tcp();
    assert_eq!(writes.len(), 2);
    let claim = String::from_utf8(writes[0].clone()).expect("request text");
    assert!(
        claim.starts_with("POST /api/pairing/claim HTTP/1.1\r\n"),
        "{claim}"
    );
    assert!(
        claim.contains("Origin: http://127.0.0.1:43722\r\n"),
        "the daemon's device surface refuses a POST without its origin: {claim}"
    );
    assert!(claim.contains(r#""deviceName":"Phone""#), "{claim}");
    assert!(
        claim.contains(&format!(r#""invite":"{INVITE}""#)),
        "{claim}"
    );
    assert!(
        claim.contains(&format!(r#""ed25519PublicKey":"{DEVICE_PUBKEY}""#)),
        "§2.3 sends the device public key: {claim}"
    );
    let context = String::from_utf8(writes[1].clone()).expect("request text");
    assert!(
        context.starts_with("GET /api/context HTTP/1.1\r\n"),
        "{context}"
    );
}

#[tokio::test]
async fn register_failure_surfaces_the_ssh_kind_and_the_status() {
    let script = shared();
    script.push_tcp(TcpReply::Events(vec![http_response(
        401,
        "Unauthorized",
        r#"{"error":"Pairing invitation is invalid or already used."}"#,
    )]));
    let error = register_device_with_timeout(
        &mock_session(&script).await,
        DEVICE_PUBKEY,
        INVITE,
        "Phone",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("rejected");
    assert_eq!(error.kind(), "ssh");
    assert!(
        error.to_string().contains("registration with HTTP 401"),
        "{error}"
    );
    assert!(
        error.to_string().contains("already used"),
        "the daemon body must reach the UI log: {error}"
    );
}

#[tokio::test]
async fn register_validates_the_device_key_and_the_name() {
    let script = shared();
    let session = mock_session(&script).await;

    let error = register_device_with_timeout(
        &session,
        "abcd",
        INVITE,
        "Phone",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("short key");
    assert_eq!(error.kind(), "crypto");
    assert!(error.to_string().contains("must be 32 bytes"), "{error}");

    let error = register_device_with_timeout(
        &session,
        DEVICE_PUBKEY,
        INVITE,
        "   ",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("empty name");
    assert_eq!(error.kind(), "ssh");
    assert!(error.to_string().contains("1-80 characters"), "{error}");

    let error = register_device_with_timeout(
        &session,
        DEVICE_PUBKEY,
        "  ",
        "Phone",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("empty token");
    assert!(error.to_string().contains("invite token"), "{error}");
}

#[tokio::test]
async fn register_reports_a_daemon_that_does_not_answer() {
    let script = shared();
    script.push_tcp(TcpReply::Failure("no route to host".to_string()));
    let error = register_device_with_timeout(
        &mock_session(&script).await,
        DEVICE_PUBKEY,
        INVITE,
        "Phone",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("no tunnel");
    assert!(
        error
            .to_string()
            .contains("cannot open the daemon tunnel on 127.0.0.1:43722"),
        "{error}"
    );
}

#[tokio::test]
async fn full_happy_path_runs_detect_upload_verify_start_register_in_order() {
    let script = shared();
    let release = device_key::generate();
    let binary = vec![9u8; 1024];
    let manifest = signed_binary(&release, &binary);

    script_happy_exec(&script, 5150);
    script.push_sftp(sftp_ok_sequence(1));
    script_happy_tcp(&script);

    let session = mock_session(&script).await;

    let host = detect_host(&session).await.expect("detect");
    assert_eq!((host.os.as_str(), host.arch.as_str()), ("linux", "aarch64"));

    let upload = upload_daemon(&session, &binary, REMOTE_PATH)
        .await
        .expect("upload");
    assert_eq!(upload.bytes_written, 1024);

    let report = verify_manifest(&release.public_hex, &binary, &manifest).expect("verify");
    assert_eq!(report.sha256, manifest.sha256);

    let start = start_daemon_with_timeout(
        &session,
        REMOTE_PATH,
        43722,
        std::time::Duration::from_millis(50),
    )
    .await
    .expect("start");
    assert_eq!(start.pid, 5150);

    let registration = register_device_with_timeout(
        &session,
        DEVICE_PUBKEY,
        INVITE,
        "Phone",
        std::time::Duration::from_millis(50),
    )
    .await
    .expect("register");
    assert_eq!(registration.device_id, "dev-1");
    assert_eq!(registration.daemon_version, "0.6.2");

    let commands = script.commands();
    assert_eq!(commands.len(), 4, "{commands:?}");
    assert_eq!(commands[0], "uname -s -m");
    assert!(commands[1].contains("cp -f"), "{}", commands[1]);
    assert_eq!(
        commands[2],
        posix_command(&format!("chmod 755 '{REMOTE_PATH}'"))
    );
    assert!(commands[3].starts_with("sh -c 'nohup "), "{}", commands[3]);

    // The upload happened before the start, and the daemon was verified before both.
    assert_eq!(script.written_sftp().len(), 4);
    // Two tunnel writes: the registration claim and the version query. The readiness
    // probe only opens and closes a channel, it writes nothing.
    assert_eq!(script.written_tcp().len(), 2);
}

#[tokio::test]
async fn a_bad_checksum_stops_the_sequence_before_start() {
    let script = shared();
    let release = device_key::generate();
    let uploaded = vec![1u8; 64];
    let manifest = signed_binary(&release, &[2u8; 64]);

    script_happy_exec(&script, 5150);
    script.push_sftp(sftp_ok_sequence(1));

    let session = mock_session(&script).await;
    detect_host(&session).await.expect("detect");
    upload_daemon(&session, &uploaded, REMOTE_PATH)
        .await
        .expect("upload");
    let error = verify_manifest(&release.public_hex, &uploaded, &manifest).expect_err("mismatch");
    assert_eq!(error.kind(), "crypto");

    let commands = script.commands();
    assert!(
        !commands.iter().any(|command| command.starts_with("nohup ")),
        "verification must abort before any start: {commands:?}"
    );
}

// --------------------------------------------------------------------------------------
// C ABI tests
// --------------------------------------------------------------------------------------

/// Call a `gc_*` JSON function and decode its answer, releasing the string.
fn call_json(pointer: *mut std::ffi::c_char) -> serde_json::Value {
    assert!(
        !pointer.is_null(),
        "the ABI must never return a null string"
    );
    // SAFETY: the pointer is a live CString owned by the caller (this test), and it is
    // freed right after the copy.
    let text = unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .expect("the ABI returns UTF-8 JSON")
        .to_string();
    // SAFETY: `pointer` is the live allocation just decoded above and is freed once here.
    unsafe { cabi::gc_free(pointer) };
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("not JSON ({error}): {text}"))
}

/// Serializes the ABI tests: the facade is process-wide, so a test that installs a scripted
/// transport must not run while another test is driving the same registry.
static ABI_LOCK: Mutex<()> = Mutex::new(());

fn abi_guard() -> std::sync::MutexGuard<'static, ()> {
    match ABI_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[test]
fn abi_version_is_the_documented_constant() {
    let _guard = abi_guard();
    assert_eq!(cabi::gc_abi_version(), 1);
    assert_eq!(cabi::ABI_VERSION, 1);
}

#[test]
fn pair_from_qr_round_trips_through_the_c_abi() {
    let _guard = abi_guard();
    let uri = format!(
        "gc://pair?v=1&host=192.168.1.42&port=2222&user=reaan&token=inv_7Qp2&fp={FP}&proto=1"
    );
    let c_uri = CString::new(uri).expect("no NUL");
    let answer = call_json(cabi::gc_pair_from_qr(c_uri.as_ptr()));
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["pair"]["host"], "192.168.1.42");
    assert_eq!(answer["pair"]["port"], 2222);
    assert_eq!(answer["pair"]["user"], "reaan");
    assert_eq!(answer["pair"]["fingerprint"], FP);
}

#[test]
fn pair_from_qr_errors_and_null_pointers_use_the_error_envelope() {
    let _guard = abi_guard();
    let bad = CString::new("not-a-uri").expect("no NUL");
    let answer = call_json(cabi::gc_pair_from_qr(bad.as_ptr()));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"]["kind"], "invalid_qr");
    assert_eq!(
        answer["error"]["message"],
        "invalid pairing QR: missing gc:// scheme"
    );

    let answer = call_json(cabi::gc_pair_from_qr(std::ptr::null()));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"]["kind"], "input");
    assert!(answer["error"]["message"]
        .as_str()
        .expect("message")
        .contains("null"));
}

#[test]
fn device_key_generate_returns_the_pair_through_the_c_abi() {
    let _guard = abi_guard();
    let answer = call_json(cabi::gc_device_key_generate());
    assert_eq!(answer["ok"], true);
    let public_hex = answer["key"]["public_hex"].as_str().expect("public key");
    assert_eq!(public_hex.len(), 64);
    let seed = answer["key"]["secret"]["secret_seed"]
        .as_array()
        .expect("seed bytes");
    assert_eq!(seed.len(), 32);
    assert_eq!(
        mobile_core::device_key::public_hex_from_secret(&mobile_core::StoredKey {
            secret_seed: seed
                .iter()
                .map(|value| value.as_u64().expect("byte") as u8)
                .collect(),
        })
        .expect("derivable"),
        public_hex
    );
}

#[test]
fn provision_step_rejects_unknown_sessions_and_malformed_steps() {
    let _guard = abi_guard();
    let step = CString::new(r#"{"step":"detect"}"#).expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(999, step.as_ptr()));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"]["kind"], "ssh");
    assert_eq!(answer["error"]["message"], "ssh: unknown session id 999");

    let bad = CString::new(r#"{"step":"teleport"}"#).expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(1, bad.as_ptr()));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"]["kind"], "input");
    assert!(answer["error"]["message"]
        .as_str()
        .expect("message")
        .contains("unknown variant"));
}

#[test]
fn c_abi_drives_the_whole_provisioning_sequence() {
    let _guard = abi_guard();
    let script = shared();
    let release = device_key::generate();
    let binary = vec![3u8; 512];
    let manifest = signed_binary(&release, &binary);

    script_happy_exec(&script, 9191);
    script.push_sftp(sftp_ok_sequence(1));
    script_happy_tcp(&script);
    // The last step of the test asks for a rollback on a host without a backup.
    script.push_exec(exec_fail(3, ""));
    cabi::install_test_transport(Arc::new(ScriptedTransport {
        shared: Arc::clone(&script),
    }));

    let config = CString::new(
        r#"{"host":"host","port":22,"user":"reaan","credential":{"kind":"password","value":"pw"}}"#,
    )
    .expect("no NUL");
    let connected = call_json(cabi::gc_ssh_connect(config.as_ptr()));
    assert_eq!(connected["ok"], true);
    let session_id = connected["sessionId"].as_u64().expect("session id");

    let detect = CString::new(r#"{"step":"detect"}"#).expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, detect.as_ptr()));
    assert_eq!(answer["step"], "detect");
    assert_eq!(answer["result"]["os"], "linux");
    assert_eq!(answer["result"]["arch"], "aarch64");

    let upload = CString::new(format!(
        r#"{{"step":"upload","remotePath":"{ABI_REMOTE_PATH}","dataHex":"{}"}}"#,
        mobile_core::fingerprint::hex_lower(&binary)
    ))
    .expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, upload.as_ptr()));
    assert_eq!(answer["step"], "upload");
    assert_eq!(answer["result"]["bytes_written"], 512);

    let verify = CString::new(
        serde_json::json!({
            "step": "verify",
            "releasePubkeyHex": release.public_hex,
            "dataHex": mobile_core::fingerprint::hex_lower(&binary),
            "manifest": manifest,
        })
        .to_string(),
    )
    .expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, verify.as_ptr()));
    assert_eq!(answer["step"], "verify");
    assert_eq!(answer["result"]["verified"], true);
    assert_eq!(answer["result"]["sha256"], manifest.sha256);

    let start = CString::new(format!(
        r#"{{"step":"start","remotePath":"{ABI_REMOTE_PATH}","port":43722}}"#
    ))
    .expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, start.as_ptr()));
    assert_eq!(answer["result"]["pid"], 9191);
    assert_eq!(answer["result"]["port"], 43722);

    let register = CString::new(format!(
        r#"{{"step":"register","devicePubkeyHex":"{DEVICE_PUBKEY}","inviteToken":"{INVITE}","deviceName":"Phone"}}"#
    ))
    .expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, register.as_ptr()));
    assert_eq!(answer["result"]["device_id"], "dev-1");
    assert_eq!(answer["result"]["daemon_version"], "0.6.2");

    let rollback = CString::new(format!(
        r#"{{"step":"rollback","remotePath":"{ABI_REMOTE_PATH}"}}"#
    ))
    .expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, rollback.as_ptr()));
    assert_eq!(answer["ok"], false, "the mock reports no backup to restore");
    assert_eq!(answer["error"]["kind"], "ssh");
    assert_eq!(
        answer["error"]["message"],
        "ssh: cannot roll back: the host has no previous daemon binary at /home/reaan/.gentle-movil/daemon-abi.prev"
    );
}

#[test]
fn c_abi_reports_a_bad_verify_as_a_crypto_error() {
    let _guard = abi_guard();
    let script = shared();
    let release = device_key::generate();
    let manifest = signed_binary(&release, &[5u8; 32]);
    cabi::install_test_transport(Arc::new(ScriptedTransport {
        shared: Arc::clone(&script),
    }));

    let config = CString::new(
        r#"{"host":"host","user":"reaan","credential":{"kind":"password","value":"pw"}}"#,
    )
    .expect("no NUL");
    let session_id = call_json(cabi::gc_ssh_connect(config.as_ptr()))["sessionId"]
        .as_u64()
        .expect("session id");

    let verify = CString::new(
        serde_json::json!({
            "step": "verify",
            "releasePubkeyHex": release.public_hex,
            "dataHex": mobile_core::fingerprint::hex_lower(&[4u8; 32]),
            "manifest": manifest,
        })
        .to_string(),
    )
    .expect("no NUL");
    let answer = call_json(cabi::gc_provision_step(session_id, verify.as_ptr()));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"]["kind"], "crypto");
    assert!(answer["error"]["message"]
        .as_str()
        .expect("message")
        .contains("checksum mismatch"));
}

// --------------------------------------------------------------------------------------
// The pivot flow (S4/S5/S7): connect reports the host key, detect/register run the
// commands the TS flow composes, and tunnel opens the forwards it asks for.
// --------------------------------------------------------------------------------------

/// Loopback probe shaped like `loopbackProbeScript` in `mobile/lib/provision.ts`: POSIX
/// constructs plus a single-quoted format, so the core must run it through `sh -c`.
const PROBE_SCRIPT: &str =
    "_found=\"\"\nfor _port in 43721 43722; do\n  printf '%s\\n' \"$_port\"\ndone";

/// `authorized_keys` line the phone installs, exactly as `mobile/lib/provision.ts` composes it.
const AUTHORIZED_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABQ gentle-movil";

/// `authorized_keys` install shaped like `authorizedKeysScript` in `mobile/lib/provision.ts`.
const REGISTER_SCRIPT: &str = "umask 077\nmkdir -p \"$HOME/.ssh\"\ntouch \"$HOME/.ssh/authorized_keys\"\ngrep -qxF 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABQ gentle-movil' \"$HOME/.ssh/authorized_keys\" || printf '%s\\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABQ gentle-movil' >> \"$HOME/.ssh/authorized_keys\"";

/// Install the scripted transport in the process-wide facade and open one session.
fn abi_connect_answer(script: &Arc<Shared>) -> serde_json::Value {
    cabi::install_test_transport(Arc::new(ScriptedTransport {
        shared: Arc::clone(script),
    }));
    let config = CString::new(
        r#"{"host":"host","port":22,"user":"reaan","credential":{"kind":"password","value":"pw"}}"#,
    )
    .expect("no NUL");
    call_json(cabi::gc_ssh_connect(config.as_ptr()))
}

/// Same as [`abi_connect_answer`], reduced to the session id the next steps need.
fn abi_connect(script: &Arc<Shared>) -> u64 {
    let answer = abi_connect_answer(script);
    assert_eq!(answer["ok"], true, "{answer}");
    answer["sessionId"].as_u64().expect("session id")
}

/// One `gc_provision_step` call from a JSON payload, releasing the answer.
fn provision_step(session_id: u64, payload: serde_json::Value) -> serde_json::Value {
    let step = CString::new(payload.to_string()).expect("no NUL");
    call_json(cabi::gc_provision_step(session_id, step.as_ptr()))
}

#[test]
fn connect_reports_the_host_fingerprint_the_handshake_saw() {
    let _guard = abi_guard();
    let script = shared();
    let connected = abi_connect_answer(&script);

    assert_eq!(connected["ok"], true, "{connected}");
    // The pivot flow reads the session and the fingerprint from the `result` record.
    assert_eq!(connected["sessionId"], connected["result"]["sessionId"]);
    assert_eq!(connected["result"]["sessionId"], 1);
    assert_eq!(connected["result"]["fingerprint"], FP);
    let fingerprint = connected["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint");
    assert_eq!(fingerprint.len(), 64);
    assert!(
        fingerprint
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character)),
        "the fingerprint must be lowercase hex: {fingerprint}"
    );
}

#[test]
fn connect_normalizes_the_reported_fingerprint_to_lowercase_hex() {
    let _guard = abi_guard();
    let script = shared();
    *script.fingerprint.lock().expect("fingerprint") =
        mobile_core::fingerprint::with_colons(&FP.to_ascii_uppercase());

    // Same shape `provision.ts` normalizes: no `SHA256:` prefix, no separators, lowercase.
    let connected = abi_connect_answer(&script);
    assert_eq!(connected["result"]["fingerprint"], FP);
}

#[test]
fn connect_omits_the_fingerprint_when_the_handshake_reported_none() {
    let _guard = abi_guard();
    let script = shared();
    script.fingerprint.lock().expect("fingerprint").clear();

    let connected = abi_connect_answer(&script);
    assert_eq!(connected["ok"], true, "{connected}");
    assert_eq!(connected["result"]["sessionId"], 1);
    assert!(
        connected["result"].get("fingerprint").is_none(),
        "no key was reported, so no value may be invented: {connected}"
    );
}

#[test]
fn detect_step_without_a_command_still_detects_the_host() {
    // PRESERVE: the pre-pivot `detect` (no `command`) keeps answering HostInfo unchanged.
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_exec(exec_ok("Linux aarch64\n"));

    let answer = provision_step(
        session_id,
        serde_json::json!({ "sessionId": session_id, "step": "detect" }),
    );

    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["result"]["os"], "linux");
    assert_eq!(answer["result"]["arch"], "aarch64");
    assert_eq!(answer["result"]["family"], "unix");
    assert_eq!(script.commands(), vec!["uname -s -m".to_string()]);
}

#[test]
fn detect_step_runs_the_probe_command_the_flow_sent() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_exec(exec_ok(" 43721 43722\n"));

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "detect",
            "ports": [43721, 43722],
            "command": PROBE_SCRIPT,
        }),
    );

    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["step"], "detect");
    assert_eq!(answer["result"]["exit_code"], 0);
    assert_eq!(answer["result"]["stdout"], " 43721 43722\n");
    assert_eq!(answer["result"]["stderr"], "");
    assert_eq!(script.commands(), vec![posix_command(PROBE_SCRIPT)]);
}

#[test]
fn detect_step_fails_honestly_when_the_probe_exits_nonzero() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_exec(ExecOutput {
        exit_code: 1,
        stdout: b" 43721\n".to_vec(),
        stderr: b"43722 refused\n".to_vec(),
    });

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "detect",
            "ports": [43721, 43722],
            "command": PROBE_SCRIPT,
        }),
    );

    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["error"]["kind"], "ssh");
    let message = answer["error"]["message"].as_str().expect("message");
    assert!(
        message.contains("detect failed with exit code 1"),
        "the exit code must reach the log: {message}"
    );
    assert!(
        message.contains("43722 refused"),
        "the command output must reach the log: {message}"
    );
    // Only the probe ran: register/tunnel must not follow a failed detect.
    assert_eq!(script.commands(), vec![posix_command(PROBE_SCRIPT)]);
    assert!(script.tcp_targets().is_empty());
}

#[test]
fn register_step_runs_the_authorized_keys_script_the_flow_sent() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_exec(exec_ok(""));

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "register",
            "devicePubkeyHex": DEVICE_PUBKEY,
            "authorizedKey": AUTHORIZED_KEY,
            "deviceName": "Gentle Movil",
            "command": REGISTER_SCRIPT,
        }),
    );

    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["step"], "register");
    assert_eq!(answer["result"]["exit_code"], 0);
    assert_eq!(script.commands(), vec![posix_command(REGISTER_SCRIPT)]);
}

#[test]
fn register_step_accepts_the_script_field_as_the_command() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_exec(exec_ok(""));

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "register",
            "devicePubkeyHex": DEVICE_PUBKEY,
            "deviceName": "Gentle Movil",
            "script": REGISTER_SCRIPT,
        }),
    );

    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(script.commands(), vec![posix_command(REGISTER_SCRIPT)]);
}

#[test]
fn register_step_without_a_command_or_daemon_fields_is_rejected() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "register",
            "devicePubkeyHex": DEVICE_PUBKEY,
            "authorizedKey": AUTHORIZED_KEY,
            "deviceName": "Gentle Movil",
        }),
    );

    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["error"]["kind"], "input");
    let message = answer["error"]["message"].as_str().expect("message");
    assert!(
        message.contains("command") && message.contains("inviteToken"),
        "the rejection must name both accepted shapes: {message}"
    );
    assert!(script.commands().is_empty(), "nothing may run for a refused step");
}

#[test]
fn tunnel_step_opens_every_forward_and_reports_the_channels() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_tcp(TcpReply::Events(vec![]));
    script.push_tcp(TcpReply::Events(vec![]));

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "tunnel",
            "forwards": [
                { "host": "127.0.0.1", "port": 43721 },
                { "host": "127.0.0.1", "port": 43722 },
            ],
        }),
    );

    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["step"], "tunnel");
    let forwards = answer["result"]["forwards"].as_array().expect("forwards");
    assert_eq!(forwards.len(), 2, "{forwards:?}");
    assert_eq!(forwards[0]["host"], "127.0.0.1");
    assert_eq!(forwards[0]["port"], 43721);
    assert_eq!(forwards[1]["host"], "127.0.0.1");
    assert_eq!(forwards[1]["port"], 43722);
    let first = forwards[0]["channel_id"].as_u64().expect("channel id");
    let second = forwards[1]["channel_id"].as_u64().expect("channel id");
    assert!(first > 0 && second > first, "{forwards:?}");
    // The forwards really were opened on the requested loopback ports, in order.
    assert_eq!(
        script.tcp_targets(),
        vec![
            ("127.0.0.1".to_string(), 43721),
            ("127.0.0.1".to_string(), 43722),
        ]
    );
}

#[test]
fn tunnel_step_reports_a_forward_that_cannot_open() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);
    script.push_tcp(TcpReply::Failure("administratively prohibited".to_string()));

    let answer = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "tunnel",
            "forwards": [{ "host": "127.0.0.1", "port": 43721 }],
        }),
    );

    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["error"]["kind"], "ssh");
    assert!(
        answer["error"]["message"]
            .as_str()
            .expect("message")
            .contains("administratively prohibited"),
        "{answer}"
    );
    assert_eq!(script.tcp_targets().len(), 1);
}

#[test]
fn tunnel_step_rejects_a_payload_with_no_usable_forward() {
    let _guard = abi_guard();
    let script = shared();
    let session_id = abi_connect(&script);

    let empty = provision_step(
        session_id,
        serde_json::json!({ "sessionId": session_id, "step": "tunnel", "forwards": [] }),
    );
    assert_eq!(empty["ok"], false, "{empty}");
    assert_eq!(empty["error"]["kind"], "input");
    assert!(
        empty["error"]["message"]
            .as_str()
            .expect("message")
            .contains("at least one forward"),
        "{empty}"
    );

    let zero = provision_step(
        session_id,
        serde_json::json!({
            "sessionId": session_id,
            "step": "tunnel",
            "forwards": [{ "host": "127.0.0.1", "port": 0 }],
        }),
    );
    assert_eq!(zero["ok"], false, "{zero}");
    assert_eq!(zero["error"]["kind"], "ssh");
    assert!(
        zero["error"]["message"]
            .as_str()
            .expect("message")
            .contains("1..=65535"),
        "{zero}"
    );
    assert!(
        script.tcp_targets().is_empty(),
        "a refused tunnel must not open a channel"
    );
}
