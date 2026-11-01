'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { UpdateError, encodeRelease, parseState } = require('./protocol.cjs');
const { resolveOwned } = require('./paths.cjs');
const { nextCheck } = require('./http.cjs');
const MAX_STATE = 4 * 1024 * 1024;
const HOUR = 3600000;

function fail(code) { throw new UpdateError(code); }
function same(a, b) { return a !== null && b !== null && a.release_id === b.release_id && a.sequence === b.sequence && a.manifest_sha256 === b.manifest_sha256; }
function validate(value) { return parseState(encodeRelease(value)); }
function fields(event, required, optional = []) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !required.every(key => Object.hasOwn(event, key)) ||
      Object.keys(event).some(key => ![...required, ...optional].includes(key))) fail('STATE_TRANSITION');
}
function validateRef(ref) {
  if (!ref || typeof ref !== 'object') fail('STATE_TRANSITION');
  const state = {
    schema: 1, current: ref, previous: null, ready: null,
    highest: { sequence: ref.sequence, manifest_sha256: ref.manifest_sha256 },
    rejected: [], last_check_ms: 0, next_check_ms: 0, failures: 0,
  };
  validate(state);
}
function fresh(state, ref, exact) {
  validateRef(ref);
  if (state.rejected.includes(ref.release_id) || (state.highest &&
      (ref.sequence < state.highest.sequence || (ref.sequence === state.highest.sequence && ref.manifest_sha256 !== state.highest.manifest_sha256)))) fail('STATE_TRANSITION');
  if (exact && (!state.highest || ref.sequence !== state.highest.sequence || ref.manifest_sha256 !== state.highest.manifest_sha256)) fail('STATE_TRANSITION');
}

function transition(state, event) {
  const next = validate(state);
  try {
    fields(event, ['type'], ['ref', 'nowMs', 'result', 'retryAfterMs']);
    switch (event.type) {
      case 'manifest-seen':
        fields(event, ['type', 'ref']);
        fresh(next, event.ref, false);
        next.highest = { sequence: event.ref.sequence, manifest_sha256: event.ref.manifest_sha256 };
        if (next.ready && !same(next.ready, event.ref)) next.ready = null;
        break;
      case 'stage-ready':
        fields(event, ['type', 'ref']);
        fresh(next, event.ref, true);
        next.ready = structuredClone(event.ref);
        break;
      case 'promote':
        fields(event, ['type']);
        if (!next.ready) fail('STATE_TRANSITION');
        fresh(next, next.ready, true);
        if (!same(next.current, next.ready)) {
          next.previous = next.current;
          next.current = next.ready;
        }
        next.ready = null;
        break;
      case 'reject':
        fields(event, ['type', 'ref']);
        validateRef(event.ref);
        if (!next.highest || event.ref.sequence > next.highest.sequence ||
            (event.ref.sequence === next.highest.sequence && event.ref.manifest_sha256 !== next.highest.manifest_sha256) || same(next.current, event.ref)) fail('STATE_TRANSITION');
        if (!next.rejected.includes(event.ref.release_id)) next.rejected.push(event.ref.release_id);
        if (same(next.ready, event.ref)) next.ready = null;
        break;
      case 'rollback': {
        fields(event, ['type']);
        if (!next.current || !next.previous || same(next.current, next.previous) || next.rejected.includes(next.previous.release_id)) fail('STATE_TRANSITION');
        const bad = next.current;
        if (!next.rejected.includes(bad.release_id)) next.rejected.push(bad.release_id);
        next.current = next.previous;
        next.previous = null;
        if (same(next.ready, bad)) next.ready = null;
        break;
      }
      case 'check-finished': {
        fields(event, ['type', 'nowMs', 'result'], ['retryAfterMs']);
        nextCheck({ nowMs: event.nowMs, failures: 0 });
        if (!['ok', 'failed', 'clock-rollback'].includes(event.result)) fail('STATE_TRANSITION');
        if (event.result === 'clock-rollback') {
          if (next.last_check_ms > event.nowMs || next.next_check_ms > event.nowMs + 6 * HOUR) {
            next.last_check_ms = event.nowMs;
            next.next_check_ms = event.nowMs + HOUR;
          }
          break;
        }
        next.failures = event.result === 'ok' ? 0 : next.failures + 1;
        next.last_check_ms = event.nowMs;
        next.next_check_ms = nextCheck({ nowMs: event.nowMs, failures: next.failures, retryAfterMs: event.retryAfterMs });
        break;
      }
      default: fail('STATE_TRANSITION');
    }
    return validate(next);
  } catch { fail('STATE_TRANSITION'); }
}

async function boundedRead(file, max) {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) fail('STATE_SCHEMA');
    const bytes = Buffer.alloc(Math.min(info.size + 1, max + 1));
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > max) fail('STATE_SCHEMA');
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

async function readInstallation(root, ports = {}) {
  const current = resolveOwned(root, 'current.json');
  const base = path.dirname(current);
  const backup = resolveOwned(base, 'current.previous.json');
  const read = ports.read || boundedRead;
  let missing = 0;
  for (const [index, file] of [current, backup].entries()) {
    let bytes;
    try { bytes = await read(file, MAX_STATE); }
    catch (error) {
      if (error.code === 'ENOENT') { missing++; continue; }
      if (error instanceof UpdateError && error.code === 'STATE_SCHEMA') continue;
      fail('STATE_IO');
    }
    try { return { state: parseState(bytes), recovered: index === 1 }; }
    catch { /* Only the explicitly named, validated backup is a recovery candidate. */ }
  }
  fail(missing === 2 ? 'STATE_MISSING' : 'STATE_RECOVERY');
}

async function commitState(root, next, ports = {}) {
  const bytes = encodeRelease(next);
  parseState(bytes);
  const current = resolveOwned(root, 'current.json');
  const base = path.dirname(current);
  const backup = resolveOwned(base, 'current.previous.json');
  if (typeof ports.commit !== 'function') fail('COORDINATOR_REQUIRED');
  try { await ports.commit({ root: base, current, backup, bytes }); }
  catch (error) { if (error instanceof UpdateError) throw error; fail('STATE_COMMIT'); }
}

module.exports = { transition, readInstallation, commitState };
