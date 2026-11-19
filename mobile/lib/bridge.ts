/**
 * Bridge client — HTTP/1.1 over the SSH tunnel channel (protocol §4).
 *
 * Everything here is pure or injected: no React Native import. The channel is
 * the core's `channelWrite`/`channelRead`/`channelClose` triple (see
 * `mobile/lib/core.ts` §MobileCore); this module frames a real
 * `GET <path> HTTP/1.1` (or `POST` with a JSON body, protocol §4.1 `POST
 * /api/exec`) request over it and parses the real response.
 *
 * ## One response per channel (`Connection: close`)
 *
 * The channel is an SSH `direct-tcpip` forward to the extension's loopback
 * port, so it *is* the TCP connection. The request therefore asks the PC to
 * close it (`Connection: close`) and the exchange ends at the response's own
 * framing — the status line plus `Content-Length` bytes, or a chunked body —
 * never at the peer closing: the extension's `node:http` server answers
 * `Connection: keep-alive` (measured on a live host) and would leave a reader
 * that waits for EOF silent until its timeout. `TunnelChannel.close()` is
 * called once the exchange is over, so the channel that already served its
 * response is never reused (see `mobile/lib/tunnel-bridge.ts`).
 *
 * Honesty rules (S7):
 * - every failure is returned as a typed `BridgeFailure` and logged by the
 *   caller with `{step, error, raw}` — nothing is invented or swallowed;
 * - the four outcomes stay apart: `offline` (no tunnel), `timeout` (silence),
 *   `channel-closed` (the peer went away mid-exchange) and `bad-response`
 *   (the peer answered something that is not a valid HTTP/JSON answer);
 * - a short/invalid HTTP answer carries the raw prefix in the failure, not a
 *   fake payload.
 *
 * `mobile/test/bridge.test.mjs` pins these rules with a fake channel that
 * speaks the real wire format.
 */

import { utf8Decode, utf8Encode } from './core.ts';
import { inspectHttpResponse } from './provision.ts';

/** Port the extension serves HTTP on (host loopback, protocol §4). */
export const BRIDGE_HTTP_PORT = 43721;

/** Largest response this client assembles before refusing it, in bytes. */
export const BRIDGE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Largest response head it scans before calling the answer malformed, in bytes. */
export const BRIDGE_MAX_HEAD_BYTES = 64 * 1024;

/** Read frames one exchange may consume before refusing it (a chatty peer cannot spin forever). */
export const BRIDGE_MAX_FRAMES = 512;

/** Longest single read window the exchange hands to the core, in ms. */
export const BRIDGE_READ_WINDOW_MS = 5_000;

/** Injectable tunnel channel — exactly the core's channel triple. */
export interface TunnelChannel {
  write(payload: Uint8Array): Promise<number>;
  read(timeoutMs?: number): Promise<{ bytes: Uint8Array; eof: boolean }>;
  /**
   * Called once the exchange is over, success or failure: one request consumes
   * one channel (`Connection: close`), so the next request opens its own.
   * `tunnelChannelAdapter` uses it to release the channel and re-open a fresh
   * `direct-tcpip` one; a test channel may implement it as a no-op.
   */
  close?(): Promise<void>;
}

/**
 * The channel the exchange was using is gone: the peer closed it, or it had
 * already served its one response. Always a typed failure, never an empty body.
 */
export class ChannelClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelClosedError';
  }
}

/** The tunnel could not hand the request a channel at all (session or forward gone). */
export class ChannelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelUnavailableError';
  }
}

/** Why a bridge call failed; the UI renders this, never a made-up payload. */
export type BridgeFailureKind =
  | 'offline'
  | 'timeout'
  | 'channel-closed'
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

/**
 * One `/api/sessions` entry (protocol §9.3). The bridge publishes exactly three
 * states and never claims one the platform does not expose: `unknown` means the
 * PC does not know. There is no "waiting" and no "done" in the contract.
 */
export interface BridgeSession {
  id: string;
  title: string;
  status: 'idle' | 'busy' | 'unknown';
  /** Branch or project hint shown under the row. */
  hint: string | null;
  /** ISO-8601 timestamp of the last activity. */
  updatedAt: string;
}

/** The three statuses §9.3 defines; anything else is `unknown`, never guessed. */
const SESSION_STATUSES: readonly BridgeSession['status'][] = ['idle', 'busy', 'unknown'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Normalize the `/api/sessions` payload.
 *
 * §9.3 answers a bare JSON array; a `{ sessions: [...] }` envelope is accepted
 * too so a newer bridge build does not break the tablet. Anything else is
 * `null` — the caller turns that into the honest "invalid list" state instead
 * of an empty success.
 */
export function normalizeSessionsPayload(body: unknown): BridgeSession[] | null {
  const raw = Array.isArray(body)
    ? body
    : Array.isArray(asRecord(body)?.sessions)
      ? (asRecord(body)?.sessions as unknown[])
      : null;
  if (raw === null) {
    return null;
  }
  const sessions: BridgeSession[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) {
      return null;
    }
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }
    const status = SESSION_STATUSES.find((known) => known === record.status) ?? 'unknown';
    // Title/hint/timestamp are optional in the contract: absence is not a
    // reason to drop a real session, and never becomes a fabricated value.
    sessions.push({
      id,
      title: stringOr(record.title, id),
      status,
      hint: typeof record.hint === 'string' ? record.hint : null,
      updatedAt: stringOr(record.updatedAt, ''),
    });
  }
  return sessions;
}

/** `/api/health` identity (protocol §4). */
export interface BridgeHealth {
  proto: number;
  /** §9.2 identifies the bridge; older builds sent `name` instead of `bridge`. */
  bridge?: string;
  name?: string;
  version: string | null;
  /** Application identity the bridge serves (`gentle-pi-extension`). */
  app?: string;
}

/** Options for `bridgeRequest`. */
export interface BridgeRequestOptions {
  /** Budget of the whole exchange, in ms (default 10 000). */
  timeoutMs?: number;
  /** Longest single read window handed to the core, in ms (default `BRIDGE_READ_WINDOW_MS`). */
  readWindowMs?: number;
  /** HTTP method of the call; defaults to `GET` (nothing else is served). */
  method?: 'GET' | 'POST';
  /** Body serialized as JSON, with its real `Content-Length` (POST only). */
  body?: unknown;
}

function failure(
  kind: BridgeFailureKind,
  message: string,
  raw: string | null = null,
  error: unknown = null,
): BridgeFailure {
  return { kind, message, raw, error };
}

/**
 * Build the exact wire bytes of the GET request (protocol §4).
 *
 * `Connection: close` is the framing this tunnel supports: one `direct-tcpip`
 * channel is one TCP connection, and the response is one-shot, so the PC is
 * asked to close the connection after answering instead of holding it open.
 */
export function buildGetRequest(path: string, host: string): Uint8Array {
  const request =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Connection: close\r\n` +
    `Accept: application/json\r\n` +
    `\r\n`;
  return utf8Encode(request);
}

/**
 * Build the exact wire bytes of a JSON POST (protocol §4.1 `POST /api/exec`).
 * `Content-Length` is the real byte length of the UTF-8 body, so the peer never
 * has to guess where the body ends. `Connection: close` for the same reason as
 * the GET request: one response per channel.
 */
export function buildPostRequest(path: string, host: string, body: unknown): Uint8Array {
  const payload = JSON.stringify(body ?? null);
  const request =
    `POST ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Connection: close\r\n` +
    `Accept: application/json\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${utf8Encode(payload).length}\r\n` +
    `\r\n` +
    payload;
  return utf8Encode(request);
}

/** Split a raw HTTP response into status + body text (whole tail after the head). */
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

/* ------------------------------------------------------------------ *
 * Response framing (status line + headers + Content-Length, chunked or eof)
 * ------------------------------------------------------------------ */

/** Framing a response head declares for its body. */
export type ResponseFraming =
  /** Exactly `length` bytes follow the head (the framing the PC serves). */
  | { kind: 'length'; length: number }
  /** `Transfer-Encoding: chunked`: hex-sized chunks until the last one. */
  | { kind: 'chunked' }
  /** No framing at all: only the peer closing the channel (or complete JSON) ends it. */
  | { kind: 'none' };

/** What the bytes read so far are: a complete response, or what it is missing. */
export type ResponseInspection =
  /** No complete head yet. */
  | { state: 'incomplete' }
  /** Head read; the body still needs bytes. `body` is what arrived so far. */
  | { state: 'pending'; status: number; headEnd: number; framing: ResponseFraming; body: Uint8Array }
  /** The response is complete: `body` is exactly what its framing declared. */
  | { state: 'complete'; status: number; headEnd: number; body: Uint8Array }
  /** The peer answered something that is not a valid HTTP answer. */
  | { state: 'invalid'; reason: string };

/** ASCII/latin1 text of some bytes (a head is ASCII; the body is not decoded here). */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index] as number);
  }
  return out;
}

/** `left` followed by `right`. */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

/** Case-insensitive value of header `name` of an already decoded head. */
function headerValue(head: string, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const line of head.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    if (line.slice(0, colon).trim().toLowerCase() === wanted) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

/**
 * How the body of this response ends, per HTTP/1.1 §3.3.2: `Transfer-Encoding:
 * chunked` wins over `Content-Length`; with neither, only the connection
 * closing (or a complete JSON document) ends the body.
 */
export function responseFraming(head: string): ResponseFraming {
  const transferEncoding = (headerValue(head, 'transfer-encoding') ?? '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    return { kind: 'chunked' };
  }
  const contentLength = headerValue(head, 'content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    return { kind: 'length', length: Number(contentLength) };
  }
  return { kind: 'none' };
}

/** One line of ASCII text ending at `\n` (tolerating `\r\n`), and where it ends. */
function readAsciiLine(bytes: Uint8Array, from: number): { text: string; next: number } | null {
  for (let index = from; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      const end = index > from && bytes[index - 1] === 0x0d ? index - 1 : index;
      return { text: latin1(bytes.subarray(from, end)), next: index + 1 };
    }
  }
  return null;
}

/** Outcome of decoding a `Transfer-Encoding: chunked` body. */
export type ChunkedBody =
  | { state: 'complete'; body: Uint8Array }
  | { state: 'incomplete' }
  | { state: 'invalid'; reason: string };

/**
 * Decode a chunked body, stopping exactly at its last chunk (plus trailers).
 * A body that has not reached the terminator is `incomplete`, so the caller
 * keeps reading; a malformed size or terminator is `invalid`, never a guess.
 */
export function decodeChunkedBody(bytes: Uint8Array): ChunkedBody {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const sizeLine = readAsciiLine(bytes, offset);
    if (sizeLine === null) {
      return { state: 'incomplete' };
    }
    offset = sizeLine.next;
    const sizeText = sizeLine.text.split(';')[0]!.trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
      return { state: 'invalid', reason: `tamaño de chunk inválido: «${sizeLine.text.slice(0, 40)}»` };
    }
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) {
      // Last chunk: the trailer section ends with an empty line.
      for (;;) {
        const trailer = readAsciiLine(bytes, offset);
        if (trailer === null) {
          return { state: 'incomplete' };
        }
        offset = trailer.next;
        if (trailer.text.trim() === '') {
          let body: Uint8Array = new Uint8Array(0);
          for (const chunk of chunks) {
            body = concat(body, chunk);
          }
          return { state: 'complete', body };
        }
      }
    }
    if (bytes.length < offset + size) {
      return { state: 'incomplete' };
    }
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    const end = readAsciiLine(bytes, offset);
    if (end === null) {
      return { state: 'incomplete' };
    }
    if (end.text.trim() !== '') {
      return { state: 'invalid', reason: 'falta el fin de línea del chunk' };
    }
    offset = end.next;
  }
}

/** Is this byte run a complete JSON document? (Self-delimiting bodies only.) */
function isJsonDocument(bytes: Uint8Array): boolean {
  try {
    JSON.parse(utf8Decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/** Statuses whose response has no body, so its head is the whole answer. */
const BODYLESS_STATUSES: readonly number[] = [204, 304];

/**
 * Inspect the bytes read so far and say whether the response is complete.
 *
 * Completion is decided by what the response itself declares (`Content-Length`
 * satisfied, chunked terminator reached, bodyless status), never by the peer
 * closing: the extension serves `Connection: keep-alive`, so waiting for EOF is
 * how the tablet ended up with an empty body. Pure, so it is unit-tested.
 */
export function inspectResponse(bytes: Uint8Array): ResponseInspection {
  // The head is the only part shared with the tunnel exchange of `provision.ts`.
  const inspected = inspectHttpResponse(bytes);
  if (inspected.headEnd < 0) {
    if (bytes.length > BRIDGE_MAX_HEAD_BYTES) {
      return { state: 'invalid', reason: `${bytes.length}B sin cabeceras HTTP` };
    }
    return { state: 'incomplete' };
  }
  const status = inspected.status;
  if (status === null) {
    return { state: 'invalid', reason: 'la respuesta no empieza con una línea de estado HTTP' };
  }
  const head = latin1(bytes.subarray(0, inspected.headEnd));
  const rest = bytes.subarray(inspected.headEnd);
  if (status < 200 || BODYLESS_STATUSES.includes(status)) {
    return { state: 'complete', status, headEnd: inspected.headEnd, body: new Uint8Array(0) };
  }
  const framing = responseFraming(head);
  if (framing.kind === 'length') {
    if (rest.length < framing.length) {
      return { state: 'pending', status, headEnd: inspected.headEnd, framing, body: rest };
    }
    // Exactly the declared length: trailing bytes (a pipelined answer, a stray
    // frame) never leak into this response.
    return {
      state: 'complete',
      status,
      headEnd: inspected.headEnd,
      body: rest.subarray(0, framing.length),
    };
  }
  if (framing.kind === 'chunked') {
    const decoded = decodeChunkedBody(rest);
    if (decoded.state === 'complete') {
      return { state: 'complete', status, headEnd: inspected.headEnd, body: decoded.body };
    }
    if (decoded.state === 'invalid') {
      return { state: 'invalid', reason: decoded.reason };
    }
    return { state: 'pending', status, headEnd: inspected.headEnd, framing, body: rest };
  }
  // No framing header at all: a complete JSON document is self-delimiting and
  // ends the response; otherwise only the channel closing can.
  if (rest.length > 0 && isJsonDocument(rest)) {
    return { state: 'complete', status, headEnd: inspected.headEnd, body: rest };
  }
  return { state: 'pending', status, headEnd: inspected.headEnd, framing, body: rest };
}

/** Is this failure the tunnel being down / core unavailable? */
export function isOfflineError(error: unknown): boolean {
  return (
    error instanceof ChannelUnavailableError ||
    (error instanceof Error &&
      (error.name === 'CoreUnavailableError' || /channel|session|core/i.test(error.message)))
  );
}

/** One failed transport call → the typed failure the UI renders. */
function transmitFailure(error: unknown): BridgeFailure {
  if (error instanceof ChannelClosedError) {
    return {
      kind: 'channel-closed',
      message: 'El canal del túnel se cerró antes de que la PC respondiera.',
      raw: error.message,
      error,
    };
  }
  if (isOfflineError(error)) {
    return { kind: 'offline', message: 'Sin túnel hacia la PC.', raw: null, error };
  }
  return { kind: 'bad-response', message: 'La PC devolvió una respuesta rota.', raw: null, error };
}

/** The peer went away before the response its own framing declared was read. */
function closedFailure(inspection: ResponseInspection, received: number): BridgeFailure {
  const expected =
    inspection.state === 'pending' && inspection.framing.kind === 'length'
      ? inspection.framing.length
      : null;
  if (expected === null) {
    return failure(
      'channel-closed',
      'El canal del túnel se cerró sin respuesta de la PC.',
      `${received}B`,
    );
  }
  return failure(
    'channel-closed',
    'La PC cerró el canal antes de terminar la respuesta.',
    `recibidos ${received}B de ${expected}B`,
  );
}

/** A complete response body → the parsed payload, or the honest parse failure. */
function parseBody<T>(status: number, body: Uint8Array): BridgeResult<T> {
  const text = utf8Decode(body);
  if (text.trim() === '') {
    return {
      ok: false,
      failure: failure('bad-response', 'La PC devolvió una respuesta vacía.', `status=${status}, 0B`),
    };
  }
  try {
    return { ok: true, status, body: JSON.parse(text) as T };
  } catch (error) {
    return {
      ok: false,
      failure: failure('bad-response', 'La PC devolvió un JSON roto.', text.slice(0, 120), error),
    };
  }
}

/** Releases the one-shot channel, whatever the exchange decided. */
async function releaseChannel(channel: TunnelChannel): Promise<void> {
  if (typeof channel.close !== 'function') {
    return;
  }
  try {
    await channel.close();
  } catch {
    // The channel is already gone: a close failure never masks the answer (S7).
  }
}

/** The exchange itself; `bridgeRequest` always releases the channel afterwards. */
async function exchange<T>(
  channel: TunnelChannel,
  path: string,
  options: BridgeRequestOptions,
): Promise<BridgeResult<T>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const readWindow = Math.max(1, Math.min(options.readWindowMs ?? BRIDGE_READ_WINDOW_MS, timeoutMs));
  const wire =
    options.method === 'POST'
      ? buildPostRequest(path, '127.0.0.1', options.body ?? null)
      : buildGetRequest(path, '127.0.0.1');

  let written: number;
  try {
    written = await channel.write(wire);
  } catch (error) {
    return { ok: false, failure: transmitFailure(error) };
  }
  if (written <= 0) {
    return { ok: false, failure: failure('offline', 'El túnel no aceptó la consulta.', 'write=0') };
  }

  let buffer: Uint8Array = new Uint8Array();
  let frames = 0;
  let eofSeen = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const inspection = inspectResponse(buffer);
    if (inspection.state === 'complete') {
      return parseBody<T>(inspection.status, inspection.body);
    }
    if (inspection.state === 'invalid') {
      return {
        ok: false,
        failure: failure(
          'bad-response',
          'La PC devolvió una respuesta rota.',
          utf8Decode(buffer.slice(0, 120)),
        ),
      };
    }
    if (eofSeen) {
      // The peer closed the channel. A response with no framing at all ends
      // here (the head plus everything that arrived); anything else is the
      // honest "the channel went away" failure, never an empty body.
      if (inspection.state === 'pending' && inspection.framing.kind === 'none') {
        return parseBody<T>(inspection.status, inspection.body);
      }
      if (inspection.state === 'incomplete' && buffer.length > 0) {
        // Bytes arrived but they are not an HTTP answer at all.
        return {
          ok: false,
          failure: failure(
            'bad-response',
            'La PC devolvió una respuesta rota.',
            utf8Decode(buffer.slice(0, 120)),
          ),
        };
      }
      return {
        ok: false,
        failure: closedFailure(inspection, inspection.state === 'pending' ? inspection.body.length : buffer.length),
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        failure: failure('timeout', 'La PC no respondió a tiempo.', `${timeoutMs}ms, ${buffer.length}B`),
      };
    }
    if (frames >= BRIDGE_MAX_FRAMES) {
      return {
        ok: false,
        failure: failure(
          'bad-response',
          `La respuesta no terminó en ${BRIDGE_MAX_FRAMES} lecturas.`,
          `${buffer.length}B`,
        ),
      };
    }
    let frame: { bytes: Uint8Array; eof: boolean };
    try {
      frame = await channel.read(Math.max(1, Math.min(readWindow, remaining)));
    } catch (error) {
      return { ok: false, failure: transmitFailure(error) };
    }
    frames += 1;
    eofSeen = frame.eof;
    if (frame.bytes.length > 0) {
      buffer = concat(buffer, frame.bytes);
      if (buffer.length > BRIDGE_MAX_RESPONSE_BYTES) {
        return {
          ok: false,
          failure: failure(
            'bad-response',
            `La PC devolvió más de ${BRIDGE_MAX_RESPONSE_BYTES} bytes.`,
            `${buffer.length}B`,
          ),
        };
      }
    }
  }
}

/**
 * One HTTP request over the tunnel channel (`GET` by default, `POST /api/exec`
 * with a JSON body when asked).
 *
 * The response ends where its own framing says (status line + `Content-Length`
 * bytes, or the chunked terminator), so a `Connection: keep-alive` peer never
 * has to close first. The channel is released when the exchange is over — one
 * request, one channel — so a caller may hand the same (now consumed) handle
 * again: `mobile/lib/tunnel-bridge.ts` opens a fresh forward for it.
 */
export async function bridgeRequest<T>(
  channel: TunnelChannel,
  path: string,
  options: BridgeRequestOptions = {},
): Promise<BridgeResult<T>> {
  try {
    return await exchange<T>(channel, path, options);
  } finally {
    await releaseChannel(channel);
  }
}

/** GET `/api/health` — identity probe used by the connection chip. */
export function bridgeHealth(
  channel: TunnelChannel,
  options?: BridgeRequestOptions,
): Promise<BridgeResult<BridgeHealth>> {
  return bridgeRequest<BridgeHealth>(channel, '/api/health', options);
}

/**
 * GET `/api/sessions` — the real session list (protocol §9.3). The payload is
 * normalized to `{ sessions }` whatever envelope the bridge uses; an
 * unparseable body comes back as a `bad-response` failure, never as `[]`.
 */
export async function bridgeSessions(
  channel: TunnelChannel,
  options?: BridgeRequestOptions,
): Promise<BridgeResult<{ sessions: BridgeSession[] }>> {
  const result = await bridgeRequest<unknown>(channel, '/api/sessions', options);
  if (!result.ok) {
    return result;
  }
  if (result.status < 200 || result.status >= 300) {
    // The status is the honest answer here; the caller reports it verbatim
    // instead of masking it with a parse error.
    return { ok: true, status: result.status, body: { sessions: [] } };
  }
  const sessions = normalizeSessionsPayload(result.body);
  if (sessions === null) {
    return {
      ok: false,
      failure: {
        kind: 'bad-response',
        message: 'La PC devolvió una lista de sesiones inválida.',
        raw: JSON.stringify(result.body).slice(0, 120),
        error: null,
      },
    };
  }
  return { ok: true, status: result.status, body: { sessions } };
}
