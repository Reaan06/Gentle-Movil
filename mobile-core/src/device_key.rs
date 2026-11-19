//! ed25519 device identity and release-signature verification.
//!
//! ## The phone owns its identity (`docs/mobile-protocol-spec.md` §0.2, §2.1)
//!
//! At the first pairing the phone generates an ed25519 key pair. The **public** half is
//! sent in `REGISTER_DEVICE` and persisted by the host daemon; every later connection
//! uses the **private** half as the SSH credential. The private half therefore never
//! leaves the device:
//!
//! * it is minted **once** (see `deviceKeyEnsure` in `mobile-core/src/cabi.rs` and the
//!   Kotlin `GcCoreModule`): the module seals the seed with an AndroidKeyStore AES/GCM key
//!   whose bytes never leave the keystore, and writes only the ciphertext into the app's
//!   private directory. Later calls decrypt it again and derive the public half with
//!   [`public_hex_from_secret`]; the seed itself never crosses into JS;
//! * [`StoredKey`] carries the raw 32-byte ed25519 seed so the native bridge and the
//!   tests can move it around. It is **not** part of the JS-visible FFI surface, it has
//!   a redacted [`Debug`] implementation, it is neither `Clone` nor `Serialize` (the one
//!   serialization site is the `gc_device_key_generate` envelope, which reads the bytes
//!   through [`StoredKey::expose_seed`]) and it **zeroizes itself on drop**: the seed is
//!   the most valuable secret on the phone, so no copy of it may survive the value that
//!   owns it. The sealing contract — format byte and AES-GCM associated data — is in the
//!   [`crate::ffi`] module docs, because the sealing itself is Kotlin's job;
//! * [`private_key_from_seed`] turns the seed into the SSH [`PrivateKey`] that
//!   `gc_ssh_connect_seed` authenticates with, and [`authorized_key_line`] is the single
//!   place that renders the `authorized_keys` line (no hand-rolled base64).
//!
//! ## What zeroization here does not cover
//!
//! This module wipes every buffer it owns: the seed holder on drop, the seed arrays copied
//! out of it, and a [`crate::ssh::SshCredential`]'s key and passphrase material on drop.
//! Three copies are out of reach by construction and are **not** claimed as fixed: the
//! JavaScript string the app hands over, the Kotlin `String` that crossed JNI, and the key
//! structure `russh` decodes internally (its `ed25519-dalek` is built without the `zeroize`
//! feature here). They belong to the Kotlin/TS hardening slice.
//!
//! Seed sizes and encodings are fixed: 32-byte seed, 32-byte public key, 64-byte
//! signature. Public keys and signatures travel as lowercase hex strings.

use std::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::{CryptoRngCore, OsRng};
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::ssh_key::{HashAlg, LineEnding};
use russh::keys::PrivateKey;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::CoreError;
use crate::fingerprint;

/// Length of an ed25519 secret seed, in bytes.
pub const SECRET_SEED_LEN: usize = 32;
/// Length of an ed25519 public key, in bytes.
pub const PUBLIC_KEY_LEN: usize = 32;
/// Length of an ed25519 signature, in bytes.
pub const SIGNATURE_LEN: usize = 64;

/// Comment `authorized_keys` carries when the caller names none.
pub const DEFAULT_AUTHORIZED_KEY_COMMENT: &str = "gentle-movil";

/// Raw ed25519 secret seed, waiting to be sealed in the platform keystore.
///
/// **Security:** this value is the device identity. The native shell must hand it to
/// the Keychain/Keystore and drop it; it must never reach JS, logs or a snapshot. It is
/// deliberately neither `Clone` nor `Serialize` (see [`StoredKey::expose_seed`] for the one
/// place the bytes are handed on), and it wipes its bytes when it is dropped.
#[derive(PartialEq, Eq)]
pub struct StoredKey {
    /// The 32-byte ed25519 seed, exactly [`SECRET_SEED_LEN`] bytes.
    pub secret_seed: Vec<u8>,
}

impl Zeroize for StoredKey {
    fn zeroize(&mut self) {
        self.secret_seed.zeroize();
    }
}

impl Drop for StoredKey {
    fn drop(&mut self) {
        self.zeroize();
    }
}

/// The trait `zeroize` uses to mark a type that wipes itself when it is dropped.
///
/// Implemented by hand (not derived) because the crate is pinned without the `derive`
/// feature: the wipe itself is the [`Zeroize`] implementation above, and the `Drop` impl
/// calls it.
impl ZeroizeOnDrop for StoredKey {}

impl StoredKey {
    /// Borrow the raw seed bytes.
    ///
    /// This exists for exactly one caller: the `gc_device_key_generate` envelope, which
    /// hands the seed to the native shell so it can seal it in the keystore. It is a
    /// **borrow**, never a copy, so nothing new is left in memory for the caller to leak;
    /// every other reader goes through [`public_hex_from_secret`],
    /// [`private_key_from_seed`] or [`sign`].
    pub fn expose_seed(&self) -> &[u8] {
        &self.secret_seed
    }
}

impl fmt::Debug for StoredKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredKey")
            .field(
                "secret_seed",
                &format_args!("<redacted {} bytes>", self.secret_seed.len()),
            )
            .finish()
    }
}

/// A freshly generated device identity.
///
/// Returned by [`generate`]. The public half is what the app shows and registers; the
/// private half is the [`StoredKey`] the keystore writer consumes.
#[derive(Debug, PartialEq, Eq)]
pub struct DeviceKeyPair {
    /// Lowercase hex (64 chars) ed25519 public key.
    pub public_hex: String,
    /// Private half, to be sealed by the platform keystore.
    pub secret: StoredKey,
}

impl DeviceKeyPair {
    /// Public half as raw bytes.
    pub fn public_bytes(&self) -> Result<[u8; PUBLIC_KEY_LEN], CoreError> {
        decode_public_hex(&self.public_hex)
    }
}

/// The pair zeroizes on drop through its [`StoredKey`], so the marker holds for it too.
impl ZeroizeOnDrop for DeviceKeyPair {}

/// Generate a new device identity with the operating system RNG.
pub fn generate() -> DeviceKeyPair {
    generate_with(&mut OsRng)
}

/// Generate a new device identity with a caller-provided RNG.
///
/// Exists so tests can pin the seed without touching OS entropy; production code calls
/// [`generate`].
pub fn generate_with(rng: &mut impl CryptoRngCore) -> DeviceKeyPair {
    let signing_key = SigningKey::generate(rng);
    DeviceKeyPair {
        public_hex: fingerprint::hex_lower(signing_key.verifying_key().as_bytes()),
        secret: StoredKey {
            secret_seed: signing_key.to_bytes().to_vec(),
        },
    }
}

/// Derive the lowercase hex public key from a stored secret (`deviceKeyPublic`).
pub fn public_hex_from_secret(secret: &StoredKey) -> Result<String, CoreError> {
    let signing_key = signing_key_from_secret(secret)?;
    Ok(fingerprint::hex_lower(
        signing_key.verifying_key().as_bytes(),
    ))
}

/// Sign `payload` with the device identity.
///
/// Used by the handshake to authenticate `REGISTER_DEVICE` (§2) and by the tests; the
/// signature is 64 bytes and the FFI/daemon encoding is lowercase hex.
pub fn sign(secret: &StoredKey, payload: &[u8]) -> Result<Vec<u8>, CoreError> {
    let signing_key = signing_key_from_secret(secret)?;
    Ok(signing_key.sign(payload).to_bytes().to_vec())
}

/// Verify `signature` over `payload` with a hex ed25519 public key (`cryptoVerify`).
///
/// Returns `false` for a wrong key, a tampered payload, a bad signature **and** for
/// unparsable inputs: the release-signature check (§3.2) needs a boolean go/no-go, and
/// any malformed input must mean "reject the binary", never "panic".
pub fn verify(release_pubkey_hex: &str, payload: &[u8], signature: &[u8]) -> bool {
    let Ok(public_bytes) = decode_public_hex(release_pubkey_hex) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&public_bytes) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    verifying_key.verify_strict(payload, &signature).is_ok()
}

/// Parse a lowercase or uppercase hex ed25519 public key into raw bytes.
fn decode_public_hex(public_hex: &str) -> Result<[u8; PUBLIC_KEY_LEN], CoreError> {
    let expected = PUBLIC_KEY_LEN * 2;
    if public_hex.len() != expected {
        return Err(CoreError::crypto(format!(
            "ed25519 public key must be {expected} hex characters, found {}",
            public_hex.len()
        )));
    }
    let mut bytes = [0u8; PUBLIC_KEY_LEN];
    for (index, chunk) in public_hex.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(chunk)
            .map_err(|_| CoreError::crypto("ed25519 public key is not ASCII hex"))?;
        bytes[index] = u8::from_str_radix(text, 16)
            .map_err(|_| CoreError::crypto(format!("ed25519 public key is not hex: {text:?}")))?;
    }
    Ok(bytes)
}

/// Rebuild the signing key from a stored secret seed.
///
/// The seed array is wiped as soon as the key exists; the [`SigningKey`] `ed25519-dalek`
/// builds is its own copy and is not wipeable in this build (see the module docs).
fn signing_key_from_secret(secret: &StoredKey) -> Result<SigningKey, CoreError> {
    let mut seed = seed_bytes(secret)?;
    let signing_key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    Ok(signing_key)
}

/// The 32 seed bytes of a stored secret, or a `crypto` error naming the real length.
pub fn seed_bytes(secret: &StoredKey) -> Result<[u8; SECRET_SEED_LEN], CoreError> {
    secret.secret_seed.as_slice().try_into().map_err(|_| {
        CoreError::crypto(format!(
            "ed25519 secret seed must be {SECRET_SEED_LEN} bytes, found {}",
            secret.secret_seed.len()
        ))
    })
}

/// The device identity as an SSH private key, derived from the stored seed.
///
/// This is the seam the key-only reconnect uses: the seed never leaves the device, and
/// the SSH layer only ever sees the derived [`PrivateKey`]. `Ed25519Keypair::from_seed`
/// is the same expansion the device key generator used, so the public half of the
/// derived key is byte-for-byte the one that was registered on the host.
pub fn private_key_from_seed(secret: &StoredKey) -> Result<PrivateKey, CoreError> {
    let mut seed = seed_bytes(secret)?;
    let private = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    seed.zeroize();
    Ok(private)
}

/// The device identity as OpenSSH/PEM text, for the frozen `SshCredential::Key` record.
///
/// The OpenSSH encoder hands its text back inside a `Zeroizing` buffer and the copy this
/// returns is owned by the caller: `gc_ssh_connect_seed` moves it straight into an
/// [`crate::ssh::SshCredential`], which wipes it on drop.
pub fn private_key_openssh(secret: &StoredKey) -> Result<String, CoreError> {
    let private = private_key_from_seed(secret)?;
    private
        .to_openssh(LineEnding::LF)
        .map(|text| text.to_string())
        .map_err(|error| CoreError::crypto(format!("cannot encode the device key: {error}")))
}

/// The device public key in OpenSSH one-line form (`ssh-ed25519 AAAA…`).
pub fn public_key_openssh(secret: &StoredKey) -> Result<String, CoreError> {
    let private = private_key_from_seed(secret)?;
    private
        .public_key()
        .to_openssh()
        .map_err(|error| CoreError::crypto(format!("cannot encode the device public key: {error}")))
}

/// The `authorized_keys` line for the device identity.
///
/// Replaces the TypeScript base64 hand-roll: the SSH wire encoding comes from the same
/// `ssh-key` implementation that parses host keys, so the line is the OpenSSH form by
/// construction. `comment` is trimmed; an empty comment leaves the line without one.
pub fn authorized_key_line(secret: &StoredKey, comment: &str) -> Result<String, CoreError> {
    let public = public_key_openssh(secret)?;
    let comment = comment.trim();
    Ok(if comment.is_empty() {
        public
    } else {
        format!("{public} {comment}")
    })
}

/// OpenSSH-style `SHA256:…` fingerprint of the device public key.
///
/// This is the value the settings screen shows; the digest is the SHA-256 of the SSH
/// wire encoding of the public key, exactly like `ssh-keygen -lf`.
pub fn fingerprint_sha256(secret: &StoredKey) -> Result<String, CoreError> {
    let private = private_key_from_seed(secret)?;
    Ok(private
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic RNG so a generated identity is reproducible in tests.
    struct FixedRng(u8);

    impl rand_core::RngCore for FixedRng {
        fn next_u32(&mut self) -> u32 {
            u32::from_le_bytes([self.0; 4])
        }

        fn next_u64(&mut self) -> u64 {
            u64::from_le_bytes([self.0; 8])
        }

        fn fill_bytes(&mut self, dest: &mut [u8]) {
            dest.fill(self.0);
        }

        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }

    impl rand_core::CryptoRng for FixedRng {}

    #[test]
    fn generate_returns_hex_public_key_and_32_byte_seed() {
        let pair = generate();
        assert_eq!(pair.public_hex.len(), PUBLIC_KEY_LEN * 2);
        assert!(pair.public_hex.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(pair.public_hex.chars().all(|c| !c.is_ascii_uppercase()));
        assert_eq!(pair.secret.secret_seed.len(), SECRET_SEED_LEN);
        assert!(pair.public_bytes().is_ok());
    }

    #[test]
    fn generate_with_the_same_rng_is_reproducible() {
        let first = generate_with(&mut FixedRng(7));
        let second = generate_with(&mut FixedRng(7));
        assert_eq!(first, second);
        let other = generate_with(&mut FixedRng(8));
        assert_ne!(first.public_hex, other.public_hex);
    }

    #[test]
    fn public_key_is_derived_from_the_secret() {
        let pair = generate_with(&mut FixedRng(3));
        assert_eq!(
            public_hex_from_secret(&pair.secret).expect("derivable"),
            pair.public_hex
        );
    }

    #[test]
    fn a_wrong_size_seed_is_a_crypto_error() {
        let short = StoredKey {
            secret_seed: vec![1, 2, 3],
        };
        let err = public_hex_from_secret(&short).unwrap_err();
        assert_eq!(err.kind(), "crypto");
        assert!(err.to_string().contains("must be 32 bytes"), "{err}");
        assert!(sign(&short, b"payload").is_err());
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let pair = generate_with(&mut FixedRng(11));
        let payload = b"REGISTER_DEVICE{\"deviceName\":\"pixel\"}";
        let signature = sign(&pair.secret, payload).expect("signable");
        assert_eq!(signature.len(), SIGNATURE_LEN);
        assert!(verify(&pair.public_hex, payload, &signature));
    }

    #[test]
    fn verify_rejects_tampering_and_foreign_keys() {
        let pair = generate_with(&mut FixedRng(5));
        let other = generate_with(&mut FixedRng(6));
        let payload = b"daemon-v0.6.0";
        let signature = sign(&pair.secret, payload).expect("signable");

        assert!(!verify(&pair.public_hex, b"daemon-v0.6.1", &signature));
        assert!(!verify(&other.public_hex, payload, &signature));
        assert!(!verify(
            &pair.public_hex,
            payload,
            &signature[..SIGNATURE_LEN - 1]
        ));
    }

    #[test]
    fn verify_returns_false_for_malformed_inputs() {
        let pair = generate_with(&mut FixedRng(9));
        let signature = sign(&pair.secret, b"x").expect("signable");
        assert!(!verify("", b"x", &signature));
        assert!(!verify("zz", b"x", &signature));
        assert!(!verify(&pair.public_hex, b"x", &[]));
        assert!(!verify(&pair.public_hex, b"x", &[0u8; SIGNATURE_LEN]));
        assert!(!verify(
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            b"x",
            &signature
        ));
    }

    #[test]
    fn public_key_hex_accepts_uppercase_input() {
        let pair = generate_with(&mut FixedRng(4));
        let payload = b"payload";
        let signature = sign(&pair.secret, payload).expect("signable");
        assert!(verify(
            &pair.public_hex.to_ascii_uppercase(),
            payload,
            &signature
        ));
    }

    #[test]
    fn debug_does_not_leak_the_seed() {
        let pair = generate_with(&mut FixedRng(2));
        let rendered = format!("{:?}", pair);
        assert!(rendered.contains("<redacted 32 bytes>"), "{rendered}");
        // FixedRng fills the seed with its byte, so this is the exact secret to hide.
        assert_eq!(pair.secret.secret_seed, vec![2u8; SECRET_SEED_LEN]);
        assert!(!rendered.contains(&fingerprint::hex_lower(&pair.secret.secret_seed)));
        assert!(!rendered.contains("02, 02, 02"), "{rendered}");
    }

    #[test]
    fn the_device_identity_only_reaches_the_sealed_envelope() {
        // `StoredKey` used to derive `Clone` + `Serialize`, so the seed could be copied and
        // JSON-encoded by anything holding the value. Both derives are gone: the single
        // serialization site is now the `gc_device_key_generate` envelope in `cabi`, whose
        // exact wire shape (`key.secret.secret_seed`) is pinned from the outside by
        // `provision_tests::device_key_generate_returns_the_pair_through_the_c_abi`.
        //
        // What is left to pin here is the derivation the keystore writer relies on: the
        // same bytes produce the same public half, every time, on a value that wipes them.
        let pair = generate_with(&mut FixedRng(13));
        let again = StoredKey {
            secret_seed: pair.secret.expose_seed().to_vec(),
        };
        assert_eq!(
            public_hex_from_secret(&again).expect("derivable"),
            pair.public_hex
        );
        assert_eq!(again, pair.secret);
        assert_eq!(
            authorized_key_line(&again, "gentle-movil").expect("renderable"),
            authorized_key_line(&pair.secret, "gentle-movil").expect("renderable")
        );
    }

    #[test]
    fn the_seed_holder_wipes_itself_and_implements_zeroize_on_drop() {
        // The trait bound is the rule: a seed holder that does not wipe on drop does not
        // compile into this test.
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<StoredKey>();
        assert_zeroize_on_drop::<DeviceKeyPair>();

        // The observable half: zeroizing the value zeroes the bytes in place (and `Vec`'s
        // implementation then resets the length), instead of leaving them behind in the
        // allocation.
        let pair = generate_with(&mut FixedRng(31));
        let mut seed = StoredKey {
            secret_seed: pair.secret.expose_seed().to_vec(),
        };
        assert_eq!(
            public_hex_from_secret(&seed).expect("derivable"),
            pair.public_hex
        );
        seed.zeroize();
        assert!(
            seed.expose_seed().is_empty(),
            "zeroize must wipe the seed bytes and drop the handle to them"
        );
    }

    #[test]
    fn the_seed_is_borrowed_not_copied_and_never_rendered() {
        let pair = generate_with(&mut FixedRng(32));
        // `expose_seed` is a borrow: the address is the holder's own buffer.
        assert_eq!(
            pair.secret.expose_seed().as_ptr(),
            pair.secret.secret_seed.as_ptr()
        );
        assert_eq!(pair.secret.expose_seed().len(), SECRET_SEED_LEN);
        assert_eq!(pair.secret.expose_seed(), &[32u8; SECRET_SEED_LEN][..]);
        // Neither `Debug` nor an error message renders the bytes.
        assert!(!format!("{pair:?}").contains("32, 32, 32"));
    }

    #[test]
    fn decode_public_hex_rejects_bad_length_and_digits() {
        assert!(decode_public_hex("").is_err());
        assert!(decode_public_hex(&"0".repeat(63)).is_err());
        assert!(decode_public_hex(&format!("{}g", "0".repeat(63))).is_err());
        assert!(decode_public_hex(&"0".repeat(64)).is_ok());
    }

    // ----------------------------------------------------------------------
    // Seed → SSH key material (the key-only reconnect path)
    // ----------------------------------------------------------------------

    /// Raw 32 bytes of the key inside an OpenSSH public key line.
    fn wire_public_bytes(openssh_line: &str) -> Vec<u8> {
        let mut fields = openssh_line.split(' ');
        assert_eq!(fields.next(), Some("ssh-ed25519"), "{openssh_line}");
        let blob = fields.next().expect("base64 blob");
        let mut out = Vec::new();
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut buffer = 0u32;
        let mut bits = 0u32;
        for byte in blob.bytes().filter(|byte| *byte != b'=') {
            let value = alphabet
                .iter()
                .position(|candidate| *candidate == byte)
                .expect("base64 digit") as u32;
            buffer = (buffer << 6) | value;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
        // `ssh-ed25519` || pubkey: skip the 4-byte length prefix and the 11 type bytes,
        // then the 4-byte length prefix of the key itself.
        let key_len = u32::from_be_bytes([out[15], out[16], out[17], out[18]]) as usize;
        assert_eq!(key_len, PUBLIC_KEY_LEN);
        out[19..19 + key_len].to_vec()
    }

    #[test]
    fn the_seed_derives_the_public_key_that_was_registered() {
        let pair = generate_with(&mut FixedRng(21));
        let private = private_key_from_seed(&pair.secret).expect("derivable");
        let openssh = public_key_openssh(&pair.secret).expect("encodable");

        // Same identity: the key inside the SSH blob is the public half of the seed.
        assert_eq!(
            wire_public_bytes(&openssh),
            pair.public_bytes().expect("public bytes")
        );
        // And the derived `PrivateKey` reports that same public key.
        assert_eq!(
            private.public_key().to_openssh().expect("encodable"),
            openssh
        );
        assert_eq!(
            public_hex_from_secret(&pair.secret).expect("derivable"),
            pair.public_hex
        );
    }

    #[test]
    fn the_private_key_round_trips_through_openssh_text() {
        let pair = generate_with(&mut FixedRng(22));
        let text = private_key_openssh(&pair.secret).expect("encodable");
        assert!(
            text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"),
            "{text}"
        );
        assert!(
            text.ends_with("-----END OPENSSH PRIVATE KEY-----\n"),
            "{text}"
        );
        // This is exactly what `russh` decodes for `SshCredential::Key`, so a credential
        // built here really authenticates as the registered identity.
        let decoded = russh::keys::decode_secret_key(&text, None).expect("decodable");
        assert_eq!(
            decoded.public_key().to_openssh().expect("encodable"),
            public_key_openssh(&pair.secret).expect("encodable")
        );
    }

    #[test]
    fn the_authorized_keys_line_is_the_openssh_form() {
        let pair = generate_with(&mut FixedRng(23));
        let line = authorized_key_line(&pair.secret, "gentle-movil").expect("renderable");
        assert_eq!(
            line,
            format!(
                "{} {DEFAULT_AUTHORIZED_KEY_COMMENT}",
                public_key_openssh(&pair.secret).expect("encodable")
            )
        );
        // OpenSSH wire prefix for an ed25519 key: `ssh-ed25519` is 11 bytes, then the
        // length-prefixed key, so the base64 blob always starts like this.
        assert!(
            line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"),
            "{line}"
        );
        assert_eq!(line.lines().count(), 1);
        assert!(!line.ends_with(' '));

        // A comment is trimmed, and an empty one leaves the line without a suffix.
        assert!(authorized_key_line(&pair.secret, "  phone \n")
            .expect("renderable")
            .ends_with(" phone"));
        let bare = authorized_key_line(&pair.secret, "   ").expect("renderable");
        assert_eq!(bare, public_key_openssh(&pair.secret).expect("encodable"));
        assert!(!bare.ends_with(' '));
    }

    #[test]
    fn the_device_fingerprint_is_the_openssh_sha256_form() {
        let pair = generate_with(&mut FixedRng(24));
        let fingerprint = fingerprint_sha256(&pair.secret).expect("derivable");
        assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
        // 32 digest bytes, base64 without padding.
        assert_eq!(fingerprint.len(), "SHA256:".len() + 43, "{fingerprint}");
        assert_ne!(
            fingerprint,
            fingerprint_sha256(&generate_with(&mut FixedRng(25)).secret).expect("derivable")
        );
    }

    #[test]
    fn a_malformed_seed_cannot_derive_key_material_and_never_echoes_it() {
        let short = StoredKey {
            secret_seed: vec![9, 8, 7],
        };
        for outcome in [
            private_key_from_seed(&short).err(),
            private_key_openssh(&short).err(),
            public_key_openssh(&short).err(),
            authorized_key_line(&short, "x").err(),
            fingerprint_sha256(&short).err(),
        ] {
            let error = outcome.expect("a short seed cannot derive a key");
            assert_eq!(error.kind(), "crypto");
            let message = error.to_string();
            assert!(message.contains("must be 32 bytes"), "{message}");
            assert!(
                !message.contains("9, 8, 7"),
                "the seed must never be echoed: {message}"
            );
        }
    }
}
