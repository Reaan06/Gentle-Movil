package com.gentlemovil.core

import android.content.Context
import android.os.Build
import java.io.File
import java.io.InputStream
import org.json.JSONObject

/**
 * Execution engine of the bundled phone runtime (T9a): runs `libnode.so` and
 * `libgentle_ai.so` out of `ApplicationInfo.nativeLibraryDir`.
 *
 * Why this shape (validated by the device spike, `odd/tasks/mobile-app.md` T9a):
 *
 * 1. **Executables must come from the APK.** Since targetSdk 29 SELinux refuses
 *    to execute a file the app wrote to its own data dir (W^X), so the binaries
 *    are packed as `lib/<abi>/libnode.so` / `libgentle_ai.so` and the package
 *    manager extracts them into `nativeLibraryDir` — the one place an app may
 *    spawn from. `scripts/fetch-runtime.sh` builds that set.
 * 2. **`LD_LIBRARY_PATH` = `nativeLibraryDir`.** The Termux build of node needs
 *    `libc++_shared.so`, `libcares.so`, `libcrypto.so`, `libssl.so`,
 *    `libicuuc.so`, `libicui18n.so`, `libicudata.so`, `libsqlite3.so` and
 *    `libz.so`; they are packed next to the binaries and the loader finds each
 *    DT_NEEDED by that plain file name in the first directory of the path.
 * 3. **argv only.** The command line is `[binary, …args]`; there is no shell
 *    anywhere, so nothing a JS caller passes is ever interpreted.
 * 4. **Bounded.** Every call has a timeout (clamped to [1 s, 10 min]); on expiry
 *    the process is killed and the answer is `{"error":{"kind":"Timeout"}}`.
 *    Each stream is capped at 1 MiB so a runaway child cannot OOM the app.
 * 5. **Never throws.** Every failure path answers the same envelope as
 *    `GcCoreModule`:
 *    `{"ok":false,"exitCode":null|N,"stdout":"…","stderr":"…","error":{"kind","message"}}`.
 *    `mobile/modules/gentle-core/src/runtime.ts` maps the `kind` to the typed
 *    failure the UI renders, through the test suite in
 *    `mobile/test/runtime.test.mjs`.
 *
 * Diagnostics live in `runtimeInfo()`, which answers the resolved paths and
 * whether each binary exists and is executable — that is what a device report
 * (`adb logcat -s GcRuntime`) shows when something is missing.
 */
internal object GcRuntimePackage {
  /** The node binary, packed as a library so Android lets the app exec it. */
  const val NODE = "libnode.so"

  /** The `gentle-ai` binary, packed the same way. */
  const val GENTLE_AI = "libgentle_ai.so"

  /** Timeout used when a caller passes something unusable. */
  const val DEFAULT_TIMEOUT_MS = 30_000

  /** Floor: a call under a second cannot even start node. */
  const val MIN_TIMEOUT_MS = 1_000

  /** Ceiling: a call longer than 10 minutes is a bug, not a slow install. */
  const val MAX_TIMEOUT_MS = 600_000

  /** Per-stream cap; beyond this the output is discarded (and flagged). */
  private const val MAX_STREAM_BYTES = 1 shl 20

  /** How long a killed process gets before we stop waiting for its pipes. */
  private const val KILL_GRACE_MS = 2_000L

  /** Polling interval of the exit check (no `Process.waitFor(timeout)`: API 26). */
  private const val POLL_MS = 25L

  private const val LOG_TAG = "GcRuntime"

  /**
   * Resolved runtime state: where the binaries are, whether they exist and
   * whether they can be executed. Answers an envelope like every other call.
   */
  fun info(context: Context?): String {
    if (context == null) {
      return failure("SpawnFailed", "La app no expuso un contexto para resolver el runtime.")
    }
    val directory = File(context.applicationInfo.nativeLibraryDir)
    val notExtracted = isPseudoPath(directory)
    return try {
      JSONObject()
        .put("ok", true)
        .put("nativeLibraryDir", directory.path)
        .put("extracted", !notExtracted)
        .put("timeoutMs", DEFAULT_TIMEOUT_MS)
        .put("node", describe(directory, NODE))
        .put("gentleAi", describe(directory, GENTLE_AI))
        .put("libraries", librariesIn(directory))
        .put("raw", JSONObject.NULL)
        .toString()
    } catch (error: Throwable) {
      failure("SpawnFailed", describeThrowable(error))
    }
  }

  /**
   * Runs `library` with `args` and answers the envelope. `context` is nullable
   * only so the module can answer a typed failure instead of throwing when Expo
   * has no React context yet.
   */
  fun run(context: Context?, library: String, args: List<String>, timeoutMs: Int): String {
    if (context == null) {
      return failure("SpawnFailed", "La app no expuso un contexto para ejecutar $library.")
    }
    val directory = File(context.applicationInfo.nativeLibraryDir)
    if (isPseudoPath(directory)) {
      // extractNativeLibs=false: nativeLibraryDir is "base.apk!/lib/<abi>" and
      // there is no file on disk to exec. This is a packaging bug, not a phone bug.
      val message = "El APK trae los binarios sin extraer (nativeLibraryDir=" + directory.path +
        "): empaquetá con android:extractNativeLibs=\"true\" (jniLibs.useLegacyPackaging = true)."
      return failure("NotExtracted", message)
    }
    val binary = File(directory, library)
    if (!binary.isFile) {
      return failure(
        "RuntimeMissing",
        "No está $library en ${directory.path}: el APK no incluye el runtime embebido.",
      )
    }
    if (!binary.canExecute()) {
      // The installer does not always keep the exec bit of a jniLibs entry.
      binary.setExecutable(true)
      if (!binary.canExecute()) {
        return failure(
          "NotExecutable",
          "El binario empaquetado $library no tiene permiso de ejecución en ${directory.path}.",
        )
      }
    }

    val bounded = timeoutMs.coerceIn(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    val command = ArrayList<String>(args.size + 1)
    command.add(binary.absolutePath)
    command.addAll(args)

    val builder = ProcessBuilder(command)
    builder.directory(context.filesDir)
    val environment = builder.environment()
    environment["LD_LIBRARY_PATH"] = directory.absolutePath
    environment["HOME"] = context.filesDir.absolutePath
    environment["TMPDIR"] = context.cacheDir.absolutePath
    environment["PATH"] = "${directory.absolutePath}:/system/bin:/system/xbin"
    environment["LANG"] = "C.UTF-8"
    // The app process must not leak a preload into the child.
    environment.remove("LD_PRELOAD")

    val process = try {
      builder.start()
    } catch (error: Throwable) {
      return failure("SpawnFailed", "No pudimos lanzar $library: ${describeThrowable(error)}")
    }

    val stdout = StreamDrainer(process.inputStream, "stdout")
    val stderr = StreamDrainer(process.errorStream, "stderr")
    stdout.start()
    stderr.start()

    val exitCode = waitForExit(process, bounded)
    if (exitCode == null) {
      kill(process)
      // Give the pipes a moment so the timeout answer is not fully empty.
      stdout.join(KILL_GRACE_MS)
      stderr.join(KILL_GRACE_MS)
      android.util.Log.w(LOG_TAG, "$library timed out after $bounded ms")
      return envelope(
        ok = false,
        exitCode = null,
        stdout = stdout.text(),
        stderr = stderr.text(),
        kind = "Timeout",
        message = "$library no terminó en $bounded ms y lo cortamos.",
        truncated = stdout.truncated || stderr.truncated,
      )
    }
    stdout.join(KILL_GRACE_MS)
    stderr.join(KILL_GRACE_MS)
    val out = stdout.text()
    val err = stderr.text()
    val truncated = stdout.truncated || stderr.truncated
    // Diagnostics for `adb logcat -s GcRuntime`: the argv length and the outcome.
    android.util.Log.d(
      LOG_TAG,
      "$library argc=${args.size} exit=$exitCode stdout=${out.length} stderr=${err.length}",
    )
    if (exitCode == 0) {
      return envelope(true, 0, out, err, null, null, truncated)
    }
    return envelope(
      ok = false,
      exitCode = exitCode,
      stdout = out,
      stderr = err,
      kind = "ExitCode",
      message = "$library terminó con código $exitCode${stderrTail(err)}.",
      truncated = truncated,
    )
  }

  /** Exit code, or `null` when the timeout expired first. */
  private fun waitForExit(process: Process, timeoutMs: Int): Int? {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (System.nanoTime() < deadline) {
      try {
        return process.exitValue()
      } catch (_: IllegalThreadStateException) {
        Thread.sleep(POLL_MS)
      }
    }
    return try {
      process.exitValue()
    } catch (_: IllegalThreadStateException) {
      null
    }
  }

  /** SIGTERM, then SIGKILL where the platform allows it (API 26+). */
  private fun kill(process: Process) {
    process.destroy()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      process.destroyForcibly()
    }
  }

  /** `nativeLibraryDir` is a pseudo path when the APK keeps its libs packed. */
  private fun isPseudoPath(directory: File): Boolean = directory.path.contains("!/")

  private fun describe(directory: File, library: String): JSONObject {
    val binary = File(directory, library)
    return JSONObject()
      .put("library", library)
      .put("path", binary.path)
      .put("exists", binary.isFile)
      .put("executable", binary.canExecute())
      .put("bytes", if (binary.isFile) binary.length() else 0)
  }

  private fun librariesIn(directory: File): List<String> {
    val names = directory.list() ?: return emptyList()
    return names.filter { it.endsWith(".so") }.sorted()
  }

  /** First `stderr` line, short enough to ride inside a message. */
  private fun stderrTail(stderr: String): String {
    val line = stderr.lineSequence().firstOrNull { it.isNotBlank() } ?: return ""
    val cleaned = line.trim().replace('\n', ' ')
    return if (cleaned.isEmpty()) "" else ": ${cleaned.take(200)}"
  }

  private fun describeThrowable(error: Throwable): String =
    "${error.javaClass.simpleName}: ${error.message ?: "sin detalle"}"

  private fun failure(kind: String, message: String): String =
    envelope(false, null, "", "", kind, message, false)

  private fun envelope(
    ok: Boolean,
    exitCode: Int?,
    stdout: String,
    stderr: String,
    kind: String?,
    message: String?,
    truncated: Boolean,
  ): String {
    val json = JSONObject()
      .put("ok", ok)
      .put("exitCode", exitCode ?: JSONObject.NULL)
      .put("stdout", stdout)
      .put("stderr", stderr)
      .put("truncated", truncated)
      .put("raw", JSONObject.NULL)
    if (kind != null) {
      json.put("error", JSONObject().put("kind", kind).put("message", message ?: ""))
    }
    return json.toString()
  }

  /**
   * Reads one stream to the end on its own thread (a child that fills a pipe
   * would otherwise block forever) and keeps at most [MAX_STREAM_BYTES].
   */
  private class StreamDrainer(private val stream: InputStream, private val name: String) : Thread(name) {
    private val buffer = StringBuilder()
    private val lock = Any()
    private var bytes = 0

    @Volatile
    var truncated: Boolean = false
      private set

    init {
      isDaemon = true
    }

    override fun run() {
      val chunk = ByteArray(8 * 1024)
      try {
        stream.use { input ->
          while (true) {
            val read = input.read(chunk)
            if (read <= 0) {
              break
            }
            // Keep reading after the cap so the child never blocks on write.
            if (bytes >= MAX_STREAM_BYTES) {
              truncated = true
              continue
            }
            val allowed = minOf(read, MAX_STREAM_BYTES - bytes)
            val text = String(chunk, 0, allowed, Charsets.UTF_8)
            synchronized(lock) { buffer.append(text) }
            bytes += allowed
            if (allowed < read) {
              truncated = true
            }
          }
        }
      } catch (_: Throwable) {
        // A killed process closes its pipes mid-read; the text so far is the answer.
      }
    }

    fun text(): String = synchronized(lock) { buffer.toString() }
  }
}
