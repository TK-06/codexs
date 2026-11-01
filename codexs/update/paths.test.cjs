'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function api() {
  let value;
  assert.doesNotThrow(() => { value = require('./paths.cjs'); }, 'owned path validation must exist');
  return value;
}

function file(name, bytes = 1) { return { path: name, bytes, sha256: 'a'.repeat(64) }; }

test('portable Unicode and space paths retain their exact names', () => {
  const files = [file('bin/codex.exe'), file('สี/hello 🌟.txt')];
  assert.deepEqual(api().validateInventory(files), files);
});

test('traversal, rooted and drive-relative inventory names are rejected', () => {
  for (const name of ['../outside', '/rooted', 'C:relative', 'C:/rooted', '\\server\share', 'bin\\..\\outside', 'bin/./app', 'bin//app', 'bin/../app', 'bin/a\0b']) {
    assert.throws(() => api().validateInventory([file(name)]), { code: 'PATH' });
  }
});

test('Windows device names, streams and normalization traps cannot be extracted', () => {
  for (const name of ['CON', 'aux.txt', 'x/COM1.log', 'LPT¹.txt', 'CONOUT$', 'bin/app:stream', 'bin/trailing.', 'bin/trailing ', 'bad?.txt', 'x/<bad>', 'x/\ud800']) {
    assert.throws(() => api().validateInventory([file(name)]), { code: 'PATH' });
  }
});

test('case collisions and file-directory collisions fail before writing', () => {
  assert.throws(() => api().validateInventory([file('bin/app'), file('BIN/APP')]), { code: 'PATH' });
  assert.throws(() => api().validateInventory([file('bin'), file('bin/app')]), { code: 'PATH' });
});

test('release sidecars and the archive itself cannot appear as payload files', () => {
  for (const name of ['release.json', 'RELEASE.SIG', 'codexs-windows-x64.zip']) {
    assert.throws(() => api().validateInventory([file(name)]), { code: 'PATH' });
  }
});

test('declared expansion and entry limits permit the boundary but reject overflow', () => {
  assert.equal(api().validateInventory([file('large', 2147483648)]).length, 1);
  assert.throws(() => api().validateInventory([file('a', 2147483648), file('b')]), { code: 'INVENTORY' });
  const entries = Array.from({ length: 10000 }, (_, i) => file(`f${String(i).padStart(5, '0')}`, 0));
  assert.equal(api().validateInventory(entries).length, 10000);
  assert.throws(() => api().validateInventory([...entries, file('overflow', 0)]), { code: 'INVENTORY' });
});

test('invalid hashes and coerced or fractional sizes are rejected', () => {
  for (const item of [{ ...file('x'), sha256: ['a'.repeat(64)] }, file('x', '1'), file('x', 0.5), file('x', -1)]) {
    assert.throws(() => api().validateInventory([item]), { code: 'INVENTORY' });
  }
});

test('owned path resolution rejects existing junction ancestors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-path-test-'));
  const link = path.join(root, 'link');
  try {
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), link, 'junction');
    assert.throws(() => api().resolveOwned(root, 'link/file'), { code: 'PATH' });
    assert.equal(api().resolveOwned(root, 'bin/app'), path.join(root, 'bin', 'app'));
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codexs-path-test-')) throw Error('Unsafe test cleanup');
    fs.rmSync(root, { recursive: true });
  }
});
