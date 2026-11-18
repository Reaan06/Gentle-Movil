package com.gentlemovil.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * Expo native module wrapping the Rust core (`libmobile_core.so`).
 *
 * Design rules (deliverable of the V3/V4 slice):
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
 *
 * The JNI wrapper symbols the core must export for this module are listed in
 * `modules/gentle-core/README.md`.
 */
class GcCoreModule : Module() {
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
    AsyncFunction("deviceKeyGenerate") { payloadJson: String -> dispatch("gc_device_key_generate", payloadJson) }
  }

  /** Called on the module queue; every failure path returns an envelope. */
  private fun dispatch(fn: String, payloadJson: String): String {
    if (!GcNative.available) {
      return unavailableEnvelope(GcNative.failure)
    }
    val payload = payloadJson.ifBlank { "{}" }
    return try {
      val response = when (fn) {
        "gc_abi_version" -> GcNative.gcAbiVersion()
        "gc_pair_from_qr" -> GcNative.gcPairFromQr(payload)
        "gc_ssh_connect" -> GcNative.gcSshConnect(payload)
        "gc_provision_step" -> GcNative.gcProvisionStep(payload)
        "gc_device_key_generate" -> GcNative.gcDeviceKeyGenerate(payload)
        else -> return failureEnvelope("UnknownFunction", "El núcleo no expone «$fn».")
      }
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
}
