'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { generateKeyPairSync, sign } = require('node:crypto');
const { releaseManifest, installationState } = require('../test-support/update-fixtures.cjs');

const keys = generateKeyPairSync('ed25519');
const policy = { repository: 'TK-06/codexs', channel: 'stable', target: 'x86_64-pc-windows-msvc', bootstrap: 1, nodeMajor: 24 };

function api() {
  let result;
  assert.doesNotThrow(() => { result = require('./protocol.cjs'); }, 'signed release protocol must exist');
  return result;
}

function signature(bytes, prefix = 'codexs-release-v1\0') {
  return sign(null, Buffer.concat([Buffer.from(prefix, 'utf8'), bytes]), keys.privateKey);
}

function verify(release, overrides = {}) {
  const bytes = api().encodeRelease(release);
  return api().verifyRelease(bytes, signature(bytes), keys.publicKey, { ...policy, ...overrides });
}

test('verifies an authentic Ed25519 release and exact source identities', () => {
  const release = releaseManifest();
  assert.deepEqual(verify(release), release);
});

test('canonical encoding sorts nested keys and emits no BOM or newline', () => {
  assert.equal(api().encodeRelease({ z: [2, { b: 1, a: 0 }], a: true }).toString(), '{"a":true,"z":[2,{"a":0,"b":1}]}');
});

test('changed bytes cannot retain the original signature', () => {
  const bytes = api().encodeRelease(releaseManifest());
  const changed = Buffer.from(bytes.toString().replace('0.166.0', '0.165.0'));
  assert.throws(() => api().verifyRelease(changed, signature(bytes), keys.publicKey, policy), { code: 'SIGNATURE' });
});

test('a different signing key cannot authenticate the publisher', () => {
  const bytes = api().encodeRelease(releaseManifest());
  assert.throws(() => api().verifyRelease(bytes, signature(bytes), generateKeyPairSync('ed25519').publicKey, policy), { code: 'SIGNATURE' });
});

test('signature prefix prevents reuse from another protocol', () => {
  const bytes = api().encodeRelease(releaseManifest());
  assert.throws(() => api().verifyRelease(bytes, signature(bytes, 'different-protocol\0'), keys.publicKey, policy), { code: 'SIGNATURE' });
});

test('signature and manifest sizes are bounded before interpretation', () => {
  const bytes = api().encodeRelease(releaseManifest());
  assert.throws(() => api().verifyRelease(bytes, Buffer.alloc(65), keys.publicKey, policy), { code: 'SIGNATURE' });
  assert.throws(() => api().verifyRelease(Buffer.alloc(4 * 1024 * 1024 + 1), Buffer.alloc(64), keys.publicKey, policy), { code: 'MANIFEST_SCHEMA' });
});

test('signed duplicate, escaped duplicate and nested duplicate keys are rejected', () => {
  for (const raw of ['{"schema":1,"schema":1}', '{"schema":1,"\\u0073chema":1}', '{"x":{"a":1,"a":2}}']) {
    const bytes = Buffer.from(raw);
    assert.throws(() => api().verifyRelease(bytes, signature(bytes), keys.publicKey, policy), { code: 'MANIFEST_SCHEMA' });
  }
});

test('signed noncanonical JSON, BOM and invalid UTF8 are rejected', () => {
  const canonical = api().encodeRelease(releaseManifest());
  for (const bytes of [Buffer.concat([canonical, Buffer.from('\n')]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]), Buffer.from('{ "schema":1}'), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => api().verifyRelease(bytes, signature(bytes), keys.publicKey, policy), { code: 'MANIFEST_SCHEMA' });
  }
});

test('top-level and nested unknown fields cannot alter the release contract', () => {
  for (const mutate of [r => { r.command = 'synthetic-untrusted-command'; }, r => { r.upstream.branch = 'main'; }, r => { r.archive.url = 'https://invalid.example/'; }, r => { r.files[0].execute = true; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('repository, channel and target policy cannot be changed by a signed payload', () => {
  for (const [key, value] of [['repository', 'different/publisher'], ['channel', 'nightly'], ['target', 'aarch64-pc-windows-msvc']]) {
    const release = releaseManifest(); release[key] = value;
    assert.throws(() => verify(release), { code: 'RELEASE_POLICY' });
  }
});

test('bootstrap and Node prerequisites cannot be bypassed', () => {
  const newer = releaseManifest(); newer.bootstrap_min = 2;
  assert.throws(() => verify(newer), { code: 'COMPATIBILITY' });
  assert.throws(() => verify(releaseManifest(), { nodeMajor: 21 }), { code: 'COMPATIBILITY' });
});

test('malformed stable versions, source SHAs and release IDs are rejected', () => {
  for (const mutate of [r => { r.product_version = '01.0.0'; }, r => { r.upstream.version = '0.166.0-alpha'; }, r => { r.upstream.sha = 'main'; }, r => { r.upstream.tag = 'rust-v0.165.0'; }, r => { r.release_id = '../escape'; }, r => { r.overlay_sha = 'Z'.repeat(40); }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('fractional and unsafe release sequences are rejected', () => {
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const release = releaseManifest(); release.sequence = sequence;
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('archive limits and hashes cannot describe an unbounded payload', () => {
  for (const mutate of [r => { r.archive.bytes = 256 * 1024 * 1024 + 1; }, r => { r.archive.sha256 = 'short'; }, r => { r.archive.name = '../bundle.zip'; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('file inventory rejects duplicates, traversal, unsorted paths and excessive size', () => {
  for (const mutate of [r => { r.files.push({ ...r.files[0] }); }, r => { r.files[0].path = '../escape'; }, r => { r.files.reverse(); }, r => { r.files[0].bytes = 2 * 1024 ** 3 + 1; }, r => { r.files[0].path = 'release.json'; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('helper package must match the native version and platform alias', () => {
  for (const mutate of [r => { r.packages.helper.version = '0.165.0-win32-x64'; }, r => { r.packages.main.name = 'unrelated'; }, r => { r.packages.main.integrity = 'sha512-short'; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('all required suites must be present, nonempty and successful', () => {
  for (const mutate of [r => { delete r.evidence.suites.full; }, r => { r.evidence.suites.full.passed = 0; }, r => { r.evidence.suites.full.failed = 1; }, r => { r.evidence.suites.full.exit = 101; }, r => { r.evidence.build_exit = 1; }, r => { r.evidence.runs = []; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('native, upstream and formatter evidence must match manifest identities', () => {
  for (const field of ['candidate_sha', 'upstream_sha', 'formatter_sha']) {
    const release = releaseManifest(); release.evidence[field] = 'f'.repeat(40);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('missing and malformed run/artifact references cannot certify a suite', () => {
  for (const mutate of [r => { r.evidence.runs[0].job = 0; }, r => { r.evidence.runs[0].artifact = 'moving-name'; }, r => { r.evidence.runs[0].attempt = 1.5; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('state parses valid empty installation bookkeeping without losing fields', () => {
  const state = installationState();
  assert.deepEqual(api().parseState(Buffer.from(JSON.stringify(state))), state);
});

test('state rejects duplicate keys even when whitespace is otherwise permitted', () => {
  assert.throws(() => api().parseState(Buffer.from('{"schema":1, "\\u0073chema":1}')), { code: 'STATE_SCHEMA' });
});

test('state cannot contain path-based pointers or unsafe counters', () => {
  for (const mutate of [s => { s.current = { release_id: '../escape', sequence: 1, manifest_sha256: '1'.repeat(64) }; }, s => { s.failures = -1; }, s => { s.highest = { sequence: Number.MAX_SAFE_INTEGER + 1, manifest_sha256: '1'.repeat(64) }; }, s => { s.extra = true; }]) {
    const state = installationState(); mutate(state);
    assert.throws(() => api().parseState(Buffer.from(JSON.stringify(state))), { code: 'STATE_SCHEMA' });
  }
});

test('a release older than the highest verified sequence is rejected', () => {
  const state = installationState(); state.highest = { sequence: 2, manifest_sha256: '1'.repeat(64) };
  assert.throws(() => api().assertFresh(releaseManifest(1), '1'.repeat(64), state), { code: 'REPLAY' });
});

test('equal sequence and different content is rejected', () => {
  const state = installationState(); state.highest = { sequence: 1, manifest_sha256: '1'.repeat(64) };
  assert.throws(() => api().assertFresh(releaseManifest(), '2'.repeat(64), state), { code: 'REPLAY' });
});

test('same digest can retry while a newer sequence can advance', () => {
  const state = installationState(); state.highest = { sequence: 1, manifest_sha256: '1'.repeat(64) };
  assert.doesNotThrow(() => api().assertFresh(releaseManifest(), '1'.repeat(64), state));
  assert.doesNotThrow(() => api().assertFresh(releaseManifest(2), '2'.repeat(64), state));
});

test('a rejected release is suppressed despite having an authentic manifest', () => {
  const state = installationState(); state.highest = { sequence: 1, manifest_sha256: '1'.repeat(64) }; state.rejected = [releaseManifest().release_id];
  assert.throws(() => api().assertFresh(releaseManifest(), '1'.repeat(64), state), { code: 'REJECTED_RELEASE' });
});

test('digest and overlay identities must be strings rather than coercible arrays', () => {
  for (const mutate of [r => { r.overlay_sha = [r.overlay_sha]; }, r => { r.archive.sha256 = [r.archive.sha256]; }, r => { r.files[0].sha256 = [r.files[0].sha256]; }]) {
    const release = releaseManifest(); mutate(release);
    assert.throws(() => verify(release), { code: 'MANIFEST_SCHEMA' });
  }
});

test('state digests reject coercible array values', () => {
  const state = installationState();
  state.highest = { sequence: 1, manifest_sha256: ['1'.repeat(64)] };
  assert.throws(() => api().parseState(Buffer.from(JSON.stringify(state))), { code: 'STATE_SCHEMA' });
});
