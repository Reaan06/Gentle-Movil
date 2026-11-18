import { createBridge } from "../../src/bridge.ts";
import type { Bridge } from "../../src/bridge.ts";
import { createLogger } from "../../src/log.ts";
import type { SessionSeed, SessionSource } from "../../src/sessions.ts";
import { createStaticSessionSource } from "../../src/sessions.ts";

export interface LogEntry {
  line: string;
  record: Record<string, unknown>;
}

export interface TestBridge {
  bridge: Bridge;
  apiPort: number;
  devicePort: number;
  logs: LogEntry[];
  /** True when some log record has exactly this event name. */
  logged(event: string): boolean;
  stop(): Promise<void>;
}

/**
 * Boots the bridge on ephemeral loopback ports with an in-memory session source,
 * so tests never collide with a real bridge squatting 43721/43722.
 */
export async function startTestBridge(options: {
  sessions?: SessionSeed[];
  platform?: "pi" | "none";
  sessionSource?: SessionSource;
} = {}): Promise<TestBridge> {
  const logs: LogEntry[] = [];
  const logger = createLogger({
    component: "gentle-movil-bridge",
    write: (line: string) => {
      let record: Record<string, unknown> = {};
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        record = { unparseable: line };
      }
      logs.push({ line, record });
    },
  });
  const bridge = createBridge({
    apiPort: 0,
    devicePort: 0,
    logger,
    sessionSource:
      options.sessionSource ??
      createStaticSessionSource(options.sessions ?? [], options.platform ?? "pi"),
  });
  const address = await bridge.start();
  return {
    bridge,
    apiPort: address.api.port,
    devicePort: address.device.port,
    logs,
    logged: (event: string) => logs.some((entry) => entry.record.event === event),
    stop: () => bridge.stop(),
  };
}
