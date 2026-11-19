package com.gentlemovil.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Expo native module wrapping the Rust core (`libmobile_core.so`).
 *
 * Design rules:
 *
 * 1. **Never crash.** `GcNative` loads the library inside `try/catch`; every
 *    call is additionally wrapped here, so a missing `.so` (or a JNI symbol the
 *    core has not exported yet) becomes the envelope
 *    `{"ok":false,"error":{"kind":"CoreUnavailable",…}}` instead of a fatal
 *    `UnsatisfiedLinkError`. The TS facade and `lib/provision.ts` turn that
 *    envelope into the failure state the pairing screen paints.
 * 2. **Strings only.** Every argument/return value is a JSON document. The TS
 *    side owns the schemas (`lib/provision.ts`), the core owns validation.
 * 3. **Off the JS thread.** `AsyncFunction` runs on the module queue, so a
 *    120-second daemon upload never blocks the UI thread.
 * 4. **The device seed never reaches JS** (SEC-001). The seed-bearing symbols —
 *    `gc_device_key_generate`, `gc_device_key_public`, `gc_ssh_connect_seed` — are
 *    reachable **only** from this class ([invoke]), never from the JS whitelist
 *    ([jsReachableFunctions]): `callGc` answers `UnknownFunction` for them. The
 *    only JS-facing identity call is `deviceKeyEnsure`, which mints the seed
 *    once, seals it with the AndroidKeystore key of [DeviceSeedStore] and answers
 *    `{publicHex, fingerprint}`. See `docs/mobile-protocol-spec.md` §2.1.
 * 5. **The file root is a privilege, not a parameter** (SEC-003). `gc_fs_list` and
 *    `gc_fs_read` take a root from the caller, so [guardFileRoot] resolves it and
 *    [FsRoots] allows only the app's private directories.
 * 6. **No payload in the log.** `dispatch` logs the function name, whether it
 *    succeeded and, on failure, the error kind — never the answer body, because
 *    the mint answer carries key material.
 *
 * The JNI wrapper symbols the core must export for this module are listed in
 * `modules/gentle-core/README.md`.
 */
class GcCoreModule : Module() {

  /**
   * The **JS-reachable** function names — the frozen whitelist of `callGc`, and nothing else.
   *
   * It is deliberately smaller than the C ABI: the seed symbols are excluded because their
   * answers (or their inputs) are the device's private key, and the rejection lives here, in
   * the producer, instead of in a TS consumer that a new import could skip (SEC-001).
   * `mobile/test/core-abi.test.mjs` reads this set out of the source and fails if it grows.
   */
  private val jsReachableFunctions: Set<String> = setOf(
    "gc_abi_version",
    "gc_pair_from_qr",
    "gc_ssh_connect",
    "gc_ssh_close",
    "gc_provision_step",
    "gc_fs_list",
    "gc_fs_read",
    "gc_ssh_channel_write",
    "gc_ssh_channel_read",
    "gc_ssh_channel_close",
  )

  /** Payload a checked call may forward, or the refusal that stops it. */
  private sealed class Forwarding {
    class Forward(val payload: String) : Forwarding()
    class Refuse(val kind: String, val message: String) : Forwarding()
  }

  override fun definition() = ModuleDefinition {
    Name("GentleCore")

    /** True when `libmobile_core.so` is packed in this build. */
    Function("isCoreAvailable") { GcNative.available }

    /** Empty string when the core is available; the load error otherwise. */
    Function("coreUnavailableReason") { GcNative.failure ?: "" }

    /**
     * Single entry point of the typed facade: `callGc(fn, payloadJson)`.
     *
     * `fn` is whitelisted (a random string never reaches JNI) and maps 1:1 to
     * the `gc_*` symbols of the C ABI.
     */
    AsyncFunction("callGc") { fn: String, payloadJson: String -> dispatch(fn, payloadJson) }

    /** Typed convenience overloads of `callGc` for the pairing screens. */
    AsyncFunction("abiVersion") { dispatch("gc_abi_version", "{}") }
    AsyncFunction("pairFromQr") { uri: String ->
      dispatch("gc_pair_from_qr", JSONObject().put("uri", uri).toString())
    }
    AsyncFunction("sshConnect") { payloadJson: String -> dispatch("gc_ssh_connect", payloadJson) }
    AsyncFunction("provisionStep") { payloadJson: String -> dispatch("gc_provision_step", payloadJson) }

    /**
     * ABI v2 (T16/T18). The frozen names of `mobile/modules/gentle-core/src/abi.ts`.
     *
     * `deviceKeyEnsure` and `sshConnectWithDeviceKey` are the only two that touch the
     * seed, and both keep it inside the Keystore boundary; the other three are plain
     * pass-throughs to the `gc_*` symbols.
     */
    AsyncFunction("deviceKeyEnsure") { payloadJson: String -> deviceKeyEnsure(payloadJson) }
    AsyncFunction("sshConnectWithDeviceKey") { payloadJson: String ->
      sshConnectWithDeviceKey(payloadJson)
    }
    AsyncFunction("sshClose") { payloadJson: String -> dispatch("gc_ssh_close", payloadJson) }
    AsyncFunction("fsList") { payloadJson: String -> dispatch("gc_fs_list", payloadJson) }
    AsyncFunction("fsRead") { payloadJson: String -> dispatch("gc_fs_read", payloadJson) }

    /**
     * Tunnel channel I/O (S4): the app speaks HTTP/WS through the channels the
     * `tunnel` step opened. Documents carry both handles, so the JNI shim splits
     * `sessionId`/`channelId` out exactly like it does for `provisionStep`.
     */
    AsyncFunction("sshChannelWrite") { payloadJson: String ->
      dispatch("gc_ssh_channel_write", payloadJson)
    }
    AsyncFunction("sshChannelRead") { payloadJson: String ->
      dispatch("gc_ssh_channel_read", payloadJson)
    }
    AsyncFunction("sshChannelClose") { payloadJson: String ->
      dispatch("gc_ssh_channel_close", payloadJson)
    }
  }

  /**
   * The **JS-facing** entry point: whitelist, then the file-root guard, then [invoke].
   *
   * Called on the module queue; every failure path returns an envelope.
   */
  private fun dispatch(fn: String, payloadJson: String): String {
    if (!GcNative.available) {
      return unavailableEnvelope(GcNative.failure)
    }
    val payload = payloadJson.ifBlank { "{}" }
    if (fn !in jsReachableFunctions) {
      // SEC-001: this is where the seed symbols die for JS callers, before JNI.
      return failureEnvelope("UnknownFunction", "El núcleo no expone «$fn».")
    }
    val guarded = try {
      guardFileRoot(fn, payload)
    } catch (error: Throwable) {
      // Rule 1: nothing escapes as an exception. Class only, never the body.
      return failureEnvelope("NativeError", error.javaClass.simpleName)
    }
    return when (guarded) {
      is Forwarding.Refuse -> failureEnvelope(guarded.kind, guarded.message)
      is Forwarding.Forward -> invoke(fn, guarded.payload)
    }
  }

  /**
   * SEC-003: resolves the root of a file request and swaps in its canonical path.
   *
   * Every other function is forwarded untouched. A refused root is answered with the
   * typed failure [FsRoots] built (real root + real allowed roots), never with a silent
   * fallback to a directory the caller did not ask for.
   */
  private fun guardFileRoot(fn: String, payload: String): Forwarding {
    if (fn != "gc_fs_list" && fn != "gc_fs_read") {
      return Forwarding.Forward(payload)
    }
    val document = try {
      JSONObject(payload)
    } catch (error: Throwable) {
      // Class only: the body may be anything, and echoing it is how payloads leak to logs.
      return Forwarding.Refuse(
        FsRoots.KIND_INVALID_PATH,
        "El pedido a «$fn» no es un documento JSON legible (${error.javaClass.simpleName}).",
      )
    }
    val context = appContext.reactContext
      ?: return Forwarding.Refuse(
        FsRoots.KIND_OUTSIDE_ROOT,
        "No hay contexto de aplicación para resolver qué carpetas puede leer la app.",
      )
    return when (val decision = FsRoots.decide(document.optString("root", ""), FsRoots.allowedRoots(context))) {
      is FsRoots.Decision.Allowed ->
        Forwarding.Forward(document.put("root", decision.root.absolutePath).toString())
      is FsRoots.Decision.Rejected -> Forwarding.Refuse(decision.kind, decision.message)
    }
  }

  /**
   * The native call itself — **not** a JS boundary.
   *
   * Only [dispatch] (after the whitelist) and this class' own seed paths ([deviceKeyEnsure],
   * [sshConnectWithDeviceKey], [mintSeed]) call it, which is what keeps the seed symbols out
   * of JS while the internal mint keeps working.
   */
  private fun invoke(fn: String, payload: String): String {
    if (!GcNative.available) {
      return unavailableEnvelope(GcNative.failure)
    }
    return try {
      val response = when (fn) {
        "gc_abi_version" -> GcNative.gcAbiVersion()
        "gc_pair_from_qr" -> GcNative.gcPairFromQr(payload)
        "gc_ssh_connect" -> GcNative.gcSshConnect(payload)
        "gc_ssh_connect_seed" -> GcNative.gcSshConnectSeed(payload)
        "gc_ssh_close" -> GcNative.gcSshClose(payload)
        "gc_provision_step" -> GcNative.gcProvisionStep(payload)
        "gc_device_key_generate" -> GcNative.gcDeviceKeyGenerate(payload)
        "gc_device_key_public" -> GcNative.gcDeviceKeyPublic(payload)
        "gc_fs_list" -> GcNative.gcFsList(payload)
        "gc_fs_read" -> GcNative.gcFsRead(payload)
        "gc_ssh_channel_write" -> GcNative.gcSshChannelWrite(payload)
        "gc_ssh_channel_read" -> GcNative.gcSshChannelRead(payload)
        "gc_ssh_channel_close" -> GcNative.gcSshChannelClose(payload)
        else -> return failureEnvelope("UnknownFunction", "El núcleo no expone «$fn».")
      }
      // Diagnostic **without** the body: `gc_device_key_generate` answers with the device
      // seed, so a raw dump here would put the private key in `adb logcat` (T16). The
      // function name, whether it worked and the failure kind are enough to debug a call.
      android.util.Log.d(LOG_TAG, "$fn ${describeAnswer(response)}")
      if (response.isNullOrBlank()) {
        failureEnvelope("EmptyResponse", "El núcleo no devolvió nada para «$fn».")
      } else {
        response
      }
    } catch (link: UnsatisfiedLinkError) {
      // The library loaded but the JNI symbol is missing (core not wired yet).
      unavailableEnvelope(link.message ?: link.javaClass.simpleName)
    } catch (error: Throwable) {
      failureEnvelope("NativeError", "${error.javaClass.simpleName}: ${error.message ?: "sin detalle"}")
    }
  }

  /**
   * One-line description of an answer that never contains it.
   *
   * `ok=true` / `ok=false kind=<kind>` is what a `raw=<…120 chars>` line used to be for,
   * without handing key material to the log.
   */
  private fun describeAnswer(response: String?): String {
    if (response == null) {
      return "answer=NULL"
    }
    if (response.isBlank()) {
      return "answer=EMPTY"
    }
    return try {
      val document = JSONObject(response)
      if (document.optBoolean("ok", false)) {
        "ok=true"
      } else {
        val kind = document.optJSONObject("error")?.optString("kind").orEmpty()
        "ok=false kind=" + kind.ifEmpty { "unknown" }
      }
    } catch (error: Throwable) {
      // Unparsable answers are reported by class only: echoing the text is the leak.
      "answer=UNPARSEABLE (" + error.javaClass.simpleName + ")"
    }
  }

  /** File, inside the app's private directory, that holds the sealed device seed. */
  private fun seedFile(): File? {
    val context = appContext.reactContext ?: return null
    return File(context.filesDir, DeviceSeedStore.FILE_NAME)
  }

  /**
   * `deviceKeyEnsure` — the phone identity, minted once and never handed to JS.
   *
   * First call: `gc_device_key_generate` mints the pair, [DeviceSeedStore] seals the seed
   * and `gc_device_key_public` derives the answer from it. Later calls: the seed is read
   * back from the Keystore, so the **same** public key and fingerprint come out. A ciphertext
   * whose Keystore entry is gone is treated as "no key" ([seedForIdentity], SEC-004).
   *
   * The answer is `{"ok":true,"result":{"publicHex","fingerprint"}}`; the seed is in no
   * part of it, in no log line and zeroed as soon as this call is done.
   */
  private fun deviceKeyEnsure(payloadJson: String): String {
    if (!GcNative.available) {
      return unavailableEnvelope(GcNative.failure)
    }
    val file = seedFile()
      ?: return failureEnvelope(
        "KeystoreUnavailable",
        "No hay contexto de aplicación para guardar la clave del dispositivo.",
      )
    var secret: ByteArray? = null
    return try {
      val seed = seedForIdentity(file)
      secret = seed
      // One seed-bearing document is the ABI's shape (`{"seed":[..]}`); the byte array we
      // own is wiped below, and the JSON string is never stored, logged or re-serialized.
      invoke("gc_device_key_public", seedRequest(seed).toString())
    } catch (error: Throwable) {
      // Class only: a JSONException message can quote the document it choked on, and for
      // the generate answer that document holds the seed.
      seedFailure(error, "abrir la clave del dispositivo")
    } finally {
      secret?.fill(0)
    }
  }

  /**
   * SEC-004 — the recovery table, in one place.
   *
   * | sealed ciphertext | Keystore entry | decision |
   * |---|---|---|
   * | no | — | mint (first run: nothing to discard) |
   * | yes | gone | **delete the stale ciphertext, log the real cause, mint fresh** |
   * | yes | present | read it; an undecryptable file stays a typed failure (never a silent rotation) |
   *
   * The table's testable specification is `modules/gentle-core/src/seed-recovery.ts`
   * (`decideSeedLoad`); this is the same three cases over [DeviceSeedStore]. A restore brings
   * the ciphertext back and can never bring the non-exportable Keystore key back, so without
   * this the phone's identity would be unreadable forever instead of merely new.
   */
  private fun seedForIdentity(file: File): ByteArray {
    if (!file.isFile) {
      return mintSeed(file)
    }
    return try {
      DeviceSeedStore.read(file) ?: mintSeed(file)
    } catch (error: DeviceSeedStore.MissingKeystoreEntryException) {
      // The real cause, and never key material: the log names the state, not the seed.
      android.util.Log.w(LOG_TAG, KEYSTORE_ENTRY_GONE_LOG)
      DeviceSeedStore.delete(file)
      mintSeed(file)
    }
  }

  /**
   * `sshConnectWithDeviceKey` — reconnect with the sealed device key, pinned to the host.
   *
   * The document the TS side sends is `{host, port, user, expectedFp}`; the seed is added
   * here, read from the Keystore, and `gc_ssh_connect_seed` refuses the call without a pin.
   */
  private fun sshConnectWithDeviceKey(payloadJson: String): String {
    if (!GcNative.available) {
      return unavailableEnvelope(GcNative.failure)
    }
    val file = seedFile()
      ?: return failureEnvelope(
        "KeystoreUnavailable",
        "No hay contexto de aplicación para leer la clave del dispositivo.",
      )
    var secret: ByteArray? = null
    return try {
      val payload = JSONObject(payloadJson.ifBlank { "{}" })
      val expectedFingerprint = payload.optString("expectedFp", "").trim()
      if (expectedFingerprint.isEmpty()) {
        return failureEnvelope(
          "Input",
          "Falta expectedFp: una conexión solo con llave tiene que estar fijada a la huella del host emparejado.",
        )
      }
      val seed = DeviceSeedStore.read(file)
        ?: return failureEnvelope(
          "MissingDeviceKey",
          "Todavía no hay una clave de dispositivo en este teléfono; hay que emparejarlo primero.",
        )
      secret = seed
      val request = JSONObject()
        .put("host", payload.optString("host", ""))
        .put("port", payload.optInt("port", 22))
        .put("user", payload.optString("user", ""))
        .put("expectedFp", expectedFingerprint)
        .put("seed", seedArray(seed))
      invoke("gc_ssh_connect_seed", request.toString())
    } catch (error: Throwable) {
      seedFailure(error, "leer la clave del dispositivo")
    } finally {
      secret?.fill(0)
    }
  }

  /** Mint the identity once and seal it; answers the raw 32-byte seed. */
  private fun mintSeed(file: File): ByteArray {
    val answer = invoke("gc_device_key_generate", "{}")
    val document = JSONObject(answer)
    if (!document.optBoolean("ok", false)) {
      val error = document.optJSONObject("error")
      throw IllegalStateException(
        "gc_device_key_generate failed: " + (error?.optString("kind") ?: "unknown"),
      )
    }
    val secret = document.optJSONObject("key")?.optJSONObject("secret")
      ?: throw IllegalStateException("the core answered no secret to seal")
    val values = secret.optJSONArray("secret_seed")
      ?: throw IllegalStateException("the core answered no seed to seal")
    val seed = ByteArray(values.length()) { index ->
      (values.optInt(index, 0) and 0xff).toByte()
    }
    try {
      DeviceSeedStore.write(file, seed)
    } catch (error: Throwable) {
      seed.fill(0)
      throw error
    }
    return seed
  }

  /** `{seed:[..]}` document for `gc_device_key_public`. */
  private fun seedRequest(seed: ByteArray): JSONObject = JSONObject().put("seed", seedArray(seed))

  /** The seed as the JSON byte array the ABI reads (unsigned values). */
  private fun seedArray(seed: ByteArray): JSONArray {
    val values = JSONArray()
    seed.forEach { byte -> values.put(byte.toInt() and 0xff) }
    return values
  }

  /**
   * Envelope for a Keystore/seed failure: names the step and the exception class only.
   *
   * Never the exception message: `JSONException` quotes the document it failed on, and for
   * the mint path that document contains the seed (T16 — the seed must not appear in any
   * error message).
   */
  private fun seedFailure(error: Throwable, step: String): String =
    failureEnvelope(
      "KeystoreUnavailable",
      "No se pudo $step (${error.javaClass.simpleName}).",
    )

  private fun unavailableEnvelope(reason: String?): String =
    buildEnvelope(
      kind = "CoreUnavailable",
      message =
        "libmobile_core.so no está disponible en esta build" +
          (reason?.let { " ($it)" } ?: "") +
          ". El emparejamiento sigue cuando el núcleo esté empaquetado.",
    )

  private fun failureEnvelope(kind: String, message: String): String =
    buildEnvelope(kind = kind, message = message)

  /** `{"ok":false,"error":{"kind","message"},"raw":null}` without `JSONObject` tricks. */
  private fun buildEnvelope(kind: String, message: String): String =
    JSONObject()
      .put("ok", false)
      .put(
        "error",
        JSONObject()
          .put("kind", kind)
          .put("message", message),
      )
      .put("raw", null)
      .toString()

  private companion object {
    /** Logcat tag of the native module. */
    const val LOG_TAG = "GcCore"

    /**
     * Real cause of a discarding mint (SEC-004), logged once.
     *
     * Verbatim twin of `KEYSTORE_ENTRY_GONE_LOG` in `modules/gentle-core/src/seed-recovery.ts`.
     * Names the state and the store, never the seed.
     */
    const val KEYSTORE_ENTRY_GONE_LOG =
      "device key: sealed ciphertext present but the AndroidKeyStore entry is gone " +
        "(restore or cleared keystore) — discarding the stale ciphertext and minting a new identity"
  }
}
