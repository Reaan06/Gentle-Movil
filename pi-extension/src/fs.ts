/**
 * Workspace-scoped file access for `GET /api/fs/read` and `GET /api/fs/tree`.
 *
 * The workspace is the extension's cwd (or the `?workspace=` directory the
 * client names, validated by the bridge). Every path is resolved twice:
 *   1. lexically, so `../…` and absolute paths are refused with 400 before any
 *      syscall;
 *   2. through `realpath`, so a symlink pointing outside the workspace is
 *      refused too (a lexical check alone would follow it).
 *
 * Honest failures: a missing path is 404, a directory is not readable as a file
 * (400), a file over the cap is 413, and content that is not UTF-8 text (NUL
 * byte or invalid encoding) is 415 — the editor never receives mojibake.
 */

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Largest file the reader returns (413 beyond this). */
export const DEFAULT_MAX_READ_BYTES = 512 * 1024;

/** Entries of one `fs/tree` listing (the rest is reported as truncated). */
export const DEFAULT_MAX_TREE_ENTRIES = 500;

export type FsErrorCode =
  | "path_outside_workspace"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "file_too_large"
  | "binary_file";

export type PathResolution =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; code: FsErrorCode; message: string };

/** True when `path` exists and is a directory (never throws). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `candidate` is inside `root` (or is `root` itself). */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves a client path inside the workspace. Declared paths are relative
 * (`?path=src/a.ts`); an absolute path is accepted only when it already lives
 * inside the workspace, so the phone can echo back a path it was given.
 */
export function resolveInsideWorkspace(root: string, requested: string | null): PathResolution {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, code: "not_found", message: `the workspace ${root} does not exist` };
  }

  const requestedPath = requested === null || requested === "" ? "." : requested;
  const lexical = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(realRoot, requestedPath);

  if (!isInside(realRoot, lexical)) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `"${requestedPath}" is outside the workspace ${realRoot}`,
    };
  }

  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    return { ok: false, code: "not_found", message: `"${requestedPath}" does not exist in the workspace` };
  }

  if (!isInside(realRoot, real)) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `"${requestedPath}" resolves outside the workspace ${realRoot} (symlink)`,
    };
  }

  const rel = relative(realRoot, real);
  return { ok: true, absolute: real, relative: rel === "" ? "" : rel.split(sep).join("/") };
}

export type FileReadResult =
  | { ok: true; body: { path: string; size: number; encoding: "utf8"; content: string } }
  | { ok: false; code: FsErrorCode; message: string };

/** Reads one text file inside the workspace, bounded and UTF-8 validated. */
export function readWorkspaceFile(
  root: string,
  requested: string | null,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): FileReadResult {
  const resolved = resolveInsideWorkspace(root, requested);
  if (!resolved.ok) return resolved;

  let size: number;
  try {
    const stats = statSync(resolved.absolute);
    if (stats.isDirectory()) {
      return { ok: false, code: "not_a_file", message: `"${resolved.relative}" is a directory, not a file` };
    }
    if (!stats.isFile()) {
      return { ok: false, code: "not_a_file", message: `"${resolved.relative}" is not a regular file` };
    }
    size = stats.size;
  } catch (error) {
    return { ok: false, code: "not_found", message: `"${resolved.relative}" could not be read: ${String(error)}` };
  }

  if (size > maxBytes) {
    return {
      ok: false,
      code: "file_too_large",
      message: `"${resolved.relative}" is ${size} bytes, over the ${maxBytes} byte limit`,
    };
  }

  const buffer = Buffer.allocUnsafe(size);
  let fd: number | null = null;
  try {
    fd = openSync(resolved.absolute, "r");
    let read = 0;
    while (read < size) {
      const chunk = readSync(fd, buffer, read, size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, 8000).includes(0)) {
      return { ok: false, code: "binary_file", message: `"${resolved.relative}" is binary, not text` };
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, code: "binary_file", message: `"${resolved.relative}" is not valid UTF-8 text` };
    }
    return { ok: true, body: { path: resolved.relative, size: read, encoding: "utf8", content } };
  } catch (error) {
    return { ok: false, code: "not_found", message: `"${resolved.relative}" could not be read: ${String(error)}` };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do: the read already finished (or failed) honestly.
      }
    }
  }
}

export type TreeEntryType = "dir" | "file" | "symlink" | "other";

export interface TreeEntry {
  name: string;
  /** Workspace-relative, `/`-separated, so the app can request it back. */
  path: string;
  type: TreeEntryType;
  /** Bytes of a regular file; null for anything else (never estimated). */
  size: number | null;
}

export type TreeResult =
  | { ok: true; body: { path: string; entries: TreeEntry[]; truncated: boolean } }
  | { ok: false; code: FsErrorCode; message: string };

function typeOf(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): TreeEntryType {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

/** Orders a listing the way the editor shows it: directories first, then names. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type === "dir" && right.type !== "dir") return -1;
    if (right.type === "dir" && left.type !== "dir") return 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/** Lists one directory level inside the workspace. */
export function listWorkspaceTree(
  root: string,
  requested: string | null,
  maxEntries = DEFAULT_MAX_TREE_ENTRIES,
): TreeResult {
  const resolved = resolveInsideWorkspace(root, requested);
  if (!resolved.ok) return resolved;

  let dirents;
  try {
    if (!statSync(resolved.absolute).isDirectory()) {
      return { ok: false, code: "not_a_directory", message: `"${resolved.relative}" is not a directory` };
    }
    dirents = readdirSync(resolved.absolute, { withFileTypes: true });
  } catch (error) {
    return { ok: false, code: "not_found", message: `"${resolved.relative}" could not be listed: ${String(error)}` };
  }

  const entries: TreeEntry[] = [];
  for (const dirent of dirents) {
    const child = join(resolved.absolute, dirent.name);
    let size: number | null = null;
    if (dirent.isFile()) {
      try {
        size = statSync(child).size;
      } catch {
        size = null;
      }
    }
    const relativeChild = resolved.relative === "" ? dirent.name : `${resolved.relative}/${dirent.name}`;
    entries.push({ name: dirent.name, path: relativeChild, type: typeOf(dirent), size });
  }

  const sorted = sortTreeEntries(entries);
  const truncated = sorted.length > maxEntries;
  return {
    ok: true,
    body: {
      path: resolved.relative,
      entries: truncated ? sorted.slice(0, maxEntries) : sorted,
      truncated,
    },
  };
}
