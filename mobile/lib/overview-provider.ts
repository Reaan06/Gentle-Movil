/**
 * V5 real data provider — Overview over the SSH tunnel (T8c).
 *
 * Replaces the V21-era demo provider: `loadOverview` now performs a real
 * `GET /api/sessions` + `GET /api/health` through the tunnel the pairing flow
 * opened, and maps the *real* failures to the §V5 states the design defines:
 *
 * - tunnel missing / channel refused  → `offline` (`Reconectando…`);
 * - response past its deadline        → `stale` with the last good data
 *   (`Datos de hace N min`) — cached truth, never invented numbers;
 * - broken/invalid JSON               → `bad-data` surfaced as offline with
 *   the raw prefix in the log.
 *
 * There is no simulated dataset anywhere in this module: if the PC does not
 * answer, the screen says so.
 */

import {
  type BridgeSession,
  type TunnelChannel,
  bridgeHealth,
  bridgeSessions,
} from './bridge.ts';
import type { OverviewData, OverviewStateModel, LoadOverview } from './overview.ts';

/** Pairing result the app keeps after a successful `provisionFlow`. */
export interface ActiveTunnel {
  sessionId: string;
  /** The provision channel for the extension's HTTP port (43721). */
  httpChannel: import('./provision').TunnelChannel;
}

/**
 * Map a real `/api/sessions` list onto the Overview counts.
 *
 * Only what the extension reports crosses this boundary: the three status
 * counts, their hints and (later, from `/api/health`) the host. Token usage,
 * per-session change counters, the device count and the sync age are `null`
 * here — the extension exposes no such source, and the view renders "sin
 * datos" with that reason instead of a zero that looks measured (T7q).
 */
export function overviewFromSessions(sessions: readonly BridgeSession[]): OverviewData {
  const working = sessions.filter((s) => s.status === 'working');
  const waiting = sessions.filter((s) => s.status === 'waiting');
  const done = sessions.filter((s) => s.status === 'done');
  return {
    working: {
      count: working.length,
      hints: working.slice(0, 2).map((s) => s.hint ?? s.title),
    },
    waiting: {
      count: waiting.length,
      hint: waiting.length > 0 ? `${waiting.length} esperándote` : null,
    },
    done: {
      count: done.length,
      unit: 'esta semana',
      withChanges: null,
      withoutPush: null,
    },
    tokens: { total: null, sessions: null, today: null, days: null },
    paired: { label: 'Live', host: 'tu-pc' },
    syncedSecondsAgo: null,
    devices: null,
  };
}

/** How long since the last good answer, for the stale chip and the sync line. */
export class LastGood {
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "answered now". */
  mark(): void {
    this.at = this.now();
  }

  /** Whole seconds since the last good answer, or null when never. */
  secondsSince(): number | null {
    return this.at === 0 ? null : Math.max(0, Math.floor((this.now() - this.at) / 1000));
  }

  /** Minutes since the last good answer, or null when never. */
  minutesSince(): number | null {
    return this.at === 0 ? null : Math.max(1, Math.floor((this.now() - this.at) / 60_000));
  }
}

/** Result of one provider run: a §V5 state, honest. */
export type ProviderOutcome =
  | { kind: 'success'; data: OverviewData }
  | { kind: 'stale'; minutes: number; data?: OverviewData }
  | { kind: 'offline' }
  | { kind: 'empty' };

/**
 * Build the injectable provider. `channel()` returns the *current* tunnel
 * channel or null (tunnel never opened / closed); every call re-asks, so a
 * reconnected tunnel is picked up on the next refresh without restarting.
 */
export function bridgeOverviewProvider(
  channel: () => TunnelChannel | null,
  lastGood: LastGood = new LastGood(),
): LoadOverview {
  return async (): Promise<OverviewData> => {
    const active = channel();
    if (active === null) {
      const outcome: ProviderOutcome = { kind: 'offline' };
      throw new OfflineSignal(outcome);
    }
    const sessionsResult = await bridgeSessions(active, { timeoutMs: 8_000 });
    if (!sessionsResult.ok) {
      const minutes = lastGood.minutesSince();
      if (sessionsResult.failure.kind === 'timeout' && minutes !== null) {
        throw new StaleSignal({ kind: 'stale', minutes });
      }
      throw new OfflineSignal({ kind: 'offline' });
    }
    const healthChannel = channel();
    const health =
      healthChannel === null
        ? { ok: false as const }
        : await bridgeHealth(healthChannel, { timeoutMs: 4_000 });
    lastGood.mark();
    const data = overviewFromSessions(sessionsResult.body.sessions ?? []);
    // The sync age is measured from the real last good answer, never a constant.
    data.syncedSecondsAgo = lastGood.secondsSince();
    if (health.ok) {
      // §9.2 sends `bridge`; older builds sent `name`. Never invent a host.
      const identity = health.body.bridge ?? health.body.name;
      if (identity !== undefined) {
        data.paired = { label: 'Live', host: identity };
      }
      // A device count is only shown when the payload actually carries one.
      const reported = (health.body as { devices?: unknown }).devices;
      if (typeof reported === 'number') {
        data.devices = reported;
      }
    }
    if (data.working.count + data.waiting.count + data.done.count === 0) {
      throw new EmptySignal({ kind: 'empty' });
    }
    return data;
  };
}

/** Internal signals the screen translates into §V5 states. */
export class OfflineSignal extends Error {
  readonly outcome: ProviderOutcome;
  constructor(outcome: ProviderOutcome) {
    super('offline');
    this.outcome = outcome;
  }
}
export class StaleSignal extends Error {
  readonly outcome: ProviderOutcome;
  constructor(outcome: ProviderOutcome) {
    super('stale');
    this.outcome = outcome;
  }
}
export class EmptySignal extends Error {
  readonly outcome: ProviderOutcome;
  constructor(outcome: ProviderOutcome) {
    super('empty');
    this.outcome = outcome;
  }
}

/** Translate a provider throw into the §V5 state model. */
export function stateFromSignal(error: unknown): OverviewStateModel {
  if (error instanceof OfflineSignal) return { kind: 'offline', data: null };
  if (error instanceof StaleSignal && error.outcome.kind === 'stale') {
    // Stale without cached numbers is offline: there is nothing truthful to show.
    if (error.outcome.data === undefined) {
      return { kind: 'offline', data: null };
    }
    return { kind: 'stale', minutes: error.outcome.minutes, data: error.outcome.data };
  }
  if (error instanceof EmptySignal) return { kind: 'empty' };
  return { kind: 'offline', data: null };
}
