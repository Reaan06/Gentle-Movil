#!/usr/bin/env node
/**
 * `gentle-movil pair` — show a pairing QR in the terminal for the Gentle Movil
 * tablet app (protocol `gc://pair?v=1`, docs/mobile-protocol-spec.md §1).
 *
 * There is no daemon (S2): the QR is assembled from local host state only —
 * LAN IP (`os.networkInterfaces`), SSH port (`sshd_config`), the SSH user,
 * the real ed25519 fingerprint (`/etc/ssh/*_key.pub`) and a locally generated
 * invite token/code. Nothing is fetched over HTTP and nothing leaves the box.
 *
 * moshi mode keeps the owner's decision: the QR carries the SSH password so
 * scanning alone provisions the tablet. `--invite-only` skips the password and
 * carries the pairing code instead.
 */
import {
  DEVICE_SURFACE_PORT,
  INVITE_TTL_SECONDS,
  buildPairUri,
  currentUser,
  detectSshPort,
  hostFingerprint,
  lanAddress,
  randomCode,
  randomToken,
} from '../lib/pairing.mjs';
import { renderTerminalQr } from '../lib/qr.mjs';

/** Reads the SSH password without echoing it (moshi: the QR carries it). */
function promptPassword() {
  if (!process.stdin.isTTY) {
    // Piped/scripted invocation: never hang waiting for a TTY. No password
    // means the invite-only payload, which is the honest fallback.
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const finish = () => {
      cleanup();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130); // owner interrupted the password prompt
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += char;
        process.stdout.write('*');
      }
    };
    process.stdout.write(
      'SSH password for the QR (moshi mode — it rides inside the QR for 5 min): ',
    );
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
    stdin.resume();
  });
}

const main = async (args = []) => {
  const inviteOnly = args.includes('--invite-only');

  const token = randomToken();
  const code = randomCode();
  const host = lanAddress();
  const port = detectSshPort();
  const user = currentUser();
  const fp = hostFingerprint();

  const password = inviteOnly ? '' : await promptPassword();
  const uri = buildPairUri({ host, port, user, token, fp, pw: password, code });

  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString();

  console.log(renderTerminalQr(uri));
  console.log(`gc://pair  host=${host}  port=${port}  user=${user}`);
  console.log(`fingerprint (ed25519, sha256): ${fp.slice(0, 32)}…${fp.slice(-8)}`);
  console.log(`token: ${token} (generated locally, ${INVITE_TTL_SECONDS / 60} min TTL hint)`);
  if (!password) {
    console.log(`pairing code: ${code} (invite-only mode)`);
    console.log(
      'mode: invite-only — no SSH password in the QR; the app pairs with the already-authorized key or typed credential',
    );
  } else {
    console.log('mode: moshi — the QR carries the SSH password (single use, 5 min)');
  }
  if (host === '127.0.0.1') {
    console.log(
      'warning: no LAN address detected (only loopback) — run `gentle-movil doctor` before scanning',
    );
  }
  console.log(
    `Expires: ${expiresAt} · nothing persists this token: the Gentle Shell extension validates it during the first pairing.`,
  );
  console.log(`device surface: ${DEVICE_SURFACE_PORT} (tunnel target, no daemon to install).`);
};

// Errors propagate to the CLI dispatcher, which prints them and sets the exit code.

export { main as run };
