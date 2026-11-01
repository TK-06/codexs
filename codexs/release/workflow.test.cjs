'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/codexs-statusline.yml'), 'utf8');

function step(name) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing actual workflow step: ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^      - name: |^  [A-Za-z_]+:/.test(lines[end])) end++;
  const section = lines.slice(start, end);
  const run = section.indexOf('        run: |');
  assert.notEqual(run, -1, `missing PowerShell body: ${name}`);
  const body = [];
  for (const line of section.slice(run + 1)) {
    if (line && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  const bindings = {};
  for (const line of section.slice(0, run)) {
    const match = line.match(/^          ([A-Z_]+): \$\{\{ (inputs|matrix)\.([a-z_]+) \}\}$/);
    if (match) bindings[match[1]] = [match[2], match[3]];
  }
  return { body: body.join('\n'), bindings };
}

function execute(name, context = {}, extra = {}, inspect) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  try {
    const selected = step(name);
    const env = {
      ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'd'.repeat(40),
      GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'TK-06/codexs',
      RUNNER_TEMP: directory, GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_ENV: path.join(directory, 'environment'),
      ...extra,
    };
    for (const [key, [group, field]] of Object.entries(selected.bindings)) env[key] = context[group]?.[field] || '';
    const encoded = Buffer.from(selected.body, 'utf16le').toString('base64');
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const outputs = fs.existsSync(env.GITHUB_OUTPUT) ? fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').replace(/^\uFEFF/, '') : '';
    if (inspect) inspect({ result, env, outputs });
    return { ...result, outputs };
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe test cleanup');
    fs.rmSync(directory, { recursive: true });
  }
}

function caller(overrides = {}) {
  return { inputs: { candidate_sha: 'a'.repeat(40), baseline_sha: 'c'.repeat(40), validation_id: 'cleanup', scope: 'cleanup', ...overrides }, matrix: { scope: 'full' } };
}

test('reusable cleanup accepts the original scheduled event with immutable caller inputs', () => {
  const result = execute('Resolve execution scopes', caller(), { GITHUB_EVENT_NAME: 'schedule' });
  assert.equal(result.status, 0, result.stderr);
  const output = result.outputs.split(/\r?\n/).find(line => line.startsWith('matrix='));
  assert.deepEqual(JSON.parse(output.slice(7)).scope, ['full', 'config', 'build']);
});

test('moving candidate refs are rejected even when the caller originated from push', () => {
  const result = execute('Resolve execution scopes', caller({ candidate_sha: 'refs/heads/main' }), { GITHUB_EVENT_NAME: 'push' });
  assert.notEqual(result.status, 0);
  assert.equal(result.outputs, '');
});

test('missing baseline or unsafe validation label cannot create a release matrix', () => {
  for (const override of [{ baseline_sha: '' }, { validation_id: '../escape' }]) {
    const result = execute('Resolve execution scopes', caller(override), { GITHUB_EVENT_NAME: 'push' });
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  }
});

test('reusable caller cannot select a partial release suite', () => {
  const result = execute('Resolve execution scopes', caller({ scope: 'config' }), { GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.notEqual(result.status, 0);
});

test('legacy pushes and cleanup dispatch keep their original scopes', () => {
  for (const [event, requested, expected] of [['push', '', ['feature']], ['workflow_dispatch', 'cleanup', ['full', 'config', 'build']]]) {
    const result = execute('Resolve execution scopes', { inputs: { scope: requested } }, { GITHUB_EVENT_NAME: event });
    assert.equal(result.status, 0, result.stderr);
    const output = result.outputs.split(/\r?\n/).find(line => line.startsWith('matrix='));
    assert.deepEqual(JSON.parse(output.slice(7)).scope, expected);
  }
});

test('native source selection uses the caller candidate instead of controller SHA', () => {
  const result = execute('Select validated scope', caller());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.outputs.includes(`source_ref=${'a'.repeat(40)}`));
});

test('baseline source selection uses the caller immutable upstream SHA', () => {
  const context = caller();
  context.matrix.scope = 'baseline';
  const result = execute('Select validated scope', context);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.outputs.includes(`source_ref=${'c'.repeat(40)}`));
});

test('different reusable invocations get different artifact suffixes', () => {
  const feature = execute('Select validated scope', caller({ validation_id: 'feature' }));
  const cleanup = execute('Select validated scope', caller({ validation_id: 'cleanup' }));
  assert.equal(feature.status, 0, feature.stderr);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.ok(feature.outputs.includes('artifact_suffix=feature-101-1'));
  assert.ok(cleanup.outputs.includes('artifact_suffix=cleanup-101-1'));
});

test('legacy artifact suffix remains compatible with existing download commands', () => {
  const result = execute('Select validated scope', { inputs: {}, matrix: { scope: 'feature' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.outputs.includes('artifact_suffix=101-1'));
});

test('validation uploader finds failure logs for labelled and legacy runs', () => {
  const section = source.split('      - name: Upload validation logs\n')[1]?.split(/\r?\n      - name:/)[0]
    || source.split('      - name: Upload validation logs\r\n')[1]?.split(/\r?\n      - name:/)[0];
  assert.ok(section, 'missing validation-log uploader');
  const input = section.match(/^          path: (.+)$/m)?.[1].trim();
  assert.ok(input, 'missing validation-log upload path');
  const cases = [
    { ...caller({ scope: 'feature', validation_id: 'port-feature' }), matrix: { scope: 'feature' } },
    ...['full', 'config', 'build'].map(scope => ({ ...caller({ validation_id: 'port-cleanup' }), matrix: { scope } })),
    { inputs: {}, matrix: { scope: 'feature' } },
  ];
  for (const context of cases) {
    execute('Select validated scope', context, {}, ({ result, env, outputs }) => {
      assert.equal(result.status, 0, result.stderr);
      const selected = fs.readFileSync(env.GITHUB_ENV, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
      const logDir = selected.find(line => line.startsWith('CODEXS_LOG_DIR=')).slice('CODEXS_LOG_DIR='.length);
      fs.writeFileSync(path.join(logDir, 'cargo.log'), 'synthetic Cargo failure\n');
      const suffix = outputs.split(/\r?\n/).find(line => line.startsWith('artifact_suffix=')).slice('artifact_suffix='.length);
      const values = {
        'env.CODEXS_LOG_DIR': logDir, 'runner.temp': env.RUNNER_TEMP, 'matrix.scope': context.matrix.scope,
        'github.run_id': env.GITHUB_RUN_ID, 'github.run_attempt': env.GITHUB_RUN_ATTEMPT,
        'steps.scope.outputs.artifact_suffix': suffix,
      };
      const uploadPath = input.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
        assert.ok(Object.hasOwn(values, key), `unknown uploader binding: ${key}`);
        return values[key];
      });
      assert.ok(fs.existsSync(path.join(uploadPath, 'cargo.log')),
        `validation uploader misses selected failure log for ${context.inputs.validation_id || 'legacy'}/${context.matrix.scope}`);
    });
  }
});

test('a full-suite command that discovers zero tests fails acceptance', () => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('          if ($wrapperProblem -or $guardReason'));
  assert.notEqual(start, -1);
  const gates = [];
  for (const line of lines.slice(start)) {
    if (!line.trim()) break;
    assert.ok(line.startsWith('          '));
    gates.push(line.slice(10));
  }
  const prelude = "$ErrorActionPreference='Stop'; $wrapperProblem=$null; $guardReason='none'; $nativeExit=0; $passed=0; $failed=0; $ignored=0; $testCount=0; $outcome='synthetic';\n";
  const encoded = Buffer.from(prelude + gates.join('\n'), 'utf16le').toString('base64');
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: { ...process.env, CODEXS_SCOPE: 'full' }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
});

function sourcePreflight(cargo, expected) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'Cargo.toml'), cargo);
    const body = step('Verify source and select target drive').body;
    const cut = body.indexOf('$toolchain =');
    assert.notEqual(cut, -1);
    const prefix = body.slice(0, cut);
    const script = "function git { $global:LASTEXITCODE=0; return ('a' * 40) }\n" + prefix + "\n} catch { throw }\nWrite-Output ('parsed_version=' + $workspaceVersion)";
    return spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, CODEXS_LOG_DIR: directory, CODEXS_SCOPE: 'full', CODEXS_EXPECTED_SOURCE_SHA: expected },
      });
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe preflight test cleanup');
    fs.rmSync(directory, { recursive: true });
  }
}

test('source preflight reads selected workspace version instead of a historical constant', () => {
  const result = sourcePreflight('[package]\nversion = "9.8.7"\n[workspace.package]\nversion = "0.166.0"\n', 'a'.repeat(40));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('parsed_version=0.166.0'));
});

test('source preflight rejects a checkout different from the expected immutable SHA', () => {
  const result = sourcePreflight('[workspace.package]\nversion = "0.162.1"\n', 'b'.repeat(40));
  assert.notEqual(result.status, 0);
});

function updaterCheck(count, exit) {
  const script = `function node { Write-Output '# tests ${count}'; $global:LASTEXITCODE=${exit} }\n` + step('Check isolated update modules').body;
  return spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000 });
}

test('hosted updater checks reject a successful Node process that discovers zero tests', () => {
  assert.notEqual(updaterCheck(0, 0).status, 0);
});

test('hosted updater checks preserve a failing Node process despite a positive summary', () => {
  assert.notEqual(updaterCheck(1, 7).status, 0);
});
