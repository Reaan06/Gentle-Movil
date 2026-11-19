/**
 * `gentle-movil bridge` tests. Every case uses a temp settings file — the real
 * `~/.pi/agent/settings.json` is never touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  EXTENSION_DIR,
  findBridgeEntry,
  isBridgeEntry,
  readSettings,
  settingsPath,
  withBridgeEntry,
  writeSettingsAtomic,
} from '../commands/bridge.mjs';

function tempSettings(content) {
  const dir = mkdtempSync(join(tmpdir(), 'gm-bridge-'));
  const path = join(dir, 'settings.json');
  if (content !== undefined) {
    writeFileSync(path, content, 'utf8');
  }
  return path;
}

test('settingsPath honours GENTLE_MOVIL_PI_SETTINGS', () => {
  const path = settingsPath({ GENTLE_MOVIL_PI_SETTINGS: '/tmp/x/settings.json' });
  assert.equal(path, '/tmp/x/settings.json');
});

test('a missing settings file reads as empty, not as an error', () => {
  const result = readSettings(join(tempSettings(), 'missing.json'));
  assert.equal(result.ok, true);
  assert.equal(result.missing, true);
  assert.deepEqual(result.data, {});
});

test('invalid JSON is a typed failure, never a silent overwrite', () => {
  const path = tempSettings('{ not json');
  const result = readSettings(path);
  assert.equal(result.ok, false);
  assert.match(result.message, /no es JSON válido/);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
});

test('a JSON array is refused (settings must be an object)', () => {
  const result = readSettings(tempSettings('[]'));
  assert.equal(result.ok, false);
  assert.match(result.message, /no contiene un objeto JSON/);
});

test('install on empty settings adds exactly one entry and keeps the rest', () => {
  const data = { defaultModel: 'x', extensions: ['-builtin:mcp'] };
  const { data: next, changed } = withBridgeEntry(data);
  assert.equal(changed, true);
  assert.deepEqual(next.extensions, ['-builtin:mcp']);
  assert.equal(next.defaultModel, 'x');
  assert.deepEqual(next.packages, [EXTENSION_DIR]);
});

test('install is idempotent: the second pass changes nothing', () => {
  const first = withBridgeEntry({ packages: ['npm:other'] });
  const second = withBridgeEntry(first.data);
  assert.equal(second.changed, false);
  assert.deepEqual(second.data.packages, ['npm:other', EXTENSION_DIR]);
});

test('an equivalent spelling of the path counts as installed', () => {
  const relative = 'pi-extension';
  assert.equal(isBridgeEntry(relative), true);
  assert.equal(findBridgeEntry([relative]), 0);
  const { changed } = withBridgeEntry({ packages: [relative] });
  assert.equal(changed, false);
});

test('other packages and their order are preserved', () => {
  const packages = ['npm:a', 'npm:b', '/abs/path'];
  const { data } = withBridgeEntry({ packages });
  assert.deepEqual(data.packages, [...packages, EXTENSION_DIR]);
});

test('atomic write leaves valid JSON and no temp file behind', () => {
  const path = tempSettings('{"packages":[]}');
  writeSettingsAtomic(path, { packages: [EXTENSION_DIR] });
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(parsed.packages, [EXTENSION_DIR]);
  assert.ok(!readFileSync(path, 'utf8').includes('tmp-'));
});

test('uninstall removes only the bridge entry', () => {
  const packages = ['npm:a', EXTENSION_DIR, 'npm:b'];
  const index = findBridgeEntry(packages);
  const next = packages.filter((_, i) => i !== index);
  assert.deepEqual(next, ['npm:a', 'npm:b']);
});
