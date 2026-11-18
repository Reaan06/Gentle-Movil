#!/usr/bin/env node
/**
 * Standalone entry point for the Gentle Movil bridge.
 *
 *   node pi-extension/server.mjs
 *   node pi-extension/server.mjs --quiet     # only JSON log lines
 *
 * It runs the exact same `createBridge()` module the Pi extension uses; the
 * difference is that no agent is attached, so `input` frames are echoed back
 * (that is what the offline tests and `doctor` exercise). Inside Pi the bridge
 * forwards input to the live agent and streams its output instead.
 */

import { createBridge } from "./src/bridge.ts";
import { BIND_HOST, loadConfig } from "./src/config.ts";
import { createLogger } from "./src/log.ts";
import { createDirectorySessionSource } from "./src/sessions.ts";
import { PROTO } from "./src/frames.ts";

const quiet = process.argv.includes("--quiet");
const config = loadConfig();
const logger = createLogger();

const sessionSource = createDirectorySessionSource({ dir: config.sessionDir, logger });
const bridge = createBridge({
  apiPort: config.apiPort,
  devicePort: config.devicePort,
  version: config.version,
  logger,
  sessionSource,
});

let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info("server.signal", { signal });
  try {
    await bridge.stop();
  } catch (error) {
    logger.error("server.stop_failed", { error });
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  // The bridge guards every socket, but a stray exception must not kill the
  // agent that hosts it: log and keep serving.
  logger.error("server.uncaught_exception", { error });
});
process.on("unhandledRejection", (error) => {
  logger.error("server.unhandled_rejection", { error });
});

try {
  const address = await bridge.start();
  logger.info("server.ready", {
    host: BIND_HOST,
    apiPort: address.api.port,
    devicePort: address.device.port,
    proto: PROTO,
    version: config.version,
    sessionDir: config.sessionDir,
  });
  if (!quiet) {
    process.stdout.write(
      [
        `gentle-movil bridge (proto ${PROTO}, v${config.version}) — loopback only`,
        `  api    http://${BIND_HOST}:${address.api.port}/api/health`,
        `  device ws://${BIND_HOST}:${address.device.port}/ws/device`,
        `  sessions dir: ${config.sessionDir ?? "(none: the platform exposes no sessions here)"}`,
        "",
      ].join("\n"),
    );
  }
} catch (error) {
  logger.error("server.start_failed", { error });
  process.exitCode = 1;
}
