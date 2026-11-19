/**
 * V6 — Sessions list logic (artboard
 * `design/mobile-app-core/02-sessions-list.html`, `docs/mobile-views-plan.md` §V6).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network of its own. `mobile/app/sessions-list.tsx` is the rendering shell and
 * `mobile/test/sessions.test.mjs` pins these rules:
 *
 * - the four filters (`Todas` / `Trabajando` / `Listas` / `Sin estado`) with
 *   the counts that stay stable while filtering (a local filter never
 *   refetches). These are the three states §9.3 really publishes (`busy`,
 *   `idle`, `unknown`); the artboard's `Esperando` / `Terminadas` have no
 *   source in the extension and were replaced by the owner's decision of
 *   2026-11-18 — showing them would mean inventing a status;
 * - the row view model built from a real `BridgeSession` (status pill, hint,
 *   relative `hace N min` copy);
 * - most recently updated first (`updatedAt`, ISO);
 * - one honest state per outcome, mirroring `lib/overview-provider.ts`:
 *   `loading | empty | success | stale | offline | error`.
 *
 * Honesty rules (S7), the same the Overview provider follows:
 * - no tunnel → `offline` (`Reconectando…`), never an empty success;
 * - a timeout with a previous good answer → `stale` with the cached rows and
 *   the minutes since that answer (`Datos de hace N min`);
 * - broken/invalid JSON or a rejected request → `error` carrying the failure
 *   message and the raw evidence for the card;
 * - an empty `/api/sessions` is the `empty` state, never a success showing
 *   zeros.
 *
 * Every failure is logged through the injectable `failure(step, error, raw)`
 * seam (`logger.tag('sessions-list')` in the app) with `{step, error, raw}`.
 */

import {
  type BridgeFailure,
  type BridgeSession,
  type TunnelChannel,
  bridgeSessions,
} from './bridge.ts';
import { logger } from './logger.ts';

/* ------------------------------------------------------------------ *
 * Filters (§V6 segmented control)
 * ------------------------------------------------------------------ */

/** Filter chips: the three real bridge states plus `all`. */
export type SessionFilter = 'all' | 'busy' | 'idle' | 'unknown';

/** Chip order (`Todas` first). */
export const SESSION_FILTERS: readonly SessionFilter[] = ['all', 'busy', 'idle', 'unknown'];

/** Chip copy: the state the PC actually reports. */
export const FILTER_LABELS: Record<SessionFilter, string> = {
  all: 'Todas',
  busy: 'Trabajando',
  idle: 'Listas',
  unknown: 'Sin estado',
};

/** Sessions the list shows (the bridge publishes every session it knows). */
export function visibleSessions(sessions: readonly BridgeSession[]): BridgeSession[] {
  return [...sessions];
}

/** Counts per filter. `all` is the sum of the three statuses, by construction. */
export function filterCounts(
  sessions: readonly BridgeSession[],
): Record<SessionFilter, number> {
  const visible = visibleSessions(sessions);
  return {
    all: visible.length,
    busy: visible.filter((session) => session.status === 'busy').length,
    idle: visible.filter((session) => session.status === 'idle').length,
    unknown: visible.filter((session) => session.status === 'unknown').length,
  };
}

/** One chip of the segmented control (counts stay visible on every chip). */
export interface FilterChip {
  id: SessionFilter;
  /** Copy: `Todas` / `Trabajando` / `Listas` / `Sin estado`. */
  label: string;
  count: number;
  active: boolean;
}

/** Build the four chips, marking `active` as pressed (a local filter only). */
export function filterChips(
  sessions: readonly BridgeSession[],
  active: SessionFilter,
): FilterChip[] {
  const counts = filterCounts(sessions);
  return SESSION_FILTERS.map((id) => ({
    id,
    label: FILTER_LABELS[id],
    count: counts[id],
    active: id === active,
  }));
}

/** Local filter over the already-fetched list; never triggers a fetch. */
export function filterSessions(
  sessions: readonly BridgeSession[],
  filter: SessionFilter,
): BridgeSession[] {
  const visible = visibleSessions(sessions);
  return filter === 'all' ? visible : visible.filter((session) => session.status === filter);
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** Sort: most recently updated first; an unusable timestamp sorts last. */
export function sortSessions(sessions: readonly BridgeSession[]): BridgeSession[] {
  return sessions
    .map((session, index) => ({ session, index, at: Date.parse(session.updatedAt) }))
    .sort((a, b) => {
      const aValid = !Number.isNaN(a.at);
      const bValid = !Number.isNaN(b.at);
      if (aValid && bValid && a.at !== b.at) {
        return b.at - a.at;
      }
      if (aValid !== bValid) {
        return aValid ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.session);
}

/**
 * Relative copy of the artboard: `hace 2 min`, `hace 1 hora`, `hace 3 días`.
 * A clock that disagrees with the PC (future timestamp) never renders a
 * negative age: it reads as "less than a minute".
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return 'sin fecha';
  }
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) {
    return 'hace menos de 1 min';
  }
  if (minutes < 60) {
    return `hace ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? 'hace 1 hora' : `hace ${hours} horas`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

/** Visual tone of the status pill. */
export type SessionTone = 'working' | 'ok' | 'muted';

/** One row of the §V6 list. */
export interface SessionRowViewModel {
  id: string;
  /** Workspace / branch name, the row's headline. */
  title: string;
  status: BridgeSession['status'];
  /** Status pill copy + tone (`Trabajando` / `Lista` / `Sin estado`). */
  pill: { label: string; tone: SessionTone };
  /** Branch or project hint; falls back to the title when the PC sent none. */
  hint: string;
  /** `hace 2 min`. */
  relative: string;
  /** ISO timestamp, kept for the frozen cache chip. */
  updatedAt: string;
  /** Where the row goes once V7 has a screen. */
  route: string;
  /** Nothing to flag yet: the bridge publishes no pending question. */
  attention: boolean;
  /** Rows read from the cache (offline/stale): the dots are frozen. */
  frozen: boolean;
}

const PILLS: Record<BridgeSession['status'], { label: string; tone: SessionTone }> = {
  busy: { label: 'Trabajando', tone: 'working' },
  idle: { label: 'Lista', tone: 'ok' },
  unknown: { label: 'Sin estado', tone: 'muted' },
};

/**
 * Pill for a status the protocol defines. Anything else is `Sin estado` on a
 * muted pill: the PC did not publish that state, so the UI does not invent one.
 */
export function pillFor(status: string): { label: string; tone: SessionTone } {
  const known = PILLS[status as BridgeSession['status']];
  return known ?? PILLS.unknown;
}

/** One `BridgeSession` → one row; `frozen` marks cached rows. */
export function sessionRow(
  session: BridgeSession,
  options: { now?: number; frozen?: boolean } = {},
): SessionRowViewModel {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    pill: pillFor(session.status),
    hint: session.hint !== null && session.hint !== undefined && session.hint !== ''
      ? session.hint
      : session.title,
    relative: relativeTime(session.updatedAt, options.now),
    updatedAt: session.updatedAt,
    route: `/session/${session.id}`,
    attention: false,
    frozen: options.frozen ?? false,
  };
}

/** Meta line: `2 trabajando · 1 lista · 3 sin estado`. */
export function summaryLine(counts: Record<SessionFilter, number>): string {
  const listas = counts.idle === 1 ? 'lista' : 'listas';
  return `${counts.busy} trabajando · ${counts.idle} ${listas} · ${counts.unknown} sin estado`;
}

/* ------------------------------------------------------------------ *
 * Honest states
 * ------------------------------------------------------------------ */

/** The §V6 states table, logic level. */
export type SessionsState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; sessions: BridgeSession[] }
  | { kind: 'stale'; minutes: number; sessions: BridgeSession[] }
  | { kind: 'offline'; sessions: BridgeSession[] | null; minutes: number | null }
  | { kind: 'error'; message: string; raw: string | null };

/**
 * Last good `/api/sessions` answer, so a later timeout can show cached rows
 * with the honest age instead of inventing a list or pretending to be empty.
 */
export class SessionsCache {
  private sessions: BridgeSession[] = [];
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "the PC answered this list, now". */
  mark(sessions: readonly BridgeSession[]): void {
    this.sessions = [...sessions];
    this.at = this.now();
  }

  /** Cached rows + minutes since they arrived, or null when never answered. */
  snapshot(): { sessions: BridgeSession[]; minutes: number } | null {
    if (this.at === 0) {
      return null;
    }
    const minutes = Math.max(1, Math.floor((this.now() - this.at) / 60_000));
    return { sessions: this.sessions, minutes };
  }

  /** Drops the cache: an empty answer is truth, not something to fall back to. */
  clear(): void {
    this.sessions = [];
    this.at = 0;
  }
}

/** Failure sink this module needs (`logger.tag('sessions-list')` satisfies it). */
export interface SessionsLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Injectable dependencies (cache, logger, deadline). */
export interface LoadSessionsDeps {
  /** Cache of the last good answer (stale/offline rows). */
  cache?: SessionsCache;
  /** Failure sink; defaults to `logger.tag('sessions-list')`. */
  logger?: SessionsLogger;
  /** Deadline of the `/api/sessions` call (default `SESSIONS_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** Default deadline of one list fetch, matching the Overview provider. */
export const SESSIONS_TIMEOUT_MS = 8_000;

/** Raw evidence of a failure, always something the log can keep. */
function rawOf(failure: BridgeFailure): string {
  return failure.raw ?? failure.kind;
}

/**
 * One failed bridge call → the §V6 state it deserves. Mirrors
 * `stateFromSignal` of `lib/overview-provider.ts`:
 *
 * - `offline` → offline, with the cached rows when there are any;
 * - `timeout` → stale when something was cached, offline when nothing was;
 * - `bad-response` / `protocol-status` → error carrying message + raw.
 */
export function stateFromFailure(
  failure: BridgeFailure,
  cache: SessionsCache | null = null,
): SessionsState {
  const cached = cache?.snapshot() ?? null;
  switch (failure.kind) {
    case 'offline':
      return {
        kind: 'offline',
        sessions: cached?.sessions ?? null,
        minutes: cached?.minutes ?? null,
      };
    case 'timeout':
      return cached === null
        ? { kind: 'offline', sessions: null, minutes: null }
        : { kind: 'stale', minutes: cached.minutes, sessions: cached.sessions };
    default:
      return { kind: 'error', message: failure.message, raw: failure.raw };
  }
}

/** Default failure sink for the app (one tag, one ring buffer, one log file). */
export const sessionsLog: SessionsLogger = logger.tag('sessions-list');

/**
 * Fetch `GET /api/sessions` over the tunnel channel and return the §V6 state.
 * A null channel means the app has no tunnel (tunnel never opened or closed),
 * which is `offline` — the screen says so instead of showing an empty list.
 */
export async function loadSessions(
  channel: TunnelChannel | null,
  deps: LoadSessionsDeps = {},
): Promise<SessionsState> {
  const log = deps.logger ?? sessionsLog;
  const cache = deps.cache ?? null;

  if (channel === null) {
    log.failure('tunnel', new Error('Sin túnel abierto hacia la PC.'), null);
    return stateFromFailure(
      {
        kind: 'offline',
        message: 'Sin túnel hacia la PC.',
        raw: null,
        error: null,
      },
      cache,
    );
  }

  const result = await bridgeSessions(channel, {
    timeoutMs: deps.timeoutMs ?? SESSIONS_TIMEOUT_MS,
  });
  if (!result.ok) {
    log.failure(
      'sessions-request',
      result.failure.error ?? new Error(result.failure.message),
      rawOf(result.failure),
    );
    return stateFromFailure(result.failure, cache);
  }

  if (result.status < 200 || result.status >= 300) {
    const raw = JSON.stringify(result.body).slice(0, 120);
    log.failure('sessions-request', new Error(`La PC respondió ${result.status}.`), raw);
    return { kind: 'error', message: `La PC respondió ${result.status}.`, raw };
  }

  // `bridgeSessions` already normalized the payload; a bad body arrived as a
  // typed failure above, so this list is the real one.
  const sessions = result.body.sessions;
  if (sessions.length === 0) {
    // A real empty PC: no rows, no zeros pretending to be data, no cache to
    // fall back to on the next timeout.
    cache?.clear();
    return { kind: 'empty' };
  }

  cache?.mark(sessions);
  return { kind: 'success', sessions: sortSessions(sessions) };
}

/* ------------------------------------------------------------------ *
 * Render model
 * ------------------------------------------------------------------ */

/** What `sessions-list.tsx` renders, per §V6 states + reactions. */
export interface SessionsViewModel {
  state: 'loading' | 'empty' | 'success' | 'stale' | 'offline' | 'error';
  /** Filter chips; empty while loading (no zeros pretending to be counts). */
  chips: FilterChip[];
  /** Rows of the active filter, newest first. */
  rows: SessionRowViewModel[];
  counts: Record<SessionFilter, number>;
  /** `2 trabajando · 1 lista · 3 sin estado`, when there is data. */
  summary: string | null;
  /** Amber chip over cached rows (`Datos de hace N min` / `Última vez hace N min`). */
  staleChip: string | null;
  /** Offline banner copy (`Reconectando…`). */
  banner: string | null;
  /** Error card copy + raw evidence (`bad-response` / `protocol-status`). */
  error: { message: string; raw: string | null } | null;
  /** Why the list is empty: overall, or just for this filter. */
  emptyMessage: string | null;
  /** The overall empty state offers `Nueva sesión`. */
  creatable: boolean;
  /** Skeleton rows are showing (pull-to-refresh keeps the rows). */
  loading: boolean;
}

const NO_COUNTS: Record<SessionFilter, number> = { all: 0, busy: 0, idle: 0, unknown: 0 };

/** Copy of the per-filter empty state. */
const FILTER_EMPTY: Record<SessionFilter, string> = {
  all: 'Aún no hay sesiones.',
  busy: 'No hay sesiones trabajando.',
  idle: 'No hay sesiones listas.',
  unknown: 'No hay sesiones sin estado.',
};

/** Build the render model from a §V6 state + the active filter. */
export function buildSessionsView(
  state: SessionsState,
  filter: SessionFilter = 'all',
  now: number = Date.now(),
): SessionsViewModel {
  const base = {
    counts: NO_COUNTS,
    summary: null,
    staleChip: null,
    banner: null,
    error: null,
    emptyMessage: null,
    creatable: false,
    loading: false,
  } as const;

  switch (state.kind) {
    case 'loading':
      return { ...base, state: 'loading', chips: [], rows: [], loading: true };
    case 'empty':
      return {
        ...base,
        state: 'empty',
        chips: filterChips([], filter),
        rows: [],
        emptyMessage: FILTER_EMPTY.all,
        creatable: true,
      };
    case 'error':
      return {
        ...base,
        state: 'error',
        chips: [],
        rows: [],
        error: { message: state.message, raw: state.raw },
      };
    case 'success':
    case 'stale':
    case 'offline': {
      const sessions = state.sessions;
      if (sessions === null) {
        // Offline with nothing cached: an empty chip row would be invented
        // counts, so the screen only shows the reconnect banner.
        return {
          ...base,
          state: 'offline',
          chips: [],
          rows: [],
          banner: 'Reconectando…',
        };
      }
      const frozen = state.kind !== 'success';
      const counts = filterCounts(sessions);
      const rows = sortSessions(filterSessions(sessions, filter)).map((session) =>
        sessionRow(session, { now, frozen }),
      );
      return {
        ...base,
        state: state.kind,
        chips: filterChips(sessions, filter),
        rows,
        counts,
        summary: sessions.length > 0 ? summaryLine(counts) : null,
        staleChip:
          state.kind === 'stale'
            ? `Datos de hace ${state.minutes} min`
            : state.kind === 'offline' && state.minutes !== null
              ? `Última vez hace ${state.minutes} min`
              : null,
        banner: state.kind === 'offline' ? 'Reconectando…' : null,
        emptyMessage:
          rows.length === 0
            ? FILTER_EMPTY[filter]
            : null,
        creatable: false,
      };
    }
  }
}
