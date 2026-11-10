'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { releaseManifest, installationState } = require('../test-support/update-fixtures.cjs');
const { encodeRelease, UpdateError } = require('./protocol.cjs');
const { readInstallation, commitState, transition } = require('./state.cjs');
const { fetchStableRelease } = require('./http.cjs');
const api = () => require('./stage.cjs');
const NOW = 1800000000000, HOUR = 3600000, FLOOR = 8589934592;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = generateKeyPairSync('ed25519');

function bundle(sequence = 2, edit = () => {}) {
  const release = releaseManifest(sequence);
  const pe = Buffer.alloc(128);
  pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  const files = {
    'bin/codex.exe': pe,
    'codex-path/rg.exe': pe,
    'codex-resources/codex-command-runner.exe': pe,
    'codex-resources/codex-windows-sandbox-setup.exe': pe,
    'formatter/dist/ccstatusline.js': Buffer.from('import "./chunk.js";\n'),
    'formatter/dist/chunk.js': Buffer.from('export {};\n'),
    'formatter/package.json': Buffer.from(JSON.stringify({ name: 'ccstatusline', version: '2.2.32', type: 'module' })),
    'packages/main/package.json': Buffer.from(JSON.stringify({ name: '@openai/codex', version: '0.166.0', optionalDependencies: { '@openai/codex-win32-x64': 'npm:@openai/codex@0.166.0-win32-x64' } })),
    'packages/helper/package.json': Buffer.from(JSON.stringify({ name: '@openai/codex', version: '0.166.0-win32-x64', os: ['win32'], cpu: ['x64'] })),
    'LICENSE': Buffer.from('Synthetic test license\n'),
  };
  edit(files, release);
  const archive = Buffer.from('Synthetic archive boundary fixture');
  release.archive = { name: 'codexs-windows-x64.zip', bytes: archive.length, sha256: hash(archive) };
  release.files = Object.entries(files).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([p, b]) => ({ path: p, bytes: b.length, sha256: hash(b) }));
  const manifestBytes = encodeRelease(release);
  const signature = sign(null, Buffer.concat([Buffer.from('codexs-release-v1\0'), manifestBytes]), keys.privateKey);
  const ref = { release_id: release.release_id, sequence, manifest_sha256: hash(manifestBytes) };
  return { release, manifestBytes, signature, archive, files, ref };
}

async function fixture(t, candidate = bundle()) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codexs-stage-test-'));
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.match(path.basename(base), /^codexs-stage-test-/);
    await fs.rm(base, { recursive: true });
  });
  const root = path.join(base, 'managed space');
  await fs.mkdir(root);
  const sentinels = ['settings.json', 'auth.json', 'history.json'];
  for (const name of sentinels) await fs.writeFile(path.join(base, name), `synthetic ${name}`);
  await fs.writeFile(path.join(root, 'current.json'), encodeRelease(installationState()));
  const calls = [], commits = [];
  let now = NOW;
  const ports = {
    publicKey: keys.publicKey, assetId: 123, node: process.execPath, now: () => now,
    readState: readInstallation,
    commitState: (r, state) => commitState(r, state, { commit: async ({ current, backup, bytes }) => {
      try { await fs.copyFile(current, backup); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fs.writeFile(current, bytes); commits.push(structuredClone(state));
    } }),
    fetchStableRelease: async ({ state, nowMs }) => {
      calls.push('fetch');
      // Exercise the actual HTTP eligibility logic; any accidental self-throttle fails staging.
      const eligible = await fetchStableRelease({ state, nowMs }, { request: async () => { throw new Error('synthetic network'); } });
      assert.equal(eligible.deferred, 'NETWORK');
      assert.equal((await readInstallation(root)).state.failures, state.failures + 1);
      return { manifestBytes: candidate.manifestBytes, signature: candidate.signature, assetId: 123 };
    },
    downloadAsset: async ({ assetId, bytes, sha256, destination }) => {
      calls.push('download'); assert.equal(assetId, 123);
      assert.equal(bytes, candidate.archive.length); assert.equal(sha256, hash(candidate.archive));
      if (calls.includes('fetch')) assert.equal((await readInstallation(root)).state.highest.sequence, candidate.release.sequence);
      await fs.writeFile(destination, candidate.archive, { flag: 'wx' });
    },
    extract: async ({ archive, destination, inventory, allowedRoot }) => {
      calls.push('extract'); assert.deepEqual(await fs.readFile(archive), candidate.archive);
      assert.ok(destination.startsWith(allowedRoot + path.sep));
      assert.deepEqual(JSON.parse(await fs.readFile(inventory, 'utf8')), candidate.release.files);
      for (const [name, bytes] of Object.entries(candidate.files)) {
        const file = path.join(destination, ...name.split('/'));
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
      }
    },
    freeBytes: async () => FLOOR,
    readSettingsVersion: async () => 4,
    probeVersion: async ({ native, node, formatter }) => {
      calls.push('version'); assert.equal(node, process.execPath);
      assert.deepEqual(await fs.readFile(native), candidate.files['bin/codex.exe']);
      assert.deepEqual(await fs.readFile(formatter), candidate.files['formatter/dist/ccstatusline.js']);
      return { native: '0.166.0', formatter: '2.2.32' };
    },
    smoke: async () => { calls.push('smoke'); },
  };
  const check = () => api().runUpdate({ mode: 'check', root, request: {} }, ports);
  const stage = () => api().stageRelease({ root, release: candidate.release, manifestBytes: candidate.manifestBytes, signature: candidate.signature }, ports);
  const state = async () => (await readInstallation(root)).state;
  const unchanged = async () => {
    for (const name of sentinels) assert.equal(await fs.readFile(path.join(base, name), 'utf8'), `synthetic ${name}`);
  };
  return { root, candidate, ports, calls, commits, check, stage, state, unchanged, advance: () => { now += 7 * HOUR; } };
}

test('verification precedes candidate execution: signature and supplied manifest must agree', async t => {
  for (const change of ['signature', 'release']) await t.test(change, async t => {
    const b = bundle();
    if (change === 'signature') b.signature = Buffer.alloc(64);
    else b.release = { ...b.release, product_version: '9.0.0' };
    const f = await fixture(t, b);
    await assert.rejects(f.stage(), { code: change === 'signature' ? 'SIGNATURE' : 'MANIFEST_MISMATCH' });
    assert.deepEqual(f.calls, []); assert.equal((await f.state()).highest, null); await f.unchanged();
  });
});

test('verification precedes candidate execution: all bytes and required packages verify first', async t => {
  const cases = [
    ['file hash', async d => fs.appendFile(path.join(d, 'LICENSE'), 'changed'), 'STAGE_INVENTORY'],
    ['missing file', async d => fs.unlink(path.join(d, 'formatter/dist/chunk.js')), 'STAGE_INVENTORY'],
    ['extra file', async d => fs.writeFile(path.join(d, 'extra'), 'unexpected'), 'STAGE_INVENTORY'],
    ['symlink', async d => { await fs.unlink(path.join(d, 'LICENSE')); await fs.symlink(d, path.join(d, 'LICENSE'), 'junction'); }, 'STAGE_INVENTORY'],
  ];
  for (const [name, change, code] of cases) await t.test(name, async t => {
    const f = await fixture(t); const extract = f.ports.extract;
    f.ports.extract = async args => { await extract(args); await change(args.destination); };
    assert.equal((await f.check()).code, code);
    assert.ok(!f.calls.includes('version')); assert.ok(!f.calls.includes('smoke'));
    assert.equal((await f.state()).ready, null); assert.deepEqual((await f.state()).rejected, [f.candidate.ref.release_id]);
  });
  for (const name of ['package', 'alias', 'formatter', 'architecture', 'layout']) await t.test(name, async t => {
    const b = bundle(2, files => {
      if (name === 'package') files['packages/main/package.json'] = Buffer.from('{"name":"@openai/codex","version":"9.0.0"}');
      if (name === 'alias') files['packages/main/package.json'] = Buffer.from('{"name":"@openai/codex","version":"0.166.0","optionalDependencies":{}}');
      if (name === 'formatter') files['formatter/package.json'] = Buffer.from('{"name":"ccstatusline","version":"9.0.0"}');
      if (name === 'architecture') files['codex-path/rg.exe'] = Buffer.from('wrong architecture');
      if (name === 'layout') delete files['codex-resources/codex-command-runner.exe'];
    });
    const f = await fixture(t, b);
    assert.equal((await f.check()).code, name === 'architecture' ? 'STAGE_ARCHITECTURE' : 'STAGE_PACKAGE');
    assert.ok(!f.calls.includes('version')); assert.ok(!f.calls.includes('smoke'));
  });
});

test('ready is not current and staging alone changes no pointer', async t => {
  const f = await fixture(t);
  const old = await fixture(t, bundle(1));
  await old.stage();
  await fs.cp(path.join(old.root, 'versions'), path.join(f.root, 'versions'), { recursive: true });
  await f.ports.commitState(f.root, { ...installationState(), current: old.candidate.ref, highest: { sequence: 1, manifest_sha256: old.candidate.ref.manifest_sha256 } });
  const oldBinary = path.join(f.root, 'versions', old.candidate.ref.release_id, 'bin/codex.exe');
  const oldBytes = await fs.readFile(oldBinary);
  const before = await f.state();
  assert.deepEqual(await f.stage(), f.candidate.ref);
  assert.deepEqual(await f.state(), before);
  assert.equal((await f.check()).code, 'READY');
  const state = await f.state();
  assert.deepEqual(state.ready, f.candidate.ref); assert.deepEqual(state.current, old.candidate.ref); assert.equal(state.previous, null);
  assert.deepEqual(await fs.readFile(oldBinary), oldBytes);
  assert.equal(state.failures, 0); await f.unchanged();
  const version = path.join(f.root, 'versions', f.candidate.ref.release_id);
  assert.deepEqual(await fs.readFile(path.join(version, 'release.json')), f.candidate.manifestBytes);
  assert.deepEqual(await fs.readFile(path.join(version, 'release.sig')), f.candidate.signature);
});

test('interrupted work leaves current usable and immutable contents untouched', async t => {
  for (const point of ['download', 'extract', 'conflict', 'archive hash', 'state commit']) await t.test(point, async t => {
    const f = await fixture(t);
    const current = { release_id: 'codexs-v1.0.0-codex0.166.0-r1', sequence: 1, manifest_sha256: '1'.repeat(64) };
    await f.ports.commitState(f.root, { ...installationState(), current, highest: { sequence: 1, manifest_sha256: current.manifest_sha256 } });
    let conflict;
    if (point === 'download') f.ports.downloadAsset = async ({ destination }) => { await fs.writeFile(destination, 'partial'); throw new Error('private path'); };
    if (point === 'extract') f.ports.extract = async ({ destination }) => { await fs.mkdir(destination); throw new Error('private path'); };
    if (point === 'archive hash') f.ports.downloadAsset = async ({ destination }) => fs.writeFile(destination, 'wrong bytes');
    if (point === 'conflict') {
      conflict = path.join(f.root, 'versions', f.candidate.ref.release_id, 'sentinel');
      await fs.mkdir(path.dirname(conflict), { recursive: true }); await fs.writeFile(conflict, 'immutable');
    }
    if (point === 'state commit') f.ports.commitState = async () => { throw new Error('private path'); };
    const result = await f.check();
    assert.match(result.code, /^(STAGE_IO|STAGE_CONFLICT|DOWNLOAD_HASH|STATE_COMMIT)$/);
    const state = await f.state(); assert.deepEqual(state.current, current); assert.equal(state.ready, null);
    assert.deepEqual(state.rejected, []); if (conflict) assert.equal(await fs.readFile(conflict, 'utf8'), 'immutable');
    await f.unchanged();
  });
});

test('disk and settings incompatibility defer without migration', async t => {
  for (const [name, version, free, expected] of [
    ['low disk', 4, FLOOR - 1, 'LOW_DISK'], ['exact floor', 4, FLOOR, 'READY'],
    ['missing', null, FLOOR, 'SETTINGS_HOLD'], ['malformed', '4', FLOOR, 'SETTINGS_HOLD'],
    ['unknown', 5, FLOOR, 'SETTINGS_HOLD'],
  ]) await t.test(name, async t => {
    const f = await fixture(t); f.ports.freeBytes = async () => free; f.ports.readSettingsVersion = async () => version;
    assert.equal((await f.check()).code, expected); await f.unchanged();
    if (expected !== 'READY') { assert.ok(!f.calls.includes('download')); assert.deepEqual((await f.state()).rejected, []); }
  });
});

test('rejected and stale releases stay suppressed without unsigned state poisoning', async t => {
  for (const kind of ['stale', 'conflict', 'rejected', 'unsigned']) await t.test(kind, async t => {
    const f = await fixture(t);
    const start = { ...installationState(), highest: { sequence: kind === 'stale' ? 3 : 2, manifest_sha256: kind === 'conflict' ? 'f'.repeat(64) : f.candidate.ref.manifest_sha256 } };
    if (kind === 'rejected') start.rejected = [f.candidate.ref.release_id];
    if (kind === 'unsigned') f.candidate.signature = Buffer.alloc(64);
    await f.ports.commitState(f.root, start);
    assert.equal((await f.check()).code, kind === 'unsigned' ? 'SIGNATURE' : kind === 'rejected' ? 'REJECTED_RELEASE' : 'REPLAY');
    const state = await f.state(); assert.deepEqual(state.highest, start.highest); assert.deepEqual(state.rejected, start.rejected);
    assert.equal(state.failures, 1); assert.ok(!f.calls.includes('download'));
    assert.equal((await f.check()).code, 'THROTTLED'); assert.equal((await f.state()).failures, 1);
  });
});

test('failed smoke or version rejects exactly once; modified probe output never becomes ready', async t => {
  for (const kind of ['smoke', 'version', 'extra version', 'modified payload']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'smoke') f.ports.smoke = async () => { throw new UpdateError('SMOKE_OUTPUT'); };
    if (kind === 'version') f.ports.probeVersion = async () => ({ native: '0.0.0', formatter: '2.2.32' });
    if (kind === 'extra version') f.ports.probeVersion = async () => ({ native: '0.166.0\nextra', formatter: '2.2.32' });
    if (kind === 'modified payload') f.ports.smoke = async ({ formatter }) => fs.appendFile(formatter, '// changed');
    const result = await f.check(); assert.match(result.code, /^(SMOKE_OUTPUT|STAGE_VERSION|STAGE_INVENTORY)$/);
    const state = await f.state(); assert.equal(state.ready, null); assert.deepEqual(state.rejected, [f.candidate.ref.release_id]); assert.equal(state.failures, 1);
    f.advance(); assert.equal((await f.check()).code, 'REJECTED_RELEASE'); assert.equal((await f.state()).failures, 2);
  });
});

test('attempt progress survives interruption, preserves recovery and avoids self-throttling', async t => {
  const f = await fixture(t);
  f.ports.downloadAsset = async () => {
    const state = await f.state(); assert.equal(state.failures, 1); assert.equal(state.next_check_ms, NOW + HOUR);
    throw new Error('simulated termination after persisted attempt');
  };
  assert.equal((await f.check()).code, 'STAGE_IO'); assert.equal((await f.state()).failures, 1);
  assert.equal(f.calls.filter(x => x === 'fetch').length, 1);
  await fs.copyFile(path.join(f.root, 'current.json'), path.join(f.root, 'current.previous.json'));
  await fs.writeFile(path.join(f.root, 'current.json'), 'interrupted primary');
  f.advance(); f.ports.fetchStableRelease = async () => ({ unchanged: true });
  assert.equal((await f.check()).code, 'UNCHANGED'); assert.equal((await f.state()).failures, 0);
  await f.unchanged();
});

test('clock rollback is normalized locally without network or counted failure', async t => {
  const f = await fixture(t);
  await f.ports.commitState(f.root, { ...installationState(), last_check_ms: NOW + HOUR, next_check_ms: NOW + 2 * HOUR });
  assert.equal((await f.check()).code, 'CLOCK_ROLLBACK');
  assert.deepEqual(f.calls, []); assert.equal((await f.state()).last_check_ms, NOW); assert.equal((await f.state()).failures, 0);
});

test('explicit promote and rollback revalidate immutable refs and do no networking', async t => {
  const f = await fixture(t);
  await f.check();
  f.ports.fetchStableRelease = async () => { throw new Error('must remain local'); };
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'PROMOTED');
  assert.deepEqual((await f.state()).current, f.candidate.ref);
  const first = f.candidate.ref, newer = bundle(3);
  const g = await fixture(t, newer); // Copy a fully verified second immutable version, then select its ready ref.
  await g.stage();
  await fs.cp(path.join(g.root, 'versions', newer.ref.release_id), path.join(f.root, 'versions', newer.ref.release_id), { recursive: true });
  await f.ports.commitState(f.root, transition(transition(await f.state(), { type: 'manifest-seen', ref: newer.ref }), { type: 'stage-ready', ref: newer.ref }));
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'PROMOTED');
  assert.deepEqual((await f.state()).previous, first);
  assert.equal((await api().runUpdate({ mode: 'rollback', root: f.root, request: {} }, f.ports)).code, 'ROLLED_BACK');
  const state = await f.state(); assert.deepEqual(state.current, first); assert.deepEqual(state.rejected, [newer.ref.release_id]);
  await f.unchanged();
});

test('bad ready candidate is rejected without replacing current', async t => {
  const f = await fixture(t); await f.check();
  await fs.appendFile(path.join(f.root, 'versions', f.candidate.ref.release_id, 'LICENSE'), 'tampered');
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'STAGE_INVENTORY');
  const state = await f.state(); assert.equal(state.current, null); assert.equal(state.ready, null); assert.deepEqual(state.rejected, [f.candidate.ref.release_id]);
});

test('coordinator capability and strict request are required before mutation', async t => {
  const f = await fixture(t); const before = await fs.readFile(path.join(f.root, 'current.json'));
  const noCoordinator = { ...f.ports }; delete noCoordinator.commitState;
  await assert.rejects(api().runUpdate({ mode: 'check', root: f.root, request: {} }, noCoordinator), { code: 'COORDINATOR_REQUIRED' });
  await assert.rejects(api().stageRelease({ root: f.root, ...f.candidate }, noCoordinator), { code: 'COORDINATOR_REQUIRED' });
  await assert.rejects(api().runUpdate({ mode: 'check', root: f.root, request: { command: 'unsafe' } }, f.ports), { code: 'UPDATE_INPUT' });
  assert.deepEqual(await fs.readFile(path.join(f.root, 'current.json')), before); assert.deepEqual(f.calls, []);
});

test('transient local validation failure does not permanently reject a ready release', async t => {
  const f = await fixture(t); await f.check();
  f.ports.probeVersion = async () => { throw new Error('temporary file access failure'); };
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'STAGE_IO');
  const state = await f.state(); assert.deepEqual(state.ready, f.candidate.ref); assert.deepEqual(state.rejected, []);
});

test('host smoke failures defer without blacklisting a signed candidate', async t => {
  const codes = ['SMOKE_IO', 'SMOKE_ENV', 'SMOKE_ARGS', 'SMOKE_RUNTIME', 'SMOKE_RUNNER', 'SMOKE_CANCELLED', 'SMOKE_TIMEOUT', 'SMOKE_CLEANUP', 'SMOKE_UNSUPPORTED'];
  for (const mode of ['check', 'promote']) for (const code of codes) await t.test(`${mode} ${code}`, async t => {
    const f = await fixture(t);
    if (mode === 'promote') assert.equal((await f.check()).code, 'READY');
    const before = await f.state();
    f.ports.smoke = async () => { throw new UpdateError(code); };
    assert.equal((await api().runUpdate({ mode, root: f.root, request: {} }, f.ports)).code, code);
    const state = await f.state();
    assert.deepEqual(state.current, before.current); assert.deepEqual(state.previous, before.previous);
    assert.deepEqual(state.ready, before.ready); assert.deepEqual(state.rejected, []);
    if (mode === 'check') {
      assert.equal(state.failures, 1); assert.equal(state.next_check_ms, NOW + HOUR);
      assert.equal((await f.check()).code, 'THROTTLED');
    }
    f.ports.smoke = async () => {};
    f.advance();
    assert.equal((await api().runUpdate({ mode, root: f.root, request: {} }, f.ports)).code, mode === 'check' ? 'READY' : 'PROMOTED');
    await f.unchanged();
  });
});

test('wrong visible smoke output rejects a ready candidate without promotion', async t => {
  const f = await fixture(t); assert.equal((await f.check()).code, 'READY');
  f.ports.smoke = async () => { throw new UpdateError('SMOKE_OUTPUT'); };
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'SMOKE_OUTPUT');
  const state = await f.state();
  assert.equal(state.current, null); assert.equal(state.ready, null);
  assert.deepEqual(state.rejected, [f.candidate.ref.release_id]);
  await f.unchanged();
});

test('missing installed sidecars reject readiness instead of retrying a broken candidate', async t => {
  const f = await fixture(t); await f.check();
  await fs.unlink(path.join(f.root, 'versions', f.candidate.ref.release_id, 'release.sig'));
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'STAGE_INVENTORY');
  assert.deepEqual((await f.state()).rejected, [f.candidate.ref.release_id]); assert.equal((await f.state()).ready, null);
});

test('settings changed after staging hold local activation without rejecting the release', async t => {
  const f = await fixture(t); await f.check();
  f.ports.readSettingsVersion = async () => 5;
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'SETTINGS_HOLD');
  assert.deepEqual((await f.state()).ready, f.candidate.ref); assert.equal((await f.state()).current, null);
  assert.deepEqual((await f.state()).rejected, []); await f.unchanged();
});

test('installed sidecars are rechecked after candidate probes', async t => {
  const f = await fixture(t); await f.check();
  f.ports.smoke = async ({ native }) => fs.writeFile(path.join(path.dirname(native), '..', 'release.json'), '{}');
  assert.equal((await api().runUpdate({ mode: 'promote', root: f.root, request: {} }, f.ports)).code, 'STAGE_INVENTORY');
  assert.equal((await f.state()).current, null); assert.equal((await f.state()).ready, null);
});

test('rate-limit backoff counts one attempt and respects the longer retry window', async t => {
  const f = await fixture(t);
  f.ports.fetchStableRelease = async () => ({ deferred: 'RATE_LIMIT', retryAfterMs: 3 * HOUR });
  assert.equal((await f.check()).code, 'RATE_LIMIT');
  assert.equal((await f.state()).failures, 1); assert.equal((await f.state()).next_check_ms, NOW + 3 * HOUR);
});

test('staging consumes a real ZIP through the existing extraction boundary', async t => {
  const f = await fixture(t), b = f.candidate;
  const source = path.join(f.root, 'zip-source'), archive = path.join(f.root, 'synthetic.zip');
  for (const [name, bytes] of Object.entries(b.files)) {
    const file = path.join(source, ...name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
  }
  function powershell(script, extra) {
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'\n" + script, 'utf16le').toString('base64')],
      { env: { ...process.env, ...extra }, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  }
  powershell(`Add-Type -AssemblyName System.IO.Compression
# Hosted TEMP can contain an 8.3 alias. Exercise that spelling even under a long local TEMP.
$sourceAlias = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:STAGE_SOURCE).ShortPath
$sourceRoot = (Get-Item -LiteralPath $sourceAlias).FullName
$stream = [IO.File]::Open($env:STAGE_ARCHIVE,[IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false,[Text.Encoding]::UTF8)
try {
  foreach ($file in (Get-ChildItem -LiteralPath $sourceRoot -File -Recurse)) {
    $name = $file.FullName.Substring($sourceRoot.Length+1).Replace('\\','/')
    $entry = $zip.CreateEntry($name)
    $output = $entry.Open()
    try { $bytes = [IO.File]::ReadAllBytes($file.FullName); $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }
  }
} finally { $zip.Dispose(); $stream.Dispose() }`, { STAGE_SOURCE: source, STAGE_ARCHIVE: archive });
  b.archive = await fs.readFile(archive); b.release.archive.bytes = b.archive.length; b.release.archive.sha256 = hash(b.archive);
  b.manifestBytes = encodeRelease(b.release); b.signature = sign(null, Buffer.concat([Buffer.from('codexs-release-v1\0'), b.manifestBytes]), keys.privateKey);
  b.ref.manifest_sha256 = hash(b.manifestBytes);
  let extractionFailure;
  f.ports.extract = async args => {
    try {
      powershell(`& ([scriptblock]::Create([IO.File]::ReadAllText($env:STAGE_SCRIPT))) -Archive $env:STAGE_ARCHIVE -Destination $env:STAGE_DESTINATION -Inventory $env:STAGE_INVENTORY -AllowedRoot $env:STAGE_ROOT`,
        { STAGE_SCRIPT: path.join(__dirname, 'archive.ps1'), STAGE_ARCHIVE: args.archive, STAGE_DESTINATION: args.destination, STAGE_INVENTORY: args.inventory, STAGE_ROOT: args.allowedRoot });
    } catch (error) { extractionFailure = error; throw error; }
  };
  const result = await f.check();
  // The public updater deliberately bounds errors; preserve the synthetic adapter failure here.
  if (extractionFailure) throw extractionFailure;
  assert.equal(result.code, 'READY'); assert.deepEqual((await f.state()).ready, b.ref); await f.unchanged();
});
