/**
 * Contract of the bundled phone runtime (T9a, `odd/tasks/mobile-app.md`).
 *
 * The app ships a real `node` and the real `gentle-ai` binary inside the APK as
 * `libnode.so` / `libgentle_ai.so` (built by `scripts/fetch-runtime.sh`), because
 * SELinux refuses to execute anything an app writes to its own data directory
 * and the package manager is the only thing that can put executables somewhere
 * Android allows (`ApplicationInfo.nativeLibraryDir`).
 *
 * This file is **pure**: no React Native import, no Expo import, no device. It
 * owns the wire envelope of the two native calls and the mapping from that
 * envelope to one typed failure. `modules/gentle-core/index.ts` binds it to the
 * `GentleRuntime` Expo module and `mobile/lib/runtime.ts` is the surface the app
 * (and T9b's installer) calls.
 *
 * Wire envelope, produced by `GcRuntimePackage.kt`:
 *
 * ```json
 * {"ok":true,  "exitCode":0,    "stdout":"v24.22.3\n","stderr":""}
 * {"ok":false, "exitCode":1,    "stdout":"…","stderr":"…","error":{"kind":"ExitCode","message":"…"}}
 * {"ok":false, "exitCode":null, "stdout":"","stderr":"","error":{"kind":"Timeout","message":"…"}}
 * ```
 *
 * Honesty rules (S7): an answer that does not match that shape is a `malformed`
 * failure carrying the raw text, never a payload; every wire kind maps to a
 * known `RuntimeFailureKind`; an unknown kind is a `spawn` failure with its
 * message intact, never a silent success.
 */

/** Timeout the app uses when a caller does not pass one (30 s). */
export const RUNTIME_DEFAULT_TIMEOUT_MS = 30_000;

/** Upper bound the native side accepts (10 min); longer calls are a bug. */
export const RUNTIME_MAX_TIMEOUT_MS = 600_000;

/** Copy the UI can render as-is (es-AR). */
export const RUNTIME_COPY: Record<string, string> = {
  unsupported: 'El runtime embebido no está en esta build (falta el módulo nativo GentleRuntime).',
  missing: 'No encontramos el runtime embebido en el APK: falta el binario en nativeLibraryDir.',
  'not-extracted':
    'El APK trae los binarios sin extraer (extractNativeLibs=false), así que Android no deja ejecutarlos.',
  'not-executable': 'El binario embebido no tiene permiso de ejecución.',
  spawn: 'No se pudo lanzar el proceso del runtime embebido.',
  timeout: 'El runtime embebido no terminó dentro del tiempo máximo.',
  exit: 'El runtime embebido terminó con un código de error.',
  malformed: 'El runtime embebido devolvió una respuesta que no entendemos.',
};

/** Why a runtime call failed; the UI renders this, never a made-up result. */
export type RuntimeFailureKind =
  | 'unsupported'
  | 'missing'
  | 'not-extracted'
  | 'not-executable'
  | 'spawn'
  | 'timeout'
  | 'exit'
  | 'malformed';

/** Typed failure with the raw evidence for `lib/logger.ts`. */
export interface RuntimeFailure {
  kind: RuntimeFailureKind;
  /** Human copy the UI can show as-is (es-AR). */
  message: string;
  /** Raw evidence (stderr, envelope text) for the `{step, error, raw}` log. */
  raw: string | null;
}

/** One process call: real output plus the typed failure when there is one. */
export interface RuntimeResult {
  /** True only when the process ran and exited `0`. */
  ok: boolean;
  /** Real exit code; `null` when the process never ran (spawn/timeout/missing). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** `null` when `ok`; the typed failure otherwise. */
  failure: RuntimeFailure | null;
}

/** The two binaries the APK bundles. */
export type RuntimeMethod = 'runNode' | 'runGentleAi';

/** Native call signature (`modules/gentle-core/index.ts` binds the real one). */
export type RuntimeInvoke = (
  method: RuntimeMethod,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

/** Wire `error.kind` -> typed kind. Anything unknown becomes `spawn`. */
const WIRE_KINDS: Record<string, RuntimeFailureKind> = {
  RuntimeMissing: 'missing',
  NotExtracted: 'not-extracted',
  NotExecutable: 'not-executable',
  SpawnFailed: 'spawn',
  Timeout: 'timeout',
  ExitCode: 'exit',
  Unavailable: 'unsupported',
};

/** Copy of a typed failure kind, used when the native side sends no message. */
export function runtimeCopy(kind: RuntimeFailureKind): string {
  return RUNTIME_COPY[kind] ?? RUNTIME_COPY.spawn;
}

/** Copy the screen shows when this build has no runtime module at all. */
export const RUNTIME_UNSUPPORTED_COPY = RUNTIME_COPY.unsupported as string;

/** Copy of a call that never answered. */
export const RUNTIME_TIMEOUT_COPY = RUNTIME_COPY.timeout as string;

/** Copy of a build whose `nativeLibraryDir` has no binary. */
export const RUNTIME_MISSING_COPY = RUNTIME_COPY.missing as string;

/** A typed failure, with the default copy when the native side sent none. */
export function runtimeFailure(
  kind: RuntimeFailureKind,
  message?: string | null,
  raw: string | null = null,
): RuntimeFailure {
  const text = typeof message === 'string' && message.trim().length > 0 ? message : runtimeCopy(kind);
  return { kind, message: text, raw: raw !== null && raw.length > 0 ? raw : null };
}

/** Result of a call that could not even be dispatched. */
export function runtimeUnavailableResult(
  kind: RuntimeFailureKind,
  message?: string | null,
  raw: string | null = null,
): RuntimeResult {
  return { ok: false, exitCode: null, stdout: '', stderr: '', failure: runtimeFailure(kind, message, raw) };
}

/** Envelope the native layer answers when the module is not in this build. */
export function runtimeUnavailableEnvelope(message: string): string {
  return JSON.stringify({
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    error: { kind: 'Unavailable', message },
  });
}

/** Result of a successful process call. */
function successResult(exitCode: number, stdout: string, stderr: string): RuntimeResult {
  return { ok: true, exitCode, stdout, stderr, failure: null };
}

/** Raw evidence of an answer that is not a string envelope. */
function rawOf(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw.length > 0 ? raw : null;
  }
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    return String(raw);
  } catch {
    return null;
  }
}

/**
 * Parses the wire envelope into a `RuntimeResult`.
 *
 * A shape that does not match the contract is `malformed` — with the envelope
 * text as evidence — so a broken bridge can never look like a working runtime.
 */
export function parseRuntimeEnvelope(raw: unknown): RuntimeResult {
  if (typeof raw !== 'string') {
    return runtimeUnavailableResult('malformed', null, rawOf(raw));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return runtimeUnavailableResult('malformed', null, rawOf(raw));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return runtimeUnavailableResult('malformed', null, rawOf(raw));
  }
  const envelope = parsed as Record<string, unknown>;
  const { ok, exitCode, stdout, stderr } = envelope;
  if (typeof ok !== 'boolean' || typeof stdout !== 'string' || typeof stderr !== 'string') {
    return runtimeUnavailableResult('malformed', null, rawOf(raw));
  }
  if (typeof exitCode !== 'number' && exitCode !== null) {
    return runtimeUnavailableResult('malformed', null, rawOf(raw));
  }
  const code = typeof exitCode === 'number' ? exitCode : null;

  if (ok) {
    if (code === null || code !== 0) {
      // A "success" that did not exit 0 (or never exited) is a failure, whatever
      // the envelope claims.
      return {
        ok: false,
        exitCode: code,
        stdout,
        stderr,
        failure: runtimeFailure('exit', null, stderr.length > 0 ? stderr : null),
      };
    }
    return successResult(code, stdout, stderr);
  }

  const error = envelope.error;
  const wireKind =
    error !== null && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>).kind
      : null;
  const wireMessage =
    error !== null && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>).message
      : null;
  const kind =
    typeof wireKind === 'string' && wireKind in WIRE_KINDS
      ? (WIRE_KINDS[wireKind] as RuntimeFailureKind)
      : 'spawn';
  return {
    ok: false,
    exitCode: code,
    stdout,
    stderr,
    failure: runtimeFailure(
      kind,
      typeof wireMessage === 'string' ? wireMessage : null,
      stderr.length > 0 ? stderr : null,
    ),
  };
}
