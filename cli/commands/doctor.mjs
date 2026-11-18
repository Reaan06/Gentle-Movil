#!/usr/bin/env node
/**
 * `gentle-movil doctor` — host-side preflight for the tablet pairing (S9).
 *
 * Four checks, each a ✓/✗ line, no sudo, no daemon, nothing beyond loopback:
 *
 * 1. sshd is active (systemd unit `sshd`, then `ssh` on distros that name it so);
 * 2. the ed25519 SSH host key is readable (TOFU fingerprint source);
 * 3. a LAN IPv4 address exists (the tablet must reach this host);
 * 4. the Gentle Shell/Pi extension answers on loopback 43721/43722.
 *
 * Exit 1 when any check fails, so "why can't the tablet connect?" is one
 * command. Missing extension is a normal, honestly reported failure — never a
 * crash.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { ED25519_HOST_KEY, detectSshPort, lanAddress } from '../lib/pairing.mjs';
import {
  allReachable,
  describeProbe,
  extensionPorts,
  probeExtensionPorts,
} from '../lib/loopback.mjs';

async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.log(`✗ ${label} — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return false;
  }
}

/** `systemctl is-active <unit>`; a missing/inactive unit throws an honest reason. */
function activeUnit(unit) {
  try {
    const state = execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8' }).trim();
    if (state === 'active') return unit;
    throw new Error(`systemd reports "${state}"`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('systemd reports')) throw error;
    throw new Error(`systemctl unavailable (${error.code || error.message})`);
  }
}

export async function run(_args) {
  let ports;
  try {
    ports = extensionPorts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let ok = true;

  ok = (await check('sshd is active', async () => {
    let unit;
    try {
      unit = activeUnit('sshd');
    } catch (sshdError) {
      try {
        unit = activeUnit('ssh');
      } catch {
        throw sshdError;
      }
    }
    return `systemd: ${unit} · port ${detectSshPort()}`;
  })) && ok;

  ok = (await check('SSH host key is readable (ed25519, TOFU source)', async () => {
    const line = readFileSync(ED25519_HOST_KEY, 'utf8').trim();
    const blob = line.split(/\s+/)[1];
    if (!blob) throw new Error(`${ED25519_HOST_KEY} has no key body`);
    return ED25519_HOST_KEY;
  })) && ok;

  ok = (await check('LAN address detected (tablet must be on the same network)', async () => {
    const host = lanAddress();
    if (host === '127.0.0.1') throw new Error('only loopback — check WiFi/Ethernet');
    return host;
  })) && ok;

  ok = (await check(
    `Gentle Shell extension reachable on loopback ${ports.join('/')}`,
    async () => {
      const results = await probeExtensionPorts(ports);
      if (!allReachable(results)) {
        throw new Error(results.map(describeProbe).join('; '));
      }
      return results.map(describeProbe).join('; ');
    },
  )) && ok;

  console.log(
    ok
      ? '\nAll checks passed — `gentle-movil pair` should work.'
      : '\nSome checks failed — fix the ✗ lines before pairing.',
  );
  return ok ? 0 : 1;
}
