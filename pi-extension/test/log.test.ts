import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../src/log.ts";

test("every record is a single parseable JSON line", () => {
  const lines: string[] = [];
  const logger = createLogger({ component: "gentle-movil-bridge", write: (line) => lines.push(line) });

  logger.info("bridge.started", { apiPort: 43721, devicePort: 43722 });
  logger.error("ws.socket_error", { code: "ECONNRESET" });

  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.includes("\n"), false);
    const record = JSON.parse(line) as Record<string, unknown>;
    assert.equal(record.component, "gentle-movil-bridge");
    assert.equal(typeof record.ts, "string");
    assert.equal(typeof record.level, "string");
    assert.equal(typeof record.event, "string");
  }
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(first.event, "bridge.started");
  assert.equal(first.apiPort, 43721);
  const second = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.equal(second.level, "error");
  assert.equal(second.code, "ECONNRESET");
});

test("errors, circular values and undefined fields never break logging", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;
  const error = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  assert.doesNotThrow(() => {
    logger.error("ws.failure", { error, circular, missing: undefined, nested: { deep: { value: 1 } } });
  });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.event, "ws.failure");
  assert.equal((record.error as Record<string, unknown>).message, "socket hang up");
  assert.equal((record.error as Record<string, unknown>).code, "ECONNRESET");
  assert.equal((record.circular as Record<string, unknown>).name, "loop");
});

test("child loggers keep their base fields", () => {
  const lines: string[] = [];
  const logger = createLogger({ component: "gentle-movil-bridge", write: (line) => lines.push(line) });
  logger.child({ connectionId: 7 }).warn("ws.client_disconnected_mid_frame", { bufferedBytes: 12 });

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.component, "gentle-movil-bridge");
  assert.equal(record.connectionId, 7);
  assert.equal(record.bufferedBytes, 12);
  assert.equal(record.level, "warn");
});
