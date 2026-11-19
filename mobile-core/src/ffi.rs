//! FFI-ready facade: the frozen surface of `docs/mobile-protocol-spec.md` §6.
//!
//! ## What this module is
//!
//! A deliberately boring binding surface. It has **no generics, no lifetimes in
//! signatures and no borrowed parameters**: every parameter and return value is an owned
//! `String`, `Vec<u8>`, integer, `Option` or a plain record of those. That is exactly what
//! UniFFI can bind (the `#[uniffi::export]` macros are a later task; this module only
//! enforces the shape), and it is also why the stateful part ([`MobileCore`]) keeps
//! sessions and channels in id-keyed maps instead of handing out trait objects.
//!
//! | spec §6 | here |
//! |---|---|
//! | `pairFromQr(uri) -> PairInfo` | [`MobileCore::pair_from_qr`] |
//! | `sshConnect(host, port, user, cred) -> SessionId` | [`MobileCore::ssh_connect`] |
//! | `sshDirectTcp(sessionId, targetHost, targetPort) -> ChannelId` | [`MobileCore::ssh_direct_tcp`] |
//! | `channelRead(channelId) -> bytes` | [`MobileCore::channel_read`] |
//! | `channelReadWithTimeout(channelId, timeout) -> {bytes, eof}` | [`MobileCore::channel_read_with_timeout`] |
//! | `channelWrite(channelId, bytes)` | [`MobileCore::channel_write`] |
//! | `channelClose(channelId)` | [`MobileCore::channel_close`] |
//! | `execOnce(sessionId, cmd) -> {exitCode, stdout, stderr}` | [`MobileCore::exec_once`] |
//! | `deviceKeyGenerate() -> PublicKey` | [`MobileCore::device_key_generate`] |
//! | `deviceKeyPublic() -> PublicKey` | [`MobileCore::device_key_public`] |
//! | `cryptoVerify(releasePubkey, payload, signature) -> bool` | [`MobileCore::crypto_verify`] |
//! | `sessionClose(sessionId)` | [`MobileCore::session_close`] |
//! | `sshConnect` with the device key + a pinned host key | [`MobileCore::ssh_connect_seed`] |
//! | `fsList(root, path, maxEntries)` | [`crate::fs::list`] |
//! | `fsRead(root, path, maxBytes)` | [`crate::fs::read_text`] |
//!
//! ## Deferred, on purpose
//!
//! * `sftpPut` belongs to the daemon-provisioning task (T7) — it needs a real SFTP client
//!   implementation, not a stub.
//! * `sqliteOpen`/`openStore` belongs to the local-mode store task (T9).
//! * §6 has **no teardown** call; [`MobileCore::session_close`] / `channelClose` fill that
//!   hole (the spec text was amended, and the registry really does release the handles) and
//!   a channel lives until [`MobileCore::channel_close`], its session closing, or the end of
//!   the process. Before T16 nothing removed a session from the map: that leak is closed.
//! * [`MobileCore::session_fingerprint`] / [`MobileCore::session_fingerprint_compact`] are
//!   additive read-only accessors: §8 requires the host key fingerprint to be visible and
//!   confirmable before the user trusts the host, and §6 forgot a way to read it.
//! * [`MobileCore::channel_read_with_timeout`] and [`MobileCore::channel_close`] are additive
//!   too: §6 froze `channelRead` as "empty `Vec` means EOF", which cannot tell "nothing
//!   arrived yet" apart from "the peer closed", and it froze no way to release a channel.
//!   The SSH tunnel of the pivot (`§4`, S4) needs both, so the frozen calls keep their exact
//!   behaviour and these two carry the tunnel client.
//!
//! ## Device identity and the keystore
//!
//! [`MobileCore::device_key_generate`] returns the full [`DeviceKeyPair`] because the
//! **native** shell (Swift/Kotlin) is the only layer allowed to write the platform
//! keystore: the Kotlin module seals `secret_seed` with an AndroidKeyStore AES/GCM key and
//! persists only the ciphertext, so a later call re-derives the same public key instead of
//! minting a second identity. The TypeScript layer must receive `public_hex` only:
//! `secret` is the device identity (§0.2, §2) and must never cross into the JS runtime or
//! a log. Later sessions hand the seed back through [`MobileCore::device_key_public`] /
//! [`MobileCore::ssh_connect_seed`], and that second one **requires** the pinned host key:
//! a key-only connection that silently trusted a new host key would be a man-in-the-middle
//! window on every reconnect.
//!
//! ## Errors
//!
//! Every fallible call returns [`CoreErrorPayload`] (`{kind, message}`) instead of
//! [`crate::error::CoreError`], because the latter wraps a `std::io::Error` that cannot
//! cross an FFI boundary. `kind` is the stable discriminator documented on
//! [`CoreError::kind`](crate::error::CoreError::kind).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::device_key::{self, DeviceKeyPair, StoredKey};
use crate::error::CoreError;
use crate::qr::{self, PairInfo};
use crate::ssh::{
    Channel, ChannelEvent, ConnectRequest, ExecOutput, RusshTransport, SshCredential, SshSession,
    Transport,
};

/// Opaque session handle. Values are never reused inside one [`MobileCore`].
pub type SessionId = u64;
/// Opaque channel handle. Values are never reused inside one [`MobileCore`].
pub type ChannelId = u64;

/// FFI-safe error record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreErrorPayload {
    /// Stable discriminator, one of `invalid_qr`, `ssh`, `io`, `crypto`,
    /// `unsupported_version`.
    pub kind: String,
    /// Human-readable message, safe to show in the UI.
    pub message: String,
}

impl From<CoreError> for CoreErrorPayload {
    fn from(error: CoreError) -> Self {
        Self {
            kind: error.kind().to_string(),
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for CoreErrorPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

/// One bounded read of a tunnel channel: what arrived and whether the peer closed it.
///
/// Additive to §6: [`MobileCore::channel_read`] keeps its frozen "empty `Vec` means EOF"
/// convention, while the tunnel client needs the two cases apart — nothing arrived yet is
/// not the same as the host closed the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelRead {
    /// Payload bytes; empty on a timeout and on EOF.
    pub bytes: Vec<u8>,
    /// Whether the peer closed the channel (or sent EOF).
    pub eof: bool,
}

/// The stateful object the native shell owns and the TS layer calls into.
///
/// Holds the SSH transport plus the id registries. It is `Send + Sync`, so a single value
/// can be shared by the app for its whole lifetime.
pub struct MobileCore {
    transport: Arc<dyn Transport>,
    sessions: Mutex<HashMap<SessionId, Arc<SshSession>>>,
    channels: Mutex<HashMap<ChannelId, RegisteredChannel>>,
    next_session_id: AtomicU64,
    next_channel_id: AtomicU64,
    connect_timeout: Duration,
}

/// How long the whole SSH handshake may take before it is abandoned (SEC-010).
///
/// A peer that accepts the TCP connection and then never answers used to hold the caller
/// forever; because Expo drives this crate from a single `AsyncFunction` thread, one stalled
/// host wedged the whole bridge. The handshake is therefore bounded: past this window the
/// future is dropped (which closes the socket) and the call answers a typed `ssh` error
/// naming the target and the window.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// A live channel together with the session that opened it.
///
/// The owning session id is what lets [`MobileCore::session_close`] take the session's
/// channels with it: a channel whose session is gone can never be read or written again,
/// so keeping the handle registered would be a leak the app cannot even clean up.
struct RegisteredChannel {
    session_id: SessionId,
    channel: Arc<Channel>,
}

impl MobileCore {
    /// Facade over the real russh transport.
    pub fn new() -> Self {
        Self::with_transport(Arc::new(RusshTransport::new()))
    }

    /// Facade over a caller-provided transport (the offline test seam).
    pub fn with_transport(transport: Arc<dyn Transport>) -> Self {
        Self::with_transport_and_connect_timeout(transport, CONNECT_TIMEOUT)
    }

    /// Facade over a caller-provided transport with an explicit handshake window.
    ///
    /// Exists so a test can pin the bounded handshake without waiting [`CONNECT_TIMEOUT`];
    /// production always uses [`MobileCore::with_transport`].
    pub fn with_transport_and_connect_timeout(
        transport: Arc<dyn Transport>,
        connect_timeout: Duration,
    ) -> Self {
        Self {
            transport,
            sessions: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            next_channel_id: AtomicU64::new(1),
            connect_timeout,
        }
    }

    /// `pairFromQr`: parse and validate a scanned `gc://pair?v=1` invitation (§1).
    pub fn pair_from_qr(&self, uri: String) -> Result<PairInfo, CoreErrorPayload> {
        qr::pair_from_qr(&uri).map_err(CoreErrorPayload::from)
    }

    /// `sshConnect`: open an authenticated session and register it under a fresh id.
    ///
    /// A **key** credential is refused here: without a pinned host fingerprint a key-only
    /// connect is trust-on-first-use, which would let anyone answering on that address
    /// receive the app's traffic. The pinned path ([`Self::ssh_connect_pinned`] /
    /// [`Self::ssh_connect_seed`]) is the only way to authenticate with a key.
    pub async fn ssh_connect(
        &self,
        host: String,
        port: u16,
        user: String,
        credential: SshCredential,
    ) -> Result<SessionId, CoreErrorPayload> {
        if matches!(credential, SshCredential::Key { .. }) {
            return Err(CoreErrorPayload::from(CoreError::ssh(
                "a key-only connect must pin the host fingerprint; use gc_ssh_connect_seed (or expectedFp) instead of trusting the first key presented",
            )));
        }
        let request = ConnectRequest::new(&host, port, &user, credential);
        self.open_session(request).await
    }

    /// `sshConnect` with a **pinned** host key: every later, already-paired connection.
    ///
    /// A different host key aborts the handshake: no session is registered, and the
    /// observed key is never trusted on first use a second time.
    pub async fn ssh_connect_pinned(
        &self,
        host: String,
        port: u16,
        user: String,
        credential: SshCredential,
        expected_fingerprint: String,
    ) -> Result<SessionId, CoreErrorPayload> {
        let expected_fingerprint = usable_pin(&expected_fingerprint)?;
        let request =
            ConnectRequest::new(&host, port, &user, credential).pinned(&expected_fingerprint);
        self.open_session(request).await
    }

    /// `gc_ssh_connect_seed`: authenticate with the **device key** derived from `seed`,
    /// pinned to `expected_fingerprint`.
    ///
    /// The credential is built here, so the seed never has to become an
    /// [`SshCredential`] in JS: a key-only connection cannot be opened without a pin
    /// either, which is exactly the defect this closes (the pre-T16 `ssh_connect` always
    /// used trust-on-first-use, even for a key).
    pub async fn ssh_connect_seed(
        &self,
        host: String,
        port: u16,
        user: String,
        seed: StoredKey,
        expected_fingerprint: String,
    ) -> Result<SessionId, CoreErrorPayload> {
        let private = device_key::private_key_openssh(&seed).map_err(CoreErrorPayload::from)?;
        let credential = SshCredential::Key {
            private: private.into_bytes(),
            passphrase: None,
        };
        self.ssh_connect_pinned(host, port, user, credential, expected_fingerprint)
            .await
    }

    /// Open one session and register it, whatever the credential or policy was.
    ///
    /// The **whole handshake is bounded** (SEC-010): a peer that accepts the TCP connection
    /// and then never answers used to hold this future — and therefore Expo's single native
    /// queue — forever. Past [`MobileCore::connect_timeout`] the attempt is abandoned (which
    /// drops the partially opened transport, closing its socket) and the answer is a typed
    /// `ssh` error naming the target and the window.
    async fn open_session(&self, request: ConnectRequest) -> Result<SessionId, CoreErrorPayload> {
        let target = format!("{}:{}", request.host, request.port);
        let attempt = SshSession::connect_with(self.transport.as_ref(), request);
        let session = match tokio::time::timeout(self.connect_timeout, attempt).await {
            Ok(result) => result.map_err(CoreErrorPayload::from)?,
            Err(_) => {
                return Err(CoreErrorPayload::from(CoreError::ssh(format!(
                    "the handshake with {target} did not complete within {} ms; the host did not answer (kept the native queue free)",
                    self.connect_timeout.as_millis()
                ))))
            }
        };
        let session_id = next_id(&self.next_session_id);
        lock(&self.sessions).insert(session_id, Arc::new(session));
        Ok(session_id)
    }

    /// `sshDirectTcp`: open a direct-tcpip channel to `target_host:target_port` (§4).
    pub async fn ssh_direct_tcp(
        &self,
        session_id: SessionId,
        target_host: String,
        target_port: u16,
    ) -> Result<ChannelId, CoreErrorPayload> {
        let session = self.session(session_id)?;
        let channel = session
            .direct_tcp(&target_host, target_port)
            .await
            .map_err(CoreErrorPayload::from)?;
        let channel_id = next_id(&self.next_channel_id);
        lock(&self.channels).insert(
            channel_id,
            RegisteredChannel {
                session_id,
                channel: Arc::new(channel),
            },
        );
        Ok(channel_id)
    }

    /// `channelRead`: next chunk of the channel.
    ///
    /// An **empty `Vec` signals end of stream** (EOF or closed channel) — byte streams have
    /// no in-band EOF marker, and this is the convention the TS tunnel client consumes.
    /// Extended data on a tunnel channel is a protocol violation and is reported as an
    /// `ssh` error rather than silently dropped.
    pub async fn channel_read(&self, channel_id: ChannelId) -> Result<Vec<u8>, CoreErrorPayload> {
        let channel = self.channel(channel_id)?;
        match channel.read().await.map_err(CoreErrorPayload::from)? {
            ChannelEvent::Data(bytes) => Ok(bytes),
            ChannelEvent::Eof => Ok(Vec::new()),
            ChannelEvent::ExtendedData { ext, .. } => Err(CoreErrorPayload::from(CoreError::ssh(
                format!("unexpected extended data frame (ext {ext}) on a tunnel channel"),
            ))),
        }
    }

    /// `channelWrite`: write bytes to the channel.
    pub async fn channel_write(
        &self,
        channel_id: ChannelId,
        bytes: Vec<u8>,
    ) -> Result<(), CoreErrorPayload> {
        let channel = self.channel(channel_id)?;
        channel.write(&bytes).await.map_err(CoreErrorPayload::from)
    }

    /// `channelReadWithTimeout`: read the next frame, waiting at most `timeout`.
    ///
    /// Unlike [`MobileCore::channel_read`], the answer distinguishes the three outcomes the
    /// tunnel client must tell apart:
    ///
    /// * data arrived → `bytes`, `eof: false`;
    /// * the peer closed the channel → empty `bytes`, `eof: true`;
    /// * nothing arrived inside `timeout` → empty `bytes`, `eof: false` (a timeout is **not**
    ///   an error: the app keeps the tunnel open and reads again).
    ///
    /// The wait never exceeds `timeout`, so a stalled host cannot hang the app (§7).
    pub async fn channel_read_with_timeout(
        &self,
        channel_id: ChannelId,
        timeout: Duration,
    ) -> Result<ChannelRead, CoreErrorPayload> {
        let channel = self.channel(channel_id)?;
        match tokio::time::timeout(timeout, channel.read()).await {
            // The window closed with nothing to report: no bytes, no end of stream.
            Err(_) => Ok(ChannelRead {
                bytes: Vec::new(),
                eof: false,
            }),
            Ok(Err(error)) => Err(CoreErrorPayload::from(error)),
            Ok(Ok(ChannelEvent::Data(bytes))) => Ok(ChannelRead { bytes, eof: false }),
            Ok(Ok(ChannelEvent::Eof)) => Ok(ChannelRead {
                bytes: Vec::new(),
                eof: true,
            }),
            Ok(Ok(ChannelEvent::ExtendedData { ext, .. })) => {
                Err(CoreErrorPayload::from(CoreError::ssh(format!(
                    "unexpected extended data frame (ext {ext}) on a tunnel channel"
                ))))
            }
        }
    }

    /// `channelClose`: send EOF/close on the channel and free its handle.
    ///
    /// The handle is removed before the close is awaited, so the id is stale from then on:
    /// a second call (or any later read/write) answers the unknown-channel error instead of
    /// touching a dead channel.
    pub async fn channel_close(&self, channel_id: ChannelId) -> Result<(), CoreErrorPayload> {
        let channel = lock(&self.channels).remove(&channel_id);
        let channel = channel.ok_or_else(|| CoreErrorPayload::from(unknown_channel(channel_id)))?;
        channel
            .channel
            .close()
            .await
            .map_err(CoreErrorPayload::from)
    }

    /// `sessionClose`: disconnect the session and free its id and its channels.
    ///
    /// The handle is removed **before** the disconnect is awaited, so the id is stale from
    /// that moment on: a second close (or any later call naming it) answers the
    /// unknown-session error instead of touching a dead session. Every channel the session
    /// opened is dropped with it — a channel of a closed session can never carry bytes
    /// again, and leaving it in the registry is the leak this closes.
    ///
    /// `Ok` means the transport **really** let go (SEC-012): the disconnect is awaited and
    /// then the transport is asked whether it still holds the connection. A transport that
    /// says it is still connected gets a typed `ssh` failure, so `closed: true` is never
    /// reported for a teardown that did not happen. The handle is gone either way.
    pub async fn session_close(&self, session_id: SessionId) -> Result<(), CoreErrorPayload> {
        let session = lock(&self.sessions).remove(&session_id);
        let session = session.ok_or_else(|| CoreErrorPayload::from(unknown_session(session_id)))?;

        let orphaned: Vec<Arc<Channel>> = {
            let mut channels = lock(&self.channels);
            let ids: Vec<ChannelId> = channels
                .iter()
                .filter(|(_, registered)| registered.session_id == session_id)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| channels.remove(&id).map(|registered| registered.channel))
                .collect()
        };
        for channel in orphaned {
            // The session is already being torn down: a channel that fails to close must
            // never keep its id registered or hide the session-level answer below.
            let _ = channel.close().await;
        }

        session.disconnect().await.map_err(CoreErrorPayload::from)?;

        if session.is_connected() == Some(true) {
            return Err(CoreErrorPayload::from(CoreError::ssh(format!(
                "session {session_id} was removed but the transport still reports an open connection: the teardown did not reach the host"
            ))));
        }
        Ok(())
    }

    /// Number of live sessions (diagnostics; the registry itself is private).
    pub fn session_count(&self) -> usize {
        lock(&self.sessions).len()
    }

    /// Number of live channels (diagnostics; the registry itself is private).
    pub fn channel_count(&self) -> usize {
        lock(&self.channels).len()
    }

    /// `execOnce`: run one command and collect its result (daemon detection, `uname -m`,
    /// `daemon restart`, … — §3, §5).
    pub async fn exec_once(
        &self,
        session_id: SessionId,
        command: String,
    ) -> Result<ExecOutput, CoreErrorPayload> {
        let session = self.session(session_id)?;
        session
            .exec_once(&command)
            .await
            .map_err(CoreErrorPayload::from)
    }

    /// Host key fingerprint of a live session in display form (`aa:bb:…`).
    ///
    /// Additive to §6 (see the module docs): §8 requires this value to be confirmable by
    /// the user before the host is trusted.
    pub fn session_fingerprint(&self, session_id: SessionId) -> Result<String, CoreErrorPayload> {
        Ok(self.session(session_id)?.fingerprint_of_host_key())
    }

    /// Host key fingerprint of a live session in compact form (64 hex chars), directly
    /// comparable with [`PairInfo::fingerprint`] from the scanned QR.
    pub fn session_fingerprint_compact(
        &self,
        session_id: SessionId,
    ) -> Result<String, CoreErrorPayload> {
        Ok(self.session(session_id)?.fingerprint_compact())
    }

    /// `deviceKeyGenerate`: create the phone's ed25519 identity (§2.1).
    ///
    /// Returns both halves because the native shell is the keystore writer; the TS layer
    /// must only ever see [`DeviceKeyPair::public_hex`]. The seed is held by a value that
    /// wipes itself on drop, so this is the only place it ever exists in memory here.
    pub fn device_key_generate(&self) -> DeviceKeyPair {
        device_key::generate()
    }

    /// `deviceKeyPublic`: derive the public key of a stored secret (`§6`), used on every
    /// later connection to prove the stored keystore entry is still consistent.
    pub fn device_key_public(&self, secret: StoredKey) -> Result<String, CoreErrorPayload> {
        device_key::public_hex_from_secret(&secret).map_err(CoreErrorPayload::from)
    }

    /// `cryptoVerify`: verify a release signature (§3.2, §5).
    ///
    /// `false` on a bad key, bad payload, bad signature or malformed input: the caller
    /// must abort the download, so no failure mode may be a panic or an `Err`.
    pub fn crypto_verify(
        &self,
        release_pubkey: String,
        payload: Vec<u8>,
        signature: Vec<u8>,
    ) -> bool {
        device_key::verify(&release_pubkey, &payload, &signature)
    }

    /// Look up a live session, or fail with an `ssh` error naming the unknown id.
    ///
    /// `pub(crate)` because [`crate::cabi`] reuses this registry as the single source of
    /// live sessions: the C ABI hands out the same [`SessionId`] values, so the two
    /// surfaces can never disagree about which session an id names.
    pub(crate) fn session(
        &self,
        session_id: SessionId,
    ) -> Result<Arc<SshSession>, CoreErrorPayload> {
        match lock(&self.sessions).get(&session_id) {
            Some(session) => Ok(Arc::clone(session)),
            None => Err(CoreErrorPayload::from(unknown_session(session_id))),
        }
    }

    /// Look up a live channel, or fail with an `ssh` error naming the unknown id.
    fn channel(&self, channel_id: ChannelId) -> Result<Arc<Channel>, CoreErrorPayload> {
        match lock(&self.channels).get(&channel_id) {
            Some(registered) => Ok(Arc::clone(&registered.channel)),
            None => Err(CoreErrorPayload::from(unknown_channel(channel_id))),
        }
    }
}

/// The `ssh` error for a channel id this process does not hold (§7: named, never a panic).
fn unknown_channel(channel_id: ChannelId) -> CoreError {
    CoreError::ssh(format!("unknown channel id {channel_id}"))
}

/// The `ssh` error for a session id this process does not hold.
fn unknown_session(session_id: SessionId) -> CoreError {
    CoreError::ssh(format!("unknown session id {session_id}"))
}

/// Normalize a pinned host fingerprint, or refuse a value no handshake could match.
///
/// An unusable pin must fail loudly: accepting it would either reject every host or (worse,
/// if it were passed through unchecked) accept any host.
fn usable_pin(expected_fingerprint: &str) -> Result<String, CoreErrorPayload> {
    crate::fingerprint::normalize(expected_fingerprint).ok_or_else(|| {
        CoreErrorPayload::from(CoreError::ssh(format!(
            "the pinned host fingerprint is not a SHA-256 fingerprint: {expected_fingerprint:?}"
        )))
    })
}

impl Default for MobileCore {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for MobileCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MobileCore")
            .field("sessions", &lock(&self.sessions).len())
            .field("channels", &lock(&self.channels).len())
            .finish_non_exhaustive()
    }
}

/// Allocate the next handle of a registry, never reusing a value.
fn next_id(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::Relaxed)
}

/// Lock a registry, recovering from a poisoned mutex instead of propagating a panic.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qr::DEFAULT_PORT;
    use crate::ssh::mock::{MockTransport, FP};
    use crate::ssh::{BoxFuture, TransportChannel, TransportSession};

    fn core() -> (MobileCore, Arc<MockTransport>) {
        core_fixture()
    }

    /// The mock-backed facade under a name that reads better inside a mixed test.
    fn core_fixture() -> (MobileCore, Arc<MockTransport>) {
        let transport = Arc::new(MockTransport::default());
        (
            MobileCore::with_transport(Arc::clone(&transport) as Arc<dyn Transport>),
            transport,
        )
    }

    const FP_HEX: &str = "66402c9468c58941dd19ffd650bf2b42f9226f83d3bd06ad515d0e5104a77020";

    fn valid_uri() -> String {
        format!(
            "gc://pair?v=1&host=192.168.1.42&port=2222&user=reaan&token=inv_7Qp2&fp={FP_HEX}&proto=1"
        )
    }

    #[test]
    fn pair_from_qr_returns_the_summary_record() {
        let (core, _) = core();
        let info = core.pair_from_qr(valid_uri()).expect("valid uri");
        assert_eq!(info.host, "192.168.1.42");
        assert_eq!(info.port, 2222);
        assert_eq!(info.user, "reaan");
        assert_eq!(info.token, "inv_7Qp2");
        assert_eq!(info.fingerprint, FP_HEX);
        assert_eq!(info.daemon_protocol_minor, Some(1));
        assert_eq!(info.version, 1);
    }

    #[test]
    fn pair_from_qr_defaults_the_port() {
        let (core, _) = core();
        let info = core
            .pair_from_qr(format!(
                "gc://pair?v=1&host=gentle.local&user=reaan&token=t&fp={FP_HEX}"
            ))
            .expect("valid uri");
        assert_eq!(info.port, DEFAULT_PORT);
    }

    #[test]
    fn pair_from_qr_maps_invalid_uris_to_an_invalid_qr_payload() {
        let (core, _) = core();
        let payload = core
            .pair_from_qr("gc://pair?v=1&host=&user=u&token=t".to_string())
            .expect_err("must fail");
        assert_eq!(payload.kind, "invalid_qr");
        assert_eq!(
            payload.message,
            "invalid pairing QR: host must not be empty"
        );
    }

    #[test]
    fn pair_from_qr_maps_unknown_versions_to_an_unsupported_version_payload() {
        let (core, _) = core();
        let payload = core
            .pair_from_qr(format!("gc://pair?v=9&host=h&user=u&token=t&fp={FP_HEX}"))
            .expect_err("must fail");
        assert_eq!(payload.kind, "unsupported_version");
        assert_eq!(
            payload.message,
            "unsupported pairing QR major version 9 (this build speaks v1)"
        );
    }

    #[tokio::test]
    async fn ssh_connect_registers_sessions_under_increasing_ids() {
        let (core, transport) = core();
        let first = core
            .ssh_connect(
                "10.0.0.5".to_string(),
                2222,
                "reaan".to_string(),
                SshCredential::Password("pw".to_string()),
            )
            .await
            .expect("session");
        let second = core
            .ssh_connect(
                "10.0.0.5".to_string(),
                2222,
                "reaan".to_string(),
                SshCredential::Password("pw".to_string()),
            )
            .await
            .expect("session");
        assert_eq!((first, second), (1, 2));
        assert_eq!(
            transport.last_request().map(|request| request.host),
            Some("10.0.0.5".to_string())
        );
        assert_eq!(core.session_fingerprint_compact(first).expect("known"), FP);
        assert!(core
            .session_fingerprint(first)
            .expect("known")
            .contains(':'));
    }

    #[tokio::test]
    async fn ssh_connect_maps_authentication_failures_to_ssh_payloads() {
        let (core, _) = core();
        let payload = core
            .ssh_connect(
                "h".to_string(),
                22,
                "denied".to_string(),
                SshCredential::Password("x".to_string()),
            )
            .await
            .expect_err("must fail");
        assert_eq!(payload.kind, "ssh");
        assert!(
            payload.message.contains("authentication rejected"),
            "{payload}"
        );
    }

    #[tokio::test]
    async fn direct_tcp_channels_are_registered_and_stream_bytes() {
        let (core, _) = core();
        let session = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("session");
        let channel = core
            .ssh_direct_tcp(session, "127.0.0.1".to_string(), crate::ssh::DAEMON_PORT)
            .await
            .expect("channel");
        assert_eq!(channel, 1);
        // The mock has nothing queued, so the first read is EOF => empty Vec.
        assert_eq!(
            core.channel_read(channel).await.expect("read"),
            Vec::<u8>::new()
        );
        core.channel_write(channel, b"GET /device/ws".to_vec())
            .await
            .expect("write");
        assert_eq!(
            core.channel_read(channel).await.expect("read"),
            Vec::<u8>::new()
        );
    }

    #[tokio::test]
    async fn exec_once_reaches_the_session() {
        let (core, _) = core();
        let session = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("session");
        let output = core
            .exec_once(session, "uname -m".to_string())
            .await
            .expect("exec");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, b"ran uname -m".to_vec());
    }

    #[tokio::test]
    async fn unknown_handles_are_reported_as_ssh_payloads() {
        let (core, _) = core();
        let session = core.session_fingerprint(42).expect_err("unknown session");
        assert_eq!(session.kind, "ssh");
        assert_eq!(session.message, "ssh: unknown session id 42");

        let channel = core.channel_read(7).await.expect_err("unknown channel");
        assert_eq!(channel.kind, "ssh");
        assert_eq!(channel.message, "ssh: unknown channel id 7");
    }

    #[test]
    fn device_key_generate_produces_a_public_key_that_matches_its_secret() {
        let (core, _) = core();
        let pair = core.device_key_generate();
        assert_eq!(pair.public_hex.len(), 64);
        // `StoredKey` is not `Clone` (the seed has no copies), so the check moves a value
        // built from the borrowed bytes instead.
        let derived = core
            .device_key_public(StoredKey {
                secret_seed: pair.secret.expose_seed().to_vec(),
            })
            .expect("derivable");
        assert_eq!(derived, pair.public_hex);
        assert_eq!(
            core.device_key_public(StoredKey {
                secret_seed: vec![0, 1]
            })
            .expect_err("bad seed")
            .kind,
            "crypto"
        );
    }

    #[test]
    fn crypto_verify_checks_release_signatures() {
        let (core, _) = core();
        let pair = core.device_key_generate();
        let payload = b"signed daemon descriptor";
        let signature = device_key::sign(&pair.secret, payload).expect("signable");
        assert!(core.crypto_verify(pair.public_hex.clone(), payload.to_vec(), signature.clone()));
        assert!(!core.crypto_verify(pair.public_hex, b"other".to_vec(), signature));
    }

    #[test]
    fn core_error_payloads_serialize_for_the_ts_layer() {
        let payload = CoreErrorPayload::from(CoreError::ssh("boom"));
        assert_eq!(
            serde_json::to_string(&payload).expect("serializes"),
            r#"{"kind":"ssh","message":"ssh: boom"}"#
        );
        assert_eq!(payload.to_string(), "ssh: ssh: boom");
    }

    #[test]
    fn debug_reports_the_registry_sizes_without_leaking_state() {
        let (core, _) = core();
        let rendered = format!("{core:?}");
        assert!(rendered.contains("sessions: 0"), "{rendered}");
        assert!(rendered.contains("channels: 0"), "{rendered}");
    }

    #[tokio::test]
    async fn extended_data_on_a_tunnel_channel_is_reported() {
        // A channel that yields stderr must not be mistaken for payload bytes.
        struct StderrChannel;

        impl crate::ssh::TransportChannel for StderrChannel {
            fn read<'a>(&'a self) -> crate::ssh::BoxFuture<'a, Result<ChannelEvent, CoreError>> {
                Box::pin(async {
                    Ok(ChannelEvent::ExtendedData {
                        ext: 1,
                        bytes: b"warn".to_vec(),
                    })
                })
            }

            fn write<'a>(
                &'a self,
                _bytes: &'a [u8],
            ) -> crate::ssh::BoxFuture<'a, Result<(), CoreError>> {
                Box::pin(async { Ok(()) })
            }

            fn close(&self) -> crate::ssh::BoxFuture<'_, Result<(), CoreError>> {
                Box::pin(async { Ok(()) })
            }
        }

        struct StderrSession;

        impl crate::ssh::TransportSession for StderrSession {
            fn host_key_fingerprint(&self) -> String {
                FP.to_string()
            }

            fn exec_once<'a>(
                &'a self,
                _command: &'a str,
            ) -> crate::ssh::BoxFuture<'a, Result<ExecOutput, CoreError>> {
                Box::pin(async {
                    Ok(ExecOutput {
                        exit_code: 0,
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                    })
                })
            }

            fn direct_tcpip<'a>(
                &'a self,
                _target_host: &'a str,
                _target_port: u16,
            ) -> crate::ssh::BoxFuture<'a, Result<Box<dyn crate::ssh::TransportChannel>, CoreError>>
            {
                Box::pin(async {
                    Ok(Box::new(StderrChannel) as Box<dyn crate::ssh::TransportChannel>)
                })
            }
        }

        struct StderrTransport;

        impl Transport for StderrTransport {
            fn connect<'a>(
                &'a self,
                _request: &'a ConnectRequest,
            ) -> crate::ssh::BoxFuture<'a, Result<Box<dyn crate::ssh::TransportSession>, CoreError>>
            {
                Box::pin(async {
                    Ok(Box::new(StderrSession) as Box<dyn crate::ssh::TransportSession>)
                })
            }
        }

        let core = MobileCore::with_transport(Arc::new(StderrTransport));
        let session = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("session");
        let channel = core
            .ssh_direct_tcp(session, "127.0.0.1".to_string(), 43722)
            .await
            .expect("channel");
        let payload = core.channel_read(channel).await.expect_err("must fail");
        assert_eq!(payload.kind, "ssh");
        assert!(payload.message.contains("extended data"), "{payload}");
    }

    // ----------------------------------------------------------------------
    // Device-key reconnect and teardown (T16)
    // ----------------------------------------------------------------------

    fn seed_pair() -> DeviceKeyPair {
        device_key::generate()
    }

    /// A fresh `StoredKey` for the pair's seed: the holder is deliberately not `Clone`.
    fn seed_copy(pair: &DeviceKeyPair) -> StoredKey {
        StoredKey {
            secret_seed: pair.secret.expose_seed().to_vec(),
        }
    }

    #[tokio::test]
    async fn ssh_connect_seed_authenticates_with_the_device_key_and_requires_the_pin() {
        let (core, transport) = core();
        let pair = seed_pair();

        let session = core
            .ssh_connect_seed(
                "10.0.0.5".to_string(),
                2222,
                "reaan".to_string(),
                seed_copy(&pair),
                FP.to_string(),
            )
            .await
            .expect("pinned key session");
        assert_eq!(session, 1);
        assert_eq!(
            core.session_fingerprint_compact(session).expect("known"),
            FP
        );

        let request = transport.last_request().expect("request");
        // The credential really is the device key, in the frozen `key` encoding.
        match &request.credential {
            SshCredential::Key {
                private,
                passphrase,
            } => {
                assert_eq!(*passphrase, None);
                let text = String::from_utf8(private.clone()).expect("openssh text");
                assert!(
                    text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"),
                    "{text}"
                );
                let seed = seed_copy(&pair);
                assert_eq!(
                    device_key::public_key_openssh(&seed).expect("public"),
                    russh::keys::decode_secret_key(&text, None)
                        .expect("decodable")
                        .public_key()
                        .to_openssh()
                        .expect("encodable")
                );
            }
            other => panic!("the seeded connect must use the device key, got {other:?}"),
        }
        // The pin travelled with the request, so the handshake enforces it.
        assert_eq!(request.expected_fingerprint.as_deref(), Some(FP));
    }

    #[tokio::test]
    async fn a_seeded_connect_without_a_usable_pin_is_refused() {
        let (core, transport) = core();
        let pair = seed_pair();

        for pin in ["", "not-a-fingerprint", &"00".repeat(31)] {
            let payload = core
                .ssh_connect_seed(
                    "10.0.0.5".to_string(),
                    22,
                    "reaan".to_string(),
                    seed_copy(&pair),
                    pin.to_string(),
                )
                .await
                .expect_err("an unusable pin must be refused");
            assert_eq!(payload.kind, "ssh", "{pin:?}");
            assert!(
                payload.message.contains("not a SHA-256 fingerprint"),
                "{pin:?}: {payload}"
            );
        }
        assert!(transport.last_request().is_none(), "nothing may connect");
        assert_eq!(core.session_count(), 0);
    }

    #[tokio::test]
    async fn a_seeded_connect_against_a_different_host_key_is_refused() {
        let (core, transport) = core();
        let pair = seed_pair();
        let wrong = "bb".repeat(32);

        let payload = core
            .ssh_connect_seed(
                "10.0.0.5".to_string(),
                22,
                "reaan".to_string(),
                seed_copy(&pair),
                wrong.clone(),
            )
            .await
            .expect_err("a different host key must abort");
        assert_eq!(payload.kind, "ssh");
        assert!(payload.message.contains("pinned fingerprint"), "{payload}");
        assert!(payload.message.contains(&wrong), "{payload}");
        assert!(payload.message.contains(FP), "{payload}");
        // No session leaked, and the refused session was disconnected.
        assert_eq!(core.session_count(), 0);
        assert_eq!(transport.disconnects(), 1);
    }

    #[tokio::test]
    async fn a_seeded_connect_with_a_malformed_seed_never_echoes_it() {
        let (core, _) = core();
        let payload = core
            .ssh_connect_seed(
                "h".to_string(),
                22,
                "u".to_string(),
                StoredKey {
                    secret_seed: vec![0xde, 0xad, 0xbe, 0xef],
                },
                FP.to_string(),
            )
            .await
            .expect_err("a short seed cannot sign");
        assert_eq!(payload.kind, "crypto");
        assert!(!payload.message.contains("222, 173"), "{payload}");
        assert_eq!(core.session_count(), 0);
    }

    #[tokio::test]
    async fn a_key_only_connect_on_the_unpinned_symbol_is_refused() {
        let (core, transport) = core();
        let payload = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Key {
                    private: b"-----BEGIN OPENSSH PRIVATE KEY-----\n".to_vec(),
                    passphrase: None,
                },
            )
            .await
            .expect_err("a key without a pin must be refused");
        assert_eq!(payload.kind, "ssh");
        assert!(payload.message.contains("must pin the host"), "{payload}");
        // Nothing was dialled and no session was left behind.
        assert!(transport.last_request().is_none());
        assert_eq!(core.session_count(), 0);

        // PRESERVE: the password path of the first pairing is untouched.
        let session = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("pw".to_string()),
            )
            .await
            .expect("password session");
        assert!(core.session_fingerprint_compact(session).is_ok());
    }

    #[tokio::test]
    async fn session_close_removes_the_session_its_channels_and_refuses_a_second_close() {
        let (core, transport) = core();
        let session = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("session");
        let channel = core
            .ssh_direct_tcp(session, "127.0.0.1".to_string(), crate::ssh::DAEMON_PORT)
            .await
            .expect("channel");
        assert_eq!(core.session_count(), 1);
        assert_eq!(core.channel_count(), 1);

        core.session_close(session).await.expect("close");
        assert_eq!(core.session_count(), 0, "the session must not leak");
        assert_eq!(core.channel_count(), 0, "its channel must not leak either");
        assert_eq!(transport.disconnects(), 1);

        // Closing twice is an honest typed error, not a silent success.
        let second = core.session_close(session).await.expect_err("second close");
        assert_eq!(second.kind, "ssh");
        assert_eq!(second.message, format!("ssh: unknown session id {session}"));
        // The freed channel id is stale too.
        let stale = core.channel_read(channel).await.expect_err("stale channel");
        assert_eq!(stale.kind, "ssh");
        assert_eq!(stale.message, format!("ssh: unknown channel id {channel}"));
        assert_eq!(
            transport.disconnects(),
            1,
            "a refused close touches nothing"
        );
    }

    #[tokio::test]
    async fn session_close_only_takes_the_channels_of_its_own_session() {
        let (core, _) = core();
        let first = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("first session");
        let second = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("second session");
        let first_channel = core
            .ssh_direct_tcp(first, "127.0.0.1".to_string(), 43721)
            .await
            .expect("first channel");
        let second_channel = core
            .ssh_direct_tcp(second, "127.0.0.1".to_string(), 43722)
            .await
            .expect("second channel");

        core.session_close(first).await.expect("close first");
        assert_eq!(core.session_count(), 1);
        assert_eq!(core.channel_count(), 1);
        assert!(core.session_fingerprint_compact(second).is_ok());
        assert!(core.channel_read(second_channel).await.is_ok());
        assert!(core.channel_read(first_channel).await.is_err());
    }

    // ----------------------------------------------------------------------
    // SEC-010: a hung peer cannot hold the native queue
    // ----------------------------------------------------------------------

    /// A host that accepts the connection and then says nothing.
    struct HangingTransport;

    impl Transport for HangingTransport {
        fn connect<'a>(
            &'a self,
            _request: &'a ConnectRequest,
        ) -> BoxFuture<'a, Result<Box<dyn TransportSession>, CoreError>> {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn a_handshake_that_never_answers_times_out_and_registers_nothing() {
        let core = MobileCore::with_transport_and_connect_timeout(
            Arc::new(HangingTransport),
            Duration::from_millis(20),
        );
        // The outer window is only a tripwire: the core itself must bound the handshake.
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            core.ssh_connect(
                "stalled".to_string(),
                2222,
                "reaan".to_string(),
                SshCredential::Password("pw".to_string()),
            ),
        )
        .await
        .expect("the core must bound the handshake, not the caller");
        let payload = outcome.expect_err("a silent host is not a connection");
        assert_eq!(payload.kind, "ssh");
        assert!(
            payload.message.contains("stalled:2222"),
            "the failure names the target: {}",
            payload.message
        );
        assert!(
            payload.message.contains("did not complete within 20 ms"),
            "the failure names the window: {}",
            payload.message
        );
        assert_eq!(
            core.session_count(),
            0,
            "no half-open session may be registered"
        );
        assert_eq!(core.channel_count(), 0);
    }

    #[tokio::test]
    async fn the_default_handshake_window_is_the_documented_constant() {
        let (core, _) = core();
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(30));
        assert_eq!(core.connect_timeout, CONNECT_TIMEOUT);
        assert!(CONNECT_TIMEOUT <= Duration::from_secs(60));
    }

    // ----------------------------------------------------------------------
    // SEC-012: close reports the real disconnect outcome
    // ----------------------------------------------------------------------

    /// A transport whose handle keeps reporting an open connection after `disconnect`.
    struct StickySessionTransport;

    impl Transport for StickySessionTransport {
        fn connect<'a>(
            &'a self,
            _request: &'a ConnectRequest,
        ) -> BoxFuture<'a, Result<Box<dyn TransportSession>, CoreError>> {
            Box::pin(async { Ok(Box::new(StickySession) as Box<dyn TransportSession>) })
        }
    }

    struct StickySession;

    impl TransportSession for StickySession {
        fn host_key_fingerprint(&self) -> String {
            FP.to_string()
        }

        fn exec_once<'a>(
            &'a self,
            _command: &'a str,
        ) -> BoxFuture<'a, Result<ExecOutput, CoreError>> {
            Box::pin(async {
                Ok(ExecOutput {
                    exit_code: 0,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                })
            })
        }

        fn direct_tcpip<'a>(
            &'a self,
            _target_host: &'a str,
            _target_port: u16,
        ) -> BoxFuture<'a, Result<Box<dyn TransportChannel>, CoreError>> {
            Box::pin(std::future::pending())
        }

        fn is_connected(&self) -> Option<bool> {
            // The teardown never reached the connection: the handle is still up.
            Some(true)
        }
    }

    #[tokio::test]
    async fn session_close_refuses_to_report_closed_while_the_connection_is_up() {
        let core = MobileCore::with_transport(Arc::new(StickySessionTransport));
        let session = core
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("session");

        let payload = core
            .session_close(session)
            .await
            .expect_err("still connected");
        assert_eq!(payload.kind, "ssh");
        assert!(
            payload.message.contains("still reports an open connection"),
            "the failure must say what is still up: {}",
            payload.message
        );
        assert_eq!(core.session_count(), 0, "the handle is gone either way");

        // A transport that really disconnected keeps answering the clean close.
        let (clean, transport) = core_fixture();
        let session = clean
            .ssh_connect(
                "h".to_string(),
                22,
                "u".to_string(),
                SshCredential::Password("p".to_string()),
            )
            .await
            .expect("session");
        clean.session_close(session).await.expect("clean close");
        assert_eq!(transport.disconnects(), 1);
    }
}
