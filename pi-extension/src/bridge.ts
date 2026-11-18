/**
 * The mobile bridge: plain HTTP + WebSocket on loopback, nothing else.
 *
 * This module is deliberately framework-free — it only needs Node. The Pi
 * extension entry (`extension.ts`) wires it to a live agent session, and
 * `server.mjs` runs it standalone for `doctor`, `curl` and the offline tests.
 *
 * Two ports, two surfaces, both bound to 127.0.0.1:
 *   43721  HTTP API (identity + session list) for the CLI and the phone
 *   43722  device channel (WebSocket at /ws/device)
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { BIND_HOST, DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_PAYLOAD_BYTES, readBridgeVersion } from "./config.ts";
import {
  ERROR_CODES,
  PROTO,
  attachedFrame,
  detachedFrame,
  errorFrame,
  helloFrame,
  inputAcceptedFrame,
  outputFrame,
  parseClientFrame,
  pongFrame,
  sessionsFrame,
} from "./frames.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import type { AgentSession, SessionSource } from "./sessions.ts";
import { createStaticSessionSource } from "./sessions.ts";
import { attachWebSocketServer } from "./ws.ts";
import type { WsConnection, WsServerHandle } from "./ws.ts";

/** Identity advertised by `GET /api/health`. Clients use it to prove what listens. */
export const BRIDGE_IDENTITY = {
  app: "gentle-shell",
  bridge: "gentle-movil",
  proto: PROTO,
} as const;

export interface InputRequest {
  sessionId: string;
  text: string;
}

export interface InputResult {
  /** `agent` when the text reached a live agent, `echo` when nobody is attached to one. */
  deliver: "agent" | "echo";
}

export interface InputSink {
  input(request: InputRequest): InputResult | Promise<InputResult>;
}

/** Standalone mode has no agent to inject into: it echoes so clients can self-test. */
export function createEchoSink(): InputSink {
  return { input: () => ({ deliver: "echo" }) };
}

export interface BridgeOptions {
  apiPort?: number;
  devicePort?: number;
  version?: string;
  logger?: Logger;
  sessionSource?: SessionSource;
  sink?: InputSink;
  maxPayloadBytes?: number;
  maxInputBytes?: number;
}

export interface ListenerAddress {
  host: string;
  port: number;
}

export interface BridgeAddresses {
  host: string;
  api: ListenerAddress;
  device: ListenerAddress;
}

export interface Bridge {
  start(): Promise<BridgeAddresses>;
  stop(): Promise<void>;
  addresses(): BridgeAddresses;
  publishOutput(sessionId: string, text: string, source?: "agent" | "echo"): void;
  readonly version: string;
  readonly sessionSource: SessionSource;
}

interface DeviceState {
  connection: WsConnection;
  sessionId: string | null;
  seq: number;
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function methodNotAllowed(response: ServerResponse): void {
  writeJson(response, 405, { error: "method_not_allowed" });
}

function addressOf(server: Server, configuredPort: number): ListenerAddress {
  const address = server.address();
  if (address && typeof address === "object") {
    return { host: address.address, port: address.port };
  }
  return { host: BIND_HOST, port: configuredPort };
}

function normalizeSession(session: AgentSession): AgentSession {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    current: session.current,
  };
}

export function createBridge(options: BridgeOptions = {}): Bridge {
  const logger = options.logger ?? createLogger();
  const sessionSource = options.sessionSource ?? createStaticSessionSource([], "none");
  const sink = options.sink ?? createEchoSink();
  const version = options.version ?? readBridgeVersion();
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;

  const configuredApiPort = options.apiPort ?? 43721;
  const configuredDevicePort = options.devicePort ?? 43722;

  const devices = new Map<WsConnection, DeviceState>();
  let wsHandle: WsServerHandle | null = null;
  let started = false;
  let starting: Promise<BridgeAddresses> | null = null;

  const apiServer = createServer((request, response) => {
    try {
      routeApi(request, response, {
        logger,
        version,
        listSessions: () => listSessions(),
      });
    } catch (error) {
      logger.error("http.api_handler_error", { error, path: request.url });
      if (!response.headersSent) writeJson(response, 500, { error: "internal_error" });
      else response.end();
    }
  });

  const deviceServer = createServer((request, response) => {
    try {
      // The device port is a websocket surface. It answers the identity document so a
      // client can prove the program listening on both ports is this bridge (the
      // identity is not a secret: authentication is the SSH tunnel the phone owns);
      // every other plain HTTP request there is a 404.
      if ((request.url ?? "/").split("?")[0] === "/api/health") {
        writeJson(response, 200, {
          app: BRIDGE_IDENTITY.app,
          bridge: BRIDGE_IDENTITY.bridge,
          proto: BRIDGE_IDENTITY.proto,
          version,
        });
        return;
      }
      writeJson(response, 404, { error: "not_found", path: request.url ?? "/" });
    } catch (error) {
      logger.error("http.device_handler_error", { error, path: request.url });
      try {
        response.destroy();
      } catch {
        // Already gone.
      }
    }
  });

  function listSessions(): AgentSession[] {
    try {
      return sessionSource.list().map(normalizeSession);
    } catch (error) {
      logger.error("sessions.list_failed", { error, platform: sessionSource.platform });
      return [];
    }
  }

  function sendFrame(state: DeviceState, frame: Record<string, unknown>): void {
    try {
      state.connection.send(JSON.stringify(frame));
    } catch (error) {
      logger.warn("ws.send_frame_failed", { connectionId: state.connection.id, error });
    }
  }

  function handleDeviceMessage(state: DeviceState, raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      logger.warn("ws.bad_json", { connectionId: state.connection.id, bytes: Buffer.byteLength(raw, "utf8") });
      sendFrame(state, errorFrame(ERROR_CODES.badFrame, "frame is not valid JSON"));
      return;
    }

    const parsed = parseClientFrame(decoded, { maxInputBytes });
    if (!parsed.ok) {
      sendFrame(state, errorFrame(parsed.code, parsed.message, { id: parsed.id, sessionId: parsed.sessionId }));
      return;
    }

    const frame = parsed.frame;
    switch (frame.type) {
      case "hello": {
        logger.info("ws.hello", { connectionId: state.connection.id, client: frame.client ?? null });
        sendFrame(state, helloFrame({ version }));
        return;
      }
      case "sessions.list": {
        const sessions = listSessions();
        logger.debug("ws.sessions_list", { connectionId: state.connection.id, count: sessions.length });
        sendFrame(state, sessionsFrame(sessions, frame.id));
        return;
      }
      case "session.attach": {
        const session = listSessions().find((candidate) => candidate.id === frame.sessionId);
        if (!session) {
          logger.warn("ws.attach_unknown_session", {
            connectionId: state.connection.id,
            sessionId: frame.sessionId,
          });
          sendFrame(
            state,
            errorFrame(ERROR_CODES.unknownSession, `unknown session ${frame.sessionId}`, {
              id: frame.id,
              sessionId: frame.sessionId,
            }),
          );
          return;
        }
        state.sessionId = session.id;
        logger.info("ws.session_attached", { connectionId: state.connection.id, sessionId: session.id });
        sendFrame(state, attachedFrame(session, frame.id));
        return;
      }
      case "session.detach": {
        if (!state.sessionId) {
          sendFrame(state, errorFrame(ERROR_CODES.notAttached, "no session is attached", { id: frame.id }));
          return;
        }
        const previous = state.sessionId;
        state.sessionId = null;
        logger.info("ws.session_detached", { connectionId: state.connection.id, sessionId: previous });
        sendFrame(state, detachedFrame(previous, frame.id));
        return;
      }
      case "input": {
        const sessionId = state.sessionId;
        if (!sessionId) {
          sendFrame(state, errorFrame(ERROR_CODES.notAttached, "attach a session before sending input", { id: frame.id }));
          return;
        }
        void deliverInput(state, frame.id, sessionId, frame.text);
        return;
      }
      case "ping": {
        sendFrame(state, pongFrame(frame.id));
        return;
      }
      default:
        sendFrame(state, errorFrame(ERROR_CODES.unsupportedType, "unsupported frame"));
        return;
    }
  }

  async function deliverInput(state: DeviceState, requestId: string | undefined, sessionId: string, text: string): Promise<void> {
    try {
      const result = await sink.input({ sessionId, text });
      const deliver = result?.deliver === "agent" ? "agent" : "echo";
      sendFrame(state, inputAcceptedFrame(sessionId, deliver, requestId));
      if (deliver === "echo") {
        // No agent behind this bridge instance: mirror the input back so the
        // paired phone can prove the round-trip end to end.
        publishOutput(sessionId, text, "echo");
      }
      logger.debug("ws.input_delivered", { connectionId: state.connection.id, sessionId, deliver, bytes: Buffer.byteLength(text, "utf8") });
    } catch (error) {
      logger.error("ws.input_failed", { connectionId: state.connection.id, sessionId, error });
      sendFrame(state, errorFrame(ERROR_CODES.inputFailed, "the agent rejected the input", { id: requestId, sessionId }));
    }
  }

  function publishOutput(sessionId: string, text: string, source: "agent" | "echo" = "agent"): void {
    if (typeof sessionId !== "string" || sessionId.length === 0 || typeof text !== "string") return;
    for (const state of devices.values()) {
      if (state.sessionId !== sessionId) continue;
      state.seq += 1;
      sendFrame(state, outputFrame(sessionId, text, source, state.seq));
    }
  }

  function listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: BIND_HOST, port });
    });
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  const bridge: Bridge = {
    version,
    sessionSource,

    addresses: () => ({
      host: BIND_HOST,
      api: addressOf(apiServer, configuredApiPort),
      device: addressOf(deviceServer, configuredDevicePort),
    }),

    start: () => {
      if (started) return Promise.resolve(bridge.addresses());
      if (starting) return starting;
      starting = (async () => {
        await listen(apiServer, configuredApiPort);
        try {
          await listen(deviceServer, configuredDevicePort);
        } catch (error) {
          await closeServer(apiServer);
          starting = null;
          logger.error("bridge.device_port_failed", { error, port: configuredDevicePort });
          throw error;
        }

        wsHandle = attachWebSocketServer(deviceServer, {
          path: "/ws/device",
          logger,
          maxPayloadBytes,
          onConnection: (connection) => {
            const state: DeviceState = { connection, sessionId: null, seq: 0 };
            devices.set(connection, state);
            logger.info("ws.client_connected", { connectionId: connection.id, remote: connection.remote });
            connection.onMessage((raw) => {
              try {
                handleDeviceMessage(state, raw);
              } catch (error) {
                logger.error("ws.frame_handler_error", { connectionId: connection.id, error });
                sendFrame(state, errorFrame(ERROR_CODES.internal, "the bridge failed to handle the frame"));
              }
            });
            connection.onClose((info) => {
              devices.delete(connection);
              if (info.midFrame) {
                logger
                  .child({ connectionId: connection.id })
                  .warn("ws.client_disconnected_mid_frame", { bufferedBytes: info.bufferedBytes, closeCode: info.code });
              } else {
                logger
                  .child({ connectionId: connection.id })
                  .info("ws.client_closed", { closeCode: info.code });
              }
            });
          },
        });

        started = true;
        const addresses = bridge.addresses();
        logger.info("bridge.started", {
          host: addresses.host,
          apiPort: addresses.api.port,
          devicePort: addresses.device.port,
          version,
          proto: PROTO,
          platform: sessionSource.platform,
        });
        return addresses;
      })();
      void starting.catch(() => {
        starting = null;
      });
      return starting;
    },

    stop: async () => {
      wsHandle?.closeAll(1001, "bridge stopping");
      wsHandle = null;
      devices.clear();
      const wasStarted = started;
      started = false;
      starting = null;
      await Promise.all([closeServer(apiServer), closeServer(deviceServer)]);
      if (wasStarted) logger.info("bridge.stopped", {});
    },

    publishOutput,
  };

  return bridge;
}

interface RouteContext {
  logger: Logger;
  version: string;
  listSessions: () => AgentSession[];
}

function routeApi(request: IncomingMessage, response: ServerResponse, context: RouteContext): void {
  const path = (request.url ?? "/").split("?")[0];

  if (path === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(response);
      return;
    }
    writeJson(response, 200, {
      app: BRIDGE_IDENTITY.app,
      bridge: BRIDGE_IDENTITY.bridge,
      proto: BRIDGE_IDENTITY.proto,
      version: context.version,
    });
    return;
  }

  if (path === "/api/sessions") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(response);
      return;
    }
    writeJson(response, 200, context.listSessions());
    return;
  }

  writeJson(response, 404, { error: "not_found", path });
}
