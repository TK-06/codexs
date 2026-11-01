'use strict';

const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { UpdateError, encodeRelease, parseState } = require('./protocol.cjs');

const LATEST = 'https://api.github.com/repos/TK-06/codexs/releases/latest';
const ASSETS = 'https://api.github.com/repos/TK-06/codexs/releases/assets/';
const MAX_METADATA = 4 * 1024 * 1024;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const HOUR = 3600000;
const cache = new WeakMap();
const production = {
  request(url, { headers, signal }) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { headers, signal, agent: false, maxHeaderSize: 16384 }, response => {
        resolve({ status: response.statusCode, headers: response.headers, body: response });
      });
      request.once('error', reject);
    });
  },
};

function fail(code) { throw new UpdateError(code); }
function safeInt(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function bounded(error) { return error instanceof UpdateError ? error : new UpdateError('NETWORK'); }

function nextCheck({ nowMs, failures, retryAfterMs }) {
  if (!safeInt(nowMs, 0, Number.MAX_SAFE_INTEGER - 6 * HOUR) || !safeInt(failures, 0, Number.MAX_SAFE_INTEGER)) fail('SCHEDULE');
  const hours = failures <= 1 ? 1 : failures === 2 ? 2 : failures === 3 ? 4 : 6;
  const retry = safeInt(retryAfterMs, 0, Number.MAX_SAFE_INTEGER) ? Math.min(6 * HOUR, Math.max(HOUR, retryAfterMs)) : 0;
  return nowMs + Math.max(hours * HOUR, retry);
}

async function timed(transport, totalMs, inactivityMs, work) {
  const timers = transport.timers || { setTimeout, clearTimeout };
  const controller = new AbortController();
  let body, idle, expired;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  // Keep rejection handled even if a timeout lands between two awaited I/O operations.
  timeout.catch(() => {});
  function expire() {
    if (expired) return;
    expired = new UpdateError('HTTP_TIMEOUT');
    rejectTimeout(expired);
    controller.abort();
    body?.destroy?.();
  }
  const total = timers.setTimeout(expire, totalMs);
  function touch() {
    if (idle !== undefined) timers.clearTimeout(idle);
    if (inactivityMs) idle = timers.setTimeout(expire, inactivityMs);
  }
  touch();
  const context = {
    signal: controller.signal,
    touch,
    bind(value) { body = value; },
    check() { if (expired) throw expired; },
    async wait(promise) {
      // An abort can race with creating the next stream promise. Observe that promise
      // even when the deadline has already expired, so its close error is handled.
      const observed = Promise.resolve(promise);
      if (expired) { observed.catch(() => {}); throw expired; }
      return Promise.race([observed, timeout]);
    },
  };
  try {
    const result = await work(context);
    context.check();
    return result;
  } catch (error) {
    controller.abort();
    body?.destroy?.();
    throw bounded(error);
  } finally {
    timers.clearTimeout(total);
    if (idle !== undefined) timers.clearTimeout(idle);
  }
}

function header(response, name) {
  const value = response.headers?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) fail('HTTP_HEADERS');
  return value;
}

async function request(transport, url, headers, context) {
  for (let redirects = 0; ; redirects++) {
    const response = await context.wait(transport.request(url, { headers: { ...headers }, signal: context.signal }));
    if (!response || !safeInt(response.status, 100, 599) || !response.body?.[Symbol.asyncIterator]) fail('HTTP_STATUS');
    context.bind(response.body);
    context.touch();
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    response.body.destroy?.();
    if (redirects >= 3) fail('HTTP_REDIRECT');
    let next;
    try { next = new URL(header(response, 'location')); } catch { fail('HTTP_REDIRECT'); }
    if (next.protocol !== 'https:' || next.username || next.password || next.port ||
        !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname) || next.hash) fail('HTTP_REDIRECT');
    url = next.href;
    // Redirect hosts receive no API, conditional, authentication or server-provided headers.
    headers = { 'user-agent': 'codexs-updater/1' };
  }
}

function contentLength(response, max, required) {
  if (header(response, 'content-encoding') && header(response, 'content-encoding') !== 'identity') fail('HTTP_LENGTH');
  const value = header(response, 'content-length');
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) fail('HTTP_LENGTH');
  const bytes = Number(value);
  if (!safeInt(bytes, 0, max)) fail('HTTP_LENGTH');
  return bytes;
}

function requireSuccess(response, nowMs) {
  if (response.status === 403 || response.status === 429) {
    const error = new UpdateError('RATE_LIMIT');
    const retry = header(response, 'retry-after');
    let delay;
    if (retry && /^\d{1,12}$/.test(retry)) delay = Number(retry) * 1000;
    else if (retry && typeof nowMs === 'number' && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)) delay = Date.parse(retry) - nowMs;
    if (Number.isSafeInteger(delay)) error.retryAfterMs = Math.min(6 * HOUR, Math.max(HOUR, delay));
    throw error;
  }
  if (response.status !== 200) fail('HTTP_STATUS');
}

async function* chunks(response, context) {
  const iterator = response.body[Symbol.asyncIterator]();
  while (true) {
    const result = await context.wait(iterator.next());
    if (result.done) return;
    if (!Buffer.isBuffer(result.value) && !(result.value instanceof Uint8Array)) fail('NETWORK');
    context.touch();
    yield Buffer.from(result.value);
  }
}

async function buffer(response, max, context, exact) {
  requireSuccess(response, context.nowMs);
  const declared = contentLength(response, max, false);
  if (exact !== undefined && declared !== null && declared !== exact) fail('HTTP_LENGTH');
  const parts = [];
  let size = 0;
  for await (const chunk of chunks(response, context)) {
    size += chunk.length;
    if (size > max || (declared !== null && size > declared)) fail('HTTP_LENGTH');
    parts.push(chunk);
  }
  if ((declared !== null && size !== declared) || (exact !== undefined && size !== exact)) fail('HTTP_LENGTH');
  return Buffer.concat(parts, size);
}

function assetsFrom(bytes) {
  let release;
  try { release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('FEED_SCHEMA'); }
  if (!release || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets) || release.assets.length > 100) fail('FEED_SCHEMA');
  const assets = {};
  const specs = { 'release.json': [1, MAX_METADATA], 'release.sig': [64, 64], 'codexs-windows-x64.zip': [1, MAX_ARCHIVE] };
  const ids = new Set();
  for (const [name, [min, max]] of Object.entries(specs)) {
    const matches = release.assets.filter(asset => asset && asset.name === name);
    if (matches.length !== 1) fail('FEED_SCHEMA');
    const asset = matches[0];
    if (!safeInt(asset.id, 1, Number.MAX_SAFE_INTEGER) || !safeInt(asset.size, min, max) || ids.has(asset.id)) fail('FEED_SCHEMA');
    ids.add(asset.id);
    assets[name] = asset;
  }
  return assets;
}

async function fetchStableRelease({ state, nowMs }, transport = production) {
  try {
    parseState(encodeRelease(state));
    nextCheck({ nowMs, failures: state.failures });
    // Task 6 persists this normalization once under the coordinator lock. This reader never mutates state.
    if (state.last_check_ms > nowMs || state.next_check_ms > nowMs + 6 * HOUR) return { deferred: 'CLOCK_ROLLBACK' };
    if (state.next_check_ms > nowMs || (state.last_check_ms !== 0 && nowMs - state.last_check_ms < HOUR)) return { deferred: 'THROTTLED' };
    return await timed(transport, 10000, 0, async context => {
      context.nowMs = nowMs;
      const headers = { accept: 'application/vnd.github+json', 'user-agent': 'codexs-updater/1', 'x-github-api-version': '2022-11-28' };
      const previous = cache.get(transport);
      if (previous) headers['if-none-match'] = previous;
      const response = await request(transport, LATEST, headers, context);
      if (response.status === 304) {
        response.body.destroy?.();
        if (!previous) fail('HTTP_STATUS');
        return { unchanged: true };
      }
      const metadata = await buffer(response, MAX_METADATA, context);
      const assets = assetsFrom(metadata);
      const assetHeaders = { accept: 'application/octet-stream', 'user-agent': 'codexs-updater/1', 'x-github-api-version': '2022-11-28' };
      const manifestBytes = await buffer(await request(transport, `${ASSETS}${assets['release.json'].id}`, assetHeaders, context), MAX_METADATA, context, assets['release.json'].size);
      const signature = await buffer(await request(transport, `${ASSETS}${assets['release.sig'].id}`, assetHeaders, context), 64, context, 64);
      const etag = header(response, 'etag');
      if (etag && etag.length <= 1024) cache.set(transport, etag);
      else cache.delete(transport);
      return { manifestBytes, signature, assetId: assets['codexs-windows-x64.zip'].id };
    });
  } catch (error) {
    const reason = bounded(error);
    return { deferred: reason.code, ...(reason.retryAfterMs === undefined ? {} : { retryAfterMs: reason.retryAfterMs }) };
  }
}

async function downloadAsset({ assetId, bytes, sha256, destination }, transport = production) {
  if (!safeInt(assetId, 1, Number.MAX_SAFE_INTEGER) || !safeInt(bytes, 1, MAX_ARCHIVE) ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || typeof destination !== 'string' || !path.isAbsolute(destination)) fail('DOWNLOAD_INPUT');
  return timed(transport, 600000, 30000, async context => {
    const response = await request(transport, `${ASSETS}${assetId}`, { accept: 'application/octet-stream', 'user-agent': 'codexs-updater/1', 'x-github-api-version': '2022-11-28' }, context);
    requireSuccess(response);
    if (contentLength(response, MAX_ARCHIVE, true) !== bytes) fail('HTTP_LENGTH');
    let file;
    try { file = await fs.open(destination, 'wx'); } catch { fail('DOWNLOAD_FILE'); }
    // The caller supplies a validated owned-stage path; existing files are never replaced.
    try {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of chunks(response, context)) {
        size += chunk.length;
        if (size > bytes) fail('HTTP_LENGTH');
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          context.check();
          const result = await file.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten === 0) fail('DOWNLOAD_FILE');
          offset += result.bytesWritten;
        }
      }
      if (size !== bytes) fail('HTTP_LENGTH');
      if (hash.digest('hex') !== sha256) fail('DOWNLOAD_HASH');
      await file.sync();
      context.check();
    } finally { await file.close(); }
  });
}

module.exports = { fetchStableRelease, downloadAsset, nextCheck };
