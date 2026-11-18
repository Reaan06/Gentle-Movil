/**
 * TypeScript contract of the Rust core (`mobile-core/`), derived from
 * `docs/mobile-protocol-spec.md` §6 ("Superficie del core Rust — congelada v1").
 *
 * This file is the ONLY place the UI learns about the native layer. Everything
 * product-level (daemon protocol parsing, tunnel protocol, state machines) stays
 * in TS so it can ship over EAS Update (stack doc — "regla de oro de la OTA").
 *
 * The v1 slice needed by the pairing flow is the four calls below; §6 also
 * freezes `sshDirectTcp`, `channelRead`, `channelWrite`, `channelClose`,
 * `sftpPut`, `execOnce`, `deviceKeyPublic` and the `sqlite*` store. The three
 * channel calls of the pivot tunnel are declared here (`channelWrite`,
 * `channelRead`, `channelClose` — S4); the rest get their typed wrappers when
 * those screens land (V3+). Their byte payloads are standard padded base64 on
 * the ABI, which is what `base64Encode`/`base64Decode` below are for.
 *
 * ---------------------------------------------------------------------------
 * DEV FALLBACK — `coreStub` below is NOT the real core. It never fakes success:
 * every call rejects with `CoreUnavailableError` so the UI shows its honest
 * "core not compiled" state. The real binding (uniFFI) replaces `core` only.
 * ---------------------------------------------------------------------------
 */

/** Parsed QR payload (`gc://pair?…`, spec §1). */
export interface PairInfo {
  /** LAN IP or hostname of the host. */
  host: string;
  /** SSH port (22 when omitted in the QR). */
  port: number;
  /** SSH user on the host. */
  user: string;
  /** One-time invite token, TTL 5 min (spec §1, §8). */
  token: string;
  /** ed25519 host fingerprint shown to the user for MITM confirmation (TOFU). */
  fp: string;
  /** Pairing code from the QR (empty when the host generates an invite-only QR). */
  code: string;
  /** SSH password carried in the QR (moshi model; empty on invite-only QRs). */
  pw: string;
  /** Daemon device-surface port (43722 when omitted in the QR, spec §4). */
  dport: number;
  /** Daemon protocol minor version the host advertises. */
  proto: string;
}

/**
 * SSH credential for the first connection (spec §1 last paragraph): the user's
 * password, or an existing key already authorized on the host. Device ed25519
 * keys live in Keychain/Keystore and are never passed as a credential
 * (spec §2.1).
 */
export type SshCredential =
  | { type: 'password'; value: string }
  | { type: 'key'; path: string; passphrase?: string };

/** Live SSH session returned by `sshConnect`. */
export interface SshSessionHandle {
  /** Opaque session id owned by the core. */
  id: string;
  /** Host key fingerprint presented during the handshake, for TOFU comparison. */
  fingerprint: string;
  /** Releases the session and its channels. */
  close(): Promise<void>;
}

/**
 * Phone identity generated on the device (spec §2.1). The private half never
 * leaves Keychain/Keystore, so only the public description crosses the FFI.
 */
export interface DeviceKeyPair {
  /** ed25519 public key in OpenSSH wire form (`ssh-ed25519 AAAA…`). */
  publicKey: string;
  /** OpenSSH SHA256 fingerprint (`SHA256:…`), shown to the user. */
  fingerprint: string;
}

/** The native surface frozen in spec §6 (v1 slice + pivot tunnel channels). */
export interface MobileCore {
  /** Parses a scanned `gc://pair?…` string into a `PairInfo`. */
  pairFromQr(uri: string): Promise<PairInfo>;
  /** Opens the SSH session used for pairing and provisioning. */
  sshConnect(
    host: string,
    port: number,
    user: string,
    cred: SshCredential,
  ): Promise<SshSessionHandle>;
  /** Creates the device ed25519 key pair in secure storage on first use. */
  deviceKeyGenerate(): Promise<DeviceKeyPair>;
  /** Verifies a signature (release checksum, spec §3.2) against a public key. */
  cryptoVerify(
    pubkey: string,
    payload: Uint8Array,
    sig: Uint8Array,
  ): Promise<boolean>;
  /**
   * `gc_ssh_channel_write` — sends bytes on a tunnel channel the `tunnel` step
   * opened (S4). Resolves with the number of bytes handed to the transport.
   */
  channelWrite(sessionId: string, channelId: number, payload: Uint8Array): Promise<number>;
  /**
   * `gc_ssh_channel_read` — reads one frame from a tunnel channel. `timeoutMs: 0`
   * is a non-blocking poll; a window that expires is `{bytes: empty, eof: false}`
   * and **not** an error (S7).
   */
  channelRead(sessionId: string, channelId: number, timeoutMs?: number): Promise<ChannelRead>;
  /** `gc_ssh_channel_close` — closes a tunnel channel and frees its id. */
  channelClose(sessionId: string, channelId: number): Promise<void>;
}

/** One frame read from a tunnel channel (`gc_ssh_channel_read` result). */
export interface ChannelRead {
  /** The bytes that arrived; empty on a timeout and when the peer closed. */
  bytes: Uint8Array;
  /** True when the host closed the channel, so no further read can succeed. */
  eof: boolean;
}

/**
 * Rejection reason used while the native core is not part of the build. The UI
 * must treat it as "no connection was made", never as success.
 */
export class CoreUnavailableError extends Error {
  /** Core method that was called. */
  readonly method: string;

  constructor(method: string) {
    super(
      `CoreUnavailableError: ${method} needs the Rust core (mobile-core), which is not compiled into this build.`,
    );
    this.name = 'CoreUnavailableError';
    this.method = method;
  }
}

/** Observable state of the dev fallback, so the UI can show `connecting`. */
export type CoreStubState = 'idle' | 'connecting';

/** Dev-only stub; typed separately so it can never masquerade as the core. */
export interface CoreStub extends MobileCore {
  /** Last state the stub reached before refusing the call. */
  readonly state: CoreStubState;
}

// TODO(ffi): replace with uniFFI binding of mobile-core (spec §6) — this stub is for UI dev only.
let stubState: CoreStubState = 'idle';

const coreStub: CoreStub = {
  get state() {
    return stubState;
  },
  async pairFromQr(uri) {
    throw new CoreUnavailableError('pairFromQr');
  },
  async sshConnect(host, port, user, cred) {
    // Flip to `connecting` before refusing: the pipeline really does start, so
    // the UI must not show a success state it did not reach.
    stubState = 'connecting';
    throw new CoreUnavailableError('sshConnect');
  },
  async deviceKeyGenerate() {
    throw new CoreUnavailableError('deviceKeyGenerate');
  },
  async cryptoVerify() {
    throw new CoreUnavailableError('cryptoVerify');
  },
  async channelWrite() {
    throw new CoreUnavailableError('channelWrite');
  },
  async channelRead() {
    throw new CoreUnavailableError('channelRead');
  },
  async channelClose() {
    throw new CoreUnavailableError('channelClose');
  },
};

/* ------------------------------------------------------------------ *
 * Byte payloads
 *
 * Every `bytes` field on the ABI is standard (padded) base64, and the encoder
 * that produced it is the Rust `base64_encode` of `mobile-core/src/cabi.rs`.
 * These helpers are dependency-free on purpose: Hermes has no `Buffer`, and a
 * `TextEncoder` is not guaranteed there either, so the app must not rely on
 * them (`lib/provision.ts` keeps its own `base64Encode` for the same reason).
 * ------------------------------------------------------------------ */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Malformed byte payload: a frame that is not standard base64, or a `bytes`
 * field the core could not have produced. Callers show it like any other core
 * failure (`{kind: 'Frame', message}`), and nothing is decoded half-way.
 */
export class ChannelFrameError extends Error {
  /** Stable kind, so a `ChannelFailure` keeps the `Frame` code for the UI. */
  readonly kind = 'Frame';

  constructor(message: string) {
    super(message);
    this.name = 'ChannelFrameError';
  }
}

/** Standard (padded) base64 of `bytes` (RFC 4648, the alphabet the ABI uses). */
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

/**
 * Bytes of a standard base64 payload. Padding is optional and whitespace is
 * ignored (a pasted `bytes` field still decodes), but any other character, a
 * bad padding tail or an impossible length is a `ChannelFrameError`.
 */
export function base64Decode(text: string): Uint8Array {
  const compact = text.replace(/[\s]/g, '');
  if (compact.length === 0) {
    return new Uint8Array(0);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new ChannelFrameError('El payload no es base64 estándar.');
  }
  const body = compact.replace(/=+$/, '');
  if (body.length % 4 === 1) {
    throw new ChannelFrameError('El payload base64 tiene un largo imposible.');
  }
  const pads = compact.length - body.length;
  if (pads > 0 && (compact.length % 4 !== 0 || pads !== (4 - (body.length % 4)) % 4)) {
    throw new ChannelFrameError('El padding del payload base64 no es válido.');
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new ChannelFrameError('El payload no es base64 estándar.');
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

/** UTF-8 bytes of `text`, without `TextEncoder` (not guaranteed on Hermes). */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.codePointAt(index) as number;
    if (code > 0xffff) {
      // A surrogate pair consumed two UTF-16 units.
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // A lone surrogate is not a code point: it becomes U+FFFD.
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

/** Decodes UTF-8 bytes into text, replacing malformed sequences with U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] as number;
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      index += 1;
      continue;
    }
    let need = 0;
    let code = 0;
    if ((byte & 0xe0) === 0xc0) {
      need = 1;
      code = byte & 0x1f;
    } else if ((byte & 0xf0) === 0xe0) {
      need = 2;
      code = byte & 0x0f;
    } else if ((byte & 0xf8) === 0xf0) {
      need = 3;
      code = byte & 0x07;
    } else {
      out += '\ufffd';
      index += 1;
      continue;
    }
    if (index + need >= bytes.length) {
      out += '\ufffd';
      index = bytes.length;
      continue;
    }
    let valid = true;
    for (let offset = 1; offset <= need; offset += 1) {
      const next = bytes[index + offset] as number;
      if ((next & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      code = (code << 6) | (next & 0x3f);
    }
    if (!valid) {
      out += '\ufffd';
      index += 1;
      continue;
    }
    out += String.fromCodePoint(code);
    index += need + 1;
  }
  return out;
}

/**
 * Single swap point for the native binding: screens and hooks import `core`
 * (typed as `MobileCore`), never the stub.
 */
export const core: MobileCore = coreStub;
