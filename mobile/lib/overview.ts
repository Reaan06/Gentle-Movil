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
 * The data provider is injectable: nothing is wired to the bridge yet, so the
 * built-in provider returns the artboard demo dataset after a short simulated
 * delay and the screen surfaces that honestly in the sync line (`simulado`).
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
  working: { count: number; hints: string[] };
  waiting: { count: number; hint: string | null };
  done: {
    count: number;
    unit: string;
    withChanges: number;
    withoutPush: number;
  };
  tokens: { total: number; sessions: number; today: number; days: TokenDay[] };
  paired: { label: string; host: string };
  syncedSecondsAgo: number;
  devices: number;
}

/** §V5 states table, logic level. */
export type OverviewStateModel =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; data: OverviewData }
  | { kind: 'stale'; minutes: number; data: OverviewData }
  | { kind: 'offline'; data: OverviewData | null };

/** The demo dataset of the artboard (built-in provider until the bridge lands). */
export const DEMO_OVERVIEW: OverviewData = {
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

/** Injectable loader; the shell awaits this instead of touching the bridge. */
export type LoadOverview = () => Promise<OverviewData>;

/** Built-in provider: the artboard demo data after a short simulated delay. */
export function defaultLoadOverview(delayMs = 350): LoadOverview {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return DEMO_OVERVIEW;
  };
}

/** `117700` → `117,7k`; `940` → `940`. */
export function formatTokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  const kilos = Math.round(value / 100) / 10;
  return `${String(kilos).replace('.', ',')}k`;
}

/** Sync status line of the artboard's `syncline`. */
export function syncLine(secondsAgo: number, devices: number): string {
  const when =
    secondsAgo < 60
      ? `hace ${secondsAgo} s`
      : `hace ${Math.floor(secondsAgo / 60)} min`;
  const devicesCopy =
    devices === 1
      ? '1 dispositivo emparejado'
      : `${devices} dispositivos emparejados`;
  return `Sincronizado ${when} · ${devicesCopy}`;
}

/** One bar of the 7-day chart; `height` is 0..1, today is the last day. */
export interface ChartBar {
  label: string;
  value: number;
  height: number;
  today: boolean;
}

/** Heights normalised to the tallest day; today (last) flagged for accent. */
export function chartBars(days: readonly TokenDay[]): ChartBar[] {
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
  pending: boolean;
  disabled: boolean;
}

/** One bento tile. */
export interface OverviewTile {
  id: 'working' | 'waiting' | 'done';
  label: string;
  count: number;
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
  chart: ChartBar[];
  actions: OverviewAction[];
  syncLine: string;
  pairDot: 'green' | 'grey';
}

const EMPTY_DATA: OverviewData = {
  working: { count: 0, hints: [] },
  waiting: { count: 0, hint: null },
  done: { count: 0, unit: 'esta semana', withChanges: 0, withoutPush: 0 },
  tokens: { total: 0, sessions: 0, today: 0, days: DEMO_OVERVIEW.tokens.days },
  paired: { label: 'Live', host: 'tu-pc' },
  syncedSecondsAgo: 0,
  devices: 0,
};

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
      hint: data.waiting.hint,
      wide: false,
      attention: data.waiting.count > 0,
      route: '/waiting-inbox',
    },
    {
      id: 'done',
      label: 'Terminadas',
      count: data.done.count,
      unit: data.done.unit,
      hint: `${data.done.withChanges} con cambios · ${data.done.withoutPush} sin push`,
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
      pending: true,
      disabled,
    },
    {
      id: 'changes',
      label: 'Ver cambios',
      route: '/changes',
      pending: true,
      disabled,
    },
  ];
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
        chart: chartBars(DEMO_OVERVIEW.tokens.days),
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
        chart: chartBars(EMPTY_DATA.tokens.days),
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
        chart: chartBars(state.data.tokens.days),
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
        chart: chartBars(state.data.tokens.days),
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
        chart: chartBars((state.data ?? EMPTY_DATA).tokens.days),
        actions: actionsFor('offline'),
        syncLine: 'Reconectando…',
        pairDot: 'grey',
      };
  }
}
