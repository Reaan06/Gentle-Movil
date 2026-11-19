/**
 * SEC-003 — the pure allowlist decision for the roots of the file ABI (`fsList`/`fsRead`).
 *
 * ## Why this exists
 *
 * `gc_fs_list` / `gc_fs_read` take the root they read from *from the caller*. Before this
 * slice the root travelled from JavaScript straight to the native layer, so any JS in the
 * runtime could ask for `/etc`, `/sdcard` or the app's own private directory and get a
 * listing or a file back. The root is therefore a privilege, not a parameter.
 *
 * ## Where the decision is enforced
 *
 * The trust boundary is the native module, so the **authoritative** decision is
 * `modules/gentle-core/android/.../FsRoots.kt`, applied in `GcCoreModule.dispatch` for both
 * `gc_fs_list` and `gc_fs_read` (that is the only way JS reaches the native layer, so
 * `callGc('gc_fs_list', …)` cannot skip it). On the device that decision also resolves
 * symlinks (`File.canonicalFile`) and the allowed roots (`Context.filesDir`,
 * `Context.cacheDir`) — neither of which exists in this process.
 *
 * This module is the same rule, in plain TypeScript, so it can be:
 *
 * 1. **tested** in node (`mobile/test/core-abi.test.mjs`), which is the only way to pin the
 *    decision without an Android toolchain, and
 * 2. applied on the TS side for the half that is decidable here (`normalizeFsRoot`: the
 *    root has to be an absolute, non-escaping path), so an impossible root is refused
 *    before it crosses the bridge.
 *
 * `FsRoots.kt` and this file must agree: same refusals, same `kind` values
 * (`invalid_path` / `outside_root`, the vocabulary of `mobile-core/src/fs.rs`) and the same
 * messages. Changing one without the other is the bug both are here to prevent.
 *
 * ## Rules (one sentence each)
 *
 * - an empty root is refused: there is nothing to resolve;
 * - a root that is not absolute is refused — a relative root would resolve against the
 *   process' working directory, which on Android is `/`;
 * - a root carrying a NUL byte is refused;
 * - a root with a `..` segment is refused instead of being collapsed: a root never climbs
 *   out of itself, so the escape is reported, not silently rewritten;
 * - `.` segments and repeated/trailing `/` are normalized away, so `/files/` and `//files`
 *   are the same root as `/files`;
 * - a root that arrives as a `file://` URI (what `expo-file-system` answers for the app's
 *   own directories) keeps only its path part, so `file:///files/` is `/files` — the URI
 *   form never reaches the native allowlist, which judges real paths;
 * - a root is allowed only when it **is** an allowed root or sits below one on a path
 *   boundary (`/files-evil` is NOT inside `/files`);
 * - the refusal names the real (normalized) root and the real allowed roots. Never a
 *   silent fallback to a "safe" directory: a caller that asked for the wrong root has to
 *   learn which one was refused.
 *
 * `FsRoots.kt` judges canonical paths only; the `file://` form is normalized here (and in
 * `abi.ts` / `lib/local-fs.ts`) **before** the native decision, so both sides still agree on
 * the set of allowed roots and on the vocabulary of the refusals.
 */

/** Refusal kinds; both are part of the frozen core vocabulary (`mobile-core/src/fs.rs`). */
export type FsRootRefusalKind = 'invalid_path' | 'outside_root';

/** The root as the ABI will use it (absolute, normalized, allowed). */
export interface FsRootAllowed {
  readonly ok: true;
  /** Absolute root with `.` segments, repeated slashes and a trailing slash removed. */
  readonly root: string;
}

/** A refused root: the caller learns the real root and the real allowed roots. */
export interface FsRootRefused {
  readonly ok: false;
  readonly kind: FsRootRefusalKind;
  /** Verbatim UI text; names the refused root and the allowed ones (never a NUL byte). */
  readonly message: string;
  /** The root as it was asked for (normalized when it could be normalized). */
  readonly requested: string;
  /** The roots that would have worked, normalized; `[]` when there are none. */
  readonly allowedRoots: readonly string[];
}

/** Outcome of the allowlist decision. */
export type FsRootDecision = FsRootAllowed | FsRootRefused;

/** Message of an empty root. Shared with `FsRoots.kt` verbatim. */
export const FS_ROOT_EMPTY_MESSAGE = 'Falta la raíz absoluta desde la que se puede leer.';

/** Message of a root carrying a NUL byte. Shared with `FsRoots.kt` verbatim. */
export const FS_ROOT_NUL_MESSAGE = 'La raíz pedida trae un byte nulo, así que no se resuelve.';

/** Message of a relative root. Shared with `FsRoots.kt` verbatim. */
export function fsRootRelativeMessage(requested: string): string {
  return `«${requested}» no es una ruta absoluta: la app solo lee raíces que le pertenecen.`;
}

/** Message of a root that climbs with `..`. Shared with `FsRoots.kt` verbatim. */
export function fsRootDotsMessage(requested: string): string {
  return `La raíz «${requested}» sube con «..»: una raíz no puede salir de sí misma.`;
}

/** Message of a root outside the allowlist. Shared with `FsRoots.kt` verbatim. */
export function fsRootOutsideMessage(root: string, allowedRoots: readonly string[]): string {
  const allowed = allowedRoots.length > 0 ? allowedRoots.join(', ') : '(ninguna)';
  return `«${root}» queda fuera de lo que la app puede leer: las raíces permitidas son ${allowed}.`;
}

function refused(
  kind: FsRootRefusalKind,
  message: string,
  requested: string,
  allowedRoots: readonly string[],
): FsRootRefused {
  return { ok: false, kind, message, requested, allowedRoots };
}

/**
 * Absolute, normalized form of `requested` — or the `invalid_path` refusal that says why.
 *
 * This is the half of the decision the TS side can make on its own (no filesystem, no
 * symlinks, no `Context`), and the first half of `decideFsRoot`.
 */
export function normalizeFsRoot(requested: string): FsRootDecision {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (raw === '') {
    return refused('invalid_path', FS_ROOT_EMPTY_MESSAGE, raw, []);
  }
  if (raw.includes('\u0000')) {
    return refused('invalid_path', FS_ROOT_NUL_MESSAGE, raw, []);
  }
  if (!raw.startsWith('/')) {
    return refused('invalid_path', fsRootRelativeMessage(raw), raw, []);
  }
  const segments = raw.split('/');
  if (segments.includes('..')) {
    return refused('invalid_path', fsRootDotsMessage(raw), raw, []);
  }
  const normalized = `/${segments.filter((segment) => segment !== '' && segment !== '.').join('/')}`;
  return { ok: true, root: normalized };
}

/** Scheme the app's own file APIs answer with (`expo-file-system` `Paths.document.uri`). */
const FILE_SCHEME = /^file:\/\//i;

/** True when the value arrives as a `file://` URI rather than a plain path. */
export function isFileRootUri(requested: string): boolean {
  return typeof requested === 'string' && FILE_SCHEME.test(requested.trim());
}

/**
 * The root a `fs*` call may use, accepting the two forms the app really produces.
 *
 * `expo-file-system` answers `Paths.document.uri` as `file:///data/…/files/`, and the
 * project root is composed from it (`lib/local-projects.ts` `projectRootFor`). The core and
 * `FsRoots.kt` expect the canonical filesystem path, so:
 *
 * | requested | root |
 * |---|---|
 * | `file:///data/x` | `/data/x` |
 * | `file:///data/x/` | `/data/x` |
 * | `/data/x/` | `/data/x` |
 * | `/data/x` | `/data/x` (unchanged) |
 *
 * Everything else keeps the rules of `normalizeFsRoot`: an empty root, a URI whose path is
 * not absolute (`file://relative/x`) and a path that climbs with `..` are `invalid_path`
 * refusals naming the value that arrived. Nothing is invented: the scheme is removed, the
 * rest is judged exactly like the plain path it is.
 */
export function normalizeDeviceRoot(requested: string): FsRootDecision {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (raw === '') {
    return refused('invalid_path', FS_ROOT_EMPTY_MESSAGE, raw, []);
  }
  if (!isFileRootUri(raw)) {
    return normalizeFsRoot(raw);
  }
  const path = raw.replace(FILE_SCHEME, '');
  if (!path.startsWith('/')) {
    // `file://` with no absolute path part: the refusal names the URI as it arrived.
    return refused('invalid_path', fsRootRelativeMessage(raw), raw, []);
  }
  const decision = normalizeFsRoot(path);
  if (!decision.ok) {
    // The refusal is about the path the URI points at; the caller still learns the URI.
    return refused('invalid_path', decision.message, raw, []);
  }
  return decision;
}

/**
 * True when `path` is `root` itself or sits below it on a path boundary.
 *
 * Both arguments are expected to be normalized by `normalizeFsRoot`; the separator check is
 * what stops `/files-evil` from being read as "inside `/files`".
 */
export function insideFsRoot(path: string, root: string): boolean {
  if (path === root) {
    return true;
  }
  if (root === '/') {
    return path.startsWith('/');
  }
  return path.startsWith(`${root.replace(/\/+$/, '')}/`);
}

/**
 * Full decision: normalize the requested root (a `file://` URI keeps only its canonical
 * path, see `normalizeDeviceRoot`), then require it to be inside one of
 * `allowedRoots`. The allowed roots are canonical paths as the native layer resolves them
 * (`normalizeFsRoot`); an entry that is not one is silently skipped — an unreadable
 * allowlist entry must not become an allowed root.
 *
 * `outside_root` is the refusal of a root that is perfectly well formed but not ours; it
 * names the real root and every real allowed root.
 */
export function decideFsRoot(
  requested: string,
  allowedRoots: readonly string[],
): FsRootDecision {
  const requestedDecision = normalizeDeviceRoot(requested);
  if (!requestedDecision.ok) {
    return requestedDecision;
  }
  const roots: string[] = [];
  for (const candidate of Array.isArray(allowedRoots) ? allowedRoots : []) {
    const decision = normalizeFsRoot(typeof candidate === 'string' ? candidate : '');
    if (decision.ok && !roots.includes(decision.root)) {
      roots.push(decision.root);
    }
  }
  for (const root of roots) {
    if (insideFsRoot(requestedDecision.root, root)) {
      return { ok: true, root: requestedDecision.root };
    }
  }
  return refused(
    'outside_root',
    fsRootOutsideMessage(requestedDecision.root, roots),
    requestedDecision.root,
    roots,
  );
}
