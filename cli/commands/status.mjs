#!/usr/bin/env node
/**
 * `gentle-movil status` — is the Gentle Shell/Pi extension answering on
 * loopback? (S2: there is no daemon anymore, only the agent's own extension.)
 *
 * Probing 127.0.0.1:43721 (control surface) and 127.0.0.1:43722 (device surface
 * the tablet tunnels into) asks the bridge to identify itself
 * (`GET /api/health` → `app:"gentle-shell"`, `bridge:"gentle-movil"`, `proto:1`).
 * Three states are reported honestly: the bridge, a port answering as something
 * else (a leftover daemon, never a success), and nothing listening. Exit 0 only
 * when every configured port identifies as the bridge; 1 otherwise; 2 when
 * GENTLE_MOVIL_PORTS is malformed.
 */
import {
  allReachable,
  extensionPorts,
  probeExtensionPorts,
  probeLine,
} from '../lib/loopback.mjs';

export async function run(_args) {
  let ports;
  try {
    ports = extensionPorts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const results = await probeExtensionPorts(ports);
  console.log('Gentle Shell extension (loopback):');
  for (const result of results) console.log(`  ${probeLine(result)}`);

  if (allReachable(results)) {
    console.log('\nextension: reachable — the tablet can tunnel to the agent through SSH.');
    return 0;
  }

  const impostors = results.filter((result) => result.state === 'impostor');
  if (impostors.length > 0) {
    console.log(
      `\nextension: not the bridge — ${impostors
        .map((result) => `127.0.0.1:${result.port}`)
        .join(', ')} answered, but not as Gentle Shell/Pi. Stop whatever owns that port and start the extension (no daemon, no sudo).`,
    );
    return 1;
  }

  console.log(
    '\nextension: not reachable — start Gentle Shell/Pi with its loopback extension (no daemon, no sudo).',
  );
  return 1;
}
