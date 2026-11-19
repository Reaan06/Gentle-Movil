/**
 * SEC-004 — the pure recovery decision of `deviceKeyEnsure` when the sealed seed and the
 * AndroidKeyStore entry disagree.
 *
 * ## The defect this closes
 *
 * `deviceKeyEnsure` used to read the sealed seed and, when the Keystore entry was missing,
 * fail with an opaque `KeystoreUnavailable` **forever**: `read()` throws, the file stays,
 * every later call throws the same way, and the phone can never pair again. That state is
 * exactly what a restore produces — the ciphertext lives in the app's files directory (and
 * `allowBackup` shipped it off-device), while a Keystore key is non-exportable and cannot be
 * restored. Ciphertext without its key is not an identity: it is garbage.
 *
 * `allowBackup: false` (`mobile/app.json`, SEC-004) removes the main cause, and this
 * decision makes the leftovers recoverable: **ciphertext present + Keystore entry gone means
 * "no key"** — delete the stale ciphertext, mint fresh, log the real cause and answer the new
 * public key.
 *
 * ## What is deliberately NOT recovered
 *
 * A ciphertext that is present, whose Keystore entry is present, and that fails to decrypt
 * (truncated file, broken GCM tag) stays a typed failure. Silently minting a new identity
 * there would rotate the phone's key behind the user's back and leave the host with an
 * `authorized_keys` line nobody can satisfy; the user has to be told, not "helped".
 *
 * ## Where it is enforced
 *
 * The device decision is Kotlin: `GcCoreModule.deviceKeyEnsure` +
 * `DeviceSeedStore.hasKeyEntry()`. This file is the same table in plain TypeScript so
 * `mobile/test/core-abi.test.mjs` can pin it without an Android toolchain; the Kotlin and
 * this module must agree on the actions, the reasons and the log line below.
 */

/** Why an identity is being minted, as the recovery decision sees it. */
export type SeedMintReason = 'no-sealed-seed' | 'keystore-entry-gone';

/** What `deviceKeyEnsure` has to do with the storage it found. */
export type SeedLoadDecision =
  | { readonly action: 'read-sealed-seed' }
  | {
      readonly action: 'mint-fresh-identity';
      readonly reason: SeedMintReason;
      /** True when the stale ciphertext must be deleted before minting. */
      readonly discardCiphertext: boolean;
    }
  | { readonly action: 'report-unreadable'; readonly reason: 'unreadable-sealed-seed' };

/** What the caller observed on the device for one `deviceKeyEnsure` call. */
export interface SeedStorageState {
  /** A `device-key.seed` ciphertext exists in the app's private directory. */
  readonly ciphertextPresent: boolean;
  /** The AndroidKeyStore entry that seals it exists (non-exportable, never restorable). */
  readonly keystoreEntryPresent: boolean;
  /**
   * Whether the ciphertext decrypted with that entry. Only meaningful when both are
   * present; defaults to `true` so the plain "what do I have here" question needs two flags.
   */
  readonly ciphertextReadable?: boolean;
}

/**
 * Real cause of a discarding mint, logged once by the native layer.
 *
 * Verbatim in `GcCoreModule.kt`: it names the state, never the seed. `DeviceSeedStore` and
 * its key alias are named so a device report is actionable.
 */
export const KEYSTORE_ENTRY_GONE_LOG =
  'device key: sealed ciphertext present but the AndroidKeyStore entry is gone ' +
  '(restore or cleared keystore) — discarding the stale ciphertext and minting a new identity';

/**
 * The recovery table, in one function:
 *
 * | ciphertext | Keystore entry | decrypts | decision |
 * |---|---|---|---|
 * | no | any | — | `mint-fresh-identity` (`no-sealed-seed`, nothing to discard) |
 * | yes | no | — | `mint-fresh-identity` (`keystore-entry-gone`, **discard the ciphertext**) |
 * | yes | yes | yes | `read-sealed-seed` |
 * | yes | yes | no | `report-unreadable` — never a silent rotation |
 */
export function decideSeedLoad(state: SeedStorageState): SeedLoadDecision {
  const ciphertextPresent = state?.ciphertextPresent === true;
  const keystoreEntryPresent = state?.keystoreEntryPresent === true;
  if (!ciphertextPresent) {
    // First run, or a previous discarding mint already cleaned up. Nothing to delete.
    return { action: 'mint-fresh-identity', reason: 'no-sealed-seed', discardCiphertext: false };
  }
  if (!keystoreEntryPresent) {
    // Ciphertext without its non-exportable key: unrecoverable by construction.
    return {
      action: 'mint-fresh-identity',
      reason: 'keystore-entry-gone',
      discardCiphertext: true,
    };
  }
  if (state?.ciphertextReadable === false) {
    return { action: 'report-unreadable', reason: 'unreadable-sealed-seed' };
  }
  return { action: 'read-sealed-seed' };
}
