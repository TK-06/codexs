'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installationState } = require('../test-support/update-fixtures.cjs');
const { encodeRelease } = require('./protocol.cjs');
const { fetchStableRelease } = require('./http.cjs');
function api() { return require('./state.cjs'); }
const HOUR = 3600000, NOW = 1800000000000;
function ref(sequence = 1, hash = String(sequence).repeat(64)) {
  return { release_id: `codexs-v1.0.0-codex0.166.0-r${sequence}`, sequence, manifest_sha256: hash };
}
function installed() {
  return { ...installationState(), current: ref(1), highest: { sequence: 1, manifest_sha256: '1'.repeat(64) } };
}
function observed(state, value) { return api().transition(state, { type: 'manifest-seen', ref: value }); }
function ready(state, value) { return api().transition(observed(state, value), { type: 'stage-ready', ref: value }); }
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexs-state-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codexs-state-test-'));
    await fs.rm(root, { recursive: true });
  });
  return root;
}

test('new signed manifest advances highest without replacing the current session', () => {
  const before = installed(), frozen = structuredClone(before);
  const next = observed(before, ref(2));
  assert.deepEqual(next.current, ref(1));
  assert.equal(next.previous, null);
  assert.equal(next.ready, null);
  assert.deepEqual(next.highest, { sequence: 2, manifest_sha256: '2'.repeat(64) });
  assert.deepEqual(before, frozen);
});

test('promotion moves current, previous and ready in one immutable transition', () => {
  const candidate = ready(installed(), ref(2));
  assert.deepEqual(candidate.current, ref(1));
  assert.deepEqual(candidate.ready, ref(2));
  const next = api().transition(candidate, { type: 'promote' });
  assert.deepEqual(next.current, ref(2));
  assert.deepEqual(next.previous, ref(1));
  assert.equal(next.ready, null);
  assert.equal(candidate.previous, null);
  assert.deepEqual(candidate.ready, ref(2));
});

test('lower, conflicting equal sequence and unobserved stage cannot alter any pointer', () => {
  const state = observed(installed(), ref(3));
  for (const event of [
    { type: 'manifest-seen', ref: ref(2) },
    { type: 'manifest-seen', ref: ref(3, 'f'.repeat(64)) },
    { type: 'stage-ready', ref: ref(4) },
    { type: 'stage-ready', ref: ref(3, 'f'.repeat(64)) },
    { type: 'promote' },
  ]) {
    const before = structuredClone(state);
    assert.throws(() => api().transition(state, event), { code: 'STATE_TRANSITION' });
    assert.deepEqual(state, before);
  }
});

test('same authenticated digest can retry until rejected and newer manifests supersede old ready state', () => {
  const state = ready(installed(), ref(2));
  assert.deepEqual(observed(state, ref(2)), state);
  const newer = observed(state, ref(3));
  assert.equal(newer.ready, null);
  const rejected = api().transition(state, { type: 'reject', ref: ref(2) });
  assert.equal(rejected.ready, null);
  assert.deepEqual(rejected.current, ref(1));
  assert.deepEqual(rejected.rejected, [ref(2).release_id]);
  assert.throws(() => observed(rejected, ref(2)), { code: 'STATE_TRANSITION' });
  assert.deepEqual(observed(rejected, ref(3)).highest, { sequence: 3, manifest_sha256: '3'.repeat(64) });
});

test('rollback restores previous, retains highest and suppresses the broken release', () => {
  const active = api().transition(ready(installed(), ref(2)), { type: 'promote' });
  const rolled = api().transition(active, { type: 'rollback' });
  assert.deepEqual(rolled.current, ref(1));
  assert.equal(rolled.previous, null);
  assert.deepEqual(rolled.highest, active.highest);
  assert.deepEqual(rolled.rejected, [ref(2).release_id]);
  assert.throws(() => observed(rolled, ref(2)), { code: 'STATE_TRANSITION' });
  assert.throws(() => api().transition(rolled, { type: 'rollback' }), { code: 'STATE_TRANSITION' });
});

test('repeated promotion cannot erase the last usable predecessor', () => {
  const active = api().transition(ready(installed(), ref(2)), { type: 'promote' });
  const restaged = ready(active, ref(2));
  assert.deepEqual(api().transition(restaged, { type: 'promote' }).previous, ref(1));
  assert.throws(() => api().transition(active, { type: 'reject', ref: ref(2) }), { code: 'STATE_TRANSITION' });
});

test('check failures and rate limits persist bounded retry timing and success resets failures', () => {
  let state = installed();
  for (const [failures, hours] of [[1, 1], [2, 2], [3, 4], [4, 6], [5, 6]]) {
    state = api().transition(state, { type: 'check-finished', result: 'failed', nowMs: NOW });
    assert.equal(state.failures, failures);
    assert.equal(state.last_check_ms, NOW);
    assert.equal(state.next_check_ms, NOW + hours * HOUR);
    assert.deepEqual(state.current, ref(1));
  }
  state = api().transition(state, { type: 'check-finished', result: 'ok', nowMs: NOW });
  assert.equal(state.failures, 0);
  assert.equal(state.next_check_ms, NOW + HOUR);
  state = api().transition(state, { type: 'check-finished', result: 'failed', nowMs: NOW, retryAfterMs: 3 * HOUR });
  assert.equal(state.next_check_ms, NOW + 3 * HOUR);
});

test('clock rollback normalization happens once, then a check is allowed an hour later', async () => {
  const future = { ...installed(), last_check_ms: NOW + HOUR, next_check_ms: NOW + 2 * HOUR };
  const normalized = api().transition(future, { type: 'check-finished', result: 'clock-rollback', nowMs: NOW });
  assert.equal(normalized.last_check_ms, NOW);
  assert.equal(normalized.next_check_ms, NOW + HOUR);
  assert.equal(normalized.failures, 0);
  const again = api().transition(normalized, { type: 'check-finished', result: 'clock-rollback', nowMs: NOW + 10 });
  assert.deepEqual(again, normalized);
  let calls = 0;
  const transport = { async request() { calls++; throw Error('synthetic offline'); } };
  assert.deepEqual(await fetchStableRelease({ state: normalized, nowMs: NOW + HOUR - 1 }, transport), { deferred: 'THROTTLED' });
  assert.equal(calls, 0);
  assert.deepEqual(await fetchStableRelease({ state: normalized, nowMs: NOW + HOUR }, transport), { deferred: 'NETWORK' });
  assert.equal(calls, 1);
});

test('unknown events, fields and unsafe values fail without mutating input', () => {
  for (const event of [
    { type: 'unknown' }, { type: 'promote', extra: true },
    { type: 'manifest-seen', ref: { ...ref(2), release_id: '../outside' } },
    { type: 'check-finished', result: 'ok', nowMs: NaN },
    { type: 'check-finished', result: 'ok', nowMs: NOW, secret: 'never copied' },
    { type: 'check-finished', result: 'arbitrary', nowMs: NOW },
  ]) {
    const state = installed();
    assert.throws(() => api().transition(state, event), { code: 'STATE_TRANSITION' });
    assert.deepEqual(state, installed());
  }
});

test('read returns valid primary without inspecting backups or arbitrary version directories', async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, 'current.json'), encodeRelease(installed()));
  await fs.writeFile(path.join(root, 'current.previous.json'), 'corrupt backup');
  assert.deepEqual(await api().readInstallation(root), { state: installed(), recovered: false });
});

test('corrupt or missing primary uses only a validated backup', async t => {
  for (const primary of [undefined, 'corrupt', '{"schema":1,"schema":1}']) {
    const root = await directory(t);
    if (primary !== undefined) await fs.writeFile(path.join(root, 'current.json'), primary);
    await fs.writeFile(path.join(root, 'current.previous.json'), encodeRelease(installed()));
    assert.deepEqual(await api().readInstallation(root), { state: installed(), recovered: true });
  }
});

test('missing or corrupt-both states fail closed without guessing an installed version', async t => {
  const root = await directory(t);
  await assert.rejects(api().readInstallation(root), { code: 'STATE_MISSING' });
  await fs.mkdir(path.join(root, 'versions'));
  await fs.writeFile(path.join(root, 'current.json'), 'corrupt');
  await fs.writeFile(path.join(root, 'current.previous.json'), 'also corrupt');
  await assert.rejects(api().readInstallation(root), { code: 'STATE_RECOVERY' });
});

test('oversize state and I/O errors cannot become a blank fresh installation', async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, 'current.json'), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(api().readInstallation(root), { code: 'STATE_RECOVERY' });
  await assert.rejects(api().readInstallation(root, { async read() { throw Object.assign(Error('private path'), { code: 'EACCES' }); } }), { code: 'STATE_IO' });
});

test('commit validates bytes and owned paths before calling the lock-owning physical writer', async t => {
  const root = await directory(t), state = installed();
  const calls = [];
  const ports = { async commit(request) {
    calls.push(request);
    assert.equal(request.root, root);
    assert.equal(request.current, path.join(root, 'current.json'));
    assert.equal(request.backup, path.join(root, 'current.previous.json'));
    assert.deepEqual(JSON.parse(request.bytes.toString()), state);
  } };
  await api().commitState(root, state, ports);
  assert.equal(calls.length, 1);
  await assert.rejects(api().commitState(root, { ...state, current: { ...ref(1), release_id: '../escape' } }, ports), { code: 'STATE_SCHEMA' });
  assert.equal(calls.length, 1);
  await assert.rejects(api().commitState(root, state), { code: 'COORDINATOR_REQUIRED' });
  assert.equal((await fs.readdir(root)).length, 0);
});

test('junction roots cannot redirect state reads or commits into another directory', async t => {
  const root = await directory(t), outside = await directory(t);
  const link = path.join(root, 'redirect');
  await fs.symlink(outside, link, 'junction');
  await assert.rejects(api().readInstallation(link), { code: 'PATH' });
  await assert.rejects(api().commitState(link, installed(), { commit() { assert.fail('writer reached through junction'); } }), { code: 'PATH' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('relative installation roots are rejected before any read or commit port is reached', async () => {
  const ports = {
    read() { assert.fail('relative root reached reader'); },
    commit() { assert.fail('relative root reached writer'); },
  };
  await assert.rejects(api().readInstallation('relative-installation', ports), { code: 'PATH' });
  await assert.rejects(api().commitState('relative-installation', installed(), ports), { code: 'PATH' });
});

test('Windows coordinator proves physical locking and crash recovery in the normal updater suite', () => {
  const script = "& ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_COORDINATOR_TEST))) -NodePath $env:CODEXS_COORDINATOR_NODE; if (-not $?) { exit 1 }; exit 0";
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: path.resolve(__dirname, '../..'), windowsHide: true, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CODEXS_COORDINATOR_TEST: path.join(__dirname, 'coordinator.Tests.ps1'), CODEXS_COORDINATOR_NODE: process.execPath },
    });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Coordinator assertions: [1-9]\d* passed; 0 failed/);
});
