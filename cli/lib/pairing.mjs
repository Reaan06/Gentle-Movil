/**
 * Pairing data for `gentle-movil pair` — everything generated locally.
 *
 * There is no daemon anymore (S2: the bridge is the Gentle Shell/Pi extension
 * itself). So the invite/token part of the QR is **not** fetched from a HTTP
 * surface: it is derived here, per invocation, from the host's own state:
 *
 * - host: LAN IPv4 read from `os.networkInterfaces()` (no packets leave the box);
 * - port: `/etc/ssh/sshd_config` `Port` (22 when absent);
 * - user: the SSH user running the CLI;
 * - fp:   SHA-256 over the ed25519 host-key blob (`/etc/ssh/*_key.pub`);
 * - token/code: fresh random values; field names are unchanged from the
 *   protocol spec so `mobile/lib/qr-parse.ts` keeps accepting the QR.
 *
 * The token is advisory: nothing persists or burns it, and the extension
 * validates it during the first pairing (`docs/mobile-protocol-spec.md` §2).
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

/** Extension device-surface port carried by the QR (protocol spec §4). */
export const DEVICE_SURFACE_PORT = 43722;

/** How long the printed pairing hint is fresh (protocol spec §1: TTL 5 min). */
export const INVITE_TTL_SECONDS = 300;

/** Length in hex characters of a SHA-256 fingerprint (32 bytes × 2). */
export const SSH_FINGERPRINT_HEX_LEN = 64;

/** The key S9 names as the TOFU fingerprint source. */
export const ED25519_HOST_KEY = '/etc/ssh/ssh_host_ed25519_key.pub';

/** Fingerprint fallbacks for hosts whose ed25519 key is not readable. */
export const HOST_KEY_CANDIDATES = [
  ED25519_HOST_KEY,
  '/etc/ssh/ssh_host_ecdsa_key.pub',
  '/etc/ssh/ssh_host_rsa_key.pub',
];

/** Interface names a phone on the same LAN can actually reach, most likely first. */
const LAN_PREFIXES = ['en', 'wlan', 'wl', 'wlp', 'eth', 'eno', 'w'];

/** Virtual interfaces that are not reachable from the tablet (docker, bridges, tunnels). */
const VIRTUAL_PREFIXES = ['lo', 'docker', 'veth', 'br-', 'virbr', 'tun', 'tap', 'wireguard'];

/**
 * A fresh one-time invite token for this invocation.
 *
 * Shape kept from the daemon era (`inv_…`) so the app's parser and docs do not
 * need a new field; only the source changed (local randomness, no HTTP).
 */
export function randomToken() {
  return `inv_${randomBytes(16).toString('hex')}`;
}

/**
 * A fresh pairing code (`AB12-CD34`), the invite-only companion of `token`.
 *
 * Locally generated like the token: there is no daemon to issue or claim it, so
 * the extension decides what to do with it during the first pairing.
 */
export function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 lookalikes
  const raw = randomBytes(8)
    .toString('hex')
    .match(/../g)
    .map((chunk) => alphabet[parseInt(chunk, 16) % alphabet.length])
    .join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/**
 * Host fingerprint: SHA-256 hex over the base64 body of the SSH host key.
 *
 * Reads only local files. `readFile` is injectable so the contract can be
 * tested without touching `/etc/ssh`.
 */
export function hostFingerprint({
  candidates = HOST_KEY_CANDIDATES,
  readFile = readFileSync,
} = {}) {
  for (const keyPath of candidates) {
    let line;
    try {
      line = readFile(keyPath, 'utf8').trim();
    } catch {
      continue; // Try the next candidate; the caller reports the failure.
    }
    const blob = line.split(/\s+/)[1];
    if (!blob) continue;
    return createHash('sha256').update(Buffer.from(blob, 'base64')).digest('hex');
  }
  throw new Error(
    'No readable SSH host key under /etc/ssh — the .pub files must be readable (no sudo needed).',
  );
}

/** SSH port from `/etc/ssh/sshd_config`, defaulting to 22 like the protocol. */
export function detectSshPort({ readFile = readFileSync } = {}) {
  try {
    const port = readFile('/etc/ssh/sshd_config', 'utf8').match(/^\s*Port\s+(\d+)\s*$/m);
    if (port) return Number(port[1]);
  } catch {}
  return 22;
}

/** The SSH user the tablet will log in as (the one running this CLI). */
export function currentUser({ exec = execFileSync, env = process.env } = {}) {
  try {
    return exec('id', ['-un'], { encoding: 'utf8' }).trim();
  } catch {
    return env.USER || 'user';
  }
}

/**
 * Primary LAN IPv4 address, read from the local interface table.
 *
 * Deliberately no socket: S9 forbids network beyond loopback, and a UDP
 * "connect" to a guessed gateway was both network-ish and subnet-specific.
 * Interfaces a phone can reach (`en*`, `wlan*`, `eth*`…) sort before virtual
 * ones (docker, VPN, loopback), and loopback is never returned unless it is the
 * only IPv4 present — in which case doctor reports the honest failure.
 */
export function lanAddress({ interfaces = networkInterfaces() } = {}) {
  const ranked = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    if (VIRTUAL_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const rank = LAN_PREFIXES.findIndex((prefix) => name.startsWith(prefix));
      ranked.push({ address: address.address, rank: rank === -1 ? LAN_PREFIXES.length : rank });
    }
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked[0]?.address ?? '127.0.0.1';
}

/**
 * Build the `gc://pair?v=1` URI printed as a QR (protocol spec §1).
 *
 * Field names are frozen: `v host port user token fp` are required by the app,
 * `pw` is the moshi password, `code` the invite-only fallback and
 * `dport` the extension surface (43722). `pw` is percent-encoded by
 * `URLSearchParams` and decoded by `mobile/lib/qr-parse.ts`.
 */
export function buildPairUri({ host, port, user, token, fp, pw = '', code = '' }) {
  const uri = new URL('gc://pair');
  uri.searchParams.set('v', '1');
  uri.searchParams.set('host', host);
  uri.searchParams.set('port', String(port));
  uri.searchParams.set('user', user);
  uri.searchParams.set('token', token);
  uri.searchParams.set('fp', fp);
  if (pw) uri.searchParams.set('pw', pw);
  if (!pw && code) uri.searchParams.set('code', code);
  uri.searchParams.set('dport', String(DEVICE_SURFACE_PORT));
  return uri.toString();
}
