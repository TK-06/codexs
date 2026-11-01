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

module.exports = { resolveOwned, validateInventory };
