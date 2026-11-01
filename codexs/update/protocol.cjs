'use strict';

const { verify, createPublicKey, KeyObject } = require('node:crypto');
const { TextDecoder } = require('node:util');

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PREFIX = Buffer.from('codexs-release-v1\0', 'utf8');
const MAX_JSON = 4 * 1024 * 1024;
const SUITES = ['quick', 'feature', 'full', 'config', 'formatter', 'updater', 'installer', 'bundle'];

class UpdateError extends Error {
  constructor(code) {
    const bounded = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UPDATE_ERROR';
    super(`Codexs update rejected: ${bounded}`);
    this.name = 'UpdateError';
    this.code = bounded;
  }
}

function fail(code) { throw new UpdateError(code); }

function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }

function object(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(code);
}

function integer(value, min, max, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(code);
}

function stable(value, code) {
  if (typeof value !== 'string' || !VERSION.test(value) || !value.split('.').every(part => Number.isSafeInteger(Number(part)))) fail(code);
}

function canonical(value, seen, depth) {
  if (depth > 64) fail('MANIFEST_SCHEMA');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    integer(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'MANIFEST_SCHEMA');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) fail('MANIFEST_SCHEMA');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('MANIFEST_SCHEMA');
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => canonical(item, seen, depth + 1)) : Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key], seen, depth + 1)]),
  );
  seen.delete(value);
  return result;
}

function encodeRelease(release) {
  try {
    const bytes = Buffer.from(JSON.stringify(canonical(release, new Set(), 0)), 'utf8');
    if (bytes.length === 0 || bytes.length > MAX_JSON) fail('MANIFEST_SCHEMA');
    return bytes;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    fail('MANIFEST_SCHEMA');
  }
}

function parseUnique(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_JSON ||
      bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail(code);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Tokenize quoted strings as units: punctuation within a string is never structural.
    const stack = [];
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
      const token = match[0];
      if (token === '{' || token === '[') {
        stack.push({ object: token === '{', needKey: true, keys: new Set() });
        if (stack.length > 64) fail(code);
      } else if (token === '}' || token === ']') {
        const last = stack.pop();
        if (!last || last.object !== (token === '}')) fail(code);
      } else if (token === ',') {
        if (stack.at(-1)?.object) stack.at(-1).needKey = true;
      } else if (token.startsWith('"') && stack.at(-1)?.object && stack.at(-1).needKey) {
        const key = JSON.parse(token);
        if (stack.at(-1).keys.has(key)) fail(code);
        stack.at(-1).keys.add(key);
        stack.at(-1).needKey = false;
      }
    }
    if (stack.length) fail(code);
    return JSON.parse(text);
  } catch { fail(code); }
}

function integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) fail('MANIFEST_SCHEMA');
  const encoded = value.slice(7);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) fail('MANIFEST_SCHEMA');
}

function validateEvidence(evidence, release) {
  const code = 'MANIFEST_SCHEMA';
  object(evidence, ['candidate_sha', 'upstream_sha', 'formatter_sha', 'runs', 'suites', 'build_exit'], code);
  if (evidence.candidate_sha !== release.native_sha || evidence.upstream_sha !== release.upstream.sha || evidence.formatter_sha !== release.formatter.sha || evidence.build_exit !== 0) fail(code);
  object(evidence.suites, SUITES, code);
  for (const name of SUITES) {
    const suite = evidence.suites[name];
    object(suite, ['passed', 'failed', 'ignored', 'exit'], code);
    integer(suite.passed, 1, Number.MAX_SAFE_INTEGER, code);
    integer(suite.ignored, 0, Number.MAX_SAFE_INTEGER, code);
    if (suite.failed !== 0 || suite.exit !== 0) fail(code);
  }
  if (!Array.isArray(evidence.runs) || evidence.runs.length === 0 || evidence.runs.length > 1000) fail(code);
  const identities = new Set();
  for (const run of evidence.runs) {
    object(run, ['repository', 'run', 'attempt', 'job', 'artifact'], code);
    if (typeof run.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(run.repository)) fail(code);
    for (const field of ['run', 'attempt', 'job', 'artifact']) integer(run[field], 1, Number.MAX_SAFE_INTEGER, code);
    const identity = `${run.repository}/${run.run}/${run.attempt}/${run.job}/${run.artifact}`;
    if (identities.has(identity)) fail(code);
    identities.add(identity);
  }
}

function validateRelease(release, policy = {}) {
  const code = 'MANIFEST_SCHEMA';
  object(release, ['schema', 'repository', 'channel', 'sequence', 'release_id', 'product_version', 'upstream', 'native_sha', 'overlay_sha', 'formatter', 'target', 'bootstrap_min', 'node_min', 'archive', 'files', 'packages', 'evidence'], code);
  if (release.schema !== 1) fail(code);
  integer(release.sequence, 1, Number.MAX_SAFE_INTEGER, code);
  stable(release.product_version, code);
  object(release.upstream, ['version', 'tag', 'sha'], code);
  stable(release.upstream.version, code);
  if (release.upstream.tag !== `rust-v${release.upstream.version}` || !matches(release.upstream.sha, SHA) || !matches(release.native_sha, SHA) || !matches(release.overlay_sha, SHA)) fail(code);
  object(release.formatter, ['sha', 'version'], code);
  stable(release.formatter.version, code);
  if (!matches(release.formatter.sha, SHA) || release.release_id !== `codexs-v${release.product_version}-codex${release.upstream.version}-r${release.sequence}`) fail(code);
  const expected = { repository: 'TK-06/codexs', channel: 'stable', target: 'x86_64-pc-windows-msvc', bootstrap: 1, nodeMajor: Number(process.versions.node.split('.')[0]), ...policy };
  if (release.repository !== expected.repository || release.channel !== expected.channel || release.target !== expected.target) fail('RELEASE_POLICY');
  integer(release.bootstrap_min, 1, Number.MAX_SAFE_INTEGER, code);
  integer(release.node_min, 22, Number.MAX_SAFE_INTEGER, code);
  if (!Number.isSafeInteger(expected.bootstrap) || !Number.isSafeInteger(expected.nodeMajor) || release.bootstrap_min > expected.bootstrap || release.node_min > expected.nodeMajor) fail('COMPATIBILITY');
  object(release.archive, ['name', 'bytes', 'sha256'], code);
  if (release.archive.name !== 'codexs-windows-x64.zip' || !matches(release.archive.sha256, HASH)) fail(code);
  integer(release.archive.bytes, 1, 256 * 1024 * 1024, code);
  if (!Array.isArray(release.files) || release.files.length === 0 || release.files.length > 10000) fail(code);
  let previous = null;
  let total = 0;
  const names = new Set();
  for (const file of release.files) {
    object(file, ['path', 'bytes', 'sha256'], code);
    if (typeof file.path !== 'string' || file.path.length === 0 || file.path.length > 1024 ||
        /[\\:\x00-\x1f]/.test(file.path) || file.path.split('/').some(part => part === '' || part === '.' || part === '..') ||
        ['release.json', 'release.sig', release.archive.name].includes(file.path.toLowerCase()) || !matches(file.sha256, HASH)) fail(code);
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(file.path)) >= 0) fail(code);
    if (names.has(file.path.toLowerCase())) fail(code);
    names.add(file.path.toLowerCase());
    previous = file.path;
    integer(file.bytes, 0, 2 * 1024 ** 3, code);
    total += file.bytes;
    if (total > 2 * 1024 ** 3) fail(code);
  }
  object(release.packages, ['main', 'helper'], code);
  for (const name of ['main', 'helper']) {
    object(release.packages[name], ['name', 'version', 'integrity'], code);
    if (release.packages[name].name !== '@openai/codex') fail(code);
    integrity(release.packages[name].integrity);
  }
  if (release.packages.main.version !== release.upstream.version || release.packages.helper.version !== `${release.upstream.version}-win32-x64`) fail(code);
  validateEvidence(release.evidence, release);
}

function verifyRelease(bytes, signature, key, policy) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_JSON) fail('MANIFEST_SCHEMA');
  if (!Buffer.isBuffer(signature) || signature.length !== 64) fail('SIGNATURE');
  try {
    const publicKey = key instanceof KeyObject ? key : createPublicKey(key);
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.concat([PREFIX, bytes]), publicKey, signature)) fail('SIGNATURE');
  } catch { fail('SIGNATURE'); }
  const release = parseUnique(bytes, 'MANIFEST_SCHEMA');
  if (!encodeRelease(release).equals(bytes)) fail('MANIFEST_SCHEMA');
  validateRelease(release, policy);
  return release;
}

function releaseSequence(id, code) {
  if (typeof id !== 'string' || id.length > 200) fail(code);
  const match = id.match(/^codexs-v([0-9.]+)-codex([0-9.]+)-r([1-9]\d*)$/);
  if (!match) fail(code);
  stable(match[1], code);
  stable(match[2], code);
  const sequence = Number(match[3]);
  integer(sequence, 1, Number.MAX_SAFE_INTEGER, code);
  return sequence;
}

function validateState(state) {
  const code = 'STATE_SCHEMA';
  object(state, ['schema', 'current', 'previous', 'ready', 'highest', 'rejected', 'last_check_ms', 'next_check_ms', 'failures'], code);
  if (state.schema !== 1) fail(code);
  for (const field of ['last_check_ms', 'next_check_ms', 'failures']) integer(state[field], 0, Number.MAX_SAFE_INTEGER, code);
  if (state.highest !== null) {
    object(state.highest, ['sequence', 'manifest_sha256'], code);
    integer(state.highest.sequence, 1, Number.MAX_SAFE_INTEGER, code);
    if (!matches(state.highest.manifest_sha256, HASH)) fail(code);
  }
  for (const name of ['current', 'previous', 'ready']) {
    const ref = state[name];
    if (ref === null) continue;
    object(ref, ['release_id', 'sequence', 'manifest_sha256'], code);
    if (releaseSequence(ref.release_id, code) !== ref.sequence || !matches(ref.manifest_sha256, HASH) ||
        state.highest === null || ref.sequence > state.highest.sequence ||
        (ref.sequence === state.highest.sequence && ref.manifest_sha256 !== state.highest.manifest_sha256)) fail(code);
  }
  if (!Array.isArray(state.rejected) || state.rejected.length > 10000 || new Set(state.rejected).size !== state.rejected.length) fail(code);
  for (const id of state.rejected) {
    if (state.highest === null || releaseSequence(id, code) > state.highest.sequence) fail(code);
  }
}

function parseState(bytes) {
  const state = parseUnique(bytes, 'STATE_SCHEMA');
  validateState(state);
  return state;
}

function assertFresh(release, manifestHash, state) {
  validateRelease(release);
  validateState(state);
  if (!matches(manifestHash, HASH)) fail('REPLAY');
  if (state.rejected.includes(release.release_id)) fail('REJECTED_RELEASE');
  if (state.highest && (release.sequence < state.highest.sequence ||
      (release.sequence === state.highest.sequence && manifestHash !== state.highest.manifest_sha256))) fail('REPLAY');
}

module.exports = { UpdateError, encodeRelease, verifyRelease, assertFresh, parseState };
