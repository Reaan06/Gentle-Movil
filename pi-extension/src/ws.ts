/**
 * A dependency-free RFC 6455 server, just large enough for the device channel.
 *
 * Deliberate choices:
 *  - no npm dependency, so the bridge needs no installation step;
 *  - every write and every handler call is guarded, because the phone can
 *    vanish at any byte of a frame — an abandoned half-frame must never turn
 *    into an uncaught exception;
 *  - a client frame larger than `maxPayloadBytes` is rejected as soon as its
 *    header is read, so a hostile length cannot make us buffer forever.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { Logger } from "./log.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const WS_SUBPROTOCOL = "gentle-movil.v1";

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

const CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  tooBig: 1009,
} as const;

export interface WsCloseInfo {
  /** True when the peer disappeared with a partially received frame buffered. */
  midFrame: boolean;
  bufferedBytes: number;
  code: number | null;
}

export interface WsConnection {
  readonly id: number;
  readonly remote: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drops the socket without a close handshake (bridge shutdown). */
  terminate(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (info: WsCloseInfo) => void): void;
}

export interface WsServerOptions {
  path: string;
  logger: Logger;
  maxPayloadBytes: number;
  onConnection: (connection: WsConnection) => void;
}

export interface WsServerHandle {
  closeAll(code?: number, reason?: string): void;
  readonly count: number;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

function pathnameOf(url: string | undefined): string {
  if (!url) return "/";
  const queryIndex = url.indexOf("?");
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function writeHttpResponse(socket: Socket, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  const lines = [
    `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Bad Request"}`,
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ];
  try {
    socket.write(lines.join("\r\n"));
  } catch {
    // The peer may already be gone; nothing to report.
  }
  socket.destroy();
}

interface CloseState {
  code: number | null;
  reason: string;
  initiator: "peer" | "bridge";
}

class Connection implements WsConnection {
  readonly id: number;
  readonly remote: string;

  private readonly socket: Socket;
  private readonly logger: Logger;
  private readonly maxPayloadBytes: number;
  private buffer: Buffer;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;
  private readonly messageHandlers: Array<(data: string) => void> = [];
  private readonly closeHandlers: Array<(info: WsCloseInfo) => void> = [];
  private closed = false;
  private notified = false;
  private closeState: CloseState = { code: null, reason: "", initiator: "peer" };
  private midFrame = false;

  constructor(options: { id: number; socket: Socket; logger: Logger; maxPayloadBytes: number; head?: Buffer }) {
    this.id = options.id;
    this.socket = options.socket;
    this.logger = options.logger;
    this.maxPayloadBytes = options.maxPayloadBytes;
    this.remote = `${options.socket.remoteAddress ?? "unknown"}:${options.socket.remotePort ?? 0}`;
    this.buffer = options.head && options.head.length > 0 ? Buffer.from(options.head) : Buffer.alloc(0);

    this.socket.setNoDelay?.(true);
    this.socket.setTimeout?.(0);
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", (error: Error) => {
      this.logger.error("ws.socket_error", { connectionId: this.id, error });
      this.destroy();
    });
    // An upgraded socket is not auto-destroyed when the peer closes its half,
    // so without this the close handler (and the mid-frame report) never runs.
    this.socket.on("end", () => this.destroy());
    this.socket.on("close", () => this.onSocketClose());
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (info: WsCloseInfo) => void): void {
    this.closeHandlers.push(handler);
  }

  send(data: string): void {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(OPCODE.text, Buffer.from(data, "utf8")));
    } catch (error) {
      this.logger.warn("ws.send_failed", { connectionId: this.id, error });
      this.destroy();
    }
  }

  close(code: number = CLOSE_CODES.normal, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.closeState = { code, reason, initiator: "bridge" };
    if (!this.socket.destroyed) {
      try {
        this.socket.write(encodeFrame(OPCODE.close, closePayload(code, reason)));
        this.socket.end();
      } catch (error) {
        this.logger.warn("ws.close_failed", { connectionId: this.id, error });
      }
      // Free the handle even if the peer never acknowledges the close frame.
      const timer = setTimeout(() => this.destroy(), 500);
      timer.unref?.();
      return;
    }
    this.destroy();
  }

  terminate(): void {
    this.closed = true;
    this.destroy();
  }

  /** Feeds bytes that arrived together with the upgrade request. */
  start(): void {
    try {
      this.drain();
    } catch (error) {
      this.logger.error("ws.frame_error", { connectionId: this.id, error });
      this.close(CLOSE_CODES.protocolError, "frame error");
    }
  }

  private destroy(): void {
    if (!this.socket.destroyed) {
      try {
        this.socket.destroy();
      } catch {
        // Already gone.
      }
    }
    this.onSocketClose();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
    } catch (error) {
      this.logger.error("ws.frame_error", { connectionId: this.id, error });
      this.close(CLOSE_CODES.protocolError, "frame error");
      return;
    }
    this.midFrame = this.buffer.length > 0 || this.fragments.length > 0;
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayloadBytes)) {
          this.close(CLOSE_CODES.tooBig, "frame too large");
          return;
        }
        length = Number(big);
        offset = 10;
      }

      if (!masked) {
        this.close(CLOSE_CODES.protocolError, "client frames must be masked");
        return;
      }
      if (length > this.maxPayloadBytes) {
        // Reject from the header alone: never buffer a declared-but-unsent length.
        this.close(CLOSE_CODES.tooBig, "frame too large");
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = this.buffer[offset + index]! ^ mask[index % 4]!;
      }
      this.buffer = this.buffer.subarray(offset + length);

      this.handleFrame(opcode, fin, payload);
      if (this.closed) return;
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case OPCODE.text:
      case OPCODE.binary: {
        if (this.fragmentOpcode !== null) {
          this.close(CLOSE_CODES.protocolError, "nested data frame");
          return;
        }
        if (opcode === OPCODE.binary) {
          this.close(CLOSE_CODES.unsupportedData, "binary frames are not supported");
          return;
        }
        if (fin) {
          this.deliver(payload);
          return;
        }
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      }
      case OPCODE.continuation: {
        if (this.fragmentOpcode === null) {
          this.close(CLOSE_CODES.protocolError, "continuation without start");
          return;
        }
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxPayloadBytes) {
          this.close(CLOSE_CODES.tooBig, "fragmented message too large");
          return;
        }
        this.fragments.push(payload);
        if (!fin) return;
        const complete = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = null;
        this.deliver(complete);
        return;
      }
      case OPCODE.ping: {
        if (this.closed || this.socket.destroyed) return;
        try {
          this.socket.write(encodeFrame(OPCODE.pong, payload));
        } catch (error) {
          this.logger.warn("ws.pong_failed", { connectionId: this.id, error });
        }
        return;
      }
      case OPCODE.pong:
        return;
      case OPCODE.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.closeState = { code, reason: payload.subarray(2).toString("utf8"), initiator: "peer" };
        this.close(CLOSE_CODES.normal, "");
        return;
      }
      default:
        this.close(CLOSE_CODES.protocolError, `unsupported opcode ${opcode}`);
        return;
    }
  }

  private deliver(payload: Buffer): void {
    const text = payload.toString("utf8");
    for (const handler of this.messageHandlers) {
      try {
        handler(text);
      } catch (error) {
        this.logger.error("ws.message_handler_error", { connectionId: this.id, error });
      }
    }
  }

  private onSocketClose(): void {
    if (this.notified) return;
    this.notified = true;
    this.closed = true;
    const info: WsCloseInfo = {
      midFrame: this.midFrame || this.buffer.length > 0 || this.fragments.length > 0,
      bufferedBytes: this.buffer.length + this.fragmentBytes,
      code: this.closeState.code,
    };
    for (const handler of this.closeHandlers) {
      try {
        handler(info);
      } catch (error) {
        this.logger.error("ws.close_handler_error", { connectionId: this.id, error });
      }
    }
  }
}

export function attachWebSocketServer(server: Server, options: WsServerOptions): WsServerHandle {
  const connections = new Set<Connection>();
  let nextId = 1;

  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      if (request.method !== "GET") {
        writeHttpResponse(socket, 400, { error: "bad_upgrade" });
        return;
      }
      const path = pathnameOf(request.url);
      if (path !== options.path) {
        writeHttpResponse(socket, 404, { error: "not_found" });
        return;
      }
      const upgrade = (headerValue(request, "upgrade") ?? "").toLowerCase();
      const key = headerValue(request, "sec-websocket-key");
      const version = headerValue(request, "sec-websocket-version");
      if (upgrade !== "websocket" || !key || version !== "13") {
        writeHttpResponse(socket, 400, { error: "bad_upgrade" });
        return;
      }

      const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
      const headers = [
        "HTTP/1.1 101 Switching Protocols",
        "upgrade: websocket",
        "connection: Upgrade",
        `sec-websocket-accept: ${accept}`,
      ];
      const requestedProtocols = headerValue(request, "sec-websocket-protocol");
      if (requestedProtocols && requestedProtocols.split(",").some((entry) => entry.trim() === WS_SUBPROTOCOL)) {
        headers.push(`sec-websocket-protocol: ${WS_SUBPROTOCOL}`);
      }
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
      socket.setNoDelay?.(true);

      const connection = new Connection({
        id: nextId++,
        socket,
        logger: options.logger,
        maxPayloadBytes: options.maxPayloadBytes,
        head,
      });
      connections.add(connection);
      connection.onClose(() => connections.delete(connection));
      try {
        options.onConnection(connection);
      } catch (error) {
        options.logger.error("ws.connection_handler_error", { connectionId: connection.id, error });
        connection.close(1011, "connection handler failed");
        return;
      }
      connection.start();
    } catch (error) {
      options.logger.error("ws.upgrade_failed", { error });
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
  });

  server.on("clientError", (error: Error, socket: Socket) => {
    options.logger.warn("http.client_error", { error });
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    } catch {
      // Already gone.
    }
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
  });

  return {
    closeAll: (code = CLOSE_CODES.goingAway, reason = "bridge stopping") => {
      const closing = [...connections];
      for (const connection of closing) connection.close(code, reason);
      connections.clear();
      // A peer that never answers must not keep the port bound.
      const timer = setTimeout(() => {
        for (const connection of closing) connection.terminate();
      }, 50);
      timer.unref?.();
    },
    get count() {
      return connections.size;
    },
  };
}
