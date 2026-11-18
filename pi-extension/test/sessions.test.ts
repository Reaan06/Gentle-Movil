import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { httpGet } from "./helpers/http.ts";
import { startTestBridge } from "./helpers/bridge.ts";
import { createDirectorySessionSource, createStaticSessionSource } from "../src/sessions.ts";

test("/api/sessions returns a valid JSON list, empty and honest when there are none", async (t) => {
  const harness = await startTestBridge({ sessions: [], platform: "none" });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/sessions");

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");
  assert.ok(Array.isArray(response.json), "sessions payload must be a JSON array");
  assert.deepEqual(response.json, []);
});

test("/api/sessions lists known sessions with id, title and status", async (t) => {
  const harness = await startTestBridge({
    sessions: [
      { id: "01a1ef85-55dd-704b-a6a9-bba2e09790fd", title: "Pivote sin daemon", status: "busy", current: true },
      { id: "4f4c0f1e-0000-4000-8000-000000000002", title: null, status: "unknown" },
    ],
  });
  t.after(() => harness.stop());

  const response = await httpGet(harness.apiPort, "/api/sessions");
  const sessions = response.json as Array<Record<string, unknown>>;

  assert.equal(response.status, 200);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => [session.id, session.title, session.status]),
    [
      ["01a1ef85-55dd-704b-a6a9-bba2e09790fd", "Pivote sin daemon", "busy"],
      ["4f4c0f1e-0000-4000-8000-000000000002", null, "unknown"],
    ],
  );
  assert.equal(sessions[0]!.current, true);
  assert.equal(sessions[1]!.current, false);
});

test("a missing session directory reports no sessions instead of throwing", async (t) => {
  const missingDir = join(tmpdir(), "gentle-movil-bridge-no-such-dir-4a1d");
  await rm(missingDir, { recursive: true, force: true });
  const source = createDirectorySessionSource({ dir: missingDir });

  assert.equal(source.platform, "none");
  assert.deepEqual(source.list(), []);

  const harness = await startTestBridge({ sessionSource: source });
  t.after(() => harness.stop());
  const response = await httpGet(harness.apiPort, "/api/sessions");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, []);
});

test("the directory source reads id, name and current marker from real session files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gentle-movil-bridge-sessions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sessionFile = join(dir, "2026-11-18T16-37-35-326Z_01a1ef85-55dd-704b-a6a9-bba2e09790fd.jsonl");
  const lines = [
    {
      type: "session",
      version: 3,
      id: "01a1ef85-55dd-704b-a6a9-bba2e09790fd",
      timestamp: "2026-11-18T16:37:35.326Z",
      cwd: "/home/reaan/Contrib/gentle-movil",
    },
    {
      type: "message",
      id: "a0b1c2d3",
      parentId: null,
      timestamp: "2026-11-18T16:37:36.000Z",
      message: { role: "user", content: "escribí el puente como extensión", timestamp: 1763000000000 },
    },
    {
      type: "session_info",
      id: "k1l2m3n4",
      parentId: "a0b1c2d3",
      timestamp: "2026-11-18T16:40:00.000Z",
      name: "Pivote sin daemon",
    },
  ];
  await writeFile(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const source = createDirectorySessionSource({ dir, currentSessionId: () => "01a1ef85-55dd-704b-a6a9-bba2e09790fd" });
  assert.equal(source.platform, "pi");
  const sessions = source.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.id, "01a1ef85-55dd-704b-a6a9-bba2e09790fd");
  assert.equal(sessions[0]!.title, "Pivote sin daemon");
  assert.equal(sessions[0]!.current, true);
  assert.equal(sessions[0]!.status, "unknown");
  assert.equal(sessions[0]!.cwd, "/home/reaan/Contrib/gentle-movil");
});

test("session status comes from the status provider when the platform exposes one", async () => {
  const source = createStaticSessionSource([{ id: "s1", title: "one", status: "idle" }]);
  assert.equal(source.platform, "pi");
  assert.deepEqual(
    source.list().map((session) => [session.id, session.status, session.current]),
    [["s1", "idle", false]],
  );
});
