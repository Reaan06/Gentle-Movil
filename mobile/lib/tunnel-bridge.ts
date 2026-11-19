/**
 * Tunnel-backed implementation of the bridge client's `TunnelChannel`.
 *
 * `lib/bridge.ts` speaks HTTP over an injectable channel triple; this module
 * adapts the provision flow's real tunnel handles (`TunnelHandles` from
 * `lib/provision.ts` — the session id plus the open `direct-tcpip` channels
 * the `tunnel` step left behind) to that contract, so the screens talk to the
 * actual extension on the PC, not a simulation.
 *
 * ## One request, one channel (`Connection: close`)
 *
 * An SSH `direct-tcpip` channel *is* the TCP connection to the extension's
 * loopback port, and the bridge client asks the PC to close it after answering
 * (`Connection: close`). A channel therefore serves exactly one response: the
 * handle the `tunnel` step reported is good for the first request only, and
 * reusing it is what made every later call read a closed channel, zero bytes
 * and report "La PC devolvió una respuesta rota." with an empty body.
 *
 * So this adapter owns the channel's lifetime: the first request adopts the
 * handle the `tunnel` step opened, `close()` releases it, and every later
 * request opens a fresh forward on the same session through the core's own
 * `tunnel` step (`openTunnelForwards`). `tunnel-store.bridgeChannel()` can keep
 * handing the same typing-time handle without knowing any of this.
 *
 * Honesty rules (S7): every channel failure is returned as-is for the caller
 * to log with `{step, error, raw}`; a channel that is closed throws
 * `ChannelClosedError` and a tunnel that cannot open a new one throws
 * `ChannelUnavailableError`, so the bridge client reports `channel-closed` /
 * `offline` instead of inventing an empty body.
 */

import { ChannelClosedError, ChannelUnavailableError, type TunnelChannel } from './bridge.ts';
import { channelClose, channelRead, channelWrite, openTunnelForwards } from './provision.ts';

/**
 * The channel currently usable per session + port. `null` means "the last one
 * is consumed: open a fresh forward before the next request".
 */
const liveChannels = new Map<string, import('./provision.ts').TunnelChannel | null>();

/** Registry key: a session id and the loopback port the channel reaches. */
function channelKey(sessionId: string, port: number): string {
  return `${sessionId}:${port}`;
}

/**
 * Adapt one provision `TunnelChannel` into the bridge client's contract.
 *
 * `timeoutMs` maps to the core's read window (`gc_ssh_channel_read`), and
 * `close()` releases the one-shot channel so the next request gets its own.
 */
export function tunnelChannelAdapter(
  sessionId: string,
  tunnelChannel: import('./provision.ts').TunnelChannel,
  deps: import('./provision.ts').ProvisionDeps = {},
): TunnelChannel {
  const key = channelKey(sessionId, tunnelChannel.port);
  if (!liveChannels.has(key)) {
    // The channel the `tunnel` step opened: still unused, so it carries the
    // first request. Anything after that opens its own.
    liveChannels.set(key, tunnelChannel);
  }
  /** The channel this adapter actually used, so `close()` releases the right one. */
  let used: import('./provision.ts').TunnelChannel | null = null;

  /** The channel the next call rides: the live one, or a freshly opened forward. */
  async function currentChannel(): Promise<import('./provision.ts').TunnelChannel> {
    const live = liveChannels.get(key) ?? null;
    if (live !== null) {
      used = live;
      return live;
    }
    const opened = await openTunnelForwards(
      sessionId,
      [{ host: tunnelChannel.host, port: tunnelChannel.port }],
      deps,
    );
    if (!opened.ok) {
      throw new ChannelUnavailableError(
        `canal ${tunnelChannel.port}: no se pudo abrir un forward nuevo: ${opened.error.message}`,
      );
    }
    const fresh = opened.channels.find((channel) => channel.port === tunnelChannel.port);
    if (fresh === undefined) {
      throw new ChannelUnavailableError(
        `canal ${tunnelChannel.port}: el túnel no devolvió el forward que se pidió.`,
      );
    }
    liveChannels.set(key, fresh);
    used = fresh;
    return fresh;
  }

  /** A core channel failure means this channel cannot carry anything else. */
  function consume(): void {
    liveChannels.set(key, null);
  }

  return {
    async write(payload: Uint8Array): Promise<number> {
      const channel = await currentChannel();
      const outcome = await channelWrite(sessionId, channel, payload, deps);
      if (!outcome.ok) {
        consume();
        throw new ChannelClosedError(`canal ${channel.channelId}: ${outcome.error.message}`);
      }
      return outcome.written;
    },
    async read(timeoutMs = 10_000) {
      const channel = await currentChannel();
      const outcome = await channelRead(sessionId, channel, timeoutMs, deps);
      if (!outcome.ok) {
        consume();
        throw new ChannelClosedError(`canal ${channel.channelId}: ${outcome.error.message}`);
      }
      return { bytes: outcome.bytes, eof: outcome.eof };
    },
    /**
     * Releases the channel the exchange used: one response per channel. The
     * core drops the id even when the close itself fails (`channelClose` removes
     * it first), and a close failure never becomes an error the UI would show.
     */
    async close(): Promise<void> {
      const channel = used ?? liveChannels.get(key) ?? null;
      consume();
      if (channel === null) {
        return;
      }
      try {
        await channelClose(sessionId, channel, deps);
      } catch {
        // The core answers a typed failure instead of throwing; a throw here is
        // a bridge-level error and must not mask the response that already came.
      }
    },
  };
}
