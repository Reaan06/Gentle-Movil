/**
 * Tunnel-backed implementation of the bridge client's `TunnelChannel`.
 *
 * `lib/bridge.ts` speaks HTTP over an injectable channel triple; this module
 * adapts the provision flow's real tunnel handles (`TunnelHandles` from
 * `lib/provision.ts` — the session id plus the open `direct-tcpip` channels
 * the `tunnel` step left behind) to that contract, so the screens talk to the
 * actual extension on the PC, not a simulation.
 *
 * Honesty rules (S7): every channel failure is returned as-is for the caller
 * to log with `{step, error, raw}`; a closed channel is never retried here.
 */

import type { TunnelChannel } from './bridge.ts';
import { channelRead, channelWrite } from './provision.ts';

/**
 * Adapt one provision `TunnelChannel` into the bridge client's contract.
 * `timeoutMs` maps to the core's read window (`gc_ssh_channel_read`).
 */
export function tunnelChannelAdapter(
  sessionId: string,
  tunnelChannel: import('./provision.ts').TunnelChannel,
  deps: import('./provision.ts').ProvisionDeps = {},
): TunnelChannel {
  return {
    async write(payload: Uint8Array): Promise<number> {
      const outcome = await channelWrite(sessionId, tunnelChannel, payload, deps);
      if (!outcome.ok) {
        throw new Error(`canal ${tunnelChannel.channelId}: ${outcome.error.message}`);
      }
      return outcome.written;
    },
    async read(timeoutMs = 10_000) {
      const outcome = await channelRead(sessionId, tunnelChannel, timeoutMs, deps);
      if (!outcome.ok) {
        throw new Error(`canal ${tunnelChannel.channelId}: ${outcome.error.message}`);
      }
      return { bytes: outcome.bytes, eof: outcome.eof };
    },
    // No `close()` on purpose: the `tunnel` provision step owns the channel
    // lifetime. Closing it here would destroy the only forward the app has.
  };
}
