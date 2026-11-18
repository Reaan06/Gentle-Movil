/**
 * V10 + V11 — Automations logic (artboards
 * `design/mobile-app-core/05-automations.html` /
 * `06-automation-editor.html`, `docs/mobile-views-plan.md` §V10/§V11).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network of its own. `mobile/app/automations.tsx` and
 * `mobile/app/automation-editor.tsx` are the rendering shells and
 * `mobile/test/automations.test.mjs` pins these rules:
 *
 * - the strict parse of an automations payload, then the enabled / paused split
 *   the artboard shows (`Programadas` / `Pausadas`), each section ordered by
 *   the next run the PC reported (soonest first, no next run last);
 * - the schedule parser: cron-ish (minute steps and weekday ranges, e.g.
 *   `0 9 * * 1-5`), interval
 *   (`every 30m`) and a plain `disabled`, each with its human copy (`Cada 15
 *   min`, `Lunes a viernes a las 09:00`, `Cada 30 min`, `Desactivada`). An
 *   expression we cannot both validate and describe is `Programación no
 *   reconocida` — it never guesses, so `0 0 1 * *` (day of month) is refused
 *   instead of being mis-described as "every day";
 * - the last-run chip tone (ok / fail) and the next-run countdown, both derived
 *   from the real timestamps;
 * - the §V11 editor model: typed per-field errors (name, schedule, steps), the
 *   dirty diff against the original automation, and the `pending: true` save
 *   intent (`/automations/<id>` is not served by the PC yet);
 * - one honest state per outcome, mirroring `lib/sessions.ts` and `lib/git.ts`:
 *   `loading | empty | success | stale | offline | error`.
 *
 * ## The endpoints this module expects (protocol §4)
 *
 * `loadAutomations` performs `GET /api/automations` over the tunnel channel and
 * expects:
 *
 * ```json
 * {
 *   "automations": [
 *     { "id": "a1", "name": "Briefing diario", "schedule": "0 8 * * *",
 *       "enabled": true,
 *       "lastRun": { "at": "2026-11-18T02:00:00.000Z", "ok": true,
 *                    "summary": "briefing listo" },
 *       "nextRun": "2026-11-19T11:00:00.000Z" }
 *   ]
 * }
 * ```
 *
 * `loadAutomation` performs `GET /api/automations/<id>` and expects one
 * automation object (`id`, `name`, `schedule`, optional `steps`). `steps` is
 * what the editor needs and what the list endpoint need not carry: when the PC
 * omits it the editor says so (`stepsKnown: false`) instead of inventing the
 * work the automation does.
 *
 * Honesty rules (S7), the same the Sessions list and Git changes follow:
 * - no tunnel → `offline` (`Sin conexión — las automatizaciones corren en tu
 *   PC.`), never an empty "no automations" success and never a fake run history;
 * - an extension that does not expose the endpoint (404/501) → `error` with
 *   `La extensión no expone las automatizaciones todavía`;
 * - incomplete/invalid entries → `error` naming the offending value, never
 *   invented automations, schedules or run results;
 * - a timeout with a previous good answer → `stale` (`Datos de hace N min`);
 * - an empty `automations` array is the `empty` state (`Aún no hay
 *   automatizaciones.`), never success with zeros.
 *
 * Every failure is logged through the injectable `failure(step, error, raw)`
 * seam (`logger.tag('automations')` in the app) with `{step, error, raw}`.
 */

import {
  type BridgeFailure,
  type TunnelChannel,
  bridgeRequest,
} from './bridge.ts';
import { logger } from './logger.ts';
import { relativeTime } from './sessions.ts';

/* ------------------------------------------------------------------ *
 * Endpoints and app routes
 * ------------------------------------------------------------------ */

/** Endpoint expected from the bridge for the list (protocol §4). */
export const AUTOMATIONS_PATH = '/api/automations';

/** App route of the §V10 list. */
export const AUTOMATIONS_ROUTE = '/automations';

/** App route of the §V11 editor. */
export const EDITOR_ROUTE = '/automation-editor';

/** `/api/automations/<id>` — one automation (editor load). */
export function automationPath(id: string): string {
  return `${AUTOMATIONS_PATH}/${encodeURIComponent(id)}`;
}

/** `/automation-editor?id=<id>` — where a §V10 row opens. */
export function automationRoute(id: string): string {
  return `${EDITOR_ROUTE}?id=${encodeURIComponent(id)}`;
}

/** `/automations` or `/automations/<id>` — the save endpoint, not built yet. */
export function automationSaveRoute(id: string | null): string {
  return id === null ? AUTOMATIONS_ROUTE : `${AUTOMATIONS_ROUTE}/${id}`;
}

/* ------------------------------------------------------------------ *
 * Schedule parsing (§V10 rows, §V11 preview)
 * ------------------------------------------------------------------ */

/** Human copy when a schedule cannot be both validated and described. */
export const SCHEDULE_UNKNOWN_COPY = 'Programación no reconocida';

/** Human copy of the plain `disabled` schedule. */
export const SCHEDULE_DISABLED_COPY = 'Desactivada';

/** What a schedule string turned out to be. */
export type ScheduleKind = 'cron' | 'interval' | 'disabled' | 'unknown';

/** Parsed schedule: kind, normalized expression and never-guessed human copy. */
export interface ParsedSchedule {
  kind: ScheduleKind;
  /** Normalized expression as it would be saved (`every 30m`, single-spaced cron). */
  expression: string;
  /** Human copy of §V10/§V11 (`Cada 15 min`, `Lunes a viernes a las 09:00`, …). */
  label: string;
  /** True when the schedule was understood: `kind !== 'unknown'`. */
  known: boolean;
}

/** One expanded cron field. */
interface CronField {
  /** The field exactly as written (`*`, a step field, `1-5`, `1,3,5`). */
  raw: string;
  /** Expanded, sorted, deduplicated values. */
  values: number[];
  /** True only for a bare `*`. */
  wildcard: boolean;
  /** Stride of a single `x/N` or `a-b/N` part, null when there is none. */
  step: number | null;
}

const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/** Collapse whitespace so a cron with padded spaces reads as one expression. */
function collapseSpace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function capitalize(text: string): string {
  return text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function unknownSchedule(expression: string): ParsedSchedule {
  return {
    kind: 'unknown',
    expression,
    label: SCHEDULE_UNKNOWN_COPY,
    known: false,
  };
}

/**
 * Expand one cron field. Supports `*`, a step over `*` or a range, `N`, `a-b` and comma
 * lists of those, strictly inside the field range: anything else is refused so
 * a malformed expression never becomes a schedule.
 */
function expandCronField(
  raw: string,
  min: number,
  max: number,
  wrapDayOfWeek = false,
): CronField | null {
  if (raw === '') {
    return null;
  }
  const parts = raw.split(',');
  const collected = new Set<number>();
  let step: number | null = null;

  for (const part of parts) {
    if (part === '') {
      return null;
    }
    const segments = part.split('/');
    if (segments.length > 2) {
      return null;
    }
    const [rangeText, stepText] = segments;
    let from: number;
    let to: number;
    if (rangeText === '*') {
      from = min;
      to = max;
    } else if (/^\d+(-\d+)?$/.test(rangeText)) {
      const [a, b] = rangeText.split('-');
      from = Number(a);
      // `a/N` means "every N from a to the end of the field", exactly like cron.
      to = b !== undefined ? Number(b) : stepText !== undefined ? max : Number(a);
      if (from < min || from > max || to < min || to > max || from > to) {
        return null;
      }
    } else {
      return null;
    }
    let stride = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) {
        return null;
      }
      stride = Number(stepText);
      if (stride < 1) {
        return null;
      }
      if (parts.length === 1) {
        step = stride;
      }
    }
    for (let value = from; value <= to; value += stride) {
      collected.add(value);
    }
  }

  const values = [...collected].map((value) =>
    wrapDayOfWeek && value === 7 ? 0 : value,
  );
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length === 0) {
    return null;
  }
  return { raw, values: unique, wildcard: raw === '*', step };
}

/** `Todos los días` / `Lunes a viernes` / `Los lunes` / a comma list. */
function describeDays(field: CronField): string | null {
  const days = field.values;
  if (days.length === 7) {
    return 'Todos los días';
  }
  if (days.length === 1) {
    const name = DAY_NAMES[days[0]];
    // `lunes` / `martes` / … are already plural-looking; `domingo` is not.
    return `Los ${name.endsWith('s') ? name : `${name}s`}`;
  }
  const key = days.join(',');
  if (key === '1,2,3,4,5') {
    return 'Lunes a viernes';
  }
  if (key === '0,6') {
    return 'Sábados y domingos';
  }
  const names = days.map((day) => DAY_NAMES[day]);
  return `${capitalize(names.slice(0, -1).join(', '))} y ${names[names.length - 1]}`;
}

/**
 * Human copy of an already-validated cron. Returns null — so the caller reports
 * `Programación no reconocida` — for every shape this module cannot describe
 * exactly: day-of-month/month filters, minute lists, hour lists, steps on the
 * hour, and weekdays combined with a minute step.
 */
function describeCron(
  minute: CronField,
  hour: CronField,
  dayOfMonth: CronField,
  month: CronField,
  dayOfWeek: CronField,
): string | null {
  if (!dayOfMonth.wildcard || !month.wildcard) {
    return null;
  }
  if (minute.wildcard) {
    return hour.wildcard ? 'Cada minuto' : null;
  }
  if (minute.step !== null && minute.raw.startsWith('*/')) {
    if (!hour.wildcard || !dayOfWeek.wildcard) {
      return null;
    }
    return minute.step === 1 ? 'Cada minuto' : `Cada ${minute.step} min`;
  }
  if (minute.values.length !== 1) {
    return null;
  }
  const minutes = minute.values[0];
  const days = describeDays(dayOfWeek);
  if (days === null) {
    return null;
  }
  if (hour.wildcard) {
    return `Cada hora a los :${pad2(minutes)}`;
  }
  if (hour.values.length !== 1) {
    return null;
  }
  return `${days} a las ${pad2(hour.values[0])}:${pad2(minutes)}`;
}

const INTERVAL_PATTERN = /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|hr|hrs|d|day|days)$/i;

/** `every 30m` / `every 2 hours` / `every 1d` → `Cada 30 min` / … */
function parseInterval(expression: string): ParsedSchedule | null {
  const match = INTERVAL_PATTERN.exec(expression);
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const short = unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : 'm';
  let label: string;
  if (short === 'm') {
    label = `Cada ${amount} min`;
  } else if (short === 'h') {
    label = amount === 1 ? 'Cada 1 hora' : `Cada ${amount} horas`;
  } else {
    label = amount === 1 ? 'Cada 1 día' : `Cada ${amount} días`;
  }
  return {
    kind: 'interval',
    expression: `every ${amount}${short}`,
    label,
    known: true,
  };
}

/** Five-field cron → human copy, or null when it cannot be described exactly. */
function parseCron(expression: string): ParsedSchedule | null {
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    return null;
  }
  const minute = expandCronField(parts[0], 0, 59);
  const hour = expandCronField(parts[1], 0, 23);
  const dayOfMonth = expandCronField(parts[2], 1, 31);
  const month = expandCronField(parts[3], 1, 12);
  const dayOfWeek = expandCronField(parts[4], 0, 7, true);
  if (
    minute === null ||
    hour === null ||
    dayOfMonth === null ||
    month === null ||
    dayOfWeek === null
  ) {
    return null;
  }
  const label = describeCron(minute, hour, dayOfMonth, month, dayOfWeek);
  if (label === null) {
    return null;
  }
  return { kind: 'cron', expression, label, known: true };
}

/**
 * Parse a schedule exactly as the PC stores it. `unknown` is a real answer (the
 * honest `Programación no reconocida`): it is never a guessed description.
 */
export function parseSchedule(input: string): ParsedSchedule {
  const expression = collapseSpace(input);
  if (expression === '') {
    return unknownSchedule(expression);
  }
  if (/^disabled$/i.test(expression)) {
    return {
      kind: 'disabled',
      expression: 'disabled',
      label: SCHEDULE_DISABLED_COPY,
      known: true,
    };
  }
  const interval = parseInterval(expression);
  if (interval !== null) {
    return interval;
  }
  const cron = parseCron(expression);
  if (cron !== null) {
    return cron;
  }
  return unknownSchedule(expression);
}

/* ------------------------------------------------------------------ *
 * Wire model (§V10 payload)
 * ------------------------------------------------------------------ */

/** One execution the PC reported. */
export interface AutomationRun {
  /** ISO-8601 timestamp of the run. */
  at: string;
  /** True when the run finished well; false is a real failure, never unknown. */
  ok: boolean;
  /** What the run produced, when the PC sent a summary. */
  summary: string | null;
}

/** One automation as the PC reports it (list endpoint). */
export interface Automation {
  id: string;
  name: string;
  /** Expression exactly as the PC stores it. */
  schedule: string;
  enabled: boolean;
  lastRun: AutomationRun | null;
  /** ISO-8601 of the next run, null when the PC has none scheduled. */
  nextRun: string | null;
}

/** The §V10 payload. */
export interface AutomationsPayload {
  automations: Automation[];
}

/** Parse outcome: the real payload, or why the body is not usable. */
export type ParseResult =
  | { ok: true; payload: AutomationsPayload }
  | { ok: false; message: string; raw: string | null };

/** Copy of an incomplete payload (§V10 `error`). */
export const INCOMPLETE_COPY = 'La PC devolvió automatizaciones incompletas.';

/** Raw evidence of any value, truncated for the log and the error card. */
function rawPrefix(value: unknown): string | null {
  try {
    if (value === undefined || value === null) {
      return null;
    }
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.slice(0, 120) : null;
  } catch {
    return null;
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** One raw run entry → a run, `null` for an explicit null, `false` when unusable. */
function parseRun(entry: unknown): AutomationRun | null | false {
  if (entry === null) {
    return null;
  }
  if (typeof entry !== 'object') {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (!isTimestamp(record.at) || typeof record.ok !== 'boolean') {
    return false;
  }
  const summary = record.summary;
  if (!(summary === null || typeof summary === 'string')) {
    return false;
  }
  return { at: record.at, ok: record.ok, summary };
}

/** One raw automation entry → an automation, or null when it is unusable. */
function parseAutomationEntry(entry: unknown): Automation | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (!isText(record.id) || !isText(record.name) || !isText(record.schedule)) {
    return null;
  }
  if (typeof record.enabled !== 'boolean') {
    return null;
  }
  const run = parseRun(record.lastRun);
  if (run === false) {
    return null;
  }
  const nextRun = record.nextRun;
  if (!(nextRun === null || isTimestamp(nextRun))) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    schedule: record.schedule,
    enabled: record.enabled,
    lastRun: run,
    nextRun,
  };
}

/**
 * Validate the §V10 body. Anything else is refused with the raw evidence of the
 * offending value: a half-understood payload must never become rows, because a
 * row here claims "this is what your PC will run".
 */
export function parseAutomations(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(body) };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.automations)) {
    return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(body) };
  }
  const automations: Automation[] = [];
  for (const entry of record.automations) {
    const parsed = parseAutomationEntry(entry);
    if (parsed === null) {
      return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(entry) };
    }
    automations.push(parsed);
  }
  return { ok: true, payload: { automations } };
}

/* ------------------------------------------------------------------ *
 * Editor payload (one automation)
 * ------------------------------------------------------------------ */

/** One automation the editor can open; `steps` are what it will run. */
export interface EditorAutomation {
  id: string;
  name: string;
  schedule: string;
  /** Steps the PC reported; empty when it reported none (never invented). */
  steps: string[];
  /** False when the payload carried no `steps` field at all. */
  stepsKnown: boolean;
}

/** Parse outcome of one automation. */
export type AutomationParseResult =
  | { ok: true; automation: EditorAutomation }
  | { ok: false; message: string; raw: string | null };

/**
 * Validate the single-automation body (`GET /api/automations/<id>`). `enabled`
 * and the run fields are ignored here — the editor only edits name, schedule
 * and steps — but an unusable shape is still refused with its raw evidence.
 */
export function parseEditorAutomation(body: unknown): AutomationParseResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(body) };
  }
  const record = body as Record<string, unknown>;
  if (!isText(record.id) || !isText(record.name) || !isText(record.schedule)) {
    return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(body) };
  }
  const stepsKnown = Array.isArray(record.steps);
  const steps: string[] = [];
  if (stepsKnown) {
    for (const step of record.steps as unknown[]) {
      if (typeof step !== 'string') {
        return { ok: false, message: INCOMPLETE_COPY, raw: rawPrefix(record.steps) };
      }
      const trimmed = step.trim();
      if (trimmed !== '') {
        steps.push(trimmed);
      }
    }
  }
  return {
    ok: true,
    automation: {
      id: record.id,
      name: record.name,
      schedule: record.schedule,
      steps,
      stepsKnown,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Ordering, countdown and last-run copy
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;

/** `Próxima en 2 h 14 min` / `Próxima en 45 min` / `Pausada · sin próxima ejecución`. */
export function countdownLabel(
  nextRun: string | null,
  enabled: boolean,
  now: number = Date.now(),
): string {
  if (nextRun === null) {
    return enabled ? 'Sin próxima ejecución' : 'Pausada · sin próxima ejecución';
  }
  const at = Date.parse(nextRun);
  if (Number.isNaN(at)) {
    return 'Sin próxima ejecución';
  }
  const diff = at - now;
  if (diff < 0) {
    return `Próxima vencida ${relativeTime(nextRun, now)}`;
  }
  const minutes = Math.floor(diff / MINUTE);
  if (minutes < 1) {
    return 'Próxima en menos de 1 min';
  }
  if (minutes < 60) {
    return `Próxima en ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0 ? `Próxima en ${hours} h` : `Próxima en ${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Próxima en 1 día' : `Próxima en ${days} días`;
}

/** Last-run chip: `ok · hace 10 h` / `falló ayer` → tone ok / fail. */
export function lastRunLabel(
  run: AutomationRun,
  now: number = Date.now(),
): { label: string; tone: 'ok' | 'fail' } {
  const when = relativeTime(run.at, now);
  return run.ok
    ? { label: `ok · ${when}`, tone: 'ok' }
    : { label: `falló ${when}`, tone: 'fail' };
}

/** Sort key: next run ascending, no next run last, name as the stable tie-break. */
export function sortAutomations(
  automations: readonly Automation[],
): Automation[] {
  return automations
    .map((automation, index) => ({
      automation,
      index,
      at: automation.nextRun === null ? null : Date.parse(automation.nextRun),
    }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) {
          return 1;
        }
        if (b.at === null) {
          return -1;
        }
        return a.at - b.at;
      }
      const byName = a.automation.name.localeCompare(b.automation.name, 'es');
      return byName !== 0 ? byName : a.index - b.index;
    })
    .map((entry) => entry.automation);
}

/* ------------------------------------------------------------------ *
 * Honest states
 * ------------------------------------------------------------------ */

/** The §V10 states table, logic level. */
export type AutomationsState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; automations: Automation[] }
  | { kind: 'stale'; minutes: number; automations: Automation[] }
  | { kind: 'offline'; automations: Automation[] | null; minutes: number | null }
  | { kind: 'error'; message: string; raw: string | null };

/**
 * Last good `/api/automations` answer, so a later timeout can show the cached
 * rows with the honest age instead of inventing a list or pretending none exist.
 */
export class AutomationsCache {
  private automations: Automation[] = [];
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "the PC answered this list, now". */
  mark(automations: readonly Automation[]): void {
    this.automations = [...automations];
    this.at = this.now();
  }

  /** Cached rows + minutes since they arrived, or null when never answered. */
  snapshot(): { automations: Automation[]; minutes: number } | null {
    if (this.at === 0) {
      return null;
    }
    const minutes = Math.max(1, Math.floor((this.now() - this.at) / 60_000));
    return { automations: this.automations, minutes };
  }

  /** Drops the cache: an empty answer is truth, not something to fall back to. */
  clear(): void {
    this.automations = [];
    this.at = 0;
  }
}

/** Failure sink this module needs (`logger.tag('automations')` satisfies it). */
export interface AutomationsLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Injectable dependencies (cache, logger, deadline). */
export interface LoadAutomationsDeps {
  /** Cache of the last good answer (stale/offline rows). */
  cache?: AutomationsCache;
  /** Failure sink; defaults to `logger.tag('automations')`. */
  logger?: AutomationsLogger;
  /** Deadline of the `/api/automations` call (default `AUTOMATIONS_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** Default deadline of one list fetch, matching the other bridge calls. */
export const AUTOMATIONS_TIMEOUT_MS = 8_000;

/** Copy when the tunnel is down (§V10 offline). */
export const OFFLINE_COPY = 'Sin conexión — las automatizaciones corren en tu PC.';

/** Copy of the reconnect hint next to `OFFLINE_COPY`. */
export const RECONNECTING_COPY = 'Reconectando…';

/** Copy when the extension does not serve the endpoint yet. */
export const MISSING_ENDPOINT_COPY = 'La extensión no expone las automatizaciones todavía';

/** Copy of the error card title (§V10 `error`). */
export const ERROR_TITLE = 'No pudimos cargar automatizaciones';

/** Copy when the PC really has no automations (§V10 `empty`). */
export const EMPTY_COPY = 'Aún no hay automatizaciones.';

/** Copy of the pending enable/disable switch (§V10 reaction, endpoint not built). */
export const TOGGLE_PENDING_NOTE =
  'Cambiar una automatización todavía no está conectado: la PC no expone PATCH automation.enabled.';

/** Raw evidence of a failure, always something the log can keep. */
function rawOf(failure: BridgeFailure): string {
  return failure.raw ?? failure.kind;
}

/**
 * One failed bridge call → the §V10 state it deserves. Mirrors
 * `stateFromFailure` of `lib/git.ts`:
 *
 * - `offline` → offline, with the cached rows when there are any;
 * - `timeout` → stale when something was cached, offline when nothing was;
 * - `bad-response` / `protocol-status` → error carrying message + raw.
 */
export function stateFromFailure(
  failure: BridgeFailure,
  cache: AutomationsCache | null = null,
): AutomationsState {
  const cached = cache?.snapshot() ?? null;
  switch (failure.kind) {
    case 'offline':
      return {
        kind: 'offline',
        automations: cached?.automations ?? null,
        minutes: cached?.minutes ?? null,
      };
    case 'timeout':
      return cached === null
        ? { kind: 'offline', automations: null, minutes: null }
        : { kind: 'stale', minutes: cached.minutes, automations: cached.automations };
    default:
      return { kind: 'error', message: failure.message, raw: failure.raw };
  }
}

/** Default failure sink for the app (one tag, one ring buffer, one log file). */
export const automationsLog: AutomationsLogger = logger.tag('automations');

/**
 * Fetch `GET /api/automations` over the tunnel channel and return the §V10
 * state. A null channel means the app has no tunnel (never opened or closed),
 * which is `offline` — the screen says so instead of showing an empty list.
 *
 * Never throws and never invents: every failure is the matching §V10 state.
 */
export async function loadAutomations(
  channel: TunnelChannel | null,
  deps: LoadAutomationsDeps = {},
): Promise<AutomationsState> {
  const log = deps.logger ?? automationsLog;
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

  const result = await bridgeRequest<unknown>(channel, AUTOMATIONS_PATH, {
    timeoutMs: deps.timeoutMs ?? AUTOMATIONS_TIMEOUT_MS,
  });
  if (!result.ok) {
    log.failure(
      'automations-request',
      result.failure.error ?? new Error(result.failure.message),
      rawOf(result.failure),
    );
    return stateFromFailure(result.failure, cache);
  }

  if (result.status < 200 || result.status >= 300) {
    // The bridge answered, but not with a list. A missing endpoint is the
    // expected state today (protocol §4 has no automations surface yet): it must
    // read as "this is not available", never as "you have no automations".
    const missing = result.status === 404 || result.status === 501;
    const message = missing ? MISSING_ENDPOINT_COPY : `La PC respondió ${result.status}.`;
    const raw = `status=${result.status} ${AUTOMATIONS_PATH}`;
    log.failure('automations-request', new Error(message), raw);
    return { kind: 'error', message, raw };
  }

  const parsed = parseAutomations(result.body);
  if (!parsed.ok) {
    log.failure('automations-parse', new Error(parsed.message), parsed.raw);
    return { kind: 'error', message: parsed.message, raw: parsed.raw };
  }

  if (parsed.payload.automations.length === 0) {
    // A real empty PC: no rows, no zeros pretending to be data and no cache to
    // fall back to on the next timeout.
    cache?.clear();
    return { kind: 'empty' };
  }

  cache?.mark(parsed.payload.automations);
  return { kind: 'success', automations: sortAutomations(parsed.payload.automations) };
}

/** Result of opening one automation in the §V11 editor. */
export type AutomationLoad =
  | { kind: 'success'; automation: EditorAutomation }
  | { kind: 'not-found'; message: string }
  | { kind: 'offline' }
  | { kind: 'error'; message: string; raw: string | null };

/** Copy when the PC has no such automation (or does not expose it yet). */
export const NOT_FOUND_COPY = 'No encontramos esa automatización en la PC.';

/**
 * Fetch `GET /api/automations/<id>` over the tunnel channel. Never throws: the
 * editor renders the matching honest state and keeps its typed draft.
 */
export async function loadAutomation(
  channel: TunnelChannel | null,
  id: string,
  deps: LoadAutomationsDeps = {},
): Promise<AutomationLoad> {
  const log = deps.logger ?? automationsLog;

  if (channel === null) {
    log.failure('tunnel', new Error('Sin túnel abierto hacia la PC.'), null);
    return { kind: 'offline' };
  }

  const path = automationPath(id);
  const result = await bridgeRequest<unknown>(channel, path, {
    timeoutMs: deps.timeoutMs ?? AUTOMATIONS_TIMEOUT_MS,
  });
  if (!result.ok) {
    log.failure(
      'automation-request',
      result.failure.error ?? new Error(result.failure.message),
      rawOf(result.failure),
    );
    if (result.failure.kind === 'offline') {
      return { kind: 'offline' };
    }
    return { kind: 'error', message: result.failure.message, raw: result.failure.raw };
  }

  if (result.status === 404) {
    log.failure('automation-request', new Error(NOT_FOUND_COPY), `status=404 ${path}`);
    return { kind: 'not-found', message: NOT_FOUND_COPY };
  }
  if (result.status < 200 || result.status >= 300) {
    const message = `La PC respondió ${result.status}.`;
    const raw = `status=${result.status} ${path}`;
    log.failure('automation-request', new Error(message), raw);
    return { kind: 'error', message, raw };
  }

  const parsed = parseEditorAutomation(result.body);
  if (!parsed.ok) {
    log.failure('automation-parse', new Error(parsed.message), parsed.raw);
    return { kind: 'error', message: parsed.message, raw: parsed.raw };
  }
  return { kind: 'success', automation: parsed.automation };
}

/* ------------------------------------------------------------------ *
 * §V10 render model
 * ------------------------------------------------------------------ */

/** One automation row of the list. */
export interface AutomationRow {
  id: string;
  name: string;
  /** Raw expression as the PC stores it (editor field value). */
  schedule: string;
  /** Human copy of the expression (`Cada 15 min`, …). */
  scheduleLabel: string;
  enabled: boolean;
  /** `Activa` / `Pausada` under the switch. */
  stateLabel: 'Activa' | 'Pausada';
  /** `Próxima en 2 h 14 min` / `Pausada · sin próxima ejecución`. */
  nextRunLabel: string;
  nextRunAt: string | null;
  /** Last-run chip, null when the automation never ran. */
  lastRun: { label: string; tone: 'ok' | 'fail' } | null;
  /** Where the row opens (`/automation-editor?id=<id>`). */
  route: string;
  /** Rows read from the cache (offline/stale): countdowns frozen at `now`. */
  frozen: boolean;
}

/** Enabled or paused section of §V10. */
export interface AutomationSection {
  id: 'enabled' | 'disabled';
  /** `Programadas` / `Pausadas`. */
  title: string;
  rows: AutomationRow[];
}

/** Section ids and titles, artboard order. */
export const SECTION_TITLES: Record<AutomationSection['id'], string> = {
  enabled: 'Programadas',
  disabled: 'Pausadas',
};

/** What `automations.tsx` renders, per §V10 states + reactions. */
export interface AutomationsViewModel {
  state: 'loading' | 'empty' | 'success' | 'stale' | 'offline' | 'error';
  /** Non-empty sections: `Programadas` (enabled) then `Pausadas` (disabled). */
  sections: AutomationSection[];
  counts: { all: number; enabled: number; disabled: number };
  /** `4 definiciones · 3 activas · 1 pausada`, when there is data. */
  summary: string | null;
  /** Amber chip over cached rows (`Datos de hace N min` / `Última vez hace N min`). */
  staleChip: string | null;
  /** Offline banner copy (`Sin conexión — las automatizaciones corren en tu PC.`). */
  banner: string | null;
  /** Reconnect hint next to the offline banner (`Reconectando…`). */
  bannerHint: string | null;
  /** Error card copy + raw evidence (`No pudimos cargar automatizaciones`). */
  error: { title: string; message: string; raw: string | null } | null;
  /** `Aún no hay automatizaciones.` only for a genuinely empty PC. */
  emptyMessage: string | null;
  /** Rows read from the cache (offline/stale): countdowns frozen, switches muted. */
  frozen: boolean;
  /** Skeleton rows are showing (pull-to-refresh keeps the rows). */
  loading: boolean;
  /** The enable/disable endpoint is not built: the switch only explains itself. */
  togglePending: boolean;
  /** Honest note under a tapped switch. */
  toggleNote: string;
  /** `+ Nueva automatización` target. */
  createRoute: string;
}

/** `4 definiciones · 3 activas · 1 pausada`. */
export function summaryLine(counts: AutomationsViewModel['counts']): string {
  const definitions = counts.all === 1 ? '1 definición' : `${counts.all} definiciones`;
  const active = counts.enabled === 1 ? '1 activa' : `${counts.enabled} activas`;
  const paused = counts.disabled === 1 ? '1 pausada' : `${counts.disabled} pausadas`;
  return `${definitions} · ${active} · ${paused}`;
}

/** One `Automation` → one row; `frozen` marks cached rows. */
export function automationRow(
  automation: Automation,
  options: { now?: number; frozen?: boolean } = {},
): AutomationRow {
  const now = options.now ?? Date.now();
  return {
    id: automation.id,
    name: automation.name,
    schedule: automation.schedule,
    scheduleLabel: parseSchedule(automation.schedule).label,
    enabled: automation.enabled,
    stateLabel: automation.enabled ? 'Activa' : 'Pausada',
    nextRunLabel: countdownLabel(automation.nextRun, automation.enabled, now),
    nextRunAt: automation.nextRun,
    lastRun: automation.lastRun === null ? null : lastRunLabel(automation.lastRun, now),
    route: automationRoute(automation.id),
    frozen: options.frozen ?? false,
  };
}

/**
 * Enabled / paused split, each section ordered by next run. Empty sections are
 * omitted: a `Pausadas` header with no rows would claim something was paused.
 */
export function buildAutomationSections(
  automations: readonly Automation[],
  options: { now?: number; frozen?: boolean } = {},
): AutomationSection[] {
  const sections: AutomationSection[] = [];
  for (const id of ['enabled', 'disabled'] as const) {
    const members = automations.filter(
      (automation) => automation.enabled === (id === 'enabled'),
    );
    if (members.length === 0) {
      continue;
    }
    sections.push({
      id,
      title: SECTION_TITLES[id],
      rows: sortAutomations(members).map((automation) =>
        automationRow(automation, options),
      ),
    });
  }
  return sections;
}

/** Build the render model from a §V10 state. */
export function buildAutomationsView(
  state: AutomationsState,
  now: number = Date.now(),
): AutomationsViewModel {
  const base: Omit<AutomationsViewModel, 'state'> = {
    sections: [],
    counts: { all: 0, enabled: 0, disabled: 0 },
    summary: null,
    staleChip: null,
    banner: null,
    bannerHint: null,
    error: null,
    emptyMessage: null,
    frozen: false,
    loading: false,
    togglePending: true,
    toggleNote: TOGGLE_PENDING_NOTE,
    createRoute: EDITOR_ROUTE,
  };

  /** Shared projection of a list that may be live or cached. */
  const projection = (automations: readonly Automation[], frozen: boolean) => {
    const counts = {
      all: automations.length,
      enabled: automations.filter((automation) => automation.enabled).length,
      disabled: automations.filter((automation) => !automation.enabled).length,
    };
    return {
      sections: buildAutomationSections(automations, { now, frozen }),
      counts,
      summary: summaryLine(counts),
      frozen,
    };
  };

  switch (state.kind) {
    case 'loading':
      return { ...base, state: 'loading', loading: true };
    case 'empty':
      return { ...base, state: 'empty', emptyMessage: EMPTY_COPY };
    case 'error':
      return {
        ...base,
        state: 'error',
        error: { title: ERROR_TITLE, message: state.message, raw: state.raw },
      };
    case 'success':
      return { ...base, state: 'success', ...projection(state.automations, false) };
    case 'stale':
      return {
        ...base,
        state: 'stale',
        ...projection(state.automations, true),
        staleChip: `Datos de hace ${state.minutes} min`,
      };
    case 'offline': {
      if (state.automations === null) {
        // Nothing cached: only the honest offline notice, no invented rows.
        return {
          ...base,
          state: 'offline',
          banner: OFFLINE_COPY,
          bannerHint: RECONNECTING_COPY,
        };
      }
      const minutes = state.minutes;
      return {
        ...base,
        state: 'offline',
        ...projection(state.automations, true),
        staleChip: minutes === null ? null : `Última vez hace ${minutes} min`,
        banner: OFFLINE_COPY,
        bannerHint: RECONNECTING_COPY,
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * §V11 editor model
 * ------------------------------------------------------------------ */

/** The draft the editor edits. */
export interface AutomationDraft {
  name: string;
  schedule: string;
  /** What the automation runs, in order. At least one is required. */
  steps: string[];
}

/** A fresh draft: every field empty, no steps to guess. */
export function emptyDraft(): AutomationDraft {
  return { name: '', schedule: '', steps: [] };
}

/** The draft an existing automation opens with (its real name, schedule, steps). */
export function draftFromAutomation(automation: EditorAutomation): AutomationDraft {
  return {
    name: automation.name,
    schedule: automation.schedule,
    steps: [...automation.steps],
  };
}

/** Field names the editor validates and diffs. */
export type DraftField = 'name' | 'schedule' | 'steps';

/** Typed validation codes (one per rule). */
export type ValidationCode = 'name-required' | 'schedule-unrecognized' | 'steps-required';

/** One typed field error. */
export interface FieldError {
  code: ValidationCode;
  message: string;
}

/** Per-field validation result. */
export interface DraftValidation {
  valid: boolean;
  errors: {
    name: FieldError | null;
    schedule: FieldError | null;
    steps: FieldError | null;
  };
}

/** Copy of the schedule error (the label stays `Programación no reconocida`). */
export const SCHEDULE_ERROR_COPY =
  'No entendimos la expresión. Probá «*/15 * * * *» o «every 30m».';

/** Trim values, drop blank steps, normalize the schedule expression. */
export function normalizeDraft(draft: AutomationDraft): AutomationDraft {
  const schedule = parseSchedule(draft.schedule);
  return {
    name: draft.name.trim(),
    schedule: schedule.known ? schedule.expression : collapseSpace(draft.schedule),
    steps: draft.steps.map((step) => step.trim()).filter((step) => step !== ''),
  };
}

/** Validate every §V11 rule and return the typed errors per field. */
export function validateDraft(draft: AutomationDraft): DraftValidation {
  const normalized = normalizeDraft(draft);
  const errors: DraftValidation['errors'] = {
    name: null,
    schedule: null,
    steps: null,
  };
  if (normalized.name === '') {
    errors.name = { code: 'name-required', message: 'El nombre no puede estar vacío.' };
  }
  if (!parseSchedule(draft.schedule).known) {
    errors.schedule = { code: 'schedule-unrecognized', message: SCHEDULE_ERROR_COPY };
  }
  if (normalized.steps.length === 0) {
    errors.steps = { code: 'steps-required', message: 'Agregá al menos un paso.' };
  }
  return {
    valid: errors.name === null && errors.schedule === null && errors.steps === null,
    errors,
  };
}

/** Dirty-state comparison against the original automation. */
export interface DraftDiff {
  dirty: boolean;
  /** Fields whose normalized value differs from the original, in field order. */
  changed: DraftField[];
}

/** Compare the normalized draft with the original (null for a new automation). */
export function draftDiff(
  draft: AutomationDraft,
  original: AutomationDraft | null,
): DraftDiff {
  const base = normalizeDraft(original ?? emptyDraft());
  const next = normalizeDraft(draft);
  const changed: DraftField[] = [];
  if (base.name !== next.name) {
    changed.push('name');
  }
  if (base.schedule !== next.schedule) {
    changed.push('schedule');
  }
  if (base.steps.join('\n') !== next.steps.join('\n')) {
    changed.push('steps');
  }
  return { dirty: changed.length > 0, changed };
}

/**
 * What saving would do. The PC does not serve the automations write endpoints
 * yet (protocol §4 only guarantees `/api/health` and `/api/sessions`), so the
 * intent is always `pending: true` and the screen logs the route instead of
 * pretending the automation was saved.
 */
export interface SaveIntent {
  pending: true;
  method: 'POST' | 'PATCH';
  /** `/automations` for a new one, `/automations/<id>` when editing. */
  route: string;
  /** Normalized body the request would carry once the endpoint exists. */
  body: { name: string; schedule: string; steps: string[] };
  /** Honest note naming the missing endpoint. */
  note: string;
}

/** Build the save intent of a draft. */
export function saveIntent(draft: AutomationDraft, id: string | null): SaveIntent {
  const normalized = normalizeDraft(draft);
  const route = automationSaveRoute(id);
  return {
    pending: true,
    method: id === null ? 'POST' : 'PATCH',
    route,
    body: {
      name: normalized.name,
      schedule: normalized.schedule,
      steps: normalized.steps,
    },
    note:
      id === null
        ? 'Crear automatizaciones todavía no está conectado: la PC no expone POST /automations.'
        : `Guardar todavía no está conectado: la PC no expone PATCH ${route}.`,
  };
}

/** What the editor needs to know about the automation it is editing. */
export interface EditorContext {
  /** The existing automation, or null when creating a new one. */
  automation: EditorAutomation | null;
  /** False when there is no tunnel: saving needs the PC (default true). */
  online?: boolean;
}

/** What `automation-editor.tsx` renders. */
export interface EditorViewModel {
  title: string;
  /** `<name> · se guarda en tu PC` (or just the second half for a new one). */
  meta: string;
  name: { value: string; error: FieldError | null };
  schedule: {
    value: string;
    /** Human preview from `parseSchedule` (`Programación no reconocida` included). */
    label: string;
    recognized: boolean;
    error: FieldError | null;
  };
  steps: { values: string[]; error: FieldError | null; canRemove: boolean };
  /** Honest note when the PC did not report the steps (never invented). */
  stepsHint: string | null;
  dirty: boolean;
  changed: DraftField[];
  canSave: boolean;
  /** `Requiere conexión` when there is no tunnel, null otherwise. */
  saveBlockedCopy: string | null;
  saveLabel: string;
  save: SaveIntent;
  discardPrompt: string;
  discardConfirm: string;
  discardCancel: string;
}

/** Copy of the discard dialog (§V11 `dirty` state). */
export const DISCARD_PROMPT = 'Descartar cambios?';

/** Build the §V11 editor model from the current draft. */
export function buildEditorView(
  draft: AutomationDraft,
  context: EditorContext,
): EditorViewModel {
  const original = context.automation;
  const online = context.online ?? true;
  const normalized = normalizeDraft(draft);
  const validation = validateDraft(draft);
  const schedule = parseSchedule(draft.schedule);
  const diff = draftDiff(draft, original === null ? null : draftFromAutomation(original));
  const id = original === null ? null : original.id;

  return {
    title: original === null ? 'Nueva automatización' : 'Editar automatización',
    meta:
      original === null
        ? 'Se guarda en tu PC'
        : `${original.name} · se guarda en tu PC`,
    name: { value: draft.name, error: validation.errors.name },
    schedule: {
      value: draft.schedule,
      label: schedule.label,
      recognized: schedule.known,
      error: validation.errors.schedule,
    },
    steps: {
      values: draft.steps,
      error: validation.errors.steps,
      canRemove: normalized.steps.length > 1,
    },
    stepsHint:
      original !== null && !original.stepsKnown && normalized.steps.length === 0
        ? 'La PC no informó los pasos de esta automatización.'
        : null,
    dirty: diff.dirty,
    changed: diff.changed,
    canSave: validation.valid && diff.dirty && online,
    saveBlockedCopy: online ? null : 'Requiere conexión',
    saveLabel: original === null ? 'Guardar' : 'Guardar cambios',
    save: saveIntent(draft, id),
    discardPrompt: DISCARD_PROMPT,
    discardConfirm: 'Descartar',
    discardCancel: 'Seguir editando',
  };
}
