#!/usr/bin/env node
/** `gentle-movil status` — local Companion daemon status summary. */
import { execFileSync } from 'node:child_process';
import { adminHttpUrl } from '../../src/daemon.ts';

export async function run(_args) {
  let running = false;
  let detail = '';
  try {
    const out = execFileSync('node', ['tools/daemon.mjs', 'status'], { encoding: 'utf8', cwd: new URL('../../', import.meta.url).pathname });
    running = out.includes('is running');
    detail = out.split('\n').filter((line) => /console:|binary:|pid/.test(line)).join('\n');
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }

  let pairingSurface = 'unreachable';
  try {
    const response = await fetch(new URL('/api/pairing/start', adminHttpUrl()), { method: 'HEAD', signal: AbortSignal.timeout(3000) }).catch((e) => { throw e; });
    pairingSurface = response.ok ? 'reachable' : `HTTP ${response.status}`;
  } catch (error) {
    pairingSurface = `unreachable: ${error instanceof Error ? error.message.split('\n')[0] : 'error'}`;
  }

  console.log(`daemon:    ${running ? 'running' : 'not running'}${detail ? `\n${detail}` : ''}`);
  console.log(`admin API: ${pairingSurface}`);
  return running ? 0 : 1;
}
