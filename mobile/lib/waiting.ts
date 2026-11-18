/**
 * V9 real data model — the Waiting inbox over the SSH tunnel (T7e).
 *
 * Artboard: `design/mobile-app-core/04-waiting-inbox.html`;
 * `docs/mobile-views-plan.md` §V9. Everything here is pure or injected: no
 * React Native import, no device, no network — `mobile/app/waiting-inbox.tsx`
 * is the rendering shell and `mobile/test/waiting.test.mjs` pins these rules
 * against a fake channel that speaks the real HTTP/1.1 wire format.
 *
 * What the inbox is: the sessions whose status is `waiting` — the agent stopped
 * because it will not decide for the human. There is no simulated dataset: the
 * cards come from `GET /api/sessions` through the tunnel the pairing flow
 * opened, and every failure maps to a §V9 state instead of a made-up list:
 *
 * - no tunnel / channel refused  → `offline` (cached cards stay, `Reconectando…`,
 *   answers disabled with `Requiere conexión`);
 * - answer past the deadline     → `stale` with the last good cards and the
 *   amber `Datos de hace N min` chip;
 * - broken JSON / bad body       → `error` with `failure.message` + the raw
 *   evidence (the screen logs `{step, error, raw}` under `waiting-inbox`);
 * - zero waiting sessions        → `empty` (`Nada esperándote. Todo en marcha.`),
 *   never a success with zeros.
 *
 * Answers are NOT wired yet: `answerIntent` describes the pending route
 * `/waiting-inbox/<id>/answer` and the UI says so instead of pretending.
 */

import {
  type BridgeSession,
  type TunnelChannel,
  bridgeSessions,
} from './bridge.ts';
import { LastGood } from './overview-provider.ts';

/** A `/api/sessions` entry as the inbox reads it (protocol §6 + question). */
export interface InboxSession extends BridgeSession {
  /**
   * Question the agent is blocked on, when the bridge sends one. Absent or
   * blank means the card renders without a question block — never invented.
   */
  question?: string | null;
}

/** One card of the inbox. */
export interface InboxItem {
  id: string;
  /** Session title (the card subject when there is no question block). */
  title: string;
  /** Branch / project hint from the bridge, or null when it sends none. */
  projectHint: string | null;
  /** Accent session line: the hint when present, the title otherwise. */
  sessionLabel: string;
  /** Question text, or null when the agent left nothing to answer. */
  question: string | null;
  /** `esperando hace 4 min` / `esperando hace 3 días` / `esperando`. */
  waitingFor: string;
  /** Whole minutes since `updatedAt`; null when the timestamp is unusable. */
  waitingMinutes: number | null;
  /** ISO-8601 timestamp the bridge sent, kept for sorting and the log. */
  updatedAt: string;
}

/** §V9 states, logic level. `loading` is the first render, before any answer. */
export type InboxStateKind = 'loading' | 'empty' | 'success' | 'offline' | 'stale' | 'error';

/**
 * One honest inbox state. Every state except `loading` carries the cards to
 * render (`items`), so a failed refresh never blanks a populated screen.
 */
export type InboxState =
  | { kind: 'loading' }
  | { kind: 'empty'; items: InboxItem[] }
  | { kind: 'success'; items: InboxItem[] }
  | { kind: 'offline'; items: InboxItem[] }
  | { kind: 'stale'; minutes: number; items: InboxItem[] }
  | { kind: 'error'; message: string; raw: string | null; items: InboxItem[] };

/** Artboard intro, minus the "Respondé y sigue solo" promise (answers pending). */
export const INBOX_INTRO = 'El agente se detuvo para no decidir por vos.';

/** §V9 empty-state copy (views plan). */
export const INBOX_EMPTY_COPY = 'Nada esperándote. Todo en marcha.';

/** Why the answer actions are muted while there is no live answer channel. */
export const INBOX_ANSWER_OFF_NOTE = 'Requiere conexión';

/** Honest note under the list: answering is not wired yet. */
export const INBOX_ANSWER_PENDING_NOTE =
  'Responder todavía no está conectado: el envío se habilita cuando exista el canal de respuesta.';

/** Default per-request timeout for one inbox refresh. */
const INBOX_TIMEOUT_MS = 8_000;

/** Marker shared by callers that do not pass their own `LastGood`. */
const defaultLastGood = new LastGood();

/** Whole minutes since an ISO timestamp; null when it cannot be parsed. */
export function waitingMinutes(at: string, now: number = Date.now()): number | null {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  // Clock skew (a timestamp in the future) clamps at 0 instead of going negative.
  return Math.max(0, Math.floor((now - timestamp) / 60_000));
}

/**
 * Relative waiting copy: minutes below an hour, hours below a day, then days —
 * singular exactly at one, plural above.
 */
export function waitingCopy(minutes: number | null): string {
  if (minutes === null) {
    return 'esperando';
  }
  if (minutes < 1) {
    return 'esperando hace menos de 1 min';
  }
  if (minutes < 60) {
    return `esperando hace ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `esperando hace ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'esperando hace 1 día' : `esperando hace ${days} días`;
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text === '' ? null : text;
}

/** Map one bridge session onto its card (the caller already filtered status). */
export function inboxItemFromSession(
  session: InboxSession,
  now: number = Date.now(),
): InboxItem {
  const title = textOf(session.title) ?? session.id;
  const projectHint = textOf(session.hint);
  const question = textOf(session.question);
  const minutes = waitingMinutes(session.updatedAt, now);
  return {
    id: session.id,
    title,
    projectHint,
    sessionLabel: projectHint ?? title,
    question,
    waitingFor: waitingCopy(minutes),
    waitingMinutes: minutes,
    updatedAt: session.updatedAt,
  };
}

function timestampOf(at: string): number {
  const timestamp = Date.parse(at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Cards for the sessions that are `waiting`, newest first (the artboard's
 * order). Working, done and archived sessions never enter the inbox.
 */
export function inboxItemsFromSessions(
  sessions: readonly InboxSession[],
  now: number = Date.now(),
): InboxItem[] {
  return sessions
    .filter((session) => session.status === 'waiting')
    .map((session) => inboxItemFromSession(session, now))
    .sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt));
}

/** Raw body prefix for the `{step, error, raw}` log. */
function rawPrefix(body: unknown): string | null {
  try {
    if (typeof body === 'string') {
      return body.slice(0, 120);
    }
    const json = JSON.stringify(body);
    return typeof json === 'string' ? json.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** Options of one inbox refresh. */
export interface InboxLoadOptions {
  /** Cards on screen from the last good load; kept when a refresh fails. */
  cached?: readonly InboxItem[];
  /** Marker of the last good answer, for the `Datos de hace N min` chip. */
  lastGood?: LastGood;
  /** Per-request timeout (default 8 s). */
  timeoutMs?: number;
  /** Injectable clock for the relative copy (tests pin it). */
  now?: number;
}

/**
 * One real inbox load over the tunnel channel. `channel` is the *current*
 * bridge channel (null when no tunnel was opened): every call re-asks, so a
 * re-paired tunnel is picked up on the next pull without a restart.
 *
 * Never throws and never invents: a failure is the matching §V9 state.
 */
export async function loadInbox(
  channel: TunnelChannel | null,
  options: InboxLoadOptions = {},
): Promise<InboxState> {
  const cached = [...(options.cached ?? [])];
  if (channel === null) {
    return { kind: 'offline', items: cached };
  }
  const lastGood = options.lastGood ?? defaultLastGood;
  const result = await bridgeSessions(channel, {
    timeoutMs: options.timeoutMs ?? INBOX_TIMEOUT_MS,
  });
  if (!result.ok) {
    if (result.failure.kind === 'timeout') {
      const minutes = lastGood.minutesSince();
      // Stale needs cached cards: with nothing cached there is nothing truthful
      // to keep on screen, so the tunnel being down is the honest state.
      if (minutes !== null && cached.length > 0) {
        return { kind: 'stale', minutes, items: cached };
      }
      return { kind: 'offline', items: cached };
    }
    if (result.failure.kind === 'offline') {
      return { kind: 'offline', items: cached };
    }
    return {
      kind: 'error',
      message: result.failure.message,
      raw: result.failure.raw,
      items: cached,
    };
  }
  if (result.status >= 400) {
    return {
      kind: 'error',
      message: `La PC respondió ${result.status}.`,
      raw: `status=${result.status}`,
      items: cached,
    };
  }
  const body = result.body as { sessions?: unknown } | null;
  const sessions = body === null || typeof body !== 'object' ? undefined : body.sessions;
  if (!Array.isArray(sessions)) {
    return {
      kind: 'error',
      message: 'La PC devolvió datos incompletos.',
      raw: rawPrefix(result.body),
      items: cached,
    };
  }
  const items = inboxItemsFromSessions(sessions as InboxSession[], options.now);
  // A good answer (even an empty one) moves the stale chip's baseline.
  lastGood.mark();
  return items.length === 0 ? { kind: 'empty', items: [] } : { kind: 'success', items };
}

/** Pending answer descriptor: the route exists in the plan, not in the app. */
export interface AnswerIntent {
  kind: 'answer';
  sessionId: string;
  /** `/waiting-inbox/<id>/answer` — logged as `route pending`, never sent. */
  route: string;
  /** Always true until the answer channel lands: the UI must say so. */
  pending: true;
  /** Copy the screen shows instead of pretending the answer was sent. */
  pendingNote: string;
}

/** Build the pending answer descriptor for one session. */
export function answerIntent(sessionId: string): AnswerIntent {
  return {
    kind: 'answer',
    sessionId,
    route: `/waiting-inbox/${encodeURIComponent(sessionId)}/answer`,
    pending: true,
    pendingNote: INBOX_ANSWER_PENDING_NOTE,
  };
}

/** What `waiting-inbox.tsx` renders, per §V9 states. */
export interface InboxViewModel {
  state: InboxStateKind;
  items: InboxItem[];
  /** Header meta: `2 preguntas abiertas` / `1 pregunta abierta` / `Nada esperándote`. */
  countLine: string;
  /** Header chip: `2 pendientes` / `1 pendiente` / `Al día`. */
  pendingChip: string;
  /** Artboard intro line. */
  intro: string;
  /** §V9 empty card copy, when the inbox is genuinely empty. */
  emptyCard: string | null;
  /** Amber `Datos de hace N min` chip (stale-error). */
  staleChip: string | null;
  /** `Reconectando…` chip (offline). */
  offlineChip: string | null;
  /** Inline error block (`failure.message` + raw evidence), with Reintentar. */
  errorCard: { message: string; raw: string | null } | null;
  /** False while there is no live channel: answers are muted, never faked. */
  answerEnabled: boolean;
  /** Why the answer actions are muted, or null when they are available. */
  answerOffNote: string | null;
}

function countLine(items: readonly InboxItem[]): string {
  const questions = items.filter((item) => item.question !== null).length;
  if (questions === 0) {
    return 'Nada esperándote';
  }
  return questions === 1 ? '1 pregunta abierta' : `${questions} preguntas abiertas`;
}

function pendingChip(items: readonly InboxItem[]): string {
  if (items.length === 0) {
    return 'Al día';
  }
  return items.length === 1 ? '1 pendiente' : `${items.length} pendientes`;
}

/** Build the render model from a §V9 state. */
export function buildInbox(state: InboxState): InboxViewModel {
  const items = state.kind === 'loading' ? [] : state.items;
  const base = {
    items,
    countLine: countLine(items),
    pendingChip: pendingChip(items),
    intro: INBOX_INTRO,
    emptyCard: null,
    staleChip: null,
    offlineChip: null,
    errorCard: null,
    answerEnabled: false,
    answerOffNote: null,
  } as const;
  switch (state.kind) {
    case 'loading':
      return { state: 'loading', ...base };
    case 'empty':
      return {
        state: 'empty',
        ...base,
        emptyCard: INBOX_EMPTY_COPY,
        answerEnabled: true,
      };
    case 'success':
      return { state: 'success', ...base, answerEnabled: true };
    case 'stale':
      return {
        state: 'stale',
        ...base,
        staleChip: `Datos de hace ${state.minutes} min`,
        answerEnabled: true,
      };
    case 'offline':
      return {
        state: 'offline',
        ...base,
        offlineChip: 'Reconectando…',
        answerOffNote: INBOX_ANSWER_OFF_NOTE,
      };
    case 'error':
      return {
        state: 'error',
        ...base,
        errorCard: { message: state.message, raw: state.raw },
        answerOffNote: INBOX_ANSWER_OFF_NOTE,
      };
  }
}
