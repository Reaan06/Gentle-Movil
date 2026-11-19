/**
 * Regression guard: every `accessibilityRole` the app passes must be a role
 * React Native accepts.
 *
 * Why this exists: a `accessibilityRole="status"` (a web-only role) reached the
 * Android view manager and killed the UI thread — the tablet closed the app the
 * moment a button navigated to a screen that rendered it (`Invalid
 * accessibility role value: status`). The JS type checker cannot see this, the
 * screens are `.tsx` (Node cannot render them), and a device test is the only
 * other place it would show up. This test reads the source and fails fast.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Roles React Native 0.88 documents for `accessibilityRole`. */
const VALID = new Set([
  'adjustable',
  'alert',
  'button',
  'checkbox',
  'combobox',
  'grid',
  'header',
  'image',
  'imagebutton',
  'keyboardkey',
  'link',
  'list',
  'menu',
  'menubar',
  'menuitem',
  'none',
  'progressbar',
  'radio',
  'radiogroup',
  'scrollbar',
  'search',
  'spinbutton',
  'summary',
  'switch',
  'tab',
  'tablist',
  'text',
  'timer',
  'togglebutton',
  'toolbar',
]);

const ROOT = new URL('../', import.meta.url).pathname;

function tsxFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsxFiles(rel));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * `accessibilityRole="x"`, `accessibilityRole={'x'}` and ternaries
 * `accessibilityRole={cond ? 'a' : 'b'}`. Only the branch literals are roles;
 * the operands of the comparison (`tone === 'danger'`) are not.
 */
function rolesIn(source) {
  const found = [];
  for (const match of source.matchAll(/accessibilityRole=("([a-z]+)"|\{[^}]*\})/g)) {
    if (match[2] !== undefined) {
      found.push(match[2]);
      continue;
    }
    const direct = /^\{'([a-z]+)'\}$/.exec(match[1]);
    if (direct !== null) {
      found.push(direct[1]);
      continue;
    }
    for (const branch of match[1].matchAll(/[?:]\s*'([a-z]+)'/g)) {
      found.push(branch[1]);
    }
  }
  return found;
}

test('every accessibilityRole in the app is a role React Native accepts', () => {
  const files = [...tsxFiles('app'), ...tsxFiles('components')];
  assert.ok(files.length > 10, `expected the screens, found ${files.length} files`);
  const offenders = [];
  for (const file of files) {
    for (const role of rolesIn(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!VALID.has(role)) {
        offenders.push(`${file}: ${role}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the guard itself recognizes the forms the screens use', () => {
  assert.deepEqual(rolesIn('<View accessibilityRole="summary" />'), ['summary']);
  assert.deepEqual(rolesIn('<View accessibilityRole="bogus" />'), ['bogus']);
  assert.deepEqual(
    rolesIn("<View accessibilityRole={tone === 'danger' ? 'alert' : 'summary'} />"),
    ['alert', 'summary'],
  );
  assert.deepEqual(rolesIn("<View accessibilityRole={'tab'} />"), ['tab']);
});
