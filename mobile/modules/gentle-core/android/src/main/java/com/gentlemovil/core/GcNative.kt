package com.gentlemovil.core

/**
 * JNI surface of the Rust core (`mobile-core`, `libmobile_core.so`).
 *
 * The library is loaded once, inside a `try/catch`: when `libmobile_core.so`
 * is not packed into the APK (the normal state until the core worker delivers
 * it), `System.loadLibrary` throws `UnsatisfiedLinkError`. That case is NOT a
 * crash — [available] stays `false`, [failure] keeps the reason, and the Expo
 * module answers every call with a `CoreUnavailable` envelope so the UI shows
 * its honest failure state (and the logger records it).
 *
 * Every function below takes/returns a JSON document as a UTF-8 string; the
 * JNI wrappers that must be exported by the core are listed in the module
 * README (`modules/gentle-core/README.md`) because the JVM names are mangled.
 */
internal object GcNative {
  private const val LIBRARY = "mobile_core"

  /** True when `libmobile_core.so` loaded into this process. */
  val available: Boolean

  /** Reason the library could not load (`null` when it loaded). */
  var failure: String? = null
    private set

  init {
    var loaded = false
    try {
      System.loadLibrary(LIBRARY)
      loaded = true
    } catch (error: Throwable) {
      failure = "${error.javaClass.simpleName}: ${error.message ?: "sin detalle"}"
    }
    available = loaded
  }

  /** `char* gc_abi_version(void)` — JSON descriptor of the frozen ABI. */
  external fun gcAbiVersion(): String?

  /** `char* gc_pair_from_qr(const char* json)` — parses a `gc://pair?…` URI. */
  external fun gcPairFromQr(json: String): String?

  /** `char* gc_ssh_connect(const char* json)` — opens the SSH session. */
  external fun gcSshConnect(json: String): String?

  /** `char* gc_provision_step(const char* json)` — one daemon-provisioning step. */
  external fun gcProvisionStep(json: String): String?

  /** `char* gc_device_key_generate(const char* json)` — phone ed25519 identity. */
  external fun gcDeviceKeyGenerate(json: String): String?

  /**
   * `void gc_free(char* pointer)` — releases a `char*` allocated by the core.
   *
   * Not called from Kotlin: JSON documents cross JNI as copies (the wrapper
   * converts the `char*` to a `jstring` and frees it), so the pointer never
   * reaches the Java heap. Declared because the ABI freezes it.
   */
  external fun gcFree(pointer: Long)
}
