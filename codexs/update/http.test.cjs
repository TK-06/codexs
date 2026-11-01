'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { installationState } = require('../test-support/update-fixtures.cjs');

function api() { return require('./http.cjs'); }
const HOUR = 3600000;
const NOW = 1800000000000;
const LATEST = 'https://api.github.com/repos/TK-06/codexs/releases/latest';
const ASSETS = 'https://api.github.com/repos/TK-06/codexs/releases/assets/';
const payload = Buffer.from('synthetic archive');
const digest = createHash('sha256').update(payload).digest('hex');
function release(overrides = {}) {
  return {
    draft: false, prerelease: false,
    assets: [
      { name: 'release.json', id: 11, size: 2 },
      { name: 'release.sig', id: 12, size: 64 },
      { name: 'codexs-windows-x64.zip', id: 13, size: payload.length },
    ], ...overrides,
  };
}
function response(bytes, status = 200, headers = {}) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
  return { status, headers: { 'content-length': String(data.length), ...headers }, body: Readable.from([data]) };
}
function transport(responses) {
  const calls = [];
  return {
    calls,
    async request(url, options) {
      calls.push({ url, ...options });
      assert.equal(new URL(url).protocol, 'https:');
      const result = responses.shift();
      if (result instanceof Error) throw result;
      assert.ok(result, 'unexpected request');
      return typeof result === 'function' ? result(options) : result;
    },
  };
}
function validFeed(first = response(release())) {
  return transport([first, response('{}'), response(Buffer.alloc(64, 7))]);
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-http-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('codexs-http-test-'));
    fs.rmSync(dir, { recursive: true });
  });
  return path.join(dir, 'archive.zip');
}
function requestDownload(destination, overrides = {}) {
  return { assetId: 13, bytes: payload.length, sha256: digest, destination, ...overrides };
}
function clock() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { pending.set(++next, { fn, ms }); return next; },
    clearTimeout(id) { pending.delete(id); },
    pending,
    fire(ms) {
      const found = [...pending].find(([, timer]) => timer.ms === ms);
      assert.ok(found, `missing ${ms} ms timer`);
      pending.delete(found[0]); found[1].fn();
    },
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('feed uses only the fixed repository endpoint and exact asset IDs', async () => {
  const http = validFeed();
  const state = installationState();
  const before = structuredClone(state);
  const result = await api().fetchStableRelease({ state, nowMs: NOW }, http);
  assert.deepEqual(result, { manifestBytes: Buffer.from('{}'), signature: Buffer.alloc(64, 7), assetId: 13 });
  assert.deepEqual(http.calls.map(call => call.url), [LATEST, `${ASSETS}11`, `${ASSETS}12`]);
  assert.deepEqual(state, before);
  for (const call of http.calls) assert.equal(call.headers.authorization, undefined);
});

test('throttled, future-clock and recent-failure checks perform no network or state writes', async () => {
  for (const [updates, code] of [
    [{ last_check_ms: NOW - HOUR + 1 }, 'THROTTLED'],
    [{ last_check_ms: NOW - HOUR, next_check_ms: NOW + 1 }, 'THROTTLED'],
    [{ last_check_ms: NOW + HOUR, next_check_ms: NOW + 2 * HOUR }, 'CLOCK_ROLLBACK'],
    [{ next_check_ms: NOW + 7 * HOUR }, 'CLOCK_ROLLBACK'],
    [{ last_check_ms: NOW - 10, failures: 5 }, 'THROTTLED'],
  ]) {
    const state = { ...installationState(), ...updates };
    const before = structuredClone(state);
    const http = transport([]);
    assert.deepEqual(await api().fetchStableRelease({ state, nowMs: NOW }, http), { deferred: code });
    assert.deepEqual(http.calls, []);
    assert.deepEqual(state, before);
  }
  const normalized = { ...installationState(), last_check_ms: NOW, next_check_ms: NOW + HOUR };
  assert.equal((await api().fetchStableRelease({ state: normalized, nowMs: NOW + HOUR }, validFeed())).assetId, 13);
});

test('scheduling backs off hourly, caps retries and does not coerce invalid timestamps', () => {
  for (const [failures, hours] of [[0, 1], [1, 1], [2, 2], [3, 4], [4, 6], [999, 6]]) {
    assert.equal(api().nextCheck({ nowMs: NOW, failures }), NOW + hours * HOUR);
  }
  for (const [retryAfterMs, hours] of [[1, 1], [3 * HOUR, 3], [10 * HOUR, 6]]) {
    assert.equal(api().nextCheck({ nowMs: NOW, failures: 1, retryAfterMs }), NOW + hours * HOUR);
  }
  assert.equal(api().nextCheck({ nowMs: NOW, failures: 4, retryAfterMs: HOUR }), NOW + 6 * HOUR);
  for (const bad of [NaN, Infinity, -1, '1', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => api().nextCheck({ nowMs: bad, failures: 0 }), { code: 'SCHEDULE' });
  }
});

test('ETag is in-memory per transport and never placed in installation state or redirects', async () => {
  const first = response(release(), 200, { etag: '"synthetic-v1"' });
  const http = validFeed(first);
  await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, http);
  http.request = async (url, options) => {
    assert.equal(url, LATEST);
    assert.equal(options.headers['if-none-match'], '"synthetic-v1"');
    return response('', 304);
  };
  assert.deepEqual(await api().fetchStableRelease({ state: installationState(), nowMs: NOW + HOUR }, http), { unchanged: true });
  assert.deepEqual(await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, transport([response('', 304)])), { deferred: 'HTTP_STATUS' });
});

test('only exact complete asset names, safe numeric IDs and stable releases are accepted', async () => {
  for (const change of [
    { draft: true }, { prerelease: true }, { assets: [] },
    { assets: [...release().assets, release().assets[0]] },
    { assets: release().assets.map(a => a.id === 11 ? { ...a, name: 'Release.json' } : a) },
    { assets: release().assets.map(a => a.id === 13 ? { ...a, id: '../private' } : a) },
    { assets: release().assets.map(a => a.id === 12 ? { ...a, size: 65 } : a) },
  ]) {
    const http = transport([response(release(change))]);
    assert.deepEqual(await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, http), { deferred: 'FEED_SCHEMA' });
    assert.equal(http.calls.length, 1);
  }
});

test('manifest browser URLs and response-supplied credentials cannot change download origin', async () => {
  const data = release();
  data.assets.forEach(a => { a.url = 'https://evil.invalid/archive'; a.browser_download_url = 'file:///secret'; });
  const http = validFeed(response(data, 200, { authorization: 'secret' }));
  await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, http);
  assert.ok(http.calls.every(call => call.url.startsWith('https://api.github.com/repos/TK-06/codexs/')));
  assert.ok(http.calls.every(call => !Object.values(call.headers).includes('secret')));
});

test('metadata and sidecars are bounded even with absent or dishonest content lengths', async () => {
  for (const first of [
    response(Buffer.alloc(4 * 1024 * 1024 + 1), 200, { 'content-length': '2' }),
    response('{}', 200, { 'content-length': '4194305' }),
    response('{}', 200, { 'content-length': '100' }),
  ]) assert.deepEqual(await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, transport([first])), { deferred: 'HTTP_LENGTH' });
  for (const sidecars of [
    [response('{}'), response(Buffer.alloc(65))],
    [response('{}'), response(Buffer.alloc(63))],
    [response(Buffer.alloc(4 * 1024 * 1024 + 1)), response(Buffer.alloc(64))],
  ]) {
    const http = transport([response(release()), ...sidecars]);
    assert.deepEqual(await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, http), { deferred: 'HTTP_LENGTH' });
  }
  const chunked = response(release()); delete chunked.headers['content-length'];
  assert.equal((await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, validFeed(chunked))).assetId, 13);
});

test('offline, API errors and malformed JSON yield bounded codes without state changes', async () => {
  for (const [item, code] of [
    [new Error('private response / token'), 'NETWORK'],
    [response('private response', 403), 'RATE_LIMIT'],
    [response('', 429, { 'retry-after': 'invalid' }), 'RATE_LIMIT'],
    [response('', 500), 'HTTP_STATUS'],
    [response('not json'), 'FEED_SCHEMA'],
  ]) {
    const state = installationState(), before = structuredClone(state);
    assert.deepEqual(await api().fetchStableRelease({ state, nowMs: NOW }, transport([item])), { deferred: code });
    assert.deepEqual(state, before);
  }
});

test('rate-limit retry hints are bounded numeric scheduling data, never response text', async () => {
  for (const [value, expected] of [
    ['1', HOUR], ['10800', 3 * HOUR], ['999999', 6 * HOUR],
    [new Date(NOW + 4 * HOUR).toUTCString(), 4 * HOUR],
  ]) {
    const result = await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, transport([response('', 429, { 'retry-after': value })]));
    assert.deepEqual(result, { deferred: 'RATE_LIMIT', retryAfterMs: expected });
    assert.equal(api().nextCheck({ nowMs: NOW, failures: 1, retryAfterMs: result.retryAfterMs }), NOW + expected);
  }
});

test('redirects are bounded and never forward API headers', async () => {
  const http = transport([
    response('', 302, { location: 'https://github.com/TK-06/codexs/releases/download/test/release.json' }),
    response('', 302, { location: 'https://release-assets.githubusercontent.com/synthetic?token=test' }),
    response('{}'),
  ]);
  const feed = response(release());
  const manifestTransport = transport([feed, ...[]]);
  // Retain the same request port while routing the two fixed API sidecars.
  const redirected = http.request.bind(http);
  manifestTransport.request = async (url, opts) => {
    if (url === LATEST) return feed;
    if (url === `${ASSETS}12`) return response(Buffer.alloc(64, 7));
    return redirected(url, opts);
  };
  await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, manifestTransport);
  assert.equal(http.calls.length, 3);
  assert.equal(http.calls[0].headers.accept, 'application/octet-stream');
  for (const call of http.calls.slice(1)) {
    assert.equal(call.headers['if-none-match'], undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers.accept, undefined);
  }
});

test('unknown, credentialed, insecure and excessive redirects fail closed', async () => {
  for (const location of ['http://github.com/x', 'https://evil.invalid/x', 'https://api.github.com/repos/other/x', 'https://user:pass@github.com/x', 'https://github.com:444/x', 'file:///x']) {
    const result = await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, transport([response('', 302, { location })]));
    assert.deepEqual(result, { deferred: 'HTTP_REDIRECT' });
  }
  const http = transport(Array.from({ length: 4 }, () => response('', 302, { location: 'https://github.com/synthetic' })));
  assert.deepEqual(await api().fetchStableRelease({ state: installationState(), nowMs: NOW }, http), { deferred: 'HTTP_REDIRECT' });
  assert.equal(http.calls.length, 4);
});

test('metadata request and stalled body obey the ten-second total deadline', async () => {
  for (const item of [() => new Promise(() => {}), () => ({ status: 200, headers: {}, body: new Readable({ read() {} }) })]) {
    const timers = clock(), http = transport([item]); http.timers = timers;
    const pending = api().fetchStableRelease({ state: installationState(), nowMs: NOW }, http);
    await turn(); timers.fire(10000);
    assert.deepEqual(await pending, { deferred: 'HTTP_TIMEOUT' });
    assert.equal(http.calls[0].signal.aborted, true);
    assert.equal(timers.pending.size, 0);
  }
});

test('download streams exact bytes to a new destination and verifies its digest', async t => {
  const destination = temp(t);
  const http = transport([{ status: 200, headers: { 'content-length': String(payload.length) }, body: Readable.from([payload.subarray(0, 3), payload.subarray(3)]) }]);
  await api().downloadAsset(requestDownload(destination), http);
  assert.deepEqual(fs.readFileSync(destination), payload);
  assert.equal(http.calls[0].url, `${ASSETS}13`);
  assert.equal(http.calls[0].signal.aborted, false);
});

test('archive requests reject untrusted identity, length, hash and existing files', async t => {
  const destination = temp(t);
  for (const bad of [{ assetId: '../escape' }, { assetId: '13' }, { bytes: 268435457 }, { sha256: 'bad' }, { destination: 'relative.zip' }]) {
    const http = transport([]);
    await assert.rejects(api().downloadAsset(requestDownload(destination, bad), http), { code: 'DOWNLOAD_INPUT' });
    assert.equal(http.calls.length, 0);
  }
  fs.writeFileSync(destination, 'sentinel');
  await assert.rejects(api().downloadAsset(requestDownload(destination), transport([response(payload)])), { code: 'DOWNLOAD_FILE' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'sentinel');
});

test('missing, mismatched, truncated and excess archive lengths never complete', async t => {
  for (const [i, res] of [
    response(payload, 200, { 'content-length': undefined }),
    response(payload, 200, { 'content-length': '1' }),
    response(payload.subarray(0, 3), 200, { 'content-length': String(payload.length) }),
    response(Buffer.concat([payload, Buffer.from('extra')]), 200, { 'content-length': String(payload.length) }),
  ].entries()) {
    await assert.rejects(api().downloadAsset(requestDownload(`${temp(t)}-${i}`), transport([res])), { code: 'HTTP_LENGTH' });
  }
});

test('archive hash failure and aborted streams leave only an unaccepted private partial', async t => {
  const destination = temp(t);
  await assert.rejects(api().downloadAsset(requestDownload(destination, { sha256: '0'.repeat(64) }), transport([response(payload)])), { code: 'DOWNLOAD_HASH' });
  const interrupted = new Readable({ read() { this.push(payload.subarray(0, 2)); this.destroy(Error('sensitive transport detail')); } });
  await assert.rejects(api().downloadAsset(requestDownload(`${destination}.partial`), transport([{ status: 200, headers: { 'content-length': String(payload.length) }, body: interrupted }])), { code: 'NETWORK' });
  assert.equal(fs.existsSync(`${destination}.ready`), false);
});

test('archive inactivity and total deadline abort and release all timers', async t => {
  for (const timeout of [30000, 600000]) {
    const timers = clock();
    const body = new Readable({ read() {} });
    const http = transport([{ status: 200, headers: { 'content-length': String(payload.length) }, body }]);
    http.timers = timers;
    const pending = api().downloadAsset(requestDownload(temp(t)), http);
    await turn(); timers.fire(timeout);
    await assert.rejects(pending, { code: 'HTTP_TIMEOUT' });
    assert.equal(http.calls[0].signal.aborted, true);
    assert.equal(body.destroyed, true);
    assert.equal(timers.pending.size, 0);
  }
});
