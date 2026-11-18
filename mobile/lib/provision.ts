/**
 * V3 orchestration — pairing progress (`mobile/app/pairing-progress.tsx`,
 * artboard `design/mobile-app-onboarding/03-pairing-progress.html`).
 *
 * ## The pivot flow (S4/S5/S7 — no daemon, no SFTP)
 *
 * Five steps, in this order, each one a real event of the SSH session:
 *
 * 1. `connect`     — `gc_ssh_connect` (russh) opens the session.
 * 2. `fingerprint` — the host key the handshake reported must equal the one the
 *                    QR carried (TOFU, protocol §1/§8).
 * 3. `detect`      — the Gentle Shell/Pi extension must be listening on the
 *                    host's loopback 43721/43722, found with a probe command
 *                    over the existing session (no new ABI).
 * 4. `register`    — the phone's ed25519 public key is installed in the user's
 *                    `~/.ssh/authorized_keys` (idempotent append), so every
 *                    later connection is key-only.
 * 5. `tunnel`      — the SSH local forward to the extension's loopback ports,
 *                    which is the channel the app talks to the agent through.
 *                    The step's result is **kept**: one `channel_id` per port,
 *                    which `httpOverTunnel`/`channelWrite`/`channelRead`/
 *                    `closeTunnel` below speak HTTP/WS through (S4).
 *
 * There is **no** binary upload, no release checksum, no daemon start and no
 * rollback in this flow (S5): those were the SFTP provisioning of the rejected
 * daemon. `mobile/test/provision.test.mjs` pins their absence.
 *
 * ## Composition instead of new ABI
 *
 * The five steps are expressed as `gc_provision_step` payloads. `detect` and
 * `register` carry the `sh` command they need composed here (`loopbackProbeScript`,
 * `authorizedKeysScript`), which the core runs with its `exec`-over-SSH
 * primitive; `tunnel` carries the `forwards` list the core turns into
 * `direct-tcpip` channels. Nothing here invents a value: a step the core does
 * not implement answers with its own error envelope, and the flow stops there
 * with that verbatim reason.
 *
 * ## Failure contract (S7)
 *
 * Every failed step reaches `logger.failure(step, error, raw)` — `logger.error`
 * with the `{step, error, raw}` payload — and the callbacks receive the same
 * verbatim reason the callout shows. The flow resolves `{ok:false, failedStep,
 * error}`; it never throws and never pretends a step passed.
 */

import type { PairInfo, SshCredential } from './core';

/** Steps of the pivot flow, in execution order. */
export type ProvisionStep = 'connect' | 'fingerprint' | 'detect' | 'register' | 'tunnel';

/** Execution order of the flow. */
export const PROVISION_STEPS: readonly ProvisionStep[] = [
  'connect',
  'fingerprint',
  'detect',
  'register',
  'tunnel',
];

/** Extension loopback port serving HTTP (protocol §4 bridge). */
export const EXTENSION_HTTP_PORT = 43721;

/** Extension loopback port serving the device surface / WS bridge (protocol §4). */
export const EXTENSION_WS_PORT = 43722;

/** Loopback ports the extension must have open on the host, in probe order. */
export const EXTENSION_LOOPBACK_PORTS: readonly number[] = [EXTENSION_HTTP_PORT, EXTENSION_WS_PORT];

/** Loopback host the extension binds to; the SSH forward targets it. */
export const EXTENSION_LOOPBACK_HOST = '127.0.0.1';

/** Name the host shows for this phone in `authorized_keys`. */
export const DEVICE_NAME = 'Gentle Movil';

/** Comment of the line `register` writes into `authorized_keys`. */
export const AUTHORIZED_KEY_COMMENT = 'gentle-movil';

/** Ceiling of one channel call that carries no read window (write/close), in ms. */
export const CHANNEL_CALL_TIMEOUT_MS = 30_000;

/** Extra window the TS guard allows on top of the read window the core honours, in ms. */
export const CHANNEL_GUARD_MARGIN_MS = 10_000;

/** Read window the HTTP helper hands to the core for one frame, in ms. */
export const CHANNEL_READ_TIMEOUT_MS = 5_000;

/** Budget of one whole request/response exchange, in ms. */
export const HTTP_EXCHANGE_TIMEOUT_MS = 30_000;

/** Largest response the helper assembles before refusing it, in bytes. */
export const HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Largest head it scans before calling the frame malformed, in bytes. */
export const HTTP_MAX_HEAD_BYTES = 64 * 1024;

/** Read frames one exchange may consume before refusing (a chatty peer must not spin forever). */
export const HTTP_MAX_FRAMES = 512;

/**
 * Per-step timeout in milliseconds. `connect` covers the whole SSH handshake
 * (russh auth included); `detect`/`register` bound one remote `exec`; `tunnel`
 * bounds opening both `direct-tcpip` channels.
 */
export const PROVISION_TIMEOUTS: Readonly<Record<ProvisionStep, number>> = {
  connect: 10_000,
  /** Local comparison of the QR fingerprint with the handshake one. */
  fingerprint: 5_000,
  /** Loopback probe over `exec` (both ports, 2 s each). */
  detect: 15_000,
  /** `mkdir`/`touch`/`grep`/`printf` over `exec` on `~/.ssh/authorized_keys`. */
  register: 15_000,
  /** Two `direct-tcpip` channel opens. */
  tunnel: 15_000,
};

/** Timeout of the initial SSH connection (V2/V3 handshake). */
export const SSH_CONNECT_TIMEOUT_MS = PROVISION_TIMEOUTS.connect;

/** Copy shown when a step does not answer (`docs/mobile-views-plan.md` §1.4). */
export const TIMEOUT_COPY = 'No respondió a tiempo. Inténtalo de nuevo.';

/** Copy shown when the QR fingerprint cannot be checked or does not match. */
export const FINGERPRINT_COPY = {
  /** The QR carries no usable 64-hex SHA-256 host fingerprint. */
  invalidQr: 'El QR no trae una huella ed25519 válida: volvé a escanearlo.',
  /** The core opened the session without reporting the host key it saw. */
  unreported:
    'La sesión SSH no devolvió la huella del host, así que no podemos comprobar la del QR.',
  /** The host key the session saw is not the one the QR pinned. */
  mismatch: 'La huella del host no coincide con la del QR: alguien puede estar en el medio.',
} as const;

/** Normalized step failure (`kind` is the core error code). */
export interface ProvisionFailure {
  kind: string;
  message: string;
}

/** Outcome of the `register` step, kept for the screen/settings. */
export interface DeviceRegistration {
  /** Host-side identity of this phone, when the core reports one. */
  deviceId?: string;
  /** `authorized_keys` line that was installed. */
  authorizedKey?: string;
  /** Anything else the core returned. */
  [key: string]: unknown;
}

/** Outcome of `provisionFlow`. */
export type ProvisionResult =
  | { ok: true; sessionId: string; registration?: DeviceRegistration; tunnel: TunnelHandles }
  | { ok: false; failedStep: ProvisionStep; error: ProvisionFailure };

/** Callbacks the screen uses to render the step list. */
export interface ProvisionCallbacks {
  onStepStart?(step: ProvisionStep): void;
  onStepDone?(step: ProvisionStep, result: unknown): void;
  onStepError?(step: ProvisionStep, error: ProvisionFailure, raw: unknown): void;
}

/** Minimal logger surface the flow uses (`logger.failure` of `lib/logger.ts`). */
export interface ProvisionLogger {
  failure(step: string, error: unknown, raw?: unknown): void;
  /** Informational progress line; optional — the app logger has it, tests may not. */
  info?(message: string, meta?: unknown): void;
}

/** Injectable dependencies (native bridge + clock + logger). */
export interface ProvisionDeps {
  /** `callGc(fn, payloadJson)` from `modules/gentle-core`. */
  call?: (fn: string, payloadJson: string) => Promise<string>;
  /** Per-step timeout overrides (tests). */
  timeouts?: Partial<Record<ProvisionStep, number>>;
  /** Ceiling of one write/close channel call, in ms (default `CHANNEL_CALL_TIMEOUT_MS`). */
  channelCallTimeoutMs?: number;
  /** Extra window the TS guard adds on top of a read's `timeoutMs` (default `CHANNEL_GUARD_MARGIN_MS`). */
  channelGuardMarginMs?: number;
  /** Failure sink; defaults to the app logger. */
  logger?: ProvisionLogger;
  /** Phone ed25519 public key (hex) when the app already holds it. */
  devicePubkeyHex?: string;
}

/** One tunnel channel: a loopback port of the extension, reached over SSH (S4). */
export interface TunnelChannel {
  /** Host the channel targets (the extension's loopback). */
  host: string;
  /** Port of the extension that this channel reaches. */
  port: number;
  /** Channel handle `gc_ssh_channel_read`/`write`/`close` address. */
  channelId: number;
}

/**
 * What the `tunnel` step really left behind: the session plus one open channel
 * per extension port. This is the object the rest of the app speaks HTTP/WS
 * through; before the pivot it was discarded.
 */
export interface TunnelHandles {
  /** Session id the channels belong to. */
  sessionId: string;
  /** Opened channels, in the order the forwards were requested. */
  channels: TunnelChannel[];
}

/** One channel call that succeeded. */
export interface ChannelWriteResult {
  ok: true;
  /** Bytes handed to the transport. */
  written: number;
}

/** One read frame (`gc_ssh_channel_read`). */
export interface ChannelReadResult {
  ok: true;
  /** Bytes that arrived; empty on a timeout and when the peer closed. */
  bytes: Uint8Array;
  /** True when the host closed the channel; later reads can only fail. */
  eof: boolean;
}

/** One channel call that closed the channel. */
export interface ChannelCloseResult {
  ok: true;
}

/** Honest failure of a channel call (the core reason, verbatim). */
export interface ChannelFailure {
  ok: false;
  error: ProvisionFailure;
}

/** Bridge function names (frozen by the native module, see its README). */
export const GC_FUNCTIONS = {
  abiVersion: 'gc_abi_version',
  pairFromQr: 'gc_pair_from_qr',
  sshConnect: 'gc_ssh_connect',
  provisionStep: 'gc_provision_step',
  deviceKeyGenerate: 'gc_device_key_generate',
  channelWrite: 'gc_ssh_channel_write',
  channelRead: 'gc_ssh_channel_read',
  channelClose: 'gc_ssh_channel_close',
} as const;

/** Visible rows of the progress list: exactly one per step (the pivot has no sub-steps). */
export type ProvisionRow = ProvisionStep;

/** Row order of the progress list. */
export const PROVISION_ROWS: readonly ProvisionRow[] = PROVISION_STEPS;

/** Timeout of `step`, or its override. */
export function timeoutFor(step: ProvisionStep, timeouts?: Partial<Record<ProvisionStep, number>>): number {
  return timeouts?.[step] ?? PROVISION_TIMEOUTS[step];
}

/** Which visible row owns a step: one row per step in the pivot flow. */
export function rowForStep(step: ProvisionStep): ProvisionRow {
  return step;
}

/** Step-based overall progress over the visible rows (0–100). */
export function overallPercent(completed: number, total = PROVISION_ROWS.length, partial = 0): number {
  const raw = ((completed + partial) / total) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Normalizes any thrown/returned value into a step failure. */
function toFailure(error: unknown): ProvisionFailure {
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  if (typeof error === 'object' && error !== null) {
    const value = error as { kind?: unknown; name?: unknown; message?: unknown };
    const kind = typeof value.kind === 'string' ? value.kind : typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : String(error);
    return { kind, message };
  }
  return { kind: 'Error', message: String(error) };
}

/** Parsed envelope the core answers with (`{ok, result|error, raw}`). */
interface BridgeEnvelope {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  raw?: unknown;
}

function parseEnvelope(response: string): BridgeEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw { kind: 'BadResponse', message: 'El núcleo devolvió algo que no entendemos.' };
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as BridgeEnvelope).ok !== 'boolean') {
    throw { kind: 'BadResponse', message: 'El núcleo devolvió algo que no entendemos.' };
  }
  return parsed as BridgeEnvelope;
}

/** Resolves `promise`, rejecting with the timeout copy after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject({ kind: 'Timeout', message: TIMEOUT_COPY }), ms);
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      // Node (tests): a pending timeout must not keep the process alive.
      (timer as unknown as { unref(): void }).unref();
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Bridge used when `deps.call` is not injected. */
async function defaultCall(fn: string, payloadJson: string): Promise<string> {
  const { callGc } = await import('../modules/gentle-core');
  return callGc(fn, payloadJson);
}

/**
 * Failure sink. `lib/logger.ts` is loaded lazily so this module stays free of
 * the `expo-file-system` surface and can be exercised by `node --test` with an
 * injected logger.
 */
let cachedLogger: ProvisionLogger | null = null;

async function resolveLogger(injected?: ProvisionLogger): Promise<ProvisionLogger> {
  if (injected) {
    return injected;
  }
  if (cachedLogger === null) {
    const module = await import('./logger');
    cachedLogger = module.logger;
  }
  return cachedLogger;
}

/* ------------------------------------------------------------------ *
 * Byte / shell helpers used to compose the steps the ABI does not have
 * ------------------------------------------------------------------ */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard (padded) base64 of `bytes`, so the app needs no `Buffer`. */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? (bytes[index + 1] as number) : -1;
    const c = index + 2 < bytes.length ? (bytes[index + 2] as number) : -1;
    out += BASE64_ALPHABET[a >> 2] ?? '';
    out += BASE64_ALPHABET[((a & 0x03) << 4) | ((b === -1 ? 0 : b) >> 4)] ?? '';
    out += b === -1 ? '=' : (BASE64_ALPHABET[((b & 0x0f) << 2) | ((c === -1 ? 0 : c) >> 6)] ?? '');
    out += c === -1 ? '=' : (BASE64_ALPHABET[c & 0x3f] ?? '');
  }
  return out;
}

/** Decodes lowercase/uppercase hex into bytes; `null` when it is not hex. */
export function hexToBytes(hex: string): Uint8Array | null {
  const compact = hex.trim().toLowerCase().replace(/[\s:]/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/.test(compact)) {
    return null;
  }
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** One POSIX-shell single-quoted word, so a value can never reach the shell raw. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** Ed25519 public key blob length (`mobile-core/src/device_key.rs`). */
export const ED25519_PUBLIC_KEY_LEN = 32;

/** SSH key type written to `authorized_keys`. */
export const ED25519_KEY_TYPE = 'ssh-ed25519';

/** Appends one length-prefixed SSH string (RFC 4251 §5) to `out`. */
function pushSshString(out: number[], value: Uint8Array): void {
  const length = value.length;
  out.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  for (const byte of value) {
    out.push(byte);
  }
}

/** ASCII bytes of `value` (the SSH key type is ASCII; no `TextEncoder` needed). */
function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0x7f;
  }
  return bytes;
}

/**
 * `authorized_keys` line for the phone's ed25519 key (S4: the QR flow installs
 * this line on the host, so later connections are key-only).
 *
 * The line is `ssh-ed25519 <base64 of "ssh-ed25519" || pubkey> <comment>`, the
 * OpenSSH wire form, built from the 32-byte public key the core returns as hex.
 * Throws a typed `Crypto` failure for a key that is not 32-byte hex.
 */
export function sshEd25519AuthorizedKey(
  publicKeyHex: string,
  comment: string = AUTHORIZED_KEY_COMMENT,
): string {
  const keyBytes = hexToBytes(publicKeyHex);
  if (keyBytes === null || keyBytes.length !== ED25519_PUBLIC_KEY_LEN) {
    throw {
      kind: 'Crypto',
      message: `La clave pública ed25519 del teléfono no es ${ED25519_PUBLIC_KEY_LEN} bytes en hex.`,
    };
  }
  const blob: number[] = [];
  pushSshString(blob, asciiBytes(ED25519_KEY_TYPE));
  pushSshString(blob, keyBytes);
  const encoded = base64Encode(Uint8Array.from(blob));
  const suffix = comment.trim() === '' ? '' : ` ${comment.trim()}`;
  return `${ED25519_KEY_TYPE} ${encoded}${suffix}`;
}

/**
 * Idempotent `authorized_keys` install: append `line` only when the exact line
 * is not there yet. `umask 077` + `mkdir -p` keep `.ssh` private on a host that
 * never had one, and `grep -qxF` compares the whole line literally, so running
 * `register` twice leaves exactly one entry.
 */
export function authorizedKeysScript(line: string): string {
  const quoted = shellQuote(line);
  return [
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    `grep -qxF ${quoted} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${quoted} >> "$HOME/.ssh/authorized_keys"`,
  ].join('\n');
}

/**
 * Loopback probe the `detect` step runs on the host (S4: "detectar la extensión
 * Pi corriendo en loopback 43721/43722").
 *
 * One reachability check per port, using whichever of `nc`, bash's `/dev/tcp`
 * or `curl` the host actually has; a port counts as listening when a TCP
 * connection succeeds. The script prints the ports that answered and exits
 * non-zero unless **all** of them did, so the step can only pass when the
 * extension really serves both ports.
 */
export function loopbackProbeScript(
  ports: readonly number[] = EXTENSION_LOOPBACK_PORTS,
  host: string = EXTENSION_LOOPBACK_HOST,
  connectTimeoutSeconds = 2,
): string {
  const checked = ports.map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw { kind: 'Input', message: `Puerto loopback inválido: ${port}` };
    }
    return String(port);
  });
  if (checked.length === 0) {
    throw { kind: 'Input', message: 'La sonda necesita al menos un puerto loopback.' };
  }
  return [
    `probe_port() {`,
    `  _port="$1"`,
    `  if command -v nc >/dev/null 2>&1; then`,
    `    nc -z -w ${connectTimeoutSeconds} ${host} "$_port" >/dev/null 2>&1 && return 0`,
    `  fi`,
    `  if command -v bash >/dev/null 2>&1; then`,
    `    bash -c 'exec 3<>/dev/tcp/${host}/'"$_port" >/dev/null 2>&1 && return 0`,
    `  fi`,
    `  if command -v curl >/dev/null 2>&1; then`,
    `    curl -s -o /dev/null -m ${connectTimeoutSeconds} "http://${host}:$_port/" >/dev/null 2>&1 && return 0`,
    `  fi`,
    `  return 1`,
    `}`,
    `_found=""`,
    `_missed=0`,
    `for _port in ${checked.join(' ')}; do`,
    `  if probe_port "$_port"; then _found="$_found $_port"; else _missed=$((_missed + 1)); fi`,
    `done`,
    `printf '%s\\n' "$_found"`,
    `[ "$_missed" -eq 0 ]`,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Fingerprint (step 2)
 * ------------------------------------------------------------------ */

/** Length in hex characters of a SHA-256 host fingerprint. */
export const FINGERPRINT_HEX_LEN = 64;

/**
 * Compact lowercase form of a host fingerprint: an optional `SHA256:` display
 * prefix and `:`/`-` separators are dropped, exactly like the QR parser and
 * `mobile-core/src/fingerprint.rs`. `null` when it is not 64 hex chars.
 */
export function normalizeHostFingerprint(value: string): string | null {
  const withoutPrefix = value.trim().replace(/^sha256:/i, '');
  const compact = withoutPrefix.replace(/[\s:-]/g, '').toLowerCase();
  if (compact.length !== FINGERPRINT_HEX_LEN || !/^[0-9a-f]+$/.test(compact)) {
    return null;
  }
  return compact;
}

/** Verdict of the local fingerprint comparison. */
export type FingerprintVerdict =
  | { ok: true; fingerprint: string }
  | { ok: false; error: ProvisionFailure };

/**
 * Compares the fingerprint the QR carried with the one the SSH handshake
 * reported. There is no "assume it matches" branch: a QR without a usable
 * fingerprint, or a session that reported none, is an honest failure.
 */
export function verifyHostFingerprint(expected: string, observed: string | undefined): FingerprintVerdict {
  const wanted = normalizeHostFingerprint(expected);
  if (wanted === null) {
    return { ok: false, error: { kind: 'Fingerprint', message: FINGERPRINT_COPY.invalidQr } };
  }
  const seen = observed === undefined || observed.trim() === '' ? null : normalizeHostFingerprint(observed);
  if (seen === null) {
    return { ok: false, error: { kind: 'Fingerprint', message: FINGERPRINT_COPY.unreported } };
  }
  if (seen !== wanted) {
    return { ok: false, error: { kind: 'FingerprintMismatch', message: FINGERPRINT_COPY.mismatch } };
  }
  return { ok: true, fingerprint: wanted };
}

/* ------------------------------------------------------------------ *
 * Connect (step 1)
 * ------------------------------------------------------------------ */

/** Result of `connectPair`. */
export type ConnectResult =
  | { ok: true; sessionId: string; fingerprint?: string }
  | { ok: false; error: ProvisionFailure; raw?: unknown };

/**
 * Step 1: the SSH session the rest of the flow reuses. Honest failure when the
 * core is not in the build or the host rejects the credential.
 */
export async function connectPair(
  pair: PairInfo,
  credential: SshCredential | null,
  deps: ProvisionDeps = {},
): Promise<ConnectResult> {
  const call = deps.call ?? defaultCall;
  try {
    // Core contract (cabi gc_ssh_connect / SshConnectConfig): flat
    // host/port/user/credential. `pair` carries the QR metadata; only its
    // connection fields go on the wire. A null credential (QR-only flow) becomes
    // a password-less placeholder the core rejects with a typed error, which is
    // surfaced verbatim instead of guessed.
    const config = {
      host: pair.host,
      port: pair.port,
      user: pair.user,
      credential,
    };
    const response = await withTimeout(
      call(GC_FUNCTIONS.sshConnect, JSON.stringify(config)),
      timeoutFor('connect', deps.timeouts),
    );
    const envelope = parseEnvelope(response);
    if (!envelope.ok) {
      return { ok: false, error: toFailure(envelope.error), raw: envelope.raw ?? null };
    }
    const result = envelope.result as { sessionId?: unknown; fingerprint?: unknown } | undefined;
    // The Rust cabi serializes sessionId as a JSON number (u64 handle); accept
    // both number and string so a stricter core build cannot break the screen.
    const sessionId = result?.sessionId;
    if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
      return { ok: false, error: { kind: 'BadResponse', message: 'El núcleo no devolvió una sesión.' } };
    }
    return {
      ok: true,
      sessionId: String(sessionId),
      fingerprint: typeof result?.fingerprint === 'string' ? result.fingerprint : undefined,
    };
  } catch (error) {
    return { ok: false, error: toFailure(error) };
  }
}

/* ------------------------------------------------------------------ *
 * Tunnel channels (step 5 hands the app its HTTP/WS surface, S4)
 *
 * The `tunnel` step opens one SSH `direct-tcpip` channel per loopback port and
 * reports each handle as `channel_id`; those handles — not local ports — are how
 * the app reaches the extension. Everything below works on that handle and
 * carries the session/channel ids inside the JSON document (the native shim
 * splits them out, exactly like `gc_provision_step` does with `sessionId`).
 *
 * Failure contract (S7): every helper resolves a result union; nothing throws
 * and nothing waits forever. A read window that expires is an empty frame with
 * `eof:false` (the core's own outcome, **not** an error); a closed/unknown
 * channel, a malformed frame or a bridge that never answers becomes a
 * `ProvisionFailure` the caller can show, and is also logged as
 * `logger.failure('channel', error, {port, channelId, raw})`.
 * ------------------------------------------------------------------ */

/**
 * Parses the `tunnel` step result into the handles the app keeps.
 *
 * Accepts `{forwards:[{host, port, channel_id}]}` (the core's `TunnelResult`),
 * and throws a typed `BadResponse` failure when the core reports no channel: an
 * empty tunnel must never look like a working one.
 */
export function parseTunnelChannels(result: unknown): TunnelChannel[] {
  const forwards = (result as { forwards?: unknown } | null | undefined)?.forwards;
  if (!Array.isArray(forwards) || forwards.length === 0) {
    throw { kind: 'BadResponse', message: 'El túnel no devolvió ningún canal abierto.' };
  }
  return forwards.map((entry) => {
    const record = (entry ?? {}) as { host?: unknown; port?: unknown; channel_id?: unknown; channelId?: unknown };
    const host = typeof record.host === 'string' && record.host.trim() !== '' ? record.host.trim() : EXTENSION_LOOPBACK_HOST;
    const port = Number(record.port);
    const rawChannel = record.channel_id ?? record.channelId;
    const channelId = Number(rawChannel);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw { kind: 'BadResponse', message: `El túnel devolvió un puerto inválido: ${String(record.port)}` };
    }
    if (!Number.isInteger(channelId) || channelId < 0) {
      throw { kind: 'BadResponse', message: `El túnel devolvió un canal inválido: ${String(rawChannel)}` };
    }
    return { host, port, channelId };
  });
}

/** The handle serving `port`, or `null` when the tunnel never opened that port. */
export function tunnelChannelFor(tunnel: TunnelHandles, port: number): TunnelChannel | null {
  return tunnel.channels.find((channel) => channel.port === port) ?? null;
}

/** UTF-8 bytes of a request string (no `TextEncoder`: Hermes does not guarantee it). */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.codePointAt(index) as number;
    if (code > 0xffff) {
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * Normalizes a channel failure, keeping the `kind` a typed error carries (a
 * malformed base64 frame is `Frame`, not the error class name).
 */
function toChannelFailure(error: unknown): ProvisionFailure {
  if (typeof error === 'object' && error !== null && typeof (error as { kind?: unknown }).kind === 'string') {
    const value = error as { kind: string; message?: unknown };
    return {
      kind: value.kind,
      message: typeof value.message === 'string' ? value.message : String(error),
    };
  }
  return toFailure(error);
}

/** Sends the failure to `logger.failure` with the `{step, error, raw}` shape. */
async function logChannelFailure(
  deps: ProvisionDeps,
  channel: TunnelChannel,
  error: ProvisionFailure,
  raw: unknown,
): Promise<void> {
  try {
    const log = await resolveLogger(deps.logger);
    log.failure('channel', error, { port: channel.port, channelId: channel.channelId, raw: raw ?? null });
  } catch {
    // A logger that cannot be loaded must never break the data path (S7).
  }
}

/** Channel ids ride in the document; the native shim splits them like `gc_provision_step`'s. */
function channelPayload(sessionId: string, channel: TunnelChannel, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ sessionId: Number(sessionId) || 0, channelId: channel.channelId, ...extra });
}

/** One channel call through the bridge, bounded, with the envelope unpacked. */
async function callChannel(
  fn: string,
  payload: string,
  boundMs: number,
  deps: ProvisionDeps,
): Promise<{ ok: true; result: unknown } | { ok: false; error: ProvisionFailure; raw: unknown }> {
  const call = deps.call ?? defaultCall;
  try {
    const envelope = parseEnvelope(await withTimeout(call(fn, payload), boundMs));
    if (!envelope.ok) {
      return { ok: false, error: toChannelFailure(envelope.error), raw: envelope.raw ?? null };
    }
    return { ok: true, result: envelope.result };
  } catch (error) {
    return { ok: false, error: toChannelFailure(error), raw: null };
  }
}

/** Ceiling of one write/close call. */
function channelCeiling(deps: ProvisionDeps): number {
  return deps.channelCallTimeoutMs ?? CHANNEL_CALL_TIMEOUT_MS;
}

/**
 * Ceiling of one read: the window the core honours plus the TS guard, so a
 * native call that never returns cannot hang the caller.
 */
function readCeiling(timeoutMs: number, deps: ProvisionDeps): number {
  return timeoutMs + (deps.channelGuardMarginMs ?? CHANNEL_GUARD_MARGIN_MS);
}

/**
 * `gc_ssh_channel_write` — writes `bytes` on a tunnel channel (S4).
 *
 * An empty payload is refused here (`Input`) because the core rejects it too,
 * and a closed/unknown channel answers the core's `ssh` failure verbatim.
 */
export async function channelWrite(
  sessionId: string,
  channel: TunnelChannel,
  bytes: Uint8Array,
  deps: ProvisionDeps = {},
): Promise<ChannelWriteResult | ChannelFailure> {
  if (bytes.length === 0) {
    return { ok: false, error: { kind: 'Input', message: 'El canal no puede escribir un payload vacío.' } };
  }
  const payload = channelPayload(sessionId, channel, { bytes: base64Encode(bytes) });
  const outcome = await callChannel(GC_FUNCTIONS.channelWrite, payload, channelCeiling(deps), deps);
  if (!outcome.ok) {
    await logChannelFailure(deps, channel, outcome.error, outcome.raw);
    return { ok: false, error: outcome.error };
  }
  const written = Number((outcome.result as { written?: unknown } | undefined)?.written);
  return { ok: true, written: Number.isFinite(written) ? written : bytes.length };
}

/**
 * `gc_ssh_channel_read` — reads one frame from a tunnel channel (S4).
 *
 * `timeoutMs: 0` is a non-blocking poll and an expired window is the honest
 * `{bytes: empty, eof: false}` outcome, not an error (S7). A frame that is not
 * standard base64, or one without a `bytes` field, is a `Frame`/`BadResponse`
 * failure instead of being read as empty.
 */
export async function channelRead(
  sessionId: string,
  channel: TunnelChannel,
  timeoutMs: number = CHANNEL_READ_TIMEOUT_MS,
  deps: ProvisionDeps = {},
): Promise<ChannelReadResult | ChannelFailure> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    return { ok: false, error: { kind: 'Input', message: `Ventana de lectura inválida: ${String(timeoutMs)}` } };
  }
  const payload = channelPayload(sessionId, channel, { timeoutMs });
  const outcome = await callChannel(GC_FUNCTIONS.channelRead, payload, readCeiling(timeoutMs, deps), deps);
  if (!outcome.ok) {
    await logChannelFailure(deps, channel, outcome.error, outcome.raw);
    return { ok: false, error: outcome.error };
  }
  const result = outcome.result as { bytes?: unknown; eof?: unknown } | undefined;
  if (typeof result?.bytes !== 'string') {
    const error: ProvisionFailure = {
      kind: 'BadResponse',
      message: 'El núcleo devolvió una lectura sin bytes.',
    };
    await logChannelFailure(deps, channel, error, result ?? null);
    return { ok: false, error };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64DecodeBytes(result.bytes);
  } catch (error) {
    const failure = toChannelFailure(error);
    await logChannelFailure(deps, channel, failure, result.bytes);
    return { ok: false, error: failure };
  }
  return { ok: true, bytes, eof: result.eof === true };
}

/** `gc_ssh_channel_close` — closes a tunnel channel and frees its id (S4). */
export async function channelClose(
  sessionId: string,
  channel: TunnelChannel,
  deps: ProvisionDeps = {},
): Promise<ChannelCloseResult | ChannelFailure> {
  const payload = channelPayload(sessionId, channel);
  const outcome = await callChannel(GC_FUNCTIONS.channelClose, payload, channelCeiling(deps), deps);
  if (!outcome.ok) {
    await logChannelFailure(deps, channel, outcome.error, outcome.raw);
    return { ok: false, error: outcome.error };
  }
  return { ok: true };
}

/**
 * Standard base64 decode of a frame (the same rules as `core.base64Decode`,
 * duplicated here because this module cannot import `core.ts` at runtime: the
 * `node --test` runner resolves `.ts` specifiers only with an extension, which
 * `tsc` rejects. `mobile/test/tunnel.test.mjs` pins that both agree).
 */
function base64DecodeBytes(text: string): Uint8Array {
  const compact = text.replace(/\s/g, '');
  if (compact.length === 0) {
    return new Uint8Array(0);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw { kind: 'Frame', message: 'El payload no es base64 estándar.' };
  }
  const body = compact.replace(/=+$/, '');
  if (body.length % 4 === 1) {
    throw { kind: 'Frame', message: 'El payload base64 tiene un largo imposible.' };
  }
  const pads = compact.length - body.length;
  if (pads > 0 && (compact.length % 4 !== 0 || pads !== (4 - (body.length % 4)) % 4)) {
    throw { kind: 'Frame', message: 'El padding del payload base64 no es válido.' };
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) {
      throw { kind: 'Frame', message: 'El payload no es base64 estándar.' };
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/** Head of the response read so far, and whether more bytes are needed. */
export interface HttpResponseHead {
  /** Status code of the response line, or `null` while no complete head was read. */
  status: number | null;
  /** Index just past the blank line ending the headers (`-1` until they end). */
  headEnd: number;
  /** True when nothing else is needed: the response is complete. */
  complete: boolean;
}

/** Statuses whose response has no body, so its head is the whole response. */
const BODYLESS_STATUSES: readonly number[] = [204, 304];

/** ASCII/latin1 text of some bytes (heads are ASCII; no decode of the body). */
function latin1Text(bytes: Uint8Array, limit: number = bytes.length): string {
  let out = '';
  for (let index = 0; index < Math.min(limit, bytes.length); index += 1) {
    out += String.fromCharCode(bytes[index] as number);
  }
  return out;
}

/** True when `bytes` ends with the ASCII `suffix`. */
function endsWithAscii(bytes: Uint8Array, suffix: string): boolean {
  if (bytes.length < suffix.length) {
    return false;
  }
  const start = bytes.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (bytes[start + index] !== suffix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/** Case-insensitive value of header `name` inside an already decoded head. */
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
 * Tells whether the bytes read so far are a complete HTTP response.
 *
 * Completion is decided by what the response itself declares: a `Content-Length`
 * that is satisfied, a chunked body that reached its last-chunk terminator, a
 * bodyless status, or — when the response carries no framing at all — only the
 * peer closing the channel (so `complete` stays `false` here and the caller
 * finishes on `eof`). Pure, so it is pinned by unit tests.
 */
export function inspectHttpResponse(bytes: Uint8Array): HttpResponseHead {
  const head = latin1Text(bytes, HTTP_MAX_HEAD_BYTES);
  const crlf = head.indexOf('\r\n\r\n');
  const lf = crlf < 0 ? head.indexOf('\n\n') : -1;
  const headEnd = crlf >= 0 ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
  if (headEnd < 0) {
    return { status: null, headEnd: -1, complete: false };
  }
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
  if (match === null) {
    return { status: null, headEnd, complete: false };
  }
  const status = Number(match[1]);
  if (status < 200 || BODYLESS_STATUSES.includes(status)) {
    return { status, headEnd, complete: true };
  }
  const headers = head.slice(0, headEnd);
  const contentLength = headerValue(headers, 'content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    return { status, headEnd, complete: bytes.length - headEnd >= Number(contentLength) };
  }
  if ((headerValue(headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    return { status, headEnd, complete: endsWithAscii(bytes, '0\r\n\r\n') };
  }
  return { status, headEnd, complete: false };
}

/** Options of one HTTP exchange over a tunnel channel. */
export interface HttpExchangeOptions {
  /** Budget of the whole exchange, in ms (default `HTTP_EXCHANGE_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Per-read window handed to the core, in ms (default `CHANNEL_READ_TIMEOUT_MS`). */
  readTimeoutMs?: number;
  /** Largest response it assembles before refusing, in bytes. */
  maxBytes?: number;
  /** Read frames it may consume before refusing. */
  maxFrames?: number;
  /** Bridge/logger/timeout overrides (`deps.call` is the native bridge). */
  deps?: ProvisionDeps;
}

/** Outcome of one HTTP exchange over the tunnel. */
export type HttpExchangeResult =
  | {
      ok: true;
      /** Status code of the response line, or `null` when there was none. */
      status: number | null;
      /** Response head text (empty when no complete head arrived). */
      head: string;
      /** Everything the channel delivered, in order. */
      response: Uint8Array;
      /** True when the response is complete per its own framing. */
      complete: boolean;
      /** True when the peer closed the channel before the framing was satisfied. */
      eof: boolean;
      /** Read frames consumed. */
      frames: number;
    }
  | { ok: false; error: ProvisionFailure };

/**
 * Speaks one HTTP request/response over the tunnel (S4): writes the request on
 * the channel serving `port`, then reads frames until the response is complete
 * (its own framing) or the peer closes the channel (S7: a closed channel is an
 * `ok` result with `eof:true`, not a hang, and a failed read is a failure with
 * the core's reason). Every wait is bounded: the per-read window by
 * `readTimeoutMs` plus the TS guard, the whole exchange by `timeoutMs`.
 */
export async function httpOverTunnel(
  tunnel: TunnelHandles,
  port: number,
  request: string | Uint8Array,
  options: HttpExchangeOptions = {},
): Promise<HttpExchangeResult> {
  const channel = tunnelChannelFor(tunnel, port);
  if (channel === null) {
    return {
      ok: false,
      error: { kind: 'NoChannel', message: `El túnel no tiene un canal abierto al puerto ${port}.` },
    };
  }
  const deps = options.deps ?? {};
  const readWindow = options.readTimeoutMs ?? CHANNEL_READ_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? HTTP_MAX_RESPONSE_BYTES;
  const maxFrames = options.maxFrames ?? HTTP_MAX_FRAMES;
  const deadline = Date.now() + (options.timeoutMs ?? HTTP_EXCHANGE_TIMEOUT_MS);

  const written = await channelWrite(
    tunnel.sessionId,
    channel,
    typeof request === 'string' ? utf8Bytes(request) : request,
    deps,
  );
  if (!written.ok) {
    return { ok: false, error: written.error };
  }

  let response = new Uint8Array(0);
  let frames = 0;
  let complete = false;
  let eof = false;
  let status: number | null = null;
  let headEnd = -1;

  while (frames < maxFrames) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: { kind: 'Timeout', message: TIMEOUT_COPY } };
    }
    const frame = await channelRead(tunnel.sessionId, channel, Math.max(1, Math.min(readWindow, remaining)), deps);
    if (!frame.ok) {
      return { ok: false, error: frame.error };
    }
    frames += 1;
    if (frame.bytes.length > 0) {
      if (response.length + frame.bytes.length > maxBytes) {
        const error: ProvisionFailure = {
          kind: 'TooLarge',
          message: `La respuesta pasó el máximo de ${maxBytes} bytes.`,
        };
        await logChannelFailure(deps, channel, error, { received: response.length + frame.bytes.length });
        return { ok: false, error };
      }
      const merged = new Uint8Array(response.length + frame.bytes.length);
      merged.set(response);
      merged.set(frame.bytes, response.length);
      response = merged;
    }
    const head = inspectHttpResponse(response);
    status = head.status ?? status;
    headEnd = head.headEnd >= 0 ? head.headEnd : headEnd;
    if (head.complete) {
      complete = true;
      break;
    }
    if (headEnd < 0 && response.length > HTTP_MAX_HEAD_BYTES) {
      const error: ProvisionFailure = {
        kind: 'Frame',
        message: 'La respuesta no trae cabeceras HTTP válidas.',
      };
      await logChannelFailure(deps, channel, error, { received: response.length });
      return { ok: false, error };
    }
    if (frame.eof) {
      eof = true;
      break;
    }
  }

  if (eof && headEnd < 0) {
    const error: ProvisionFailure = {
      kind: 'Frame',
      message: 'La respuesta terminó sin cabeceras HTTP.',
    };
    await logChannelFailure(deps, channel, error, { received: response.length });
    return { ok: false, error };
  }
  if (!complete && !eof) {
    const error: ProvisionFailure = {
      kind: 'Frame',
      message: `La respuesta no terminó en ${maxFrames} lecturas.`,
    };
    await logChannelFailure(deps, channel, error, { received: response.length, frames });
    return { ok: false, error };
  }

  return {
    ok: true,
    status,
    head: headEnd >= 0 ? latin1Text(response, headEnd) : '',
    response,
    // A head completed at eof with no framing header is the whole response.
    complete: complete || headEnd >= 0,
    eof,
    frames,
  };
}

/** What `closeTunnel` actually closed. */
export interface TunnelCloseReport {
  /** True only when every channel closed without an error. */
  ok: boolean;
  /** Ports whose channel closed. */
  closed: number[];
  /** Ports whose close failed, with the core reason verbatim. */
  errors: { port: number; error: ProvisionFailure }[];
}

/**
 * Closes every channel of the tunnel, best effort and honest (S4/S7): one
 * failing close does not skip the rest and never throws; a channel that is
 * already gone answers the core's `ssh` failure in `errors`.
 */
export async function closeTunnel(tunnel: TunnelHandles, deps: ProvisionDeps = {}): Promise<TunnelCloseReport> {
  const closed: number[] = [];
  const errors: { port: number; error: ProvisionFailure }[] = [];
  for (const channel of tunnel.channels) {
    const outcome = await channelClose(tunnel.sessionId, channel, deps);
    if (outcome.ok) {
      closed.push(channel.port);
    } else {
      errors.push({ port: channel.port, error: outcome.error });
    }
  }
  return { ok: errors.length === 0, closed, errors };
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

/** One step that goes through `gc_provision_step`. */
type ComposedStep = 'detect' | 'register' | 'tunnel';

/** Outcome of one `gc_provision_step` call. */
type StepOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: ProvisionFailure; raw: unknown };

/**
 * Runs `connect → fingerprint → detect → register → tunnel` (S4/S5).
 *
 * A failure stops the flow at that step and is surfaced verbatim to the
 * callbacks and to `logger.failure` (`{step, error, raw}`); nothing after the
 * failing step runs, nothing is retried, and no step is ever reported as done
 * when the core did not answer ok.
 */
export async function provisionFlow(
  pair: PairInfo,
  credential: SshCredential | null,
  callbacks: ProvisionCallbacks = {},
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const call = deps.call ?? defaultCall;
  const log = await resolveLogger(deps.logger);
  const timeouts = deps.timeouts;

  /** Surfaces a failed step: callback, `{step, error, raw}` log, honest result. */
  const stop = (
    step: ProvisionStep,
    error: ProvisionFailure,
    raw: unknown,
  ): { ok: false; failedStep: ProvisionStep; error: ProvisionFailure } => {
    callbacks.onStepError?.(step, error, raw);
    log.failure(step, error, raw);
    return { ok: false, failedStep: step, error };
  };

  /** Sends one composed step to the core, bounded by its timeout. */
  const runComposed = async (
    step: ComposedStep,
    payload: Record<string, unknown>,
    sessionId: string,
  ): Promise<StepOutcome> => {
    try {
      const body = {
        // The cabi reads the session id from its own argument and ignores this
        // field; it stays because the module README freezes the payload shape.
        sessionId: Number(sessionId) || 0,
        step,
        ...payload,
      };
      const response = await withTimeout(
        call(GC_FUNCTIONS.provisionStep, JSON.stringify(body)),
        timeoutFor(step, timeouts),
      );
      const envelope = parseEnvelope(response);
      return envelope.ok
        ? { ok: true, result: envelope.result }
        : { ok: false, error: toFailure(envelope.error), raw: envelope.raw ?? null };
    } catch (error) {
      return { ok: false, error: toFailure(error), raw: null };
    }
  };

  // 1) connect -------------------------------------------------------------
  callbacks.onStepStart?.('connect');
  const connection = await connectPair(pair, credential, deps);
  if (!connection.ok) {
    return stop('connect', connection.error, connection.raw ?? null);
  }
  const sessionId = connection.sessionId;
  callbacks.onStepDone?.('connect', { sessionId, host: pair.host, port: pair.port });

  // 2) fingerprint ---------------------------------------------------------
  callbacks.onStepStart?.('fingerprint');
  const verdict = verifyHostFingerprint(pair.fp, connection.fingerprint);
  if (!verdict.ok) {
    return stop('fingerprint', verdict.error, {
      expected: pair.fp,
      observed: connection.fingerprint ?? null,
    });
  }
  callbacks.onStepDone?.('fingerprint', { fingerprint: verdict.fingerprint });

  // 3) detect --------------------------------------------------------------
  callbacks.onStepStart?.('detect');
  let detectScript: string;
  try {
    detectScript = loopbackProbeScript();
  } catch (error) {
    return stop('detect', toFailure(error), { ports: EXTENSION_LOOPBACK_PORTS });
  }
  const detected = await runComposed(
    'detect',
    { ports: [...EXTENSION_LOOPBACK_PORTS], command: detectScript },
    sessionId,
  );
  if (!detected.ok) {
    return stop('detect', detected.error, detected.raw);
  }
  callbacks.onStepDone?.('detect', detected.result);
  log.info?.('extensión Pi detectada en loopback', {
    ports: EXTENSION_LOOPBACK_PORTS,
    result: detected.result ?? null,
  });

  // 4) register ------------------------------------------------------------
  callbacks.onStepStart?.('register');
  let devicePubkeyHex = deps.devicePubkeyHex ?? '';
  if (devicePubkeyHex === '') {
    let deviceKeyRaw: unknown;
    try {
      const keyResponse = await withTimeout(
        call(GC_FUNCTIONS.deviceKeyGenerate, '{}'),
        timeoutFor('register', timeouts),
      );
      deviceKeyRaw = JSON.parse(keyResponse);
    } catch (error) {
      return stop('register', toFailure(error), null);
    }
    // An explicit failure envelope keeps its kind (Crypto, Ssh, …) instead of
    // degrading to BadResponse.
    const failure = deviceKeyRaw as { ok?: unknown; error?: unknown } | null;
    if (failure && failure.ok === false) {
      return stop('register', toFailure(failure.error), deviceKeyRaw ?? null);
    }
    // The core documents `gc_device_key_generate` as {"ok":true,"key":{...}} but some
    // builds answer the bare {"key":{...}}; the key may also ride under `result`.
    // Accept both placements so the step fails only when there is genuinely no key.
    const container = (
      deviceKeyRaw as { key?: unknown; result?: { key?: unknown } } | null
    );
    const key =
      (container?.key as { public_hex?: unknown } | undefined) ??
      (container?.result?.key as { public_hex?: undefined } | undefined);
    devicePubkeyHex = typeof key?.public_hex === 'string' ? key.public_hex : '';
    if (devicePubkeyHex === '') {
      return stop(
        'register',
        { kind: 'BadResponse', message: 'El núcleo no devolvió la clave pública ed25519 del teléfono.' },
        deviceKeyRaw ?? null,
      );
    }
  }
  let authorizedKey: string;
  try {
    authorizedKey = sshEd25519AuthorizedKey(devicePubkeyHex);
  } catch (error) {
    return stop('register', toFailure(error), { devicePubkeyHex });
  }
  const registered = await runComposed(
    'register',
    {
      devicePubkeyHex,
      authorizedKey,
      deviceName: DEVICE_NAME,
      command: authorizedKeysScript(authorizedKey),
    },
    sessionId,
  );
  if (!registered.ok) {
    return stop('register', registered.error, registered.raw);
  }
  const registration: DeviceRegistration = {
    ...(typeof registered.result === 'object' && registered.result !== null
      ? (registered.result as DeviceRegistration)
      : {}),
    authorizedKey,
  };
  callbacks.onStepDone?.('register', registration);

  // 5) tunnel --------------------------------------------------------------
  callbacks.onStepStart?.('tunnel');
  const tunneled = await runComposed(
    'tunnel',
    {
      forwards: EXTENSION_LOOPBACK_PORTS.map((port) => ({ host: EXTENSION_LOOPBACK_HOST, port })),
    },
    sessionId,
  );
  if (!tunneled.ok) {
    return stop('tunnel', tunneled.error, tunneled.raw);
  }
  // The handles are the whole point of the step: keep them instead of dropping
  // the result, or fail honestly when the core reported no channel (S4/S7).
  let channels: TunnelChannel[];
  try {
    channels = parseTunnelChannels(tunneled.result);
  } catch (error) {
    return stop('tunnel', toChannelFailure(error), tunneled.result ?? null);
  }
  callbacks.onStepDone?.('tunnel', tunneled.result);
  log.info?.('túnel SSH abierto', { channels });

  return { ok: true, sessionId, registration, tunnel: { sessionId, channels } };
}