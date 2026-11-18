/**
 * V20 — Global connection states (artboard
 * `design/mobile-app-core/11-global-states.html`, `docs/mobile-views-plan.md` §V20).
 *
 * One model for every screen that needs to tell the human whether the phone is
 * talking to the PC. Everything here is pure or injected: no React Native
 * import, no timers, no polling loop — the screen decides the cadence and calls
 * `checkConnection` once per cadence. `mobile/components/ConnectionBanner.tsx`
 * renders the copy this module builds and `mobile/test/connection.test.mjs`
 * pins the rules against a fake channel that speaks the real HTTP/1.1 wire
 * format.
 *
 * The states come from real evidence, never from a simulation:
 *
 * - no tunnel opened by the pairing flow (`bridgeChannel()` returned null)
 *   → `offline`;
 * - `GET /api/health` answering the protocol §9.2 identity with the proto this
 *   app speaks → `live` (name + version);
 * - an identity from a newer/older bridge proto → `incompatible`, carrying BOTH
 *   protos so the copy can name them;
 * - `401`/`403` → `unauthorized` (the bridge refused this device);
 * - a timeout after a previous good answer → `stale` with the minutes since it
 *   (`última vez hace N min`); with nothing good before → `offline`;
 * - a broken answer (garbage, non-identity JSON, 5xx) → `unknown` with the
 *   failure message and the raw evidence, never `live`.
 *
 * Honesty rules (S7): every failure is logged through the injectable
 * `ConnectionLogger` (`logger.tag('connection')` in the app) with
 * `{step, error, raw}`; the reconnect itself is not built yet, so its retry
 * descriptor says `pending: true` instead of pretending a tap reconnects.
 */

import {
  type BridgeFailureKind,
  type TunnelChannel,
  bridgeHealth,
} from './bridge.ts';
import { logger } from './logger.ts';

/**
 * Bridge proto version this app speaks (`docs/mobile-protocol-spec.md` §9:
 * the loopback extension serves `proto: 1`). Kept here instead of `bridge.ts`
 * because it is a compatibility rule of the UI, not of the HTTP framing.
 */
export const APP_PROTO = 1;

/** Default host name used in copy until the tunnel exposes the real one. */
export const DEFAULT_HOST = 'tu-pc';

/** Default deadline of one `/api/health` probe (protocol §4 identity check). */
export const HEALTH_TIMEOUT_MS = 4_000;

/**
 * The §V20 state set this module derives. `unknown` and `connecting` are the
 * pre-answer states (first render / check in flight); the other five are
 * conclusions from real evidence.
 */
export type ConnectionStatus =
  | 'unknown'
  | 'connecting'
  | 'live'
  | 'stale'
  | 'offline'
  | 'incompatible'
  | 'unauthorized';

/** Every status, in the order the QA gallery lists them. */
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'unknown',
  'connecting',
  'live',
  'stale',
  'offline',
  'incompatible',
  'unauthorized',
];

/** Banner tone: green, amber, red, or the neutral pre-answer grey. */
export type ConnectionTone = 'ok' | 'warning' | 'danger' | 'muted';

/** `/api/health` identity as the app reads it (protocol §9.2). */
export interface HealthIdentity {
  /** Bridge proto version the PC advertises. */
  proto: number;
  /** What is listening: `gentle-shell` (or the legacy `name` field). */
  name: string;
  /** Semver of the extension, when it advertises one. */
  version: string | null;
}

/** One conclusion about the connection, with the evidence that produced it. */
export interface ConnectionModel {
  status: ConnectionStatus;
  /** Identity the bridge answered with, when it answered one. */
  identity: HealthIdentity | null;
  /** Minutes since the last good answer (`stale` only). */
  minutes: number | null;
  /** Both protos when they disagree (`incompatible` only). */
  protos: { app: number; bridge: number } | null;
  /** HTTP status when the conclusion came from one (`unauthorized`, 5xx). */
  httpStatus: number | null;
  /** Typed bridge failure this conclusion came from, or null. */
  failure: BridgeFailureKind | null;
  /** Failure message, shown as-is (es-AR) and logged with the raw evidence. */
  message: string | null;
  /** Raw evidence (response prefix, `write=0`, timeout window, …). */
  raw: string | null;
}

/** Evidence one derivation is allowed to see; nothing else is consulted. */
export interface ConnectionEvidence {
  /** Did the pairing flow leave an open tunnel channel? */
  tunnel: boolean;
  /** Identity parsed from a 2xx `/api/health` answer. */
  identity?: HealthIdentity | null;
  /** HTTP status of the health answer. */
  httpStatus?: number | null;
  /** Typed failure of the health call, when it failed. */
  failure?: {
    kind: BridgeFailureKind;
    message: string;
    raw: string | null;
  } | null;
  /** Epoch ms of the last good answer, or null when there was never one. */
  lastGoodAt?: number | null;
  /** Clock (tests pin it). */
  now?: number;
}

/* ------------------------------------------------------------------ *
 * Evidence helpers
 * ------------------------------------------------------------------ */

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text === '' ? null : text;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  // The spec is JSON-typed, but a bridge that stringifies `proto` still means
  // the same number; anything else is not an identity.
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Parse the §9.2 identity: `{app, bridge, proto, version}`. A body without a
 * numeric `proto` is NOT an identity — another server could answer the port, so
 * the caller reports `unknown` instead of `live`.
 */
export function parseHealthIdentity(body: unknown): HealthIdentity | null {
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const value = body as Record<string, unknown>;
  const proto = integerOrNull(value.proto);
  if (proto === null) {
    return null;
  }
  const name =
    textOrNull(value.name) ?? textOrNull(value.app) ?? textOrNull(value.bridge) ?? 'gentle-shell';
  return { proto, name, version: textOrNull(value.version) };
}

/**
 * Minutes since `lastGoodAt`, clamped to at least 1 (a clock skew never renders
 * a negative age) — the same convention as `LastGood` in
 * `lib/overview-provider.ts`. Null when there was never a good answer.
 */
export function staleMinutes(lastGoodAt: number | null | undefined, now: number): number | null {
  if (lastGoodAt === null || lastGoodAt === undefined || !Number.isFinite(lastGoodAt)) {
    return null;
  }
  return Math.max(1, Math.floor((now - lastGoodAt) / 60_000));
}

/**
 * HTTP status found in a raw response prefix. `lib/bridge.ts` owns the framing,
 * so this only helps for answers it could not parse at all (a proxy status line
 * inside the prefix); the normal 401/403 path reads `result.status`.
 */
export function httpStatusFromRaw(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(raw.trim());
  return match === null ? null : Number(match[1]);
}

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

/** Build a model, filling every evidence field the caller did not set with null. */
function makeConnection(
  partial: Partial<ConnectionModel> & { status: ConnectionStatus },
): ConnectionModel {
  return {
    status: partial.status,
    identity: partial.identity ?? null,
    minutes: partial.minutes ?? null,
    protos: partial.protos ?? null,
    httpStatus: partial.httpStatus ?? null,
    failure: partial.failure ?? null,
    message: partial.message ?? null,
    raw: partial.raw ?? null,
  };
}

/**
 * Turn real evidence into one §V20 status. Order matters and is the honesty
 * contract of this module:
 *
 * 1. no tunnel → `offline` (the PC may be fine; the phone has no tunnel);
 * 2. a typed failure wins over everything it invalidates:
 *    `offline`/refused → `offline`, `timeout` → `stale` if a good answer exists
 *    and `offline` otherwise, a visible 401/403 → `unauthorized`, anything else
 *    broken → `unknown` with the message (never `live`);
 * 3. a real HTTP 401/403 → `unauthorized`;
 * 4. no usable identity → `unknown`;
 * 5. a different proto → `incompatible` with both protos;
 * 6. otherwise → `live`.
 */
export function deriveConnection(evidence: ConnectionEvidence): ConnectionModel {
  const now = evidence.now ?? Date.now();
  const identity = evidence.identity ?? null;
  const failure = evidence.failure ?? null;
  const httpStatus = evidence.httpStatus ?? null;

  const evidenceFields = {
    httpStatus,
    failure: failure?.kind ?? null,
    message: failure?.message ?? null,
    raw: failure?.raw ?? (httpStatus !== null ? `status=${httpStatus}` : null),
  };

  if (!evidence.tunnel) {
    return makeConnection({
      ...evidenceFields,
      status: 'offline',
      httpStatus: null,
      raw: failure?.raw ?? null,
    });
  }

  if (failure !== null) {
    switch (failure.kind) {
      case 'offline':
        return makeConnection({ ...evidenceFields, status: 'offline' });
      case 'timeout': {
        const minutes = staleMinutes(evidence.lastGoodAt, now);
        return minutes === null
          ? makeConnection({ ...evidenceFields, status: 'offline' })
          : makeConnection({ ...evidenceFields, status: 'stale', minutes });
      }
      default: {
        const hidden = httpStatusFromRaw(failure.raw);
        if (hidden === 401 || hidden === 403) {
          return makeConnection({ ...evidenceFields, status: 'unauthorized', httpStatus: hidden });
        }
        return makeConnection({ ...evidenceFields, status: 'unknown' });
      }
    }
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return makeConnection({ ...evidenceFields, status: 'unauthorized' });
  }
  if (identity === null) {
    return makeConnection({ ...evidenceFields, status: 'unknown' });
  }
  if (identity.proto !== APP_PROTO) {
    return makeConnection({
      ...evidenceFields,
      status: 'incompatible',
      identity,
      protos: { app: APP_PROTO, bridge: identity.proto },
    });
  }
  return makeConnection({ ...evidenceFields, status: 'live', identity });
}

/** The first-render model: nothing has been checked yet. */
export function initialConnection(): ConnectionModel {
  return makeConnection({ status: 'unknown' });
}

/** The in-flight model the banner spins on. */
export function checkingConnection(): ConnectionModel {
  return makeConnection({ status: 'connecting' });
}

/* ------------------------------------------------------------------ *
 * Copy (es-AR)
 * ------------------------------------------------------------------ */

/** What the banner and the QA gallery render for one status. */
export interface ConnectionCopy {
  status: ConnectionStatus;
  tone: ConnectionTone;
  /** Short label of the state (`Sin conexión`, `Conectado`, …). */
  title: string;
  /** The sentence the banner shows. */
  text: string;
  /** Retry button label, or null when there is nothing to retry. */
  retryLabel: string | null;
}

/** Options of the copy builder. */
export interface ConnectionCopyOptions {
  /** Host the human recognises; defaults to `tu-pc`. */
  host?: string | null;
}

const TONES: Record<ConnectionStatus, ConnectionTone> = {
  unknown: 'muted',
  connecting: 'warning',
  live: 'ok',
  stale: 'warning',
  offline: 'danger',
  incompatible: 'danger',
  unauthorized: 'danger',
};

const RETRY_LABEL = 'Reintentar';

function hostOf(host: string | null | undefined): string {
  const text = typeof host === 'string' ? host.trim() : '';
  return text === '' ? DEFAULT_HOST : text;
}

/**
 * Build the es-AR copy of one status. Every sentence is derived from the model,
 * so an `incompatible` banner always names both protos and a `stale` one always
 * names the minutes — nothing is hardcoded that the evidence contradicts.
 */
export function connectionCopy(
  state: ConnectionModel,
  options: ConnectionCopyOptions = {},
): ConnectionCopy {
  const host = hostOf(options.host);
  const identity = state.identity;
  const tone = TONES[state.status];

  switch (state.status) {
    case 'unknown': {
      const text =
        state.message !== null
          ? `No pudimos verificar el puente. ${state.message}`
          : `Todavía no verificamos el túnel con ${host}.`;
      return { status: 'unknown', tone, title: 'Estado desconocido', text, retryLabel: RETRY_LABEL };
    }
    case 'connecting':
      return {
        status: 'connecting',
        tone,
        title: 'Reconectando',
        text: `Túnel SSH reconectando a ${host}…`,
        retryLabel: null,
      };
    case 'live': {
      const name = identity?.name ?? 'el puente';
      const version = identity?.version != null ? ` ${identity.version}` : '';
      const proto = identity !== null ? `proto ${identity.proto}` : `proto ${APP_PROTO}`;
      return {
        status: 'live',
        tone,
        title: 'Conectado',
        text: `Conectado a ${host} · ${name}${version} · ${proto}`,
        retryLabel: null,
      };
    }
    case 'stale': {
      const age = state.minutes === null ? 'hace un rato' : `hace ${state.minutes} min`;
      return {
        status: 'stale',
        tone,
        title: 'Sin respuesta',
        text: `Sin respuesta de ${host} · última vez ${age}. Mostrando datos guardados.`,
        retryLabel: RETRY_LABEL,
      };
    }
    case 'offline':
      return {
        status: 'offline',
        tone,
        title: 'Sin conexión',
        text: `Sin conexión con ${host} · verificá que la PC esté encendida y que el túnel SSH siga abierto.`,
        retryLabel: RETRY_LABEL,
      };
    case 'incompatible': {
      const bridgeProto = state.protos?.bridge ?? null;
      const appProto = state.protos?.app ?? APP_PROTO;
      const version = identity?.version != null ? ` (versión ${identity.version})` : '';
      const speaks = bridgeProto === null ? 'otro proto' : `proto ${bridgeProto}`;
      return {
        status: 'incompatible',
        tone,
        title: 'Versiones incompatibles',
        text: `El puente de ${host} habla ${speaks}${version} y esta app espera proto ${appProto}. Actualizá el puente o la app.`,
        retryLabel: RETRY_LABEL,
      };
    }
    case 'unauthorized': {
      const status = state.httpStatus === null ? '' : ` (HTTP ${state.httpStatus})`;
      return {
        status: 'unauthorized',
        tone,
        title: 'Sin autorización',
        text: `El puente de ${host} rechazó este dispositivo${status}. Volvé a emparejar desde la PC.`,
        retryLabel: RETRY_LABEL,
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Retry intent
 * ------------------------------------------------------------------ */

/**
 * What a `Reintentar` tap means for the current status. Reconnecting the SSH
 * tunnel is not built yet, so that descriptor is `pending: true`; a recheck is
 * real (the screen re-runs `checkConnection`), so it is not.
 */
export interface RetryIntent {
  kind: 'reconnect' | 'recheck';
  /** True when the action is not wired yet: the UI must say so. */
  pending: boolean;
  /** Button label the banner shows. */
  label: string;
  /** Honest note under the button when it is pending. */
  note: string;
}

/** Note shown for a reconnect that cannot happen yet. */
export const RECONNECT_PENDING_NOTE =
  'Reconectar el túnel todavía no está conectado: Reintentar vuelve a verificar el puente.';

/** Note of the wired recheck. */
export const RECHECK_NOTE = 'Reintentar vuelve a preguntarle al puente por /api/health.';

/** Build the retry descriptor of a status. */
export function retryIntent(state: ConnectionModel): RetryIntent {
  if (state.status === 'offline') {
    return {
      kind: 'reconnect',
      pending: true,
      label: RETRY_LABEL,
      note: RECONNECT_PENDING_NOTE,
    };
  }
  return { kind: 'recheck', pending: false, label: RETRY_LABEL, note: RECHECK_NOTE };
}

/* ------------------------------------------------------------------ *
 * Real check
 * ------------------------------------------------------------------ */

/** Failure sink this module needs (`logger.tag('connection')` satisfies it). */
export interface ConnectionLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Options of one real connection check. */
export interface CheckConnectionOptions {
  /** Host name for the copy (the tunnel store knows it). */
  host?: string | null;
  /** Deadline of the `/api/health` probe (default `HEALTH_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Epoch ms of the last good answer, for the `stale` minutes. */
  lastGoodAt?: number | null;
  /** Clock (tests pin it). */
  now?: number;
  /** Failure sink; defaults to `logger.tag('connection')`. */
  logger?: ConnectionLogger;
}

/** Everything one check produces: the state, its copy and its retry intent. */
export interface ConnectionCheck {
  model: ConnectionModel;
  copy: ConnectionCopy;
  retry: RetryIntent;
  /** Epoch ms of this check (the caller marks its last-good with it). */
  at: number;
}

/** Default failure sink for the app (one tag, one ring buffer, one log file). */
export const connectionLog: ConnectionLogger = logger.tag('connection');

/**
 * Perform ONE real `GET /api/health` over the current tunnel channel and return
 * the §V20 state. `channel` is the *current* bridge channel (`null` when the
 * pairing flow opened no tunnel): the caller re-asks on every check, so a
 * re-paired tunnel is picked up without a restart.
 *
 * No polling lives here on purpose: one call is one request, and the screen
 * decides when to call again. A successful check does NOT mark the last-good
 * timestamp — the caller does it with `at`, so the timestamp belongs to the
 * screen that also renders the minutes.
 */
export async function checkConnection(
  channel: TunnelChannel | null,
  options: CheckConnectionOptions = {},
): Promise<ConnectionCheck> {
  const now = options.now ?? Date.now();
  const log = options.logger ?? connectionLog;
  const host = options.host ?? null;
  const lastGoodAt = options.lastGoodAt ?? null;

  let state: ConnectionModel;

  if (channel === null) {
    log.failure('tunnel', new Error('Sin túnel abierto hacia la PC.'), null);
    state = deriveConnection({ tunnel: false, lastGoodAt, now });
  } else {
    const result = await bridgeHealth(channel, {
      timeoutMs: options.timeoutMs ?? HEALTH_TIMEOUT_MS,
    });

    if (!result.ok) {
      const failure = result.failure;
      log.failure(
        'health-request',
        failure.error ?? new Error(failure.message),
        failure.raw ?? failure.kind,
      );
      state = deriveConnection({
        tunnel: true,
        failure: { kind: failure.kind, message: failure.message, raw: failure.raw },
        lastGoodAt,
        now,
      });
    } else if (result.status === 401 || result.status === 403) {
      log.failure(
        'health-status',
        new Error(`El puente respondió ${result.status}.`),
        `status=${result.status}`,
      );
      state = deriveConnection({ tunnel: true, httpStatus: result.status, lastGoodAt, now });
    } else if (result.status < 200 || result.status >= 300) {
      log.failure(
        'health-status',
        new Error(`La PC respondió ${result.status}.`),
        `status=${result.status}`,
      );
      state = deriveConnection({
        tunnel: true,
        httpStatus: result.status,
        failure: {
          kind: 'protocol-status',
          message: `La PC respondió ${result.status}.`,
          raw: `status=${result.status}`,
        },
        lastGoodAt,
        now,
      });
    } else {
      const identity = parseHealthIdentity(result.body as unknown);
      if (identity === null) {
        const raw = JSON.stringify(result.body).slice(0, 120);
        log.failure('health-parse', new Error('La PC devolvió una identidad inválida.'), raw);
        state = deriveConnection({
          tunnel: true,
          httpStatus: result.status,
          failure: {
            kind: 'bad-response',
            message: 'La PC devolvió una identidad inválida.',
            raw,
          },
          lastGoodAt,
          now,
        });
      } else {
        state = deriveConnection({
          tunnel: true,
          identity,
          httpStatus: result.status,
          lastGoodAt,
          now,
        });
      }
    }
  }

  return {
    model: state,
    copy: connectionCopy(state, { host }),
    retry: retryIntent(state),
    at: now,
  };
}

/* ------------------------------------------------------------------ *
 * QA gallery examples
 * ------------------------------------------------------------------ */

/** Documented example values of the QA strip (`app/connection-states.tsx`). */
const PREVIEW_IDENTITY: HealthIdentity = { proto: APP_PROTO, name: 'gentle-shell', version: '0.5.9' };

/**
 * A model carrying the documented example values of one status, for the QA
 * gallery ONLY (`app/connection-states.tsx` renders all seven under a
 * `vista previa` label). It is never shown as the current state: the screen's
 * live banner always comes from `checkConnection`.
 */
export function previewConnection(status: ConnectionStatus): ConnectionModel {
  switch (status) {
    case 'unknown':
      return initialConnection();
    case 'connecting':
      return checkingConnection();
    case 'live':
      return makeConnection({
        status: 'live',
        identity: PREVIEW_IDENTITY,
        httpStatus: 200,
      });
    case 'stale':
      return makeConnection({
        status: 'stale',
        identity: PREVIEW_IDENTITY,
        minutes: 7,
        failure: 'timeout',
        message: 'La PC no respondió a tiempo.',
        raw: '4000ms, 0B',
      });
    case 'offline':
      return makeConnection({
        status: 'offline',
        failure: 'offline',
        message: 'Sin túnel hacia la PC.',
      });
    case 'incompatible':
      return makeConnection({
        status: 'incompatible',
        identity: { proto: 2, name: 'gentle-shell', version: '0.6.0' },
        protos: { app: APP_PROTO, bridge: 2 },
        httpStatus: 200,
      });
    case 'unauthorized':
      return makeConnection({
        status: 'unauthorized',
        httpStatus: 401,
        failure: 'protocol-status',
        message: 'El puente respondió 401.',
        raw: 'status=401',
      });
  }
}

/* ------------------------------------------------------------------ *
 * Evidence line
 * ------------------------------------------------------------------ */

/**
 * One line of raw evidence for the screen (`proto=1 · versión=0.5.9 …`), or
 * null when the model carries no evidence at all. Only values that really
 * arrived are printed: a missing version or last-good leaves no trace.
 */
export function evidenceLine(state: ConnectionModel): string | null {
  const parts: string[] = [];
  if (state.identity !== null) {
    parts.push(`proto=${state.identity.proto}`);
    parts.push(`name=${state.identity.name}`);
    if (state.identity.version !== null) {
      parts.push(`versión=${state.identity.version}`);
    }
  }
  if (state.protos !== null) {
    parts.push(`app-proto=${state.protos.app}`);
    parts.push(`puente-proto=${state.protos.bridge}`);
  }
  if (state.httpStatus !== null) {
    parts.push(`http=${state.httpStatus}`);
  }
  if (state.minutes !== null) {
    parts.push(`última vez=${state.minutes} min`);
  }
  if (state.failure !== null) {
    parts.push(`falla=${state.failure}`);
  }
  if (state.raw !== null) {
    parts.push(`raw=${state.raw}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}
