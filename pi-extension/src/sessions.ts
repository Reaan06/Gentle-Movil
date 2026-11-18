/**
 * What the bridge knows about agent sessions.
 *
 * Two implementations, one contract:
 *  - `createStaticSessionSource` for tests and for hosts where the platform
 *    exposes nothing;
 *  - `createDirectorySessionSource`, which reads Pi's session JSONL files.
 *
 * Every field is either read from the platform or reported honestly as unknown:
 * the bridge never claims to know a session status the platform does not expose.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Logger } from "./log.ts";

export type SessionStatus = "idle" | "busy" | "unknown";
export type SessionPlatform = "pi" | "none";

export interface AgentSession {
  id: string;
  title: string | null;
  status: SessionStatus;
  cwd: string | null;
  updatedAt: string | null;
  current: boolean;
}

export interface SessionSeed {
  id: string;
  title?: string | null;
  status?: SessionStatus;
  cwd?: string | null;
  updatedAt?: string | null;
  current?: boolean;
}

export interface SessionSource {
  readonly platform: SessionPlatform;
  list(): AgentSession[];
}

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 120;

export function normalizeSession(seed: SessionSeed): AgentSession {
  const title = typeof seed.title === "string" && seed.title.trim().length > 0 ? seed.title.trim() : null;
  return {
    id: seed.id,
    title,
    status: seed.status ?? "unknown",
    cwd: seed.cwd ?? null,
    updatedAt: seed.updatedAt ?? null,
    current: seed.current ?? false,
  };
}

export function createStaticSessionSource(seeds: SessionSeed[] = [], platform: SessionPlatform = "pi"): SessionSource {
  const sessions = seeds.map((seed) => normalizeSession(seed));
  return {
    platform,
    list: () => sessions.map((session) => ({ ...session })),
  };
}

export interface DirectorySessionOptions {
  /** Session root; a function lets the extension track the live session directory. */
  dir: string | null | (() => string | null);
  logger?: Logger;
  limit?: number;
  maxScanBytes?: number;
  currentSessionId?: () => string | null;
  currentTitle?: () => string | null;
  currentCwd?: () => string | null;
  statusFor?: (id: string) => SessionStatus;
}

interface ScannedSession {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: string;
}

function safeCall<T>(fn: (() => T) | undefined): T | undefined {
  if (!fn) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function createDirectorySessionSource(options: DirectorySessionOptions): SessionSource {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;

  const resolveDir = (): string | null => {
    try {
      return typeof options.dir === "function" ? options.dir() : options.dir;
    } catch {
      return null;
    }
  };

  const statusOf = (id: string, fallback: SessionStatus = "unknown"): SessionStatus => {
    const status = safeCall(options.statusFor ? () => options.statusFor!(id) : undefined);
    if (status === "idle" || status === "busy" || status === "unknown") return status;
    return fallback;
  };

  return {
    // Honest platform report: with no readable directory there is nothing to read.
    get platform(): SessionPlatform {
      const dir = resolveDir();
      if (!dir) return "none";
      try {
        return statSync(dir).isDirectory() ? "pi" : "none";
      } catch {
        return "none";
      }
    },
    list: () => {
      const dir = resolveDir();
      const currentId = safeCall(options.currentSessionId) ?? null;

      if (!dir) {
        // Honest empty list: the platform exposed no directory to read.
        if (!currentId) return [];
        return [
          normalizeSession({
            id: currentId,
            title: safeCall(options.currentTitle) ?? null,
            cwd: safeCall(options.currentCwd) ?? null,
            status: statusOf(currentId),
            current: true,
          }),
        ];
      }

      const scanned: ScannedSession[] = [];
      const seen = new Set<string>();
      for (const file of collectSessionFiles(dir, limit, options.logger)) {
        const metadata = readSessionMetadata(file.path, maxScanBytes);
        if (!metadata || seen.has(metadata.id)) continue;
        seen.add(metadata.id);
        scanned.push({ ...metadata, updatedAt: file.updatedAt });
      }

      const sessions = scanned.map((entry) =>
        normalizeSession({
          id: entry.id,
          title: safeCall(options.currentTitle) && entry.id === currentId ? safeCall(options.currentTitle)! : entry.title,
          status: statusOf(entry.id),
          cwd: entry.cwd,
          updatedAt: entry.updatedAt,
          current: entry.id === currentId,
        }),
      );

      if (currentId && !sessions.some((session) => session.id === currentId)) {
        sessions.unshift(
          normalizeSession({
            id: currentId,
            title: safeCall(options.currentTitle) ?? null,
            cwd: safeCall(options.currentCwd) ?? null,
            status: statusOf(currentId),
            updatedAt: null,
            current: true,
          }),
        );
      }

      return sessions;
    },
  };
}

interface SessionFile {
  path: string;
  updatedAt: string;
}

function collectSessionFiles(root: string, limit: number, logger?: Logger): SessionFile[] {
  const found: Array<{ path: string; mtimeMs: number }> = [];

  const visit = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logger?.warn("sessions.scan_failed", { dir, error });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) visit(full, depth - 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        found.push({ path: full, mtimeMs: statSync(full).mtimeMs });
      } catch (error) {
        logger?.warn("sessions.stat_failed", { file: full, error });
      }
    }
  };

  visit(root, 1);
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found.slice(0, limit).map((entry) => ({
    path: entry.path,
    updatedAt: new Date(entry.mtimeMs).toISOString(),
  }));
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  const joined = parts.join(" ").trim();
  return joined.length > 0 ? joined : null;
}

function truncateTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TITLE_LENGTH ? `${collapsed.slice(0, MAX_TITLE_LENGTH - 1)}…` : collapsed;
}

function idFromFileName(file: string): string {
  const name = basename(file).replace(/\.jsonl$/, "");
  const separator = name.lastIndexOf("_");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

/**
 * Reads the bounded head of one session file: header (id/cwd), the last
 * `session_info` name, and the first user message as a title fallback.
 */
export function readSessionMetadata(file: string, maxScanBytes = DEFAULT_MAX_SCAN_BYTES): { id: string; title: string | null; cwd: string | null } | null {
  let fd: number | null = null;
  let text = "";
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(maxScanBytes);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read <= 0) break;
      total += read;
    }
    text = buffer.subarray(0, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do: the scan is best-effort.
      }
    }
  }

  let id: string | null = null;
  let cwd: string | null = null;
  let name: string | null = null;
  let firstUserText: string | null = null;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // A half-written trailing line is expected while Pi appends.
    }
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "session") {
      if (typeof entry.id === "string") id = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    if (entry.type === "session_info") {
      if (typeof entry.name === "string" && entry.name.trim().length > 0) name = entry.name.trim();
      continue;
    }
    if (entry.type === "message" && firstUserText === null) {
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (message && message.role === "user") {
        const candidate = textFromContent(message.content);
        if (candidate) firstUserText = truncateTitle(candidate);
      }
    }
  }

  const resolvedId = id ?? idFromFileName(file);
  const title = name ?? firstUserText ?? null;
  return { id: resolvedId, title, cwd };
}
