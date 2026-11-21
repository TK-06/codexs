'use strict';

const path = require('node:path');
const { TextDecoder } = require('node:util');
const { UpdateError } = require('./protocol.cjs');
const { resolveOwned, readBoundedFile } = require('./paths.cjs');

const LIMITS=Object.freeze({version:5000,smoke:25000,extract:120000,local:60000,outerLocal:70000,check:900000,outerCheck:910000,validator:5000,cleanup:5000});
const fail = code => { throw new UpdateError(code); };

function footerCommand() {
  // Values are session-pinned environment data, expanded once by CMD.
  return '"%CODEXS_STATUSLINE_NODE%" "%CODEXS_STATUSLINE_ENTRY%" footer';
}

async function runFooter() {
  let context;
  try {
    const encoded=process.env.CODEXS_STATUSLINE_CONTEXT;
    if(typeof encoded!=='string' || encoded.length>16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail('FOOTER_INPUT');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)fail('FOOTER_INPUT');
    context=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
    if(Object.keys(context).sort().join(',')!=='formatter,node,settings' ||
       Object.values(context).some(value=>typeof value!=='string' || !path.isAbsolute(value) || value.includes('\0')))fail('FOOTER_INPUT');
  } catch {fail('FOOTER_INPUT');}
  const {spawn}=require('node:child_process');
  return new Promise((resolve,reject)=>{
    const child=spawn(context.node,[context.formatter,'--config',context.settings],{shell:false,windowsHide:true,stdio:'inherit'});
    const handlers=new Map(['SIGINT','SIGTERM','SIGHUP'].map(signal=>[signal,()=>{try{child.kill(signal);}catch{}}]));
    for(const [signal,handler]of handlers)process.on(signal,handler);
    const cleanup=()=>{for(const [signal,handler]of handlers)process.removeListener(signal,handler);};
    child.once('error',()=>{cleanup();reject(new UpdateError('FOOTER_IO'));});
    child.once('close',(code,signal)=>{cleanup();resolve(code===null?({SIGINT:130,SIGTERM:143,SIGHUP:129}[signal] || 1):code);});
  });
}

async function resolveLaunch({ root, mode, argv, verifiedRelease }, ports = {}) {
  if (!['cli','editor'].includes(mode) || !Array.isArray(argv) ||
      argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !ports.config) fail('LAUNCH_INPUT');
  const { config } = ports;
  const releaseRoot = resolveOwned(root,'versions/' + verifiedRelease.releaseRef.release_id);
  if (path.resolve(verifiedRelease.releaseRoot) !== releaseRoot) fail('LAUNCH_INPUT');
  let settings;
  try {
    const bytes = await readBoundedFile(config.settings_path,{maxBytes:4*1024*1024,code:'SETTINGS_HOLD'});
    settings = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  } catch { fail('SETTINGS_HOLD'); }
  if (!settings || settings.version !== 4) fail('SETTINGS_HOLD');
  const native = resolveOwned(releaseRoot,'bin/codex.exe');
  const helper = resolveOwned(releaseRoot,'codex-path');
  const formatter = resolveOwned(releaseRoot,'formatter/dist/ccstatusline.js');
  const env = {...(ports.env || process.env)};
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const inheritedPath = pathKey ? env[pathKey] : '';
  for (const key of Object.keys(env)) {
    if (['PATH','CODEX_MANAGED_BY_NPM','CODEX_MANAGED_PACKAGE_ROOT','CODEXS_STATUSLINE_NODE','CODEXS_STATUSLINE_ENTRY','CODEXS_STATUSLINE_CONTEXT'].includes(key.toUpperCase())) delete env[key];
  }
  env.PATH = helper + path.delimiter + inheritedPath;
  env.CODEXS_STATUSLINE_NODE=config.node_path;
  env.CODEXS_STATUSLINE_ENTRY=resolveOwned(releaseRoot,'update/launch.cjs');
  env.CODEXS_STATUSLINE_CONTEXT=Buffer.from(JSON.stringify({node:config.node_path,formatter,settings:config.settings_path}),'utf8').toString('base64');
  const args = mode === 'editor'
    ? [formatter,'--codex','--config',config.settings_path,...argv]
    : ['-c','tui.status_line_command.command=' + JSON.stringify(footerCommand()),...argv];
  return {file:mode === 'editor' ? config.node_path : native,args,env,cwd:ports.cwd || process.cwd(),releaseRef:verifiedRelease.releaseRef};
}

const sameRef=(a,b)=>a===null&&b===null || !!a&&!!b&&a.release_id===b.release_id&&a.sequence===b.sequence&&a.manifest_sha256===b.manifest_sha256;
const CORRUPT=['BOOTSTRAP_INVENTORY','BOOTSTRAP_PACKAGE','SIGNATURE','MANIFEST_MISMATCH','MANIFEST_SCHEMA','PATH','STATE_RECOVERY'];

async function prepareLaunch(input,ports) {
  if(typeof ports.readSnapshot!=='function' || typeof ports.verifyInstalledRelease!=='function' || !ports.publicKey)fail('BOOTSTRAP_REQUIRED');
  const verify=ref=>ports.verifyInstalledRelease({root:ports.root,releaseRef:ref},{publicKey:ports.publicKey});
  let verifiedRelease=input.verifiedRelease,snapshot=ports.snapshot || await ports.readSnapshot(ports.root);
  const rollback=verified=>coordinate({mode:'rollback',verifiedRelease:verified,expectedCurrent:snapshot.state.current},ports);
  if(input.mode==='cli' && input.argv.length===1 && input.argv[0]==='rollback'){
    if(!snapshot.state.previous || sameRef(snapshot.state.previous,snapshot.state.current))fail('NO_PREVIOUS');
    const result=await rollback(verifiedRelease);if(result.code!=='ROLLED_BACK')fail(result.code);
    (ports.write || (text=>process.stdout.write(text)))('ROLLED_BACK\n');return {handled:true,exit:0};
  }
  async function recover(predecessor,bad) {
    const started=performance.now();
    for(;;){
      const latest=await ports.readSnapshot(ports.root);
      if(!sameRef(latest.state.current,bad) && latest.state.current && !latest.state.rejected.includes(latest.state.current.release_id)){
        return {verifiedRelease:await verify(latest.state.current),snapshot:latest};
      }
      const result=await coordinate({mode:'rollback',verifiedRelease:predecessor,expectedCurrent:bad},ports);
      if(!['ROLLED_BACK','BUSY','STATE_CHANGED','NO_PREVIOUS'].includes(result.code))fail(result.code);
      const winner=await ports.readSnapshot(ports.root);
      if(!sameRef(winner.state.current,bad) && winner.state.current && !winner.state.rejected.includes(winner.state.current.release_id)){
        return {verifiedRelease:await verify(winner.state.current),snapshot:winner};
      }
      if(!['BUSY','STATE_CHANGED'].includes(result.code))fail('STATE_RECOVERY');
      if(performance.now()-started>=LIMITS.local)fail('COORDINATOR_TIMEOUT');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  if(ports.recoverPrevious)return recover(verifiedRelease,snapshot.state.current);
  if(snapshot.state.ready){
    try{await coordinate({mode:'promote',verifiedRelease},ports);}catch{}
    snapshot=await ports.readSnapshot(ports.root);
    try{
      if(!snapshot.state.current || snapshot.state.rejected.includes(snapshot.state.current.release_id))fail('STATE_RECOVERY');
      verifiedRelease=await verify(snapshot.state.current);
    }catch(error){
      if(!CORRUPT.includes(error.code) || !snapshot.state.previous || sameRef(snapshot.state.current,snapshot.state.previous) ||
         snapshot.state.rejected.includes(snapshot.state.previous.release_id))throw error;
      return recover(await verify(snapshot.state.previous),snapshot.state.current);
    }
  }
  return {verifiedRelease,snapshot};
}

function updateDue(state,now) {
  if(state.last_check_ms>now || state.next_check_ms>now+21600000)return true;
  return state.next_check_ms<=now && (state.last_check_ms===0 || now-state.last_check_ms>=3600000);
}

async function main(input, ports = {}) {
  const prepared=await prepareLaunch(input,ports);
  if(prepared.handled)return prepared.exit;
  if(typeof ports.dispatchVerified!=='function')fail('BOOTSTRAP_REQUIRED');
  return ports.dispatchVerified({...input,verifiedRelease:prepared.verifiedRelease},{...ports,snapshot:prepared.snapshot});
}

async function launchResolved(input,ports) {
  const prepared={verifiedRelease:input.verifiedRelease,snapshot:ports.snapshot};
  const plan=await resolveLaunch({...input,root:ports.root},ports);
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(plan.file,plan.args,{cwd:plan.cwd,env:plan.env,stdio:'inherit',shell:false});
    } catch { reject(new UpdateError('LAUNCH_START')); return; }
    let settled = false;
    const handlers = new Map(['SIGINT','SIGTERM','SIGHUP'].map(signal => [
      signal, () => { try { child.kill(signal); } catch { /* Already-exited children need no action. */ } },
    ]));
    const cleanup = () => { for (const [signal,handler] of handlers) process.removeListener(signal,handler); };
    for (const [signal,handler] of handlers) process.on(signal,handler);
    child.once('spawn',()=>{
      if(updateDue(prepared.snapshot.state,Date.now())){
        void coordinate({mode:'check',verifiedRelease:prepared.verifiedRelease},{...ports,detached:true}).catch(()=>{});
      }
    });
    child.once('error',() => {
      if (settled) return;
      settled = true; cleanup(); reject(new UpdateError('LAUNCH_START'));
    });
    child.once('close',(code,signal) => {
      if (settled) return;
      settled = true; cleanup();
      resolve(code === null ? ({SIGINT:130,SIGTERM:143,SIGHUP:129}[signal] || 1) : code);
    });
  });
}

module.exports = {resolveLaunch,main,launchResolved,limits:LIMITS};

function workerPeer() {
  let pending=null,next=0,buffer=Buffer.alloc(0),failure=null;
  const broken=() => {
    failure=new UpdateError('COORDINATOR_PROTOCOL');
    if(pending){const request=pending;pending=null;request.reject(failure);}
  };
  const data=chunk => {
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>1024){broken();return;}
    const end=buffer.indexOf(10);if(end<0)return;
    const line=buffer.subarray(0,end).toString('utf8').replace(/\r$/,'');
    buffer=buffer.subarray(end+1);
    let ack;
    try{ack=JSON.parse(line);}catch{broken();return;}
    if(buffer.length || !pending || Object.keys(ack).sort().join(',')!=='code,id,type' ||
       ack.type!=='ack' || ack.code!=='OK' || ack.id!==pending.id){broken();return;}
    const request=pending;pending=null;request.resolve();
  };
  process.stdin.on('data',data);process.stdin.once('end',broken);process.stdin.resume();
  return {
    async commit(root,state) {
      const {encodeRelease,parseState}=require('./protocol.cjs');
      const bytes=encodeRelease(state);parseState(bytes);
      if(bytes.length>4194304 || pending || failure)throw failure || new UpdateError('COORDINATOR_PROTOCOL');
      await new Promise((resolve,reject)=>{
        pending={id:++next,resolve,reject};
        process.stdout.write(JSON.stringify({type:'commit',id:next,state:bytes.toString('base64')})+'\n',error=>{if(error)broken();});
      });
    },
    close(){process.stdin.removeListener('data',data);process.stdin.removeListener('end',broken);process.stdin.pause();},
  };
}

async function runWorker({mode,verifiedRelease,expectedCurrent},ports) {
  const peer=workerPeer();
  try {
    const result=await require('./stage.cjs').runUpdate({mode,root:ports.root,request:expectedCurrent===undefined?{}:{expectedCurrent}},{
      ...createUpdatePorts({verifiedRelease},ports),publicKey:ports.publicKey,node:ports.config.node_path,commitState:peer.commit,
    });
    if(!result || typeof result.stateChanged!=='boolean' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.code))fail('COORDINATOR_PROTOCOL');
    await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify({type:'result',code:result.code,stateChanged:result.stateChanged})+'\n',error=>error?reject(error):resolve()));
    return 0;
  } finally {peer.close();}
}

function startBackground(entry,verified,ports) {
  const {spawn}=require('node:child_process');
  const request=Buffer.from(JSON.stringify({mode:'check',releaseRef:verified.releaseRef}),'utf8').toString('base64');
  return new Promise((resolve,reject)=>{
    // Detach Node, whose console-independent bootstrap retains the PowerShell host.
    const child=spawn(ports.config.node_path,[entry,'background',request],{
      windowsHide:true,detached:true,stdio:'ignore',cwd:ports.root,shell:false,
    });
    let settled=false;
    const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();finish(new UpdateError('COORDINATOR_TIMEOUT'));},5000);
    function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);}
    child.once('error',()=>finish(new UpdateError('COORDINATOR_WORKER')));
    child.once('spawn',()=>{child.unref();finish(null,{code:'STARTED',stateChanged:false});});
  });
}

async function coordinate({mode,verifiedRelease,expectedCurrent},ports={}) {
  if(!['check','promote','rollback'].includes(mode) || typeof ports.verifyInstalledRelease!=='function')fail('COORDINATOR_REQUIRED');
  const verified=await ports.verifyInstalledRelease({root:ports.root,releaseRef:verifiedRelease.releaseRef},{publicKey:ports.publicKey});
  const host=resolveOwned(verified.releaseRoot,'update/coordinator.ps1');
  const entry=resolveOwned(ports.root,'bootstrap/bootstrap.cjs');
  if(expectedCurrent!==undefined && mode!=='rollback')fail('UPDATE_INPUT');
  if(ports.detached){if(mode!=='check')fail('UPDATE_INPUT');return startBackground(entry,verified,ports);}
  const data=Buffer.from(JSON.stringify({root:ports.root,mode,releaseRef:verified.releaseRef,node:ports.config.node_path,host,entry,...(expectedCurrent===undefined?{}:{expectedCurrent})}),'utf8').toString('base64');
  const script=[
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    "$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json",
    "try {",
    "  . ([scriptblock]::Create([IO.File]::ReadAllText($data.host)))",
    "  $validate={param([byte[]]$Bytes)",
    "    $validator=[Diagnostics.Process]::new();$started=$false",
    "    $validator.StartInfo.FileName=$data.node;$validator.StartInfo.Arguments='\"'+$data.entry+'\" validate-state'",
    "    $validator.StartInfo.UseShellExecute=$false;$validator.StartInfo.CreateNoWindow=$true",
    "    $validator.StartInfo.RedirectStandardInput=$true;$validator.StartInfo.RedirectStandardOutput=$true;$validator.StartInfo.RedirectStandardError=$true",
    "    try {",
    "      $started=$validator.Start();if(-not $started){return $false}",
    "      if($null -ne $job){$job.Assign($validator.Handle)}",
    "      $out=$validator.StandardOutput.ReadToEndAsync();$err=$validator.StandardError.ReadToEndAsync()",
    "      $validator.StandardInput.BaseStream.Write($Bytes,0,$Bytes.Length);$validator.StandardInput.Close()",
    "      if(-not $validator.WaitForExit(5000)){return $false}",
    "      return ($validator.ExitCode -eq 0 -and $out.GetAwaiter().GetResult().Length -eq 0 -and $err.GetAwaiter().GetResult().Length -eq 0)",
    "    } finally {if($started){try{if(-not $validator.HasExited){$validator.Kill()};[void]$validator.WaitForExit(5000)}catch{}};$validator.Dispose()}",
    "  }",
    "  $result=Invoke-CodexsCoordinator -Request @{mode=$data.mode;root=$data.root} -ValidateState $validate -Operation {",
    "    param($Request,$Context)",
    "    $workerRequest=@{mode=$Request.mode;root=$Request.root;releaseRef=$data.releaseRef};if($data.PSObject.Properties.Name -ccontains 'expectedCurrent'){$workerRequest.expectedCurrent=$data.expectedCurrent}",
    "    Invoke-CodexsWorkerHost -Context $Context -NodePath $data.node -WorkerPath ([IO.Path]::Combine([IO.Path]::GetDirectoryName($data.host),'launch.cjs')) -Request $workerRequest",
    "  }",
    "  [Console]::Out.WriteLine((ConvertTo-Json $result -Compress))",
    "} catch {[Console]::Error.WriteLine('COORDINATOR_WORKER');exit 1}",
  ].join('\n');
  const {spawn}=require('node:child_process');
  const shell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  return new Promise((resolve,reject)=>{
    const child=spawn(shell,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:ports.root,shell:false});
    let settled=false,out=Buffer.alloc(0),err=Buffer.alloc(0);
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(new UpdateError('COORDINATOR_TIMEOUT'));},mode==='check'?LIMITS.outerCheck:LIMITS.outerLocal);
    child.once('error',()=>finish(new UpdateError('COORDINATOR_WORKER')));
    child.stdout.on('data',bytes=>{out=Buffer.concat([out,bytes]);if(out.length>8192){child.kill();finish(new UpdateError('COORDINATOR_OUTPUT'));}});
    child.stderr.on('data',bytes=>{err=Buffer.concat([err,bytes]);if(err.length>8192){child.kill();finish(new UpdateError('COORDINATOR_OUTPUT'));}});
    child.once('close',code=>{
      if(code!==0){finish(new UpdateError('COORDINATOR_WORKER'));return;}
      try {
        const result=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(out));
        if(Object.keys(result).sort().join(',')!=='code,stateChanged' || typeof result.stateChanged!=='boolean' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.code))fail('COORDINATOR_PROTOCOL');
        finish(null,result);
      } catch{finish(new UpdateError('COORDINATOR_PROTOCOL'));}
    });
  });
}
module.exports.coordinate=coordinate;
module.exports.runWorker=runWorker;

function createUpdatePorts({verifiedRelease},ports) {
  const fs=require('node:fs/promises');
  const {promisify}=require('node:util');
  const execFile=promisify(require('node:child_process').execFile);
  const {randomUUID}=require('node:crypto');
  const environment=ports.env || process.env;
  const system=environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows';
  const shell=path.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const settings=ports.config.settings_path;
  async function isolated(work) {
    const relative='probes/'+randomUUID(),cwd=resolveOwned(ports.root,relative);
    await fs.mkdir(path.dirname(cwd),{recursive:true});await fs.mkdir(cwd);
    const env={
      SystemRoot:system,WINDIR:system,COMSPEC:path.join(system,'System32','cmd.exe'),
      PATH:path.join(system,'System32'),PATHEXT:'.EXE;.COM',
      HOME:cwd,USERPROFILE:cwd,CODEX_HOME:cwd,APPDATA:cwd,LOCALAPPDATA:cwd,TEMP:cwd,TMP:cwd,
      CCSTATUSLINE_WIDTH:'80',NO_COLOR:'1',
    };
    try {return await work({cwd,env});}
    finally {const owned=resolveOwned(ports.root,relative);if(owned!==cwd)fail('PATH');await fs.rm(owned,{recursive:true,force:true});}
  }
  const run=(file,args,options,timeout) => execFile(file,args,{
    ...options,windowsHide:true,encoding:'buffer',maxBuffer:8192,timeout,killSignal:'SIGKILL',
  });
  const stable='(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
  return {
    node:ports.config.node_path,
    async freeBytes(root) {
      if(path.resolve(root)!==path.resolve(ports.root))fail('PATH');
      resolveOwned(root,'disk-check');
      const info=await (ports.statfs || fs.statfs)(root,{bigint:true});
      const bytes=BigInt(info.bavail)*BigInt(info.bsize);
      if(bytes<0n || bytes>BigInt(Number.MAX_SAFE_INTEGER))fail('LOW_DISK');
      return Number(bytes);
    },
    async readSettingsVersion() {
      try {
        const bytes=await readBoundedFile(settings,{maxBytes:4194304,code:'SETTINGS_HOLD'});
        return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)).version;
      } catch{return null;}
    },
    async probeVersion(paths) {
      try {
        return await isolated(async options=>{
          const native=await run(paths.native,['--version'],options,ports.probeTimeoutMs || LIMITS.version);
          const formatter=await run(paths.node,[paths.formatter,'--version'],options,ports.probeTimeoutMs || LIMITS.version);
          if(native.stderr.length || formatter.stderr.length)fail('STAGE_VERSION');
          const match=new RegExp('^codex(?:-cli)? ('+stable+')$').exec(native.stdout.toString('utf8').trim());
          const format=formatter.stdout.toString('utf8').trim();
          if(!match || !new RegExp('^'+stable+'$').test(format))fail('STAGE_VERSION');
          return {native:match[1],formatter:format};
        });
      } catch(error) {
        if(error && error.name==='UpdateError' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code))throw error;
        fail('STAGE_IO');
      }
    },
    async smoke(paths) {
      let output;
      try {
        output=await isolated(options=>run(paths.native,['codexs-smoke','--node',paths.node,'--formatter',paths.formatter],options,ports.probeTimeoutMs || LIMITS.smoke));
      } catch(error) {
        const stderr=Buffer.isBuffer(error.stderr)?error.stderr.toString('utf8').trim():'';
        const code=/^(?:Error: )?(SMOKE_(?:(?:ARGS|IO|ENV|TIMEOUT|OUTPUT|CANCELLED|RUNNER)(?:_(?:RUNNER_CLEANUP|DIRECTORY_CLEANUP|RUNNER_AND_DIRECTORY_CLEANUP))?|RUNNER_CLEANUP|DIRECTORY_CLEANUP|RUNNER_AND_DIRECTORY_CLEANUP|CLEANUP|UNSUPPORTED|RUNTIME))$/.exec(stderr);
        if(code)fail(code[1]);
        if(error.killed && error.code!=='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')fail('SMOKE_TIMEOUT');
        fail('SMOKE_IO');
      }
      const expected='{"schema":1,"runner":"ok","formatter":"ok","cleanup":"ok"}';
      if(output.stderr.length || output.stdout.toString('utf8').trim()!==expected)fail('SMOKE_PROTOCOL');
    },
    async extract({archive,destination,inventory,allowedRoot}) {
      try {
        const relative=path.relative(ports.root,allowedRoot).split(path.sep).join('/');
        if(resolveOwned(ports.root,relative)!==path.resolve(allowedRoot))fail('PATH');
        const extractor=resolveOwned(verifiedRelease.releaseRoot,'update/archive.ps1');
        const data=Buffer.from(JSON.stringify({extractor,archive,destination,inventory,allowedRoot}),'utf8').toString('base64');
        const script=[
          "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
          "$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json",
          "try {",
                    "$receipt=@(& ([scriptblock]::Create([IO.File]::ReadAllText($data.extractor))) -Archive $data.archive -Destination $data.destination -Inventory $data.inventory -AllowedRoot $data.allowedRoot)",
                    "if($receipt.Count -ne 1 -or $receipt[0] -cne '{\"schema\":1,\"code\":\"EXTRACTED\"}'){throw 'EXTRACT_IO'}",
                    "[Console]::Out.WriteLine($receipt[0])",
                    "} catch {$code=if($_.Exception.Message -ceq 'ARCHIVE_REJECTED'){'ARCHIVE_REJECTED'}else{'EXTRACT_IO'};[Console]::Error.WriteLine($code);exit 1}",
        ].join('\n');
        const output=await run(shell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:ports.root},ports.extractTimeoutMs || LIMITS.extract);
        if(output.stderr.length || output.stdout.toString('utf8').trim()!=='{"schema":1,"code":"EXTRACTED"}')fail('EXTRACT_IO');
      } catch(error) {
        if(error && error.name==='UpdateError' && error.code==='PATH')fail('ARCHIVE_REJECTED');
        const reason=Buffer.isBuffer(error.stderr)?error.stderr.toString('utf8').trim():'';
        if(reason==='ARCHIVE_REJECTED')fail('ARCHIVE_REJECTED');
        fail('EXTRACT_IO');
      }
    },
  };
}
module.exports.createUpdatePorts=createUpdatePorts;

if(require.main===module){
  const work=process.argv.length===3 && process.argv[2]==='footer'?runFooter:async()=>fail('FOOTER_INPUT');
  work().then(code=>{process.exitCode=code;}).catch(error=>{const code=error && error.name==='UpdateError' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:'FOOTER_IO';console.error('codexs: '+code);process.exitCode=1;});
}
