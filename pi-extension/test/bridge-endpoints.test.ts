/**
 * The data endpoints the connected screens already call (task T8b):
 * `/api/git/status`, `/api/automations`, `/api/automations/<id>`,
 * `/api/exec/history`, `POST /api/exec`, `/api/fs/read` and `/api/fs/tree`.
 *
 * Every test boots the real bridge on ephemeral loopback ports and talks real
 * HTTP to it; git and fs fixtures live in `mkdtemp` directories outside the
 * worktree. Nothing here stubs the endpoint: a green test means the bridge
 * actually ran `git status`/`git diff --numstat` on disk.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { createBridge } from "../src/bridge.ts";
import type { BridgeOptions } from "../src/bridge.ts";
import { createLogger } from "../src/log.ts";
import { createStaticSessionSource } from "../src/sessions.ts";
import { httpGet } from "./helpers/http.ts";
import type { HttpResult } from "./helpers/http.ts";

interface Harness {
  apiPort: number;
  stop(): Promise<void>;
}

/** Boots the real bridge on ephemeral ports with a silent logger. */
async function startBridge(options: BridgeOptions = {}): Promise<Harness> {
  const bridge = createBridge({
    apiPort: 0,
    devicePort: 0,
    logger: createLogger({ component: "gentle-movil-bridge", write: () => {} }),
    sessionSource: createStaticSessionSource([], "pi"),
    ...options,
  });
  const address = await bridge.start();
  return { apiPort: address.api.port, stop: () => bridge.stop() };
}

/** A fresh temp directory the test removes when it ends. */
function tempDir(t: TestContext, prefix = "gentle-movil-bridge-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Bridge Test",
  GIT_AUTHOR_EMAIL: "bridge@test.invalid",
  GIT_COMMITTER_NAME: "Bridge Test",
  GIT_COMMITTER_EMAIL: "bridge@test.invalid",
};

/** Runs git for the fixture, never against the user's real config. */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

/** A real repository with one commit and a `main` branch. */
function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "tracked.txt"), "uno\ndos\n");
  git(dir, "add", "tracked.txt");
  git(dir, "commit", "-q", "-m", "base");
}

/** POST with a JSON body, mirroring the mobile client. */
function httpPost(port: number, path: string, payload: unknown, contentType = "application/json"): Promise<HttpResult> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: { "content-type": contentType, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("http request timed out")));
    req.end(body);
  });
}

interface GitFileRow {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  staged: boolean;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function gitStatusBody(result: HttpResult): {
  workspace: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileRow[];
} {
  return result.json as {
    workspace: string;
    branch: string | null;
    ahead: number | null;
    behind: number | null;
    files: GitFileRow[];
  };
}

function errorBody(result: HttpResult): ErrorBody["error"] {
  const body = result.json as Partial<ErrorBody> | undefined;
  assert.ok(body !== undefined, `body is not JSON: ${result.body}`);
  assert.ok(typeof body.error === "object" && body.error !== null, `no {error:{code,message}} in ${result.body}`);
  return body.error as ErrorBody["error"];
}

/* ------------------------------------------------------------------ *
 * GET /api/git/status
 * ------------------------------------------------------------------ */

test("GET /api/git/status reports real porcelain statuses and numstat of a temp repo", async (t) => {
  const repo = tempDir(t, "gentle-movil-git-");
  initRepo(repo);
  // One modified file (+2 additions, 0 deletions) and one untracked file.
  writeFileSync(join(repo, "tracked.txt"), "uno\ndos\ntres\ncuatro\n");
  writeFileSync(join(repo, "nuevo.txt"), "a\nb\nc\n");

  const harness = await startBridge({ workspace: repo });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/git/status");
  assert.equal(response.status, 200, response.body);
  const body = gitStatusBody(response);

  assert.equal(body.workspace, repo);
  assert.equal(body.branch, "main");
  // No upstream configured: the counters are null, never an invented 0.
  assert.equal(body.ahead, null);
  assert.equal(body.behind, null);

  const modified = body.files.find((file) => file.path === "tracked.txt");
  assert.deepEqual(modified, {
    path: "tracked.txt",
    status: "modified",
    additions: 2,
    deletions: 0,
    staged: false,
  });

  const untracked = body.files.find((file) => file.path === "nuevo.txt");
  assert.deepEqual(untracked, {
    path: "nuevo.txt",
    status: "added",
    additions: 3,
    deletions: 0,
    staged: false,
  });

  assert.equal(body.files.length, 2);
});

test("GET /api/git/status splits staged from unstaged and reports deletions, renames and upstream counters", async (t) => {
  const repo = tempDir(t, "gentle-movil-git-");
  const origin = tempDir(t, "gentle-movil-origin-");
  initRepo(repo);
  writeFileSync(join(repo, "gone.txt"), "x\ny\n");
  writeFileSync(join(repo, "old.txt"), "r\n");
  git(repo, "add", "gone.txt", "old.txt");
  git(repo, "commit", "-q", "-m", "mas");

  // A real upstream, then one local commit: ahead/behind are measured, not guessed.
  execFileSync("git", ["init", "--bare", "-q", origin], { cwd: repo, env: GIT_ENV, stdio: "ignore" });
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  writeFileSync(join(repo, "local.txt"), "solo local\n");
  git(repo, "add", "local.txt");
  git(repo, "commit", "-q", "-m", "local");

  // Staged and unstaged edit of the same file, a staged deletion, a staged rename.
  writeFileSync(join(repo, "tracked.txt"), "uno\ndos\ntres\n");
  git(repo, "add", "tracked.txt");
  writeFileSync(join(repo, "tracked.txt"), "uno\ndos\ntres\ncuatro\n");
  git(repo, "rm", "-q", "gone.txt");
  git(repo, "mv", "old.txt", "done.txt");

  const harness = await startBridge({ workspace: repo });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/git/status");
  assert.equal(response.status, 200, response.body);
  const body = gitStatusBody(response);

  assert.equal(body.ahead, 1);
  assert.equal(body.behind, 0);

  const rows = body.files.filter((file) => file.path === "tracked.txt");
  assert.deepEqual(rows, [
    { path: "tracked.txt", status: "modified", additions: 1, deletions: 0, staged: true },
    { path: "tracked.txt", status: "modified", additions: 1, deletions: 0, staged: false },
  ]);

  const deleted = body.files.find((file) => file.path === "gone.txt");
  assert.deepEqual(deleted, { path: "gone.txt", status: "deleted", additions: 0, deletions: 2, staged: true });

  const renamed = body.files.find((file) => file.path === "done.txt");
  assert.deepEqual(renamed, { path: "done.txt", status: "renamed", additions: 0, deletions: 0, staged: true });
});

test("GET /api/git/status answers 409 when the workspace is not a git repository", async (t) => {  const plain = tempDir(t, "gentle-movil-nogit-");
  writeFileSync(join(plain, "solo.txt"), "sin git\n");

  const harness = await startBridge({ workspace: plain });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/git/status");
  assert.equal(response.status, 409, response.body);
  const error = errorBody(response);
  assert.equal(error.code, "not_a_git_repository");
  assert.match(error.message, /git/i);
});

test("GET /api/git/status rejects a ?workspace= that escapes the workspace with 400", async (t) => {
  const root = tempDir(t, "gentle-movil-workspace-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  initRepo(repo);
  writeFileSync(join(root, "afuera.txt"), "no se toca\n");

  const harness = await startBridge({ workspace: repo });
  t.after(() => harness.stop());

  const relative = await httpGet(harness.apiPort, "/api/git/status?workspace=../..");
  assert.equal(relative.status, 400, relative.body);
  assert.equal(errorBody(relative).code, "path_outside_workspace");

  const absolute = await httpGet(harness.apiPort, `/api/git/status?workspace=${encodeURIComponent(root)}`);
  assert.equal(absolute.status, 400, absolute.body);
  assert.equal(errorBody(absolute).code, "path_outside_workspace");
});

/* ------------------------------------------------------------------ *
 * GET /api/automations (+ /<id>)
 * ------------------------------------------------------------------ */

test("GET /api/automations answers an empty list when the file does not exist", async (t) => {
  const dir = tempDir(t, "gentle-movil-automations-");
  const file = join(dir, "automations.json");

  const harness = await startBridge({ workspace: dir, automationsFile: file });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/automations");
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(response.json, { automations: [] });
});

test("GET /api/automations answers 500 carrying the parse error of a broken file", async (t) => {
  const dir = tempDir(t, "gentle-movil-automations-");
  const file = join(dir, "automations.json");
  writeFileSync(file, '{"automations": [\n');

  const harness = await startBridge({ workspace: dir, automationsFile: file });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/automations");
  assert.equal(response.status, 500, response.body);
  const error = errorBody(response);
  assert.equal(error.code, "automations_unreadable");
  // Honest body: the real JSON.parse complaint, not an empty success.
  assert.match(error.message, /JSON/i);
});

test("GET /api/automations/<id> returns the bare object and 404s an unknown id", async (t) => {
  const dir = tempDir(t, "gentle-movil-automations-");
  const file = join(dir, "automations.json");
  writeFileSync(
    file,
    JSON.stringify({
      automations: [
        {
          id: "nightly",
          name: "Limpieza nocturna",
          schedule: "0 3 * * *",
          enabled: true,
          lastRun: { at: "2026-11-18T03:00:00.000Z", ok: true, summary: "ok" },
          nextRun: "2026-11-19T03:00:00.000Z",
          steps: ["bun run lint"],
        },
      ],
    }),
  );

  const harness = await startBridge({ workspace: dir, automationsFile: file });
  t.after(() => harness.stop());

  const one = await httpGet(harness.apiPort, "/api/automations/nightly");
  assert.equal(one.status, 200, one.body);
  const automation = one.json as Record<string, unknown>;
  // The mobile editor parser expects the automation itself, not a wrapper.
  assert.equal(automation.id, "nightly");
  assert.equal(automation.name, "Limpieza nocturna");
  assert.equal(automation.schedule, "0 3 * * *");
  assert.equal(automation.enabled, true);
  assert.deepEqual(automation.steps, ["bun run lint"]);
  assert.equal("automations" in automation, false);

  const list = await httpGet(harness.apiPort, "/api/automations");
  assert.equal(list.status, 200, list.body);
  const listed = (list.json as { automations: Array<Record<string, unknown>> }).automations;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.lastRun, { at: "2026-11-18T03:00:00.000Z", ok: true, summary: "ok" });

  const missing = await httpGet(harness.apiPort, "/api/automations/no-existe");
  assert.equal(missing.status, 404, missing.body);
  const error = errorBody(missing);
  assert.equal(error.code, "automation_not_found");
  assert.match(error.message, /no-existe/);
});

/* ------------------------------------------------------------------ *
 * POST /api/exec (+ GET /api/exec/history)
 * ------------------------------------------------------------------ */

test("POST /api/exec without the opt-in answers 403 and never runs the command", async (t) => {
  const dir = tempDir(t, "gentle-movil-exec-");
  const harness = await startBridge({ workspace: dir, allowExec: false });
  t.after(() => harness.stop());

  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
  const response = await httpPost(harness.apiPort, "/api/exec", { command });
  assert.equal(response.status, 403, response.body);
  const error = errorBody(response);
  assert.equal(error.code, "exec_disabled");
  assert.match(error.message, /GENTLE_MOVIL_ALLOW_EXEC/);

  // Proof, not a claim: the command did not run, and nothing entered the ring.
  assert.equal(existsSync(join(dir, "marker.txt")), false);
  const history = await httpGet(harness.apiPort, "/api/exec/history");
  assert.equal(history.status, 200, history.body);
  assert.deepEqual(history.json, { commands: [] });
});

test("POST /api/exec with the opt-in runs the command, reports it, and lands in the history ring", async (t) => {
  const dir = tempDir(t, "gentle-movil-exec-");
  const harness = await startBridge({ workspace: dir, allowExec: true });
  t.after(() => harness.stop());

  const command = `"${process.execPath}" -e "process.stdout.write('hola desde la pc')"`;
  const response = await httpPost(harness.apiPort, "/api/exec", { command });
  assert.equal(response.status, 200, response.body);
  const result = response.json as { id: string; exitCode: number | null; output: string | null };
  assert.equal(typeof result.id, "string");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "hola desde la pc");

  // A non-zero exit is a real result, not an HTTP failure.
  const failing = await httpPost(harness.apiPort, "/api/exec", {
    command: `"${process.execPath}" -e "process.stderr.write('boom'); process.exit(3)"`,
  });
  assert.equal(failing.status, 200, failing.body);
  const failed = failing.json as { id: string; exitCode: number | null; output: string | null };
  assert.equal(failed.exitCode, 3);
  assert.match(failed.output ?? "", /boom/);

  const history = await httpGet(harness.apiPort, "/api/exec/history");
  assert.equal(history.status, 200, history.body);
  const commands = (history.json as { commands: Array<Record<string, unknown>> }).commands;
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], {
    id: result.id,
    command,
    at: commands[0]?.at,
    status: "sent",
    exitCode: 0,
    output: "hola desde la pc",
  });
  assert.equal(typeof commands[0]?.at, "string");
  assert.equal(commands[1]?.id, failed.id);
  assert.equal(commands[1]?.exitCode, 3);
  assert.equal(commands[1]?.status, "sent");
});

test("POST /api/exec refuses a shell command line and a command that never starts", async (t) => {
  const dir = tempDir(t, "gentle-movil-exec-");
  const harness = await startBridge({ workspace: dir, allowExec: true });
  t.after(() => harness.stop());

  // No shell runs here: a pipe would be a literal argument, so it is refused.
  const piped = await httpPost(harness.apiPort, "/api/exec", { command: "ls | wc -l" });
  assert.equal(piped.status, 400, piped.body);
  assert.equal(errorBody(piped).code, "shell_unsupported");

  const unknownBinary = await httpPost(harness.apiPort, "/api/exec", { command: "no-existe-esta-bin" });
  assert.equal(unknownBinary.status, 502, unknownBinary.body);
  assert.equal(errorBody(unknownBinary).code, "command_spawn_failed");

  // A command that never ran is `failed` in the ring, never a silent success.
  const history = await httpGet(harness.apiPort, "/api/exec/history");
  const commands = (history.json as { commands: Array<Record<string, unknown>> }).commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.command, "no-existe-esta-bin");
  assert.equal(commands[0]?.status, "failed");
  assert.equal(commands[0]?.exitCode, null);
});

/* ------------------------------------------------------------------ *
 * /api/fs/read and /api/fs/tree
 * ------------------------------------------------------------------ */

test("GET /api/fs/read returns the real content of a file inside the workspace", async (t) => {
  const dir = tempDir(t, "gentle-movil-fs-");
  const content = "# Notas\n\nprimera línea\n";
  writeFileSync(join(dir, "notas.md"), content);

  const harness = await startBridge({ workspace: dir });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/fs/read?path=notas.md");
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(response.json, {
    path: "notas.md",
    size: Buffer.byteLength(content),
    encoding: "utf8",
    content,
  });
});

test("GET /api/fs/read refuses a path that leaves the workspace with 400", async (t) => {
  const root = tempDir(t, "gentle-movil-fs-");
  const workspace = join(root, "proyecto");
  mkdirSync(workspace);
  writeFileSync(join(root, "secreto.txt"), "afuera\n");

  const harness = await startBridge({ workspace });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/fs/read?path=../../etc/passwd");
  assert.equal(response.status, 400, response.body);
  assert.equal(errorBody(response).code, "path_outside_workspace");

  const absolute = await httpGet(harness.apiPort, `/api/fs/read?path=${encodeURIComponent(join(root, "secreto.txt"))}`);
  assert.equal(absolute.status, 400, absolute.body);
  assert.equal(errorBody(absolute).code, "path_outside_workspace");
});

test("GET /api/fs/tree lists directories before files, one level", async (t) => {
  const dir = tempDir(t, "gentle-movil-fs-");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "README.md"), "# hola\n");

  const harness = await startBridge({ workspace: dir });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/fs/tree?path=");
  assert.equal(response.status, 200, response.body);
  const body = response.json as {
    path: string;
    truncated: boolean;
    entries: Array<{ name: string; path: string; type: string; size: number | null }>;
  };
  assert.equal(body.path, "");
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.entries.map((entry) => [entry.name, entry.path, entry.type]),
    [
      ["src", "src", "dir"],
      ["README.md", "README.md", "file"],
    ],
  );

  const nested = await httpGet(harness.apiPort, "/api/fs/tree?path=src");
  assert.equal(nested.status, 200, nested.body);
  const nestedBody = nested.json as { entries: Array<{ name: string; type: string }> };
  assert.deepEqual(
    nestedBody.entries.map((entry) => [entry.name, entry.type]),
    [["index.ts", "file"]],
  );
});

test("GET /api/fs/read refuses an oversized file with 413 and a binary one with 415", async (t) => {
  const dir = tempDir(t, "gentle-movil-fs-");
  writeFileSync(join(dir, "grande.txt"), "x".repeat(600 * 1024));
  writeFileSync(join(dir, "binario.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  const harness = await startBridge({ workspace: dir });
  t.after(() => harness.stop());

  const oversized = await httpGet(harness.apiPort, "/api/fs/read?path=grande.txt");
  assert.equal(oversized.status, 413, oversized.body);
  assert.equal(errorBody(oversized).code, "file_too_large");

  const binary = await httpGet(harness.apiPort, "/api/fs/read?path=binario.dat");
  assert.equal(binary.status, 415, binary.body);
  assert.equal(errorBody(binary).code, "binary_file");
});

/* ------------------------------------------------------------------ *
 * Identity and method handling of the new surface
 * ------------------------------------------------------------------ */

test("every new endpoint carries the bridge identity header", async (t) => {
  const dir = tempDir(t, "gentle-movil-identity-");
  initRepo(dir);
  writeFileSync(join(dir, "nuevo.txt"), "a\n");
  writeFileSync(join(dir, "automations.json"), JSON.stringify({ automations: [] }));
  writeFileSync(join(dir, "notas.md"), "hola\n");

  const harness = await startBridge({
    workspace: dir,
    automationsFile: join(dir, "automations.json"),
    allowExec: false,
  });
  t.after(() => harness.stop());

  const paths = [
    "/api/git/status",
    "/api/automations",
    "/api/exec/history",
    "/api/fs/read?path=notas.md",
    "/api/fs/tree?path=",
  ];
  for (const path of paths) {
    const response = await httpGet(harness.apiPort, path);
    assert.equal(response.status, 200, `${path}: ${response.body}`);
    // An impostor squatting the port cannot reproduce this header.
    assert.equal(response.headers["x-gentle-bridge"], "gentle-movil/1", path);
  }

  const refused = await httpPost(harness.apiPort, "/api/exec", { command: "echo hola" });
  assert.equal(refused.status, 403, refused.body);
  assert.equal(refused.headers["x-gentle-bridge"], "gentle-movil/1");

  const wrongMethod = await httpPost(harness.apiPort, "/api/git/status", {});
  assert.equal(wrongMethod.status, 405, wrongMethod.body);
  assert.equal(errorBody(wrongMethod).code, "method_not_allowed");
});
