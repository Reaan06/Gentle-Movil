/**
 * Logging for the bridge: every record is exactly one JSON line on stdout.
 *
 * Two rules make this safe on a flaky device link:
 *  - logging never throws (a broken pipe or a circular payload must not take the
 *    bridge down, and a socket error is often what we are logging);
 *  - the record always carries `ts`, `level`, `component`, `event`, even when the
 *    caller passes fields with those names.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly component: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  component?: string;
  write?: (line: string) => void;
  base?: LogFields;
}

export const BRIDGE_LOG_COMPONENT = "gentle-movil-bridge";

function normalizeValue(value: unknown, seen: Set<unknown>): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") return Number.isFinite(value as number) ? value : String(value);
  if (kind === "bigint") return (value as bigint).toString();
  if (kind === "function") return "[function]";
  if (kind === "symbol") return (value as symbol).toString();
  if (value instanceof Error) {
    const normalized: LogFields = { name: value.name, message: value.message };
    const code = (value as Error & { code?: unknown }).code;
    if (code !== undefined) normalized.code = code;
    return normalized;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, seen));
  if (kind === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const normalized: LogFields = {};
    for (const [key, item] of Object.entries(value as LogFields)) {
      const result = normalizeValue(item, seen);
      if (result !== undefined) normalized[key] = result;
    }
    seen.delete(value);
    return normalized;
  }
  return String(value);
}

export function normalizeFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const normalized = normalizeValue(fields, new Set<unknown>());
  return (normalized as LogFields | undefined) ?? {};
}

/** Serializes a record to a single line. Falls back to a minimal record instead of throwing. */
export function toJsonLine(record: LogFields): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "log.serialize_failed" });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const component = options.component ?? BRIDGE_LOG_COMPONENT;
  const base = options.base ?? {};
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    const record: LogFields = {
      ...normalizeFields(base),
      ...normalizeFields(fields),
      ts: new Date().toISOString(),
      level,
      component,
      event,
    };
    try {
      write(toJsonLine(record));
    } catch {
      // A logger that throws is worse than a lost line: swallow and continue.
    }
  };

  return {
    component,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) => createLogger({ component, write, base: { ...base, ...normalizeFields(fields) } }),
  };
}
