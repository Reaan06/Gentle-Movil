/**
 * V7 — Terminal / control logic (artboard
 * `design/mobile-app-core/03-terminal-control.html`, `docs/mobile-views-plan.md`
 * §V7).
 *
 * Everything here is pure or injected: no React Native import, no device, no
 * network of its own. `mobile/app/terminal-control.tsx` is the rendering shell
 * and `mobile/test/terminal.test.mjs` pins these rules with a fake channel that
 * speaks the real HTTP/1.1 wire format:
 *
 * - the command history ring (`{id, command, at, status, exitCode, output}`,
 *   newest N kept, append/clear);
 * - the send descriptor: trimmed, empty rejected, always `pending: true` on
 *   `POST /api/exec` with the honest note that the endpoint is not served yet;
 * - the output model: raw stream chunks appended in order, ANSI escapes
 *   stripped for display with the newlines intact, and a real `truncado`
 *   marker instead of a silent cut;
 * - the exit-code copy: `0` ok, non-zero danger with the code, `null` neutral;
 * - one honest state per outcome, mirroring `lib/git.ts`:
 *   `loading | empty | success | stale | offline | error`.
 *
 * ## The endpoint this module expects (protocol §4)
 *
 * `loadHistory` performs `GET /api/exec/history` over the tunnel channel and
 * expects this body (the endpoint is a bridge extension of protocol §4; the
 * core only guarantees the tunnel and `/api/health` / `/api/sessions` today):
 *
 * ```json
 * {
 *   "commands": [
 *     { "id": "cmd-1", "command": "bun test", "at": "2026-11-18T14:32:00.000Z",
 *       "status": "sent", "exitCode": 1, "output": "\u001b[31mfail\u001b[0m\n" }
 *   ]
 * }
 * ```
 *
 * `status` is `pending | sent | failed`; `exitCode` is `null` or an integer;
 * `output` is `null` or the raw stream the command produced (escapes and all);
 * `at` is ISO-8601 or epoch milliseconds.
 *
 * ## What the PC does NOT serve yet
 *
 * There is no command endpoint: `POST /api/exec` does not exist. A command the
 * human typed is therefore recorded as `no enviado` with the reason, never
 * echoed as fake output and never reported as executed. `sendIntent` is the
 * descriptor of that gap, so the screen can log the route and show the note
 * instead of inventing an `OK` line.
 *
 * Honesty rules (S7), the same the other connected screens follow:
 * - no tunnel → `offline` (`Requiere conexión — el terminal corre en tu PC.`),
 *   never an empty success;
 * - an extension that does not expose the endpoint (404/501) → `error` with
 *   `La extensión no expone el terminal todavía`, never an empty history;
 * - incomplete/invalid entries → `error` carrying the raw evidence, never
 *   invented commands, exit codes or output;
 * - a timeout with a previous good answer → `stale` (`Datos de hace N min`);
 * - an empty `commands` array is the `empty` state
 *   (`Todavía no hay comandos en esta sesión.`), never success with zeros.
 *
 * Every failure is logged through the injectable `failure(step, error, raw)`
 * seam (`logger.tag('terminal')` in the app) with `{step, error, raw}`.
 */

import { type BridgeFailure, type TunnelChannel, bridgeRequest } from './bridge.ts';
import { logger } from './logger.ts';

/* ------------------------------------------------------------------ *
 * Wire model (§V7 payload)
 * ------------------------------------------------------------------ */

/** Endpoint expected from the bridge for the PC-side command history. */
export const EXEC_HISTORY_PATH = '/api/exec/history';

/** Endpoint a command would be posted to once the bridge serves it. */
export const EXEC_PATH = '/api/exec';

/** How many commands the local ring keeps (newest N). */
export const HISTORY_CAPACITY = 20;

/** How much of one command's output the pane renders before truncating. */
export const OUTPUT_DISPLAY_CAP = 4_000;

/** Default deadline of one history fetch, matching the other bridge calls. */
export const HISTORY_TIMEOUT_MS = 8_000;

/** Status of one command, as the phone or the PC knows it. */
export type CommandStatus = 'pending' | 'sent' | 'failed';

/** One command in the history ring. */
export interface CommandEntry {
  id: string;
  /** The command line, already trimmed. */
  command: string;
  /** Epoch milliseconds the command was typed / the PC ran it. */
  at: number;
  status: CommandStatus;
  /** Process exit code, `null` while it never ran or the PC omitted it. */
  exitCode: number | null;
  /** Raw stream output (escapes included), `null` when there was none. */
  output: string | null;
}

/** Status copy of a row inside the PC history. */
export const STATUS_LABELS: Record<CommandStatus, string> = {
  pending: 'en cola',
  sent: 'enviado',
  failed: 'falló',
};

/** Status copy of a command typed here that the PC never received. */
export const NOT_SENT_LABEL = 'no enviado';

/** Copy of an empty history (§V7 `empty`). */
export const EMPTY_COPY = 'Todavía no hay comandos en esta sesión.';

/** Copy of the empty output pane. */
export const PANE_EMPTY_COPY = 'Esperando la primera salida…';

/** Copy when the tunnel is down (§V7 offline). */
export const OFFLINE_COPY = 'Requiere conexión — el terminal corre en tu PC.';

/** Copy of the reconnect hint next to `OFFLINE_COPY`. */
export const RECONNECTING_COPY = 'Reconectando…';

/** Copy when the extension does not serve the endpoint yet. */
export const MISSING_ENDPOINT_COPY = 'La extensión no expone el terminal todavía';

/** Copy of the error card title (§V7 `error`). */
export const ERROR_TITLE = 'No pudimos leer el historial';

/** Copy of an unusable `/api/exec/history` body. */
export const INCOMPLETE_HISTORY_COPY = 'La PC devolvió un historial incompleto.';

/** Why a typed command never left the phone. */
export const NOT_SENT_REASON =
  'no enviado: la extensión todavía no expone POST /api/exec.';

/** Honest note of the send button (the endpoint does not exist yet). */
export const SEND_PENDING_NOTE =
  'Enviar todavía no está conectado: la extensión no expone POST /api/exec. El comando queda como no enviado.';

/** Copy when the human taps send with an empty field. */
export const EMPTY_COMMAND_COPY = 'Escribí un comando antes de enviarlo.';

/** Honest note of the clear action (it only clears the phone's view). */
export const CLEAR_NOTE = 'Limpiar borra lo que ves en el teléfono; el historial de la PC no se toca.';

/** Label of the send button. */
export const SEND_LABEL = 'Enviar';

/** Label of the clear action. */
export const CLEAR_LABEL = 'Limpiar';

/* ------------------------------------------------------------------ *
 * Command history ring
 * ------------------------------------------------------------------ */

/** What `append` accepts: a command plus whatever the caller already knows. */
export interface NewCommand {
  command: string;
  status?: CommandStatus;
  exitCode?: number | null;
  output?: string | null;
  /** Epoch ms; defaults to the injected clock. */
  at?: number;
  id?: string;
}

/** Keep at most `capacity` of the newest entries (the input is never mutated). */
export function capHistory<T>(entries: readonly T[], capacity: number = HISTORY_CAPACITY): T[] {
  if (capacity <= 0) {
    return [];
  }
  if (entries.length <= capacity) {
    return [...entries];
  }
  return entries.slice(entries.length - capacity);
}

/**
 * The local command history: a capped ring, oldest first, with append/clear.
 * It holds what the human typed here — a command stays `pending` until the PC
 * says otherwise, which today never happens (there is no `/api/exec`).
 */
export class CommandHistory {
  private list: CommandEntry[] = [];
  private sequence = 0;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(capacity: number = HISTORY_CAPACITY, now: () => number = Date.now) {
    this.capacity = capacity;
    this.now = now;
  }

  /** Append one command, trimming it and dropping the oldest when full. */
  append(input: NewCommand): CommandEntry {
    this.sequence += 1;
    const at = typeof input.at === 'number' ? input.at : this.now();
    const entry: CommandEntry = {
      id: input.id ?? `cmd-${at}-${this.sequence}`,
      command: input.command.trim(),
      at,
      status: input.status ?? 'pending',
      exitCode: input.exitCode ?? null,
      output: input.output ?? null,
    };
    this.list = capHistory([...this.list, entry], this.capacity);
    return this.list[this.list.length - 1];
  }

  /** Snapshot, oldest first (a caller can never mutate the ring). */
  entries(): CommandEntry[] {
    return [...this.list];
  }

  /** Empty the ring. Ids keep advancing so no row key is reused. */
  clear(): void {
    this.list = [];
  }

  size(): number {
    return this.list.length;
  }
}

/* ------------------------------------------------------------------ *
 * Send descriptor
 * ------------------------------------------------------------------ */

/** What tapping send means today: a real request to an endpoint that is absent. */
export interface SendDescriptor {
  /** Always true: nothing is: there is no `/api/exec` on the bridge yet. */
  pending: true;
  method: 'POST';
  /** `/api/exec` — the route the command would be posted to. */
  route: string;
  /** The trimmed command. */
  command: string;
  /** Honest note the screen shows instead of a fake acknowledgement. */
  note: string;
}

/** Outcome of a send attempt: the descriptor, or why there is nothing to send. */
export type SendIntentResult =
  | { ok: true; intent: SendDescriptor }
  | { ok: false; reason: 'empty'; message: string };

/**
 * Build the send descriptor of a typed command. An empty or whitespace-only
 * field is refused with `EMPTY_COMMAND_COPY`; anything that is not a string is
 * treated as empty instead of throwing at the UI.
 */
export function sendIntent(command: unknown): SendIntentResult {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (trimmed === '') {
    return { ok: false, reason: 'empty', message: EMPTY_COMMAND_COPY };
  }
  return {
    ok: true,
    intent: {
      pending: true,
      method: 'POST',
      route: EXEC_PATH,
      command: trimmed,
      note: SEND_PENDING_NOTE,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Output model (raw chunks → display)
 * ------------------------------------------------------------------ */

/** OSC sequences (window title, hyperlinks): ESC ] … BEL or ESC \. */
const OSC_ESCAPE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** CSI sequences (colours, cursor moves, erases): ESC [ params final. */
const CSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Charset selection: ESC ( B, ESC # 8, … */
const CHARSET_ESCAPE = /\u001b[()#][0-9A-Za-z]/g;
/** Remaining two-byte escapes: ESC =, ESC >, ESC M, … */
const TWO_BYTE_ESCAPE = /\u001b[@-Z\\-_]/g;
/** Stray C0 controls that are not a newline or a tab. */
const STRAY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip ANSI escapes for display, keeping every visible character and every
 * newline. A CRLF becomes one newline; a lone CR (progress overwrite) becomes a
 * newline too, so no step of the stream is lost instead of being concatenated.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC_ESCAPE, '')
    .replace(CSI_ESCAPE, '')
    .replace(CHARSET_ESCAPE, '')
    .replace(TWO_BYTE_ESCAPE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(STRAY_CONTROL, '');
}

/** Append one raw stream chunk in order (escapes stay until display time). */
export function appendOutput(current: string | null, chunk: string | null): string {
  return `${current ?? ''}${chunk ?? ''}`;
}

/** The real marker that replaces a silent cut. */
export function truncationMarker(hidden: number): string {
  const noun = hidden === 1 ? 'carácter oculto' : 'caracteres ocultos';
  return `… [truncado: ${hidden} ${noun}]`;
}

/** Display-ready output: escapes stripped, truncation marked. */
export interface OutputView {
  text: string;
  truncated: boolean;
  /** Characters hidden behind the marker (0 when nothing was cut). */
  hidden: number;
}

/**
 * Display form of one raw output. `null` stays `null` (there was no output at
 * all, which is not the same as an empty one). Over the cap, the head is kept
 * and a real marker names how much was hidden.
 */
export function renderOutput(
  raw: string | null,
  cap: number = OUTPUT_DISPLAY_CAP,
): OutputView | null {
  if (raw === null) {
    return null;
  }
  const display = stripAnsi(raw);
  if (display.length <= cap) {
    return { text: display, truncated: false, hidden: 0 };
  }
  const hidden = display.length - cap;
  return {
    text: `${display.slice(0, cap)}\n${truncationMarker(hidden)}`,
    truncated: true,
    hidden,
  };
}

/* ------------------------------------------------------------------ *
 * Exit-code copy
 * ------------------------------------------------------------------ */

/** Chip tones the screen knows how to paint. */
export type ExitTone = 'ok' | 'danger' | 'neutral';

/** One exit-code chip: `exit 0` / `exit 130` / `sin código`. */
export interface ExitChip {
  label: string;
  tone: ExitTone;
}

/** `0` ok, non-zero danger with the code, `null` neutral (never invented). */
export function exitChip(exitCode: number | null): ExitChip {
  if (exitCode === null) {
    return { label: 'sin código', tone: 'neutral' };
  }
  return { label: `exit ${exitCode}`, tone: exitCode === 0 ? 'ok' : 'danger' };
}

/* ------------------------------------------------------------------ *
 * Payload validation
 * ------------------------------------------------------------------ */

/** Parse outcome: the real entries, or why the body is not usable. */
export type ParseResult =
  | { ok: true; entries: CommandEntry[] }
  | { ok: false; message: string; raw: string | null };

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

function isKnownStatus(value: unknown): value is CommandStatus {
  return value === 'pending' || value === 'sent' || value === 'failed';
}

/** ISO-8601 or epoch milliseconds → epoch ms, `null` when unusable. */
function parseAt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** One raw entry → a `CommandEntry`, or null when it is not usable. */
function parseEntry(entry: unknown): CommandEntry | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') {
    return null;
  }
  if (typeof record.command !== 'string' || record.command.trim() === '') {
    return null;
  }
  const at = parseAt(record.at);
  if (at === null) {
    return null;
  }
  if (!isKnownStatus(record.status)) {
    return null;
  }
  const exitCode = record.exitCode;
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
    return null;
  }
  const output = record.output;
  if (output !== null && typeof output !== 'string') {
    return null;
  }
  return {
    id: record.id,
    command: record.command.trim(),
    at,
    status: record.status,
    exitCode: exitCode as number | null,
    output: output as string | null,
  };
}

/**
 * Validate the §V7 body. Anything else is refused with the raw evidence of the
 * offending value: a half-understood payload must never become history, because
 * a row here claims "this is what ran on your PC".
 */
export function parseHistory(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: INCOMPLETE_HISTORY_COPY, raw: rawPrefix(body) };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.commands)) {
    return { ok: false, message: INCOMPLETE_HISTORY_COPY, raw: rawPrefix(body) };
  }
  const entries: CommandEntry[] = [];
  for (const raw of record.commands) {
    const parsed = parseEntry(raw);
    if (parsed === null) {
      return { ok: false, message: INCOMPLETE_HISTORY_COPY, raw: rawPrefix(raw) };
    }
    entries.push(parsed);
  }
  return { ok: true, entries };
}

/* ------------------------------------------------------------------ *
 * Honest states
 * ------------------------------------------------------------------ */

/** The §V7 states table, logic level. */
export type HistoryState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; entries: CommandEntry[] }
  | { kind: 'stale'; minutes: number; entries: CommandEntry[] }
  | { kind: 'offline'; entries: CommandEntry[] | null; minutes: number | null }
  | { kind: 'error'; message: string; raw: string | null };

/**
 * Last good `/api/exec/history` answer, so a later timeout can show the cached
 * rows with the honest age instead of inventing output or pretending the
 * session is empty.
 */
export class HistoryCache {
  private entries: CommandEntry[] | null = null;
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "the PC answered this history, now". */
  mark(entries: readonly CommandEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.at = this.now();
  }

  /** Cached entries + minutes since they arrived, or null when never answered. */
  snapshot(): { entries: CommandEntry[]; minutes: number } | null {
    if (this.at === 0 || this.entries === null) {
      return null;
    }
    const minutes = Math.max(1, Math.floor((this.now() - this.at) / 60_000));
    return { entries: this.entries, minutes };
  }

  /** Drops the cache: an empty history is truth, not something to fall back to. */
  clear(): void {
    this.entries = null;
    this.at = 0;
  }
}

/** Failure sink this module needs (`logger.tag('terminal')` satisfies it). */
export interface TerminalLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
}

/** Injectable dependencies (cache, logger, deadline). */
export interface LoadHistoryDeps {
  /** Cache of the last good answer (stale/offline rows). */
  cache?: HistoryCache;
  /** Failure sink; defaults to `logger.tag('terminal')`. */
  logger?: TerminalLogger;
  /** Deadline of the `/api/exec/history` call (default `HISTORY_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** Default failure sink for the app (one tag, one ring buffer, one log file). */
export const terminalLog: TerminalLogger = logger.tag('terminal');

/** Raw evidence of a failure, always something the log can keep. */
function rawOf(failure: BridgeFailure): string {
  return failure.raw ?? failure.kind;
}

/**
 * One failed bridge call → the §V7 state it deserves. Mirrors
 * `stateFromFailure` of `lib/git.ts`:
 *
 * - `offline` → offline, with the cached rows when there are any;
 * - `timeout` → stale when something was cached, offline when nothing was;
 * - `bad-response` / `protocol-status` → error carrying message + raw.
 */
export function stateFromFailure(
  failure: BridgeFailure,
  cache: HistoryCache | null = null,
): HistoryState {
  const cached = cache?.snapshot() ?? null;
  switch (failure.kind) {
    case 'offline':
      return {
        kind: 'offline',
        entries: cached?.entries ?? null,
        minutes: cached?.minutes ?? null,
      };
    case 'timeout':
      return cached === null
        ? { kind: 'offline', entries: null, minutes: null }
        : { kind: 'stale', minutes: cached.minutes, entries: cached.entries };
    default:
      return { kind: 'error', message: failure.message, raw: failure.raw };
  }
}

/**
 * Fetch `GET /api/exec/history` over the tunnel channel and return the §V7
 * state. A null channel means the app has no tunnel (never opened or closed),
 * which is `offline` — the screen says so instead of showing an empty session.
 *
 * Never throws and never invents: every failure is the matching §V7 state.
 */
export async function loadHistory(
  channel: TunnelChannel | null,
  deps: LoadHistoryDeps = {},
): Promise<HistoryState> {
  const log = deps.logger ?? terminalLog;
  const cache = deps.cache ?? null;

  if (channel === null) {
    log.failure('tunnel', new Error('Sin túnel abierto hacia la PC.'), null);
    return stateFromFailure(
      { kind: 'offline', message: 'Sin túnel hacia la PC.', raw: null, error: null },
      cache,
    );
  }

  const result = await bridgeRequest<unknown>(channel, EXEC_HISTORY_PATH, {
    timeoutMs: deps.timeoutMs ?? HISTORY_TIMEOUT_MS,
  });
  if (!result.ok) {
    log.failure(
      'exec-history-request',
      result.failure.error ?? new Error(result.failure.message),
      rawOf(result.failure),
    );
    return stateFromFailure(result.failure, cache);
  }

  if (result.status < 200 || result.status >= 300) {
    // The bridge answered, but not with a history. A missing endpoint is the
    // expected state today (protocol §4 has no exec surface yet): it must read
    // as "this is not available", never as "nothing ran yet".
    const missing = result.status === 404 || result.status === 501;
    const message = missing ? MISSING_ENDPOINT_COPY : `La PC respondió ${result.status}.`;
    const raw = `status=${result.status} ${EXEC_HISTORY_PATH}`;
    log.failure('exec-history-request', new Error(message), raw);
    return { kind: 'error', message, raw };
  }

  const parsed = parseHistory(result.body);
  if (!parsed.ok) {
    log.failure('exec-history-parse', new Error(parsed.message), parsed.raw);
    return { kind: 'error', message: parsed.message, raw: parsed.raw };
  }

  if (parsed.entries.length === 0) {
    // A real empty session: nothing on screen, no zeros pretending to be data
    // and no cache to fall back to on the next timeout.
    cache?.clear();
    return { kind: 'empty' };
  }

  cache?.mark(parsed.entries);
  return { kind: 'success', entries: parsed.entries };
}

/* ------------------------------------------------------------------ *
 * Render model
 * ------------------------------------------------------------------ */

/** One history row the screen paints (PC truth or a typed, unsent command). */
export interface HistoryRow {
  id: string;
  command: string;
  /** `14:32` local time of the entry. */
  atLabel: string;
  status: CommandStatus;
  /** `enviado` / `en cola` / `falló` / `no enviado`. */
  statusLabel: string;
  /** True only for a command typed here that the PC never received. */
  notSent: boolean;
  /** Why it was not sent, `NOT_SENT_REASON`; null for PC entries. */
  reason: string | null;
  exit: ExitChip;
  /** Display-ready output, `null` when the command produced none. */
  output: OutputView | null;
}

/** The output pane: the newest command that actually produced output. */
export interface PaneView {
  command: string;
  exit: ExitChip;
  output: OutputView;
}

/** What `terminal-control.tsx` renders, per §V7 states. */
export interface TerminalViewModel {
  state: 'loading' | 'empty' | 'success' | 'stale' | 'offline' | 'error';
  /** PC history, oldest first. */
  rows: HistoryRow[];
  /** Commands typed here that never ran: always `no enviado`, never faked. */
  notSent: HistoryRow[];
  /** Newest output in the pane, null when nothing produced output yet. */
  pane: PaneView | null;
  /** `Esperando la primera salida…` while the pane has nothing to show. */
  paneEmpty: string | null;
  /** Amber chip over cached rows (`Datos de hace N min` / `Última vez hace N min`). */
  staleChip: string | null;
  /** Offline banner copy (`Requiere conexión — el terminal corre en tu PC.`). */
  banner: string | null;
  /** Reconnect hint next to the offline banner (`Reconectando…`). */
  bannerHint: string | null;
  /** Error card copy + raw evidence (`No pudimos leer el historial`). */
  error: { title: string; message: string; raw: string | null } | null;
  /** `Todavía no hay comandos en esta sesión.` only for a real empty history. */
  emptyMessage: string | null;
  /** Rows read from the cache (offline/stale): muted, status frozen. */
  frozen: boolean;
  /** Skeleton rows are showing (pull-to-refresh keeps the rows). */
  loading: boolean;
  /** Input enabled: sending needs the PC (offline/error are read-only). */
  canSend: boolean;
}

/** `14:32` for an epoch stamp (local time, `--:--` when unusable). */
export function timeLabel(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** One PC entry → one row. */
export function historyRow(entry: CommandEntry): HistoryRow {
  return {
    id: entry.id,
    command: entry.command,
    atLabel: timeLabel(entry.at),
    status: entry.status,
    statusLabel: STATUS_LABELS[entry.status],
    notSent: false,
    reason: null,
    exit: exitChip(entry.exitCode),
    output: renderOutput(entry.output),
  };
}

/** One typed, never-sent command → one `no enviado` row. */
export function notSentRow(entry: CommandEntry): HistoryRow {
  return {
    id: entry.id,
    command: entry.command,
    atLabel: timeLabel(entry.at),
    status: 'pending',
    statusLabel: NOT_SENT_LABEL,
    notSent: true,
    reason: NOT_SENT_REASON,
    exit: exitChip(null),
    output: null,
  };
}

/** Newest row that produced output, for the pane. */
function paneOf(rows: readonly HistoryRow[]): PaneView | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.output !== null) {
      return { command: row.command, exit: row.exit, output: row.output };
    }
  }
  return null;
}

/**
 * Build the render model from a §V7 state plus the commands typed here that
 * never ran. Those are appended as `no enviado` rows in every state (they are
 * local truth, not PC truth) and never merged into the PC history.
 */
export function buildTerminalView(
  state: HistoryState,
  local: readonly CommandEntry[] = [],
): TerminalViewModel {
  const notSent = local
    .filter((entry) => entry.status === 'pending')
    .map((entry) => notSentRow(entry));

  const base: Omit<TerminalViewModel, 'state'> = {
    rows: [],
    notSent,
    pane: null,
    paneEmpty: null,
    staleChip: null,
    banner: null,
    bannerHint: null,
    error: null,
    emptyMessage: null,
    frozen: false,
    loading: false,
    canSend: false,
  };

  /** Shared projection of a history that may be live or cached. */
  const projection = (entries: readonly CommandEntry[], frozen: boolean) => {
    const rows = entries.map(historyRow);
    return { rows, pane: paneOf(rows), frozen };
  };

  switch (state.kind) {
    case 'loading':
      return { ...base, state: 'loading', loading: true };
    case 'empty':
      return {
        ...base,
        state: 'empty',
        emptyMessage: EMPTY_COPY,
        paneEmpty: PANE_EMPTY_COPY,
        canSend: true,
      };
    case 'error':
      return {
        ...base,
        state: 'error',
        error: { title: ERROR_TITLE, message: state.message, raw: state.raw },
      };
    case 'success': {
      const projected = projection(state.entries, false);
      return {
        ...base,
        state: 'success',
        ...projected,
        paneEmpty: projected.pane === null ? PANE_EMPTY_COPY : null,
        canSend: true,
      };
    }
    case 'stale': {
      const projected = projection(state.entries, true);
      return {
        ...base,
        state: 'stale',
        ...projected,
        paneEmpty: projected.pane === null ? PANE_EMPTY_COPY : null,
        staleChip: `Datos de hace ${state.minutes} min`,
        canSend: true,
      };
    }
    case 'offline': {
      if (state.entries === null) {
        // Nothing cached: only the honest offline notice, no invented rows.
        return {
          ...base,
          state: 'offline',
          banner: OFFLINE_COPY,
          bannerHint: RECONNECTING_COPY,
        };
      }
      const projected = projection(state.entries, true);
      const minutes = state.minutes;
      return {
        ...base,
        state: 'offline',
        ...projected,
        paneEmpty: projected.pane === null ? PANE_EMPTY_COPY : null,
        staleChip: minutes === null ? null : `Última vez hace ${minutes} min`,
        banner: OFFLINE_COPY,
        bannerHint: RECONNECTING_COPY,
      };
    }
  }
}
