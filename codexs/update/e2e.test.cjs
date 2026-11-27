'use strict';

// Only the HTTPS transport and available-disk observation are injected. Enrollment,
// signatures, shims, detached workers, locking, extraction, probes and launches are real.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { runtimeInstallation, zipDirectory, physicalStateCommit, upstreamPackages, evidenceZip } = require('../test-support/update-fixtures.cjs');
const { verifyInventory, hashFile } = require('./paths.cjs');
const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psText = text => Buffer.from(text, 'utf16le').toString('base64');
const dataText = value => Buffer.from(JSON.stringify(value)).toString('base64');
const psData = value => "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + dataText(value) + "'))|ConvertFrom-Json)";
const ps = (source, options = {}) => execute(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', psText("$ErrorActionPreference='Stop';" + source)], { windowsHide: true, timeout: 30000, maxBuffer: 131072, ...options });

async function until(read, label, timeout = 120000) {
  const end = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
  throw Error('E2E_DEADLINE: ' + label);
}

async function awaitCommandExit(command, context, timers = { setTimeout, clearTimeout }) {
  // This fixture includes launcher startup and post-coordination verification.
  // Preserve the inner 70-second product limit; allow 50 seconds around it.
  const budget = require('./launch.cjs').limits.outerLocal + 50000, started = performance.now();
  let timer;
  try {
    return await Promise.race([command.exit, new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        const observed = command.observation?.() || {}, integer = value => Number.isSafeInteger(value) ? value : null;
        // Fixed test labels and numeric process metadata only: no argv, paths,
        // environment or captured stdout/stderr content enters a failure report.
        const detail = {
          stage: /^[a-z0-9-]{1,64}$/.test(context.stage) ? context.stage : 'unknown',
          mode: ['cli', 'editor'].includes(context.mode) ? context.mode : 'unknown',
          operation: ['--help', '--version', '-V', 'update-status', 'rollback', '--synthetic-invalid-option', 'editor'].includes(context.operation) ? context.operation : 'other',
          shell: ['cmd', 'powershell'].includes(context.shell) ? context.shell : 'unknown', invocation: integer(context.invocation),
          budget_ms: budget, elapsed_ms: Math.round(performance.now() - started),
          pid: integer(observed.pid), exit_code: integer(observed.exit_code), stdout_bytes: integer(observed.stdout_bytes), stderr_bytes: integer(observed.stderr_bytes),
        };
        const error = Error('E2E_COMMAND_DEADLINE ' + JSON.stringify(detail)); error.code = 'E2E_COMMAND_DEADLINE'; reject(error);
      }, budget);
    })]);
  } finally { timers.clearTimeout(timer); }
}

function commandClock() {
  let now = 0, next = 0;
  const pending = new Map();
  return {
    timers: { setTimeout(callback, delay) { const id = ++next; pending.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { pending.delete(id); } },
    advance(ms) { now += ms; for (const [id, timer] of pending) if (timer.at <= now) { pending.delete(id); timer.callback(); } },
    remaining() { return pending.size; },
  };
}

test('command watchdog allows coordinator completion after bounded launcher startup', async () => {
  const clock = commandClock(); let finish;
  const exit = new Promise(resolve => { finish = resolve; });
  const result = assert.doesNotReject(awaitCommandExit({ exit }, { stage: 'adopt-b-launch', mode: 'cli', operation: '--help', shell: 'cmd', invocation: 2 }, clock.timers));
  // The inner coordinator is allowed 70 seconds, after launcher startup.
  clock.advance(require('./launch.cjs').limits.outerLocal + 30000);
  finish({ code: 0, signal: null, stdout: '', stderr: '' });
  await result;
  assert.equal(clock.remaining(), 0);
});

test('command watchdog identifies the stalled stage with bounded process metadata', async () => {
  const clock = commandClock(), exit = new Promise(() => {});
  const observed = awaitCommandExit({ exit, observation: () => ({ pid: 123, exit_code: 0, stdout_bytes: 37, stderr_bytes: 11, stdout: 'synthetic-private-output', path: 'synthetic-private-path' }) },
    { stage: 'corrupt-c-check', mode: 'cli', operation: '--help', shell: 'cmd', invocation: 3 }, clock.timers).catch(error => error);
  clock.advance(120000);
  const error = await observed;
  assert.equal(error.code, 'E2E_COMMAND_DEADLINE');
  const detail = JSON.parse(error.message.slice(error.code.length + 1));
  assert.equal(detail.stage, 'corrupt-c-check'); assert.equal(detail.invocation, 3);
  assert.equal(detail.mode, 'cli'); assert.equal(detail.operation, '--help'); assert.equal(detail.shell, 'cmd');
  assert.equal(detail.pid, 123); assert.equal(detail.exit_code, 0);
  assert.equal(detail.stdout_bytes, 37); assert.equal(detail.stderr_bytes, 11);
  assert.ok(error.message.length <= 1024); assert.doesNotMatch(error.message, /synthetic-private/);
  assert.equal(clock.remaining(), 0);
});

test('command watchdog preserves a completed child exit and releases its timer', async () => {
  const clock = commandClock();
  const result = await awaitCommandExit({ exit: Promise.resolve({ code: 17, signal: null, stdout: '', stderr: '' }) },
    { stage: 'launch', mode: 'cli', operation: 'other', shell: 'cmd', invocation: 1 }, clock.timers);
  assert.deepEqual(result, { code: 17, signal: null, stdout: '', stderr: '' });
  assert.equal(clock.remaining(), 0);
});

async function fixtureRelease(f, sequence, { manifest = {}, payload = {}, acceptedArchive = null } = {}) {
  const version = manifest.product_version || '1.0.0', upstream = manifest.upstream?.version || '0.166.0';
  const value = await f.install(sequence, { manifest: { ...manifest, sequence, release_id: 'codexs-v' + version + '-codex' + upstream + '-r' + sequence }, payload });
  // Real distributions contain uppercase license names. The signed protocol
  // orders UTF-8 bytes, whereas the shared small-fixture builder uses collation.
  value.release.files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const archive = path.join(f.root, 'release-' + sequence + '.zip');
  if (acceptedArchive) {
    assert.deepEqual(value.release.files, acceptedArchive.files, 'accepted ZIP payload inventory must match the signed release');
    // Sequence and signatures are sidecars; the verified payload stays identical.
    // Recompressing a real CLI for each fixture exceeds the small ZIP helper cap.
    await fs.copyFile(acceptedArchive.path, archive, fs.constants.COPYFILE_EXCL);
    assert.equal(await hashFile(archive, acceptedArchive.bytes, 'BUNDLE_HASH'), acceptedArchive.sha256);
  } else {
    await zipDirectory(archive, value.directory, value.release.files.map(item => item.path));
  }
  return { ...await f.sealArchive(value, archive), archive };
}

async function acceptedArchiveFixture(t) {
  const f = await runtimeInstallation(t), payload = { 'notes/synthetic.txt': Buffer.from('accepted fixture payload') };
  const seed = await f.install(1, { payload });
  seed.release.files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const files = Object.fromEntries(await Promise.all(seed.release.files.map(async item => [item.path, await fs.readFile(path.join(seed.directory, item.path))])));
  // Stored entries deliberately differ from the deflated ZIP builder. Repacking
  // identical payloads cannot accidentally satisfy the exact-byte regression.
  const bytes = evidenceZip(files), archive = path.join(f.root, 'accepted.zip');
  await fs.writeFile(archive, bytes);
  return { f, payload, bytes, acceptedArchive: { path: archive, bytes: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'), files: seed.release.files } };
}

test('fixture archive reuses accepted bytes while signing distinct A B C releases', async t => {
  const { f, payload, bytes, acceptedArchive } = await acceptedArchiveFixture(t);
  const refs = new Set(), signatures = new Set();
  for (const sequence of [1, 2, 3]) {
    const value = await fixtureRelease(f, sequence, { payload, acceptedArchive });
    assert.ok((await fs.readFile(value.archive)).equals(bytes), 'accepted ZIP bytes must be reused without recompression');
    assert.equal(value.release.archive.bytes, bytes.length); assert.equal(value.release.archive.sha256, acceptedArchive.sha256);
    const manifest = await fs.readFile(path.join(value.directory, 'release.json')), signature = await fs.readFile(path.join(value.directory, 'release.sig'));
    assert.equal(JSON.parse(manifest).sequence, sequence);
    assert.equal(JSON.parse(manifest).release_id, 'codexs-v1.0.0-codex0.166.0-r' + sequence);
    assert.equal(require('node:crypto').verify(null, Buffer.concat([Buffer.from('codexs-release-v1\0'), manifest]), f.publicKey, signature), true);
    refs.add(value.ref.manifest_sha256); signatures.add(signature.toString('hex'));
  }
  assert.equal(refs.size, 3); assert.equal(signatures.size, 3);
});

test('fixture archive rejects accepted bytes paired with a different payload inventory', async t => {
  const { f, payload, acceptedArchive } = await acceptedArchiveFixture(t);
  await assert.rejects(fixtureRelease(f, 2, { payload: { ...payload, 'notes/synthetic.txt': Buffer.from('changed fixture payload') }, acceptedArchive }), { code: 'ERR_ASSERTION' });
});

test('fixture archive rejects accepted source bytes changed after verification', async t => {
  const { f, payload, bytes, acceptedArchive } = await acceptedArchiveFixture(t);
  const altered = Buffer.from(bytes); altered[0] ^= 1; await fs.writeFile(acceptedArchive.path, altered);
  await assert.rejects(fixtureRelease(f, 2, { payload, acceptedArchive }), { code: 'ERR_ASSERTION' });
});

test('fixture archive still builds synthetic payloads and refuses to overwrite an existing ZIP', async t => {
  const f = await runtimeInstallation(t), payload = { 'notes/synthetic.txt': Buffer.from('synthetic ZIP contents') };
  const value = await fixtureRelease(f, 1, { payload });
  const result = await ps('Add-Type -AssemblyName System.IO.Compression.FileSystem;$d=' + psData({ archive: value.archive }) + ';$zip=[IO.Compression.ZipFile]::OpenRead($d.archive);try{$reader=[IO.StreamReader]::new($zip.GetEntry("notes/synthetic.txt").Open());try{[Console]::Out.WriteLine($reader.ReadToEnd())}finally{$reader.Dispose()}}finally{$zip.Dispose()}');
  assert.equal(result.stdout.trim(), 'synthetic ZIP contents');
  await assert.rejects(fixtureRelease(f, 1, { payload }));
});

// This preload lives only in owned test scratch. It supplies GitHub-shaped bytes to
// the unmodified production client in separate processes; it cannot select a feed.
function transportPreload() {
  const fs = require('node:fs'), https = require('node:https');
  const { Readable } = require('node:stream'), { EventEmitter } = require('node:events');
  const file = process.env.CODEXS_E2E_TRANSPORT;
  const config = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = value => fs.appendFileSync(config().log, JSON.stringify({ pid: process.pid, ...value }) + '\n');
  record({ type: 'start', role: process.argv[2], file: process.argv[1] });
  process.once('exit', code => record({ type: 'exit', code }));
  const cp = require('node:child_process'), originalSpawn = cp.spawn;
  cp.spawn = function (file, args, options) {
    const child = originalSpawn.call(this, file, args, options);
    child.once('spawn', () => record({ type: 'spawn', child: child.pid, file, args }));
    return child;
  };
  const originalStat = fs.promises.statfs;
  fs.promises.statfs = async (...args) => {
    const c = config();
    if (c.lowDisk) return { bsize: 4096n, bavail: 0n };
    if (c.synthetic) return { bsize: 4096n, bavail: 4194304n };
    return originalStat(...args);
  };
  https.get = (url, options, callback) => {
    const request = new EventEmitter();
    let timer, stopped = false;
    const stop = () => { stopped = true; clearTimeout(timer); };
    options.signal.addEventListener('abort', stop, { once: true });
    request.destroy = stop;
    const c = config(); record({ type: 'request', url: String(url) });
    const deliver = () => {
      if (stopped) return;
      if (c.gate && !fs.existsSync(c.gate)) { timer = setTimeout(deliver, 25); return; }
      if (c.offline) { request.emit('error', Error('SYNTHETIC_OFFLINE')); return; }
      let bytes;
      if (url === 'https://api.github.com/repos/TK-06/codexs/releases/latest') {
        bytes = Buffer.from(JSON.stringify({ draft: false, prerelease: false, assets: [
          { id: 11, name: 'release.json', size: fs.statSync(c.manifest).size },
          { id: 12, name: 'release.sig', size: 64 },
          { id: 13, name: 'codexs-windows-x64.zip', size: c.advertisedBytes || fs.statSync(c.archive).size },
        ] }));
      } else {
        const files = { 'https://api.github.com/repos/TK-06/codexs/releases/assets/11': c.manifest,
          'https://api.github.com/repos/TK-06/codexs/releases/assets/12': c.signature,
          'https://api.github.com/repos/TK-06/codexs/releases/assets/13': c.archive };
        if (!files[url]) { request.emit('error', Error('UNEXPECTED_NETWORK')); return; }
        bytes = fs.readFileSync(files[url]);
      }
      const response = Readable.from([bytes]); response.statusCode = 200;
      response.headers = { 'content-length': String(bytes.length) }; callback(response);
    };
    setImmediate(deliver); return request;
  };
}

async function syntheticPayload(root) {
  const executable = path.join(root, 'synthetic-native.exe');
  const source = [
    'using System;using System.Text;public class OfflineFixture {public static int Main(string[] a){',
    'Console.OutputEncoding=new UTF8Encoding(false);',
    'if(Array.IndexOf(a,"--version")>=0){Console.WriteLine("codex-cli 0.166.0");return 0;}',
    'if(Array.IndexOf(a,"codexs-smoke")>=0){Console.WriteLine("{\\"schema\\":1,\\"runner\\":\\"ok\\",\\"formatter\\":\\"ok\\",\\"cleanup\\":\\"ok\\"}");return 0;}',
    'if(Array.IndexOf(a,"app-server")>=0){string l;while((l=Console.ReadLine())!=null){if(l.Contains("\\"id\\":1"))Console.WriteLine("{\\"id\\":1,\\"result\\":{\\"userAgent\\":\\"synthetic\\"}}");if(l.Contains("\\"id\\":2"))Console.WriteLine("{\\"id\\":2,\\"result\\":{\\"config\\":{}}}");Console.Out.Flush();}return 0;}',
    'if(Array.IndexOf(a,"--help")>=0){Console.WriteLine("Usage: synthetic codex");return 0;}return 2;}}',
  ].join('\n');
  await ps('$d=' + psData({ executable, source }) + ';Add-Type -AssemblyName Microsoft.CSharp;$c=[Microsoft.CSharp.CSharpCodeProvider]::new();$o=[CodeDom.Compiler.CompilerParameters]::new();$o.GenerateExecutable=$true;$o.OutputAssembly=$d.executable;$o.CompilerOptions="/platform:x64";[void]$o.ReferencedAssemblies.Add("System.dll");try{$r=$c.CompileAssemblyFromSource($o,$d.source);if($r.Errors.HasErrors){throw ($r.Errors|Out-String)}}finally{$c.Dispose()}');
  const binary = await fs.readFile(executable);
  return {
    ...Object.fromEntries(['bin/codex.exe', 'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'].map(name => [name, binary])),
    'packages/main/package.json': Buffer.from(JSON.stringify(upstreamPackages().main)),
    'packages/helper/package.json': Buffer.from(JSON.stringify(upstreamPackages().helper)),
    'formatter/package.json': Buffer.from('{"name":"ccstatusline","type":"module","version":"2.2.32"}'),
    'formatter/LICENSE': Buffer.from('Synthetic fixture license\n'),
    'formatter/dist/ccstatusline.js': Buffer.from("if(process.argv.includes('--version'))console.log('2.2.32');else{process.stdin.resume();process.stdin.on('end',()=>process.exit(0));}"),
  };
}

async function makeFixture(t) {
  const cleanup = [], sessions = [];
  let fixture;
  t.after(async () => {
    if (fixture) {
      for (const child of sessions) child.stdin.end();
      await fixture.stopOwned();
    }
    for (const action of cleanup.reverse()) await action();
  });
  const f = await runtimeInstallation({ after: action => cleanup.push(action) });
  const installed = path.join(f.root, 'installed'), shims = path.join(f.root, 'managed shims');
  const home = path.join(f.root, 'home'), cwd = path.join(f.root, 'unrelated caller');
  const log = path.join(f.root, 'transport.jsonl'), transport = path.join(f.root, 'transport.json'), preload = path.join(f.root, 'transport.cjs');
  await fs.mkdir(cwd); await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  const sentinels = new Map([[f.config.settings_path, await fs.readFile(f.config.settings_path)],
    [path.join(home, '.codex/auth.json'), Buffer.from('{}')],
    [path.join(home, '.codex/history.jsonl'), Buffer.from('synthetic untouched history\n')],
    [path.join(home, '.claude/settings.json'), Buffer.from('{"synthetic":"unchanged"}')]]);
  for (const [file, bytes] of sentinels) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
  await fs.writeFile(log, ''); await fs.writeFile(preload, '(' + transportPreload.toString() + ')();');
  const context = process.env.CODEXS_E2E_BUNDLE_CONTEXT;
  let payload, manifest = {}, packageRoot, acceptedArchive = null;
  if (context) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'real bundle execution is hosted only');
    const { draft, work } = JSON.parse(context);
    const base = JSON.parse(await fs.readFile(path.join(draft, 'manifest-base.json')));
    assert.equal(await hashFile(path.join(draft, 'codexs-windows-x64.zip'), base.archive.bytes, 'BUNDLE_HASH'), base.archive.sha256);
    acceptedArchive = { ...base.archive, path: path.join(draft, 'codexs-windows-x64.zip'), files: base.files };
    const source = path.join(work, 'acceptance/installed/versions', 'codexs-v' + base.product_version + '-codex' + base.upstream.version + '-r1');
    await verifyInventory(source, base.files, { installed: true });
    payload = Object.fromEntries(await Promise.all(base.files.map(async item => [item.path, await fs.readFile(path.join(source, item.path))])));
    const pre = JSON.parse(await fs.readFile(path.join(work, 'pre-bundle.json')));
    manifest = { ...base, evidence: { ...pre, suites: { ...pre.suites, bundle: { passed: 1, failed: 0, ignored: 0, exit: 0 } } } };
    packageRoot = path.join(work, 'acceptance/enrollment/update');
  } else {
    payload = await syntheticPayload(f.root);
    packageRoot = path.join(f.root, 'producer/update'); await fs.mkdir(packageRoot, { recursive: true });
    for (const name of ['bootstrap.cjs', 'protocol.cjs', 'paths.cjs', 'stage.cjs', 'state.cjs', 'http.cjs', 'launch.cjs', 'archive.ps1', 'coordinator.ps1', 'enroll.ps1']) await fs.copyFile(path.join(__dirname, name), path.join(packageRoot, name));
  }
  const release = sequence => fixtureRelease(f, sequence, { manifest, payload, acceptedArchive });
  const a = await release(1), b = await release(2);
  const options = { AllowedRoot: f.root, InstallRoot: installed, AllowedShimRoot: f.root, ShimRoot: shims, PackageRoot: packageRoot,
    Bundle: a.archive, Manifest: path.join(a.directory, 'release.json'), Signature: path.join(a.directory, 'release.sig'),
    PublicKey: path.join(f.root, 'bootstrap/release-public-key.pem'), NodePath: process.execPath, SettingsPath: f.config.settings_path };
  const enrollment = await ps('$d=' + psData(options) + ';$o=@{};foreach($p in $d.PSObject.Properties){$o[$p.Name]=$p.Value};. ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $d.PackageRoot "enroll.ps1"))));$ops=Get-CodexsEnrollmentOperations;' + (!context ? '$ops.FreeBytes={param($p) return [long]17179869184};' : '') + '$r=Invoke-CodexsEnrollmentCore $o $ops -Install;if(-not $r.Installed){throw "E2E_ENROLLMENT"};[Console]::Out.WriteLine("ENROLLED")');
  assert.match(enrollment.stdout, /ENROLLED/);
  let control = { synthetic: !context, log, manifest: path.join(b.directory, 'release.json'), signature: path.join(b.directory, 'release.sig'), archive: b.archive };
  async function configure(changes = {}) { control = { ...control, ...changes }; const temporary = transport + '.new'; await fs.writeFile(temporary, JSON.stringify(control)); await fs.rename(temporary, transport); }
  await configure();
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, COMSPEC: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
    PATH: shims + path.delimiter + path.join(process.env.SystemRoot, 'System32'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), APPDATA: home, LOCALAPPDATA: home, TEMP: f.root, TMP: f.root,
    NODE_OPTIONS: '--require ' + JSON.stringify(preload.replaceAll('\\', '/')), CODEXS_E2E_TRANSPORT: transport, NO_COLOR: '1', CCSTATUSLINE_WIDTH: '80' };
  async function records() { return (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  const state = async () => JSON.parse(await fs.readFile(path.join(installed, 'current.json')));
  async function clock(overrides = {}) {
    const next = { ...await state(), last_check_ms: 0, next_check_ms: 0, failures: 0, ...overrides };
    await until(async () => { await physicalStateCommit(installed, next); return JSON.stringify(await state()) === JSON.stringify(next); }, 'clock commit', 30000);
  }
  function start(mode, args, powershell = false) {
    const command = mode === 'cli' ? 'codexs' : 'codexs-statusline';
    const child = powershell ? spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', psText('& ' + command + ' ' + args.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(' ') + ';exit $LASTEXITCODE')], { cwd, env, windowsHide: true })
      : spawn(env.COMSPEC, ['/d', '/v:off', '/s', '/c', command + '.cmd ' + args.join(' ')], { cwd, env, windowsHide: true, windowsVerbatimArguments: true });
    sessions.push(child); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 262144) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 262144) child.kill(); });
    child.stdin.on('error', () => {});
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
    return { child, exit, output: () => stdout, observation: () => ({ pid: child.pid, exit_code: child.exitCode, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr) }) };
  }
  let invocation = 0;
  async function run(mode, args, powershell = false, stage = 'launch') {
    const child = start(mode, args, powershell); child.child.stdin.end();
    return awaitCommandExit(child, { stage, mode, operation: args[0] || 'editor', shell: powershell ? 'powershell' : 'cmd', invocation: ++invocation });
  }
  async function workerAfter(before) {
    const worker = await until(async () => (await records()).slice(before).find(item => item.type === 'start' && item.role === 'worker'), 'worker start');
    await until(async () => (await records()).some(item => item.type === 'exit' && item.pid === worker.pid), 'worker exit');
    return worker;
  }
  async function stopOwned(pid) {
    // Only processes whose command line/executable names this fresh fixture are
    // eligible. Recheck creation time immediately before terminating an identity.
    const script = '$d=' + psData({ root: f.root, pid: pid || 0 }) + ';$all=@(Get-CimInstance Win32_Process);foreach($p in $all){if($d.pid -and $p.ProcessId -ne $d.pid){continue};$owned=($p.ExecutablePath -and $p.ExecutablePath.StartsWith($d.root+"\\",[StringComparison]::OrdinalIgnoreCase)) -or ($p.CommandLine -and $p.CommandLine.Contains($d.root));if(-not $owned -or $p.ProcessId -eq $PID){continue};$q=Get-CimInstance Win32_Process -Filter ("ProcessId="+$p.ProcessId);if($q -and $q.CreationDate -eq $p.CreationDate -and $q.ExecutablePath -eq $p.ExecutablePath){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}}';
    await ps(script);
  }
  fixture = { ...f, installed, shims, home, env, cwd, a, b, state, clock, configure, records, run, start, workerAfter, release, stopOwned,
    async unchanged() { for (const [file, bytes] of sentinels) assert.deepEqual(await fs.readFile(file), bytes, 'user data changed: ' + path.basename(file)); },
    async use(value, changes = {}) { await configure({ manifest: path.join(value.directory, 'release.json'), signature: path.join(value.directory, 'release.sig'), archive: value.archive, gate: null, offline: false, lowDisk: false, advertisedBytes: null, ...changes }); },
  };
  return fixture;
}

test('task11: installed commands stage and adopt signed B without replacing a live A session', { timeout: 240000 }, async t => {
  const f = await makeFixture(t);
  const gate = path.join(f.root, 'allow-feed'); await f.use(f.b, { gate }); await f.clock();
  const before = (await f.records()).length, session = f.start('cli', ['app-server']);
  session.child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codexs-e2e', version: '1.0.0' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } } }) + '\n');
  await until(() => session.output().split('\n').some(line => { try { const x = JSON.parse(line); return x.id === 1 && x.result && !x.error; } catch { return false; } }), 'A initialize');
  session.child.stdin.write('{"method":"initialized"}\n');
  await fs.writeFile(gate, 'ready'); await f.workerAfter(before);
  assert.equal((await f.state()).ready?.sequence, 2); assert.equal((await f.state()).current.sequence, 1);
  assert.equal((await f.run('cli', ['--version'], true)).code, 0);
  assert.equal((await f.state()).current.sequence, 1, 'read-only version cannot adopt');
  const launched = await f.run('cli', ['--help']); assert.equal(launched.code, 0, launched.stderr);
  assert.equal((await f.state()).current.sequence, 2); assert.equal((await f.state()).previous.sequence, 1);
  session.child.stdin.write('{"id":2,"method":"config/read","params":{"includeLayers":false}}\n');
  await until(() => session.output().split('\n').some(line => { try { const x = JSON.parse(line); return x.id === 2 && x.result && !x.error; } catch { return false; } }), 'A remains responsive');
  session.child.stdin.end(); assert.equal((await session.exit).code, 0);
  const native = (await f.records()).filter(item => item.type === 'spawn' && item.file.endsWith('codex.exe'));
  assert.ok(native.some(item => item.file.includes(f.a.ref.release_id) && item.args.includes('app-server')));
  assert.ok(native.some(item => item.file.includes(f.b.ref.release_id) && item.args.includes('--help')));
  assert.equal((await f.run('editor', ['--version'], true)).code, 0); await f.unchanged();
});

test('task11: corrupt downloaded C leaves current B usable and never executes C', { timeout: 240000 }, async t => {
  const f = await makeFixture(t); await adoptB(f);
  const c = await f.release(3), broken = path.join(f.root, 'corrupt-C.zip');
  const bytes = await fs.readFile(c.archive); bytes[0] ^= 1; await fs.writeFile(broken, bytes);
  await f.use(c, { archive: broken }); await f.clock(); const before = (await f.records()).length;
  assert.equal((await f.run('cli', ['--help'], false, 'corrupt-c-check')).code, 0); await f.workerAfter(before);
  assert.equal((await f.state()).current.sequence, 2); assert.equal((await f.state()).ready, null);
  assert.equal((await f.records()).some(item => item.type === 'spawn' && item.file.includes(c.ref.release_id)), false); await f.unchanged();
});

async function adoptB(f) {
  await f.clock(); const before = (await f.records()).length;
  assert.equal((await f.run('cli', ['--help'], false, 'stage-b-launch-a')).code, 0); await f.workerAfter(before);
  assert.equal((await f.state()).ready?.sequence, 2);
  assert.equal((await f.run('cli', ['--help'], false, 'adopt-b-launch')).code, 0); assert.equal((await f.state()).current.sequence, 2);
}

test('task11: prelaunch corruption recovers A while runtime failure requires explicit rollback without replay', { timeout: 300000 }, async t => {
  const f = await makeFixture(t); await adoptB(f);
  const before = (await f.records()).length;
  const failed = await f.run('cli', ['--synthetic-invalid-option']); assert.equal(failed.code, 2, failed.stderr);
  assert.equal((await f.state()).current.sequence, 2);
  assert.equal((await f.records()).slice(before).filter(item => item.type === 'spawn' && item.file.endsWith('codex.exe')).length, 1, 'runtime error must not replay');
  const rollback = await f.run('cli', ['rollback']); assert.equal(rollback.code, 0, rollback.stderr); assert.match(rollback.stdout, /ROLLED_BACK/);
  assert.equal((await f.state()).current.sequence, 1); assert.ok((await f.state()).rejected.includes(f.b.ref.release_id));
  // A separately enrolled installation distinguishes automatic prelaunch recovery
  // from the explicit runtime rollback above, without rewriting an immutable tree.
  const g = await makeFixture(t); await adoptB(g);
  const currentExe = path.join(g.installed, 'versions', g.b.ref.release_id, 'bin/codex.exe');
  const handle = await fs.open(currentExe, 'r+'); try { await handle.write(Buffer.from('corrupt'), 0, 7, 0); } finally { await handle.close(); }
  const launched = await g.run('cli', ['--help']); assert.equal(launched.code, 0, launched.stderr);
  assert.equal((await g.state()).current.sequence, 1); assert.ok((await g.state()).rejected.includes(g.b.ref.release_id)); await f.unchanged(); await g.unchanged();
});

test('task11: offline, clock rollback and low disk preserve launches and bounded check state', { timeout: 240000 }, async t => {
  const f = await makeFixture(t); await f.use(f.b, { offline: true }); await f.clock();
  let before = (await f.records()).length; assert.equal((await f.run('cli', ['--help'])).code, 0); await f.workerAfter(before);
  let s = await f.state(); assert.equal(s.current.sequence, 1); assert.equal(s.ready, null); assert.equal(s.failures, 1); assert.ok(s.next_check_ms > s.last_check_ms);
  const requests = (await f.records()).filter(x => x.type === 'request').length;
  assert.equal((await f.run('cli', ['update-status'])).code, 0); assert.equal((await f.run('cli', ['--help'])).code, 0);
  assert.equal((await f.records()).filter(x => x.type === 'request').length, requests, 'backoff must avoid a new network check');
  await f.use(f.b); await f.clock({ last_check_ms: Date.now() + 86400000, next_check_ms: Date.now() + 90000000 });
  before = (await f.records()).length; assert.equal((await f.run('cli', ['--help'])).code, 0); await f.workerAfter(before);
  s = await f.state(); assert.ok(s.last_check_ms <= Date.now()); assert.equal(s.current.sequence, 1);
  assert.equal((await f.records()).filter(x => x.type === 'request').length, requests, 'clock rollback must normalize before networking');
  await f.use(f.b, { lowDisk: true }); await f.clock(); before = (await f.records()).length;
  assert.equal((await f.run('cli', ['--help'])).code, 0); await f.workerAfter(before);
  assert.equal((await f.state()).ready, null); assert.equal((await f.state()).current.sequence, 1);
  assert.equal((await f.records()).filter(x => x.type === 'request').length, requests, 'low disk must stop before download'); await f.unchanged();
  await f.use(f.b, { advertisedBytes: 268435457 }); await f.clock(); before = (await f.records()).length;
  assert.equal((await f.run('cli', ['--help'])).code, 0); await f.workerAfter(before);
  assert.equal((await f.state()).ready, null); assert.equal((await f.state()).current.sequence, 1);
  const bounded = (await f.records()).slice(before).filter(x => x.type === 'request');
  assert.equal(bounded.length, 1); assert.ok(bounded[0].url.endsWith('/latest'), 'oversized asset must be rejected before download'); await f.unchanged();
});

test('task11: concurrent CLI/editor share one coordinator and worker death releases ownership for a later check', { timeout: 300000 }, async t => {
  const f = await makeFixture(t); await f.clock(); const before = (await f.records()).length;
  const [cli, editor] = await Promise.all([f.run('cli', ['--help']), f.run('editor', [])]);
  assert.equal(cli.code, 0); assert.equal(editor.signal, null); assert.doesNotMatch(editor.stderr, /codexs: (BOOTSTRAP|LAUNCH|COORDINATOR)/);
  if (process.env.CODEXS_E2E_BUNDLE_CONTEXT) { assert.equal(editor.code, 1); assert.match(editor.stderr, /interactive terminal/); }
  else assert.equal(editor.code, 0);
  assert.ok((await f.records()).slice(before).some(item => item.type === 'start' && item.file.endsWith('ccstatusline.js')), 'editor entry actually ran');
  await f.workerAfter(before); assert.equal((await f.state()).ready?.sequence, 2);
  assert.equal((await f.records()).filter(item => item.type === 'request' && item.url.endsWith('/latest')).length, 1);
  const g = await makeFixture(t), gate = path.join(g.root, 'hold-feed'); await g.use(g.b, { gate }); await g.clock();
  assert.equal((await g.run('cli', ['--help'])).code, 0);
  const request = await until(async () => (await g.records()).find(item => item.type === 'request'), 'worker reached transport');
  await g.stopOwned(request.pid); assert.equal((await g.state()).current.sequence, 1); assert.equal((await g.state()).ready, null);
  assert.equal((await g.state()).failures, 1, 'reservation must survive death');
  await g.use(g.b); await g.clock(); const resumed = (await g.records()).length;
  assert.equal((await g.run('cli', ['--help'])).code, 0); await g.workerAfter(resumed);
  assert.equal((await g.state()).ready?.sequence, 2); assert.equal((await g.run('cli', ['--help'])).code, 0); assert.equal((await g.state()).current.sequence, 2);
  await f.unchanged(); await g.unchanged();
});

test('task11: enrolled commands need neither source checkout nor development tools', { timeout: 180000 }, async t => {
  const f = await makeFixture(t); await f.clock({ last_check_ms: Date.now(), next_check_ms: Date.now() + 3600000 });
  // Resolve and validate every recursively removed producer path, all owned by f.
  for (const name of ['producer', 'bootstrap', 'versions']) {
    const target = path.resolve(f.root, name); assert.equal(path.dirname(target), f.root);
    await fs.rm(target, { recursive: true, force: true });
  }
  for (const name of ['git', 'gh', 'npm', 'bun', 'codex']) {
    await assert.rejects(execute(path.join(process.env.SystemRoot, 'System32/where.exe'), [name], { cwd: f.cwd, env: f.env, windowsHide: true, timeout: 3000 }), error => error.code === 1);
  }
  for (const mode of ['cli', 'editor']) {
    const result = await f.run(mode, ['--version'], true); assert.equal(result.code, 0, result.stderr);
  }
  assert.equal((await f.run('cli', ['--help'])).code, 0); await f.unchanged();
});

function bundleProgram() {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../../.github/workflows/codexs-statusline.yml'), 'utf8').replace(/\r\n?/g, '\n');
  const job = source.split('\n  bundle_acceptance:\n')[1]?.split('\n  final_evidence:\n')[0];
  const body = job?.split('      - name: Prove installed update and recovery\n')[1]?.split('      - name:')[0];
  const program = body?.match(/\$program=@'\n([\s\S]*?)\n *'@/);
  assert.ok(program, 'bundle acceptance must run the installed update/recovery gate');
  return program[1].replace(/^          /gm, '');
}

test('task11: bundle gate counts actual e2e assertions and rejects failure cancellation skip or an empty suite', async () => {
  const program = bundleProgram();
  for (const change of [{}, { failed: 1 }, { cancelled: 1 }, { skipped: 1 }, { todo: 1 }, { passed: 0 }]) {
    const files = new Map([['bundle.log', 'Bundle assertions: 15 passed; 0 failed\n']]); let ran = false;
    const summary = { passed: 6, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 1, ...change };
    const processFixture = { env: { GITHUB_WORKSPACE: path.resolve(__dirname, '../..'), CODEXS_BUNDLE_WORK: '/synthetic/work', CODEXS_BUNDLE_DRAFT: '/synthetic/draft' }, exitCode: 0 };
    const load = name => name === 'node:fs/promises' ? { mkdir: async () => {}, readFile: async file => files.get(path.basename(file)), writeFile: async (file, value) => files.set(path.basename(file), String(value)) }
      : name.endsWith('check-tests.cjs') ? { checkNodeSuites: async (input, ports) => { ran = true; assert.equal(input.files.length, 1); assert.ok(input.files[0].endsWith('e2e.test.cjs')); assert.ok(processFixture.env.CODEXS_E2E_BUNDLE_CONTEXT); ports.write('synthetic TAP\n'); return { suites: [{ file: input.files[0] }], summary }; } } : require(name);
    await new Function('require', 'process', 'console', program.replace('(async()=>', 'return (async()=>'))(load, processFixture, { log() {}, error() {} });
    assert.equal(ran, true);
    if (Object.keys(change).length) { assert.equal(processFixture.exitCode, 1); assert.doesNotMatch(files.get('bundle.log'), /21 passed; 0 failed/); }
    else { assert.equal(processFixture.exitCode, 0); assert.equal(files.get('bundle.log'), 'Bundle assertions: 21 passed; 0 failed\n'); assert.equal(JSON.parse(files.get('e2e-results.json')).passed, 6); }
  }
});
