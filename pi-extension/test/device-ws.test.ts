import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { httpGet } from "./helpers/http.ts";
import { connectTestWs } from "./helpers/ws-client.ts";
import { startTestBridge } from "./helpers/bridge.ts";

test("a device client attaches to a session and gets input echoed back as output frames", async (t) => {
  const harness = await startTestBridge({
    sessions: [{ id: "s1", title: "Sesión uno", status: "idle", current: true }],
  });
  t.after(() => harness.stop());

  const client = await connectTestWs(harness.devicePort, "/ws/device");
  t.after(() => client.destroy());

  client.sendText({ type: "hello", proto: 1, client: "test-tablet" });
  const hello = await client.nextFrame();
  assert.equal(hello.type, "hello");
  assert.equal(hello.proto, 1);

  client.sendText({ type: "sessions.list", id: "r1" });
  const list = await client.nextFrame();
  assert.equal(list.type, "sessions.list");
  assert.equal(list.id, "r1");
  assert.deepEqual(
    (list.sessions as Array<Record<string, unknown>>).map((session) => [session.id, session.title, session.status]),
    [["s1", "Sesión uno", "idle"]],
  );

  client.sendText({ type: "session.attach", id: "r2", sessionId: "s1" });
  const attached = await client.nextFrame();
  assert.equal(attached.type, "session.attached");
  assert.equal(attached.sessionId, "s1");

  client.sendText({ type: "input", id: "r3", text: "hola desde la tablet" });
  const accepted = await client.nextFrame();
  assert.equal(accepted.type, "input.accepted");
  assert.equal(accepted.id, "r3");
  assert.equal(accepted.sessionId, "s1");
  assert.equal(accepted.deliver, "echo");

  const output = await client.nextFrame();
  assert.equal(output.type, "output");
  assert.equal(output.sessionId, "s1");
  assert.equal(output.text, "hola desde la tablet");
  assert.equal(output.source, "echo");
  assert.equal(output.seq, 1);
});

test("protocol errors are reported as error frames without killing the connection", async (t) => {
  const harness = await startTestBridge({ sessions: [{ id: "s1", title: "uno", status: "idle" }] });
  t.after(() => harness.stop());

  const client = await connectTestWs(harness.devicePort, "/ws/device");
  t.after(() => client.destroy());

  client.sendText({ type: "input", id: "e1", text: "sin adjuntar" });
  const notAttached = await client.nextFrame();
  assert.equal(notAttached.type, "error");
  assert.equal(notAttached.code, "not_attached");
  assert.equal(notAttached.id, "e1");

  client.sendText({ type: "session.attach", id: "e2", sessionId: "nope" });
  const unknown = await client.nextFrame();
  assert.equal(unknown.type, "error");
  assert.equal(unknown.code, "unknown_session");

  client.sendTextRaw("{not json");
  const badFrame = await client.nextFrame();
  assert.equal(badFrame.type, "error");
  assert.equal(badFrame.code, "bad_frame");

  client.sendText({ type: "hello", proto: 2, client: "future-phone" });
  const protoError = await client.nextFrame();
  assert.equal(protoError.type, "error");
  assert.equal(protoError.code, "unsupported_proto");

  client.sendText({ type: "nonsense" });
  const unsupported = await client.nextFrame();
  assert.equal(unsupported.type, "error");
  assert.equal(unsupported.code, "unsupported_type");

  // Still alive after every error.
  client.sendText({ type: "session.attach", id: "e3", sessionId: "s1" });
  const recovered = await client.nextFrame();
  assert.equal(recovered.type, "session.attached");
});

test("a client that vanishes mid-frame does not crash the server", async (t) => {
  const harness = await startTestBridge({ sessions: [{ id: "s1", title: "uno", status: "idle" }] });
  t.after(() => harness.stop());

  const doomed = await connectTestWs(harness.devicePort, "/ws/device");
  doomed.sendText({ type: "hello", proto: 1 });
  await doomed.nextFrame();

  // Header declares 200 bytes, only 5 arrive, then the socket dies.
  doomed.sendTruncatedTextFrame(200, 5);
  await delay(50);
  doomed.destroy();
  await delay(100);

  // The server keeps serving both surfaces.
  const health = await httpGet(harness.apiPort, "/api/health");
  assert.equal(health.status, 200);
  assert.equal((health.json as { bridge?: string }).bridge, "gentle-movil");

  const survivor = await connectTestWs(harness.devicePort, "/ws/device");
  t.after(() => survivor.destroy());
  survivor.sendText({ type: "sessions.list", id: "after-crash" });
  const list = await survivor.nextFrame();
  assert.equal(list.type, "sessions.list");
  assert.equal(list.id, "after-crash");

  assert.equal(harness.logged("ws.client_disconnected_mid_frame"), true);
  const midFrameLine = harness.logs.find((entry) => entry.record.event === "ws.client_disconnected_mid_frame");
  assert.ok(midFrameLine);
  // One-line JSON record: a single line, parseable, with level and event.
  assert.equal(midFrameLine.line.includes("\n"), false);
  assert.equal(typeof midFrameLine.record.level, "string");
  assert.equal(midFrameLine.record.component, "gentle-movil-bridge");
});

test("a bare socket that connects and closes is logged, never thrown", async (t) => {
  const harness = await startTestBridge();
  t.after(() => harness.stop());

  const client = await connectTestWs(harness.devicePort, "/ws/device");
  client.destroy();
  await delay(100);

  assert.equal(harness.logged("ws.client_connected"), true);
  assert.equal(harness.logged("ws.client_closed"), true);
  assert.equal(harness.logs.every((entry) => entry.line.split("\n").length === 1), true);
});
