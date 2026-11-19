/**
 * V5 — Overview dashboard logic (artboard
 * `design/mobile-app-core/01-overview.html`, `docs/mobile-views-plan.md` §V5).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network. `mobile/app/overview.tsx` is the rendering shell and
 * `mobile/test/overview.test.mjs` pins these rules:
 *
 * - the §V5 state machine (`loading | empty | success | stale | offline`),
 *   each mapped to the states table of the views plan;
 * - the bento tile view model (wide-first, hint copies);
 * - the 7-day token chart bars (heights normalised to the tallest day, today
 *   flagged for the accent fill);
 * - es-AR token formatting (comma decimal, `k` suffix);
 * - the sync line copy (seconds/minutes, singular/plural devices);
 * - the quick-action descriptors, which carry `pending: true` while their
 *   routes have no screen yet (honest `route pending` on tap, same
 *   convention as V21's local route).
 *
 * Honesty rule (T7q, pivote S7): a metric the PC does not report is `null`
 * and renders "sin datos" plus its reason. The extension exposes no token
 * usage, no per-session change counters and no device count today, so those
 * are `null` here — never 0 and never a fabricated series. Only counts from
 * `GET /api/sessions`, the host from `GET /api/health` and the real elapsed
 * time of the last good fetch cross this boundary.
 */

/** One day of the 7-day token chart. */
export interface TokenDay {
  /** Short weekday label, lowercase es-AR (`mié`, `mar`). */
  label: string;
  /** Tokens consumed that day. */
  value: number;
}

/** Dataset the Overview renders. */
export interface OverviewData {
  /** Real: sessions the bridge reports as `busy`. */
  working: { count: number; hints: string[] };
  /** The extension publishes no pending questions: `count` is `null`. */
  waiting: { count: number | null; hint: string | null };
  /** The extension publishes no finished sessions: `count` is `null`. */
  done: {
    count: number | null;
    unit: string | null;
    /** Not reported by the extension; `null` renders "sin datos". */
    withChanges: number | null;
    withoutPush: number | null;
  };
  /** No usage source on the extension: every field is `null` today. */
  tokens: {
    total: number | null;
    sessions: number | null;
    today: number | null;
    days: TokenDay[] | null;
  };
  paired: { label: string; host: string };
  /** Real elapsed seconds since the last good fetch, `null` when unknown. */
  syncedSecondsAgo: number | null;
  /** Only when `/api/health` reports a count; otherwise `null`. */
  devices: number | null;
}

/** Why the Esperando tile has no count. */
export const NO_PENDING_REASON = 'la extensión no expone preguntas pendientes';
/** Why the Terminadas tile has no count. */
export const NO_DONE_REASON = 'la extensión no expone sesiones terminadas';
/** Why the token panel has nothing to draw. */
export const NO_TOKENS_REASON = 'la extensión no expone uso de tokens';
/** Why the done tile shows no change counters. */
export const NO_CHANGES_REASON = 'la extensión no expone cambios por sesión';
/** Why the actions still cannot open a new session. */
export const MISSING_NEW_SESSION_REASON =
  'la pantalla /new-session todavía no existe';

/** §V5 states table, logic level. */
export type OverviewStateModel =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; data: OverviewData }
  | { kind: 'stale'; minutes: number; data: OverviewData }
  | { kind: 'offline'; data: OverviewData | null };

/**
 * A PC that reports every metric. This is a *test fixture*, never a runtime
 * fallback: the app's only provider is the tunnel provider in
 * `overview-provider.ts`.
 */
export const MEASURED_OVERVIEW: OverviewData = {
  working: {
    count: 2,
    hints: ['feat/auth-login', 'fix/daemon-retry'],
  },
  waiting: { count: 1, hint: '1 pregunta sin responder' },
  done: { count: 12, unit: 'esta semana', withChanges: 11, withoutPush: 1 },
  tokens: {
    total: 117700,
    sessions: 4,
    today: 31200,
    days: [
      { label: 'mié', value: 9400 },
      { label: 'jue', value: 14200 },
      { label: 'vie', value: 21800 },
      { label: 'sáb', value: 8100 },
      { label: 'dom', value: 6300 },
      { label: 'lun', value: 26700 },
      { label: 'mar', value: 31200 },
    ],
  },
  paired: { label: 'Live', host: 'tu-pc' },
  syncedSecondsAgo: 12,
  devices: 1,
};

/**
 * A PC that answers with sessions only — the shape the extension returns
 * today: counts and host are real, everything else is honestly absent.
 */
export const NOTHING_MEASURED: OverviewData = {
  working: { count: 0, hints: [] },
  waiting: { count: null, hint: null },
  done: { count: null, unit: null, withChanges: null, withoutPush: null },
  tokens: { total: null, sessions: null, today: null, days: null },
  paired: { label: 'Live', host: 'tu-pc' },
  syncedSecondsAgo: null,
  devices: null,
};

/** Injectable loader; the shell awaits this instead of touching the bridge. */
export type LoadOverview = () => Promise<OverviewData>;

/** `117700` → `117,7k`; `940` → `940`. */
export function formatTokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  const kilos = Math.round(value / 100) / 10;
  return `${String(kilos).replace('.', ',')}k`;
}

/**
 * Sync status line of the artboard's `syncline`. Every part is optional: an
 * unknown age or device count says "sin datos" instead of turning into 0.
 */
export function syncLine(secondsAgo: number | null, devices: number | null): string {
  const when =
    secondsAgo === null
      ? 'Sincronizado'
      : secondsAgo < 60
        ? `Sincronizado hace ${secondsAgo} s`
        : `Sincronizado hace ${Math.floor(secondsAgo / 60)} min`;
  const devicesCopy =
    devices === null
      ? 'dispositivos sin datos'
      : devices === 1
        ? '1 dispositivo emparejado'
        : `${devices} dispositivos emparejados`;
  return `${when} · ${devicesCopy}`;
}

/** One bar of the 7-day chart; `height` is 0..1, today is the last day. */
export interface ChartBar {
  label: string;
  value: number;
  height: number;
  today: boolean;
}

/** Heights normalised to the tallest day; today (last) flagged for accent. */
export function chartBars(days: readonly TokenDay[] | null): ChartBar[] {
  if (days === null || days.length === 0) {
    return [];
  }
  const max = Math.max(...days.map((d) => d.value), 1);
  return days.map((day, index) => ({
    label: day.label,
    value: day.value,
    height: day.value / max,
    today: index === days.length - 1,
  }));
}

/** Quick-action descriptor (`pending` routes have no screen yet). */
export interface OverviewAction {
  id: 'new-session' | 'changes';
  label: string;
  route: string;
  /** True while the target screen does not exist; `pendingReason` says why. */
  pending: boolean;
  pendingReason: string | null;
  disabled: boolean;
}

/** The token panel: either the measured series or the honest reason. */
export type TokensPanel =
  | {
      available: true;
      total: string;
      sessions: string;
      today: string;
      chart: ChartBar[];
    }
  | { available: false; reason: string; chart: [] };

/** One bento tile. */
export interface OverviewTile {
  id: 'working' | 'waiting' | 'done';
  label: string;
  /** `null` when the bridge does not report this metric: renders '—'. */
  count: number | null;
  unit: string | null;
  hint: string | null;
  wide: boolean;
  attention: boolean;
  route: string;
}

/** What `overview.tsx` renders, per §V5 states + reactions. */
export interface OverviewViewModel {
  state: 'loading' | 'empty' | 'success' | 'stale' | 'offline';
  data: OverviewData | null;
  tiles: OverviewTile[];
  emptyCard: string | null;
  staleChip: string | null;
  /** Minutes of the last good data (`stale` only), for the connection chip. */
  staleMinutes: number | null;
  tokens: TokensPanel;
  actions: OverviewAction[];
  syncLine: string;
  pairDot: 'green' | 'grey';
}

const EMPTY_DATA: OverviewData = NOTHING_MEASURED;

/**
 * Done-tile hint. The extension reports no per-session change counters, so a
 * missing metric is spelled out instead of printing a zero that looks measured.
 */
function doneHint(done: OverviewData['done']): string | null {
  const parts: string[] = [];
  if (done.withChanges !== null) parts.push(`${done.withChanges} con cambios`);
  if (done.withoutPush !== null) parts.push(`${done.withoutPush} sin push`);
  if (parts.length > 0) return parts.join(' · ');
  return done.count === 0 || done.count === null
    ? null
    : `sin datos de cambios (${NO_CHANGES_REASON})`;
}

function tilesFor(data: OverviewData): OverviewTile[] {
  return [
    {
      id: 'working',
      label: 'Trabajando',
      count: data.working.count,
      unit: data.working.count === 1 ? 'sesión en curso' : 'sesiones en curso',
      hint: data.working.hints.length > 0 ? data.working.hints.join(' · ') : null,
      wide: true,
      attention: false,
      route: '/sessions-list',
    },
    {
      id: 'waiting',
      label: 'Esperando',
      count: data.waiting.count,
      unit: null,
      hint: data.waiting.hint ?? NO_PENDING_REASON,
      wide: false,
      attention: data.waiting.count !== null && data.waiting.count > 0,
      route: '/waiting-inbox',
    },
    {
      id: 'done',
      label: 'Terminadas',
      count: data.done.count,
      unit: data.done.unit,
      hint: data.done.count === null ? NO_DONE_REASON : doneHint(data.done),
      wide: false,
      attention: false,
      route: '/sessions-list',
    },
  ];
}

function actionsFor(state: 'success' | 'stale' | 'offline'): OverviewAction[] {
  const disabled = state === 'offline';
  return [
    {
      id: 'new-session',
      label: '+ Nueva sesión',
      route: '/new-session',
      // No screen yet (V8 is still open) — the screen logs this exact reason.
      pending: true,
      pendingReason: MISSING_NEW_SESSION_REASON,
      disabled,
    },
    {
      id: 'changes',
      label: 'Ver cambios',
      // /git-changes exists and reads the real bridge.
      route: '/git-changes',
      pending: false,
      pendingReason: null,
      disabled,
    },
  ];
}

/** Token panel from the data: measured series, or the reason it is missing. */
function tokensPanel(
  data: OverviewData | null,
  missingReason: string,
): TokensPanel {
  const tokens = data?.tokens;
  if (
    tokens === undefined ||
    tokens === null ||
    tokens.total === null ||
    tokens.sessions === null ||
    tokens.today === null ||
    tokens.days === null ||
    tokens.days.length === 0
  ) {
    return { available: false, reason: missingReason, chart: [] };
  }
  return {
    available: true,
    total: formatTokens(tokens.total),
    sessions:
      tokens.sessions === 1 ? '1 sesión' : `${tokens.sessions} sesiones`,
    today: formatTokens(tokens.today),
    chart: chartBars(tokens.days),
  };
}

/** Build the render model from a §V5 state. */
export function buildOverview(state: OverviewStateModel): OverviewViewModel {
  switch (state.kind) {
    case 'loading':
      return {
        state: 'loading',
        data: null,
        tiles: tilesFor(EMPTY_DATA),
        emptyCard: null,
        staleChip: null,
        staleMinutes: null,
        tokens: { available: false, reason: 'cargando datos de la PC…', chart: [] },
        actions: actionsFor('success'),
        syncLine: 'Sincronizando…',
        pairDot: 'grey',
      };
    case 'empty':
      return {
        state: 'empty',
        data: EMPTY_DATA,
        tiles: tilesFor(EMPTY_DATA),
        emptyCard: 'Aún no hay sesiones. Crea la primera.',
        staleChip: null,
        staleMinutes: null,
        tokens: {
          available: false,
          reason: 'todavía no hay sesiones que medir',
          chart: [],
        },
        actions: actionsFor('success'),
        syncLine: 'Sin datos todavía',
        pairDot: 'green',
      };
    case 'success':
      return {
        state: 'success',
        data: state.data,
        tiles: tilesFor(state.data),
        emptyCard: null,
        staleChip: null,
        staleMinutes: null,
        tokens: tokensPanel(state.data, NO_TOKENS_REASON),
        actions: actionsFor('success'),
        syncLine: syncLine(state.data.syncedSecondsAgo, state.data.devices),
        pairDot: 'green',
      };
    case 'stale':
      return {
        state: 'stale',
        data: state.data,
        tiles: tilesFor(state.data),
        emptyCard: null,
        staleChip: `Datos de hace ${state.minutes} min`,
        staleMinutes: state.minutes,
        tokens: tokensPanel(state.data, NO_TOKENS_REASON),
        actions: actionsFor('stale'),
        syncLine: syncLine(state.data.syncedSecondsAgo, state.data.devices),
        pairDot: 'green',
      };
    case 'offline':
      return {
        state: 'offline',
        data: state.data,
        tiles: tilesFor(state.data ?? EMPTY_DATA),
        emptyCard: null,
        staleChip: null,
        staleMinutes: null,
        tokens: state.data === null
          ? { available: false, reason: 'sin conexión con la PC', chart: [] }
          : tokensPanel(state.data, NO_TOKENS_REASON),
        actions: actionsFor('offline'),
        syncLine: 'Reconectando…',
        pairDot: 'grey',
      };
  }
}

/* ------------------------------------------------------------------ *
 * Connection chip (T17, S11)
 * ------------------------------------------------------------------ */

/** The Overview chip copy: the state of the tunnel, in the person's words. */
export interface ConnectionChip {
  /** `Live · 192.168.0.10` / `Sin conexión · 192.168.0.10` / … */
  text: string;
  dot: 'green' | 'grey';
  accessibilityLabel: string;
  accessibilityHint: string;
}

/** What the person can do from the chip (the S11 connection menu). */
export const CONNECTION_CHIP_HINT = 'Reconectar, cambiar de conexión o agregar otro dispositivo';

/** Host copy when nothing reported one. */
export const UNKNOWN_HOST_COPY = 'sin datos';

/**
 * Builds the Overview connection chip — the entry to the connection menu
 * (S11). The state is the §V5 state, so the chip never claims `Live` while the
 * screen is offline, and the host is the one `/api/health` reported: when there
 * is none it says `sin datos` instead of inventing a name.
 */
export function connectionChip(vm: OverviewViewModel, host?: string | null): ConnectionChip {
  const reported = host === undefined ? vm.data?.paired.host ?? '' : host ?? '';
  const target = reported.trim() === '' ? UNKNOWN_HOST_COPY : reported.trim();

  const text =
    vm.state === 'loading'
      ? `Reconectando… · ${target}`
      : vm.state === 'offline'
        ? `Sin conexión · ${target}`
        : vm.state === 'stale' && vm.staleMinutes !== null
          ? `Live · ${target} · hace ${vm.staleMinutes} min`
          : `Live · ${target}`;

  const dot: ConnectionChip['dot'] = vm.state === 'success' || vm.state === 'empty' || vm.state === 'stale'
    ? 'green'
    : 'grey';

  return {
    text,
    dot,
    accessibilityLabel: `${text} · abrir el menú de conexión`,
    accessibilityHint: CONNECTION_CHIP_HINT,
  };
}
