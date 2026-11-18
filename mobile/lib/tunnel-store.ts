/**
 * The app's single source of truth for the *active* tunnel (S4, T8c).
 *
 * `provisionFlow` returns `TunnelHandles` — a native session id plus one open
 * `direct-tcpip` channel per extension port. Those handles are native state:
 * they cannot be serialized into AsyncStorage, so this store keeps them in
 * memory for the app session and honestly reports "no tunnel" after a restart
 * (the pairing flow has to run again — that is the truth, not a bug).
 *
 * The screens read the tunnel through `bridgeChannel()`; when it returns null
 * the bridge client fails as `offline` and the UI shows `Reconectando…`.
 */

import type { TunnelChannel } from './bridge.ts';
import { EXTENSION_HTTP_PORT } from './provision.ts';
import { tunnelChannelAdapter } from './tunnel-bridge.ts';

/** What the pairing flow left open, as the app keeps it. */
export interface ActiveTunnel {
  sessionId: string;
  /** The provision channel bound to the extension HTTP port (43721). */
  httpChannel: import('./provision.ts').TunnelChannel;
  /** Host shown in the connection chip. */
  host: string;
}

let active: ActiveTunnel | null = null;

/** Store the tunnel a successful `provisionFlow` left behind. */
export function setActiveTunnel(tunnel: ActiveTunnel | null): void {
  active = tunnel;
}

/** The stored tunnel, or null when none was opened in this app session. */
export function getActiveTunnel(): ActiveTunnel | null {
  return active;
}

/**
 * Bridge channel for the next request, or null when there is no tunnel.
 * Re-asks on every call, so a re-paired tunnel is picked up without a restart.
 */
export function bridgeChannel(): TunnelChannel | null {
  if (active === null) {
    return null;
  }
  return tunnelChannelAdapter(active.sessionId, active.httpChannel);
}

/** Provision channel of a `TunnelHandles` result for the HTTP port. */
export function httpChannelOf(
  handles: import('./provision.ts').TunnelHandles,
): import('./provision.ts').TunnelChannel | null {
  return handles.channels.find((channel) => channel.port === EXTENSION_HTTP_PORT) ?? null;
}
