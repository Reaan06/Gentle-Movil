import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** Minimal RFC 6455 client: enough to drive the bridge in tests without dependencies. */
export interface TestWsClient {
  nextFrame(timeoutMs?: number): Promise<Record<string, unknown>>;
  sendText(payload: unknown): void;
  /** Masked text frame whose payload is not necessarily valid JSON. */
  sendTextRaw(payload: string): void;
  sendRaw(buffer: Buffer): void;
  /** Send a valid frame header plus a truncated payload, then stall (mid-frame). */
  sendTruncatedTextFrame(declaredLength: number, sentPayloadBytes: number): void;
  close(): void;
  destroy(): void;
  readonly upgrade: { status: number; headers: Record<string, string | string[] | undefined> };
}

class FrameQueue {
  private readonly frames: Record<string, unknown>[] = [];
  private readonly waiters: Array<{
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closedError: Error | null = null;

  push(frame: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  fail(error: Error): void {
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  next(timeoutMs: number): Promise<Record<string, unknown>> {
    const buffered = this.frames.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a server frame`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }
}

function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  const header: number[] = [0x80 | OPCODE.text];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  } else {
    header.push(0x80 | 127);
    for (let shift = 56; shift >= 0; shift -= 8) header.push((payload.length / 2 ** shift) & 0xff);
  }
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

/** Frame header only: declares `declaredLength` bytes so the rest never arrives. */
function encodeTruncatedFrame(declaredLength: number, sentPayloadBytes: number): Buffer {
  const mask = randomBytes(4);
  const header: number[] = [0x80 | OPCODE.text, 0x80 | 126, declaredLength >> 8, declaredLength & 0xff];
  const body = Buffer.alloc(sentPayloadBytes, 0x61);
  return Buffer.concat([Buffer.from(header), mask, body]);
}

export function connectTestWs(port: number, path = "/ws/device"): Promise<TestWsClient> {
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      agent: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`expected 101 upgrade, got ${res.statusCode}`));
    });
    req.on("upgrade", (res, socket: Socket, head: Buffer) => {
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      const queue = new FrameQueue();
      let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

      const pump = (): void => {
        while (buffer.length >= 2) {
          const first = buffer[0]!;
          const second = buffer[1]!;
          const opcode = first & 0x0f;
          let length = second & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === OPCODE.text || opcode === OPCODE.binary) {
            try {
              queue.push(JSON.parse(payload.toString("utf8")) as Record<string, unknown>);
            } catch {
              queue.push({ type: "__unparseable__", raw: payload.toString("utf8") });
            }
          } else if (opcode === OPCODE.close) {
            queue.fail(new Error("server closed the websocket"));
          }
        }
      };

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        pump();
      });
      socket.on("error", (error: Error) => queue.fail(error));
      socket.on("close", () => queue.fail(new Error("socket closed")));

      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(new Error("bad Sec-WebSocket-Accept in upgrade response"));
        return;
      }

      resolve({
        upgrade: { status: res.statusCode ?? 0, headers: res.headers },
        nextFrame: (timeoutMs = 5000) => {
          void pump;
          return queue.next(timeoutMs);
        },
        sendText: (payload: unknown) => socket.write(encodeClientTextFrame(JSON.stringify(payload))),
        sendTextRaw: (payload: string) => socket.write(encodeClientTextFrame(payload)),
        sendRaw: (raw: Buffer) => socket.write(raw),
        sendTruncatedTextFrame: (declaredLength: number, sentPayloadBytes: number) => {
          socket.write(encodeTruncatedFrame(declaredLength, sentPayloadBytes));
        },
        close: () => socket.end(),
        destroy: () => socket.destroy(),
      });
    });
    req.end();
  });
}
