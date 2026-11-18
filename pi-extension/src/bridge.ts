/**
 * The mobile bridge: plain HTTP + WebSocket on loopback, nothing else.
 *
 * This module is deliberately framework-free — it only needs Node. The Pi
 * extension entry (`extension.ts`) wires it to a live agent session, and
 * `server.mjs` runs it standalone for `doctor`, `curl` and the offline tests.
 *
 * Two ports, two surfaces, both bound to 127.0.0.1:
 *   43721  HTTP API (identity, sessions, git, automations, exec, fs) for the CLI and the phone
 *   43722  device channel (WebSocket at /ws/device)
 *
 * Every JSON answer carries the `x-gentle-bridge` identity header, so a client
 * that reaches a stranger on one of these ports still knows it is not us.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { readAutomations, findAutomation, defaultAutomationsFile } from "./automations.ts";
import { BIND_HOST, DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_PAYLOAD_BYTES, readBridgeVersion } from "./config.ts";
import {
  EXEC_HISTORY_CAPACITY,
  ALLOW_EXEC_ENV,
  createExecRing,
  isExecEnabled,
  runCommand,
  statusOfResult,
  tokenizeCommand,
} from "./exec.ts";
import type { ExecRing } from "./exec.ts";
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_TREE_ENTRIES,
  isDirectory,
  listWorkspaceTree,
  readWorkspaceFile,
  resolveInsideWorkspace,
} from "./fs.ts";
import type { FsErrorCode } from "./fs.ts";
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
import { readGitStatus } from "./git.ts";
import { BRIDGE_IDENTITY, methodNotAllowed as methodNotAllowedJson, readJsonBody, requestUrl, writeError, writeJson } from "./http.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import type { AgentSession, SessionSource } from "./sessions.ts";
import { createStaticSessionSource } from "./sessions.ts";
import { attachWebSocketServer } from "./ws.ts";
import type { WsConnection, WsServerHandle } from "./ws.ts";

export { BRIDGE_IDENTITY };

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
  /** Root the workspace-scoped endpoints may read; defaults to `process.cwd()`. */
  workspace?: string;
  /** JSON file `GET /api/automations` reads; defaults to `~/.pi/gentle-movil/automations.json`. */
  automationsFile?: string | null;
  /** Enables `POST /api/exec`; defaults to `GENTLE_MOVIL_ALLOW_EXEC === "1"`. */
  allowExec?: boolean;
  /** Commands kept in the exec history ring (default 50). */
  execHistoryCapacity?: number;
  /** Largest file `/api/fs/read` returns (default 512 KiB). */
  fsMaxReadBytes?: number;
  /** Entries one `/api/fs/tree` listing returns (default 500). */
  fsMaxTreeEntries?: number;
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

function legacyMethodNotAllowed(response: ServerResponse): void {
  writeJson(response, 405, { error: "method_not_allowed" });
}

/** `GET` and `HEAD` are the same thing for the read-only endpoints. */
function isRead(request: IncomingMessage): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

const FS_STATUS: Record<FsErrorCode, number> = {
  path_outside_workspace: 400,
  not_found: 404,
  not_a_file: 400,
  not_a_directory: 400,
  file_too_large: 413,
  binary_file: 415,
};

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

  // Workspace-scoped endpoints never leave this root: the extension's cwd
  // unless the host says otherwise (tests and hosts with a fixed project).
  const workspace = options.workspace ?? process.cwd();
  const automationsFile = options.automationsFile === undefined ? defaultAutomationsFile() : options.automationsFile;
  const allowExec = options.allowExec ?? isExecEnabled();
  const execRing: ExecRing = createExecRing(options.execHistoryCapacity ?? EXEC_HISTORY_CAPACITY);
  const fsMaxReadBytes = options.fsMaxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const fsMaxTreeEntries = options.fsMaxTreeEntries ?? DEFAULT_MAX_TREE_ENTRIES;

  const devices = new Map<WsConnection, DeviceState>();
  let wsHandle: WsServerHandle | null = null;
  let started = false;
  let starting: Promise<BridgeAddresses> | null = null;

  const apiServer = createServer((request, response) => {
    void routeApi(request, response, {
      logger,
      version,
      listSessions: () => listSessions(),
      workspace,
      automationsFile,
      allowExec,
      execRing,
      fsMaxReadBytes,
      fsMaxTreeEntries,
    }).catch((error: unknown) => {
      logger.error("http.api_handler_error", { error, path: request.url });
      if (!response.headersSent) writeError(response, 500, "internal_error", "the bridge failed to answer this request");
      else response.end();
    });
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
  workspace: string;
  automationsFile: string | null;
  allowExec: boolean;
  execRing: ExecRing;
  fsMaxReadBytes: number;
  fsMaxTreeEntries: number;
}

type WorkspaceAnswer = { ok: true; workspace: string } | { ok: false; status: number; code: string; message: string };

/**
 * `?workspace=` (optional) names a directory inside the extension's workspace.
 * Anything that escapes it, does not exist, or is not a directory answers 400
 * before a single syscall reads outside the root.
 */
function resolveWorkspace(root: string, request: IncomingMessage): WorkspaceAnswer {
  const requested = requestUrl(request).searchParams.get("workspace");
  if (requested === null || requested === "") return { ok: true, workspace: root };

  const resolved = resolveInsideWorkspace(root, requested);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 400,
      code: resolved.code === "not_found" ? "workspace_not_found" : resolved.code,
      message: resolved.message,
    };
  }
  // A file is not a workspace: reporting git or fs facts for it would be a lie.
  if (!isDirectory(resolved.absolute)) {
    return { ok: false, status: 400, code: "workspace_not_a_directory", message: `"${resolved.relative}" is not a directory` };
  }
  return { ok: true, workspace: resolved.absolute };
}

/** Returns the workspace to use, or writes the 4xx and returns null. */
function answerWorkspace(response: ServerResponse, answer: WorkspaceAnswer): string | null {
  if (answer.ok) return answer.workspace;
  writeError(response, answer.status, answer.code, answer.message);
  return null;
}

function handleAutomations(response: ServerResponse, context: RouteContext): void {
  const loaded = readAutomations(context.automationsFile);
  if (!loaded.ok) {
    // Honest 500: the file exists but cannot be understood, so an empty list
    // would read as "you have no automations".
    writeError(response, 500, loaded.code, loaded.message);
    return;
  }
  writeJson(response, 200, { automations: loaded.automations });
}

function handleAutomationDetail(response: ServerResponse, context: RouteContext, id: string): void {
  const loaded = readAutomations(context.automationsFile);
  if (!loaded.ok) {
    writeError(response, 500, loaded.code, loaded.message);
    return;
  }
  const automation = findAutomation(loaded.automations, id);
  if (automation === null) {
    writeError(
      response,
      404,
      "automation_not_found",
      `no automation with id "${id}" in ${context.automationsFile ?? "(no automations file)"}`,
    );
    return;
  }
  // The mobile editor parses the automation itself, not a wrapper.
  writeJson(response, 200, automation);
}

async function handleExec(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowedJson(response, "POST");
    return;
  }
  if (!context.allowExec) {
    context.logger.warn("http.exec_refused", { reason: "opt_in_absent", env: ALLOW_EXEC_ENV });
    writeError(
      response,
      403,
      "exec_disabled",
      `running commands is disabled: start the bridge with ${ALLOW_EXEC_ENV}=1 to allow it`,
    );
    return;
  }

  const workspace = answerWorkspace(response, resolveWorkspace(context.workspace, request));
  if (workspace === null) return;

  const body = await readJsonBody(request, 16 * 1024);
  if (!body.ok) {
    writeError(response, body.code === "payload_too_large" ? 413 : 400, body.code, body.message);
    return;
  }
  const candidate = body.value as { command?: unknown } | null;
  const command = candidate !== null && typeof candidate === "object" ? candidate.command : undefined;
  if (typeof command !== "string") {
    writeError(response, 400, "invalid_body", 'the body must be {"command": "<command line>"}');
    return;
  }

  const tokenized = tokenizeCommand(command);
  if (!tokenized.ok) {
    writeError(response, 400, tokenized.code, tokenized.message);
    return;
  }

  const startedAt = Date.now();
  const result = await runCommand({ command, cwd: workspace });
  const record = context.execRing.add({
    command: command.trim(),
    at: new Date().toISOString(),
    status: statusOfResult(result),
    exitCode: result.exitCode,
    output: result.output,
  });
  context.logger.info("http.exec_ran", {
    id: record.id,
    file: tokenized.argv[0],
    status: record.status,
    exitCode: record.exitCode,
    durationMs: Date.now() - startedAt,
  });

  if (result.spawnError !== null && !result.timedOut) {
    // The process never started (missing binary, permissions). A 200 with a
    // null exit code would read as "ran and said nothing": it did not run.
    writeError(response, 502, "command_spawn_failed", result.spawnError);
    return;
  }

  writeJson(response, 200, { id: record.id, exitCode: record.exitCode, output: record.output });
}

async function routeApi(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const path = (request.url ?? "/").split("?")[0] ?? "/";

  if (path === "/api/health") {
    if (!isRead(request)) {
      legacyMethodNotAllowed(response);
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
    if (!isRead(request)) {
      legacyMethodNotAllowed(response);
      return;
    }
    writeJson(response, 200, context.listSessions());
    return;
  }

  if (path === "/api/git/status") {
    if (!isRead(request)) {
      methodNotAllowedJson(response, "GET");
      return;
    }
    const workspace = answerWorkspace(response, resolveWorkspace(context.workspace, request));
    if (workspace === null) return;

    const result = await readGitStatus(workspace);
    if (!result.ok) {
      // Not a repository conflicts with this request (409); a host without the
      // git binary cannot serve the capability at all (501).
      writeError(response, result.code === "git_unavailable" ? 501 : 409, result.code, result.message);
      return;
    }
    writeJson(response, 200, result.report);
    return;
  }

  if (path === "/api/automations") {
    if (!isRead(request)) {
      methodNotAllowedJson(response, "GET");
      return;
    }
    handleAutomations(response, context);
    return;
  }

  if (path.startsWith("/api/automations/")) {
    if (!isRead(request)) {
      methodNotAllowedJson(response, "GET");
      return;
    }
    const raw = path.slice("/api/automations/".length);
    let id = raw;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = raw;
    }
    if (id === "") {
      writeError(response, 404, "automation_not_found", "no automation id in the path");
      return;
    }
    handleAutomationDetail(response, context, id);
    return;
  }

  if (path === "/api/exec/history") {
    if (!isRead(request)) {
      methodNotAllowedJson(response, "GET");
      return;
    }
    writeJson(response, 200, { commands: context.execRing.list() });
    return;
  }

  if (path === "/api/exec") {
    await handleExec(request, response, context);
    return;
  }

  if (path === "/api/fs/read") {
    if (!isRead(request)) {
      methodNotAllowedJson(response, "GET");
      return;
    }
    const workspace = answerWorkspace(response, resolveWorkspace(context.workspace, request));
    if (workspace === null) return;

    const requested = requestUrl(request).searchParams.get("path");
    const result = readWorkspaceFile(workspace, requested, context.fsMaxReadBytes);
    if (!result.ok) {
      writeError(response, FS_STATUS[result.code], result.code, result.message);
      return;
    }
    writeJson(response, 200, result.body);
    return;
  }

  if (path === "/api/fs/tree") {
    if (!isRead(request)) {
      methodNotAllowedJson(response, "GET");
      return;
    }
    const workspace = answerWorkspace(response, resolveWorkspace(context.workspace, request));
    if (workspace === null) return;

    const requested = requestUrl(request).searchParams.get("path");
    const result = listWorkspaceTree(workspace, requested, context.fsMaxTreeEntries);
    if (!result.ok) {
      writeError(response, FS_STATUS[result.code], result.code, result.message);
      return;
    }
    writeJson(response, 200, result.body);
    return;
  }

  writeJson(response, 404, { error: "not_found", path });
}
