/**
 * Pi / Gentle Shell extension entry point for the mobile bridge.
 *
 * This replaces the removed Rust daemon: the agent process itself serves the
 * loopback API (43721) and the device channel (43722). No sudo, no binary, no
 * install step — the extension only talks to Node's `http` module and Pi's
 * public extension API.
 *
 * Load it with `pi -e ./pi-extension/src/extension.ts`, or list the path in
 * `settings.json` (`extensions: ["/abs/path/pi-extension/src/extension.ts"]`).
 *
 * Lifecycle:
 *   session_start  → bind the live session + start both listeners
 *   message_end    → forward assistant output to attached devices
 *   session_shutdown → close every socket and free the ports
 *
 * Every failure is logged and swallowed: a busy port or a vanished phone must
 * never take the agent down.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBridge } from "./bridge.ts";
import type { Bridge, InputSink } from "./bridge.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { createDirectorySessionSource } from "./sessions.ts";

/** Only the slice of the Pi API this extension uses, so it stays easy to fake in tests. */
interface PiLike {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown;
  sendUserMessage?(content: string, options?: unknown): unknown;
}

export interface ExtensionOptions {
  apiPort?: number;
  devicePort?: number;
  /** Overrides Pi's session directory; `undefined` follows the live session. */
  sessionDir?: string | null;
  version?: string;
  logger?: Logger;
}

interface SessionBinding {
  getSessionId(): string | null;
  getSessionName(): string | null;
  getSessionDir(): string | null;
  isIdle(): boolean;
}

export interface GentleMovilRuntime {
  register(pi: ExtensionAPI): void;
  start(ctx?: unknown): Promise<void>;
  stop(): Promise<void>;
  readonly bridge: Bridge | null;
  readonly logger: Logger;
}

function readString(source: object, name: string): string | null {
  const candidate = (source as Record<string, unknown>)[name];
  if (typeof candidate !== "function") return null;
  try {
    const value = (candidate as () => unknown).call(source);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function bindContext(ctx: unknown): SessionBinding | null {
  if (!ctx || typeof ctx !== "object") return null;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!manager || typeof manager !== "object") return null;
  const isIdleMethod = (ctx as { isIdle?: unknown }).isIdle;
  return {
    getSessionId: () => readString(manager, "getSessionId"),
    getSessionName: () => readString(manager, "getSessionName"),
    getSessionDir: () => readString(manager, "getSessionDir"),
    isIdle: () => {
      if (typeof isIdleMethod !== "function") return true;
      try {
        return Boolean((isIdleMethod as () => unknown).call(ctx));
      } catch {
        return true;
      }
    },
  };
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content.trim().length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  const joined = parts.join("");
  return joined.trim().length > 0 ? joined : null;
}

function assistantTextFrom(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant") return null;
  return contentToText(candidate.content);
}

export function createGentleMovilExtension(options: ExtensionOptions = {}): GentleMovilRuntime {
  const logger = options.logger ?? createLogger();
  const config = loadConfig();
  const apiPort = options.apiPort ?? config.apiPort;
  const devicePort = options.devicePort ?? config.devicePort;
  const version = options.version ?? config.version;
  const sessionDirOverride = options.sessionDir;

  let binding: SessionBinding | null = null;
  let pi: PiLike | null = null;
  let bridge: Bridge | null = null;

  const sessionSource = createDirectorySessionSource({
    // `undefined` (not provided) means: follow whatever Pi reports at session_start.
    dir: () => (sessionDirOverride !== undefined ? sessionDirOverride : (binding?.getSessionDir() ?? null)),
    currentSessionId: () => binding?.getSessionId() ?? null,
    currentTitle: () => binding?.getSessionName() ?? null,
    statusFor: (id) => {
      const currentId = binding?.getSessionId() ?? null;
      if (!currentId || id !== currentId) return "unknown";
      return binding!.isIdle() ? "idle" : "busy";
    },
    logger,
  });

  const sink: InputSink = {
    input: async ({ text }) => {
      if (!pi || typeof pi.sendUserMessage !== "function") {
        throw new Error("no agent is available to receive input");
      }
      await pi.sendUserMessage(text);
      return { deliver: "agent" };
    },
  };

  async function start(ctx?: unknown): Promise<void> {
    if (ctx) binding = bindContext(ctx) ?? binding;
    if (bridge) return;
    const candidate = createBridge({ apiPort, devicePort, version, logger, sessionSource, sink });
    try {
      const address = await candidate.start();
      bridge = candidate;
      logger.info("extension.bridge_ready", {
        apiPort: address.api.port,
        devicePort: address.device.port,
        sessionId: binding?.getSessionId() ?? null,
      });
    } catch (error) {
      logger.error("extension.bridge_start_failed", { error, apiPort, devicePort });
      bridge = null;
    }
  }

  async function stop(): Promise<void> {
    const current = bridge;
    bridge = null;
    if (!current) return;
    try {
      await current.stop();
    } catch (error) {
      logger.error("extension.bridge_stop_failed", { error });
    }
  }

  function register(piApi: ExtensionAPI): void {
    pi = piApi as unknown as PiLike;
    piApi.on("session_start", async (_event, ctx) => {
      await start(ctx);
    });
    piApi.on("session_shutdown", async () => {
      await stop();
      binding = null;
      logger.info("extension.session_shutdown", {});
    });
    piApi.on("message_end", async (event) => {
      try {
        const text = assistantTextFrom((event as { message?: unknown } | undefined)?.message);
        if (!text || !bridge) return;
        const sessionId = binding?.getSessionId() ?? null;
        if (!sessionId) return;
        bridge.publishOutput(sessionId, text, "agent");
      } catch (error) {
        logger.error("extension.output_forward_failed", { error });
      }
    });
  }

  return {
    register,
    start,
    stop,
    logger,
    get bridge() {
      return bridge;
    },
  };
}

/** Default export consumed by Pi when the extension is loaded. */
export default function gentleMovilBridgeExtension(pi: ExtensionAPI): void {
  createGentleMovilExtension().register(pi);
}
