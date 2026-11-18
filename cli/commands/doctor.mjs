#!/usr/bin/env node
/**
 * `gentle-movil doctor` — host-side preflight for the tablet pairing.
 * Each check prints a ✓/✗ line and the doctor exits non-zero if any failed,
 * so "why can't the tablet connect?" is one command.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOST_KEY_CANDIDATES = [
  '/etc/ssh/ssh_host_ed25519_key.pub',
  '/etc/ssh/ssh_host_ecdsa_key.pub',
  '/etc/ssh/ssh_host_rsa_key.pub',
];

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

function sshPort() {
  try {
    const port = readFileSync('/etc/ssh/sshd_config', 'utf8').match(/^\s*Port\s+(\d+)\s*$/m);
    if (port) return Number(port[1]);
  } catch {}
  return 22;
}

function lanHost() {
  // Same UDP trick as pair.mjs but synchronous enough for a doctor line.
  return new Promise((resolve) => {
    import('node:dgram').then(({ createSocket }) => {
      const socket = createSocket('udp4');
      const done = (v) => { try { socket.close(); } catch {} resolve(v); };
      socket.once('error', () => done('127.0.0.1'));
      socket.connect(80, '192.168.2.1', () => done(socket.address().address || '127.0.0.1'));
      setTimeout(() => done('127.0.0.1'), 1500);
    });
  });
}

export async function run(_args) {
  let ok = true;

  ok &= await check('sshd is active on port 22', async () => {
    const out = execFileSync('systemctl', ['is-active', 'sshd'], { encoding: 'utf8' }).trim();
    if (out !== 'active') {
      try {
        const alt = execFileSync('systemctl', ['is-active', 'ssh'], { encoding: 'utf8' }).trim();
        if (alt !== 'active') throw new Error('inactive');
      } catch { throw new Error(`systemd reports "${out}"`); }
    }
    return `port ${sshPort()}`;
  });

  ok &= await check('SSH host key readable (TOFU fingerprint source)', async () => {
    for (const path of HOST_KEY_CANDIDATES) {
      const blob = readFileSync(path, 'utf8').trim().split(/\s+/)[1];
      if (blob) return path;
    }
    throw new Error('no readable host key (chmod the .pub or run doctor as the key owner)');
  });

  ok &= await check('LAN address detected (tablet must be on the same network)', async () => {
    const host = await lanHost();
    if (host === '127.0.0.1') throw new Error('only loopback — check WiFi/network');
    return host;
  });

  ok &= await check('Companion daemon reachable on the admin surface', async () => {
    const { adminHttpUrl } = await import('../../src/daemon.ts');
    const response = await fetch(new URL('/', adminHttpUrl()), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return adminHttpUrl();
  });

  console.log(ok ? '\nAll checks passed — `gentle-movil pair` should work.' : '\nSome checks failed — fix the ✗ lines before pairing.');
  return ok ? 0 : 1;
}
