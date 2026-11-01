'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { upstreamRelease, upstreamPackages, footerOverlay } = require('../test-support/update-fixtures.cjs');

function api() {
  let result;
  assert.doesNotThrow(() => { result = require('./upstream.cjs'); }, 'upstream implementation must exist');
  return result;
}

function selected(version = '0.166.0') {
  const packages = upstreamPackages(version);
  return api().selectUpstream([upstreamRelease(version)], packages.main, packages.helper);
}

function candidateFixture(options = {}) {
  const calls = [];
  const writes = [];
  const overlay = footerOverlay();
  const input = {
    upstream: selected(), overlay,
    workspace: path.join(os.tmpdir(), 'codexs-candidate-synthetic'),
  };
  const marker = `codexs-upstream:v1\nupstream_sha=${'a'.repeat(40)}\noverlay_sha=${'b'.repeat(40)}\npatch_sha256=${overlay.patch_sha256}`;
  return {
    input, calls, writes, marker,
    ports: {
      async getJson(url) {
        calls.push(['GET', url]);
        if (!options.existing) return null;
        if (url.includes('/git/ref/heads/')) return { object: { sha: 'f'.repeat(40) } };
        return { message: options.wrongExisting ? 'unrelated commit' : marker };
      },
      async git(args, cwd) {
        calls.push(['GIT', args, cwd]);
        if (args[0] === 'apply' && options.conflict) throw Object.assign(new Error('synthetic conflict'), { stderr: 'synthetic diagnostic' });
        if (args[0] === 'rev-parse') return 'f'.repeat(40);
        if (args[0] === 'diff') return 'codex-rs/Cargo.lock\ncodex-rs/tui/src/status_line_command.rs\n';
        return '';
      },
      async readFile(file) {
        if (file === path.join(input.workspace, '.codexs-owned-workspace')) return 'codexs-candidate-workspace-v1\n';
        if (file === path.join(input.workspace, 'codex-rs', 'tui', 'Cargo.toml')) return '[package]\nname = "codex-tui"\nversion.workspace = true\n';
        if (file === path.join(input.workspace, 'codex-rs', 'Cargo.lock')) return 'version = 4\n\n[[package]]\nname = "codex-tui"\nversion = "0.0.0"\n';
        assert.equal(file, path.join(input.workspace, 'codex-rs', 'Cargo.toml'));
        return `[workspace]\nmembers = ["tui"]\n\n[workspace.package]\nversion = "${options.sourceVersion || '0.166.0'}"\n`;
      },
      async writeFile(file, bytes) { writes.push({ file, bytes }); },
    },
  };
}

test('selects newest matching stable and retains immutable identities', () => {
  const p = upstreamPackages();
  const value = api().selectUpstream([
    upstreamRelease('0.99.0'), upstreamRelease(),
    upstreamRelease('0.167.0', { prerelease: true }), upstreamRelease('0.168.0', { draft: true }),
  ], p.main, p.helper);
  assert.equal(value.version, '0.166.0');
  assert.equal(value.tag, 'rust-v0.166.0');
  assert.equal(value.sha, 'a'.repeat(40));
  assert.equal(value.packages.helper.version, '0.166.0-win32-x64');
  assert.equal(value.packages.main.integrity, p.main.dist.integrity);
});

test('does not select drafts or prereleases', () => {
  const p = upstreamPackages();
  assert.equal(api().selectUpstream([upstreamRelease('0.166.0-alpha.1', { prerelease: true }), upstreamRelease('0.166.0', { draft: true })], p.main, p.helper), null);
});

test('does not use an older release when newest npm publication is incomplete', () => {
  const p = upstreamPackages();
  assert.equal(api().selectUpstream([upstreamRelease('0.167.0'), upstreamRelease()], p.main, p.helper), null);
  assert.equal(api().selectUpstream([upstreamRelease()], p.main, null), null);
});

test('rejects shell-shaped tags before candidate preparation', () => {
  const p = upstreamPackages();
  assert.throws(() => api().selectUpstream([upstreamRelease('0.166.0;whoami')], p.main, p.helper), { code: 'UPSTREAM_IDENTITY' });
});

test('rejects moving refs and malformed source versions', () => {
  const p = upstreamPackages();
  for (const release of [upstreamRelease('0.166.0', { sha: 'main' }), upstreamRelease('00.166.0'), upstreamRelease('0.166.9007199254740992')]) {
    assert.throws(() => api().selectUpstream([release], p.main, p.helper), { code: 'UPSTREAM_IDENTITY' });
  }
});

test('rejects main package substitution and unknown platform alias layouts', () => {
  const p = upstreamPackages();
  assert.throws(() => api().selectUpstream([upstreamRelease()], { ...p.main, name: 'different-package' }, p.helper), { code: 'PACKAGE_LAYOUT' });
  assert.throws(() => api().selectUpstream([upstreamRelease()], { ...p.main, optionalDependencies: {} }, p.helper), { code: 'PACKAGE_LAYOUT' });
});

test('rejects mismatched helper identity and architecture', () => {
  const p = upstreamPackages();
  for (const helper of [{ ...p.helper, name: '@openai/codex-win32-x64' }, { ...p.helper, version: '0.165.0-win32-x64' }, { ...p.helper, cpu: ['arm64'] }, { ...p.helper, os: ['linux'] }]) {
    assert.throws(() => api().selectUpstream([upstreamRelease()], p.main, helper), { code: 'PACKAGE_LAYOUT' });
  }
});

test('requires independently recorded valid package integrities', () => {
  const p = upstreamPackages();
  assert.throws(() => api().selectUpstream([upstreamRelease()], { ...p.main, dist: {} }, p.helper), { code: 'PACKAGE_INTEGRITY' });
  assert.throws(() => api().selectUpstream([upstreamRelease()], p.main, { ...p.helper, dist: { integrity: 'sha512-short' } }), { code: 'PACKAGE_INTEGRITY' });
});

test('records packages without executing their lifecycle scripts', () => {
  const p = upstreamPackages();
  p.main.scripts = { postinstall: 'never-execute-synthetic-command' };
  assert.equal(api().selectUpstream([upstreamRelease()], p.main, p.helper).version, '0.166.0');
});

test('prepares only an isolated automation candidate with verified patch bytes', async () => {
  const f = candidateFixture();
  const result = await api().prepareCandidate(f.input, f.ports);
  assert.deepEqual(result, { candidate_sha: 'f'.repeat(40), upstream_sha: 'a'.repeat(40), overlay_sha: 'b'.repeat(40), paths: ['codex-rs/Cargo.lock', 'codex-rs/tui/src/status_line_command.rs'] });
  const gitCalls = f.calls.filter(c => c[0] === 'GIT').map(c => c[1]);
  assert.ok(gitCalls.some(args => args[0] === 'apply' && args.includes('--3way') && args.includes('--index')));
  assert.ok(gitCalls.some(args => args[0] === 'checkout' && args[1] === '-b' && args[2] === 'automation/upstream/0.166.0-bbbbbbbbbbbb'));
  assert.equal(gitCalls.some(args => ['push', 'reset', 'clean', 'merge', 'rebase'].includes(args[0])), false);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[0].bytes, f.input.overlay.patch_bytes);
  assert.equal(f.writes[1].bytes, 'version = 4\n\n[[package]]\nname = "codex-tui"\nversion = "0.166.0"\n');
  assert.ok(gitCalls.some(args => args[0] === 'apply' && args.includes('--exclude=codex-rs/Cargo.lock')));
});

test('conflict cannot produce a commit or candidate result', async () => {
  const f = candidateFixture({ conflict: true });
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'OVERLAY_CONFLICT' });
  assert.equal(f.calls.some(c => c[0] === 'GIT' && c[1].includes('commit')), false);
});

test('source version disagreement stops before applying the overlay', async () => {
  const f = candidateFixture({ sourceVersion: '0.165.0' });
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'SOURCE_VERSION' });
  assert.equal(f.calls.some(c => c[0] === 'GIT' && c[1][0] === 'apply'), false);
});

test('changed overlay bytes stop before any external operation', async () => {
  const f = candidateFixture();
  f.input.overlay.patch_bytes = Buffer.from('tampered synthetic patch');
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'OVERLAY_IDENTITY' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('unsafe overlay paths stop before any external operation', async () => {
  for (const file of ['../escape', '.git/config', 'codex-rs/../escape', 'codex-rs/example.snap', 'codex-rs/example.snap.new']) {
    const f = candidateFixture();
    f.input.overlay.paths = [file];
    await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'OVERLAY_IDENTITY' });
    assert.equal(f.calls.length, 0);
  }
});

test('refuses the user checkout as a preparation workspace', async () => {
  const f = candidateFixture();
  f.input.workspace = process.cwd();
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'WORKSPACE' });
  assert.equal(f.calls.length, 0);
});

test('a directory name alone cannot authorize Git workspace writes', async () => {
  const f = candidateFixture();
  f.ports.readFile = async () => 'unrelated-directory';
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'WORKSPACE' });
  assert.equal(f.calls.length, 0);
});

test('reuses an identical existing candidate without Git mutations', async () => {
  const f = candidateFixture({ existing: true });
  assert.equal((await api().prepareCandidate(f.input, f.ports)).candidate_sha, 'f'.repeat(40));
  assert.equal(f.calls.some(c => c[0] === 'GIT'), false);
  assert.equal(f.writes.length, 0);
});

test('an unrelated existing branch cannot be relabeled or overwritten', async () => {
  const f = candidateFixture({ existing: true, wrongExisting: true });
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'CANDIDATE_IDENTITY' });
  assert.equal(f.calls.some(c => c[0] === 'GIT'), false);
});

test('snapshot case variants cannot enter a Windows candidate', async () => {
  const f = candidateFixture();
  f.input.overlay.paths = ['codex-rs/example.SNAP.NEW'];
  await assert.rejects(api().prepareCandidate(f.input, f.ports), { code: 'OVERLAY_IDENTITY' });
  assert.equal(f.calls.length, 0);
});

test('transport errors expose only a bounded preparation reason', async () => {
  const f = candidateFixture();
  f.ports.getJson = async () => { throw new Error('synthetic private transport detail'); };
  await assert.rejects(api().prepareCandidate(f.input, f.ports), error => error.code === 'PREPARATION_IO' && !error.message.includes('private transport'));
});

test('refreshes only declared workspace versions and preserves external identities', () => {
  const lock = 'version = 4\n\n[[package]]\nname = "member"\nversion = "0.0.0"\n\n[[package]]\nname = "external"\nversion = "9.8.7"\nsource = "registry+synthetic"\nchecksum = "synthetic-checksum"\n';
  const want = 'version = 4\n\n[[package]]\nname = "member"\nversion = "0.166.0"\n\n[[package]]\nname = "external"\nversion = "9.8.7"\nsource = "registry+synthetic"\nchecksum = "synthetic-checksum"\n';
  assert.equal(api().refreshWorkspaceVersions(lock, [{ name: 'member', version: '0.166.0' }]), want);
});

test('preserves explicit member versions and CRLF lockfile encoding', () => {
  const lock = 'version = 4\r\n\r\n[[package]]\r\nname = "member"\r\nversion = "1.2.3"\r\n';
  assert.equal(api().refreshWorkspaceVersions(lock, [{ name: 'member', version: '1.2.3' }]), lock);
});

test('missing workspace entries cannot be silently omitted from a refresh', () => {
  assert.throws(() => api().refreshWorkspaceVersions('version = 4\n', [{ name: 'member', version: '0.166.0' }]), { code: 'WORKSPACE_LOCK' });
});

test('updates disambiguated references to a workspace package without changing registry versions', () => {
  const lock = 'version = 4\n\n[[package]]\nname = "parent"\nversion = "1.0.0"\ndependencies = [\n "member 0.0.0",\n]\n\n[[package]]\nname = "member"\nversion = "0.0.0"\n\n[[package]]\nname = "member"\nversion = "9.8.7"\nsource = "registry+synthetic"\n';
  const refreshed = api().refreshWorkspaceVersions(lock, [{ name: 'parent', version: '1.0.0' }, { name: 'member', version: '0.166.0' }]);
  assert.ok(refreshed.includes(' "member 0.166.0",'));
  assert.ok(refreshed.endsWith('name = "member"\nversion = "9.8.7"\nsource = "registry+synthetic"\n'));
});

test('reads declared member names instead of rewriting every source-less package', async () => {
  const f = candidateFixture();
  const rootCargo = await f.ports.readFile(path.join(f.input.workspace, 'codex-rs', 'Cargo.toml'));
  assert.deepEqual(await api().readWorkspacePackages(rootCargo, f.input.workspace, f.ports.readFile), [{ name: 'codex-tui', version: '0.166.0' }]);
});

test('unsupported workspace member syntax fails for review before touching a lockfile', async () => {
  const f = candidateFixture();
  await assert.rejects(api().readWorkspacePackages('[workspace]\nmembers = ["utils/*"]\n[workspace.package]\nversion = "0.166.0"\n', f.input.workspace, f.ports.readFile), { code: 'SOURCE_LAYOUT' });
});

test('includes implicit members supplied by workspace path dependencies', async () => {
  const f = candidateFixture();
  const cargo = '[workspace]\nmembers = ["tui"]\n[workspace.package]\nversion = "0.166.0"\n[workspace.dependencies]\nsupport = { path = "utils/support" }\n';
  const readFile = file => file === path.join(f.input.workspace, 'codex-rs', 'utils', 'support', 'Cargo.toml')
    ? '[package]\nname = "support"\nversion.workspace = true\n' : f.ports.readFile(file);
  assert.deepEqual(await api().readWorkspacePackages(cargo, f.input.workspace, readFile), [
    { name: 'codex-tui', version: '0.166.0' }, { name: 'support', version: '0.166.0' },
  ]);
});

test('unaccounted source-less lock entries stop for membership review', () => {
  const lock = 'version = 4\n\n[[package]]\nname = "member"\nversion = "0.0.0"\n\n[[package]]\nname = "unknown"\nversion = "0.0.0"\n';
  assert.throws(() => api().refreshWorkspaceVersions(lock, [{ name: 'member', version: '0.166.0' }]), { code: 'WORKSPACE_LOCK' });
});
