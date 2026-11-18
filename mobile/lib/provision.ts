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
 *
 * There is **no** binary upload, no release checksum, no daemon start and no
 * rollback in this flow (S5): those were the SFTP provisioning of the rejected
 * daemon. `mobile/test/provision.test.mjs` pins their absence.
 *
 * ## Composition instead of new ABI
 *
 * The C ABI stays frozen (`mobile/lib/core.ts` untouched): steps 3–5 are
 * expressed as `gc_provision_step` payloads. `detect` and `register` carry the
 * `sh` command they need composed here (`loopbackProbeScript`,
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
  | { ok: true; sessionId: string; registration?: DeviceRegistration }
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
  /** Failure sink; defaults to the app logger. */
  logger?: ProvisionLogger;
  /** Phone ed25519 public key (hex) when the app already holds it. */
  devicePubkeyHex?: string;
}

/** Bridge function names (frozen by the native module, see its README). */
export const GC_FUNCTIONS = {
  abiVersion: 'gc_abi_version',
  pairFromQr: 'gc_pair_from_qr',
  sshConnect: 'gc_ssh_connect',
  provisionStep: 'gc_provision_step',
  deviceKeyGenerate: 'gc_device_key_generate',
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
    let keyEnvelope: BridgeEnvelope;
    try {
      const keyResponse = await withTimeout(
        call(GC_FUNCTIONS.deviceKeyGenerate, '{}'),
        timeoutFor('register', timeouts),
      );
      keyEnvelope = parseEnvelope(keyResponse);
    } catch (error) {
      return stop('register', toFailure(error), null);
    }
    if (!keyEnvelope.ok) {
      return stop('register', toFailure(keyEnvelope.error), keyEnvelope.raw ?? null);
    }
    const key = (keyEnvelope.result as { key?: { public_hex?: unknown } } | undefined)?.key;
    devicePubkeyHex = typeof key?.public_hex === 'string' ? key.public_hex : '';
    if (devicePubkeyHex === '') {
      return stop(
        'register',
        { kind: 'BadResponse', message: 'El núcleo no devolvió la clave pública ed25519 del teléfono.' },
        keyEnvelope.result ?? null,
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
  callbacks.onStepDone?.('tunnel', tunneled.result);

  return { ok: true, sessionId, registration };
}