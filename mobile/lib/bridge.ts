/**
 * Bridge client — HTTP/1.1 over the SSH tunnel channel (protocol §4).
 *
 * Everything here is pure or injected: no React Native import. The channel is
 * the core's `channelWrite`/`channelRead`/`channelClose` triple (see
 * `mobile/lib/core.ts` §MobileCore); this module frames a real
 * `GET <path> HTTP/1.1` request over it and parses the real response.
 *
 * Honesty rules (S7):
 * - every failure is returned as a typed `BridgeFailure` and logged by the
 *   caller with `{step, error, raw}` — nothing is invented or swallowed;
 * - a short/invalid HTTP answer is `bad-response` with the raw prefix in the
 *   failure, not a fake payload;
 * - the tunnel being down is `offline`, never an empty success.
 *
 * `mobile/test/bridge.test.mjs` pins these rules with a fake channel that
 * speaks the real wire format.
 */

import { utf8Decode, utf8Encode } from './core.ts';

/** Port the extension serves HTTP on (host loopback, protocol §4). */
export const BRIDGE_HTTP_PORT = 43721;

/** Injectable tunnel channel — exactly the core's channel triple. */
export interface TunnelChannel {
  write(payload: Uint8Array): Promise<number>;
  read(timeoutMs?: number): Promise<{ bytes: Uint8Array; eof: boolean }>;
  close(): Promise<void>;
}

/** Why a bridge call failed; the UI renders this, never a made-up payload. */
export type BridgeFailureKind =
  | 'offline'
  | 'timeout'
  | 'bad-response'
  | 'protocol-status';

/** Typed failure with the raw evidence for the log. */
export interface BridgeFailure {
  kind: BridgeFailureKind;
  /** Human copy the UI can show as-is (es-AR). */
  message: string;
  /** Raw evidence (response prefix, timeout ms, …) for the `{step, error, raw}` log. */
  raw: string | null;
  /** Underlying error when the failure came from an exception. */
  error: unknown;
}

/** Result of a bridge call: real payload or typed failure. */
export type BridgeResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; failure: BridgeFailure };

/** One `/api/sessions` entry (protocol §6 sessions.list). */
export interface BridgeSession {
  id: string;
  title: string;
  status: 'working' | 'waiting' | 'done' | 'archived';
  /** Branch or project hint shown under the row. */
  hint: string | null;
  /** ISO-8601 timestamp of the last activity. */
  updatedAt: string;
}

/** `/api/health` identity (protocol §4). */
export interface BridgeHealth {
  proto: number;
  name: string;
  version: string | null;
}

/** Options for `bridgeRequest`. */
export interface BridgeRequestOptions {
  /** Per-call timeout; the read window is this, divided across frames. */
  timeoutMs?: number;
}

function failure(
  kind: BridgeFailureKind,
  message: string,
  raw: string | null = null,
  error: unknown = null,
): BridgeFailure {
  return { kind, message, raw, error };
}

/** Build the exact wire bytes of the GET request (protocol §4). */
export function buildGetRequest(path: string, host: string): Uint8Array {
  const request =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Connection: close\r\n` +
    `Accept: application/json\r\n` +
    `\r\n`;
  return utf8Encode(request);
}

/** Split a raw HTTP response into status + body bytes. */
export function splitResponse(raw: Uint8Array): { status: number; body: string } | null {
  const text = utf8Decode(raw);
  const separator = text.indexOf('\r\n\r\n');
  if (separator < 0) {
    return null;
  }
  const head = text.slice(0, separator);
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (statusMatch === null) {
    return null;
  }
  return { status: Number(statusMatch[1]), body: text.slice(separator + 4) };
}

/** Is this failure the tunnel being down / core unavailable? */
export function isOfflineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CoreUnavailableError' || /channel|session|core/i.test(error.message))
  );
}

/**
 * One HTTP GET over the tunnel channel. Opens nothing: the caller passes the
 * already-open channel (the `tunnel` provision step owns it).
 */
export async function bridgeRequest<T>(
  channel: TunnelChannel,
  path: string,
  options: BridgeRequestOptions = {},
): Promise<BridgeResult<T>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let raw = new Uint8Array();
  try {
    const written = await channel.write(buildGetRequest(path, '127.0.0.1'));
    if (written <= 0) {
      return {
        ok: false,
        failure: failure('offline', 'El túnel no aceptó la consulta.', 'write=0'),
      };
    }
    // Read until the response is parseable, the peer closes, or the window dies.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          failure: failure(
            'timeout',
            'La PC no respondió a tiempo.',
            `${timeoutMs}ms, ${raw.length}B`,
          ),
        };
      }
      const frame = await channel.read(remaining);
      if (frame.bytes.length > 0) {
        const merged = new Uint8Array(raw.length + frame.bytes.length);
        merged.set(raw);
        merged.set(frame.bytes, raw.length);
        raw = merged;
      }
      if (frame.eof) {
        break;
      }
      const parsed = splitResponse(raw);
      if (parsed !== null && parsed.status >= 200) {
        // Headers complete; keep reading briefly for a body unless it parses.
        try {
          JSON.parse(parsed.body);
          break;
        } catch {
          // Body still incomplete — keep reading until eof/deadline.
        }
      }
    }
  } catch (error) {
    if (isOfflineError(error)) {
      return {
        ok: false,
        failure: failure('offline', 'Sin túnel hacia la PC.', null, error),
      };
    }
    return {
      ok: false,
      failure: failure('bad-response', 'La PC devolvió una respuesta rota.', null, error),
    };
  }
  void channel.close().catch(() => {});
  const parsed = splitResponse(raw);
  if (parsed === null) {
    return {
      ok: false,
      failure: failure(
        'bad-response',
        'La PC devolvió una respuesta rota.',
        utf8Decode(raw.slice(0, 120)),
      ),
    };
  }
  try {
    return { ok: true, status: parsed.status, body: JSON.parse(parsed.body) as T };
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        'bad-response',
        'La PC devolvió un JSON roto.',
        parsed.body.slice(0, 120),
        error,
      ),
    };
  }
}

/** GET `/api/health` — identity probe used by the connection chip. */
export function bridgeHealth(
  channel: TunnelChannel,
  options?: BridgeRequestOptions,
): Promise<BridgeResult<BridgeHealth>> {
  return bridgeRequest<BridgeHealth>(channel, '/api/health', options);
}

/** GET `/api/sessions` — the real session list (protocol §6). */
export function bridgeSessions(
  channel: TunnelChannel,
  options?: BridgeRequestOptions,
): Promise<BridgeResult<{ sessions: BridgeSession[] }>> {
  return bridgeRequest<{ sessions: BridgeSession[] }>(channel, '/api/sessions', options);
}
