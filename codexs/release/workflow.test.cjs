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

function execute(name, context = {}, extra = {}, inspect, prelude = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  try {
    const selected = step(name);
    const env = {
      ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'd'.repeat(40),
      GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'TK-06/codexs',
      RUNNER_TEMP: directory, CODEXS_LOG_DIR: directory, GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_ENV: path.join(directory, 'environment'),
      ...extra,
    };
    for (const [key, [group, field]] of Object.entries(selected.bindings)) env[key] = context[group]?.[field] || '';
    const encoded = Buffer.from(prelude + '\n' + selected.body, 'utf16le').toString('base64');
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

test('overlay patch checkout preserves exact Git blob bytes even with autocrlf enabled', () => {
  const git = args => {
    const result = spawnSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.autocrlf=true', ...args],
      { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, String(result.stderr));
    return result.stdout;
  };
  const blob = git(['cat-file', 'blob', 'HEAD:codexs/upstream/overlay.patch']);
  const checkout = git(['cat-file', '--filters', 'HEAD:codexs/upstream/overlay.patch']);
  assert.equal(Buffer.compare(checkout, blob), 0, 'checkout line-ending conversion must not alter signed overlay bytes');
});

test('overlay round-trip requires verified bytes, successful application and the exact native tree', () => {
  const patch = 'synthetic overlay bytes\n';
  const metadata = { schema: 1, base_sha: 'c'.repeat(40), accepted_sha: 'a'.repeat(40),
    patch_sha256: require('node:crypto').createHash('sha256').update(patch).digest('hex'), paths: ['codex-rs/synthetic.rs'] };
  for (const mode of ['good', 'hash', 'identity', 'fetch', 'apply', 'tree', 'paths']) {
    const data = structuredClone(metadata);
    if (mode === 'hash') data.patch_sha256 = '0'.repeat(64);
    if (mode === 'identity') data.accepted_sha = '--unsafe-ref';
    const prelude = `
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $env:RUNNER_TEMP
$null=[IO.Directory]::CreateDirectory((Join-Path $env:RUNNER_TEMP 'codexs/upstream'))
[IO.File]::WriteAllBytes((Join-Path $env:RUNNER_TEMP 'codexs/upstream/overlay.patch'),[Convert]::FromBase64String('${Buffer.from(patch).toString('base64')}'))
[IO.File]::WriteAllBytes((Join-Path $env:RUNNER_TEMP 'codexs/upstream/overlay.json'),[Convert]::FromBase64String('${Buffer.from(JSON.stringify(data)).toString('base64')}'))
function git {
  $call=@($args)
  Add-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'git-calls.jsonl') -Value (ConvertTo-Json -InputObject $call -Compress)
  $global:LASTEXITCODE=0
  if (($env:CODEXS_OVERLAY_TEST_MODE -eq 'fetch' -and $call -contains 'fetch') -or
      ($env:CODEXS_OVERLAY_TEST_MODE -eq 'apply' -and $call -contains 'apply') -or
      ($env:CODEXS_OVERLAY_TEST_MODE -eq 'tree' -and $call -contains '--exit-code')) { $global:LASTEXITCODE=7; return }
  if ($call -contains '--name-only') {
    'codex-rs/synthetic.rs'
    if ($env:CODEXS_OVERLAY_TEST_MODE -eq 'paths') { 'unreviewed.txt' }
  }
}
`;
    const result = execute('Verify overlay round-trip', {}, { CODEXS_OVERLAY_TEST_MODE: mode }, ({ result, env }) => {
      if (mode !== 'good') return;
      assert.equal(result.status, 0, result.stderr);
      const calls = fs.readFileSync(path.join(env.RUNNER_TEMP, 'git-calls.jsonl'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(JSON.parse);
      const fetch = calls.find(c => c.includes('fetch'));
      assert.ok(fetch.includes('https://github.com/TK-06/codexs.git'));
      assert.ok(fetch.includes(metadata.base_sha) && fetch.includes(metadata.accepted_sha));
      assert.ok(calls.some(c => c.includes('apply') && c.includes('--cached')));
      assert.ok(calls.some(c => c.includes('--exit-code') && c.includes(metadata.accepted_sha) && c.includes('codex-rs')));
      assert.ok(!fs.readdirSync(env.RUNNER_TEMP).some(name => name.startsWith('codexs-overlay-')));
    }, prelude);
    if (mode === 'good') assert.match(result.stdout, /overlay_roundtrip=ok/);
    else assert.notEqual(result.status, 0, `round-trip accepted ${mode}`);
  }
});

// Break caught: an ineffective pagefile change wastes a full compilation or
// consumes the disk reserve. Only CIM readings are substituted; the actual gates run.
function memoryGate(name, readings, inspect) {
  const encoded = Buffer.from(JSON.stringify(readings)).toString('base64');
  const prelude = `
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
function Get-CimInstance($ClassName) {
  if ($ClassName -eq 'Win32_LogicalDisk') { return $fixture.disk }
  if ($ClassName -eq 'Win32_PageFileUsage') { return $fixture.pagefiles }
  if ($ClassName -eq 'Win32_OperatingSystem') { return $fixture.os }
  throw 'Unexpected CIM query'
}
`;
  return execute(name, {}, {}, inspect, prelude);
}

function capacity(overrides = {}) {
  return {
    disk: { DeviceID: 'D:', DriveType: 3, FreeSpace: 42949672960 },
    pagefiles: [{ Name: 'D:\\pagefile.sys', AllocatedBaseSize: 32768 }],
    os: { FreeVirtualMemory: 25165824, FreePhysicalMemory: 8388608, TotalVirtualMemorySize: 50331648 },
    ...overrides,
  };
}

test('hosted pagefile allocation preserves the disk reserve and fails closed on invalid readings', () => {
  assert.equal(memoryGate('Check hosted pagefile disk capacity', capacity()).status, 0);
  for (const disk of [null, { DeviceID: 'D:', DriveType: 3, FreeSpace: 42949672959 },
    { DeviceID: 'C:', DriveType: 3, FreeSpace: 99999999999 },
    { DeviceID: 'D:', DriveType: 2, FreeSpace: 99999999999 }]) {
    const result = memoryGate('Check hosted pagefile disk capacity', capacity({ disk }));
    assert.notEqual(result.status, 0, 'unsafe allocation must fail before the action runs');
  }
});

test('hosted memory verification requires the effective D pagefile and usable virtual headroom', () => {
  const result = memoryGate('Verify hosted memory capacity', capacity(), ({ result, env }) => {
    assert.equal(result.status, 0, result.stderr);
    const bytes = fs.readFileSync(path.join(env.CODEXS_LOG_DIR, 'memory-capacity.log'));
    const log = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
    assert.match(log, /allocated_mib=32768/);
    assert.match(log, /free_virtual_bytes=25769803776/);
    assert.match(log, /free_physical_bytes=8589934592/);
  });
  assert.equal(result.status, 0);
  for (const readings of [
    { pagefiles: [] },
    { pagefiles: [{ Name: 'C:\\pagefile.sys', AllocatedBaseSize: 32768 }] },
    { pagefiles: [{ Name: 'D:\\pagefile.sys', AllocatedBaseSize: 32767 }] },
    { os: { FreeVirtualMemory: 25165823, FreePhysicalMemory: 8388608, TotalVirtualMemorySize: 50331648 } },
    { os: null },
  ]) {
    assert.notEqual(memoryGate('Verify hosted memory capacity', capacity(readings)).status, 0,
      'ineffective allocation or missing memory reading must stop before Cargo');
  }
});

test('only hosted native jobs allocate the pinned pagefile before verifying memory and starting Cargo', () => {
  const windows = source.slice(source.indexOf('\n  windows:'));
  const allocation = windows.match(/      - name: Configure hosted pagefile\r?\n(?<body>.*?)(?=      - name:)/s);
  assert.ok(allocation, 'missing hosted allocation');
  assert.match(allocation.groups.body, /uses: al-cheb\/configure-pagefile-action@9b6da52fb72a3c6147c1aad2df22d8d905681adc/);
  const values = Object.fromEntries([...allocation.groups.body.matchAll(/^          ([a-z-]+): ['"]?([^'"\r\n]+)['"]?$/gm)]
    .map(match => [match[1], match[2]]));
  assert.deepEqual(values, { 'minimum-size': '32GB', 'maximum-size': '32GB', 'disk-root': 'D:' });
  const names = ['Check hosted pagefile disk capacity', 'Configure hosted pagefile', 'Verify hosted memory capacity', 'Run guarded native Cargo operation'];
  const indices = names.map(name => windows.indexOf(`      - name: ${name}`));
  assert.ok(indices.every((index, i) => index >= 0 && (i === 0 || index > indices[i - 1])));
  assert.ok(!source.slice(0, source.indexOf('\n  windows:')).includes('configure-pagefile-action'));
});

test('guard diagnostics bound owned process memory samples and retain a final snapshot before cleanup', () => {
  const native = step('Run guarded native Cargo operation').body;
  const guard = native.match(/^\$guardSource = @'\n(?<body>.*?)^'@/ms)?.groups.body;
  assert.ok(guard);
  const start = guard.indexOf('$job = $null');
  const end = guard.indexOf('$nativeSource =');
  const functions = guard.slice(start, end);
  assert.ok(functions.includes('function WriteProcessMemory'), 'missing owned-process memory diagnostics');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  try {
    const script = functions + `
$log = Join-Path $env:CODEXS_PROBE_ROOT 'memory.log'
$job = New-Object psobject
$job | Add-Member ScriptMethod ActiveProcessIds { return (1..16) }
$stamp = [datetime]::UtcNow
foreach ($id in 1..15) { $seen[$id] = @{ ticks=$stamp.Ticks } }
function Get-Process($Id) {
  if ($Id -eq 15) { return $null }
  $started = if ($Id -eq 14) { $stamp.AddSeconds(1) } else { $stamp }
  [pscustomobject]@{ Id=$Id; StartTime=$started; ProcessName='synthetic'; PrivateMemorySize64=($Id * 1MB); WorkingSet64=($Id * 2MB); PeakWorkingSet64=($Id * 3MB) }
}
WriteProcessMemory
WriteProcessMemory
WriteProcessMemory -Force
`;
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';\n" + script, 'utf16le').toString('base64')],
      { env: { ...process.env, CODEXS_PROBE_ROOT: directory }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(path.join(directory, 'memory.log'), 'utf8').split(/\r?\n/).filter(line => line.includes('process_memory '));
    assert.equal(lines.length, 16, 'two snapshots of eight; the immediate periodic call must be throttled');
    const ids = lines.slice(0, 8).map(line => Number(line.match(/pid=(\d+)/)?.[1]));
    assert.deepEqual(ids, [13, 12, 11, 10, 9, 8, 7, 6], 'only highest owned live identities belong in the bounded snapshot');
    assert.match(lines[0], /private_bytes=13631488 working_set_bytes=27262976 peak_working_set_bytes=40894464/);
    const loop = guard.slice(guard.indexOf('while ($true)'));
    assert.ok(loop.indexOf('WriteProcessMemory') >= 0 && loop.indexOf('WriteProcessMemory') < loop.indexOf('CheckResources'));
    const final = guard.slice(guard.indexOf('} finally {', guard.indexOf('GUARD_STOP')));
    assert.ok(final.indexOf('WriteProcessMemory -Force') >= 0 && final.indexOf('WriteProcessMemory -Force') < final.indexOf('$job.Dispose()'));
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe diagnostics test cleanup');
    fs.rmSync(directory, { recursive: true });
  }
});

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

test('Windows dependency checkout fits the legacy path limit with the selected Cargo home', () => {
  const windows = source.slice(source.indexOf('\n  windows:'));
  const env = windows.split('    env:')[1]?.split('    steps:')[0];
  const value = env?.match(/^      CARGO_HOME: (.+)$/m)?.[1].trim();
  const home = value?.replace(/^(['"])(.*)\1$/, '$2') || 'C:\\Users\\synthetic-runner\\.cargo';
  const relative = path.win32.join(
    `git/checkouts/rusty_v8-${'a'.repeat(16)}`, 'bbbbbbb',
    'third_party/rust/chromium_crates_io/vendor/icu_calendar-v2/src/tests/snapshots',
    'icu_calendar__tests__date_arithmetic_snapshot__date_add_snapshot__date_add_snapshot_Ethiopian (Amete Alem).snap',
  );
  assert.ok(path.win32.isAbsolute(home), 'Cargo home must be an absolute Windows path');
  assert.ok(path.win32.join(home, relative).length < 260,
    'nested dependency checkout exceeds the Windows legacy path limit');
});

test('Cargo cache restore and save use the active home without caching checkouts or builds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  try {
    const active = path.join(directory, 'active-cargo');
    const legacy = path.join(directory, 'legacy-user');
    const expected = ['registry/index', 'registry/cache', 'git/db'].map(part => path.join(active, part));
    for (const folder of expected) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'synthetic-download'), 'synthetic cached download');
    }
    for (const name of ['Restore Cargo downloads only', 'Save Cargo downloads only']) {
      const section = source.split(new RegExp(`^      - name: ${name}\\r?\\n`, 'm'))[1]?.split(/\r?\n      - name:/)[0];
      assert.ok(section, `missing ${name}`);
      const block = section.split('          path: |')[1]?.split(/^          \S/m)[0];
      assert.ok(block, `missing cache paths for ${name}`);
      const folders = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(input => {
        const expanded = input.replace(/\$\{\{\s*env.CARGO_HOME\s*\}\}/g, active).replace(/^~(?=[\\/])/, legacy);
        assert.ok(!expanded.includes('${{'), 'unresolved cache path binding');
        return path.normalize(expanded);
      });
      assert.deepEqual(folders.sort(), [...expected].sort(), `${name} must follow the active Cargo home`);
      assert.ok(folders.every(folder => fs.existsSync(path.join(folder, 'synthetic-download'))));
    }
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe cache test cleanup');
    fs.rmSync(directory, { recursive: true });
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

test('built CLI smoke gate rejects bad diagnostics and preserves isolated sentinels', async t => {
  const runner = step('Run guarded native Cargo operation').body.match(/^\$runnerSource = @'\n(?<body>.*?)^'@/ms)?.groups.body;
  const gate = runner?.match(/(?<body>^function Invoke-CodexsSmokeGate \{.*?)(?=^# End codexs smoke gate)/ms)?.groups.body;
  assert.ok(gate, 'missing executable CLI smoke gate');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const binary = path.join(directory, 'synthetic-cli.exe');
  const run = (script, extra = {}) => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, RUNNER_TEMP: directory, CODEXS_TEST_BINARY: binary, ...extra }, windowsHide: true, encoding: 'utf8', timeout: 25000 });
  try {
    const compile = run(String.raw`$ErrorActionPreference='Stop'
Add-Type -OutputType ConsoleApplication -OutputAssembly $env:CODEXS_TEST_BINARY -TypeDefinition @'
using System;
using System.IO;
public class SmokeBoundaryProbe {
  public static int Main(string[] args) {
    string mode = Environment.GetEnvironmentVariable("CODEXS_TEST_SMOKE_MODE");
    File.AppendAllText(Environment.GetEnvironmentVariable("CODEXS_TEST_ARGS"), string.Join("|", args) + "\n");
    if (args.Length == 1) {
      Console.Error.WriteLine("SMOKE_ARGS"); return mode == "missing-zero" ? 0 : 1;
    }
    if (Array.IndexOf(args, "--unknown") >= 0) {
      Console.Error.WriteLine("SMOKE_ARGS"); return mode == "unknown-zero" ? 0 : 1;
    }
    string formatter = args[Array.IndexOf(args, "--formatter") + 1];
    if (Path.GetFileName(formatter).StartsWith("wrong")) {
      Console.Error.WriteLine(mode == "private-error" ? "private failure with path" : "SMOKE_OUTPUT");
      return mode == "failure-zero" ? 0 : 1;
    }
    if (mode == "sentinel-write") File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("CODEX_HOME"), "auth.json"), "changed");
    string output = "{\"schema\":1,\"runner\":\"ok\",\"formatter\":\"ok\",\"cleanup\":\"ok\"}";
    if (mode == "malformed") output = "{";
    if (mode == "wrong-json") output = "{\"schema\":1,\"runner\":\"ok\",\"formatter\":\"ok\",\"cleanup\":\"failed\"}";
    Console.WriteLine(output);
    if (mode == "extra") Console.WriteLine(output);
    return mode == "nonzero" ? 9 : 0;
  }
}
'@`);
    assert.equal(compile.status, 0, compile.stderr);
    for (const mode of ['good', 'extra', 'malformed', 'wrong-json', 'nonzero', 'missing-zero', 'unknown-zero', 'failure-zero', 'private-error', 'sentinel-write']) {
      await t.test(mode, () => {
        const record = path.join(directory, `${mode}.args`);
        const result = run("$ErrorActionPreference='Stop'\n" + gate + '\nInvoke-CodexsSmokeGate $env:CODEXS_TEST_BINARY',
          { CODEXS_TEST_SMOKE_MODE: mode, CODEXS_TEST_ARGS: record });
        if (mode === 'good') {
          const diagnostic = fs.readdirSync(directory).filter(name => name.startsWith('codexs-smoke-gate-')).flatMap(name =>
            fs.readdirSync(path.join(directory, name)).filter(file => /\.(out|err)$/.test(file)).map(file =>
              [file, fs.readFileSync(path.join(directory, name, file), 'utf8')]));
          assert.equal(result.status, 0, result.stderr + JSON.stringify(diagnostic));
          const args = fs.readFileSync(record, 'utf8').trim().split('\n');
          assert.equal(args.length, 4);
          assert.ok(args[0].startsWith('codexs-smoke|--node|'));
          assert.ok(args[0].includes('|--formatter|'));
          assert.equal(args[1], 'codexs-smoke');
          assert.ok(args[2].endsWith('|--unknown'));
        } else assert.notEqual(result.status, 0, `gate accepted ${mode}`);
      });
    }
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe smoke test cleanup');
    fs.rmSync(directory, { recursive: true });
  }
});
