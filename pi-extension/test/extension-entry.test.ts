import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extensionEntry, { createGentleMovilExtension } from "../src/extension.ts";
import { httpGet } from "./helpers/http.ts";
import { connectTestWs } from "./helpers/ws-client.ts";

test("the extension entry is a factory Pi can call with its API object", () => {
  assert.equal(typeof extensionEntry, "function");
});

test("start wires the bridge to the session and the agent, shutdown releases the ports", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "gentle-movil-bridge-extension-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));

  const runtime = createGentleMovilExtension({ apiPort: 0, devicePort: 0, sessionDir });
  t.after(() => runtime.stop());

  const sent: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const fakePi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    sendUserMessage(content: string) {
      sent.push(content);
      return Promise.resolve();
    },
  };

  runtime.register(fakePi as never);
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");
  assert.equal(typeof handlers.get("message_end"), "function");

  const fakeCtx = {
    cwd: sessionDir,
    isIdle: () => false,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionName: () => "Sesión puente",
      getSessionFile: () => join(sessionDir, "s1.jsonl"),
      getSessionDir: () => sessionDir,
      getHeader: () => ({ cwd: sessionDir }),
    },
  };

  await handlers.get("session_start")!({ reason: "startup" }, fakeCtx);
  const address = runtime.bridge!.addresses();
  assert.equal(address.host, "127.0.0.1");

  const health = await httpGet(address.api.port, "/api/health");
  assert.equal(health.status, 200);

  const sessions = await httpGet(address.api.port, "/api/sessions");
  assert.deepEqual(sessions.json, [
    {
      id: "s1",
      title: "Sesión puente",
      status: "busy",
      cwd: null,
      updatedAt: null,
      current: true,
    },
  ]);

  const client = await connectTestWs(address.device.port, "/ws/device");
  client.sendText({ type: "session.attach", id: "a1", sessionId: "s1" });
  const attached = await client.nextFrame();
  assert.equal(attached.type, "session.attached");

  client.sendText({ type: "input", id: "i1", text: "dale" });
  const accepted = await client.nextFrame();
  assert.equal(accepted.type, "input.accepted");
  assert.equal(accepted.deliver, "agent");
  assert.deepEqual(sent, ["dale"]);
  client.destroy();

  await handlers.get("session_shutdown")!({ reason: "quit" }, fakeCtx);
  assert.equal(runtime.bridge, null);
  await assert.rejects(() => httpGet(address.api.port, "/api/health"));
});
