#!/usr/bin/env node
/**
 * `gentle-movil` — base CLI for the Gentle Movil host-side tooling.
 *
 * Structure (kept boring on purpose, documented in docs/cli.md):
 * - `cli/commands/<name>.mjs` exports `run(args)` → exit code; one file per
 *   command, no shared mutable state.
 * - This file parses argv, dispatches, prints help/errors. Adding a command =
 *   adding one file + one line in COMMANDS below.
 *
 * Install as `gentle-movil` after `npm install` (see package.json `bin`), or
 * run directly: `node cli/gentle-movil.mjs <command>`.
 */
import { pathToFileURL } from 'node:url';

const COMMANDS = {
  /** One-time pairing QR for the Gentle Movil app, rendered in the terminal. */
  pair: () => import('./commands/pair.mjs'),
  /** Daemon status summary (running, pid, binary, pairing surface). */
  status: () => import('./commands/status.mjs'),
  /** Host-side preflight: sshd, host keys, LAN IP, daemon reachability. */
  doctor: () => import('./commands/doctor.mjs'),
};

const HELP = `gentle-movil — host-side companion for the Gentle Movil app

Usage: gentle-movil <command> [args]

Commands:
  pair       Show a one-time pairing QR in the terminal (gc://pair, spec §1)
  status     Report the local Companion daemon status
  doctor     Preflight checks: sshd, host keys, daemon, LAN reachability
  help       Show this help

Examples:
  gentle-movil pair            # QR → scan it with the app
  gentle-movil doctor          # why can't the tablet connect?
`;

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  const loader = COMMANDS[command];
  if (!loader) {
    console.error(`Unknown command: ${command}`);
    console.error(HELP);
    return 2;
  }
  const module = await loader();
  if (typeof module.run !== 'function') {
    console.error(`Command "${command}" does not export run(args).`);
    return 2;
  }
  return await module.run(args);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { main };
