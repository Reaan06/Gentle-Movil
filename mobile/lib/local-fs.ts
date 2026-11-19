/**
 * T18/T14 — Real device files for local mode.
 *
 * `mobile/lib/local-editor.ts` reads content through an injected
 * `EditorSource`; the only implementation until now was `bridgeEditorSource`
 * (the PC over the SSH tunnel), so local mode could only say "no filesystem".
 * The Rust core now exposes the frozen pair below (ABI v2, contract owned by
 * the core writer — this file only *codes against* it):
 *
 * ```jsonc
 * // fsList({ root, path, maxEntries? })
 * { "entries": [ { "path": "src/app.ts", "size": 120, "kind": "file" } ] }
 * // fsRead({ root, path, maxBytes? })
 * { "path": "src/app.ts", "text": "const a = 1;", "size": 13, "truncated": false }
 * ```
 *
 * This seam turns those answers into the shapes the editor already parses
 * (`{entries:[{path,size,kind}]}` for `parseTree`, `{path,text}` for
 * `parseFile`), so the tree, ordering, dirty diff and truncation rules stay in
 * one place.
 *
 * ## Honesty rules (S7)
 *
 * - the default surface is the **real ABI layer** (`modules/gentle-core/src/abi.ts`), the
 *   same `fsList`/`fsRead` `lib/core.ts` re-exports: resolving the legacy `core` object of
 *   `lib/core.ts` would land on the dev stub, whose methods always throw, and a build that
 *   really has the symbols would report "core unavailable" (T18 hardware defect);
 * - a build without the symbols (`api: null`, or a surface that lacks them) is `no-fs` with
 *   a message that names the **real root** and the real cause — never an empty project that
 *   looks like a successful listing;
 * - the root is normalized in the pure layer before any call (`src/fs-roots.ts`
 *   `normalizeDeviceRoot`): `file:///data/x/` and `/data/x` are the same root, and a root
 *   that is empty, relative or escapes with `..` is refused naming the value, without ever
 *   reaching the core;
 * - `permission_denied` is `no-fs` too, naming the real path, the real root and
 *   the cause the core reported (`EACCES`, …);
 * - `not_found`, `binary` and `too_large` keep their own copy and always name
 *   the path: no generic "we couldn't" that hides which file it was;
 * - a read the core had to cut (`truncated: true`) is refused, because opening
 *   it would show a partial file as if it were the whole one;
 * - a listing the core cut at `maxEntries` is refused too (the core reports
 *   `truncated` at the listing level, even though the frozen TS shape only
 *   promises `entries`): a short list that looks like the whole project is the
 *   same lie as a short file;
 * - a path that escapes the project root never reaches the core;
 * - every failure is logged as `{step, error, raw}` through `lib/logger.ts`.
 *
 * Everything is injected: the tests never touch a device.
 */

import { logger } from './logger.ts';
import type { EditorFailure, EditorLogger, EditorSource, SourceResult } from './local-editor.ts';
import { fsList as abiFsList, fsRead as abiFsRead } from '../modules/gentle-core/src/abi.ts';
import { normalizeDeviceRoot } from '../modules/gentle-core/src/fs-roots.ts';

/* ------------------------------------------------------------------ *
 * Frozen core surface (contract, not implementation)
 * ------------------------------------------------------------------ */

/** One entry as the core reports it. `size` is `null` when the core does not know. */
export interface CoreFsEntry {
  /** Path relative to `root`, as the core reports it. */
  path: string;
  size: number | null;
  kind: 'file' | 'dir';
}

/** Answer of `fsList`. */
export interface CoreFsListing {
  entries: CoreFsEntry[];
}

/** Answer of `fsRead`. */
export interface CoreFsFile {
  path: string;
  text: string;
  size: number;
  /** True when the core had to cut the file at `maxBytes`. */
  truncated: boolean;
}

/** The two core calls this seam needs (frozen names, do not rename). */
export interface LocalFsApi {
  fsList(input: { root: string; path: string; maxEntries?: number }): Promise<CoreFsListing>;
  fsRead(input: { root: string; path: string; maxBytes?: number }): Promise<CoreFsFile>;
}

/** Dependencies of `localFsEditorSource` (all injectable for the tests). */
export interface LocalFsDeps {
  /**
   * Core surface. Omitted → resolved from the ABI layer (`defaultLocalFsApi`); `null` → the
   * caller already knows this build has no `fsList`/`fsRead`.
   */
  api?: LocalFsApi | null;
  /** Failure sink (`{step, error, raw}`). Defaults to `logger.tag('local-fs')`. */
  logger?: EditorLogger;
  /** Entry cap of one listing. */
  maxEntries?: number;
  /** Byte cap of one read; over it the core answers `truncated: true`. */
  maxBytes?: number;
}

/* ------------------------------------------------------------------ *
 * Copy (es-AR) and caps
 * ------------------------------------------------------------------ */

/** Entries one listing may return before the core cuts it. */
export const LOCAL_FS_MAX_ENTRIES = 2_000;

/** Bytes one read may return; a bigger file is refused, never silently cut. */
export const LOCAL_FS_MAX_BYTES = 1024 * 1024;

/** Same title the editor already shows for the capability gap. */
export const LOCAL_FS_NO_ACCESS_COPY = 'Sin acceso a archivos';

/** Copy of a read the core had to cut. */
export const LOCAL_FS_INCOMPLETE_READ_COPY = 'El core del teléfono devolvió un archivo incompleto.';

/** Copy of an answer that does not match the frozen contract. */
export const LOCAL_FS_BAD_PAYLOAD_COPY = 'El core del teléfono devolvió una respuesta que no entendemos.';

/** Failure sink of this seam (one tag, one ring buffer, one log). */
export const localFsLog: EditorLogger = logger.tag('local-fs');

/** Message of a build whose core does not expose the two frozen symbols. */
export function localFsUnavailableMessage(root: string): string {
  return `${LOCAL_FS_NO_ACCESS_COPY}: esta build del core Rust no expone fsList/fsRead, así que no podemos leer ${root}.`;
}

/**
 * Message of a build whose native core is not packed (`libmobile_core.so`).
 *
 * The ABI layer **is** there in that case, so blaming the two symbols would be false: the
 * real cause is the missing native library, and the core's own sentence is appended.
 */
export function nativeCoreMissingMessage(root: string, cause: string): string {
  return `${LOCAL_FS_NO_ACCESS_COPY}: el núcleo nativo del teléfono (libmobile_core.so) no está en esta build, así que no podemos leer ${root}. El core respondió: ${cause}`;
}

/**
 * Message of a root that is not a usable device path.
 *
 * The value is always named, so a person can see what the app tried to read instead of a
 * generic "we couldn't": the app composes this root from its documents dir, so a wrong one
 * is a real bug worth naming.
 */
export function invalidRootMessage(value: string, cause: string): string {
  const shown = typeof value === 'string' ? value.trim() : '';
  const named = shown === '' ? 'la raíz vacía' : `«${shown}»`;
  return `${LOCAL_FS_NO_ACCESS_COPY}: ${named} no es una ruta absoluta del teléfono, así que no la leemos. ${cause}`;
}

/** Message of a path the phone did not allow: real path, real root, real cause. */
export function permissionDeniedMessage(path: string, root: string, cause: string): string {
  return `${LOCAL_FS_NO_ACCESS_COPY}: el teléfono no dio permiso para leer ${path} dentro de ${root}. El core respondió: ${cause}`;
}

/** Message of a path the core says does not exist. */
export function notFoundMessage(path: string, root: string): string {
  return `El archivo no está en el teléfono: ${path} (dentro de ${root}).`;
}

/** Message of a file with no text to edit. */
export function binaryMessage(path: string): string {
  return `Archivo binario: ${path} no tiene texto para editar.`;
}

/** Message of a file over the read cap. */
export function tooLargeMessage(path: string, maxBytes: number): string {
  return `Archivo demasiado grande: ${path} supera el tope de ${maxBytes} bytes de una lectura.`;
}

/** Message of a read the core truncated (a partial file is not opened). */
export function truncatedReadMessage(path: string, size: number, maxBytes: number): string {
  return `La lectura de ${path} quedó truncada (el archivo pesa ${size} bytes y el tope es ${maxBytes}): no abrimos un archivo incompleto.`;
}

/** Message of a listing the core had to cut at the entry cap. */
export function truncatedListingMessage(maxEntries: number): string {
  return `La carpeta tiene más de ${maxEntries} entradas: el listado quedaría incompleto, así que no lo mostramos como si fuera todo el proyecto.`;
}

/** Message of a path that would leave the project root. */
export function unsafePathMessage(path: string, root: string): string {
  const trimmed = path.trim();
  if (trimmed === '') {
    return `La ruta está vacía: no hay archivo que abrir en ${root}.`;
  }
  return `La ruta ${trimmed} sale de la raíz del proyecto (${root}), así que no la abrimos.`;
}

/** Message of an answer that does not match the contract, with its raw evidence. */
function malformedMessage(raw: string): string {
  return `${LOCAL_FS_BAD_PAYLOAD_COPY} (${raw})`;
}

/* ------------------------------------------------------------------ *
 * Raw evidence helpers
 * ------------------------------------------------------------------ */

/** Raw evidence of any value, truncated for the log and the error card. */
function rawPrefix(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') {
      return json.slice(0, 160);
    }
  } catch {
    // fall through to the String() form
  }
  try {
    return String(value).slice(0, 160);
  } catch {
    return 'unrepresentable';
  }
}

/** Message of any thrown value, without inventing one. */
function causeMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error.slice(0, 160);
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message.trim().slice(0, 160);
    }
  }
  return rawPrefix(error);
}

/** Lowercased typed kind of an error (`kind`, `code` or `name`). */
function kindOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const record = error as Record<string, unknown>;
  for (const key of ['kind', 'code', 'name'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim().toLowerCase();
    }
  }
  return '';
}

const PERMISSION_KINDS = new Set([
  'permission_denied',
  'permissiondenied',
  'permission-denied',
  'permission',
  'eacces',
  'eperm',
]);
const NOT_FOUND_KINDS = new Set(['not_found', 'notfound', 'not-found', 'enoent', 'missing']);
const BINARY_KINDS = new Set(['binary', 'binaryfile', 'binary_file', 'is_binary']);
const TOO_LARGE_KINDS = new Set(['too_large', 'toolarge', 'too-large', 'efbig', 'file_too_large']);
const UNAVAILABLE_KINDS = new Set([
  'no-fs',
  'nofs',
  'coreunavailable',
  'coreunavailableerror',
  'core_unavailable',
  'unsupported',
]);
const TIMEOUT_KINDS = new Set(['timeout', 'etimedout', 'deadline', 'deadlineexceeded']);

/* ------------------------------------------------------------------ *
 * Core failure → EditorFailure
 * ------------------------------------------------------------------ */

/** Where a call happened, so both the copy and the log name the real target. */
interface FailureContext {
  /** `list` or `read` (log step + raw evidence). */
  step: 'list' | 'read';
  /** Absolute project root (always named). */
  root: string;
  /** Path of the file being read, or the root when listing. */
  path: string;
  maxBytes: number;
}

/**
 * Maps one core rejection to the editor's typed failure.
 *
 * The kind decides the copy, never the message text: `permission_denied` is a
 * capability gap (`no-fs`) naming the real path and the real cause; `not_found`,
 * `binary` and `too_large` keep their own copy; an unknown failure keeps the
 * core's own message instead of an invented one.
 */
export function mapCoreFailure(error: unknown, context: FailureContext): EditorFailure {
  const kind = kindOf(error);
  const cause = causeMessage(error);
  const raw = `kind=${kind === '' ? 'desconocido' : kind} message=${cause} root=${context.root} path=${context.path}`;

  if (PERMISSION_KINDS.has(kind)) {
    return { kind: 'no-fs', message: permissionDeniedMessage(context.path, context.root, cause), raw };
  }
  if (UNAVAILABLE_KINDS.has(kind)) {
    return {
      kind: 'no-fs',
      message: nativeCoreMissingMessage(context.root, cause),
      raw,
    };
  }
  if (NOT_FOUND_KINDS.has(kind)) {
    return { kind: 'bad-response', message: notFoundMessage(context.path, context.root), raw };
  }
  if (BINARY_KINDS.has(kind)) {
    return { kind: 'bad-response', message: binaryMessage(context.path), raw };
  }
  if (TOO_LARGE_KINDS.has(kind)) {
    return { kind: 'bad-response', message: tooLargeMessage(context.path, context.maxBytes), raw };
  }
  if (TIMEOUT_KINDS.has(kind)) {
    return {
      kind: 'timeout',
      message: `El core del teléfono no respondió a tiempo leyendo ${context.path}.`,
      raw,
    };
  }
  // Unknown: the core's own message, with the real evidence next to it.
  return {
    kind: 'bad-response',
    message: `El core del teléfono falló leyendo ${context.path} dentro de ${context.root}: ${cause}`,
    raw,
  };
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** True when `path` is a relative, non-escaping path inside the project root. */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string') {
    return false;
  }
  const trimmed = path.trim();
  if (trimmed === '' || trimmed.startsWith('/')) {
    return false;
  }
  return trimmed.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/* ------------------------------------------------------------------ *
 * Core detection
 * ------------------------------------------------------------------ */

/** The named members the frozen pair lives under (a module namespace or an object). */
export interface LocalFsSurface {
  fsList?: unknown;
  fsRead?: unknown;
}

/**
 * Reads the frozen surface off a candidate binding.
 *
 * `null` means the two symbols are really not there (a build without them): the caller can
 * then say so out loud instead of showing an empty project. Nothing here throws, so the
 * decision is never a crash with a stack trace in place of the copy.
 */
export function coreLocalFsApi(candidate: unknown): LocalFsApi | null {
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const list = record.fsList;
  const read = record.fsRead;
  if (typeof list !== 'function' || typeof read !== 'function') {
    return null;
  }
  return {
    fsList: (input) => (list as (value: unknown) => Promise<CoreFsListing>).call(candidate, input),
    fsRead: (input) => (read as (value: unknown) => Promise<CoreFsFile>).call(candidate, input),
  };
}

/**
 * The ABI surface this build really ships: the two module functions of
 * `modules/gentle-core/src/abi.ts` (the same ones `lib/core.ts` re-exports).
 *
 * Returned as a plain surface object so `coreLocalFsApi` reads it exactly like any other
 * binding, keeping the members' own `this`.
 */
export function abiLocalFsSurface(): Required<LocalFsSurface> {
  return { fsList: abiFsList, fsRead: abiFsRead };
}

/**
 * The default surface: the ABI layer, never the dev stub of `lib/core.ts`.
 *
 * `lib/core.ts` still exports a `core` binding whose `fsList`/`fsRead` are the throwing
 * placeholder; resolving *that* object made a build with the real symbols report "esta
 * build no expone fsList/fsRead" (T18 hardware defect). The ABI layer is the fallback, and
 * with no native core bound its calls fail with the honest `CoreUnavailable` cause, which
 * `mapCoreFailure` turns into the "núcleo nativo no está en esta build" copy.
 */
export function defaultLocalFsApi(): LocalFsApi | null {
  return coreLocalFsApi(abiLocalFsSurface());
}

/**
 * Resolves the surface of a candidate binding (`undefined` → the ABI layer).
 *
 * Injected by the tests and by any caller that holds a different binding, so the seam
 * never has to guess which object to read the two frozen members from.
 */
export function resolveLocalFsApi(surface: unknown = abiLocalFsSurface()): LocalFsApi | null {
  return coreLocalFsApi(surface);
}

/* ------------------------------------------------------------------ *
 * The seam
 * ------------------------------------------------------------------ */

/** One answer: the body in the editor's shape, or the typed failure. */
function failure(
  log: EditorLogger,
  step: 'list' | 'read',
  detail: EditorFailure,
): { ok: false; failure: EditorFailure } {
  log.failure(step === 'list' ? 'local-fs-list' : 'local-fs-read', new Error(detail.message), detail.raw);
  return { ok: false, failure: detail };
}

/**
 * `EditorSource` over the frozen `fsList`/`fsRead` pair, rooted at the
 * project's **real** folder on the device.
 *
 * `root` is the absolute project directory (the app documents dir plus the
 * recorded relative path — see `projectRootFor` in `lib/local-projects.ts`); the
 * core is asked to list that folder itself (`path: ''`), and every read carries
 * a path relative to it.
 *
 * The root is normalized here, not trusted: `expo-file-system` answers that documents dir
 * as a `file://` URI, and the native allowlist plus the core judge canonical paths, so
 * `file:///data/x/` reaches them as `/data/x`. A root that cannot be a device path (empty,
 * relative, escaping with `..`) is refused naming the value, without a single core call.
 */
export function localFsEditorSource(root: string, deps: LocalFsDeps = {}): EditorSource {
  const log = deps.logger ?? localFsLog;
  const maxEntries = deps.maxEntries ?? LOCAL_FS_MAX_ENTRIES;
  const maxBytes = deps.maxBytes ?? LOCAL_FS_MAX_BYTES;
  // `undefined` means "resolve it", `null` means "the caller knows it is absent".
  const api = deps.api === undefined ? defaultLocalFsApi() : deps.api;
  const requestedRoot = typeof root === 'string' ? root.trim() : '';
  const rootDecision = normalizeDeviceRoot(requestedRoot);
  const projectRoot = rootDecision.ok ? rootDecision.root : requestedRoot;
  /** The refusal of the root itself: no call may happen while it is set. */
  const rootFailure: EditorFailure | null = rootDecision.ok
    ? null
    : {
        kind: 'no-fs',
        message: invalidRootMessage(requestedRoot, rootDecision.message),
        raw: `root=${requestedRoot} kind=${rootDecision.kind}`,
      };

  async function list(): Promise<SourceResult> {
    if (rootFailure !== null) {
      return failure(log, 'list', rootFailure);
    }

    if (api === null) {
      return failure(log, 'list', {
        kind: 'no-fs',
        message: localFsUnavailableMessage(projectRoot),
        raw: `core-fsList-missing root=${projectRoot} path=`,
      });
    }

    let listing: unknown;
    try {
      listing = await api.fsList({ root: projectRoot, path: '', maxEntries });
    } catch (error) {
      return failure(
        log,
        'list',
        mapCoreFailure(error, { step: 'list', root: projectRoot, path: projectRoot, maxBytes }),
      );
    }

    if (typeof listing !== 'object' || listing === null) {
      return failure(log, 'list', {
        kind: 'bad-response',
        message: malformedMessage(rawPrefix(listing)),
        raw: `payload=${rawPrefix(listing)}`,
      });
    }

    // Entries are passed through untouched: `parseTree` is the strict parser and
    // rejects an unknown kind or a file without a size by name. Coercing here
    // would leave a shorter, believable tree.
    const answer = listing as { entries?: unknown; truncated?: unknown };
    if (answer.truncated === true) {
      return failure(log, 'list', {
        kind: 'bad-response',
        message: truncatedListingMessage(maxEntries),
        raw: `truncated=true maxEntries=${maxEntries} root=${projectRoot}`,
      });
    }
    return { ok: true, body: { entries: answer.entries } };
  }

  async function read(path: string): Promise<SourceResult> {
    if (rootFailure !== null) {
      return failure(log, 'read', rootFailure);
    }

    const requested = typeof path === 'string' ? path.trim() : '';
    if (!isSafeRelativePath(requested)) {
      return failure(log, 'read', {
        kind: 'bad-response',
        message: unsafePathMessage(requested, projectRoot),
        raw: `path=${requested} root=${projectRoot}`,
      });
    }

    if (api === null) {
      return failure(log, 'read', {
        kind: 'no-fs',
        message: localFsUnavailableMessage(projectRoot),
        raw: `core-fsRead-missing root=${projectRoot} path=${requested}`,
      });
    }

    let file: unknown;
    try {
      file = await api.fsRead({ root: projectRoot, path: requested, maxBytes });
    } catch (error) {
      return failure(
        log,
        'read',
        mapCoreFailure(error, { step: 'read', root: projectRoot, path: requested, maxBytes }),
      );
    }

    if (typeof file !== 'object' || file === null) {
      return failure(log, 'read', {
        kind: 'bad-response',
        message: malformedMessage(rawPrefix(file)),
        raw: `payload=${rawPrefix(file)}`,
      });
    }

    const answer = file as { path?: unknown; text?: unknown; size?: unknown; truncated?: unknown };
    if (answer.truncated === true) {
      const size = typeof answer.size === 'number' && Number.isFinite(answer.size) ? answer.size : -1;
      return failure(log, 'read', {
        kind: 'bad-response',
        message: truncatedReadMessage(requested, size, maxBytes),
        raw: `truncated=true size=${size} maxBytes=${maxBytes} path=${requested}`,
      });
    }
    if (typeof answer.text !== 'string') {
      return failure(log, 'read', {
        kind: 'bad-response',
        message: LOCAL_FS_INCOMPLETE_READ_COPY,
        raw: `payload=${rawPrefix(file)} path=${requested}`,
      });
    }

    const reported = typeof answer.path === 'string' ? answer.path.trim() : '';
    return { ok: true, body: { path: reported === '' ? requested : reported, text: answer.text } };
  }

  return { list, read };
}
