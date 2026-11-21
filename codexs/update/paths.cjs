'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { UpdateError } = require('./protocol.cjs');

function fail(code) { throw new UpdateError(code); }

function portable(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024 ||
      /[\x00-\x1f\x7f<>:"\\|?*]/.test(name) || /[\ud800-\udfff]/u.test(name)) fail('PATH');
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) fail('PATH');
  if (['release.json', 'release.sig', 'codexs-windows-x64.zip'].includes(name.toLowerCase())) fail('PATH');
  return name;
}

function resolveOwned(root, relative) {
  portable(relative);
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('PATH');
  const base = path.resolve(root);
  if (base === path.parse(base).root) fail('PATH');
  const target = path.resolve(base, ...relative.split('/'));
  if (!target.toLowerCase().startsWith(base.toLowerCase() + path.sep)) fail('PATH');
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('PATH'); }
    catch (error) { if (error.code !== 'ENOENT') fail('PATH'); }
    if (cursor === path.dirname(cursor)) break;
  }
  return target;
}

function validateInventory(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 10000) fail('INVENTORY');
  const names = new Set();
  const parents = new Set();
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).sort().join(',') !== 'bytes,path,sha256') fail('INVENTORY');
    const name = portable(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('INVENTORY');
    total += file.bytes;
    if (total > 2147483648) fail('INVENTORY');
    const normalized = name.normalize('NFC').toLowerCase();
    if (names.has(normalized)) fail('PATH');
    names.add(normalized);
    const parts = normalized.split('/');
    for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join('/'));
  }
  if ([...names].some(name => parents.has(name))) fail('PATH');
  return files;
}


const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');

async function readBoundedFile(file, { maxBytes = 4 * 1024 * 1024, code = 'INVENTORY' } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 4 * 1024 * 1024) fail(code);
  resolveOwned(path.dirname(file), 'ancestry-check');
  const info = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') fail(code); throw error; });
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail(code);
  const handle = await fsp.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) fail(code);
    const bytes = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== opened.size || used > maxBytes) fail(code);
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

async function hashFile(file, bytes, code) {
  const info = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') fail(code); throw error; });
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes) fail(code);
  const handle = await fsp.open(file, 'r');
  try {
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > bytes) fail(code);
      hash.update(chunk);
    }
    if (total !== bytes) fail(code);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function verifyInventory(root, files, { installed = false, code = 'INVENTORY' } = {}) {
  validateInventory(files);
  resolveOwned(root, 'ancestry-check');
  const expected = new Map(files.map(file => [file.path, file]));
  const directories = new Set();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const seen = new Set();
  async function walk(relative = '') {
    const entries = await fsp.readdir(relative ? resolveOwned(root, relative) : root, { withFileTypes: true })
      .catch(error => { if (error.code === 'ENOENT') fail(code); throw error; });
    for (const entry of entries) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (installed && relative === '' && ['release.json', 'release.sig'].includes(name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail(code);
        continue;
      }
      if (entry.isSymbolicLink()) fail(code);
      if (entry.isDirectory()) {
        if (!directories.has(name)) fail(code);
        await walk(name);
      } else {
        const file = expected.get(name);
        if (!entry.isFile() || !file || seen.has(name)) fail(code);
        if (await hashFile(resolveOwned(root, name), file.bytes, code) !== file.sha256) fail(code);
        seen.add(name);
      }
    }
  }
  await walk();
  if (seen.size !== expected.size) fail(code);
}

module.exports = { resolveOwned, validateInventory, readBoundedFile, verifyInventory, hashFile };
