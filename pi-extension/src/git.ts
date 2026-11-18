/**
 * Real git facts for `GET /api/git/status`.
 *
 * No dependencies, no shell: every command is spawned with an argument array
 * (`execFile`, never `exec`) inside the requested workspace, so a path from the
 * query can never become part of a command line.
 *
 * The three readings the endpoint needs:
 *   1. `git status --porcelain=v1 -z --untracked-files=all` — what changed and
 *      on which side (index `X`, worktree `Y`);
 *   2. `git diff --numstat -z` and `git diff --cached --numstat -z` — the real
 *      added/removed line counts of each side;
 *   3. `git rev-parse --abbrev-ref HEAD` + `git rev-list --count --left-right`
 *      — branch and how far it is from its upstream.
 *
 * Paths are repo-root-relative (what `git status` prints, also from a
 * subdirectory) and stay consistent between status and numstat because both
 * commands run in the same workspace. When a file is changed in the index and
 * in the worktree it appears twice, exactly like `git status` prints it: once
 * `staged: true` and once `staged: false`.
 *
 * Untracked files have no diff, so their `additions` is the real line count of
 * the file on disk (bounded read); nothing is estimated.
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitFileEntry {
  path: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  staged: boolean;
}

export interface GitStatusReport {
  workspace: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileEntry[];
}

export type GitStatusResult =
  | { ok: true; report: GitStatusReport }
  | { ok: false; code: "not_a_git_repository"; message: string }
  | { ok: false; code: "git_unavailable"; message: string };

export type GitFailureCode = "not_a_git_repository" | "git_unavailable";

/** Ceiling of the porcelain/numstat stream we are willing to buffer. */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Untracked files are counted from disk; beyond this we report 0 instead of guessing. */
const MAX_UNTRACKED_COUNT_BYTES = 256 * 1024;

interface GitRun {
  ok: boolean;
  stdout: string;
  /** Exit code when git itself exited non-zero, null when it never started. */
  code: number | null;
  missing: boolean;
}

/** Runs git with an argument array; a missing binary is reported, never thrown. */
function runGit(args: string[], cwd: string): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.quotepath=false", ...args],
      { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        void stderr;
        if (!error) {
          resolve({ ok: true, stdout: typeof stdout === "string" ? stdout : "", code: 0, missing: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        const exitCode = typeof code === "number" ? code : null;
        resolve({
          ok: false,
          stdout: typeof stdout === "string" ? stdout : "",
          code: exitCode,
          missing: code === "ENOENT",
        });
      },
    );
  });
}

interface StatusRecord {
  index: string;
  worktree: string;
  path: string;
}

/** Parses `git status --porcelain=v1 -z`, including the rename origin token. */
export function parsePorcelain(raw: string): StatusRecord[] {
  const records: StatusRecord[] = [];
  const tokens = raw.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.length < 4) continue;
    const indexCode = token.slice(0, 1);
    const worktreeCode = token.slice(1, 2);
    const path = token.slice(3);
    if (indexCode === "!" && worktreeCode === "!") continue; // ignored files
    if (indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C") {
      index += 1; // the origin path of a rename/copy, not a record of its own
    }
    if (path === "") continue;
    records.push({ index: indexCode, worktree: worktreeCode, path });
  }
  return records;
}

interface Numstat {
  additions: number;
  deletions: number;
}

/** `-` (binary) counts as 0: numstat measured no lines, we do not invent any. */
function toCount(field: string | undefined): number {
  if (field === undefined || field === "-" || field === "") return 0;
  const value = Number(field);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Parses `git diff --numstat -z`. A rename arrives as
 * `"<add>\t<del>\t\0<old>\0<new>\0"`: the entry is filed under the new path,
 * which is the path `git status` reports too.
 */
export function parseNumstat(raw: string): Map<string, Numstat> {
  const entries = new Map<string, Numstat>();
  const tokens = raw.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "") continue;
    const fields = token.split("\t");
    const additions = toCount(fields[0]);
    const deletions = toCount(fields[1]);
    let path = fields[2] ?? "";
    if (path === "") {
      index += 1; // old path
      index += 1;
      path = tokens[index] ?? ""; // new path
    }
    if (path !== "") entries.set(path, { additions, deletions });
  }
  return entries;
}

/** `added | modified | deleted | renamed` for one porcelain code, or null. */
function statusOf(code: string): GitFileStatus | null {
  switch (code) {
    case "A":
    case "C": // a copy is a new file for the app
    case "?":
      return "added";
    case "M":
    case "T": // typechange: the file changed, it is still there
    case "U": // unmerged: the human has to resolve it, it is modified
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return null;
  }
}

/** Real line count of an untracked file; 0 when it is binary or too big to count. */
function countLines(path: string): number {
  let fd: number | null = null;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_UNTRACKED_COUNT_BYTES) return 0;
    const buffer = Buffer.allocUnsafe(stats.size);
    fd = openSync(path, "r");
    let read = 0;
    while (read < stats.size) {
      const chunk = readSync(fd, buffer, read, stats.size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, 8000).includes(0)) return 0; // binary: no line count to report
    const text = bytes.toString("utf8");
    if (text === "") return 0;
    const lines = text.split("\n");
    return text.endsWith("\n") ? lines.length - 1 : lines.length;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do: the count is best-effort by design.
      }
    }
  }
}

function parseAheadBehind(raw: string): { ahead: number; behind: number } | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind) || ahead < 0 || behind < 0) return null;
  return { ahead, behind };
}

/**
 * Reads the real status of `workspace`.
 *
 * Honest failures: a directory outside any work tree answers
 * `not_a_git_repository`; a host without the `git` binary answers
 * `git_unavailable` (the bridge never pretends the tree is clean).
 */
export async function readGitStatus(workspace: string): Promise<GitStatusResult> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], workspace);
  if (inside.missing) {
    return { ok: false, code: "git_unavailable", message: "git is not installed on this host, so the bridge cannot read the workspace" };
  }
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      code: "not_a_git_repository",
      message: `${workspace} is not inside a git working tree`,
    };
  }

  const [status, unstaged, staged, branch, upstream, topLevel] = await Promise.all([
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace),
    runGit(["diff", "--numstat", "-z"], workspace),
    runGit(["diff", "--cached", "--numstat", "-z"], workspace),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspace),
    runGit(["rev-list", "--count", "--left-right", "HEAD...@{upstream}"], workspace),
    runGit(["rev-parse", "--show-toplevel"], workspace),
  ]);

  if (!status.ok) {
    return {
      ok: false,
      code: "not_a_git_repository",
      message: `git status failed in ${workspace} (exit ${status.code ?? "unknown"})`,
    };
  }

  // Porcelain paths are repo-root-relative (also from a subdirectory), so the
  // untracked line count has to be read from the work tree root.
  const workTreeRoot = topLevel.ok && topLevel.stdout.trim() !== "" ? topLevel.stdout.trim() : workspace;

  const unstagedCounts = unstaged.ok ? parseNumstat(unstaged.stdout) : new Map<string, Numstat>();
  const stagedCounts = staged.ok ? parseNumstat(staged.stdout) : new Map<string, Numstat>();

  const files: GitFileEntry[] = [];
  for (const record of parsePorcelain(status.stdout)) {
    const untracked = record.index === "?" && record.worktree === "?";
    if (untracked) {
      files.push({
        path: record.path,
        status: "added",
        additions: countLines(join(workTreeRoot, record.path)),
        deletions: 0,
        staged: false,
      });
      continue;
    }

    const stagedStatus = statusOf(record.index);
    if (stagedStatus !== null) {
      const counts = stagedCounts.get(record.path) ?? { additions: 0, deletions: 0 };
      files.push({ path: record.path, status: stagedStatus, ...counts, staged: true });
    }

    const worktreeStatus = statusOf(record.worktree);
    if (worktreeStatus !== null) {
      const counts = unstagedCounts.get(record.path) ?? { additions: 0, deletions: 0 };
      files.push({ path: record.path, status: worktreeStatus, ...counts, staged: false });
    }
  }

  const branchName = branch.ok ? branch.stdout.trim() : "";
  const counters = upstream.ok ? parseAheadBehind(upstream.stdout) : null;

  return {
    ok: true,
    report: {
      workspace,
      // A detached HEAD is `HEAD`: the app shows no branch instead of the word.
      branch: branchName === "" || branchName === "HEAD" ? null : branchName,
      // No upstream configured: null, never an invented 0.
      ahead: counters?.ahead ?? null,
      behind: counters?.behind ?? null,
      files,
    },
  };
}
