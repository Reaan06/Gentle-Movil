/**
 * Device channel frame schema, `proto: 1`.
 *
 * Every frame is a JSON text frame with a `type` discriminator. Client frames
 * may carry an optional `id` (request id) that the bridge echoes back on the
 * matching reply or error, so the phone can correlate without ordering tricks.
 * The schema is documented in `docs/mobile-protocol-spec.md` §9.
 */

import type { AgentSession } from "./sessions.ts";

export const PROTO = 1;

export type ClientFrame =
  | { type: "hello"; proto: number; client?: string }
  | { type: "sessions.list"; id?: string }
  | { type: "session.attach"; id?: string; sessionId: string }
  | { type: "session.detach"; id?: string }
  | { type: "input"; id?: string; text: string }
  | { type: "ping"; id?: string };

export const ERROR_CODES = {
  badFrame: "bad_frame",
  unsupportedProto: "unsupported_proto",
  unsupportedType: "unsupported_type",
  notAttached: "not_attached",
  unknownSession: "unknown_session",
  inputTooLarge: "input_too_large",
  inputFailed: "input_failed",
  internal: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type FrameParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: ErrorCode; message: string; id?: string; sessionId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalId(record: Record<string, unknown>): string | undefined {
  return typeof record.id === "string" ? record.id : undefined;
}

export interface ParseClientFrameOptions {
  maxInputBytes?: number;
}

/**
 * Validates an already-decoded JSON value. Unknown types are rejected with an
 * error frame instead of being ignored, so a newer phone app fails loudly.
 */
export function parseClientFrame(raw: unknown, options: ParseClientFrameOptions = {}): FrameParseResult {
  const maxInputBytes = options.maxInputBytes ?? 64 * 1024;
  if (!isRecord(raw)) {
    return { ok: false, code: ERROR_CODES.badFrame, message: "frame must be a JSON object" };
  }
  const id = optionalId(raw);
  const type = raw.type;
  if (typeof type !== "string") {
    return { ok: false, code: ERROR_CODES.badFrame, message: "frame.type must be a string", id };
  }

  switch (type) {
    case "hello": {
      if (typeof raw.proto !== "number") {
        return { ok: false, code: ERROR_CODES.badFrame, message: "hello.proto must be a number", id };
      }
      if (raw.proto !== PROTO) {
        return {
          ok: false,
          code: ERROR_CODES.unsupportedProto,
          message: `unsupported proto ${raw.proto}; this bridge speaks proto ${PROTO}`,
          id,
        };
      }
      return {
        ok: true,
        frame: { type: "hello", proto: raw.proto, client: typeof raw.client === "string" ? raw.client : undefined },
      };
    }
    case "sessions.list":
      return { ok: true, frame: { type: "sessions.list", id } };
    case "session.attach": {
      if (typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) {
        return { ok: false, code: ERROR_CODES.badFrame, message: "session.attach.sessionId must be a non-empty string", id };
      }
      return { ok: true, frame: { type: "session.attach", id, sessionId: raw.sessionId } };
    }
    case "session.detach":
      return { ok: true, frame: { type: "session.detach", id } };
    case "input": {
      if (typeof raw.text !== "string") {
        return { ok: false, code: ERROR_CODES.badFrame, message: "input.text must be a string", id };
      }
      if (Buffer.byteLength(raw.text, "utf8") > maxInputBytes) {
        return {
          ok: false,
          code: ERROR_CODES.inputTooLarge,
          message: `input.text exceeds ${maxInputBytes} bytes`,
          id,
        };
      }
      return { ok: true, frame: { type: "input", id, text: raw.text } };
    }
    case "ping":
      return { ok: true, frame: { type: "ping", id } };
    default:
      return { ok: false, code: ERROR_CODES.unsupportedType, message: `unsupported frame type "${type}"`, id };
  }
}

export type ServerFrame = Record<string, unknown>;

export function errorFrame(
  code: ErrorCode | string,
  message: string,
  extra: { id?: string; sessionId?: string } = {},
): ServerFrame {
  const frame: ServerFrame = { type: "error", code, message };
  if (extra.id !== undefined) frame.id = extra.id;
  if (extra.sessionId !== undefined) frame.sessionId = extra.sessionId;
  return frame;
}

export function helloFrame(bridge: { version: string }): ServerFrame {
  return { type: "hello", proto: PROTO, bridge: "gentle-movil", version: bridge.version };
}

export function sessionsFrame(sessions: AgentSession[], id?: string): ServerFrame {
  const frame: ServerFrame = { type: "sessions.list", sessions };
  if (id !== undefined) frame.id = id;
  return frame;
}

export function attachedFrame(session: AgentSession, id?: string): ServerFrame {
  const frame: ServerFrame = { type: "session.attached", sessionId: session.id, session };
  if (id !== undefined) frame.id = id;
  return frame;
}

export function detachedFrame(sessionId: string, id?: string): ServerFrame {
  const frame: ServerFrame = { type: "session.detached", sessionId };
  if (id !== undefined) frame.id = id;
  return frame;
}

export function inputAcceptedFrame(sessionId: string, deliver: "agent" | "echo", id?: string): ServerFrame {
  const frame: ServerFrame = { type: "input.accepted", sessionId, deliver };
  if (id !== undefined) frame.id = id;
  return frame;
}

export function pongFrame(id?: string): ServerFrame {
  const frame: ServerFrame = { type: "pong" };
  if (id !== undefined) frame.id = id;
  return frame;
}

export function outputFrame(
  sessionId: string,
  text: string,
  source: "agent" | "echo",
  seq: number,
): ServerFrame {
  return { type: "output", sessionId, text, source, seq };
}
