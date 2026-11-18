/**
 * Loopback probing for the Gentle Shell/Pi extension (no daemon).
 *
 * The extension serves HTTP on 127.0.0.1:43721 (control surface) and
 * 127.0.0.1:43722 (device surface, the tunnel target). `status` and `doctor`
 * both ask the same question — "is the bridge answering there?" — so the probe
 * lives here once.
 *
 * Answering is not enough. A leftover Rust daemon served a camera-preview page
 * (`etag: camera-v2-preview-v1`) on 43722 and the old probe reported
 * "extension reachable — HTTP 200". The bridge now proves its identity:
 *
 *   GET /api/health → {"app":"gentle-shell","bridge":"gentle-movil",
 *                     "proto":1,"version":"<semver>"}
 *
 * so a port is the bridge only when that document carries `app:"gentle-shell"`,
 * `bridge:"gentle-movil"` and `proto:1`. Three states, never conflated:
 * `bridge` (reachable), `impostor` (something answered, wrong identity — named
 * with what was actually observed) and `unreachable` (nothing listening).
 *
 * Nothing leaves the box: the only host probed is 127.0.0.1.
 */
import http from 'node:http';
import net from 'node:net';

/** Extension surfaces (protocol spec §4: 43722; S4: 43721 control). */
export const DEFAULT_EXTENSION_PORTS = [43721, 43722];

/** The identity path and the exact document the bridge must answer with. */
export const HEALTH_PATH = '/api/health';
export const BRIDGE_IDENTITY = Object.freeze({
  app: 'gentle-shell',
  bridge: 'gentle-movil',
  proto: 1,
});

const PROBE_TIMEOUT_MS = 800;
/** Never buffer more than this: an impostor page can be arbitrarily large. */
const MAX_BODY_BYTES = 4096;
const BODY_PREFIX_CHARS = 60;

/**
 * Ports to probe, honoring `GENTLE_MOVIL_PORTS` (`43721,43722` by default).
 *
 * The override exists so a test (or an extension running elsewhere) can point
 * the probe at another loopback port without editing code. Invalid values fail
 * loudly instead of silently probing the defaults.
 */
export function extensionPorts(env = process.env) {
  const raw = (env.GENTLE_MOVIL_PORTS || '').trim();
  if (!raw) return DEFAULT_EXTENSION_PORTS;
  const ports = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`GENTLE_MOVIL_PORTS is invalid ("${raw}"): expected ports 1-65535, comma separated.`);
  }
  return ports;
}

/**
 * One `GET /api/health` on loopback.
 *
 * Resolves `{ answered: true, status, headers, body }` for any HTTP answer (a
 * 200 impostor is still an answer, so its headers/body must be inspected) or
 * `{ answered: false, error }` when the request never produced a response.
 */
function readHealth(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: HEALTH_PATH,
        method: 'GET',
        timeout: PROBE_TIMEOUT_MS,
        headers: { accept: 'application/json' },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < MAX_BODY_BYTES) {
            body += chunk.slice(0, MAX_BODY_BYTES - body.length);
          }
        });
        const done = () =>
          finish({
            answered: true,
            status: response.statusCode,
            headers: response.headers,
            body,
          });
        response.once('end', done);
        // A truncated/aborted response still tells us what was on the port.
        response.once('error', done);
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => finish({ answered: false, error: error.code || error.message }));
    request.end();
  });
}

/** Parse a JSON document, or `undefined` when the body is not JSON. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** True only for the exact bridge document (`app`/`bridge`/`proto` all match). */
export function identifiesAsBridge(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  return (
    document.app === BRIDGE_IDENTITY.app &&
    document.bridge === BRIDGE_IDENTITY.bridge &&
    document.proto === BRIDGE_IDENTITY.proto
  );
}

/** What the port actually answered, so an impostor is never a mystery. */
function describeObserved({ status, headers, body }) {
  const seen = [`HTTP ${status}`];
  const contentType = headers['content-type'];
  if (contentType) seen.push(`content-type ${contentType}`);
  if (headers.etag) seen.push(`etag ${headers.etag}`);

  const trimmed = body.trim();
  const document = parseJson(trimmed);
  if (document !== undefined) {
    const shape = ['app', 'bridge', 'proto']
      .map((key) => `${key}=${JSON.stringify(document?.[key] ?? null)}`)
      .join(' ');
    seen.push(`JSON ${shape}`);
  } else if (trimmed) {
    seen.push(`body starts ${JSON.stringify(trimmed.slice(0, BODY_PREFIX_CHARS))}`);
  } else {
    seen.push('empty body');
  }
  return seen.join(', ');
}

/** `bridge identity confirmed (app=… bridge=… proto=1, version x.y.z), HTTP 200` */
function bridgeDetail(document, status) {
  const identity = `app=${BRIDGE_IDENTITY.app} bridge=${BRIDGE_IDENTITY.bridge} proto=${BRIDGE_IDENTITY.proto}`;
  const version = typeof document.version === 'string' && document.version ? `, version ${document.version}` : '';
  return `bridge identity confirmed (${identity}${version}), HTTP ${status}`;
}

const IMPOSTOR_LEAD = 'port answering, but it is not the Gentle Shell bridge';

/** A TCP connect distinguishes "listening but not HTTP" from "nothing there". */
function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (reachable, detail) => {
      socket.destroy();
      resolve({ reachable, detail });
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true, 'TCP listener, no HTTP answer'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error) => done(false, error.code || error.message));
  });
}

/**
 * Probe one extension port.
 *
 * `{ port, state, reachable, detail }` where `state` is one of:
 * - `bridge` — the contract document identified Gentle Shell/Pi (`reachable: true`);
 * - `impostor` — something answered, but not as the bridge (`reachable: false`),
 *   with `detail` naming what was observed (content-type, etag, body prefix);
 * - `unreachable` — nothing listens (`reachable: false`).
 */
export async function probeExtensionPort(port) {
  const health = await readHealth(port);

  if (health.answered) {
    const document = parseJson(health.body.trim());
    if (identifiesAsBridge(document)) {
      return { port, state: 'bridge', reachable: true, detail: bridgeDetail(document, health.status) };
    }
    return {
      port,
      state: 'impostor',
      reachable: false,
      detail: `${IMPOSTOR_LEAD} — observed ${describeObserved(health)}`,
    };
  }

  const tcpResult = await tcpProbe(port);
  if (tcpResult.reachable) {
    return {
      port,
      state: 'impostor',
      reachable: false,
      detail: `${IMPOSTOR_LEAD} — ${tcpResult.detail}`,
    };
  }

  const reason =
    tcpResult.detail === 'ECONNREFUSED'
      ? 'ECONNREFUSED — nothing listening'
      : `${tcpResult.detail} — no listener`;
  return { port, state: 'unreachable', reachable: false, detail: reason };
}

/** Probe every extension port, in order. */
export function probeExtensionPorts(ports = extensionPorts()) {
  return Promise.all(ports.map((port) => probeExtensionPort(port)));
}

/** True when every port identified as the bridge (a half-served bridge is not "reachable"). */
export function allReachable(results) {
  return results.length > 0 && results.every((result) => result.reachable);
}

/** State → the word used in the user-facing line. */
const STATE_WORD = {
  bridge: 'reachable',
  impostor: 'not the bridge',
  unreachable: 'unreachable',
};

/**
 * `127.0.0.1:43721 reachable — bridge identity confirmed (…), HTTP 200`
 * `127.0.0.1:43722 not the bridge — port answering, but it is not the Gentle Shell bridge — …`
 * `127.0.0.1:43722 unreachable — ECONNREFUSED — nothing listening`
 */
export function describeProbe(result) {
  const state = result.state || (result.reachable ? 'bridge' : 'unreachable');
  return `127.0.0.1:${result.port} ${STATE_WORD[state] || STATE_WORD.unreachable} — ${result.detail}`;
}

/** `✓ 127.0.0.1:43721 reachable — HTTP 204` (doctor/status line shape). */
export function probeLine(result) {
  return `${result.reachable ? '✓' : '✗'} ${describeProbe(result)}`;
}
