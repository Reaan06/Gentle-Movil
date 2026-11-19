package com.gentlemovil.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Storage of the phone's ed25519 **seed**, sealed by the Android Keystore.
 *
 * ## Why the seed does not live in a file
 *
 * The seed is the device identity: whoever holds it can authenticate as this phone. So it
 * is never written in the clear and never leaves the process:
 *
 * 1. an AES-256 key is generated **inside** the AndroidKeyStore (`KEY_ALIAS`), so its bytes
 *    are not extractable — not by the app, not by a backup, not by `adb`;
 * 2. the seed is encrypted with `AES/GCM/NoPadding` and a fresh 12-byte IV;
 * 3. only `iv || ciphertext || tag` is written, to a file inside the app's **private**
 *    files directory (`Context.filesDir`).
 *
 * GCM is authenticated, so a tampered file fails to decrypt instead of yielding a
 * different key: the caller gets an exception and the UI says the key cannot be read
 * instead of silently minting a second identity.
 *
 * The one exception to that rule is a **ciphertext whose Keystore entry no longer exists**
 * (a restore, a cleared keystore). The ciphertext is then unrecoverable by construction —
 * the key is non-exportable and cannot come back — so [read] throws
 * [MissingKeystoreEntryException] and `GcCoreModule.deviceKeyEnsure` treats the file as "no
 * key": it deletes it, logs the real cause and mints a fresh identity (SEC-004). Without
 * that, one restore would brick the phone's identity forever. `allowBackup: false`
 * (`mobile/app.json`) is what stops the ciphertext leaving the device in the first place.
 *
 * ## Contract with Rust
 *
 * The Rust core mints the seed once (`gc_device_key_generate`) and derives the public half
 * from it again on every later call (`gc_device_key_public`). This object is the only place
 * that reads or writes the seed; `GcCoreModule` zeroes its buffers as soon as it is done.
 */
internal object DeviceSeedStore {
  /**
   * The sealed seed exists but its AndroidKeyStore entry does not.
   *
   * Raised by [read] instead of a generic `IllegalStateException` so the caller can apply
   * the SEC-004 recovery (discard the stale ciphertext, mint fresh). Catching this is the
   * only difference between "unreadable file" and "no key at all", and only the second one
   * may rotate the identity.
   */
  class MissingKeystoreEntryException internal constructor(message: String) :
    IllegalStateException(message)

  /** File, inside the app's private directory, that holds the sealed seed. */
  const val FILE_NAME = "device-key.seed"

  private const val KEYSTORE = "AndroidKeyStore"
  private const val KEY_ALIAS = "gentle-movil.device-key.v1"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  /**
   * Largest payload this store accepts. A 32-byte seed plus the GCM tag is 48 bytes; the
   * margin leaves room for a longer seed without letting a corrupted file be decrypted as
   * if it were one.
   */
  private const val MAX_PAYLOAD_BYTES = 128

  /**
   * The sealed seed, or `null` when this device has none yet (first run).
   *
   * @throws MissingKeystoreEntryException when the file exists and the Keystore entry that
   *   seals it is gone: an identity that can never be read again.
   */
  fun read(file: File): ByteArray? {
    if (!file.isFile) {
      return null
    }
    val payload = file.readBytes()
    try {
      if (payload.size <= IV_BYTES || payload.size > MAX_PAYLOAD_BYTES) {
        throw IllegalStateException("the sealed device key file has an impossible size")
      }
      val iv = payload.copyOfRange(0, IV_BYTES)
      val ciphertext = payload.copyOfRange(IV_BYTES, payload.size)
      try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, existingKey(), GCMParameterSpec(TAG_BITS, iv))
        return cipher.doFinal(ciphertext)
      } finally {
        ciphertext.fill(0)
      }
    } finally {
      payload.fill(0)
    }
  }

  /** Seal `seed` and replace the file atomically (write to `.tmp`, then rename). */
  fun write(file: File, seed: ByteArray) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, ensureKey())
    val ciphertext = cipher.doFinal(seed)
    val payload = cipher.iv + ciphertext
    val temporary = File(file.parentFile, "${file.name}.tmp")
    try {
      temporary.writeBytes(payload)
      if (!temporary.renameTo(file)) {
        temporary.delete()
        throw IllegalStateException("the sealed device key could not be moved into place")
      }
    } finally {
      payload.fill(0)
      ciphertext.fill(0)
    }
  }

  /** Delete the sealed seed (used when a screen offers to forget this device). */
  fun delete(file: File) {
    if (file.isFile) {
      file.delete()
    }
    val temporary = File(file.parentFile, "${file.name}.tmp")
    if (temporary.isFile) {
      temporary.delete()
    }
  }

  /** The keystore entry, or an honest failure when there is none. */
  private fun existingKey(): SecretKey {
    val entry = keyStore().getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
      ?: throw MissingKeystoreEntryException(
        "the AndroidKeyStore entry for the device key is missing",
      )
    return entry.secretKey
  }

  /** The keystore entry, generated on first use; its bytes stay inside the keystore. */
  private fun ensureKey(): SecretKey {
    val store = keyStore()
    (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(false)
        .build(),
    )
    return generator.generateKey()
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
}
