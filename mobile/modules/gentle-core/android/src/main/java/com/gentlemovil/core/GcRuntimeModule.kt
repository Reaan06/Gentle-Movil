package com.gentlemovil.core

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo native module of the bundled phone runtime (T9a): `runNode` and
 * `runGentleAi` exec the two binaries the APK ships as libraries, out of
 * `ApplicationInfo.nativeLibraryDir`.
 *
 * Design rules, the same ones `GcCoreModule` follows:
 *
 * 1. **Never crash.** `GcRuntimePackage` turns every failure (no context, libs
 *    not extracted, binary absent, no exec bit, spawn error, timeout) into the
 *    envelope `{"ok":false,"exitCode":null|N,"stdout":"…","stderr":"…","error":{"kind","message"}}`,
 *    so the TS layer can paint the honest state instead of hitting an exception.
 * 2. **argv only.** `args` is a list of strings handed to `ProcessBuilder` as-is:
 *    there is no shell, so nothing interpolates.
 * 3. **Off the JS thread.** `AsyncFunction` runs on the module queue, so a
 *    30-second `node` call never blocks the UI thread.
 * 4. **Bounded.** `timeoutMs` is clamped to [1 s, 10 min] and the process is
 *    killed on expiry (`GcRuntimePackage.MAX_TIMEOUT_MS`).
 *
 * `runtimeInfo` is the diagnostic entry point: it answers the resolved
 * `nativeLibraryDir`, whether the APK was packaged with extraction enabled, and
 * whether each binary exists and is executable. A device report is
 * `adb logcat -s GcRuntime` plus that answer.
 */
class GcRuntimeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GentleRuntime")

    /** Where the runtime is and whether it is usable; never throws. */
    AsyncFunction("runtimeInfo") { GcRuntimePackage.info(applicationContext()) }

    /** Execs `nativeLibraryDir/libnode.so` with `args` (argv, no shell). */
    AsyncFunction("runNode") { args: List<String>, timeoutMs: Int ->
      GcRuntimePackage.run(applicationContext(), GcRuntimePackage.NODE, args, timeoutMs)
    }

    /** Execs `nativeLibraryDir/libgentle_ai.so` with `args`. */
    AsyncFunction("runGentleAi") { args: List<String>, timeoutMs: Int ->
      GcRuntimePackage.run(applicationContext(), GcRuntimePackage.GENTLE_AI, args, timeoutMs)
    }
  }

  /** Application context, or `null` before Expo holds a React context. */
  private fun applicationContext() = appContext.reactContext?.applicationContext
}
