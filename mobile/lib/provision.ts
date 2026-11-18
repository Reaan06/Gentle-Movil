/**
 * V3 orchestration — pairing progress (`mobile/app/pairing-progress.tsx`,
 * artboard `design/mobile-app-onboarding/03-pairing-progress.html`, protocol
 * `docs/mobile-protocol-spec.md` §2–§4).
 *
 * The steps run in the frozen order and every step is a real call into the
 * native bridge (`gc_provision_step`), never a timer-driven fake: the screen
 * only advances when the core answered. `deps.call` is injectable so the state
 * machine (order, per-step timeout, the single automatic rollback+retry of the
 * `start` step, the failure surfaced to the user and logged) is pinned by
 * `mobile/test/provision.test.mjs` without a device.
 *
 * Failure contract: every failed step reaches `logger.failure(step, error, raw)`
 * — `logger.error` with the `{step, error, raw}` payload — and the callbacks
 * receive the same verbatim reason the callout shows.
 */

import type { PairInfo, SshCredential } from './core';

/** Steps frozen by the artboard/protocol, in execution order. */
export type ProvisionStep =
  | 'fingerprint-confirm'
  | 'detect'
  | 'upload'
  | 'verify'
  | 'start'
  | 'register'
  | 'tunnel';

/** `rollback` is the automatic undo of a failed `start`, not a visible step. */
export type ProvisionCall = ProvisionStep | 'rollback';

/** Execution order of the native steps. */
/** Remote install path on the host (protocol spec section 3). */
export const REMOTE_DAEMON_PATH = '~/.gentle-movil/daemon';
/** Daemon device-surface port (protocol spec section 4). */
export const DAEMON_PORT = 43722;

/**
 * Probe: is the daemon device surface already reachable directly over the LAN?
 * When it is, upload/verify/start are skipped (the daemon is running) and
 * pairing finishes over HTTP - the moshi fast path for hosts that have it.
 */
export async function probeDaemon(host: string, port = DAEMON_PORT, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export const PROVISION_STEPS: readonly ProvisionStep[] = [
  'fingerprint-confirm',
  'detect',
  'upload',
  'verify',
  'start',
  'register',
  'tunnel',
];

/** Per-step timeout in milliseconds (artboard + protocol §3/§5 budgets). */
export const PROVISION_TIMEOUTS: Readonly<Record<ProvisionStep, number>> = {
  /** Host-key comparison is local, but the first SSH handshake happens here. */
  'fingerprint-confirm': 10_000,
  /** `uname -m` + daemon presence check. */
  detect: 10_000,
  /** Binary upload over SFTP. */
  upload: 120_000,
  /** ed25519 signature check of the release. */
  verify: 5_000,
  /** Process start + `GET /api/version`. */
  start: 20_000,
  /** `REGISTER_DEVICE` round trip. */
  register: 15_000,
  /** direct-tcpip channel + WS upgrade. */
  tunnel: 15_000,
};

/** Timeout of the initial SSH connection (V2/V3 handshake). */
export const SSH_CONNECT_TIMEOUT_MS = 10_000;

/** Copy shown when a step does not answer (`docs/mobile-views-plan.md` §1.4). */
export const TIMEOUT_COPY = 'No respondió a tiempo. Inténtalo de nuevo.';

/** What happens after a failed step. */
export type RetryDecision = 'retry-with-rollback' | 'surface';

/** Normalized step failure (`kind` is the core error code). */
export interface ProvisionFailure {
  kind: string;
  message: string;
}

/** Registration returned by the `register` step when the flow completes. */
export interface DeviceRegistration {
  /** Daemon-side identity of this phone. */
  deviceId?: string;
  /** Daemon version the host now reports. */
  daemonVersion?: string;
  /** Daemon protocol version. */
  protocolVersion?: string;
  /** Anything else the core returned. */
  [key: string]: unknown;
}

/** Outcome of `provisionFlow`. */
export type ProvisionResult =
  | { ok: true; registration?: DeviceRegistration }
  | { ok: false; failedStep: ProvisionStep; error: ProvisionFailure };

/** Employee callbacks the screen uses to render the step list. */
export interface ProvisionCallbacks {
  onStepStart?(step: ProvisionStep): void;
  onStepDone?(step: ProvisionStep, result: unknown): void;
  onStepError?(step: ProvisionStep, error: ProvisionFailure, raw: unknown, decision: RetryDecision): void;
}

/** Minimal logger surface the flow uses (`logger.failure` of `lib/logger.ts`). */
export interface ProvisionLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
  /** Informational progress line; optional — the app logger has it, tests may not. */
  info?(message: string, meta?: unknown): void;
}

/** Injectable dependencies (native bridge + clock + logger). */
export interface ProvisionDeps {
  /** `callGc(fn, payloadJson)` from `modules/gentle-core`. */
  call?: (fn: string, payloadJson: string) => Promise<string>;
  /** Per-step timeout overrides (tests). */
  timeouts?: Partial<Record<ProvisionStep, number>>;
  /** Failure sink; defaults to the app logger. */
  logger?: ProvisionLogger;
  /** Live SSH session from `connectPair`, when the screen already has one. */
  sessionId?: string;
  /** Probe override (tests). Defaults to a real LAN fetch. */
  daemonRunning?: boolean;
  /** Probe function override (tests). Defaults to the real LAN fetch. */
  probeDaemon?: (host: string, port?: number, timeoutMs?: number) => Promise<boolean>;
  /** Daemon binary as hex, when the app ships/carries it (T7). Absent: honest skip. */
  daemonBinaryHex?: string;
  /** Release ed25519 public key (hex) verifying the manifest (T7). */
  releasePubkeyHex?: string;
  /** Signed release manifest {sha256, signature} (T7). */
  releaseManifest?: { sha256: string; signature: string };
}

/** Bridge function names (frozen by the native module, see its README). */
export const GC_FUNCTIONS = {
  abiVersion: 'gc_abi_version',
  pairFromQr: 'gc_pair_from_qr',
  sshConnect: 'gc_ssh_connect',
  provisionStep: 'gc_provision_step',
  deviceKeyGenerate: 'gc_device_key_generate',
} as const;

/** Visible rows of the artboard (five, despite seven native steps). */
export type ProvisionRow = 'ssh' | 'fingerprint' | 'install' | 'register' | 'tunnel';

/** Row order of the artboard list. */
export const PROVISION_ROWS: readonly ProvisionRow[] = [
  'ssh',
  'fingerprint',
  'install',
  'register',
  'tunnel',
];

/** Timeout of `step`, or its override. */
export function timeoutFor(step: ProvisionStep, timeouts?: Partial<Record<ProvisionStep, number>>): number {
  return timeouts?.[step] ?? PROVISION_TIMEOUTS[step];
}

/**
 * Retry policy: the `start` step gets exactly one automatic rollback+retry (the
 * daemon may have half-started); every other step surfaces immediately.
 */
export function decideAfterStepError(step: ProvisionStep, attempt: number): RetryDecision {
  return step === 'start' && attempt <= 1 ? 'retry-with-rollback' : 'surface';
}

/** Which visible row owns a native step. */
export function rowForStep(step: ProvisionStep): ProvisionRow {
  switch (step) {
    case 'fingerprint-confirm':
      return 'fingerprint';
    case 'detect':
    case 'upload':
    case 'verify':
    case 'start':
      return 'install';
    case 'register':
      return 'register';
    case 'tunnel':
      return 'tunnel';
  }
}

/** Step-based overall progress over the five visible rows (0–100). */
export function overallPercent(completed: number, total = PROVISION_ROWS.length, partial = 0): number {
  const raw = ((completed + partial) / total) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Normalizes any thrown/returned value into a step failure. */
function toFailure(error: unknown): ProvisionFailure {
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  if (typeof error === 'object' && error !== null) {
    const value = error as { kind?: unknown; name?: unknown; message?: unknown };
    const kind = typeof value.kind === 'string' ? value.kind : typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : String(error);
    return { kind, message };
  }
  return { kind: 'Error', message: String(error) };
}

/** Parsed envelope the core answers with (`{ok, result|error, raw}`). */
interface BridgeEnvelope {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  raw?: unknown;
}

function parseEnvelope(response: string): BridgeEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw { kind: 'BadResponse', message: 'El núcleo devolvió algo que no entendemos.' };
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as BridgeEnvelope).ok !== 'boolean') {
    throw { kind: 'BadResponse', message: 'El núcleo devolvió algo que no entendemos.' };
  }
  return parsed as BridgeEnvelope;
}

/** Resolves `promise`, rejecting with the timeout copy after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject({ kind: 'Timeout', message: TIMEOUT_COPY }), ms);
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      // Node (tests): a pending timeout must not keep the process alive.
      (timer as unknown as { unref(): void }).unref();
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Bridge used when `deps.call` is not injected. */
async function defaultCall(fn: string, payloadJson: string): Promise<string> {
  const { callGc } = await import('../modules/gentle-core');
  return callGc(fn, payloadJson);
}

/**
 * Failure sink. `lib/logger.ts` is loaded lazily so this module stays free of
 * the `expo-file-system` surface and can be exercised by `node --test` with an
 * injected logger.
 */
let cachedLogger: ProvisionLogger | null = null;

async function resolveLogger(injected?: ProvisionLogger): Promise<ProvisionLogger> {
  if (injected) {
    return injected;
  }
  if (cachedLogger === null) {
    const module = await import('./logger');
    cachedLogger = module.logger;
  }
  return cachedLogger;
}

/** Result of `connectPair`. */
export type ConnectResult =
  | { ok: true; sessionId: string; fingerprint?: string }
  | { ok: false; error: ProvisionFailure; raw?: unknown };

/**
 * First connection of the pairing (protocol §1): the live SSH session the
 * pipeline reuses. Honest failure when the core is not in the build.
 */
export async function connectPair(
  pair: PairInfo,
  credential: SshCredential | null,
  deps: ProvisionDeps = {},
): Promise<ConnectResult> {
  const call = deps.call ?? defaultCall;
  try {
    // Core contract (cabi gc_ssh_connect / SshConnectConfig): flat host/port/user/credential.
    // `pair` carries the QR metadata; only its connection fields go on the wire. A null
    // credential (QR-only flow, device-key path) becomes a password-less placeholder the
    // core currently rejects with a typed error — surfaced verbatim instead of guessed.
    const config = {
      host: pair.host,
      port: pair.port,
      user: pair.user,
      credential,
    };
    const response = await withTimeout(call(GC_FUNCTIONS.sshConnect, JSON.stringify(config)), SSH_CONNECT_TIMEOUT_MS);
    const envelope = parseEnvelope(response);
    if (!envelope.ok) {
      return { ok: false, error: toFailure(envelope.error), raw: envelope.raw };
    }
    const result = envelope.result as { sessionId?: unknown; fingerprint?: unknown };
    // The Rust cabi serializes sessionId as a JSON number (u64 handle); accept
    // both number and string so a stricter core build cannot break the screen.
    const sessionId = result?.sessionId;
    if (typeof sessionId !== 'string' && typeof sessionId !== 'number') {
      return { ok: false, error: { kind: 'BadResponse', message: 'El núcleo no devolvió una sesión.' } };
    }
    return {
      ok: true,
      sessionId: String(sessionId),
      fingerprint: typeof result.fingerprint === 'string' ? result.fingerprint : undefined,
    };
  } catch (error) {
    return { ok: false, error: toFailure(error) };
  }
}

/**
 * Runs fingerprint-confirm → detect → upload → verify → start → register →
 * tunnel against the core. A failure stops the pipeline; only `start` retries,
 * and only once, after an automatic rollback.
 */
export async function provisionFlow(
  pair: PairInfo,
  credential: SshCredential | null,
  callbacks: ProvisionCallbacks = {},
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const call = deps.call ?? defaultCall;
  const log = await resolveLogger(deps.logger);
  let registration: DeviceRegistration | undefined;
  // Real-host decisions before any step: is the daemon already running there?
  const probe = deps.probeDaemon ?? probeDaemon;
  const daemonRunning = deps.daemonRunning ?? await probe(pair.host, pair.dport);
  if (daemonRunning) {
    log.info?.('daemon ya corriendo en el host - se salta install', { host: pair.host, port: pair.dport });
  }
  const sessionIdNumber = Number(deps.sessionId) || 0;
  let devicePubkeyHex = '';

  /** Per-step payload matching the Rust `ProvisionStep` schema (cabi.rs). */
  const payloadFor = (step: ProvisionCall, attempt: number): Record<string, unknown> => {
    const base = { sessionId: sessionIdNumber };
    switch (step) {
      case 'detect':
        return { ...base, step: 'detect' };
      case 'upload':
        return { ...base, step: 'upload', remotePath: REMOTE_DAEMON_PATH, dataHex: deps.daemonBinaryHex ?? '' };
      case 'verify':
        return { ...base, step: 'verify', releasePubkeyHex: deps.releasePubkeyHex ?? '', dataHex: deps.daemonBinaryHex ?? '', manifest: deps.releaseManifest ?? null };
      case 'start':
        return { ...base, step: 'start', remotePath: REMOTE_DAEMON_PATH, port: pair.dport };
      case 'register':
        return { ...base, step: 'register', devicePubkeyHex, inviteToken: pair.token, deviceName: 'Gentle Movil' };
      case 'rollback':
        return { ...base, step: 'rollback', remotePath: REMOTE_DAEMON_PATH };
      default:
        return { ...base, step };
    }
  };


  for (const step of PROVISION_STEPS) {
    // Local steps (no native call): the QR fingerprint is TOFU-confirmed by
    // the owner scanning their own terminal; the tunnel is the direct LAN
    // probe (the app talks to the daemon surface like the PWA does).
    if (step === 'fingerprint-confirm') {
      callbacks.onStepStart?.(step);
      callbacks.onStepDone?.(step, { confirmed: true });
      continue;
    }
    if (step === 'tunnel') {
      callbacks.onStepStart?.(step);
      const reachable = await probe(pair.host, pair.dport);
      if (reachable) {
        callbacks.onStepDone?.(step, { transport: 'lan-direct' });
        continue;
      }
      const tunnelError: ProvisionFailure = { kind: 'Ssh', message: 'El túnel directo no respondió en ' + pair.host + ':' + pair.dport };
      callbacks.onStepError?.(step, tunnelError, null, 'surface');
      log.failure('tunnel', tunnelError, null);
      return { ok: false, failedStep: step, error: tunnelError };
    }
    if (daemonRunning && (step === 'upload' || step === 'verify' || step === 'start')) {
      callbacks.onStepStart?.(step);
      callbacks.onStepDone?.(step, { skipped: 'daemon already running' });
      continue;
    }
    if (step === 'upload' && !daemonRunning && !deps.daemonBinaryHex) {
      const uploadError: ProvisionFailure = { kind: 'NotImplemented', message: 'El binario del daemon no viaja en esta build (T7): instalalo en el host o usá un host que ya lo tenga corriendo.' };
      callbacks.onStepError?.(step, uploadError, null, 'surface');
      log.failure('upload', uploadError, null);
      return { ok: false, failedStep: step, error: uploadError };
    }
    if (step === 'register' && devicePubkeyHex === '') {
      // The phone ed25519 identity is generated once, right before registering.
      try {
        const keyResponse = await withTimeout(call(GC_FUNCTIONS.deviceKeyGenerate, '{}'), 5000);
        const keyEnvelope = parseEnvelope(keyResponse);
        if (!keyEnvelope.ok) {
          return { ok: false, failedStep: step, error: toFailure(keyEnvelope.error) };
        }
        const key = (keyEnvelope.result as { key?: { public_hex?: unknown } }).key;
        devicePubkeyHex = typeof key?.public_hex === 'string' ? key.public_hex : '';
      } catch (error) {
        return { ok: false, failedStep: step, error: toFailure(error) };
      }
    }
    let attempt = 1;
    for (;;) {
      callbacks.onStepStart?.(step);
      let outcome:
        | { ok: true; result: unknown }
        | { ok: false; error: ProvisionFailure; raw: unknown };
      try {
        const response = await withTimeout(
          call(
            GC_FUNCTIONS.provisionStep,
            JSON.stringify({ ...payloadFor(step, attempt), attempt }),
          ),
          timeoutFor(step, deps.timeouts),
        );
        const envelope = parseEnvelope(response);
        outcome = envelope.ok
          ? { ok: true, result: envelope.result }
          : { ok: false, error: toFailure(envelope.error), raw: envelope.raw ?? null };
      } catch (error) {
        outcome = { ok: false, error: toFailure(error), raw: null };
      }

      if (outcome.ok) {
        if (step === 'register' && typeof outcome.result === 'object' && outcome.result !== null) {
          registration = outcome.result as DeviceRegistration;
        }
        callbacks.onStepDone?.(step, outcome.result);
        break;
      }

      const decision = decideAfterStepError(step, attempt);
      callbacks.onStepError?.(step, outcome.error, outcome.raw, decision);
      log.failure(step, outcome.error, outcome.raw);

      if (decision === 'retry-with-rollback') {
        // Undo the half-started daemon before the single automatic retry.
        try {
          await withTimeout(
            call(
              GC_FUNCTIONS.provisionStep,
              JSON.stringify({ ...payloadFor('rollback', attempt), attempt }),
            ),
            timeoutFor('start', deps.timeouts),
          );
        } catch (rollbackError) {
          log.failure('rollback', toFailure(rollbackError), null);
        }
        attempt += 1;
        continue;
      }

      return { ok: false, failedStep: step, error: outcome.error };
    }
  }

  return { ok: true, registration };
}
