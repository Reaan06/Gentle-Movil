package com.gentlemovil.core

import android.content.Context
import java.io.File
import java.io.IOException

/**
 * SEC-003 — the allowlist of roots the file ABI (`gc_fs_list` / `gc_fs_read`) may read.
 *
 * ## The rule
 *
 * The root is not a parameter chosen by the caller: it is a privilege. Before this slice
 * `GcCoreModule.dispatch` forwarded `root` from JavaScript straight to the native layer, so
 * `callGc('gc_fs_list', {"root":"etc"})` canonicalized against `/` and read `/etc`, and the
 * app's own private directory (`filesDir`, where the sealed device key lives) was reachable
 * from any JS in the runtime. [decide] is the single place that says yes or no, and it is
 * called from `GcCoreModule.dispatch` for **both** file symbols — that is the only way JS
 * reaches the native layer, so an AsyncFunction cannot be used to skip it.
 *
 * ## What is allowed
 *
 * Exactly the app's own private directories, canonicalized before comparison:
 * `Context.filesDir` and `Context.cacheDir`. A request is allowed when its **canonical**
 * path is one of those roots or sits below one on a path boundary — `/files-evil` is not
 * inside `/files`. Canonicalizing resolves symlinks first, so `files/../../etc` or a link
 * pointing outside is rejected rather than followed.
 *
 * ## SAF-granted trees
 *
 * The user-picked folders of the SAF flow do not exist yet (no `openDocumentTree` /
 * `takePersistableUriPermission` anywhere in the app), so they are **not** pretended to
 * work: [safGrantedRoots] is the single documented hook and it currently returns no roots.
 * When the picker lands, it registers the canonical `File` it resolved there — nothing else
 * in this object needs to change, and until then every SAF path is refused like any other
 * outside path.
 *
 * ## The refusal
 *
 * `invalid_path` for a root that cannot be resolved at all (empty, relative — a relative
 * root would resolve against `/`, carrying a NUL byte, climbing with `..`); `outside_root`
 * for a well-formed root that is not ours. Both messages name the real root and the real
 * allowed roots, and nothing is ever redirected to a "safe" fallback: a caller that asked
 * for the wrong directory has to learn which one was refused.
 *
 * The pure decision is pinned in plain node by `mobile/test/core-abi.test.mjs` against its
 * TypeScript twin `modules/gentle-core/src/fs-roots.ts` (same refusals, same kinds, same
 * messages); the canonical/symlink half only exists here, on the device.
 */
internal object FsRoots {
  /** Root refused because it cannot be resolved into an absolute, non-escaping path. */
  const val KIND_INVALID_PATH = "invalid_path"

  /** Root refused because it resolved to a directory the app does not own. */
  const val KIND_OUTSIDE_ROOT = "outside_root"

  /** Message of an empty root. Verbatim twin: `FS_ROOT_EMPTY_MESSAGE` in `src/fs-roots.ts`. */
  const val EMPTY_MESSAGE = "Falta la raíz absoluta desde la que se puede leer."

  /** Message of a NUL byte. Verbatim twin: `FS_ROOT_NUL_MESSAGE` in `src/fs-roots.ts`. */
  const val NUL_MESSAGE = "La raíz pedida trae un byte nulo, así que no se resuelve."

  /** Outcome of [decide]: the root as the core must receive it, or why it is refused. */
  sealed class Decision {
    /** [root] is the canonical directory the request may use. */
    class Allowed(val root: File) : Decision()

    /**
     * The request must not reach the core.
     *
     * [message] names the real root and the real allowed roots; [requested] and
     * [allowedRoots] are kept so the caller can log the evidence without re-parsing it.
     */
    class Rejected(
      val kind: String,
      val message: String,
      val requested: String,
      val allowedRoots: List<String>,
    ) : Decision()
  }

  /** The roots this app may read, canonicalized. The only source of truth for the allowlist. */
  fun allowedRoots(context: Context): List<File> =
    privateRoots(context) + safGrantedRoots(context)

  /**
   * Hook for the SAF trees the user grants in the future.
   *
   * Empty on purpose: there is no picker and no persisted grant yet, so claiming these
   * roots work would be a lie told to the UI. The day the picker lands it returns the
   * canonical `File`s of the granted trees and every other rule here stays untouched.
   */
  private fun safGrantedRoots(@Suppress("UNUSED_PARAMETER") context: Context): List<File> =
    emptyList()

  /** The app's own private directories: the files it owns and its temp scratch. */
  private fun privateRoots(context: Context): List<File> =
    listOf(context.filesDir, context.cacheDir)

  /**
   * Allows [requested] only when it is (inside) one of [allowedRoots].
   *
   * Order matters and is the same as `decideFsRoot` in `src/fs-roots.ts`: shape first
   * (absolute, no NUL, no `..`), then canonicalization (symlinks and `..` already resolved,
   * device only), then membership.
   */
  fun decide(requested: String, allowedRoots: List<File>): Decision {
    val requestedRoot = requested.trim()
    if (requestedRoot.isEmpty()) {
      return Decision.Rejected(KIND_INVALID_PATH, EMPTY_MESSAGE, requestedRoot, emptyList())
    }
    if (requestedRoot.contains('\u0000')) {
      return Decision.Rejected(KIND_INVALID_PATH, NUL_MESSAGE, requestedRoot, emptyList())
    }
    // A relative root would resolve against the process' working directory, which is "/".
    if (!File(requestedRoot).isAbsolute) {
      return Decision.Rejected(
        KIND_INVALID_PATH,
        relativeMessage(requestedRoot),
        requestedRoot,
        emptyList(),
      )
    }
    if (requestedRoot.split('/').contains("..")) {
      return Decision.Rejected(
        KIND_INVALID_PATH,
        dotsMessage(requestedRoot),
        requestedRoot,
        emptyList(),
      )
    }
    val realRoot = canonical(requestedRoot)
      ?: return Decision.Rejected(
        KIND_INVALID_PATH,
        "La raíz «$requestedRoot» no se pudo resolver en el teléfono.",
        requestedRoot,
        emptyList(),
      )
    val roots = allowedRoots.mapNotNull { canonical(it) }.distinct()
    if (roots.any { root -> isInside(realRoot, root) }) {
      return Decision.Allowed(realRoot)
    }
    val allowed = roots.map { it.path }
    return Decision.Rejected(
      KIND_OUTSIDE_ROOT,
      outsideMessage(realRoot.path, allowed),
      realRoot.path,
      allowed,
    )
  }

  /** `path` is `root` itself or below it on a separator boundary (`/f-evil` ≠ `/f`). */
  private fun isInside(path: File, root: File): Boolean {
    if (path.path == root.path) {
      return true
    }
    val prefix = root.path.trimEnd('/')
    return if (prefix.isEmpty()) path.path.startsWith("/") else path.path.startsWith("$prefix/")
  }

  /** Canonical form of a path, or `null` when the platform cannot resolve it. */
  private fun canonical(path: String): File? =
    try {
      File(path).canonicalFile
    } catch (error: IOException) {
      null
    }

  /** Canonical form of a root, or `null` when the platform cannot resolve it. */
  private fun canonical(file: File): File? =
    try {
      file.canonicalFile
    } catch (error: IOException) {
      null
    }

  /** Verbatim twin: `fsRootRelativeMessage` in `src/fs-roots.ts`. */
  private fun relativeMessage(requested: String): String =
    "«$requested» no es una ruta absoluta: la app solo lee raíces que le pertenecen."

  /** Verbatim twin: `fsRootDotsMessage` in `src/fs-roots.ts`. */
  private fun dotsMessage(requested: String): String =
    "La raíz «$requested» sube con «..»: una raíz no puede salir de sí misma."

  /** Verbatim twin: `fsRootOutsideMessage` in `src/fs-roots.ts`. */
  private fun outsideMessage(root: String, allowedRoots: List<String>): String {
    val allowed = if (allowedRoots.isEmpty()) "(ninguna)" else allowedRoots.joinToString(", ")
    return "«$root» queda fuera de lo que la app puede leer: " +
      "las raíces permitidas son $allowed."
  }
}
