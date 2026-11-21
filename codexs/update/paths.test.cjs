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

const { createHash } = require('node:crypto');

function ownedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-path-test-'));
  t.after(() => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codexs-path-test-')) throw Error('Unsafe test cleanup');
    fs.rmSync(root, { recursive: true });
  });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'probe'), 'synthetic');
  return { root, files: [{ path: 'bin/probe', bytes: 9, sha256: createHash('sha256').update('synthetic').digest('hex') }] };
}

test('bounded reads permit the exact cap and reject oversized or missing metadata', async t => {
  const { root } = ownedFixture(t);
  const file = path.join(root, 'bin', 'probe');
  assert.equal(typeof api().readBoundedFile, 'function', 'shared bounded reader must exist');
  assert.equal((await api().readBoundedFile(file, { maxBytes: 9, code: 'TEST_METADATA' })).toString(), 'synthetic');
  await assert.rejects(api().readBoundedFile(file, { maxBytes: 8, code: 'TEST_METADATA' }), { code: 'TEST_METADATA' });
  await assert.rejects(api().readBoundedFile(path.join(root, 'missing'), { maxBytes: 9, code: 'TEST_METADATA' }), { code: 'TEST_METADATA' });
  await assert.rejects(api().readBoundedFile(path.join(root, 'bin'), { maxBytes: 9, code: 'TEST_METADATA' }), { code: 'TEST_METADATA' });
});

test('exact inventory rejects changed, truncated, missing and extra payload bytes', async t => {
  const { root, files } = ownedFixture(t);
  assert.equal(typeof api().verifyInventory, 'function', 'shared inventory verifier must exist');
  await api().verifyInventory(root, files, { code: 'TEST_INVENTORY' });
  for (const changed of ['different', 'short']) {
    fs.writeFileSync(path.join(root, 'bin', 'probe'), changed);
    await assert.rejects(api().verifyInventory(root, files, { code: 'TEST_INVENTORY' }), { code: 'TEST_INVENTORY' });
  }
  fs.unlinkSync(path.join(root, 'bin', 'probe'));
  await assert.rejects(api().verifyInventory(root, files, { code: 'TEST_INVENTORY' }), { code: 'TEST_INVENTORY' });
  fs.writeFileSync(path.join(root, 'bin', 'probe'), 'synthetic');
  fs.writeFileSync(path.join(root, 'unlisted'), 'extra');
  await assert.rejects(api().verifyInventory(root, files, { code: 'TEST_INVENTORY' }), { code: 'TEST_INVENTORY' });
});

test('installed inventory permits only the two fixed sidecars as regular files', async t => {
  const { root, files } = ownedFixture(t);
  assert.equal(typeof api().verifyInventory, 'function');
  fs.writeFileSync(path.join(root, 'release.json'), '{}');
  fs.writeFileSync(path.join(root, 'release.sig'), Buffer.alloc(64));
  await api().verifyInventory(root, files, { installed: true, code: 'TEST_INVENTORY' });
  await assert.rejects(api().verifyInventory(root, files, { code: 'TEST_INVENTORY' }), { code: 'TEST_INVENTORY' });
  fs.unlinkSync(path.join(root, 'release.sig'));
  fs.mkdirSync(path.join(root, 'release.sig'));
  await assert.rejects(api().verifyInventory(root, files, { installed: true, code: 'TEST_INVENTORY' }), { code: 'TEST_INVENTORY' });
});

test('shared readers and inventory refuse junction ancestry without touching its target', async t => {
  const { root } = ownedFixture(t);
  assert.equal(typeof api().readBoundedFile, 'function');
  assert.equal(typeof api().verifyInventory, 'function');
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, 'outside', 'sentinel'), 'unchanged');
  const link = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'outside'), link, 'junction');
  t.after(() => { if (fs.existsSync(link)) fs.unlinkSync(link); });
  await assert.rejects(api().readBoundedFile(path.join(link, 'sentinel'), { maxBytes: 9, code: 'TEST_METADATA' }), { code: 'PATH' });
  await assert.rejects(api().verifyInventory(link, [{ path: 'sentinel', bytes: 9, sha256: 'a'.repeat(64) }], { code: 'TEST_INVENTORY' }), { code: 'PATH' });
  assert.equal(fs.readFileSync(path.join(root, 'outside', 'sentinel'), 'utf8'), 'unchanged');
});
