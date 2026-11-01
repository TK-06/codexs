'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const SHA = /^[a-f0-9]{40}$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

// Hosted preparation is independent of the later client protocol module.
class UpdateError extends Error {
  constructor(code) {
    super(`Codexs upstream preparation rejected: ${code}`);
    this.name = 'UpdateError';
    this.code = code;
  }
}

function fail(code) { throw new UpdateError(code); }

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail('UPSTREAM_IDENTITY');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) fail('UPSTREAM_IDENTITY');
  return parts;
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function integrity(value) {
  if (typeof value !== 'string' || !SRI.test(value)) fail('PACKAGE_INTEGRITY');
  const raw = value.slice(7);
  if (Buffer.from(raw, 'base64').length !== 64 || Buffer.from(raw, 'base64').toString('base64') !== raw) fail('PACKAGE_INTEGRITY');
  return value;
}

function selectUpstream(releases, npmMain, npmHelper) {
  if (!Array.isArray(releases)) fail('UPSTREAM_IDENTITY');
  const stable = [];
  for (const release of releases) {
    if (!release || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || typeof release.tag_name !== 'string') fail('UPSTREAM_IDENTITY');
    if (release.draft || release.prerelease || !release.tag_name.startsWith('rust-v')) continue;
    const version = release.tag_name.slice(6);
    versionParts(version);
    if (!SHA.test(release.sha)) fail('UPSTREAM_IDENTITY');
    stable.push({ version, tag: release.tag_name, sha: release.sha });
  }
  stable.sort((a, b) => compareVersions(b.version, a.version));
  if (stable.length === 0) return null;
  const newest = stable[0];
  if (stable.some(r => r.version === newest.version && r.sha !== newest.sha)) fail('UPSTREAM_IDENTITY');
  if (!npmMain || !npmHelper) return null;
  if (npmMain.name !== '@openai/codex') fail('PACKAGE_LAYOUT');
  if (npmMain.version !== newest.version) return null;
  const platformVersion = `${newest.version}-win32-x64`;
  if (npmMain.optionalDependencies?.['@openai/codex-win32-x64'] !== `npm:@openai/codex@${platformVersion}` ||
      npmHelper.name !== '@openai/codex' || npmHelper.version !== platformVersion ||
      !Array.isArray(npmHelper.os) || !npmHelper.os.includes('win32') ||
      !Array.isArray(npmHelper.cpu) || !npmHelper.cpu.includes('x64')) fail('PACKAGE_LAYOUT');
  return {
    ...newest,
    packages: {
      main: { name: npmMain.name, version: npmMain.version, integrity: integrity(npmMain.dist?.integrity) },
      helper: { name: npmHelper.name, version: npmHelper.version, integrity: integrity(npmHelper.dist?.integrity) },
    },
  };
}

function nativePath(file) {
  return typeof file === 'string' && file.startsWith('codex-rs/') &&
    !file.includes('\\') && !file.includes('\0') && !file.includes(':') &&
    file.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
    !/\.(?:snap(?:\.new)?|pending-snap)$/i.test(file);
}

function table(text, name) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `[${name}]`);
  if (start < 0) fail('SOURCE_LAYOUT');
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++;
  return lines.slice(start + 1, end).join('\n');
}

function stringField(text, name) {
  const match = text.match(new RegExp(`^${name}[ \\t]*=[ \\t]*("(?:[^"\\\\]|\\\\.)*")[ \\t]*(?:#.*)?$`, 'm'));
  if (!match) fail('SOURCE_LAYOUT');
  try { return JSON.parse(match[1]); } catch { fail('SOURCE_LAYOUT'); }
}

async function readWorkspacePackages(cargo, workspace, readFile) {
  const version = stringField(table(cargo, 'workspace.package'), 'version');
  versionParts(version);
  const members = table(cargo, 'workspace').match(/^members\s*=\s*\[([\s\S]*?)\]/m);
  if (!members) fail('SOURCE_LAYOUT');
  const list = members[1].replace(/#[^\r\n]*/g, '');
  const strings = /"(?:[^"\\]|\\.)*"/g;
  if (list.replace(strings, '').replace(/[\s,]/g, '') !== '') fail('SOURCE_LAYOUT');
  const tokens = list.match(strings) || [];
  if (/^\[workspace\.dependencies\]\s*$/m.test(cargo)) {
    const dependencies = table(cargo, 'workspace.dependencies');
    for (const line of dependencies.split('\n')) {
      if (!/\bpath\s*=/.test(line) || /^\s*#/.test(line)) continue;
      const local = line.match(/^[A-Za-z0-9_-]+\s*=\s*\{[^\r\n]*?\bpath\s*=\s*("(?:[^"\\]|\\.)*")/);
      if (!local) fail('SOURCE_LAYOUT');
      if (!tokens.includes(local[1])) tokens.push(local[1]);
    }
  }
  if (tokens.length === 0 || tokens.length > 5000) fail('SOURCE_LAYOUT');
  const packages = [];
  const paths = new Set();
  const names = new Set();
  for (const token of tokens) {
    let member;
    try { member = JSON.parse(token); } catch { fail('SOURCE_LAYOUT'); }
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(member) || paths.has(member)) fail('SOURCE_LAYOUT');
    paths.add(member);
    const manifest = table(await readFile(path.join(workspace, 'codex-rs', ...member.split('/'), 'Cargo.toml')), 'package');
    const name = stringField(manifest, 'name');
    if (!/^[A-Za-z0-9_-]+$/.test(name) || names.has(name)) fail('SOURCE_LAYOUT');
    names.add(name);
    const inherited = /^version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(manifest) || /^version\s*=\s*\{\s*workspace\s*=\s*true\s*\}\s*(?:#.*)?$/m.test(manifest);
    const memberVersion = inherited ? version : stringField(manifest, 'version');
    versionParts(memberVersion);
    packages.push({ name, version: memberVersion });
  }
  return packages;
}

function refreshWorkspaceVersions(lock, packages) {
  if (typeof lock !== 'string' || !Array.isArray(packages) || packages.length === 0) fail('WORKSPACE_LOCK');
  const wanted = new Map();
  for (const item of packages) {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.name) || wanted.has(item.name)) fail('WORKSPACE_LOCK');
    try { versionParts(item.version); } catch { fail('WORKSPACE_LOCK'); }
    wanted.set(item.name, item.version);
  }
  const found = new Set();
  const changed = [];
  let result = lock.split(/(?=^\[\[package\]\]\r?$)/m).map(block => {
    if (!block.startsWith('[[package]]') || /^source\s*=/m.test(block)) return block;
    const name = block.match(/^name\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1];
    if (!wanted.has(name)) fail('WORKSPACE_LOCK');
    const old = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!old || found.has(name)) fail('WORKSPACE_LOCK');
    found.add(name);
    const version = wanted.get(name);
    if (old === version) return block;
    try { versionParts(old); } catch { fail('WORKSPACE_LOCK'); }
    changed.push({ name, old, version });
    return block.replace(/^version[ \t]*=[ \t]*"[^"]+"/m, `version = "${version}"`);
  }).join('');
  if (found.size !== wanted.size) fail('WORKSPACE_LOCK');
  for (const { name, old, version } of changed) {
    const reference = new RegExp(`(^[ \\t]+")${name} ${old.replaceAll('.', '\\.')}(",?[ \\t]*\\r?$)`, 'gm');
    result = result.replace(reference, `$1${name} ${version}$2`);
  }
  return result;
}

function validateInput(input) {
  if (!input || !input.upstream || !input.overlay) fail('UPSTREAM_IDENTITY');
  const { upstream, overlay, workspace } = input;
  versionParts(upstream.version);
  if (upstream.tag !== `rust-v${upstream.version}` || !SHA.test(upstream.sha)) fail('UPSTREAM_IDENTITY');
  if (!upstream.packages || upstream.packages.main?.name !== '@openai/codex' || upstream.packages.main.version !== upstream.version ||
      upstream.packages.helper?.name !== '@openai/codex' || upstream.packages.helper.version !== `${upstream.version}-win32-x64`) fail('PACKAGE_LAYOUT');
  integrity(upstream.packages.main.integrity);
  integrity(upstream.packages.helper.integrity);
  if (overlay.schema !== 1 || !SHA.test(overlay.base_sha) || !SHA.test(overlay.accepted_sha) ||
      !SHA.test(overlay.revision) || !SHA.test(overlay.formatter_sha) ||
      !Buffer.isBuffer(overlay.patch_bytes) || overlay.patch_bytes.length === 0 || overlay.patch_bytes.length > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(overlay.patch_sha256) || createHash('sha256').update(overlay.patch_bytes).digest('hex') !== overlay.patch_sha256 ||
      !Array.isArray(overlay.paths) || overlay.paths.length === 0 || !overlay.paths.every(nativePath) || new Set(overlay.paths).size !== overlay.paths.length ||
      JSON.stringify(overlay.required_suites) !== JSON.stringify(['feature', 'full', 'config', 'build'])) fail('OVERLAY_IDENTITY');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) ||
      !/^codexs-candidate-[A-Za-z0-9_-]+$/.test(path.basename(workspace))) fail('WORKSPACE');
}

async function prepareCandidateUnchecked(input, ports) {
  validateInput(input);
  const { upstream, overlay, workspace } = input;
  try {
    if (await ports.readFile(path.join(workspace, '.codexs-owned-workspace')) !== 'codexs-candidate-workspace-v1\n') fail('WORKSPACE');
  } catch { fail('WORKSPACE'); }
  const branch = `automation/upstream/${upstream.version}-${overlay.revision.slice(0, 12)}`;
  const message = `codexs-upstream:v1\nupstream_sha=${upstream.sha}\noverlay_sha=${overlay.revision}\npatch_sha256=${overlay.patch_sha256}`;
  const existing = await ports.getJson(`https://api.github.com/repos/TK-06/codexs/git/ref/heads/${branch}`);
  const result = candidate_sha => ({ candidate_sha, upstream_sha: upstream.sha, overlay_sha: overlay.revision, paths: [...overlay.paths] });
  if (existing) {
    if (!SHA.test(existing.object?.sha)) fail('CANDIDATE_IDENTITY');
    const commit = await ports.getJson(`https://api.github.com/repos/TK-06/codexs/git/commits/${existing.object.sha}`);
    if (commit?.message?.trim() !== message) fail('CANDIDATE_IDENTITY');
    return result(existing.object.sha);
  }
  await ports.git(['init'], workspace);
  await ports.git(['remote', 'add', 'upstream', 'https://github.com/openai/codex.git'], workspace);
  for (const sha of new Set([upstream.sha, overlay.base_sha])) {
    await ports.git(['fetch', '--no-tags', '--depth=1', 'upstream', sha], workspace);
  }
  await ports.git(['checkout', '--detach', upstream.sha], workspace);
  const cargo = String(await ports.readFile(path.join(workspace, 'codex-rs', 'Cargo.toml')));
  const section = cargo.match(/^\[workspace\.package\][^\r\n]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (section?.[1].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1] !== upstream.version) fail('SOURCE_VERSION');
  const patchPath = path.join(workspace, '.codexs-overlay.patch');
  await ports.writeFile(patchPath, overlay.patch_bytes);
  try { await ports.git(['apply', '--3way', '--index', '--exclude=codex-rs/Cargo.lock', patchPath], workspace); }
  catch { fail('OVERLAY_CONFLICT'); }
  const members = await readWorkspacePackages(cargo, workspace, file => ports.readFile(file));
  const lockPath = path.join(workspace, 'codex-rs', 'Cargo.lock');
  const oldLock = String(await ports.readFile(lockPath));
  const newLock = refreshWorkspaceVersions(oldLock, members);
  if (newLock !== oldLock) {
    if (!overlay.paths.includes('codex-rs/Cargo.lock')) fail('OVERLAY_IDENTITY');
    await ports.writeFile(lockPath, newLock);
    await ports.git(['add', '--', 'codex-rs/Cargo.lock'], workspace);
  }
  const changed = String(await ports.git(['diff', '--cached', '--name-only', '--no-ext-diff'], workspace)).trim().split(/\r?\n/);
  if (changed.length === 0 || changed.some(file => !nativePath(file) || !overlay.paths.includes(file))) fail('OVERLAY_IDENTITY');
  await ports.git(['checkout', '-b', branch], workspace);
  await ports.git(['-c', `core.hooksPath=${path.join(workspace, '.codexs-disabled-hooks')}`,
    '-c', 'user.name=codexs automation', '-c', 'user.email=codexs@users.noreply.github.com',
    'commit', '--no-gpg-sign', '-m', message], workspace);
  const candidate = String(await ports.git(['rev-parse', 'HEAD'], workspace)).trim();
  if (!SHA.test(candidate)) fail('CANDIDATE_IDENTITY');
  return result(candidate);
}

async function prepareCandidate(input, ports) {
  try { return await prepareCandidateUnchecked(input, ports); }
  catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('PREPARATION_IO');
  }
}

module.exports = { selectUpstream, prepareCandidate, readWorkspacePackages, refreshWorkspaceVersions };
