/**
 * Loopback probing for the Gentle Shell/Pi extension (no daemon).
 *
 * The extension serves HTTP on 127.0.0.1:43721 (control surface) and
 * 127.0.0.1:43722 (device surface, the tunnel target). `status` and `doctor`
 * both ask the same question — "is something answering there?" — so the probe
 * lives here once.
 *
 * Nothing leaves the box: the only host probed is 127.0.0.1.
 */
import http from 'node:http';
import net from 'node:net';

/** Extension surfaces (protocol spec §4: 43722; S4: 43721 control). */
export const DEFAULT_EXTENSION_PORTS = [43721, 43722];

const PROBE_TIMEOUT_MS = 800;

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

/** One HTTP GET on loopback; any answer proves an HTTP surface is listening. */
function httpProbe(port) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve({ reachable: true, detail: `HTTP ${response.statusCode}` });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ reachable: false, error: error.code || error.message }));
    request.end();
  });
}

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
 * `{ port, reachable, detail }`. `detail` is user-facing: an HTTP status when the
 * extension answers, or the honest reason it did not (`ECONNREFUSED` → nothing
 * listening).
 */
export async function probeExtensionPort(port) {
  const httpResult = await httpProbe(port);
  if (httpResult.reachable) return { port, reachable: true, detail: httpResult.detail };

  const tcpResult = await tcpProbe(port);
  if (tcpResult.reachable) return { port, reachable: true, detail: tcpResult.detail };

  const reason =
    tcpResult.detail === 'ECONNREFUSED'
      ? 'ECONNREFUSED — nothing listening'
      : `${tcpResult.detail} — no listener`;
  return { port, reachable: false, detail: reason };
}

/** Probe every extension port, in order. */
export function probeExtensionPorts(ports = extensionPorts()) {
  return Promise.all(ports.map((port) => probeExtensionPort(port)));
}

/** True when every port answered (a half-served bridge is not "reachable"). */
export function allReachable(results) {
  return results.length > 0 && results.every((result) => result.reachable);
}

/** `127.0.0.1:43721 reachable — HTTP 204` / `127.0.0.1:43722 unreachable — …` */
export function describeProbe(result) {
  return `127.0.0.1:${result.port} ${result.reachable ? 'reachable' : 'unreachable'} — ${result.detail}`;
}

/** `✓ 127.0.0.1:43721 reachable — HTTP 204` (doctor/status line shape). */
export function probeLine(result) {
  return `${result.reachable ? '✓' : '✗'} ${describeProbe(result)}`;
}
