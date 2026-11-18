/**
 * Bundled phone runtime — the app-facing surface (T9a, `odd/tasks/mobile-app.md`).
 *
 * Wraps the two native calls of the `GentleRuntime` Expo module, which exec
 * `nativeLibraryDir/libnode.so` and `nativeLibraryDir/libgentle_ai.so` with
 * `LD_LIBRARY_PATH` pointing at the same directory (the shared libraries the
 * Termux build needs are packed next to them; see `scripts/fetch-runtime.sh`
 * and README.md § "Runtime embebido"). The binaries run as separate processes
 * with an argv array — no shell, no `exec` string, so nothing is interpolated.
 *
 * Everything here is pure or injected: no React Native import, no device, so
 * `mobile/test/runtime.test.mjs` drives it with a fake native call.
 *
 * Honesty rules (S7):
 * - nothing throws: an absent module is `unsupported`, a broken envelope is
 *   `malformed`, a timeout is `timeout`, a non-zero exit keeps its real code and
 *   both streams;
 * - `nodeVersion()`/`gentleAiVersion()` return the exact line the binary printed,
 *   and a line that is not a version is a `malformed` failure — never a made-up
 *   version and never a fallback to the JS-bundled interpreter.
 *
 * T9b (the installer) builds on this: it will run `npm install` through the same
 * two calls instead of inventing another bridge.
 */

import {
  RUNTIME_DEFAULT_TIMEOUT_MS,
  parseRuntimeEnvelope,
  runtimeFailure,
  runtimeUnavailableResult,
} from '../modules/gentle-core/src/runtime.ts';
import type {
  RuntimeFailure,
  RuntimeInvoke,
  RuntimeMethod,
  RuntimeResult,
} from '../modules/gentle-core/src/runtime.ts';

export type {
  RuntimeFailure,
  RuntimeFailureKind,
  RuntimeInvoke,
  RuntimeMethod,
  RuntimeResult,
} from '../modules/gentle-core/src/runtime.ts';

export {
  RUNTIME_COPY,
  RUNTIME_DEFAULT_TIMEOUT_MS,
  RUNTIME_MAX_TIMEOUT_MS,
  RUNTIME_MISSING_COPY,
  RUNTIME_TIMEOUT_COPY,
  RUNTIME_UNSUPPORTED_COPY,
  parseRuntimeEnvelope,
  runtimeFailure,
} from '../modules/gentle-core/src/runtime.ts';

/** Outcome of `nodeVersion()` / `gentleAiVersion()`. */
export interface VersionResult {
  ok: boolean;
  /** Exact first line the binary printed (`v24.22.3`, `gentle-ai 4.6.0`); `null` on failure. */
  version: string | null;
  failure: RuntimeFailure | null;
  /** Full stdout, for the log and for the "what did it actually say" state. */
  raw: string;
}

/** Injectable dependencies (native bridge + timeout). */
export interface RuntimeDeps {
  /**
   * Native invoker. `undefined` uses the real `modules/gentle-core` binding;
   * `null` means "this build has no runtime module" and answers `unsupported`.
   */
  call?: RuntimeInvoke | null;
  /** Per-call timeout in ms; the native side clamps it to its own ceiling. */
  timeoutMs?: number;
}

/** `node --version` prints exactly one of these (semver with an optional suffix). */
const NODE_VERSION_LINE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** `gentle-ai --version` prints `gentle-ai 4.6.0` (the prefix and `v` are optional). */
const GENTLE_AI_VERSION_LINE = /^(?:gentle-ai\s+)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** First non-empty line of `text`, trimmed. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return '';
}

/**
 * The real native bridge, loaded lazily so this module stays importable by
 * `node --test` (same trick as `lib/provision.ts`). A build without the module
 * (Expo Go, web, an APK built before T9a) answers `unsupported` with its reason.
 */
async function defaultInvoke(
  method: RuntimeMethod,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const { callRuntime } = await import('../modules/gentle-core');
    return await callRuntime(method, args, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: { kind: 'Unavailable', message },
    });
  }
}

/** Runs `method` with an argv array and turns the envelope into a result. */
async function invoke(
  method: RuntimeMethod,
  args: readonly string[],
  deps: RuntimeDeps,
): Promise<RuntimeResult> {
  const call = deps.call === undefined ? defaultInvoke : deps.call;
  if (call === null) {
    return runtimeUnavailableResult('unsupported');
  }
  const timeoutMs = deps.timeoutMs ?? RUNTIME_DEFAULT_TIMEOUT_MS;
  let envelope: unknown;
  try {
    envelope = await call(method, [...args], timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return runtimeUnavailableResult('spawn', message, message);
  }
  return parseRuntimeEnvelope(envelope);
}

/** Result of a version command, or the typed failure of the call itself. */
function versionOf(result: RuntimeResult, pattern: RegExp): VersionResult {
  if (!result.ok) {
    return { ok: false, version: null, failure: result.failure, raw: result.stdout };
  }
  const version = firstLine(result.stdout);
  if (!pattern.test(version)) {
    return {
      ok: false,
      version: null,
      failure: runtimeFailure('malformed', null, result.stdout),
      raw: result.stdout,
    };
  }
  return { ok: true, version, failure: null, raw: result.stdout };
}

/** Runs the bundled `node` with an argv array (`no shell`, no interpolation). */
export async function runNode(args: readonly string[], deps: RuntimeDeps = {}): Promise<RuntimeResult> {
  return invoke('runNode', args, deps);
}

/** Runs the bundled `gentle-ai` with an argv array. */
export async function runGentleAi(
  args: readonly string[],
  deps: RuntimeDeps = {},
): Promise<RuntimeResult> {
  return invoke('runGentleAi', args, deps);
}

/** `node --version` through the bundled runtime (`v24.22.3` on this pin). */
export async function nodeVersion(deps: RuntimeDeps = {}): Promise<VersionResult> {
  return versionOf(await runNode(['--version'], deps), NODE_VERSION_LINE);
}

/** `gentle-ai --version` through the bundled runtime (`gentle-ai 4.6.0` on this pin). */
export async function gentleAiVersion(deps: RuntimeDeps = {}): Promise<VersionResult> {
  return versionOf(await runGentleAi(['--version'], deps), GENTLE_AI_VERSION_LINE);
}
