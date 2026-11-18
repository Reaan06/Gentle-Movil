/**
 * `POST /api/exec` and `GET /api/exec/history`: running a command on the host,
 * and the in-memory ring the bridge keeps of what it ran.
 *
 * Three hard rules:
 *  1. **Opt-in only.** Nothing runs unless the bridge was started with
 *     `GENTLE_MOVIL_ALLOW_EXEC=1` (or `createBridge({allowExec: true})`). A
 *     request without it is refused with `403 exec_disabled` and never reaches
 *     `spawn`, so a paired phone cannot run commands on a host whose owner did
 *     not ask for that.
 *  2. **No shell, ever.** The command line is split into an argv array by
 *     {@link tokenizeCommand} and passed to `spawn(file, args)`; there is no
 *     `sh -c`, so nothing is interpolated. A command line that needs a shell
 *     (`|`, `&&`, `;`, `>`, `$(…)`, backticks, …) is refused with a clear 400
 *     instead of being half-executed.
 *  3. **Bounded.** Output is capped, the process is killed after a timeout, and
 *     the ring keeps the newest {@link EXEC_HISTORY_CAPACITY} commands.
 *
 * History entries are the shape `mobile/lib/terminal.ts` parses:
 * `{id, command, at, status, exitCode, output}` with
 * `status: "pending" | "sent" | "failed"`, `at` ISO-8601 and `output` the raw
 * stream (null when the command produced none).
 */

import { spawn } from "node:child_process";

/** Environment variable that enables command execution. */
export const ALLOW_EXEC_ENV = "GENTLE_MOVIL_ALLOW_EXEC";

/** Commands kept in the ring (newest last). */
export const EXEC_HISTORY_CAPACITY = 50;

/** Bytes of combined stdout/stderr kept per command. */
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024;

/** Milliseconds a command may run before it is killed. */
export const EXEC_TIMEOUT_MS = 30_000;

/** Longest command line accepted (bytes). */
export const EXEC_MAX_COMMAND_BYTES = 4096;

export type ExecStatus = "pending" | "sent" | "failed";

export interface ExecRecord {
  id: string;
  command: string;
  /** ISO-8601, the shape the phone parses. */
  at: string;
  status: ExecStatus;
  exitCode: number | null;
  output: string | null;
}

export interface ExecRing {
  add(record: Omit<ExecRecord, "id"> & { id?: string }): ExecRecord;
  list(): ExecRecord[];
  size(): number;
}

/** True only for the explicit opt-in `GENTLE_MOVIL_ALLOW_EXEC=1`. */
export function isExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_EXEC_ENV] === "1";
}

/**
 * The in-memory history ring: capped, oldest first, newest last. Nothing is
 * persisted — a bridge restart starts with an empty history, which is honest
 * about what this process ran.
 */
export function createExecRing(capacity = EXEC_HISTORY_CAPACITY): ExecRing {
  let records: ExecRecord[] = [];
  let sequence = 0;
  return {
    add: (entry) => {
      sequence += 1;
      const record: ExecRecord = {
        id: entry.id ?? `cmd-${Date.now().toString(36)}-${sequence}`,
        command: entry.command,
        at: entry.at,
        status: entry.status,
        exitCode: entry.exitCode,
        output: entry.output,
      };
      records = capacity <= 0 ? [] : [...records, record].slice(-capacity);
      return record;
    },
    list: () => records.map((record) => ({ ...record })),
    size: () => records.length,
  };
}

export type TokenizeResult =
  | { ok: true; argv: string[] }
  | { ok: false; code: "shell_unsupported"; message: string }
  | { ok: false; code: "invalid_command"; message: string };

/**
 * Characters a shell would interpret. Outside quotes they make the command
 * refuse instead of being handed to the program as literals (`shell_unsupported`).
 */
const SHELL_META = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "{", "}", "*", "?", "[", "]", "~", "#"]);
const QUOTES = new Set(["'", '"']);

/**
 * Splits a command line into argv the way a shell would split words, without a
 * shell: quotes group, `\` escapes the next character, and any shell operator
 * outside quotes makes the command refuse (`shell_unsupported`). Refusing is
 * the honest answer: without `sh -c` a pipe would be passed to the program as a
 * literal argument and silently do the wrong thing.
 */
export function tokenizeCommand(command: string): TokenizeResult {
  if (typeof command !== "string") return { ok: false, code: "invalid_command", message: "command must be a string" };
  const text = command.trim();
  if (text === "") return { ok: false, code: "invalid_command", message: "command is empty" };
  if (Buffer.byteLength(text, "utf8") > EXEC_MAX_COMMAND_BYTES) {
    return { ok: false, code: "invalid_command", message: `command is longer than ${EXEC_MAX_COMMAND_BYTES} bytes` };
  }
  if (text.includes("\n")) {
    return { ok: false, code: "shell_unsupported", message: "multi-line commands are not supported: the bridge does not run a shell" };
  }

  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;

  const flush = (): void => {
    if (started) argv.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index];
        started = true;
        continue;
      }
      current += char;
      started = true;
      continue;
    }

    if (QUOTES.has(char)) {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= text.length) {
        return { ok: false, code: "shell_unsupported", message: "the command ends with a dangling backslash" };
      }
      index += 1;
      current += text[index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (SHELL_META.has(char)) {
      return {
        ok: false,
        code: "shell_unsupported",
        message: `the character "${char}" needs a shell and the bridge runs no shell; quote it for the program or run the parts separately`,
      };
    }
    current += char;
    started = true;
  }

  if (quote !== null) {
    return { ok: false, code: "shell_unsupported", message: `the command has an unterminated ${quote === "'" ? "single" : "double"} quote` };
  }
  flush();
  if (argv.length === 0) return { ok: false, code: "invalid_command", message: "command is empty" };
  return { ok: true, argv };
}

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  /** Process exit code, null when the command never exited (spawn error / timeout). */
  exitCode: number | null;
  /** Combined stdout+stderr in arrival order, capped; null when it produced none. */
  output: string | null;
  /** Set when `spawn` failed (missing binary, permissions), the honest reason. */
  spawnError: string | null;
  timedOut: boolean;
}

/** Marker appended when the output cap hides bytes: a real note, not a silent cut. */
function truncationNote(hidden: number): string {
  return `\n… [cortado: ${hidden} bytes ocultos]`;
}

/**
 * Runs one tokenized command with an argv array (`spawn`, never a shell),
 * collecting a capped stream in arrival order. It never rejects: every failure
 * comes back as a value the caller can record and report.
 */
export function runCommand(options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? EXEC_MAX_OUTPUT_BYTES;
  const tokenized = tokenizeCommand(options.command);
  if (!tokenized.ok) {
    return Promise.resolve({ exitCode: null, output: null, spawnError: tokenized.message, timedOut: false });
  }

  const argv = tokenized.argv;
  const file = argv[0] as string;

  return new Promise((resolve) => {
    let output = "";
    let written = 0;
    let hidden = 0;
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      const body = output === "" ? null : output;
      resolve({ ...result, output: body });
    };

    const child = spawn(file, argv.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const collect = (chunk: Buffer): void => {
      if (written >= maxOutputBytes) {
        hidden += chunk.length;
        return;
      }
      const room = maxOutputBytes - written;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      if (slice.length < chunk.length) hidden += chunk.length - slice.length;
      output += slice.toString("utf8");
      written += slice.length;
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      settle({ exitCode: null, output: null, spawnError: error.message, timedOut });
    });

    child.on("close", (code, signal) => {
      if (hidden > 0) output += truncationNote(hidden);
      if (timedOut) output += `\n… [cortado: el comando superó ${timeoutMs} ms]`;
      const exitCode = typeof code === "number" ? code : null;
      settle({
        exitCode,
        output: null,
        spawnError: timedOut ? `the command was killed after ${timeoutMs} ms` : null,
        timedOut: timedOut || (signal !== null && exitCode === null),
      });
    });
  });
}

/** `sent` when the process ran (whatever the exit code), `failed` otherwise. */
export function statusOfResult(result: RunResult): ExecStatus {
  return result.spawnError === null && result.exitCode !== null ? "sent" : "failed";
}
