'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { UpdateError, verifyRelease, encodeRelease, assertFresh } = require('./protocol.cjs');
const { resolveOwned, validateInventory } = require('./paths.cjs');
const { transition, readInstallation } = require('./state.cjs');
const { fetchStableRelease, downloadAsset } = require('./http.cjs');

const FLOOR = 8589934592, HOUR = 3600000;
const REQUIRED = ['bin/codex.exe', 'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe', 'packages/main/package.json', 'packages/helper/package.json', 'formatter/package.json', 'formatter/dist/ccstatusline.js'];
const fail = code => { throw new UpdateError(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const refFor = (release, bytes) => ({ release_id: release.release_id, sequence: release.sequence, manifest_sha256: digest(bytes) });
const same = (a, b) => a && b && a.release_id === b.release_id && a.sequence === b.sequence && a.manifest_sha256 === b.manifest_sha256;
const bounded = (error, fallback = 'STAGE_IO') => error instanceof UpdateError ? error : new UpdateError(fallback);
const deterministic = error => /^(STAGE_(INVENTORY|PACKAGE|ARCHITECTURE|VERSION)|SMOKE_[A-Z0-9_]+|ARCHIVE_[A-Z0-9_]+|SIGNATURE|MANIFEST_(MISMATCH|SCHEMA))$/.test(error.code);

function capability(ports) {
  // Only the OS-lock owner may provide this capability. There is no second lock or standalone writer.
  if (!ports || typeof ports.commitState !== 'function') fail('COORDINATOR_REQUIRED');
}

function authenticate(input, ports) {
  const release = verifyRelease(input.manifestBytes, input.signature, ports.publicKey, ports.policy);
  if (input.release !== undefined && !encodeRelease(input.release).equals(input.manifestBytes)) fail('MANIFEST_MISMATCH');
  validateInventory(release.files);
  return { release, ref: refFor(release, input.manifestBytes) };
}

async function fileHash(file, bytes, code) {
  const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') fail(code); throw error; });
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes) fail(code);
  const handle = await fs.open(file, 'r');
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

// Reserved sidecars are updater-owned constants, never payload inventory names. Validate their
// parent and ancestry through resolveOwned, then inspect the fixed leaf without weakening paths.cjs.
function sidecar(root, name) {
  resolveOwned(root, 'ancestry-check');
  return path.join(root, name);
}

async function readSmall(file, max = 4 * 1024 * 1024) {
  const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') fail('STAGE_INVENTORY'); throw error; });
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail('STAGE_INVENTORY');
  const bytes = await fs.readFile(file);
  if (bytes.length > max) fail('STAGE_INVENTORY');
  return bytes;
}

async function inventory(root, release, installed = false) {
  resolveOwned(root, 'ancestry-check');
  const expected = new Map(release.files.map(file => [file.path, file]));
  const directories = new Set();
  for (const file of release.files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const seen = new Set();
  async function walk(relative = '') {
    const entries = await fs.readdir(relative ? resolveOwned(root, relative) : root, { withFileTypes: true })
      .catch(error => { if (error.code === 'ENOENT') fail('STAGE_INVENTORY'); throw error; });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (installed && relative === '' && ['release.json', 'release.sig'].includes(name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail('STAGE_INVENTORY');
        continue;
      }
      if (entry.isSymbolicLink()) fail('STAGE_INVENTORY');
      if (entry.isDirectory()) {
        if (!directories.has(name)) fail('STAGE_INVENTORY');
        await walk(name);
      } else {
        const file = expected.get(name);
        if (!entry.isFile() || !file || seen.has(name)) fail('STAGE_INVENTORY');
        if (await fileHash(resolveOwned(root, name), file.bytes, 'STAGE_INVENTORY') !== file.sha256) fail('STAGE_INVENTORY');
        seen.add(name);
      }
    }
  }
  await walk();
  if (seen.size !== expected.size) fail('STAGE_INVENTORY');
}

async function json(root, name) {
  const bytes = await readSmall(resolveOwned(root, name));
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('STAGE_PACKAGE'); }
}

async function peX64(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') fail('STAGE_ARCHITECTURE');
    const offset = header.readUInt32LE(60), pe = Buffer.alloc(6);
    if (offset < 64 || offset > (await handle.stat()).size - 6 || (await handle.read(pe, 0, 6, offset)).bytesRead !== 6 ||
        pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) fail('STAGE_ARCHITECTURE');
    return 'x64';
  } finally { await handle.close(); }
}

async function verifyPayload(root, release, ports, installed = false) {
  await inventory(root, release, installed);
  const names = new Set(release.files.map(file => file.path));
  if (REQUIRED.some(name => !names.has(name))) fail('STAGE_PACKAGE');
  const main = await json(root, 'packages/main/package.json');
  const helper = await json(root, 'packages/helper/package.json');
  const formatter = await json(root, 'formatter/package.json');
  if (main.name !== release.packages.main.name || main.version !== release.packages.main.version ||
      main.optionalDependencies?.['@openai/codex-win32-x64'] !== `npm:@openai/codex@${release.packages.helper.version}` ||
      helper.name !== release.packages.helper.name || helper.version !== release.packages.helper.version ||
      !Array.isArray(helper.os) || !helper.os.includes('win32') || !Array.isArray(helper.cpu) || !helper.cpu.includes('x64') ||
      formatter.name !== 'ccstatusline' || formatter.version !== release.formatter.version || formatter.type !== 'module') fail('STAGE_PACKAGE');
  for (const name of REQUIRED.filter(name => name.endsWith('.exe'))) {
    if (await (ports.probePe || peX64)(resolveOwned(root, name)) !== 'x64') fail('STAGE_ARCHITECTURE');
  }
  const paths = { native: resolveOwned(root, 'bin/codex.exe'), node: ports.node || process.execPath, formatter: resolveOwned(root, 'formatter/dist/ccstatusline.js') };
  if (typeof ports.probeVersion !== 'function' || typeof ports.smoke !== 'function') fail('STAGE_PROBE_REQUIRED');
  const versions = await ports.probeVersion(paths);
  if (!versions || Object.keys(versions).sort().join(',') !== 'formatter,native' ||
      versions.native !== release.upstream.version || versions.formatter !== release.formatter.version) fail('STAGE_VERSION');
  await ports.smoke(paths);
  await inventory(root, release, installed);
}

async function settingsCompatible(ports) {
  if (typeof ports.readSettingsVersion !== 'function' || await ports.readSettingsVersion() !== 4) fail('SETTINGS_HOLD');
}

async function compatible(root, ports) {
  await settingsCompatible(ports);
  if (typeof ports.freeBytes !== 'function') fail('LOW_DISK');
  const bytes = await ports.freeBytes(root);
  if (!Number.isSafeInteger(bytes) || bytes < FLOOR) fail('LOW_DISK');
}

async function verifyInstalled(root, ref, ports) {
  const directory = resolveOwned(root, `versions/${ref.release_id}`);
  const manifestBytes = await readSmall(sidecar(directory, 'release.json'));
  const signature = await readSmall(sidecar(directory, 'release.sig'), 64);
  const { release, ref: actual } = authenticate({ manifestBytes, signature }, ports);
  if (!same(ref, actual)) fail('MANIFEST_MISMATCH');
  await verifyPayload(directory, release, ports, true);
  if (!(await readSmall(sidecar(directory, 'release.json'))).equals(manifestBytes) ||
      !(await readSmall(sidecar(directory, 'release.sig'), 64)).equals(signature)) fail('STAGE_INVENTORY');
  return actual;
}

async function stageRelease(input, ports) {
  capability(ports);
  try {
    const { release, ref } = authenticate(input, ports);
    const { state } = await (ports.readState || readInstallation)(input.root);
    assertFresh(release, ref.manifest_sha256, state);
    await compatible(input.root, ports);
    const target = resolveOwned(input.root, `versions/${release.release_id}`);
    try {
      await fs.lstat(target);
      try { await verifyInstalled(input.root, ref, ports); } catch { fail('STAGE_CONFLICT'); }
      return ref;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Number.isSafeInteger(ports.assetId) || ports.assetId <= 0) fail('DOWNLOAD_INPUT');
    const work = resolveOwned(input.root, `staging/${randomUUID()}`);
    await fs.mkdir(path.dirname(work), { recursive: true });
    await fs.mkdir(work);
    const archive = resolveOwned(work, 'archive.zip'), inventoryFile = resolveOwned(work, 'inventory.json');
    const payload = resolveOwned(work, 'payload');
    await fs.writeFile(inventoryFile, encodeRelease(release.files), { flag: 'wx' });
    await (ports.downloadAsset || downloadAsset)({ assetId: ports.assetId, ...release.archive, destination: archive });
    if (await fileHash(archive, release.archive.bytes, 'DOWNLOAD_HASH') !== release.archive.sha256) fail('DOWNLOAD_HASH');
    try {
      if (typeof ports.extract !== 'function') fail('STAGE_EXTRACT_REQUIRED');
      await ports.extract({ archive, destination: payload, inventory: inventoryFile, allowedRoot: work });
      await verifyPayload(payload, release, ports);
    } catch (error) {
      const reason = bounded(error);
      // I/O/transport is retryable. Only deterministic failures after the authenticated archive
      // matched are eligible to suppress this release. Callers never infer trust from an ID alone.
      reason.rejectRelease = deterministic(reason);
      throw reason;
    }
    await fs.writeFile(sidecar(payload, 'release.json'), input.manifestBytes, { flag: 'wx' });
    await fs.writeFile(sidecar(payload, 'release.sig'), input.signature, { flag: 'wx' });
    resolveOwned(input.root, `versions/${release.release_id}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.rename(payload, target); }
    catch (error) { if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) fail('STAGE_CONFLICT'); throw error; }
    return ref;
  } catch (error) { throw bounded(error); }
}

async function runUpdate({ mode, root, request }, ports) {
  capability(ports);
  if (!['check', 'promote', 'rollback'].includes(mode) || !request || typeof request !== 'object' ||
      Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).length) fail('UPDATE_INPUT');
  resolveOwned(root, 'current.json');
  let state, changed = false;
  const result = code => ({ code, stateChanged: changed });
  async function persist(next) {
    try { await ports.commitState(root, next); }
    catch (error) { throw bounded(error, 'STATE_COMMIT'); }
    state = next; changed = true;
  }
  try {
    ({ state } = await (ports.readState || readInstallation)(root));
    if (mode !== 'check') {
      const ref = mode === 'promote' ? state.ready : state.previous;
      if (!ref) return result(mode === 'promote' ? 'NO_READY' : 'NO_PREVIOUS');
      await settingsCompatible(ports);
      if (state.rejected.includes(ref.release_id)) fail('REJECTED_RELEASE');
      try { await verifyInstalled(root, ref, ports); }
      catch (error) {
        if (mode === 'promote' && !same(state.current, ref) && deterministic(bounded(error))) await persist(transition(state, { type: 'reject', ref }));
        throw error;
      }
      await persist(transition(state, { type: mode }));
      return result(mode === 'promote' ? 'PROMOTED' : 'ROLLED_BACK');
    }
    const nowMs = (ports.now || Date.now)();
    if (state.last_check_ms > nowMs || state.next_check_ms > nowMs + 6 * HOUR) {
      await persist(transition(state, { type: 'check-finished', nowMs, result: 'clock-rollback' }));
      return result('CLOCK_ROLLBACK');
    }
    if (state.next_check_ms > nowMs || (state.last_check_ms !== 0 && nowMs - state.last_check_ms < HOUR)) return result('THROTTLED');
    const eligible = state;
    // A failed-attempt reservation survives process death. Completion must never increment it twice.
    await persist(transition(state, { type: 'check-finished', nowMs, result: 'failed' }));
    let trusted;
    try {
      await compatible(root, ports);
      const feed = await (ports.fetchStableRelease || fetchStableRelease)({ state: eligible, nowMs });
      if (feed.deferred) {
        if (feed.retryAfterMs !== undefined) await persist(transition({ ...state, failures: eligible.failures }, { type: 'check-finished', nowMs, result: 'failed', retryAfterMs: feed.retryAfterMs }));
        return result(bounded(new UpdateError(feed.deferred)).code);
      }
      if (feed.unchanged) {
        await persist(transition(state, { type: 'check-finished', nowMs, result: 'ok' }));
        return result('UNCHANGED');
      }
      trusted = authenticate(feed, ports);
      assertFresh(trusted.release, trusted.ref.manifest_sha256, state);
      await persist(transition(state, { type: 'manifest-seen', ref: trusted.ref }));
      const ref = await stageRelease({ root, release: trusted.release, manifestBytes: feed.manifestBytes, signature: feed.signature }, { ...ports, assetId: feed.assetId });
      await persist(transition(transition(state, { type: 'stage-ready', ref }), { type: 'check-finished', nowMs, result: 'ok' }));
      return result('READY');
    } catch (error) {
      if (trusted && error.rejectRelease) await persist(transition(state, { type: 'reject', ref: trusted.ref }));
      throw error;
    }
  } catch (error) { return result(bounded(error).code); }
}

module.exports = { stageRelease, runUpdate };
