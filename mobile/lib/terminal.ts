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
 * - the send: `POST /api/exec` over the tunnel (protocol §4.1), trimmed, empty
 *   rejected before the wire, the real `exitCode`/`output` appended to the ring
 *   on 200, and one honest copy per refusal (`exec_disabled`,
 *   `shell_unsupported`, `invalid_command`, `payload_too_large`,
 *   `command_spawn_failed`) or link failure (offline, timeout);
 * - the output model: raw stream chunks appended in order, ANSI escapes
 *   stripped for display with the newlines intact, and a real `truncado`
 *   marker instead of a silent cut;
 * - the exit-code copy: `0` ok, non-zero danger with the code, `null` neutral;
 * - one honest state per outcome, mirroring `lib/git.ts`:
 *   `loading | empty | success | stale | offline | error`;
 * - the session transcript (T7n): ordered events derived ONLY from the real
 *   history entries and their real `at` stamps, a `running | ended | idle`
 *   state derived from that same evidence, and the agent header
 *   (`pi · <model>`) which is only ever named from the payload.
 *
 * ## What the transcript may and may not say
 *
 * The bridge serves `GET /api/exec/history` and `POST /api/exec` (protocol
 * §4.1) and **no agent-stream endpoint**: there is no frame, event or route
 * that says "the agent is thinking", "the agent is waiting for you" or "the
 * agent said this". Therefore:
 *
 * - `waiting` is not a state this module can produce. `TRANSCRIPT_STATES` is
 *   `running | ended | idle` and nothing else: a `pending` history entry is
 *   `running` (with its real elapsed time), a `sent`/`failed` newest entry is
 *   `ended` (with its exit chip), no entry is `idle`;
 * - every transcript carries `AGENT_NOTE` (`sin eventos del agente`) plus
 *   `NO_AGENT_REASON`, the honest reason: the agent conversation belongs to
 *   the sessions surface (V9), not to this one;
 * - the header stays `shell` unless the payload carried a real model name, in
 *   which case it reads `pi · <model>`.
 *
 * Everything else — a `waiting` card, thinking blocks, tool calls, approvals —
 * needs data the PC does not publish today and is NOT invented here.
 *
 * ## The endpoints this module uses (protocol §4.1)
 *
 * `loadHistory` performs `GET /api/exec/history` and `sendIntent` performs
 * `POST /api/exec` over the tunnel channel, both served by the Pi extension
 * (`pi-extension/src/exec.ts`). The history body is:
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
 * `at` is ISO-8601 or epoch milliseconds. An optional top-level `model`
 * (string) is read leniently: when it is absent the pane header stays `shell`.
 *
 * ## What `POST /api/exec` answers
 *
 * `200 {id, exitCode, output}` when the extension runs with
 * `GENTLE_MOVIL_ALLOW_EXEC=1`: the command really ran, and its real exit code
 * (non-zero included) and raw output are what the ring keeps. Without the
 * opt-in the PC refuses with `403 exec_disabled` and **nothing runs**, which
 * this module maps to its own copy (and a `No se ejecutó nada.` note), never to a
 * silent success. `400 shell_unsupported` (the bridge spawns an argv, never a
 * shell), `400 invalid_command`, `400 invalid_body`, `413 payload_too_large` and
 * `502 command_spawn_failed` each keep their own honest copy; offline and
 * timeout stay link failures, blamed on the phone/network, not on the PC.
 *
 * Honesty rules (S7), the same the other connected screens follow:
 * - no tunnel → `offline` (`Requiere conexión — el terminal corre en tu PC.`),
 *   never an empty success;
 * - an extension that does not expose `/api/exec/history` (404/501) → `error`
 *   with `La extensión no expone el terminal todavía`, never an empty history;
 * - a send the PC refused keeps the PC's own copy and never a ring entry, so no
 *   row claims a command ran when nothing did;
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

/** Endpoint that runs one command on the PC (protocol §4.1, opt-in only). */
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
  /** Why it never ran, when the PC refused it; `null` for a PC history row. */
  reason?: string | null;
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

/** Copy of the pane when the command really ran and printed nothing. */
export const PANE_NO_OUTPUT_COPY = 'El comando no produjo salida.';

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

/** Why a command the phone typed never left it (per-entry reason). */
export const NOT_SENT_REASON =
  'no enviado: el comando quedó en el teléfono y la PC no confirmó que corrió.';

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
  /** Why it did not run, when the human should read it (`no enviado` rows). */
  reason?: string | null;
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
 * It holds what the human typed here. The PC is the only thing that can turn a
 * command into `sent`: `sendIntent` appends the entry only after a real 200
 * `POST /api/exec`, with the real exit code and output.
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
      reason: input.reason ?? null,
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
 * Send — POST /api/exec (protocol §4.1)
 * ------------------------------------------------------------------ */

/**
 * Deadline of one send. The PC kills a command at 30 s and then answers, so the
 * phone waits a little longer instead of calling a real run a timeout.
 */
export const SEND_TIMEOUT_MS = 35_000;

/** Progress copy of the dock while the request is in flight. */
export const SENDING_COPY = 'Enviando…';

/** Manyana copy: the PC ran nothing because it refused the command. */
export const EXEC_DISABLED_COPY =
  'Enviar está desactivado en tu PC: la extensión necesita GENTLE_MOVIL_ALLOW_EXEC=1.';

/** Second line of the `exec_disabled` card: nothing ran. */
export const EXEC_DISABLED_NOTE =
  'No se ejecutó nada: la PC rechazó el comando antes de correrlo.';

/** Copy when the command line needs a shell the bridge will never spawn. */
export const SHELL_UNSUPPORTED_COPY =
  'La PC no corre un shell: no se soportan pipes, redirecciones, globs ni variables ($VAR, `cmd`). Escribí el comando con sus argumentos.';

/** Copy for a command the PC read as empty or too long. */
export const INVALID_COMMAND_COPY =
  'La PC rechazó el comando: está vacío o pasa los 4096 bytes.';

/** Copy for a body the PC could not read as `{"command": "…"}`. */
export const INVALID_BODY_COPY =
  'La PC no entendió el pedido: el cuerpo tiene que ser {"command": "…"}.';

/** Copy for a body over the 16 KiB the bridge accepts. */
export const PAYLOAD_TOO_LARGE_COPY =
  'El pedido superó los 16 KiB que acepta la PC: no se ejecutó nada.';

/** Copy when the process never started (missing binary, permissions). */
export const COMMAND_SPAWN_FAILED_COPY =
  'La PC no pudo arrancar el comando: el binario no existe o no tiene permiso.';

/** Copy for any other refusal the PC answered with. */
export function sendRejectedCopy(status: number): string {
  return `La PC rechazó el comando (status ${status}).`;
}

/** Copy when the extension does not serve `POST /api/exec`. */
export function execUnavailableCopy(status: number): string {
  return `La extensión no expone POST /api/exec (status ${status}).`;
}

/** Second line of every refusal: the command did not run. */
export const NOTHING_RAN_NOTE = 'No se ejecutó nada.';

/** Copy when there is no tunnel: the command never left the phone. */
export const SEND_OFFLINE_COPY =
  'Sin conexión con la PC: el comando no salió del teléfono.';

/** Copy when the PC did not answer in time: the result is unknown, not failed. */
export const SEND_TIMEOUT_COPY =
  'La PC no respondió a tiempo: el comando pudo haber corrido, revisá el historial.';

/** Copy when the answer cannot be read: nothing can be claimed about the run. */
export const SEND_BROKEN_COPY =
  'La PC devolvió una respuesta rota: no podemos afirmar que el comando corrió.';

/** Second line of the broken case: the history is the only truth left. */
export const SEND_BROKEN_NOTE = 'No sabemos si el comando corrió: revisá el historial.';

/** Card title when the PC refused the command (not the phone's fault). */
export const SEND_REFUSED_TITLE = 'La PC rechazó el comando';

/** Card title when the phone could not get an answer (link failure). */
export const SEND_UNREACHABLE_TITLE = 'No pudimos enviar el comando';

/** Who refused: the PC said no, or the request never got an answer. */
export type SendBlame = 'pc' | 'link';

/** Why a send produced no real result. */
export type SendFailureReason =
  | 'exec_disabled'
  | 'shell_unsupported'
  | 'invalid_command'
  | 'invalid_body'
  | 'payload_too_large'
  | 'command_spawn_failed'
  | 'rejected'
  | 'offline'
  | 'timeout'
  | 'broken';

/** A real refusal or a link failure: the command did not come back with a result. */
export interface SendFailure {
  ok: false;
  reason: SendFailureReason;
  /** Card title: `La PC rechazó el comando` / `No pudimos enviar el comando`. */
  title: string;
  /** `pc` when the PC answered with a refusal, `link` when it never answered. */
  blame: SendBlame;
  /** Honest copy (es-AR) of this exact failure. */
  message: string;
  /** Extra line the card shows (`No se ejecutó nada.`), `null` when unused. */
  note: string | null;
  /** Raw evidence for the log (`status=403 code=exec_disabled …`). */
  raw: string | null;
  /** HTTP status the PC answered with, `null` when there was no answer. */
  status: number | null;
}

/** What a send attempt produced: the real entry, or why there is none. */
export type SendResult =
  | {
      ok: true;
      /** Ring entry the PC's real exit code and output produced (`sent`). */
      entry: CommandEntry;
      /** Exit chip of that real code. */
      exit: ExitChip;
      /** Display-ready output (`null` when the command produced none). */
      output: OutputView | null;
    }
  | SendFailure
  | { ok: false; reason: 'empty'; message: string };

/** Injectable dependencies of one send. */
export interface SendDeps {
  /** Tunnel channel to the PC; `null`/absent means there is no tunnel. */
  channel?: TunnelChannel | null;
  /** Ring that keeps the entry the PC really ran (status `sent`). */
  history?: CommandHistory | null;
  /** Failure sink; defaults to `logger.tag('terminal')`. */
  logger?: TerminalLogger;
  /** Deadline of the call (default `SEND_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** 200 body of `POST /api/exec`: `{id, exitCode, output}` (protocol §4.1). */
interface ExecAnswer {
  id: string | null;
  exitCode: number | null;
  output: string | null;
}

/**
 * Validate the §4.1 200 body. `exitCode` must be an integer or `null` and
 * `output` a string or `null`; anything else is unusable, because a fabricated
 * exit code would claim a result the PC never sent.
 */
function parseExecAnswer(body: unknown): ExecAnswer | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const exitCode = record.exitCode;
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
    return null;
  }
  const output = record.output;
  if (output !== null && typeof output !== 'string') {
    return null;
  }
  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : null,
    exitCode: exitCode as number | null,
    output: output as string | null,
  };
}

/** `{error:{code,message}}` of a §4.1 refusal, read leniently. */
function execError(body: unknown): { code: string | null; message: string | null } {
  if (typeof body !== 'object' || body === null) {
    return { code: null, message: null };
  }
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) {
    return { code: null, message: null };
  }
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' && record.code !== '' ? record.code : null,
    message: typeof record.message === 'string' && record.message !== '' ? record.message : null,
  };
}

/**
 * One refused status → its own honest failure. Mirrors `stateFromFailure` of
 * `lib/git.ts`: every code the PC can answer with keeps its own copy, and an
 * unknown one is still a real refusal with its status, never a success.
 */
function refusal(status: number, body: unknown): SendFailure {
  const { code, message } = execError(body);
  const raw = `status=${status} code=${code ?? 'sin código'} ${
    message === null ? 'sin mensaje' : message.slice(0, 80)
  }`;
  const shared = { ok: false as const, blame: 'pc' as const, title: SEND_REFUSED_TITLE, raw, status };

  if (code === 'exec_disabled' || (code === null && status === 403)) {
    return {
      ...shared,
      reason: 'exec_disabled',
      message: EXEC_DISABLED_COPY,
      note: EXEC_DISABLED_NOTE,
    };
  }
  if (code === 'shell_unsupported') {
    return {
      ...shared,
      reason: 'shell_unsupported',
      message: SHELL_UNSUPPORTED_COPY,
      note: NOTHING_RAN_NOTE,
    };
  }
  if (code === 'invalid_command') {
    return {
      ...shared,
      reason: 'invalid_command',
      message: INVALID_COMMAND_COPY,
      note: NOTHING_RAN_NOTE,
    };
  }
  if (code === 'invalid_body' || code === 'invalid_json') {
    return { ...shared, reason: 'invalid_body', message: INVALID_BODY_COPY, note: NOTHING_RAN_NOTE };
  }
  if (code === 'payload_too_large' || status === 413) {
    return {
      ...shared,
      reason: 'payload_too_large',
      message: PAYLOAD_TOO_LARGE_COPY,
      note: NOTHING_RAN_NOTE,
    };
  }
  if (code === 'command_spawn_failed' || status === 502) {
    return {
      ...shared,
      reason: 'command_spawn_failed',
      message: COMMAND_SPAWN_FAILED_COPY,
      note: NOTHING_RAN_NOTE,
    };
  }
  if (status === 404 || status === 405 || status === 501) {
    return {
      ...shared,
      reason: 'rejected',
      message: execUnavailableCopy(status),
      note: NOTHING_RAN_NOTE,
    };
  }
  return {
    ...shared,
    reason: 'rejected',
    message: sendRejectedCopy(status),
    note: NOTHING_RAN_NOTE,
  };
}

/** Link failure: the phone never got an answer from the PC. */
function linkFailure(
  reason: 'offline' | 'timeout' | 'broken',
  message: string,
  raw: string | null,
  note: string | null = null,
  status: number | null = null,
): SendFailure {
  return {
    ok: false,
    reason,
    title: SEND_UNREACHABLE_TITLE,
    blame: 'link',
    message,
    note,
    raw,
    status,
  };
}

/**
 * Send one command to the PC: `POST /api/exec` over the tunnel (protocol §4.1).
 *
 * - an empty/whitespace-only field is refused with `EMPTY_COMMAND_COPY` and
 *   **nothing is written to the tunnel**;
 * - no tunnel → `offline` (`SEND_OFFLINE_COPY`), never a fake send;
 * - a refusal (403 `exec_disabled`, 400 `shell_unsupported`/`invalid_command`,
 *   413, 502, …) keeps its own copy and **never enters the ring**: nothing ran;
 * - a real `200` appends `{status: 'sent', exitCode, output}` to the ring with
 *   the PC's own values and id. Non-zero exit codes are results, not errors.
 *
 * Every failure goes through the injected `failure(step, error, raw)` seam.
 */
export async function sendIntent(
  command: unknown,
  deps: SendDeps = {},
): Promise<SendResult> {
  const log = deps.logger ?? terminalLog;
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (trimmed === '') {
    return { ok: false, reason: 'empty', message: EMPTY_COMMAND_COPY };
  }

  const channel = deps.channel ?? null;
  if (channel === null) {
    log.failure('exec-send', new Error('Sin túnel abierto hacia la PC.'), null);
    return linkFailure('offline', SEND_OFFLINE_COPY, 'tunnel=null');
  }

  const result = await bridgeRequest<unknown>(channel, EXEC_PATH, {
    method: 'POST',
    body: { command: trimmed },
    timeoutMs: deps.timeoutMs ?? SEND_TIMEOUT_MS,
  });

  if (!result.ok) {
    const failure = result.failure;
    const raw = rawOf(failure);
    log.failure('exec-send', failure.error ?? new Error(failure.message), raw);
    if (failure.kind === 'offline') {
      return linkFailure('offline', SEND_OFFLINE_COPY, raw);
    }
    if (failure.kind === 'timeout') {
      // The command may have run: never claim it did not.
      return linkFailure('timeout', SEND_TIMEOUT_COPY, raw);
    }
    return linkFailure('broken', SEND_BROKEN_COPY, raw, SEND_BROKEN_NOTE);
  }

  if (result.status < 200 || result.status >= 300) {
    const refused = refusal(result.status, result.body);
    log.failure('exec-send', new Error(refused.message), refused.raw);
    return refused;
  }

  const answer = parseExecAnswer(result.body);
  if (answer === null) {
    const raw = rawPrefix(result.body);
    log.failure('exec-send-parse', new Error(SEND_BROKEN_COPY), raw);
    return linkFailure('broken', SEND_BROKEN_COPY, raw, SEND_BROKEN_NOTE, result.status);
  }

  const known = {
    command: trimmed,
    status: 'sent' as const,
    exitCode: answer.exitCode,
    output: answer.output,
    ...(answer.id === null ? {} : { id: answer.id }),
  };
  const entry: CommandEntry =
    deps.history != null
      ? deps.history.append(known)
      : {
          id: answer.id ?? `exec-${trimmed.length}-${Date.now()}`,
          command: trimmed,
          at: Date.now(),
          status: 'sent',
          exitCode: answer.exitCode,
          output: answer.output,
          reason: null,
        };

  return { ok: true, entry, exit: exitChip(entry.exitCode), output: renderOutput(entry.output) };
}

/* ------------------------------------------------------------------ *
 * Agent header
 * ------------------------------------------------------------------ */

/** The only agent the bridge can name (§9: the Pi extension). */
export const AGENT_NAME = 'pi';

/** Header shown when the payload named no model: the plain shell. */
export const SHELL_HEADER = 'shell';

/** Who is on the other side of the tunnel: `pi · <model>`, or the shell. */
export interface AgentHeader {
  agent: string;
  /** The real model name the payload carried; `null` when it carried none. */
  model: string | null;
  /** `pi · opus-4.5` with a payload model, `shell` without one. */
  label: string;
}

/**
 * Header of the transcript pane. §4.1 publishes no model field today, so the
 * header stays `shell`; a real model name in the payload is the only thing that
 * turns it into `pi · <model>`. An empty/blank or mistyped value is absent, not
 * a made-up agent.
 */
export function agentHeader(model: unknown = null): AgentHeader {
  const name = typeof model === 'string' && model.trim() !== '' ? model.trim() : null;
  return {
    agent: AGENT_NAME,
    model: name,
    label: name === null ? SHELL_HEADER : `${AGENT_NAME} · ${name}`,
  };
}

/* ------------------------------------------------------------------ *
 * Transcript — derived from the real history only (T7n)
 * ------------------------------------------------------------------ */

/** The states the evidence supports. There is no `waiting`: nothing serves it. */
export type TranscriptKind = 'running' | 'ended' | 'idle';

/** Closed set of transcript states (artboard chips, minus the fabricated one). */
export const TRANSCRIPT_STATES: readonly TranscriptKind[] = ['running', 'ended', 'idle'];

/** Chip copy of a `pending` newest entry: the command has not come back yet. */
export const RUNNING_LABEL = 'en curso';

/** Chip copy when the newest entry finished (`sent`/`failed`). */
export const ENDED_LABEL = 'terminado';

/** Chip copy when the history has no entry at all. */
export const IDLE_LABEL = 'sin actividad';

/** Honest note over the transcript: the bridge serves no agent stream. */
export const AGENT_NOTE = 'sin eventos del agente';

/** Why there are no agent events: this is command history, V9 owns the agent. */
export const NO_AGENT_REASON =
  'El puente no expone el stream del agente: /api/exec/history solo trae los comandos que corrió. La conversación del agente llega con la superficie de sesiones (V9).';

/** Ceiling of the duration copy: past a day the exact span stops being useful. */
export const DURATION_CAP_MS = 24 * 3_600_000;

/** What a span over the ceiling reads as (capped, never a fake precision). */
export const DURATION_CAP_COPY = 'más de 24 horas';

/** `1 segundo` / `45 segundos`: the number plus its singular or plural noun. */
function plural(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * Duration copy with singular/plural and a capped ceiling: `0 segundos`,
 * `1 segundo`, `1 minuto 30 segundos`, `2 horas 5 minutos`, `más de 24 horas`.
 * A negative or unusable number reads `0 segundos` instead of a nonsense span.
 */
export function durationCopy(ms: number): string {
  const seconds = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (seconds * 1000 >= DURATION_CAP_MS) {
    return DURATION_CAP_COPY;
  }
  if (seconds < 60) {
    return plural(seconds, 'segundo', 'segundos');
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    const head = plural(minutes, 'minuto', 'minutos');
    return rest === 0 ? head : `${head} ${plural(rest, 'segundo', 'segundos')}`;
  }
  const hours = Math.floor(minutes / 60);
  const tail = minutes % 60;
  const head = plural(hours, 'hora', 'horas');
  return tail === 0 ? head : `${head} ${plural(tail, 'minuto', 'minutos')}`;
}

/** Tones the transcript state chip can paint. */
export type TranscriptTone = 'running' | 'ok' | 'danger' | 'neutral' | 'muted';

/** The derived transcript state: evidence in, one chip out. */
export interface TranscriptStatus {
  kind: TranscriptKind;
  /** `en curso` / `terminado` / `sin actividad`. */
  label: string;
  tone: TranscriptTone;
  /** `hace` (elapsed of the pending entry) / `duró` (real span) / `null`. */
  timeLabel: string | null;
  /** `12 segundos` / `4 minutos` / `null` when nothing was measured. */
  time: string | null;
  /** Exit chip of the newest finished entry (`ended` only). */
  exit: ExitChip | null;
  /** The command the state is about, `null` when the history is empty. */
  command: string | null;
  /** `sin eventos del agente`: always, see `NO_AGENT_REASON`. */
  agentNote: string;
  /** Why there are no agent events (not this surface's data). */
  agentReason: string;
  /** `pi · <model>` only when the payload named one, `shell` otherwise. */
  agent: AgentHeader;
  /** Real entries the state was derived from (0 = nothing was claimed). */
  from: number;
}

/** Injectable clock + the model the payload named (both optional). */
export interface TranscriptOptions {
  /** Epoch ms used for the elapsed copy; defaults to `Date.now()`. */
  now?: number;
  /** Model name the payload carried, `null`/absent when it carried none. */
  model?: string | null;
}

/** Entries sorted by their real `at`, stable for equal stamps (no mutation). */
function byAt(entries: readonly CommandEntry[]): CommandEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * The transcript state, derived from real history entries only:
 *
 * - no entry → `idle`;
 * - newest entry `pending` → `running`, elapsed since its real `at`;
 * - newest entry `sent`/`failed` → `ended`, with that entry's exit chip and the
 *   real span between the oldest and newest stamps (no span with one entry).
 *
 * There is no `waiting`: the bridge cannot say the agent is waiting for you.
 */
export function transcriptState(
  entries: readonly CommandEntry[],
  options: TranscriptOptions = {},
): TranscriptStatus {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const base = {
    agentNote: AGENT_NOTE,
    agentReason: NO_AGENT_REASON,
    agent: agentHeader(options.model ?? null),
  };
  const ordered = byAt(entries);

  if (ordered.length === 0) {
    return {
      ...base,
      kind: 'idle',
      label: IDLE_LABEL,
      tone: 'muted',
      timeLabel: null,
      time: null,
      exit: null,
      command: null,
      from: 0,
    };
  }

  const newest = ordered[ordered.length - 1];
  const oldest = ordered[0];

  if (newest.status === 'pending') {
    return {
      ...base,
      kind: 'running',
      label: RUNNING_LABEL,
      tone: 'running',
      timeLabel: 'hace',
      time: durationCopy(now - newest.at),
      exit: null,
      command: newest.command,
      from: ordered.length,
    };
  }

  const chip = exitChip(newest.exitCode);
  const span = newest.at - oldest.at;
  const measured = ordered.length > 1 && span >= 0 ? span : null;
  return {
    ...base,
    kind: 'ended',
    label: ENDED_LABEL,
    tone: chip.tone,
    timeLabel: measured === null ? null : 'duró',
    time: measured === null ? null : durationCopy(measured),
    exit: chip,
    command: newest.command,
    from: ordered.length,
  };
}

/** Kinds of streamed line the transcript renders. */
export type TranscriptEventKind = 'command' | 'output' | 'status';

/** Kind glyphs (artboard `.log__who` / `.tool__head` columns). */
export const EVENT_GLYPHS: Record<TranscriptEventKind, string> = {
  command: '$',
  output: '│',
  status: '·',
};

/** One ordered transcript line, derived from one real history entry. */
export interface TranscriptEvent {
  /** Stable, unique key: `${entry.id}:${kind}`. */
  id: string;
  /** The history entry this line came from. */
  entryId: string;
  /** Real epoch ms of the entry — the only stamp the bridge gives. */
  at: number;
  /** `14:32` local time of that stamp. */
  atLabel: string;
  kind: TranscriptEventKind;
  /** `$` / `│` / `·`. */
  glyph: string;
  /** Display text: the command, the ANSI-stripped output or the status copy. */
  text: string;
  /** Status copy on a `status` line (`enviado` / `falló` / `en cola`), else null. */
  statusLabel: string | null;
  /** Exit chip on a `status` line, null on the other kinds. */
  exit: ExitChip | null;
  /** The output was cut by the display cap (the marker names how much). */
  truncated: boolean;
  /** Characters hidden behind the marker (0 when nothing was cut). */
  hidden: number;
  /** The command this line belongs to. */
  command: string;
}

/**
 * The streamed transcript: one `command` line per entry, its `output` lines
 * (ANSI-stripped and truncated by the existing rule) and its `status` line,
 * ordered by the real `at` ascending. Equal stamps keep the natural order of
 * one command — command, then output, then status — never an invented clock.
 */
export function transcriptEvents(
  entries: readonly CommandEntry[],
  cap: number = OUTPUT_DISPLAY_CAP,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const entry of byAt(entries)) {
    const shared = {
      entryId: entry.id,
      at: entry.at,
      atLabel: timeLabel(entry.at),
      command: entry.command,
    };
    events.push({
      ...shared,
      id: `${entry.id}:command`,
      kind: 'command',
      glyph: EVENT_GLYPHS.command,
      text: entry.command,
      statusLabel: null,
      exit: null,
      truncated: false,
      hidden: 0,
    });
    const output = renderOutput(entry.output, cap);
    if (output !== null) {
      events.push({
        ...shared,
        id: `${entry.id}:output`,
        kind: 'output',
        glyph: EVENT_GLYPHS.output,
        text: output.text,
        statusLabel: null,
        exit: null,
        truncated: output.truncated,
        hidden: output.hidden,
      });
    }
    events.push({
      ...shared,
      id: `${entry.id}:status`,
      kind: 'status',
      glyph: EVENT_GLYPHS.status,
      text: STATUS_LABELS[entry.status],
      statusLabel: STATUS_LABELS[entry.status],
      exit: exitChip(entry.exitCode),
      truncated: false,
      hidden: 0,
    });
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * Payload validation
 * ------------------------------------------------------------------ */

/** Parse outcome: the real entries (plus any model the payload named), or why
 * the body is not usable. */
export type ParseResult =
  | { ok: true; entries: CommandEntry[]; model: string | null }
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
  return { ok: true, entries, model: parseModel(record.model) };
}

/**
 * Optional model name of the body. §4.1 does not publish it, so it is read
 * leniently: only a non-empty string names the agent, anything else is absent
 * (the header then stays `shell`). A field the bridge does not serve can never
 * turn the screen into an error.
 */
function parseModel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/* ------------------------------------------------------------------ *
 * Honest states
 * ------------------------------------------------------------------ */

/** The §V7 states table, logic level. */
export type HistoryState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; entries: CommandEntry[]; model?: string | null }
  | { kind: 'stale'; minutes: number; entries: CommandEntry[]; model?: string | null }
  | {
      kind: 'offline';
      entries: CommandEntry[] | null;
      minutes: number | null;
      model?: string | null;
    }
  | { kind: 'error'; message: string; raw: string | null };

/**
 * Last good `/api/exec/history` answer, so a later timeout can show the cached
 * rows with the honest age instead of inventing output or pretending the
 * session is empty.
 */
export class HistoryCache {
  private entries: CommandEntry[] | null = null;
  private model: string | null = null;
  private at = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Marks "the PC answered this history, now" (with the model it named). */
  mark(entries: readonly CommandEntry[], model: string | null = null): void {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.model = model;
    this.at = this.now();
  }

  /** Cached entries + minutes since they arrived, or null when never answered. */
  snapshot(): { entries: CommandEntry[]; minutes: number; model: string | null } | null {
    if (this.at === 0 || this.entries === null) {
      return null;
    }
    const minutes = Math.max(1, Math.floor((this.now() - this.at) / 60_000));
    return { entries: this.entries, minutes, model: this.model };
  }

  /** Drops the cache: an empty history is truth, not something to fall back to. */
  clear(): void {
    this.entries = null;
    this.model = null;
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
        model: cached?.model ?? null,
      };
    case 'timeout':
      return cached === null
        ? { kind: 'offline', entries: null, minutes: null, model: null }
        : { kind: 'stale', minutes: cached.minutes, entries: cached.entries, model: cached.model };
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
    // The bridge answered, but not with a history. A missing route reads as
    // "this is not available", never as "nothing ran yet".
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

  cache?.mark(parsed.entries, parsed.model);
  return { kind: 'success', entries: parsed.entries, model: parsed.model };
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
  /** The derived transcript chip: `running | ended | idle`, never `waiting`. */
  transcript: TranscriptStatus;
  /** Ordered transcript lines (real `at` ascending) from the PC history. */
  events: TranscriptEvent[];
  /** The transcript section has evidence to show (or a real empty history). */
  transcriptVisible: boolean;
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
    reason: entry.reason ?? NOT_SENT_REASON,
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
 * Build the render model from a §V7 state plus the commands typed here.
 *
 * A local `pending` entry is a command that never ran: it is appended as a
 * `no enviado` row with its reason and never merged into the PC history. A
 * local `sent`/`failed` entry is a real result the PC returned (`POST
 * /api/exec`): it is merged into `rows` (and therefore the pane) by id, so it
 * disappears on its own once a history refresh carries the same id.
 *
 * The transcript (T7n) is derived from the PC entries: real `at` stamps, no
 * fabricated agent events and no `waiting` state. `now` makes the elapsed copy
 * injectable.
 */
export function buildTerminalView(
  state: HistoryState,
  local: readonly CommandEntry[] = [],
  now: number = Date.now(),
): TerminalViewModel {
  const notSent = local
    .filter((entry) => entry.status === 'pending')
    .map((entry) => notSentRow(entry));
  const realLocal = local.filter((entry) => entry.status !== 'pending').map(historyRow);

  const transcriptEntries: CommandEntry[] =
    state.kind === 'success' || state.kind === 'stale'
      ? state.entries
      : state.kind === 'offline' && state.entries !== null
        ? state.entries
        : [];
  const model =
    state.kind === 'success' || state.kind === 'stale' || state.kind === 'offline'
      ? (state.model ?? null)
      : null;

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
    transcript: transcriptState(transcriptEntries, { now, model }),
    events: transcriptEvents(transcriptEntries),
    transcriptVisible: state.kind === 'empty' || transcriptEntries.length > 0,
  };

  /** Shared projection of a history that may be live or cached. */
  const projection = (entries: readonly CommandEntry[], frozen: boolean) => {
    const known = new Set(entries.map((entry) => entry.id));
    const rows = [...entries.map(historyRow), ...realLocal.filter((row) => !known.has(row.id))];
    return { rows, pane: paneOf(rows), frozen };
  };

  switch (state.kind) {
    case 'loading':
      return { ...base, state: 'loading', loading: true };
    case 'empty': {
      const projected = projection([], false);
      return {
        ...base,
        state: 'empty',
        ...projected,
        emptyMessage: EMPTY_COPY,
        paneEmpty: projected.pane === null ? PANE_EMPTY_COPY : null,
        canSend: true,
      };
    }
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
