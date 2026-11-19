/**
 * Reconnect with the saved device key (T17, S11/S12).
 *
 * After the onboarding, the pairing is persisted (`lib/connections.ts`) and the
 * phone key is already in the PC's `authorized_keys` (the `register` step of the
 * pairing flow, S4). So a later start does **not** need the onboarding, the QR,
 * the password or `register` again: it needs a key-only SSH session and the
 * tunnel the connected screens talk through. This module owns exactly that:
 *
 * ```
 * device-key  deviceKeyEnsure()  → is the key we paired with still here?
 * connect     sshConnectWithDeviceKey({host, port, user, expectedFingerprint})
 * detect      gc_provision_step 'detect'  (loopbackProbeScript, 43721/43722)
 * tunnel      gc_provision_step 'tunnel'  (forwards → parseTunnelChannels)
 * store       setActiveTunnel({sessionId, httpChannel, host})
 * ```
 *
 * `detect`/`tunnel` are the helpers of `lib/provision.ts`, unchanged: the probe
 * script, the port list and the channel parser are the pairing flow's own, so a
 * reconnect cannot agree with a tunnel the pairing would have refused.
 *
 * ## The core surface (real ABI layer, never the dev stub)
 *
 * The three core calls are named by the frozen contract (`deviceKeyEnsure`,
 * `sshConnectWithDeviceKey`, `sshClose`) and shipped by
 * `modules/gentle-core/src/abi.ts`. The default surface is **that layer**
 * (`defaultReconnectCore`), the same one `lib/local-fs.ts` reads `fsList`/`fsRead` from:
 * resolving the legacy `core` object of `lib/core.ts` lands on the dev stub, whose methods
 * always throw, so a real device (ABI layer and Kotlin module present) answered
 * `Unavailable` and never connected (T17 hardware defect). Everything goes through an
 * injectable seam, so `mobile/test/reconnect.test.mjs` drives the whole orchestration with
 * a fake core — no device, no PC, no native module.
 *
 * A call that never reached the core says **which** surface it was missing: this build's JS
 * layer has no frozen member (`Unavailable`), or the native core is not packed
 * (`CoreUnavailable`, naming `libmobile_core.so`). Whatever the core did answer keeps its own
 * kind and its own message, verbatim.
 *
 * ## Honesty contract (S7)
 *
 * - the outcome is a typed union; there is no "assume it worked" branch and no
 *   tunnel is stored unless both channels really opened;
 * - `connected` carries the record and the real channels; anything else carries
 *   the real step, the core's message verbatim, and the raw evidence;
 * - a session opened before a later step failed is closed (`sshClose`) instead
 *   of leaking, and a close whose handle was released without the transport
 *   confirming it is logged with that real cause **without** masking the
 *   failure that sent us there;
 * - the connect answer has to name the host key the handshake verified: a
 *   fingerprint-less answer is never `connected` (it is
 *   `fingerprint-mismatch`, and the session it leaked is closed).
 * - every failure is logged with `{step, error, raw}`.
 */

import {
  EXTENSION_HTTP_PORT,
  EXTENSION_LOOPBACK_HOST,
  EXTENSION_LOOPBACK_PORTS,
  GC_FUNCTIONS,
  PROVISION_TIMEOUTS,
  TIMEOUT_COPY,
  loopbackProbeScript,
  normalizeHostFingerprint,
  parseTunnelChannels,
  type ProvisionFailure,
  type TunnelChannel,
} from './provision.ts';
import {
  deviceKeyEnsure as abiDeviceKeyEnsure,
  sshClose as abiSshClose,
  sshConnectWithDeviceKey as abiSshConnectWithDeviceKey,
  type SshCloseOutcome,
} from '../modules/gentle-core/src/abi.ts';
import { httpChannelOf, setActiveTunnel, type ActiveTunnel } from './tunnel-store.ts';
import {
  type ConnectionRecord,
  type ConnectionsLog,
  type ConnectionsStorage,
  connectionsLog,
  readActiveConnection,
} from './connections.ts';

/** Steps of one reconnect, in execution order (`fingerprint` is the PC's). */
export type ReconnectStep = 'device-key' | 'connect' | 'detect' | 'tunnel' | 'storage' | 'select';

/** Timeout of one reconnect step, in ms (reuses the pairing budgets). */
export const RECONNECT_TIMEOUTS: Readonly<Record<ReconnectStep, number>> = {
  'device-key': 5_000,
  connect: PROVISION_TIMEOUTS.connect,
  detect: PROVISION_TIMEOUTS.detect,
  tunnel: PROVISION_TIMEOUTS.tunnel,
  /** Local storage reads; bounded so a hung store cannot freeze the entry. */
  storage: 5_000,
  /** Local selection; no call at all. */
  select: 0,
};

/**
 * What a reconnect really produced. Only `connected` means a tunnel is open;
 * every other member names the step that did not happen.
 */
export type ReconnectOutcome =
  | { kind: 'connected'; record: ConnectionRecord; sessionId: string; channels: TunnelChannel[] }
  | { kind: 'no-saved-connection' }
  /**
   * The phone key is gone or is not the one the PC accepted (a `deviceKeyEnsure`
   * failure, or its fingerprint no longer matching the saved pairing). Retrying
   * cannot help: the device has to be paired again.
   *
   * `raw.cause` says whether the call reached the core at all: `native-core-missing`
   * (this build has no `libmobile_core.so`), `surface-missing` (the JS layer has no frozen
   * member), or absent (the core was asked and rejected — `raw.kind`/`message` are its own).
   */
  | {
      kind: 'no-device-key';
      message: string;
      raw: {
        kind: string;
        saved: string;
        current: string | null;
        /** Set only when the call never reached the core (`surfaceFailureCause`). */
        cause?: SurfaceFailureCause;
      };
    }
  /** The PC presented a host key that is not the pinned one: never trusted. */
  | {
      kind: 'fingerprint-mismatch';
      /** The connect step is the one that refused: no session was ever pinned. */
      step: 'connect';
      expected: string;
      /** The key the answer showed, or `null` when it showed none (`observed: null`). */
      observed: string | null;
      message: string;
      raw: { kind: string; raw: unknown };
    }
  /** The PC could not be reached at that step (nothing about it is known). */
  | { kind: 'offline'; step: ReconnectStep; message: string; raw: { kind: string; raw: unknown } }
  /** A step failed for its own reason; `step` is the real one. */
  | { kind: 'failed'; step: ReconnectStep; message: string; raw: { kind: string; raw: unknown } };

/** The subset of outcomes that are failures (everything but `connected`). */
export type ReconnectFailureOutcome = Exclude<ReconnectOutcome, { kind: 'connected' }>;

/** `deviceKeyEnsure` of the frozen core surface. */
export type DeviceKeyEnsure = () => Promise<{ publicHex: string; fingerprint: string }>;

/** Input of `sshConnectWithDeviceKey` (the pinned host key included). */
export interface DeviceKeyConnectInput {
  host: string;
  port: number;
  user: string;
  expectedFingerprint: string;
}

/**
 * What a pinned connect answered.
 *
 * `fingerprint` is required by the frozen contract (`mobile/modules/gentle-core/src/abi.ts`,
 * SEC-013) and optional in this *shape* on purpose: a build that omits it has to be
 * representable so it can be classified as the failure it is, never coerced into a session.
 */
export interface DeviceKeyConnectAnswer {
  sessionId: string;
  /** Host key the handshake verified, in any display form; absent when nothing proved it. */
  fingerprint?: string | null;
}

/** The frozen core calls this module drives. */
export interface ReconnectCore {
  deviceKeyEnsure: DeviceKeyEnsure;
  sshConnectWithDeviceKey(input: DeviceKeyConnectInput): Promise<DeviceKeyConnectAnswer>;
  sshClose(sessionId: string): Promise<SshCloseOutcome>;
}

/** Everything one reconnect needs; every member is injectable. */
export interface ReconnectDeps {
  /** Registry storage (AsyncStorage in the app). */
  storage: ConnectionsStorage;
  /** `callGc(fn, payloadJson)` of the native bridge, for the provision steps. */
  call?: (fn: string, payloadJson: string) => Promise<string>;
  /** Frozen core: device key, key-only connect and session close. */
  deviceKeyEnsure?: DeviceKeyEnsure;
  sshConnectWithDeviceKey?: (input: DeviceKeyConnectInput) => Promise<DeviceKeyConnectAnswer>;
  sshClose?: (sessionId: string) => Promise<SshCloseOutcome>;
  /**
   * Frozen core surface as a whole. Omitted → resolved from the real ABI layer
   * (`defaultReconnectCore`); `null` → the caller already knows this build has no frozen
   * member at all. The per-member seams above win over it, so a test can drive one call.
   */
  coreSurface?: ReconnectCore | null;
  /** Where the opened tunnel is kept (defaults to `setActiveTunnel`). */
  setTunnel?: (tunnel: ActiveTunnel | null) => void;
  /** Failure sink; defaults to `logger.tag('connections')`. */
  log?: ConnectionsLog;
  /** Per-step timeout overrides (tests). */
  timeouts?: Partial<Record<ReconnectStep, number>>;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Normalized step failure (`kind` is the core error code). */
function toFailure(error: unknown): ProvisionFailure {
  if (typeof error === 'object' && error !== null) {
    const value = error as { kind?: unknown; name?: unknown; message?: unknown };
    const kind =
      typeof value.kind === 'string' ? value.kind : typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : String(error);
    return { kind, message };
  }
  return { kind: 'Error', message: String(error) };
}

/** Error kinds that mean "the PC is not reachable", not "the step is broken". */
const OFFLINE_KINDS: readonly string[] = [
  'offline',
  'timeout',
  'connect',
  'unreachable',
  'hostunreachable',
  'networkunreachable',
  'connectionrefused',
  'network',
];

/** Error kinds that mean "the host key is not the pinned one". */
const FINGERPRINT_KINDS: readonly string[] = [
  'fingerprint',
  'fingerprintmismatch',
  'hostkeymismatch',
  'hostkeychanged',
  'hostkey',
  'pinned',
];

function kindOf(failure: ProvisionFailure): string {
  return failure.kind.trim().toLowerCase();
}

/**
 * Sentences that mean "no host key was verified".
 *
 * The hardened core says it in `cabi.rs` (`session_answer`, SEC-013) and closes the session
 * itself; this layer's own contract refusal (`modules/gentle-core/src/abi.ts`) says it in
 * Spanish. Both must land in `fingerprint-mismatch`, never in a generic failure the UI
 * could paint as retryable.
 */
const MISSING_HOST_FINGERPRINT_MARKERS: readonly RegExp[] = [
  /no usable host key fingerprint/i,
  /no devolvió la huella del host/i,
];

function namesMissingHostFingerprint(failure: ProvisionFailure): boolean {
  return MISSING_HOST_FINGERPRINT_MARKERS.some((marker) => marker.test(failure.message));
}

/** Rejects after `ms`; the timer never keeps the process alive (tests). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject({ kind: 'Timeout', message: TIMEOUT_COPY }), ms);
    if (timer && typeof timer === 'object' && 'unref' in timer) {
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

/** Parsed envelope of one bridge call (`{ok, result|error, raw}`). */
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

/**
 * Default bridge: the app's `callGc`. Loaded lazily so this module (and its
 * tests) never pull the native module in when a seam is injected.
 */
async function defaultCall(fn: string, payloadJson: string): Promise<string> {
  const { callGc } = await import('../modules/gentle-core');
  return callGc(fn, payloadJson);
}

/* ------------------------------------------------------------------ *
 * The core surface (real ABI layer, never the dev stub)
 * ------------------------------------------------------------------ */

/** The named members the frozen surface lives under (a module namespace or an object). */
export interface ReconnectCoreSurface {
  deviceKeyEnsure?: unknown;
  sshConnectWithDeviceKey?: unknown;
  sshClose?: unknown;
}

/**
 * Reads the frozen surface off a candidate binding.
 *
 * `null` means the three members are really not there in this build, and only that case may
 * be reported as a missing surface. Nothing here throws, so the decision is never a crash
 * with a stack trace in place of the outcome.
 */
export function coreReconnectSurface(candidate: unknown): ReconnectCore | null {
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const ensure = record.deviceKeyEnsure;
  const connect = record.sshConnectWithDeviceKey;
  const close = record.sshClose;
  if (typeof ensure !== 'function' || typeof connect !== 'function' || typeof close !== 'function') {
    return null;
  }
  return {
    deviceKeyEnsure: () =>
      (ensure as (this: unknown) => Promise<{ publicHex: string; fingerprint: string }>).call(
        candidate,
      ),
    sshConnectWithDeviceKey: (input) =>
      (
        connect as (
          this: unknown,
          value: DeviceKeyConnectInput,
        ) => Promise<DeviceKeyConnectAnswer>
      ).call(candidate, input),
    sshClose: (sessionId) =>
      (close as (this: unknown, id: string) => Promise<SshCloseOutcome>).call(candidate, sessionId),
  };
}

/**
 * The ABI surface this build really ships: the three functions of
 * `modules/gentle-core/src/abi.ts` (the same ones `lib/core.ts` re-exports).
 *
 * Returned as a plain surface object so `coreReconnectSurface` reads it exactly like any
 * other binding, keeping the members' own `this`.
 */
export function abiReconnectSurface(): Required<ReconnectCoreSurface> {
  return {
    deviceKeyEnsure: abiDeviceKeyEnsure,
    sshConnectWithDeviceKey: abiSshConnectWithDeviceKey,
    sshClose: abiSshClose,
  };
}

/**
 * The default surface: the ABI layer, never the dev stub of `lib/core.ts`.
 *
 * `lib/core.ts` still exports a `core` binding whose `deviceKeyEnsure`/`sshConnectWithDeviceKey`/
 * `sshClose` are the throwing placeholder. Resolving *that* object made a real device — with
 * the ABI layer and the Kotlin module present — answer the typed `Unavailable` failure and
 * never connect (T17 hardware defect). With no native core bound these ABI calls fail with
 * their honest `CoreUnavailable` cause naming `libmobile_core.so`, which is a different fact
 * from "the JS surface is missing" and is reported as such.
 */
export function defaultReconnectCore(): ReconnectCore | null {
  return coreReconnectSurface(abiReconnectSurface());
}

/**
 * Resolves the surface of a candidate binding (`undefined` → the ABI layer).
 *
 * Injected by the tests and by any caller that holds a different binding, so the seam never
 * has to guess which object the three frozen members live on.
 */
export function resolveReconnectCore(
  surface: unknown = abiReconnectSurface(),
): ReconnectCore | null {
  return coreReconnectSurface(surface);
}

/** Kind of a surface this build does not have (never used while the surface is present). */
export const SURFACE_MISSING_KIND = 'Unavailable';

/** Message of a build whose JS layer does not expose one frozen member at all. */
export function surfaceMissingMessage(name: string): string {
  return `Esta build no incluye ${name} en su capa ABI del núcleo, así que no podemos reconectar.`;
}

/** Why a call never reached the core, when it never did. */
export type SurfaceFailureCause = 'surface-missing' | 'native-core-missing';

/** True when the failure means the native core is not packed in this build. */
export function namesMissingNativeCore(failure: ProvisionFailure): boolean {
  return kindOf(failure) === 'coreunavailable' || /libmobile_core/i.test(failure.message);
}

/** True when the failure means this build's JS layer has no such member at all. */
export function namesMissingSurface(failure: ProvisionFailure): boolean {
  return kindOf(failure) === 'unavailable' && !namesMissingNativeCore(failure);
}

/**
 * Honest cause of a call that never reached the core, or `null` when the core was asked.
 *
 * The two absences are not the same fact: `surface-missing` is a broken/older JS bundle
 * (this module's own `Unavailable`), `native-core-missing` is a build without
 * `libmobile_core.so` (the ABI layer's `CoreUnavailable`, which names it). A rejection keeps
 * no cause: its own `kind` and `message` say what happened.
 */
export function surfaceFailureCause(failure: ProvisionFailure): SurfaceFailureCause | null {
  if (namesMissingSurface(failure)) {
    return 'surface-missing';
  }
  if (namesMissingNativeCore(failure)) {
    return 'native-core-missing';
  }
  return null;
}

/** Two device-key fingerprints name the same key (hex is case-insensitive). */
function sameDeviceFingerprint(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === '' || right === '') {
    return false;
  }
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * The orchestration
 * ------------------------------------------------------------------ */

/** Outcome of one `gc_provision_step` call. */
type StepOutcome = { ok: true; result: unknown } | { ok: false; error: ProvisionFailure; raw: unknown };

/**
 * Reconnects using the active saved connection. Resolves a typed outcome and
 * never throws: a broken store, a missing core call, an unreachable PC, a
 * changed host key and a failed tunnel each get their own answer.
 */
export async function reconnectFromSaved(deps: ReconnectDeps): Promise<ReconnectOutcome> {
  const log = deps.log ?? connectionsLog;
  const timeouts = deps.timeouts;
  const timeoutOf = (step: ReconnectStep): number => timeouts?.[step] ?? RECONNECT_TIMEOUTS[step];

  // The frozen surface: the injected per-member seam wins, then the whole-surface seam, then
  // this build's real ABI layer. Resolved once, so one reconnect cannot mix two surfaces.
  let resolvedSurface: ReconnectCore | null | undefined;
  const surface = (): ReconnectCore | null => {
    if (resolvedSurface === undefined) {
      resolvedSurface = deps.coreSurface === undefined ? defaultReconnectCore() : deps.coreSurface;
    }
    return resolvedSurface;
  };

  /**
   * One frozen member, or the honest "this build has no such member" failure. The missing
   * surface is claimed **only** here, where the member really is not a function.
   */
  const member = <K extends keyof ReconnectCore>(name: K): ReconnectCore[K] => {
    const injected = deps[name];
    if (typeof injected === 'function') {
      return injected as unknown as ReconnectCore[K];
    }
    const found = surface()?.[name];
    if (typeof found !== 'function') {
      throw { kind: SURFACE_MISSING_KIND, message: surfaceMissingMessage(String(name)) };
    }
    return found as ReconnectCore[K];
  };

  /** Logs a failure as `{step, error, raw}` and builds the typed outcome. */
  const failed = (
    step: ReconnectStep,
    failure: ProvisionFailure,
    raw: unknown,
  ): ReconnectFailureOutcome => {
    log.failure(step, failure, raw);
    return {
      kind: 'failed',
      step,
      message: failure.message,
      raw: { kind: failure.kind, raw: raw ?? null },
    };
  };

  /** Sends one provision step to the core with the pairing flow's payload shape. */
  const runStep = async (
    step: 'detect' | 'tunnel',
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<StepOutcome> => {
    const call = deps.call ?? defaultCall;
    try {
      const body = { sessionId: Number(sessionId) || 0, step, ...payload };
      const envelope = parseEnvelope(
        await withTimeout(call(GC_FUNCTIONS.provisionStep, JSON.stringify(body)), timeoutOf(step)),
      );
      return envelope.ok
        ? { ok: true, result: envelope.result }
        : { ok: false, error: toFailure(envelope.error), raw: envelope.raw ?? null };
    } catch (error) {
      return { ok: false, error: toFailure(error), raw: null };
    }
  };

  // 0) which device? -------------------------------------------------------
  const read = await readActiveConnection(deps.storage, log);
  if (!read.ok) {
    return failed(
      'storage',
      { kind: 'Storage', message: 'no pudimos leer las conexiones guardadas de este teléfono' },
      { key: 'gentle-movil:connections' },
    );
  }
  if (read.records.length === 0) {
    // A damaged payload is NOT "there was never a pairing": that would send the
    // person through the onboarding for a storage failure (S12).
    if (read.repaired) {
      return failed(
        'storage',
        {
          kind: 'Storage',
          message: 'las conexiones guardadas están dañadas: no se pudo leer ninguna',
        },
        { key: 'gentle-movil:connections' },
      );
    }
    log.info('sin conexiones guardadas', { records: 0 });
    return { kind: 'no-saved-connection' };
  }
  if (read.active === null) {
    return failed(
      'select',
      {
        kind: 'Select',
        message: 'ninguna conexión guardada está marcada como activa: elegí una de la lista',
      },
      { saved: read.records.map((record) => record.id) },
    );
  }
  const record = read.active;

  // 1) the phone key -------------------------------------------------------
  // The PC only accepts the key that was registered during pairing, so a phone
  // without it (app data wiped, Keystore reset) is told to pair again instead of
  // opening a session that is guaranteed to be refused.
  let current: { publicHex: string; fingerprint: string };
  try {
    const ensure = member('deviceKeyEnsure');
    current = await withTimeout(ensure(), timeoutOf('device-key'));
  } catch (error) {
    const failure = toFailure(error);
    const cause = surfaceFailureCause(failure);
    const evidence = {
      kind: failure.kind,
      saved: record.deviceKeyFingerprint,
      current: null,
      ...(cause === null ? {} : { cause }),
    };
    log.failure('device-key', failure, evidence);
    return { kind: 'no-device-key', message: failure.message, raw: evidence };
  }
  if (
    record.deviceKeyFingerprint.trim() !== '' &&
    !sameDeviceFingerprint(current.fingerprint, record.deviceKeyFingerprint)
  ) {
    const message =
      'este teléfono ya no tiene la llave con la que se emparejó: volvé a emparejar el dispositivo';
    const evidence = {
      kind: 'DeviceKeyMismatch',
      saved: record.deviceKeyFingerprint,
      current: current.fingerprint,
    };
    log.failure('device-key', new Error(message), evidence);
    return { kind: 'no-device-key', message, raw: evidence };
  }

  /** Closes a session this attempt no longer keeps (best effort, never throws). */
  const closeSession = async (id: string): Promise<void> => {
    try {
      const close = member('sshClose');
      const report = await withTimeout(close(id), timeoutOf('connect'));
      if (report?.kind === 'removed-unconfirmed') {
        // The core released the handle and then found the transport still connected
        // (`ffi.rs` session_close, SEC-012). The real cause is logged with the handle — and
        // it never replaces the failure that sent us here.
        log.failure(
          'connect',
          { kind: 'CloseUnconfirmed', message: report.message },
          { sessionId: id, reason: CLOSE_UNCONFIRMED_REASON, raw: report.raw ?? null },
        );
        return;
      }
      log.info('sesión SSH cerrada', { sessionId: id, outcome: report?.kind ?? null });
    } catch (error) {
      log.failure('connect', error, { sessionId: id, reason: 'no se pudo cerrar la sesión' });
    }
  };

  // 2) the key-only SSH session -------------------------------------------
  let sessionId: string;
  let answer: DeviceKeyConnectAnswer | null = null;
  try {
    const connect = member('sshConnectWithDeviceKey');
    answer = await withTimeout(
      connect({
        host: record.host,
        port: record.port,
        user: record.user,
        expectedFingerprint: record.fingerprint,
      }),
      timeoutOf('connect'),
    );
    const id = answer?.sessionId;
    if (id === undefined || id === null || String(id).trim() === '') {
      return failed(
        'connect',
        { kind: 'BadResponse', message: 'El núcleo no devolvió una sesión SSH.' },
        answer ?? null,
      );
    }
    sessionId = String(id);
  } catch (error) {
    const failure = toFailure(error);
    const evidence = { kind: failure.kind, raw: null };
    // Nothing verified the host, so there is no pinned session to be had (SEC-013).
    // Retrying cannot help either: the answer has to name the host key it verified.
    if (namesMissingHostFingerprint(failure)) {
      log.failure('connect', failure, evidence);
      return {
        kind: 'fingerprint-mismatch',
        step: 'connect',
        expected: record.fingerprint,
        observed: null,
        message: HOST_FINGERPRINT_MISSING_COPY,
        raw: evidence,
      };
    }
    // A core that reports the key it saw (`observed`) is answering a host-key
    // disagreement even when its own kind is not in the list: the PC presented a
    // key that is not the pinned one, and that must never be trusted.
    if (FINGERPRINT_KINDS.includes(kindOf(failure)) || hasOwn(error, 'observed')) {
      const observed = observedFingerprint(error);
      log.failure('connect', failure, { ...evidence, observed });
      return {
        kind: 'fingerprint-mismatch',
        step: 'connect',
        expected: record.fingerprint,
        observed,
        message: failure.message,
        raw: evidence,
      };
    }
    if (OFFLINE_KINDS.includes(kindOf(failure))) {
      log.failure('connect', failure, evidence);
      return { kind: 'offline', step: 'connect', message: failure.message, raw: evidence };
    }
    return failed('connect', failure, null);
  }

  // A session counts as pinned only when the answer names the host key the handshake
  // verified. The core closes a fingerprint-less session itself (`cabi.rs` session_answer);
  // a build that still answers one is never `connected`, and its handle is closed here.
  const pinned = normalizeHostFingerprint(record.fingerprint);
  if (pinned === null) {
    await closeSession(sessionId);
    return failed(
      'connect',
      {
        kind: 'Storage',
        message: `la huella guardada de ${record.host} no es un SHA-256 en hex, así que no se puede fijar la sesión`,
      },
      { saved: record.fingerprint },
    );
  }
  const observedRaw = typeof answer?.fingerprint === 'string' ? answer.fingerprint.trim() : '';
  const observed = observedRaw === '' ? null : normalizeHostFingerprint(observedRaw);
  if (observed !== pinned) {
    await closeSession(sessionId);
    const kind = observed === null ? 'MissingFingerprint' : 'FingerprintMismatch';
    const message =
      observed === null ? HOST_FINGERPRINT_MISSING_COPY : HOST_FINGERPRINT_CHANGED_COPY;
    const evidence = { kind, raw: observedRaw === '' ? null : observedRaw };
    log.failure('connect', { kind, message }, evidence);
    return {
      kind: 'fingerprint-mismatch',
      step: 'connect',
      expected: record.fingerprint,
      observed,
      message,
      raw: evidence,
    };
  }

  // 3) the extension on loopback ------------------------------------------
  let detectScript: string;
  try {
    detectScript = loopbackProbeScript();
  } catch (error) {
    await closeSession(sessionId);
    return failed('detect', toFailure(error), { ports: EXTENSION_LOOPBACK_PORTS });
  }
  const detected = await runStep('detect', sessionId, {
    ports: [...EXTENSION_LOOPBACK_PORTS],
    command: detectScript,
  });
  if (!detected.ok) {
    await closeSession(sessionId);
    return failed('detect', detected.error, detected.raw);
  }
  log.info('extensión Pi detectada', { ports: EXTENSION_LOOPBACK_PORTS, result: detected.result ?? null });

  // 4) the tunnel ----------------------------------------------------------
  const tunneled = await runStep('tunnel', sessionId, {
    forwards: EXTENSION_LOOPBACK_PORTS.map((port) => ({ host: EXTENSION_LOOPBACK_HOST, port })),
  });
  if (!tunneled.ok) {
    await closeSession(sessionId);
    return failed('tunnel', tunneled.error, tunneled.raw);
  }

  let channels: TunnelChannel[];
  try {
    channels = parseTunnelChannels(tunneled.result);
  } catch (error) {
    await closeSession(sessionId);
    return failed('tunnel', toFailure(error), tunneled.result ?? null);
  }

  // 5) keep the tunnel — only when the HTTP channel the app speaks through is
  //    really one of the opened ones.
  const handles = { sessionId, channels };
  const httpChannel = httpChannelOf(handles);
  if (httpChannel === null) {
    await closeSession(sessionId);
    return failed(
      'tunnel',
      {
        kind: 'NoChannel',
        message: `El túnel no abrió el canal HTTP al puerto ${EXTENSION_HTTP_PORT}.`,
      },
      { channels: channels.map((channel) => channel.port) },
    );
  }

  try {
    (deps.setTunnel ?? setActiveTunnel)({ sessionId, host: record.host, httpChannel });
  } catch (error) {
    await closeSession(sessionId);
    return failed('tunnel', toFailure(error), { sessionId, port: httpChannel.port });
  }

  log.info('reconectado con la llave guardada', {
    host: record.host,
    port: record.port,
    user: record.user,
    sessionId,
    channels: channels.map((channel) => channel.port),
  });
  return { kind: 'connected', record, sessionId, channels };
}

/** True when `value` is an object that carries `key` itself. */
function hasOwn(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

/** Host fingerprint a core failure reported as observed, when it reported one. */
function observedFingerprint(error: unknown): string | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const value = (error as { observed?: unknown }).observed;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/* ------------------------------------------------------------------ *
 * Copy (es-AR)
 * ------------------------------------------------------------------ */

/** The reconnecting line the entry shows while the session is being opened. */
export const RECONNECTING_COPY = 'Reconectando con ';

/** Host shown when the caller has no real one. */
export const UNKNOWN_HOST_COPY = 'tu-pc';

/** `Reconectando con 192.168.0.10…` — the honest in-flight state of the entry. */
export function reconnectingCopy(host: string | null | undefined): string {
  const text = typeof host === 'string' ? host.trim() : '';
  return `${RECONNECTING_COPY}${text === '' ? UNKNOWN_HOST_COPY : text}…`;
}

/** Noun of each step, for the title of a failure. */
const STEP_TITLE: Readonly<Record<ReconnectStep, string>> = {
  'device-key': 'la llave del teléfono',
  connect: 'la conexión SSH',
  detect: 'la detección de la extensión',
  tunnel: 'el túnel SSH',
  storage: 'las conexiones guardadas',
  select: 'la conexión activa',
};

/** Action phrasing of each step, for the copy under the title. */
const STEP_ACTION: Readonly<Record<ReconnectStep, string>> = {
  'device-key': 'leer la llave del teléfono',
  connect: 'conectar',
  detect: 'detectar la extensión',
  tunnel: 'abrir el túnel SSH',
  storage: 'leer las conexiones guardadas',
  select: 'elegir la conexión activa',
};

/** Button that really retries the same reconnect. */
export const RETRY_LABEL = 'Reintentar';

/** Button that goes back to the onboarding without deleting the saved devices. */
export const ESCAPE_LABEL = 'Agregar otro dispositivo';

/**
 * What the entry says when the core answered a session without the host key it verified.
 *
 * The session is not pinned, so the honest answer is that nothing was trusted — not a
 * retry promise (the same answer would come back) (SEC-013).
 */
export const HOST_FINGERPRINT_MISSING_COPY =
  'El núcleo no devolvió la huella del host que verificó el handshake, así que no damos la sesión por fijada.';

/** What the entry says when the session reported a host key other than the paired one. */
const HOST_FINGERPRINT_CHANGED_COPY =
  'La sesión se abrió con una huella del host distinta de la que se emparejó, así que no la damos por fijada.';

/**
 * Reason recorded when a close released the handle and the transport did not confirm.
 * The session is gone from the registry, so the id is stale and nothing is retried.
 */
export const CLOSE_UNCONFIRMED_REASON =
  'el handle se liberó pero el transporte no confirmó el cierre';

/** Note shown instead of a retry that cannot work (it would fail identically). */
export const NO_RETRY_NOTE =
  'Reintentar no va a cambiar nada: hace falta emparejar el dispositivo de nuevo.';

/** What the entry shows after a failed reconnect. */
export interface ReconnectFailureCopy {
  title: string;
  text: string;
  /** Real step that failed, in plain words (`null` when no step ran). */
  step: string | null;
  /** True only when retrying the same reconnect can really help. */
  retryEnabled: boolean;
  retryLabel: string | null;
  /** Escape hatch: pair again / add another device. */
  escapeLabel: string;
}

/** Minimal evidence the copy builder reads (a `ReconnectOutcome` satisfies it). */
export interface ReconnectFailureInput {
  kind: ReconnectFailureOutcome['kind'];
  step?: ReconnectStep;
  message?: string | null;
  raw?: unknown;
  expected?: string;
  observed?: string | null;
  /** Host for the copy; falls back to the saved record's host. */
  host?: string | null;
  record?: ConnectionRecord | null;
}

function hostOf(input: ReconnectFailureInput): string {
  const direct = typeof input.host === 'string' ? input.host.trim() : '';
  if (direct !== '') {
    return direct;
  }
  const saved = input.record?.host ?? '';
  return saved === '' ? UNKNOWN_HOST_COPY : saved;
}

/**
 * es-AR copy of a failed reconnect. It never blames the person and never
 * promises a retry that cannot work: a lost device key and a changed host key
 * both point at pairing again, while an unreachable PC and a failed step keep a
 * real `Reintentar`.
 */
export function reconnectFailureCopy(input: ReconnectFailureInput): ReconnectFailureCopy {
  const host = hostOf(input);
  const message = typeof input.message === 'string' ? input.message.trim() : '';

  switch (input.kind) {
    case 'no-saved-connection':
      return {
        title: 'Sin conexión guardada',
        text: 'Este teléfono no tiene ninguna conexión guardada. Emparejá un dispositivo para conectarte.',
        step: null,
        retryEnabled: false,
        retryLabel: null,
        escapeLabel: 'Emparejar un dispositivo',
      };
    case 'no-device-key':
      return {
        title: 'Falta la llave del teléfono',
        text:
          message === ''
            ? 'No pudimos leer la llave con la que se emparejó este teléfono. Volvé a emparejarlo.'
            : `${message}. Volvé a emparejar el dispositivo para conectarte a ${host}.`,
        step: STEP_ACTION['device-key'],
        retryEnabled: false,
        retryLabel: null,
        escapeLabel: ESCAPE_LABEL,
      };
    case 'fingerprint-mismatch': {
      const expected = input.expected ?? '';
      const observed = input.observed ?? null;
      return {
        // `observed: null` is its own fact: the host presented nothing, which is not the
        // same as presenting a different key.
        title: observed === null ? 'El host no presentó su huella' : 'La huella del host no coincide',
        text:
          `La huella del host que guardamos es ${expected} y ${host} presentó ${
            observed === null ? 'ninguna huella' : observed
          }.${message === '' ? '' : ` ${message}`} No abrimos la sesión.`,
        step: STEP_ACTION.connect,
        retryEnabled: false,
        retryLabel: null,
        escapeLabel: ESCAPE_LABEL,
      };
    }
    case 'offline':
      return {
        title: `Sin conexión con ${host}`,
        text: message === '' ? 'La PC no respondió.' : `${message} Verificá que la PC esté encendida y que su SSH acepte la llave de este teléfono.`,
        step: STEP_ACTION[input.step ?? 'connect'],
        retryEnabled: true,
        retryLabel: RETRY_LABEL,
        escapeLabel: ESCAPE_LABEL,
      };
    case 'failed': {
      const step = input.step ?? 'connect';
      return {
        title: `Falló ${STEP_TITLE[step]}`,
        text: message === '' ? `No pudimos ${STEP_ACTION[step]}.` : `${message}`,
        step: STEP_ACTION[step],
        retryEnabled: true,
        retryLabel: RETRY_LABEL,
        escapeLabel: ESCAPE_LABEL,
      };
    }
  }
}
