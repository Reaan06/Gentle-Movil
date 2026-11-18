/**
 * The thin HTTP surface every bridge route shares: one JSON writer, one error
 * envelope, one request reader.
 *
 * Two rules live here so no route can forget them:
 *  - **identity**: every JSON answer carries `x-gentle-bridge: gentle-movil/1`.
 *    A process squatting 43721/43722 cannot reproduce it, so a client that got
 *    a well-formed JSON body from a stranger still detects the impostor;
 *  - **errors**: `{"error":{"code":"…","message":"…"}}` — an error is always a
 *    machine code plus a sentence a human can read, never an empty body.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { PROTO } from "./frames.ts";

/**
 * Identity advertised by `GET /api/health` and stamped as a header on every
 * JSON answer. Clients use it to prove what listens on both ports.
 */
export const BRIDGE_IDENTITY = {
  app: "gentle-shell",
  bridge: "gentle-movil",
  proto: PROTO,
} as const;

/** Header stamped on every JSON answer of both listeners. */
export const IDENTITY_HEADER = "x-gentle-bridge";

/** Value of {@link IDENTITY_HEADER}: `<bridge>/<proto>`. */
export const IDENTITY_VALUE = `${BRIDGE_IDENTITY.bridge}/${BRIDGE_IDENTITY.proto}`;

/** Machine code + human sentence. */
export interface BridgeError {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): BridgeError {
  return { error: { code, message } };
}

/** Writes one JSON answer with the bridge identity header. */
export function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    [IDENTITY_HEADER]: IDENTITY_VALUE,
  });
  response.end(body);
}

/** Writes `{error:{code,message}}` with the matching status and the identity header. */
export function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, errorBody(code, message));
}

/** 405 with the error envelope of this surface (`allow` lists the real verbs). */
export function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  writeError(response, 405, "method_not_allowed", `${allow} is the only method of this endpoint`);
}

/** The request URL parsed against loopback, so `?query=` is ready to read. */
export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export type BodyRead =
  | { ok: true; value: unknown }
  | { ok: false; code: "payload_too_large"; message: string }
  | { ok: false; code: "invalid_json"; message: string };

/**
 * Reads and parses a JSON request body, bounded: an oversized payload is
 * dropped instead of buffered, and a body that does not parse names the real
 * failure instead of a generic 400.
 */
export function readJsonBody(request: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, code: "payload_too_large", message: `the body exceeds ${maxBytes} bytes` });
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch (error) {
        finish({
          ok: false,
          code: "invalid_json",
          message: `the body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
    request.on("error", (error: Error) => {
      finish({ ok: false, code: "invalid_json", message: `the request body could not be read: ${error.message}` });
    });
  });
}
