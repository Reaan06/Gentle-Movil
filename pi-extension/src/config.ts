/**
 * Bridge configuration.
 *
 * The bind host is NOT configurable: the bridge only ever listens on loopback,
 * because the phone reaches it through the SSH tunnel opened after pairing. A
 * config knob for `0.0.0.0` would defeat the whole security model.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BIND_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 43721;
export const DEFAULT_DEVICE_PORT = 43722;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;

export const ENV_KEYS = {
  apiPort: "GENTLE_MOVIL_API_PORT",
  devicePort: "GENTLE_MOVIL_DEVICE_PORT",
  sessionDir: "GENTLE_MOVIL_SESSION_DIR",
} as const;

export interface BridgeConfig {
  apiPort: number;
  devicePort: number;
  sessionDir: string | null;
  version: string;
  maxPayloadBytes: number;
  maxInputBytes: number;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

/** Reads the semver advertised by `/api/health` and the websocket hello frame. */
export function readBridgeVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (isSemver(parsed.version)) return parsed.version;
  } catch {
    // Fall through: a missing package.json must not stop the bridge.
  }
  return "0.0.0";
}

/**
 * Ports come from the environment; anything that is not an integer port falls
 * back to the documented default instead of failing startup.
 */
export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return fallback;
  return value;
}

/**
 * Where Pi keeps session JSONL files. Honest by construction: when nothing can
 * be resolved (or the directory does not exist) this returns null, and the
 * sessions endpoint reports an empty list rather than inventing sessions.
 */
export function resolveSessionDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: Array<string | undefined> = [env[ENV_KEYS.sessionDir]];
  if (env.PI_SESSION_FILE) candidates.push(dirname(env.PI_SESSION_FILE));
  if (env.PI_CODING_AGENT_DIR) candidates.push(join(env.PI_CODING_AGENT_DIR, "sessions"));
  const home = env.HOME ?? safeHomedir();
  if (home) candidates.push(join(home, ".pi", "agent", "sessions"));

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function safeHomedir(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    apiPort: parsePort(env[ENV_KEYS.apiPort], DEFAULT_API_PORT),
    devicePort: parsePort(env[ENV_KEYS.devicePort], DEFAULT_DEVICE_PORT),
    sessionDir: resolveSessionDir(env),
    version: readBridgeVersion(),
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
  };
}
