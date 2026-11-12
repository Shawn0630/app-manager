// Unit tests for the stale no-compose warning fix (resolveWarning).
// Run: node --test tests/registry.test.mjs  (or: npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWarning, registerLocalApp } from '../src/registry.js';

// The exact string registerLocalApp stores when no compose file is
// found (kept as a literal here so a wording change fails loudly).
const NO_COMPOSE = 'no compose file found in repo root (looked for docker-compose.yml / compose.yml / compose.yaml)';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-resolve-warning-'));
}

test('no warning stored -> null', () => {
  const dir = tmpDir();
  assert.equal(resolveWarning({ warning: null, workdir: dir }), null);
});

test('exact no-compose warning kept while the file is still missing', () => {
  const dir = tmpDir();
  assert.equal(resolveWarning({ warning: NO_COMPOSE, workdir: dir }), NO_COMPOSE);
});

test('exact no-compose warning clears once the file arrives', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services:\n');
  assert.equal(resolveWarning({ warning: NO_COMPOSE, workdir: dir }), null);
});

test('joined warning keeps its other segments when the file arrives', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n');
  const other = 'not a git repository: no GitHub connection';
  assert.equal(
    resolveWarning({ warning: `${NO_COMPOSE}; ${other}`, workdir: dir }),
    other,
  );
  // …and keeps the whole joined warning while the file is missing.
  const dir2 = tmpDir();
  assert.equal(
    resolveWarning({ warning: `${NO_COMPOSE}; ${other}`, workdir: dir2 }),
    `${NO_COMPOSE}; ${other}`,
  );
});

test('an unrelated warning is untouched even when a compose file exists', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n');
  const warning = 'clone failed: something broke';
  assert.equal(resolveWarning({ warning, workdir: dir }), warning);
});

test('end to end: registerLocalApp warning clears after the file is added', async () => {
  const dir = tmpDir();
  const { warning } = await registerLocalApp({ path: dir }, new Set());
  assert.ok(typeof warning === 'string' && warning.includes('no compose file found'), warning);
  // Still stale while the file is missing…
  assert.equal(resolveWarning({ warning, workdir: dir }), warning);
  // …and the no-compose segment drops once the file exists, while
  // the not-a-git-repo segment survives.
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n');
  const resolved = resolveWarning({ warning, workdir: dir });
  assert.ok(resolved && !resolved.includes('no compose file found'), resolved);
  assert.ok(resolved.includes('not a git repository'), resolved);
});
