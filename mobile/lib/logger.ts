/**
 * Structured logger for Gentle Movil (pairing pipeline support).
 *
 * Two concerns are deliberately separated so both stay verifiable without a
 * React Native runtime:
 *
 * - the *pure* part (ring buffer, level gate, one-line serialization, the
 *   rotation decision at 512 KB, error normalization) is plain functions;
 * - the *I/O* part is an injected `LogSink`, so `mobile/test/logger.test.mjs`
 *   can mock the filesystem and pin the rules, while the app passes the
 *   `expo-file-system` sink.
 *
 * Persistence rule: every `error` entry (and only those) is appended to
 * `${documentDirectory}/logs/gentle-movil.log`, rotated to `.1` when the next
 * line would cross 512 KB. Backend failures go through `logger.failure`, which
 * is `logger.error` with the fixed `{step, error, raw}` payload — the shape the
 * pairing screen and any later diagnostics screen read.
 *
 * A failing sink never breaks the caller: writes are fire-and-forget, `flush()`
 * resolves after the queue settles, and sink errors are swallowed.
 */

/** Severity of a record. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric rank used by the level gate. */
export const levelRank: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** In-memory ring capacity. */
export const LOG_CAPACITY = 500;

/** Rotate the on-disk log once the next line would cross this size. */
export const LOG_ROTATE_BYTES = 512 * 1024;

/** Directory (relative to the document directory) that holds the log file. */
export const LOG_DIR = 'logs';

/** Log file name. */
export const LOG_FILE = 'gentle-movil.log';

/** Structured data attached to a record. */
export type LogData = Record<string, unknown>;

/** One record in the ring buffer. */
export interface LogEntry {
  /** Epoch milliseconds (the clock is injectable). */
  ts: number;
  level: LogLevel;
  /** Logical source, e.g. `provision` or `pairing-progress`. */
  tag: string;
  msg: string;
  data?: LogData | FailureData;
}

/** Normalized failure reason (`{step, error, raw}` is the app-wide shape). */
export interface FailureReason {
  name: string;
  message: string;
}

/** Payload attached to every backend failure record. */
export interface FailureData {
  step: string;
  error: FailureReason;
  raw: unknown;
}

/** Appends the line when it fits; rotates first when it would cross the limit. */
export type RotationDecision = 'append' | 'rotate-first';

/** Filesystem operations the logger needs (mocked in the tests). */
export interface LogSink {
  /** Byte size of the file; 0 when it does not exist. */
  size(path: string): Promise<number>;
  /** Appends one already-serialized line to the file, creating it if needed. */
  append(path: string, line: string): Promise<void>;
  /** Copies the current file to `${path}.1`, replacing the previous rotation. */
  rotate(path: string): Promise<void>;
}

/** Scoped logger handed to screens and libs. */
export interface Logger {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
  /** Records a backend failure as `error` with the `{step, error, raw}` payload. */
  failure(step: string, error: unknown, raw?: unknown): void;
  /** Same ring and sink, different `tag`. */
  tag(tag: string): Logger;
  /** Snapshot of the in-memory ring, oldest first. */
  entries(): readonly LogEntry[];
  /** Resolves after every queued write settled; never rejects. */
  flush(): Promise<void>;
}

/** Options of `createLogger`. */
export interface LoggerOptions {
  /** Sink that receives `error` entries; defaults to `expo-file-system`. */
  sink?: LogSink;
  /** Absolute path of the log file; defaults to the document directory one. */
  resolveLogPath?: () => Promise<string>;
  /** Injected clock (tests). */
  now?: () => number;
  /** Minimum level kept in the ring and mirrored to console (default `debug`). */
  min?: LogLevel;
  /** Ring capacity (default `LOG_CAPACITY`). */
  capacity?: number;
  /** Mirror to console (default true; tests pass false). */
  console?: boolean;
  /** Tag of the records created by this logger (default `app`). */
  tag?: string;
  /** Rotate threshold in bytes (default `LOG_ROTATE_BYTES`). */
  limit?: number;
}

/** True when `level` is at least `min`. */
export function shouldWrite(level: LogLevel, min: LogLevel): boolean {
  return levelRank[level] >= levelRank[min];
}

/**
 * Pure ring append: returns a new array holding at most `capacity` of the
 * newest entries. The input is never mutated.
 */
export function ringAppend<T>(buffer: readonly T[], entry: T, capacity: number = LOG_CAPACITY): readonly T[] {
  const kept = buffer.length + 1 > capacity ? buffer.slice(buffer.length + 1 - capacity) : buffer;
  return [...kept, entry];
}

/** One-line JSON serialization (a record can never span two lines). */
export function serializeEntry(entry: LogEntry): string {
  const record: Record<string, unknown> = {
    ts: entry.ts,
    at: new Date(entry.ts).toISOString(),
    level: entry.level,
    tag: entry.tag,
    msg: entry.msg,
  };
  if (entry.data !== undefined) {
    record.data = entry.data;
  }
  return `${JSON.stringify(record)}\n`;
}

/** Decides whether the next line fits or needs a rotation first. */
export function rotationDecision(
  currentBytes: number,
  incomingBytes: number,
  limit: number = LOG_ROTATE_BYTES,
): RotationDecision {
  return currentBytes + incomingBytes > limit ? 'rotate-first' : 'append';
}

/** `file:///…/logs/gentle-movil.log` under the given document directory. */
export function logPathFor(baseDir: string): string {
  const base = baseDir.replace(/\/+$/, '');
  return `${base}/${LOG_DIR}/${LOG_FILE}`;
}

/** Path of the single rotation slot (`.1`). */
export function rotatedPathFor(path: string): string {
  return `${path}.1`;
}

/**
 * Normalizes any thrown value into `{name, message}`. The native bridge reports
 * `{kind, message}` objects; real errors carry `name`; anything else becomes a
 * plain `Error`.
 */
export function describeError(error: unknown): FailureReason {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === 'object' && error !== null) {
    const value = error as { kind?: unknown; message?: unknown; name?: unknown };
    const name = typeof value.kind === 'string' ? value.kind : typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : '';
    return { name, message };
  }
  return { name: 'Error', message: String(error) };
}

/** Builds the fixed backend-failure payload. */
export function failureData(step: string, error: unknown, raw?: unknown): FailureData {
  return { step, error: describeError(error), raw: raw === undefined ? null : raw };
}

/** Resolves the document-directory log path with the real filesystem module. */
async function expoLogPath(): Promise<string> {
  const { Paths } = await import('expo-file-system');
  return logPathFor(Paths.document.uri);
}

/** `expo-file-system` sink (append + single `.1` rotation). */
const expoSink: LogSink = {
  async size(path) {
    const { File } = await import('expo-file-system');
    const file = new File(path);
    return file.exists ? file.size : 0;
  },
  async append(path, line) {
    const { Directory, File } = await import('expo-file-system');
    const dirUri = path.slice(0, path.lastIndexOf('/'));
    new Directory(dirUri).create({ intermediates: true, idempotent: true });
    await new File(path).write(line, { append: true });
  },
  async rotate(path) {
    const { File } = await import('expo-file-system');
    const file = new File(path);
    const current = file.exists ? await file.text() : '';
    await new File(rotatedPathFor(path)).write(current);
    await file.write('');
  },
};

/**
 * Creates a logger. Entries go to the ring (and console) when they pass the
 * gate; `error` entries are additionally queued for the file sink.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? expoSink;
  const resolveLogPath = options.resolveLogPath ?? expoLogPath;
  const now = options.now ?? Date.now;
  const min = options.min ?? 'debug';
  const capacity = options.capacity ?? LOG_CAPACITY;
  const limit = options.limit ?? LOG_ROTATE_BYTES;
  const mirror = options.console ?? true;
  const baseTag = options.tag ?? 'app';

  let buffer: readonly LogEntry[] = [];
  let queue: Promise<void> = Promise.resolve();
  let pathPromise: Promise<string> | null = null;

  function persist(entry: LogEntry): void {
    const line = serializeEntry(entry);
    const bytes = line.length;
    queue = queue.then(async () => {
      try {
        pathPromise = pathPromise ?? resolveLogPath();
        const path = await pathPromise;
        if (rotationDecision(await sink.size(path), bytes, limit) === 'rotate-first') {
          await sink.rotate(path);
        }
        await sink.append(path, line);
      } catch {
        // A broken filesystem must never hide the record: it stays in the ring
        // and in the console, and the pairing flow keeps its honest failure.
        pathPromise = null;
      }
    });
  }

  function record(level: LogLevel, tag: string, msg: string, data?: LogData | FailureData): void {
    if (!shouldWrite(level, min)) {
      return;
    }
    const entry: LogEntry = { ts: now(), level, tag, msg };
    if (data !== undefined) {
      entry.data = data;
    }
    buffer = ringAppend(buffer, entry, capacity);
    if (mirror) {
      const args: unknown[] = [`[${level}] ${tag}: ${msg}`];
      if (data !== undefined) {
        args.push(data);
      }
      // eslint-disable-next-line no-console
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...args);
    }
    if (level === 'error') {
      persist(entry);
    }
  }

  function makeLogger(tag: string): Logger {
    return {
      debug: (msg, data) => record('debug', tag, msg, data),
      info: (msg, data) => record('info', tag, msg, data),
      warn: (msg, data) => record('warn', tag, msg, data),
      error: (msg, data) => record('error', tag, msg, data),
      failure(step, error, raw) {
        const data = failureData(step, error, raw);
        record('error', tag, `falló el paso «${step}»: ${data.error.message || data.error.name}`, data);
      },
      tag: (next: string) => makeLogger(next),
      entries: () => buffer,
      flush: () => queue,
    };
  }

  return makeLogger(baseTag);
}

/**
 * App-wide logger. Screens use `logger.tag('pairing-progress')` so one ring and
 * one file collect every backend failure of the session.
 */
export const logger: Logger = createLogger();
