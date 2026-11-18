#!/usr/bin/env node
/**
 * `npm run pair:movil` — show a pairing QR in the terminal for the Gentle Movil
 * phone app (protocol `gc://pair?v=1`, docs/mobile-protocol-spec.md §1).
 *
 * Reuses the daemon's one-time invite (`/api/pairing/start`, same as pair-cli)
 * and completes it with the connection fields the app parses locally: LAN host,
 * SSH port, user, and the host's real ed25519 fingerprint (SHA-256 of
 * /etc/ssh/ssh_host_ed25519_key.pub).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { adminHttpUrl } from '../../src/daemon.ts';
import { createPairing } from '../../src/pair-cli.ts';
import readline from 'node:readline';

const HOST_KEY_CANDIDATES = [
  '/etc/ssh/ssh_host_ed25519_key.pub',
  '/etc/ssh/ssh_host_ecdsa_key.pub',
  '/etc/ssh/ssh_host_rsa_key.pub',
];

/** Host fingerprint: SHA-256 hex over the base64 body of the SSH host key. */
function hostFingerprint() {
  for (const path of HOST_KEY_CANDIDATES) {
    try {
      const line = readFileSync(path, 'utf8').trim();
      const blob = line.split(/\s+/)[1];
      if (!blob) continue;
      return createHash('sha256').update(Buffer.from(blob, 'base64')).digest('hex');
    } catch {
      // Try the next candidate; the error surfaces later if none readable.
    }
  }
  throw new Error('No readable SSH host key under /etc/ssh (try sudo: the .pub files must be readable).');
}

/** Primary LAN IP via a UDP "connect" (no packets sent): fastest reliable way. */
function lanHost() {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (value) => {
      try { socket.close(); } catch {}
      resolve(value);
    };
    socket.once('error', () => done('127.0.0.1'));
    socket.connect(80, '192.168.2.1', () => done(socket.address().address || '127.0.0.1'));
    setTimeout(() => done('127.0.0.1'), 1500);
  });
}

function sshPort() {
  try {
    const config = readFileSync('/etc/ssh/sshd_config', 'utf8');
    const port = config.match(/^\s*Port\s+(\d+)\s*$/m);
    if (port) return Number(port[1]);
  } catch {}
  return 22;
}

function currentUser() {
  try {
    return execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  } catch {
    return process.env.USER || 'user';
  }
}

const { default: qrcode } = await import('qrcode').catch(() => ({}));

/** Reads the SSH password with muted echo (moshi model: the QR carries it). */
function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin;
    stdin.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\r' || char === '\n') continue;
        rl.output.write('*');
      }
    });
    rl.question('SSH password for the QR (moshi mode — it rides inside the QR for 5 min): ', (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    // Mute the default echo.
    rl.prompt = () => {};
  });
}

const main = async (args) => {
  const inviteOnly = args.includes('--invite-only');
  if (!qrcode) throw new Error('Missing dependency `qrcode` — run `npm install` first.');
  const invite = await createPairing();
  const token = new URL(invite.url).searchParams.get('invite');
  if (!token) throw new Error('The daemon invite URL has no `invite` token — cannot build a gc://pair URI.');

  const [host, fp] = await Promise.all([lanHost(), Promise.resolve(hostFingerprint())]);
  const uri = new URL('gc://pair');
  uri.searchParams.set('v', '1');
  uri.searchParams.set('host', host);
  uri.searchParams.set('port', String(sshPort()));
  uri.searchParams.set('user', currentUser());
  uri.searchParams.set('token', token);
  uri.searchParams.set('fp', fp);

  // moshi model (owner decision): the QR carries the SSH password so scanning
  // alone provisions a fresh host. URLSearchParams percent-encodes it; the app
  // decodes `pw` on parse. Opt out with --invite-only (old invite+code path).
  let password = '';
  if (!inviteOnly) {
    password = await promptPassword();
  }
  if (password) {
    uri.searchParams.set('pw', password);
  }
  if (!password) {
    // Invite-only fallback: the pairing code rides along so the app can claim
    // the invite over HTTP against an already-running daemon.
    uri.searchParams.set('code', invite.code);
  }
  uri.searchParams.set('dport', '43722');

  const qr = await qrcode.toString(uri.toString(), { type: 'terminal', small: true });
  console.log(qr);
  console.log(`gc://pair  host=${host}  port=${sshPort()}  user=${currentUser()}`);
  console.log(`fingerprint (ed25519, sha256): ${fp.slice(0, 32)}…${fp.slice(-8)}`);
  console.log(password ? 'mode: moshi — the QR carries the SSH password (single use, 5 min)' : 'mode: invite-only — daemon must already be running on the host');
  console.log(`Expires: ${new Date(invite.expiresAt * 1000).toISOString()} · single use — scan it with Gentle Movil.`);
};

// Errors propagate to the CLI dispatcher, which prints them and sets the exit code.

export { main as run };
