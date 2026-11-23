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

function fixtureTempRoot() {
  return require('node:fs').realpathSync.native(require('node:os').tmpdir());
}
module.exports.fixtureTempRoot = fixtureTempRoot;

async function launchInstallation(t, { special = false } = {}) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { generateKeyPairSync, sign } = require('node:crypto');
  const { encodeRelease } = require('../update/protocol.cjs');
  const tempRoot = fixtureTempRoot();
  const root = await fs.mkdtemp(path.join(tempRoot, special ? 'codexs-launch-test-สี %CODEXS_TRIPWIRE%! caret^ & (x)-' : 'codexs-launch-test-'));
  t.after(async () => {
    if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith('codexs-launch-test-')) throw Error('Unsafe launch test cleanup');
    await fs.rm(root, { recursive: true, maxRetries: 10, retryDelay: 100 });
  });
  const keys = generateKeyPairSync('ed25519');
  const config = { schema: 1, abi: 1, node_path: process.execPath, settings_path: path.join(root, 'settings.json'), shim_root: path.join(root, 'shims'), shim_marker: 'codexs managed shim' };
  await fs.mkdir(path.join(root, 'bootstrap'));
  await fs.writeFile(path.join(root, 'bootstrap', 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(root, 'bootstrap', 'release-public-key.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  await fs.writeFile(config.settings_path, JSON.stringify({ version: 4, lines: [], synthetic_unknown: 'preserve' }));
  const marker = path.join(root, 'imported');
  async function install(sequence = 1, { manifest = {}, payload = {} } = {}) {
    const release = { ...releaseManifest(sequence), ...manifest };
    const data = {
      'bin/codex.exe': Buffer.from('synthetic native, never executed'),
      'codex-path/rg.exe': Buffer.from('synthetic helper'),
      'codex-resources/codex-command-runner.exe': Buffer.from('synthetic runner'),
      'codex-resources/codex-windows-sandbox-setup.exe': Buffer.from('synthetic setup'),
      'formatter/dist/ccstatusline.js': Buffer.from('synthetic formatter'),
      'packages/main/package.json': Buffer.from('{}'),
      'packages/helper/package.json': Buffer.from('{}'),
      'formatter/package.json': Buffer.from('{}'),
      ...Object.fromEntries(['protocol','paths','state','http','stage'].map(name => ['update/' + name + '.cjs', Buffer.from('module.exports = {};')])),
      'update/archive.ps1': Buffer.from('# synthetic archive'),
      'update/coordinator.ps1': Buffer.from('# synthetic coordinator'),
      'update/launch.cjs': Buffer.from("require('node:fs').writeFileSync(require('node:path').join(__dirname,'..','..','..','imported'),'loaded'); exports.main = async () => 17;"),
      ...payload,
    };
    release.files = Object.entries(data).filter(([,bytes]) => bytes !== null).map(([name, bytes]) => ({ path: name, bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') })).sort((a,b) => a.path.localeCompare(b.path,'en'));
    const bytes = encodeRelease(release);
    const signature = sign(null, Buffer.concat([Buffer.from('codexs-release-v1\0'),bytes]), keys.privateKey);
    const ref = { release_id: release.release_id, sequence: release.sequence, manifest_sha256: createHash('sha256').update(bytes).digest('hex') };
    const directory = path.join(root,'versions',release.release_id);
    for(const [name,value] of Object.entries(data)) {
      if(value === null) continue;
      const file = path.join(directory,...name.split('/'));
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,value);
    }
    await fs.writeFile(path.join(directory,'release.json'),bytes);
    await fs.writeFile(path.join(directory,'release.sig'),signature);
    return { release, ref, directory };
  }
  async function writeState(current, overrides = {}) {
    const state = { ...installationState(), current, highest: { sequence: current.sequence, manifest_sha256: current.manifest_sha256 }, ...overrides };
    await fs.writeFile(path.join(root,'current.json'),encodeRelease(state));
    return state;
  }

  async function sealArchive(installation,archivePath) {
    const archive=await fs.readFile(archivePath);
    const release={...installation.release,archive:{name:'codexs-windows-x64.zip',bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}};
    const bytes=encodeRelease(release);
    const signature=sign(null,Buffer.concat([Buffer.from('codexs-release-v1\0'),bytes]),keys.privateKey);
    const ref={release_id:release.release_id,sequence:release.sequence,manifest_sha256:createHash('sha256').update(bytes).digest('hex')};
    await fs.writeFile(path.join(installation.directory,'release.json'),bytes);
    await fs.writeFile(path.join(installation.directory,'release.sig'),signature);
    return {...installation,release,ref};
  }
  return { root, config, marker, publicKey: keys.publicKey, install, writeState, sealArchive };
}
module.exports.launchInstallation = launchInstallation;

async function runtimeInstallation(t) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const base = await launchInstallation(t);
  for (const name of ['bootstrap','protocol','paths']) {
    await fs.copyFile(path.join(__dirname,'..','update',name+'.cjs'),path.join(base.root,'bootstrap',name+'.cjs'));
  }
  const operational = {};
  for (const name of ['launch','protocol','paths','state','http','stage']) {
    operational['update/'+name+'.cjs'] = await fs.readFile(path.join(__dirname,'..','update',name+'.cjs'));
  }
  for (const name of ['archive','coordinator']) {
    operational['update/'+name+'.ps1'] = await fs.readFile(path.join(__dirname,'..','update',name+'.ps1'));
  }
  return {...base,writeState:(ref,overrides={})=>base.writeState(ref,{last_check_ms:Date.now(),next_check_ms:Date.now()+3600000,...overrides}),install:(sequence=1,options={})=>base.install(sequence,{...options,payload:{...operational,...options.payload}})};
}

async function physicalStateCommit(root, state) {
  const path = require('node:path');
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const encode = text => Buffer.from(text,'utf8').toString('base64');
  const decode = text => "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encode(text)+"'))";
  const coordinator = path.join(__dirname,'..','update','coordinator.ps1');
  const protocol = path.join(__dirname,'..','update','protocol.cjs');
  const source = [
    "$ErrorActionPreference = 'Stop'",
    '. ([scriptblock]::Create([IO.File]::ReadAllText('+decode(coordinator)+')))',
    '$node='+decode(process.execPath),
    '$protocol='+decode(protocol),
    '$root='+decode(root),
    "$next=[Convert]::FromBase64String('"+Buffer.from(JSON.stringify(state)).toString('base64')+"')",
    "$validate={param([byte[]]$Bytes) $b64=[Convert]::ToBase64String($Bytes); & $node -e 'try{require(process.argv[1]).parseState(Buffer.from(process.argv[2],String.fromCharCode(98,97,115,101,54,52)))}catch{process.exit(1)}' $protocol $b64; return ($LASTEXITCODE -eq 0)}",
    "Invoke-CodexsCoordinator -Request @{mode='promote';root=$root} -Operation {param($Request,$Context) @{code='PROMOTED';nextState=$next}} -ValidateState $validate | Out-Null",
  ].join('\n');
  const shell = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  await execFile(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:65536});
}
module.exports.runtimeInstallation = runtimeInstallation;
module.exports.physicalStateCommit = physicalStateCommit;

async function probeInstallation(t) {
  const fs=require('node:fs/promises'),path=require('node:path');
  const {promisify}=require('node:util');
  const execFile=promisify(require('node:child_process').execFile);
  const f=await runtimeInstallation(t);
  const executable=path.join(f.root,'synthetic-probe.exe');
  const source=[
    'using System;using System.IO;using System.Text;using System.Threading;',
    'public class SyntheticCodexProbe {',
    'static string Encode(string x){return Convert.ToBase64String(Encoding.UTF8.GetBytes(x??""));}',
    'public static int Main(string[] args){',
    'Console.OutputEncoding=new UTF8Encoding(false);',
    'string root='+JSON.stringify(f.root)+';',
    'string control=File.Exists(Path.Combine(root,"control"))?File.ReadAllText(Path.Combine(root,"control")):"ok";',
    'File.WriteAllLines(Path.Combine(root,"probe-record"),new string[]{Encode(Environment.CurrentDirectory),Encode(Environment.GetEnvironmentVariable("HOME")),Encode(Environment.GetEnvironmentVariable("CODEX_HOME")),(Environment.GetEnvironmentVariable("SYNTHETIC_SECRET")!=null).ToString(),ProcessId(),String.Join("|",Array.ConvertAll(args,Encode)),Encode(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName),Encode(Environment.GetEnvironmentVariable("TEMP")),Encode(Environment.GetEnvironmentVariable("TMP"))});',
    'if(control=="timeout"){Thread.Sleep(10000);return 99;}',
    'if(control=="oversized"){Console.Write(new String((char)120,9000));return 0;}',
    'if(args.Length==1&&args[0]=="--version"){',
    // Match the accepted release CLI's arg0 guard; smoke dispatch bypasses arg0.
    'string home=Environment.GetEnvironmentVariable("CODEX_HOME");',
    'string temp=Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);',
    'if(!String.IsNullOrEmpty(home))home=Path.GetFullPath(home).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);',
    'if(control=="version-warning"||!String.IsNullOrEmpty(home)&&(String.Equals(home,temp,StringComparison.OrdinalIgnoreCase)||home.StartsWith(temp+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)))Console.Error.WriteLine("WARNING: synthetic release refuses helper binaries under temporary home");',
    'Console.WriteLine(control=="bad-version"?"invalid":"codex-cli 0.166.0");return 0;}',
    'if(args.Length>0&&args[0]=="codexs-smoke"){',
    'if(control=="smoke-long-cleanup"){Thread.Sleep(21000);}',
    'if(control.StartsWith("smoke-code:")){Console.Error.WriteLine(control.Substring(11));return 1;}',
    'if(control.StartsWith("smoke-prefix:")){Console.Error.WriteLine("Error: "+control.Substring(13));return 1;}',
    'if(control=="smoke-error"){Console.Error.WriteLine("SMOKE_OUTPUT");return 1;}',
    'if(control=="smoke-extra"){Console.WriteLine('+JSON.stringify('{"schema":1,"runner":"ok","formatter":"ok","cleanup":"ok","extra":true}')+');return 0;}',
    'if(control=="smoke-cleanup"){Console.WriteLine('+JSON.stringify('{"schema":1,"runner":"ok","formatter":"ok","cleanup":"pending"}')+');return 0;}',
    'Console.WriteLine('+JSON.stringify('{"schema":1,"runner":"ok","formatter":"ok","cleanup":"ok"}')+');return 0;}',
    'File.WriteAllText(Path.Combine(root,"native-launch-"+ProcessId()),"synthetic");',
    'return control=="cli-exit23"?23:2;',
    '}static string ProcessId(){return System.Diagnostics.Process.GetCurrentProcess().Id.ToString();}}',
  ].join('\n');
  const data=x=>Buffer.from(x,'utf8').toString('base64');
  const script=[
    "$ErrorActionPreference='Stop'",
    "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data(source)+"'))",
    "$file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data(executable)+"'))",
    "Add-Type -AssemblyName Microsoft.CSharp",
    "$compiler=[Microsoft.CSharp.CSharpCodeProvider]::new();$options=[CodeDom.Compiler.CompilerParameters]::new()",
    "$options.GenerateExecutable=$true;$options.GenerateInMemory=$false;$options.OutputAssembly=$file;$options.CompilerOptions='/platform:x64'",
    "[void]$options.ReferencedAssemblies.Add('System.dll')",
    "try{$result=$compiler.CompileAssemblyFromSource($options,$source);if($result.Errors.HasErrors){throw 'SYNTHETIC_COMPILE'}}finally{$compiler.Dispose()}",
  ].join('\n');
  const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  await execFile(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:65536});
  const exe=await fs.readFile(executable);
  const payload={
    ...Object.fromEntries(['bin/codex.exe','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe'].map(name=>[name,exe])),
    'packages/main/package.json':Buffer.from(JSON.stringify(upstreamPackages().main)),
    'packages/helper/package.json':Buffer.from(JSON.stringify(upstreamPackages().helper)),
    'formatter/package.json':Buffer.from('{"name":"ccstatusline","version":"2.2.32","type":"module"}'),
    'formatter/dist/ccstatusline.js':Buffer.from("process.stdout.write('2.2.32'+String.fromCharCode(10));"),
  };
  return {...f,install:(sequence=1,options={})=>f.install(sequence,{...options,payload:{...payload,...options.payload}})};
}
module.exports.probeInstallation=probeInstallation;

async function tinyZip(file, files) {
  const path=require('node:path'),{promisify}=require('node:util');
  const execFile=promisify(require('node:child_process').execFile);
  const bytes=Buffer.from(JSON.stringify({file,entries:Object.entries(files).map(([name,value])=>({name,data:Buffer.from(value).toString('base64')}))}),'utf8').toString('base64');
  const script=[
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression",
    "$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+bytes+"'))|ConvertFrom-Json",
    "$stream=[IO.File]::Open($d.file,[IO.FileMode]::CreateNew);$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)",
    "try{foreach($e in $d.entries){$entry=$zip.CreateEntry($e.name);$output=$entry.Open();try{$raw=[Convert]::FromBase64String($e.data);$output.Write($raw,0,$raw.Length)}finally{$output.Dispose()}}}finally{$zip.Dispose();$stream.Dispose()}",
  ].join('\n');
  await execFile(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:65536});
}
module.exports.tinyZip=tinyZip;

async function zipDirectory(file,sourceRoot,paths) {
  const path=require('node:path'),{promisify}=require('node:util');
  const execFile=promisify(require('node:child_process').execFile);
  const data=Buffer.from(JSON.stringify({file,sourceRoot,paths}),'utf8').toString('base64');
  const script=[
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression",
    "$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json",
    "$stream=[IO.File]::Open($d.file,[IO.FileMode]::CreateNew);$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)",
    "try{foreach($name in $d.paths){$entry=$zip.CreateEntry($name);$output=$entry.Open();$entrySource=[IO.File]::OpenRead([IO.Path]::Combine($d.sourceRoot,([string]$name).Replace('/','\\')));try{$entrySource.CopyTo($output)}finally{$entrySource.Dispose();$output.Dispose()}}}finally{$zip.Dispose();$stream.Dispose()}",
  ].join('\n');
  await execFile(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:65536});
}
module.exports.zipDirectory=zipDirectory;

// Stored ZIP fixtures exercise the evidence reader without any external service or process.
function evidenceZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(local.length / 3, 8); end.writeUInt16LE(local.length / 3, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
module.exports.evidenceZip = evidenceZip;

function evidenceFixture() {
  const runs = new Map(), jobs = new Map(), artifacts = new Map(), bytes = new Map(), filesByScope = new Map(), jobLogs=new Map(), distributions=new Map();
  const candidate = { sha: 'b'.repeat(40), upstream_sha: 'a'.repeat(40), version: '0.166.0', archive:{bytes:1234,sha256:'9'.repeat(64)} };
  const formatter = { sha: 'd'.repeat(40), version: '2.2.32' };
  const refs = [];
  const totals = { quick: [77,0], updater: [442,0], installer: [46,0], formatter: [3010,19], bundle: [12,0] };
  const counts = name => ({ passed: totals[name][0], failed: 0, ignored: totals[name][1], exit: 0 });
  function update(scope,raw=evidenceZip(filesByScope.get(scope))) {
    const ref = refs.find(item => item.scope === scope);
    bytes.set(ref.artifact, raw);
    artifacts.get(ref.artifact).size_in_bytes = raw.length;
    artifacts.get(ref.artifact).digest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
    const artifact=artifacts.get(ref.artifact),stamp='2026-01-01T00:00:00.0000000Z ';
    jobLogs.set(ref.job,[artifact,...(scope==='build'?[artifacts.get(ref.binary_artifact)]:[]),...(distributions.has(scope)?[distributions.get(scope)]:[])].map(upload=>[
      '##[group]Run actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f',
      '  name: '+upload.name,'##[endgroup]',
      'SHA256 digest of uploaded artifact is '+upload.digest.slice(7),
      'Artifact '+upload.name+' successfully finalized. Artifact ID '+upload.id,
      'Artifact '+upload.name+' has been successfully uploaded! Final size is '+upload.size_in_bytes+' bytes. Artifact ID is '+upload.id,
    ].map(line=>stamp+line).join('\n')+'\n').join(''));
  }
  for (const [index, scope] of ['quick','feature','full','config','build','formatter','bundle'].entries()) {
    const run = 100 + index * 10, job = run + 1, artifact = run + 2;
    const native = ['feature','full','config','build'].includes(scope);
    const ref = { scope, repository: 'TK-06/codexs', run, attempt: 1, job, artifact, controller_sha: 'c'.repeat(40), validation_id: 'fixture' };
    if(scope==='build')ref.binary_artifact=run+3;
    refs.push(ref);
    runs.set(run, { id: run, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40), path: '.github/workflows/codexs-statusline.yml', event: 'workflow_dispatch', repository: { full_name: 'TK-06/codexs' } });
    jobs.set(job, { id: job, run_id: run, run_attempt: 1, head_sha:'c'.repeat(40), status: 'completed', conclusion: 'success', name: native ? `Windows (${scope})` : {quick:'Quick workflow and status-line formatting checks',formatter:'Pinned formatter acceptance',bundle:'Extracted Windows bundle acceptance'}[scope], steps: [{ name: native ? 'Run guarded native Cargo operation' : 'Record complete acceptance', status: 'completed', conclusion: 'success' }] });
    artifacts.set(artifact, { id: artifact, name: `${native ? 'codexs-statusline' : 'codexs-task9'}-${scope}-fixture-${run}-1`, expired: false, workflow_run: { id: run, head_sha: 'c'.repeat(40) } });
    if(scope==='build'){
      const raw=evidenceZip({'codex.exe':'synthetic native, never executed'});bytes.set(ref.binary_artifact,raw);
      artifacts.set(ref.binary_artifact,{id:ref.binary_artifact,name:`codexs-cli-fixture-${run}-1`,expired:false,size_in_bytes:raw.length,digest:'sha256:'+createHash('sha256').update(raw).digest('hex'),workflow_run:{id:run,head_sha:'c'.repeat(40)}});
    }
    let files;
    if (native) {
      const [passed, ignored] = { feature:[150,0], full:[6004,8], config:[403,0], build:[0,0] }[scope];
      files = {
        'outcome.txt': `scope=${scope} source=${candidate.sha} native_exit=0 passed=${passed} failed=0 ignored=${ignored} total=${passed+ignored} guard_stop=none wrapper=\n`,
        'setup.log': `preflight_started scope=${scope}\nsource=${candidate.sha} scope=${scope} rust=rustc 1.95.0 target=synthetic-target\n`,
        'guard-state.json': JSON.stringify({ scope, source_sha: candidate.sha, workspace_version: candidate.version }),
        'native-exit.txt': '0\n',
        'cargo.log': scope === 'build' ? '    Finished `release` profile [optimized] target(s) in 10.00s\ncli_version_exit=0 output=codex-cli 0.166.0\n' : `test result: ok. ${passed} passed; 0 failed; ${ignored} ignored; 0 measured; 0 filtered out; finished in 1.00s\n`,
      };
    } else {
      const names = scope === 'quick' ? ['quick','updater','installer'] : [scope];
      files = { 'acceptance.json': JSON.stringify({schema:1,scope,candidate_sha:candidate.sha,upstream_sha:candidate.upstream_sha,formatter_sha:formatter.sha,controller_sha:ref.controller_sha,suites:Object.fromEntries(names.map(name => [name,counts(name)])),build_exit:null}) };
      if (scope === 'quick') {
        files['quick.log'] = 'RESULT passed=77 failed=0\n';
        files['installer.log'] = 'Installer assertions: 46 passed; 0 failed\n';
        files['updater.log'] = '# tests 389\n# pass 389\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# codexs verified suites 10\nArchive assertions: 16 passed; 0 failed\nCoordinator assertions: 18 passed; 0 failed\nEnrollment assertions: 19 passed; 0 failed\n';
      } else if (scope === 'formatter') {
        files['tests.log'] = 'bun test v1.3.11\n 3010 pass\n 19 skip\n 0 fail\nRan 3029 tests across 150 files. [2.00s]\n';
        files['checks.log'] = 'lint_exit=0\nbuild_exit=0\n';
      } else {
        const receipt=JSON.parse(files['acceptance.json']);receipt.archive={...candidate.archive};files['acceptance.json']=JSON.stringify(receipt);
        files['bundle.log'] = 'Bundle assertions: 12 passed; 0 failed\n';
      }
    }
    if(native) {
      const command={
        feature:'test --release --locked -p codex-tui --config profile.release.package.codex-tui.opt-level=1 --timings --lib status_line_command',
        full:'test --release --locked -p codex-tui --config profile.release.package.codex-tui.opt-level=1 --timings --no-fail-fast -- --test-threads=1',
        config:'test --release --locked -p codex-config --timings --no-fail-fast',
        build:'build --release --locked -p codex-cli --bin codex --timings',
      }[scope];
      files['cargo.log']='scope='+scope+' source='+candidate.sha+' rust=1.95.0 jobs=1 release=true locked=true lto=off debug=0 tui_opt='+(scope==='config'?'n/a':'1')+' native_command=synthetic/rustup.exe run 1.95.0 cargo '+command+'\n'+files['cargo.log'];
    }
    filesByScope.set(scope, files); update(scope);
  }
  function addDistributionArtifact(scope,files) {
      const ref=refs.find(item=>item.scope===scope),id=ref.artifact+1000,raw=evidenceZip(files);
      const artifact={...structuredClone(artifacts.get(ref.artifact)),id,name:`codexs-${scope==='formatter'?'formatter-dist':'bundle-draft'}-${ref.validation_id}-${ref.run}-${ref.attempt}`,size_in_bytes:raw.length,digest:'sha256:'+createHash('sha256').update(raw).digest('hex')};
      artifacts.set(id,artifact);bytes.set(id,raw);distributions.set(scope,artifact);update(scope);return id;
  }
  const formatterArtifact=addDistributionArtifact('formatter',{'dist/ccstatusline.js':'synthetic formatter default','package.json':'{}',LICENSE:'synthetic license'});
  const publicRef=ref=>Object.fromEntries(['repository','run','attempt','job','artifact'].map(key=>[key,ref[key]]));
  function sealBundleInputs(pre,artifact=formatterArtifact) {
    const format=refs.find(ref=>ref.scope==='formatter'),receipt=JSON.parse(filesByScope.get('bundle')['acceptance.json']);
    receipt.inputs={pre_evidence_sha256:createHash('sha256').update(require('../update/protocol.cjs').encodeRelease(pre)).digest('hex'),formatter_artifact:{...publicRef(format),artifact}};
    filesByScope.get('bundle')['acceptance.json']=JSON.stringify(receipt);update('bundle');
  }
  sealBundleInputs({
    candidate_sha:candidate.sha,upstream_sha:candidate.upstream_sha,formatter_sha:formatter.sha,
    runs:refs.filter(ref=>ref.scope!=='bundle').flatMap(ref=>[publicRef(ref),...(ref.scope==='build'?[{...publicRef(ref),artifact:ref.binary_artifact}]:[])]),
    suites:{quick:counts('quick'),updater:counts('updater'),installer:counts('installer'),feature:{passed:150,failed:0,ignored:0,exit:0},full:{passed:6004,failed:0,ignored:8,exit:0},config:{passed:403,failed:0,ignored:0,exit:0},formatter:counts('formatter')},build_exit:0,
  });
  return {
    input: { candidate, formatter, runs: refs }, runs, jobs, artifacts, bytes,jobLogs,
    addDistributionArtifact,sealBundleInputs,
    replaceFiles(scope, change) { change(filesByScope.get(scope)); update(scope); },
    setArtifactBytes(scope,raw){update(scope,raw);},
    github: {
      controllerSha:'c'.repeat(40),
      async getRun(repository, id) { assertRepository(repository); return structuredClone(runs.get(id)); },
      async getJob(repository, id) { assertRepository(repository); return structuredClone(jobs.get(id)); },
      async getArtifact(repository, id) { assertRepository(repository); return structuredClone(artifacts.get(id)); },
      async getJobLog(repository,id){assertRepository(repository);return jobLogs.get(id);},
      async downloadArtifact(repository, id) { assertRepository(repository); return bytes.get(id); },
    },
  };
  function assertRepository(value) { if (value !== 'TK-06/codexs') throw Error('Unexpected fixture repository'); }
}
module.exports.evidenceFixture = evidenceFixture;
