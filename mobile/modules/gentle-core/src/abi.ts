/**
 * Pure TypeScript contract of the **ABI v2** surface (T16/T18).
 *
 * This module holds no platform import on purpose: `index.ts` binds it to the Kotlin
 * module, `mobile/lib/core.ts` re-exports it for the app, and `mobile/test/core-abi.test.mjs`
 * exercises it in plain node. Every native call answers a JSON envelope
 * (`{ok:true,result:{…}}` / `{ok:false,error:{kind,message}}`, see
 * `mobile-core/src/cabi.rs`), and this file is the single place that turns those
 * envelopes into typed values or a `CoreCallError`.
 *
 * ## Secret hygiene (non-negotiable)
 *
 * The device seed never appears in a value this module returns: `deviceKeyEnsure` reads
 * `publicHex` and `fingerprint` only, builds a fresh object and **refuses** an answer that
 * carries `seed` / `secret` at all — forwarding it would recreate exactly the leak the
 * Rust side just closed. No error message in here interpolates a seed either.
 *
 * ## The file root is a privilege, not a parameter (SEC-003)
 *
 * `fsList`/`fsRead` take a root, and the root decides what the phone shows: `/etc`,
 * `/sdcard` and the app's own private directory were all reachable from JS before this
 * slice. The **authoritative** allowlist is native (`FsRoots.kt`, enforced in
 * `GcCoreModule` for both `gc_fs_*` symbols, so `callGc` cannot skip it); here the root is
 * additionally normalized (a `file://` URI, which is what `expo-file-system` answers for the
 * app's own directories, is reduced to its canonical path) and refused when it is not an
 * absolute, non-escaping path (`src/fs-roots.ts`), so an impossible root never crosses the
 * bridge.
 *
 * ## The connect answer always names the host key it verified (SEC-013)
 *
 * `sshConnectWithDeviceKey()` used to resolve on an `ok:true` answer whose `result` carried
 * no `fingerprint`. A caller that only looked at `ok` thought it held a pinned session while
 * nothing had verified the host. The contract now says the opposite: the connect record
 * **promises** the verified host key, and an answer without a usable one is a `Contract`
 * failure that names what came instead — never a success with an optional field.
 *
 * ## A close has two honest answers (SEC-012)
 *
 * `gc_ssh_close` removes the registry entry **before** awaiting the disconnect, so a
 * transport that still believes it is connected answers an `ssh` error after the handle is
 * already gone. That is not the same fact as "still open" and not a generic error: the
 * close resolves a typed outcome (`closed` vs `removed-unconfirmed`) so the caller can log
 * the real cause without mistaking the session for a live one or retrying blindly.
 *
 * ## Honesty
 *
 * A malformed answer is a `Contract` failure, never a default value: a listing whose entry
 * is neither `file` nor `dir`, a session id that is not a number, a missing fingerprint —
 * all of them throw instead of inventing something the UI could paint as success.
 */

import { normalizeDeviceRoot } from './fs-roots.ts';

/** What `deviceKeyEnsure()` resolves with — and nothing else. */
export interface DeviceKeyInfo {
  /** ed25519 public key in lowercase hex (64 characters). */
  publicHex: string;
  /** OpenSSH-style `SHA256:…` fingerprint of that public key. */
  fingerprint: string;
}

/** Input of `sshConnectWithDeviceKey()` (never carries the seed: Kotlin reads it). */
export interface SshConnectWithDeviceKeyInput {
  /** Host IP or hostname. */
  host: string;
  /** SSH port, 1..65535. */
  port: number;
  /** SSH user. */
  user: string;
  /** Host key fingerprint stored at pairing time (compact hex or `aa:bb:…`). Required. */
  expectedFingerprint: string;
}

/** What a pinned connect resolves with: the handle **and** the host key it verified. */
export interface SshConnectResult {
  /** Session handle the core registered, as a decimal string. */
  sessionId: string;
  /**
   * Host key the handshake really verified, compact lowercase hex (64 characters).
   *
   * Required: without it there is no pinned session, so a connect answer that omits it or
   * cannot parse it is refused instead of being handed out (SEC-013).
   */
  fingerprint: string;
}

/** A close the core really confirmed: the transport let go. */
export interface SshCloseConfirmed {
  readonly kind: 'closed';
  readonly sessionId: string;
}

/**
 * A close whose handle is gone while the transport still holds the connection.
 *
 * `gc_ssh_close` removes the session from the registry **before** awaiting the disconnect,
 * so this answer means "the id is freed, the teardown did not reach the host" — not "the
 * session is still open" and not an unexplained error (SEC-012).
 */
export interface SshCloseUnconfirmed {
  readonly kind: 'removed-unconfirmed';
  /** Handle that is already gone from the core registry. */
  readonly sessionId: string;
  /** The core's own message, verbatim, naming the transport that stayed connected. */
  readonly message: string;
  /** Typed core failure behind it, for the `{step, error, raw}` log. */
  readonly raw: { readonly kind: string; readonly message: string };
}

/** What `sshClose()` resolves with: one of the two teardown facts, never a guess. */
export type SshCloseOutcome = SshCloseConfirmed | SshCloseUnconfirmed;

/** One entry of `fsList()`. */
export interface FsEntry {
  /** Path relative to the root, with `/` separators. */
  path: string;
  /** Size in bytes for regular files; `null` for a directory (never an estimate). */
  size: number | null;
  /** Whether the entry is a file or a directory. */
  kind: 'file' | 'dir';
}

/** Input of `fsList()`. */
export interface FsListInput {
  /**
   * Absolute root the app may read. The native allowlist (`FsRoots.kt`: `filesDir`,
   * `cacheDir`) decides which ones those are; anything else is refused, never redirected.
   */
  root: string;
  /** Path relative to `root`; `''` is the root itself. */
  path: string;
  /** Entry window; the core defaults to 500 and caps at 5000. */
  maxEntries?: number;
}

/** Input of `fsRead()`. */
export interface FsReadInput {
  /** Absolute root the app may read; same allowlist as `fsList()`. */
  root: string;
  /** Path relative to `root`. */
  path: string;
  /** Byte window; the core defaults to 512 KiB and caps at 8 MiB. */
  maxBytes?: number;
}

/** Result of `fsRead()`. */
export interface FsReadResult {
  /** Parsed file text. Never a lossy decode: binary content is refused upstream. */
  text: string;
  /** Path relative to the root, exactly as the core normalized it. */
  path: string;
  /** **Real** size of the file in bytes. */
  size: number;
  /** True when `text` is only the first `maxBytes` bytes of a bigger file. */
  truncated: boolean;
}

/**
 * Failure of one core call.
 *
 * `kind` is the stable discriminator from the core (`ssh`, `not_found`,
 * `permission_denied`, `too_large`, `binary`, `invalid_path`, `outside_root`, `crypto`,
 * `io`, `input`) plus this layer's own `CoreUnavailable`, `NativeError`, `Input` and
 * `Contract`. `message` is verbatim UI text and never contains key material.
 */
export class CoreCallError extends Error {
  /** Stable discriminator, so screens branch on the kind instead of the message. */
  readonly kind: string;

  /** Method or symbol the failure belongs to, for the `{step, error, raw}` log. */
  readonly method: string;

  constructor(method: string, kind: string, message: string) {
    super(message);
    this.name = 'CoreCallError';
    this.method = method;
    this.kind = kind;
  }
}

/**
 * The Kotlin methods this module calls. Each takes the JSON document the C ABI expects and
 * answers the JSON envelope, exactly like `callGc`.
 */
export interface CoreNativeBridge {
  /** `deviceKeyEnsure` — mints once, seals the seed with the AndroidKeystore key. */
  deviceKeyEnsure(payloadJson: string): Promise<string>;
  /** `sshConnectWithDeviceKey` — device-key connect pinned to `expectedFp`. */
  sshConnectWithDeviceKey(payloadJson: string): Promise<string>;
  /** `sshClose` — `{sessionId}` → `{closed:true}`, or the removed-but-unconfirmed answer. */
  sshClose(payloadJson: string): Promise<string>;
  /** `fsList` — `{root, path, maxEntries?}` → `{entries}`. */
  fsList(payloadJson: string): Promise<string>;
  /** `fsRead` — `{root, path, maxBytes?}` → `{path, text, size, truncated}`. */
  fsRead(payloadJson: string): Promise<string>;
}

let bridge: CoreNativeBridge | null = null;

/**
 * Installs the native bridge. Called by `index.ts` once the Kotlin module is registered;
 * `null` means "no native core in this build", and every call then fails with
 * `CoreUnavailable` instead of pretending.
 */
export function bindCoreNativeBridge(next: CoreNativeBridge | null): void {
  bridge = next;
}

/** True when a native bridge is installed (diagnostics / tests). */
export function coreNativeBridgeBound(): boolean {
  return bridge !== null;
}

/** One JSON object, as `unknown` so every field has to be checked. */
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a fingerprint to compact lowercase hex, or `null` when it is not one. */
export function compactFingerprint(value: string): string | null {
  const compact = value
    .split(':')
    .join('')
    .split('-')
    .join('')
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(compact) ? compact : null;
}

/**
 * Names the value that arrived instead of a host fingerprint.
 *
 * A fingerprint is public, so it may be echoed; what never happens is inventing one. The
 * message has to say what came, or the caller cannot tell "the core answered an old shape"
 * from "the core answered garbage".
 */
function describeFingerprintField(value: unknown): string {
  if (value === undefined) {
    return 'el campo «fingerprint» no vino';
  }
  if (value === null) {
    return 'llegó null';
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? 'llegó vacío' : `llegó «${text}»`;
  }
  return `llegó un ${typeof value}`;
}

/** The core's own sentence for a handle released while the transport stayed connected. */
const TEARDOWN_UNCONFIRMED = /was removed but the transport still reports an open connection/i;

/** Read one envelope and return its `result` object, or throw the typed failure. */
export function parseEnvelope(method: string, text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CoreCallError(
      method,
      'Contract',
      `El núcleo respondió algo que no es JSON para «${method}».`,
    );
  }
  if (!isObject(value)) {
    throw new CoreCallError(
      method,
      'Contract',
      `El núcleo respondió un documento inesperado para «${method}».`,
    );
  }
  if (value.ok !== true) {
    const error = isObject(value.error) ? value.error : {};
    const kind = typeof error.kind === 'string' && error.kind !== '' ? error.kind : 'Unknown';
    const message =
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `El núcleo no explicó el fallo de «${method}».`;
    throw new CoreCallError(method, kind, message);
  }
  const result = value.result;
  if (!isObject(result)) {
    throw new CoreCallError(
      method,
      'Contract',
      `La respuesta de «${method}» no trae el registro «result».`,
    );
  }
  return result;
}

/** Call one bridged method with a payload and return its `result` record. */
async function callNative(
  method: keyof CoreNativeBridge,
  payload: JsonObject,
): Promise<JsonObject> {
  if (bridge === null) {
    throw new CoreCallError(
      method,
      'CoreUnavailable',
      `«${method}» necesita el núcleo nativo (libmobile_core.so), que no está en esta build.`,
    );
  }
  const payloadJson = JSON.stringify(payload);
  let text: string;
  try {
    text = await bridge[method](payloadJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CoreCallError(method, 'NativeError', message);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CoreCallError(
      method,
      'NativeError',
      `El núcleo nativo no devolvió nada para «${method}».`,
    );
  }
  return parseEnvelope(method, text);
}

/** Fields that would mean the device seed leaked into a JS value. */
const SEED_FIELDS = ['seed', 'secret', 'secret_seed', 'secretSeed'] as const;

/**
 * `deviceKeyEnsure()` — the phone identity, minted once and sealed in the Keystore.
 *
 * The module mints the seed on the first call, encrypts it with an AndroidKeyStore
 * AES/GCM key and stores the ciphertext in the app's private directory; every later call
 * decrypts it again and answers the **same** public key. Only `publicHex` and
 * `fingerprint` leave the native layer.
 */
export async function deviceKeyEnsure(): Promise<DeviceKeyInfo> {
  const result = await callNative('deviceKeyEnsure', {});

  // The seed must not cross the bridge. If a (buggy) answer carries it, this layer refuses
  // it instead of handing it to JS — and the message names no bytes.
  for (const field of SEED_FIELDS) {
    if (field in result) {
      throw new CoreCallError(
        'deviceKeyEnsure',
        'Contract',
        'La respuesta de la clave del dispositivo incluía material secreto; se descartó sin usarlo.',
      );
    }
  }

  const publicHex = typeof result.publicHex === 'string' ? result.publicHex.trim().toLowerCase() : '';
  const fingerprint = typeof result.fingerprint === 'string' ? result.fingerprint.trim() : '';
  if (!/^[0-9a-f]{64}$/.test(publicHex)) {
    throw new CoreCallError(
      'deviceKeyEnsure',
      'Contract',
      'La clave pública ed25519 del teléfono no llegó como 64 caracteres hex.',
    );
  }
  if (fingerprint === '') {
    throw new CoreCallError(
      'deviceKeyEnsure',
      'Contract',
      'El núcleo no devolvió la huella de la clave del dispositivo.',
    );
  }
  // A fresh object with exactly these two fields: nothing else can ride along.
  return { publicHex, fingerprint };
}

/**
 * `sshConnectWithDeviceKey()` — reconnect with the stored device key, pinned to the host
 * key that was paired.
 *
 * `expectedFingerprint` is required by this layer as well as by the core: a key-only
 * connection without a pin is exactly the trust-on-first-use window T16 closes.
 * The answer has to prove the same thing: `result.fingerprint` is the host key the
 * handshake verified, and a session without it is refused as a `Contract` failure naming
 * what came instead (SEC-013). The handle a broken answer handed out is closed here, so a
 * fingerprint-less answer cannot leak a live session either.
 */
export async function sshConnectWithDeviceKey(
  input: SshConnectWithDeviceKeyInput,
): Promise<SshConnectResult> {
  const host = typeof input?.host === 'string' ? input.host.trim() : '';
  if (host === '') {
    throw new CoreCallError('sshConnectWithDeviceKey', 'Input', 'Falta el host de la conexión.');
  }
  const user = typeof input?.user === 'string' ? input.user.trim() : '';
  if (user === '') {
    throw new CoreCallError('sshConnectWithDeviceKey', 'Input', 'Falta el usuario SSH.');
  }
  const port = input?.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CoreCallError(
      'sshConnectWithDeviceKey',
      'Input',
      'El puerto SSH tiene que ser un entero entre 1 y 65535.',
    );
  }
  const expectedFp =
    typeof input?.expectedFingerprint === 'string'
      ? compactFingerprint(input.expectedFingerprint)
      : null;
  if (expectedFp === null) {
    throw new CoreCallError(
      'sshConnectWithDeviceKey',
      'Input',
      'La huella del host con la que se emparejó el teléfono no es un SHA-256 en hex; no se puede reconectar sin fijarla.',
    );
  }

  const result = await callNative('sshConnectWithDeviceKey', {
    host,
    port,
    user,
    expectedFp,
  });
  const rawSessionId = result.sessionId;
  const validSessionId =
    typeof rawSessionId === 'number' && Number.isInteger(rawSessionId) && rawSessionId >= 0;
  const rawFingerprint = result.fingerprint;
  const observed = typeof rawFingerprint === 'string' ? compactFingerprint(rawFingerprint) : null;
  if (observed === null) {
    // Nothing verified this host, so nothing may keep a handle to it. The core closes such a
    // session itself; when a build still answers one, it is torn down here (best effort).
    if (validSessionId) {
      try {
        await callNative('sshClose', { sessionId: rawSessionId });
      } catch {
        // A close that cannot even be attempted does not change the fact being reported.
      }
    }
    throw new CoreCallError(
      'sshConnectWithDeviceKey',
      'Contract',
      `La conexión no devolvió la huella del host que verificó el handshake (${describeFingerprintField(rawFingerprint)}); sin ella no hay sesión fijada.`,
    );
  }
  if (!validSessionId) {
    throw new CoreCallError(
      'sshConnectWithDeviceKey',
      'Contract',
      'La conexión no devolvió un identificador de sesión válido.',
    );
  }
  return { sessionId: String(rawSessionId), fingerprint: observed };
}

/**
 * The root an `fs*` call will send, or the refusal that stops it here.
 *
 * A missing root keeps the frozen `Input` kind it always had (screens branch on it); the
 * new refusals use the core's own `invalid_path`, which is what `mobile-core/src/fs.rs`
 * answers for the same input on the device. A root that arrives as a `file://` URI (the
 * form `expo-file-system` answers for the app's own directories) is reduced to its
 * canonical path first, so the native allowlist and the core never judge a URI. A
 * well-formed root outside the allowlist is **not** decided here — the native allowlist
 * knows the phone's real directories.
 */
function checkedFsRoot(method: string, root: unknown): string {
  const requested = typeof root === 'string' ? root.trim() : '';
  if (requested === '') {
    throw new CoreCallError(method, 'Input', 'Falta la raíz desde la que se puede leer.');
  }
  const decision = normalizeDeviceRoot(requested);
  if (!decision.ok) {
    throw new CoreCallError(method, decision.kind, decision.message);
  }
  return decision.root;
}

/**
 * `sshClose(sessionId)` — disconnect the session and free its id and channels.
 *
 * Resolves one of two facts and nothing else:
 *
 * - `{kind:'closed'}` — the core confirmed the teardown (`result.closed === true`);
 * - `{kind:'removed-unconfirmed'}` — the handle is already gone but the transport still
 *   reports an open connection. The core says so with an `ssh` error *after* removing the
 *   entry, so it is surfaced as its own outcome carrying the core's message, never as a
 *   generic error and never as "still open" (SEC-012).
 *
 * Anything else keeps throwing: a non-numeric handle is `Input`, an unknown/already-closed
 * id stays the core's typed `ssh` error (a second close is a stale id, not a teardown), and
 * an `ok` answer that does not confirm the close is a `Contract` failure.
 */
export async function sshClose(sessionId: string): Promise<SshCloseOutcome> {
  const id = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId ?? '');
  if (!/^\d+$/.test(id)) {
    throw new CoreCallError(
      'sshClose',
      'Input',
      'El identificador de sesión no es un número.',
    );
  }
  let result: JsonObject;
  try {
    result = await callNative('sshClose', { sessionId: Number(id) });
  } catch (error) {
    if (error instanceof CoreCallError && TEARDOWN_UNCONFIRMED.test(error.message)) {
      return {
        kind: 'removed-unconfirmed',
        sessionId: id,
        message: error.message,
        raw: { kind: error.kind, message: error.message },
      };
    }
    throw error;
  }
  if (result.closed !== true) {
    throw new CoreCallError(
      'sshClose',
      'Contract',
      'El núcleo no confirmó el cierre de la sesión.',
    );
  }
  return { kind: 'closed', sessionId: id };
}

/** `fsList(input)` — one level of the phone's files, relative to `root`. */
export async function fsList(input: FsListInput): Promise<{ entries: FsEntry[] }> {
  const payload: JsonObject = {};
  payload.root = checkedFsRoot('fsList', input?.root);
  payload.path = typeof input?.path === 'string' ? input.path : '';
  if (input?.maxEntries !== undefined) {
    if (
      typeof input.maxEntries !== 'number' ||
      !Number.isFinite(input.maxEntries) ||
      input.maxEntries < 1
    ) {
      throw new CoreCallError(
        'fsList',
        'Input',
        'maxEntries tiene que ser un entero mayor que cero.',
      );
    }
    payload.maxEntries = Math.trunc(input.maxEntries);
  }

  const result = await callNative('fsList', payload);
  const rawEntries = result.entries;
  if (!Array.isArray(rawEntries)) {
    throw new CoreCallError('fsList', 'Contract', 'La respuesta no trae la lista de archivos.');
  }
  const entries: FsEntry[] = rawEntries.map((raw): FsEntry => {
    if (!isObject(raw) || typeof raw.path !== 'string') {
      throw new CoreCallError('fsList', 'Contract', 'Una entrada de la lista no trae su ruta.');
    }
    if (raw.kind !== 'file' && raw.kind !== 'dir') {
      throw new CoreCallError(
        'fsList',
        'Contract',
        `Una entrada de la lista trae un tipo desconocido («${String(raw.kind)}»).`,
      );
    }
    const size = raw.size;
    if (size !== null && (typeof size !== 'number' || !Number.isFinite(size))) {
      throw new CoreCallError(
        'fsList',
        'Contract',
        'Una entrada de la lista trae un tamaño que no es un número.',
      );
    }
    return { path: raw.path, size, kind: raw.kind };
  });
  return { entries };
}

/** `fsRead(input)` — one file as text, with its real size and truncation flag. */
export async function fsRead(input: FsReadInput): Promise<FsReadResult> {
  const payload: JsonObject = {};
  payload.root = checkedFsRoot('fsRead', input?.root);
  if (typeof input?.path !== 'string' || input.path.trim() === '') {
    throw new CoreCallError('fsRead', 'Input', 'Falta la ruta del archivo a leer.');
  }
  payload.path = input.path;
  if (input?.maxBytes !== undefined) {
    if (
      typeof input.maxBytes !== 'number' ||
      !Number.isFinite(input.maxBytes) ||
      input.maxBytes < 1
    ) {
      throw new CoreCallError(
        'fsRead',
        'Input',
        'maxBytes tiene que ser un entero mayor que cero.',
      );
    }
    payload.maxBytes = Math.trunc(input.maxBytes);
  }

  const result = await callNative('fsRead', payload);
  if (typeof result.path !== 'string' || typeof result.text !== 'string') {
    throw new CoreCallError('fsRead', 'Contract', 'La lectura no devolvió la ruta y el texto.');
  }
  if (typeof result.size !== 'number' || !Number.isFinite(result.size)) {
    throw new CoreCallError('fsRead', 'Contract', 'La lectura no devolvió el tamaño real.');
  }
  if (typeof result.truncated !== 'boolean') {
    throw new CoreCallError(
      'fsRead',
      'Contract',
      'La lectura no dijo si el texto está cortado.',
    );
  }
  return {
    path: result.path,
    text: result.text,
    size: result.size,
    truncated: result.truncated,
  };
}
