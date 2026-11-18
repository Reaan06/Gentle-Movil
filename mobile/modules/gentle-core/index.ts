/**
 * Typed facade of the `GentleCore` native module (`libmobile_core.so` + JNI wrapper).
 *
 * `lib/provision.ts` and the screens talk to the core only through `callGc(fn,
 * payloadJson)`; every argument and response is a JSON document, so the schema
 * stays in TypeScript (OTA rule, `docs/mobile-app-stack.md`) and the native side
 * never needs a schema change to ship a new step.
 *
 * Graceful absence: when the module is not registered (Expo Go, web bundle) or
 * when `libmobile_core.so` is not packed in the APK, the call resolves with the
 * envelope
 *
 * ```json
 * {"ok":false,"error":{"kind":"CoreUnavailable","message":"…"},"raw":null}
 * ```
 *
 * which `provision.ts` reports as a step failure. Nothing throws, nothing
 * crashes, nothing pretends to have connected.
 */

import { requireNativeModule } from 'expo-modules-core';

import {
  RUNTIME_DEFAULT_TIMEOUT_MS,
  RUNTIME_MAX_TIMEOUT_MS,
  runtimeUnavailableEnvelope,
} from './src/runtime.ts';
import type { RuntimeMethod } from './src/runtime.ts';

/** Function names of the frozen C ABI (`gc_*` symbols). */
export type GcFunction =
  | 'gc_abi_version'
  | 'gc_pair_from_qr'
  | 'gc_ssh_connect'
  | 'gc_provision_step'
  | 'gc_device_key_generate'
  | 'gc_ssh_channel_write'
  | 'gc_ssh_channel_read'
  | 'gc_ssh_channel_close';

/** Shape of the Kotlin module (`modules/gentle-core/android/.../GcCoreModule.kt`). */
export interface GentleCoreNativeModule {
  /** True when `libmobile_core.so` loaded in this process. */
  isCoreAvailable(): boolean;
  /** Load error when unavailable; empty string otherwise. */
  coreUnavailableReason(): string;
  /** Single dispatch point: name of the `gc_*` symbol + JSON payload. */
  callGc(fn: string, payloadJson: string): Promise<string>;
  /** Convenience overloads that mirror `callGc`. */
  abiVersion(): Promise<string>;
  pairFromQr(uri: string): Promise<string>;
  sshConnect(payloadJson: string): Promise<string>;
  provisionStep(payloadJson: string): Promise<string>;
  deviceKeyGenerate(payloadJson: string): Promise<string>;
  /** Tunnel channel I/O (`gc_ssh_channel_*`); both handles ride inside the document. */
  sshChannelWrite(payloadJson: string): Promise<string>;
  sshChannelRead(payloadJson: string): Promise<string>;
  sshChannelClose(payloadJson: string): Promise<string>;
}

let nativeModule: GentleCoreNativeModule | null = null;
let loadError = '';

try {
  nativeModule = requireNativeModule<GentleCoreNativeModule>('GentleCore');
} catch (error) {
  // Expo Go / web / a build without the module. Honest reason kept for the UI.
  loadError = error instanceof Error ? error.message : String(error);
}

/** Envelope the facade answers with when the native module is missing. */
function unavailableEnvelope(message: string, kind = 'CoreUnavailable'): string {
  return JSON.stringify({ ok: false, error: { kind, message }, raw: null });
}

/** True when the native module exists AND `libmobile_core.so` loaded. */
export function coreAvailable(): boolean {
  if (nativeModule === null) {
    return false;
  }
  try {
    return nativeModule.isCoreAvailable();
  } catch {
    return false;
  }
}

/** Human-readable reason the core is not usable (`''` when it is). */
export function coreUnavailableReason(): string {
  if (nativeModule === null) {
    return loadError || 'el módulo nativo GentleCore no está registrado en esta build';
  }
  try {
    return nativeModule.coreUnavailableReason();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Calls one `gc_*` symbol with a JSON payload and returns the JSON envelope.
 * Never rejects: transport failures become `{ok:false,error:{kind…}}`.
 */
export async function callGc(fn: GcFunction | string, payloadJson: string): Promise<string> {
  if (nativeModule === null) {
    return unavailableEnvelope(
      `GentleCore no está registrado en esta build (${loadError || 'sin detalle'})`,
      'CoreUnavailable',
    );
  }
  try {
    return await nativeModule.callGc(fn, payloadJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableEnvelope(message, 'NativeError');
  }
}

/** `gc_abi_version` — JSON descriptor of the frozen ABI. */
export async function abiVersion(): Promise<string> {
  return nativeModule === null ? callGc('gc_abi_version', '{}') : nativeModule.abiVersion();
}

/** `gc_pair_from_qr` — parses a `gc://pair?…` URI. */
export async function pairFromQr(uri: string): Promise<string> {
  return nativeModule === null ? callGc('gc_pair_from_qr', JSON.stringify({ uri })) : nativeModule.pairFromQr(uri);
}

/** `gc_device_key_generate` — phone ed25519 identity (kept in the Keystore). */
export async function deviceKeyGenerate(payloadJson = '{}'): Promise<string> {
  return callGc('gc_device_key_generate', payloadJson);
}

/* ------------------------------------------------------------------ *
 * Tunnel channel I/O (S4)
 *
 * The `tunnel` step reports one `channel_id` per loopback port; the app reaches
 * the extension through those handles with the three calls below. Every
 * document carries both handles (`sessionId`, `channelId`) so one native entry
 * point stays enough — the JNI shim splits them out like it does for
 * `provisionStep`. `lib/provision.ts` (`channelWrite`/`channelRead`/
 * `channelClose`, `httpOverTunnel`, `closeTunnel`) is the typed layer over them.
 * ------------------------------------------------------------------ */

/** `gc_ssh_channel_write` — `{sessionId, channelId, bytes: "<base64>"}`. */
export async function sshChannelWrite(payloadJson: string): Promise<string> {
  return callGc('gc_ssh_channel_write', payloadJson);
}

/** `gc_ssh_channel_read` — `{sessionId, channelId, timeoutMs?}`. */
export async function sshChannelRead(payloadJson: string): Promise<string> {
  return callGc('gc_ssh_channel_read', payloadJson);
}

/** `gc_ssh_channel_close` — `{sessionId, channelId}`. */
export async function sshChannelClose(payloadJson: string): Promise<string> {
  return callGc('gc_ssh_channel_close', payloadJson);
}

/* ------------------------------------------------------------------ *
 * Bundled phone runtime (T9a)
 *
 * Second native module of this Expo module: `GentleRuntime` execs the two
 * binaries the APK ships as libraries — `nativeLibraryDir/libnode.so` and
 * `nativeLibraryDir/libgentle_ai.so` — with `LD_LIBRARY_PATH` pointing at that
 * same directory (see `scripts/fetch-runtime.sh`). Same rules as the core:
 * every argument is an argv array (never a shell string) and every answer is a
 * JSON envelope, so `src/runtime.ts` (pure, tested by `mobile/test/runtime.test.mjs`)
 * can turn it into a typed result.
 *
 * Graceful absence: this module and `GentleCore` are registered separately, so a
 * build that has the core but not the runtime (or Expo Go) answers
 * `{"ok":false,…,"error":{"kind":"Unavailable"}}` instead of throwing.
 * ------------------------------------------------------------------ */

/** Shape of the Kotlin runtime module (`GcRuntimeModule.kt`). */
export interface GentleRuntimeNativeModule {
  /** Execs `libnode.so` with `args`; answers `{ok, exitCode, stdout, stderr}`. */
  runNode(args: string[], timeoutMs: number): Promise<string>;
  /** Execs `libgentle_ai.so` with `args`. */
  runGentleAi(args: string[], timeoutMs: number): Promise<string>;
  /** Where the binaries are and whether they are executable (diagnostics). */
  runtimeInfo(): Promise<string>;
}

let runtimeModule: GentleRuntimeNativeModule | null = null;
let runtimeLoadError = '';

try {
  runtimeModule = requireNativeModule<GentleRuntimeNativeModule>('GentleRuntime');
} catch (error) {
  runtimeLoadError = error instanceof Error ? error.message : String(error);
}

/** True when the `GentleRuntime` native module is registered in this build. */
export function runtimeModuleAvailable(): boolean {
  return runtimeModule !== null;
}

/** Why the runtime module is missing (`''` when it is registered). */
export function runtimeModuleUnavailableReason(): string {
  return runtimeModule === null ? runtimeLoadError : '';
}

/**
 * Dispatches one runtime call and always answers an envelope string.
 * Never rejects: a transport failure or a missing module becomes
 * `{ok:false,…,"error":{"kind":"Unavailable"|"NativeError"}}`.
 */
export async function callRuntime(
  method: RuntimeMethod | string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  if (runtimeModule === null) {
    return runtimeUnavailableEnvelope(
      runtimeLoadError || 'el módulo nativo GentleRuntime no está registrado en esta build',
    );
  }
  // A non-finite timeout (NaN/Infinity) would reach the bridge as garbage.
  const requested = Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : RUNTIME_DEFAULT_TIMEOUT_MS;
  const bounded = Math.min(Math.max(requested, 1_000), RUNTIME_MAX_TIMEOUT_MS);
  const argv = args.map((arg) => String(arg));
  try {
    if (method === 'runNode') {
      return await runtimeModule.runNode(argv, bounded);
    }
    if (method === 'runGentleAi') {
      return await runtimeModule.runGentleAi(argv, bounded);
    }
    return runtimeUnavailableEnvelope(`El runtime no expone «${String(method)}».`);
  } catch (error) {
    return runtimeUnavailableEnvelope(error instanceof Error ? error.message : String(error));
  }
}

/** `runtimeInfo` — resolved paths, so a device report can name the real files. */
export async function runtimeInfo(): Promise<string> {
  if (runtimeModule === null) {
    return runtimeUnavailableEnvelope(
      runtimeLoadError || 'el módulo nativo GentleRuntime no está registrado en esta build',
    );
  }
  try {
    return await runtimeModule.runtimeInfo();
  } catch (error) {
    return runtimeUnavailableEnvelope(error instanceof Error ? error.message : String(error));
  }
}
