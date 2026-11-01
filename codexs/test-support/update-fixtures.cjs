'use strict';

const { createHash } = require('node:crypto');

function upstreamRelease(version = '0.166.0', overrides = {}) {
  return { tag_name: `rust-v${version}`, sha: 'a'.repeat(40), draft: false, prerelease: false, ...overrides };
}

function upstreamPackages(version = '0.166.0') {
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  return {
    main: {
      name: '@openai/codex', version,
      optionalDependencies: { '@openai/codex-win32-x64': `npm:@openai/codex@${version}-win32-x64` },
      dist: { integrity },
    },
    helper: {
      name: '@openai/codex', version: `${version}-win32-x64`, os: ['win32'], cpu: ['x64'],
      dist: { integrity },
    },
  };
}

function footerOverlay() {
  const patch_bytes = Buffer.from('synthetic footer patch\n');
  return {
    schema: 1, base_sha: 'c'.repeat(40), accepted_sha: 'd'.repeat(40),
    patch_sha256: createHash('sha256').update(patch_bytes).digest('hex'),
    paths: ['codex-rs/Cargo.lock', 'codex-rs/tui/src/status_line_command.rs'], formatter_sha: 'e'.repeat(40),
    required_suites: ['feature', 'full', 'config', 'build'],
    revision: 'b'.repeat(40), patch_bytes,
  };
}

function releaseManifest(sequence = 1) {
  const packages = upstreamPackages();
  const suites = {};
  for (const name of ['quick', 'feature', 'full', 'config', 'formatter', 'updater', 'installer', 'bundle']) {
    suites[name] = { passed: 1, failed: 0, ignored: 0, exit: 0 };
  }
  return {
    schema: 1, repository: 'TK-06/codexs', channel: 'stable', sequence,
    release_id: `codexs-v1.0.0-codex0.166.0-r${sequence}`, product_version: '1.0.0',
    upstream: { version: '0.166.0', tag: 'rust-v0.166.0', sha: 'a'.repeat(40) },
    native_sha: 'b'.repeat(40), overlay_sha: 'c'.repeat(40),
    formatter: { sha: 'd'.repeat(40), version: '2.2.32' },
    target: 'x86_64-pc-windows-msvc', bootstrap_min: 1, node_min: 22,
    archive: { name: 'codexs-windows-x64.zip', bytes: 1024, sha256: '1'.repeat(64) },
    files: [
      { path: 'bin/codex.exe', bytes: 8, sha256: '2'.repeat(64) },
      { path: 'formatter/dist/ccstatusline.js', bytes: 16, sha256: '3'.repeat(64) },
    ],
    packages: {
      main: { name: packages.main.name, version: packages.main.version, integrity: packages.main.dist.integrity },
      helper: { name: packages.helper.name, version: packages.helper.version, integrity: packages.helper.dist.integrity },
    },
    evidence: {
      candidate_sha: 'b'.repeat(40), upstream_sha: 'a'.repeat(40), formatter_sha: 'd'.repeat(40),
      runs: [{ repository: 'TK-06/codexs', run: 100, attempt: 1, job: 101, artifact: 102 }],
      suites, build_exit: 0,
    },
  };
}

function installationState() {
  return {
    schema: 1, current: null, previous: null, ready: null, highest: null,
    rejected: [], last_check_ms: 0, next_check_ms: 0, failures: 0,
  };
}

module.exports = { upstreamRelease, upstreamPackages, footerOverlay, releaseManifest, installationState };
