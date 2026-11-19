/**
 * `gentle-movil bridge` — install the Gentle Movil bridge as a PERMANENT Pi
 * extension, and report its two independent facts.
 *
 * The bridge is not a service: `pi-extension/package.json` declares
 * `pi.extensions`, so Pi loads it by itself when it starts and binds both
 * loopback ports on `session_start`. "Installing" therefore means one thing
 * only — listing that path in Pi's `packages`. After that the user opens Pi and
 * scans the QR; there is nothing to start.
 *
 * Honesty rules:
 * - never overwrite a settings file that is not valid JSON (refuse, exit 1);
 * - idempotent: a second install leaves the file byte-identical;
 * - `status` reports "installed" and "answering" separately, so "installed but
 *   Pi is closed" can never be mistaken for "not installed" or for success;
 * - the real user settings are only touched by an explicit command, never by a
 *   test.
 */
import { readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root this CLI belongs to (cli/lib/ → repo). */
export const REPO_ROOT = resolve(HERE, '..', '..');
/** The extension directory Pi should load. */
export const EXTENSION_DIR = join(REPO_ROOT, 'pi-extension');

/** Default Pi settings path; `GENTLE_MOVIL_PI_SETTINGS` overrides it. */
export function settingsPath(env = process.env) {
  const override = env.GENTLE_MOVIL_PI_SETTINGS;
  if (typeof override === 'string' && override.trim() !== '') {
    return resolve(override);
  }
  return join(homedir(), '.pi', 'agent', 'settings.json');
}

/** Read + parse the settings file. Returns a typed failure instead of throwing. */
export function readSettings(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: true, data: {}, raw: null, missing: true };
    }
    return {
      ok: false,
      message: `No pudimos leer ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const data = JSON.parse(raw);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, message: `${path} no contiene un objeto JSON.` };
    }
    return { ok: true, data, raw, missing: false };
  } catch (error) {
    return {
      ok: false,
      message: `${path} no es JSON válido: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Is this entry the bridge directory (any equivalent spelling)? */
export function isBridgeEntry(entry, extensionDir = EXTENSION_DIR) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    return false;
  }
  if (entry.startsWith('npm:')) {
    return false;
  }
  const resolved = entry.startsWith('/') ? resolve(entry) : resolve(REPO_ROOT, entry);
  return resolved === resolve(extensionDir);
}

/** Index of the bridge entry in `packages`, or -1. */
export function findBridgeEntry(packages, extensionDir = EXTENSION_DIR) {
  if (!Array.isArray(packages)) {
    return -1;
  }
  return packages.findIndex((entry) => isBridgeEntry(entry, extensionDir));
}

/** Add the bridge to a settings object; returns whether anything changed. */
export function withBridgeEntry(data, extensionDir = EXTENSION_DIR) {
  const packages = Array.isArray(data.packages) ? [...data.packages] : [];
  if (findBridgeEntry(packages, extensionDir) >= 0) {
    return { data, changed: false, packages };
  }
  packages.push(extensionDir);
  return { data: { ...data, packages }, changed: true, packages };
}

/** Write JSON atomically (temp file in the same dir + rename). */
export function writeSettingsAtomic(path, data) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** Backup the previous file next to it, once, before the first change. */
function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${path}.bak-${stamp}`;
  copyFileSync(path, target);
  return target;
}

/** `GET /api/health` on the bridge port, bounded by a short timeout. */
async function probeHealth(port = 43721, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { ok: true, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  } finally {
    clearTimeout(timer);
  }
}

const HELP = `gentle-movil bridge — instala el puente como extensión permanente de Pi

Usage: gentle-movil bridge <install|status|uninstall>

  install     Agrega ${EXTENSION_DIR} a los packages de Pi (una sola vez)
  status      ¿Está instalado? ¿Está respondiendo ahora?
  uninstall   Quita esa entrada y nada más

Después de \`install\`: abrí Pi y escaneá el QR desde el teléfono. No hay ningún
servicio que arrancar: la extensión vive dentro de Pi.
`;

export async function run(args) {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return 0;
  }

  const path = settingsPath();
  const read = readSettings(path);
  if (!read.ok) {
    console.error(read.message);
    console.error('No tocamos el archivo: revisalo a mano y volvé a intentar.');
    return 1;
  }

  if (sub === 'install') {
    const { data, changed } = withBridgeEntry(read.data);
    if (!changed) {
      console.log(`El puente ya estaba instalado en ${path}.`);
      console.log('Abrí Pi: la extensión se carga sola. Después escaneá el QR.');
      return 0;
    }
    let backupPath = null;
    if (!read.missing) {
      backupPath = backup(path);
    }
    writeSettingsAtomic(path, data);
    console.log(`Instalado: ${EXTENSION_DIR}`);
    console.log(`  en ${path}`);
    if (backupPath) {
      console.log(`  copia previa: ${backupPath}`);
    }
    console.log('Abrí Pi: la extensión se carga sola. Después escaneá el QR.');
    return 0;
  }

  if (sub === 'uninstall') {
    const packages = Array.isArray(read.data.packages) ? read.data.packages : [];
    const index = findBridgeEntry(packages);
    if (index < 0) {
      console.log(`El puente no estaba instalado en ${path}.`);
      return 0;
    }
    const next = { ...read.data, packages: packages.filter((_, i) => i !== index) };
    writeSettingsAtomic(path, next);
    console.log(`Quitado de ${path}. El resto de tus packages quedó igual.`);
    return 0;
  }

  if (sub === 'status') {
    const installed = findBridgeEntry(read.data.packages) >= 0;
    const health = await probeHealth();
    console.log(`instalado en Pi: ${installed ? 'sí' : 'no'}`);
    console.log(`respondiendo ahora: ${health.ok ? 'sí' : 'no'}`);
    if (health.ok) {
      const body = health.body ?? {};
      console.log(`  identidad: ${body.bridge ?? '?'} · proto ${body.proto ?? '?'} · v${body.version ?? '?'}`);
    } else if (installed) {
      console.log('  está instalado pero no responde: abrí Pi (la extensión se carga sola).');
    } else {
      console.log('  instalalo con: gentle-movil bridge install');
    }
    return installed && health.ok ? 0 : 1;
  }

  if (rest.length >= 0 && !['install', 'status', 'uninstall'].includes(sub)) {
    console.error(`Subcomando desconocido: ${sub}`);
    console.error(HELP);
    return 2;
  }
  return 0;
}
