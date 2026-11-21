'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchInstallation } = require('../test-support/update-fixtures.cjs');
const { verifyInstalledRelease } = require('./bootstrap.cjs');

function api() {
  let value;
  assert.doesNotThrow(() => { value = require('./launch.cjs'); }, 'immutable launcher must exist');
  assert.equal(typeof value.resolveLaunch,'function');
  assert.equal(typeof value.main,'function');
  return value;
}
async function fixture(t, options, rootOptions) {
  const f = await launchInstallation(t, rootOptions);
  const a = await f.install(1,options);
  await f.writeState(a.ref);
  const verifiedRelease = await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const cwd = path.join(f.root,'unrelated caller สี');
  await fs.mkdir(cwd);
  return {...f,...a,verifiedRelease,cwd};
}

test('CLI resolves one immutable native and helper tree while preserving cwd and override precedence', async t => {
  const f = await fixture(t);
  const argv = ['-c','tui.status_line_command.command="user override"','resume','synthetic thread','', 'quote"arg','100%','!literal!'];
  const original = [...argv];
  const plan = await api().resolveLaunch({root:f.root,mode:'cli',argv,verifiedRelease:f.verifiedRelease},{
    config:f.config,cwd:f.cwd,env:{Path:'synthetic inherited path',SYNTHETIC_AUTH:'retain',CODEX_MANAGED_BY_NPM:'1',CODEX_MANAGED_PACKAGE_ROOT:'obsolete'},
  });
  assert.equal(plan.file,path.join(f.directory,'bin','codex.exe'));
  assert.equal(plan.cwd,f.cwd);
  assert.equal(plan.args[0],'-c');
  assert.match(plan.args[1],/^tui\.status_line_command\.command=/);
  assert.deepEqual(plan.args.slice(2),original);
  assert.deepEqual(argv,original);
  assert.equal(plan.env.PATH,path.join(f.directory,'codex-path')+path.delimiter+'synthetic inherited path');
  assert.equal(plan.env.SYNTHETIC_AUTH,'retain');
  assert.equal(Object.hasOwn(plan.env,'CODEX_MANAGED_BY_NPM'),false);
  assert.equal(Object.hasOwn(plan.env,'CODEX_MANAGED_PACKAGE_ROOT'),false);
  assert.deepEqual(plan.releaseRef,f.ref);
});

test('editor resolves bundled formatter with explicit Node and the stable settings file', async t => {
  const f=await fixture(t);
  const plan=await api().resolveLaunch({root:f.root,mode:'editor',argv:['--synthetic',''],verifiedRelease:f.verifiedRelease},{config:f.config,cwd:f.cwd});
  assert.equal(plan.file,process.execPath);
  assert.deepEqual(plan.args,[path.join(f.directory,'formatter','dist','ccstatusline.js'),'--codex','--config',f.config.settings_path,'--synthetic','']);
  assert.equal(plan.cwd,f.cwd);
  assert.deepEqual(plan.releaseRef,f.ref);
});

test('non-exact reserved commands remain native arguments', async t => {
  const f=await fixture(t);
  for(const argv of [['footer'],['update-status','extra'],['rollback','--help'],['exec','--version'],['--codexs-internal-worker','untrusted-root']]){
    const plan=await api().resolveLaunch({root:f.root,mode:'cli',argv,verifiedRelease:f.verifiedRelease},{config:f.config,cwd:f.cwd});
    assert.deepEqual(plan.args.slice(2),argv);
    assert.equal(plan.file,path.join(f.directory,'bin','codex.exe'));
  }
});

test('missing or incompatible settings fail before a normal child can start',async t=>{
  const f=await fixture(t);
  await fs.unlink(f.config.settings_path);
  await assert.rejects(api().resolveLaunch({root:f.root,mode:'cli',argv:[],verifiedRelease:f.verifiedRelease},{config:f.config}),{code:'SETTINGS_HOLD'});
  await fs.writeFile(f.config.settings_path,'{"version":5}');
  await assert.rejects(api().resolveLaunch({root:f.root,mode:'editor',argv:[],verifiedRelease:f.verifiedRelease},{config:f.config}),{code:'SETTINGS_HOLD'});
});

test('short footer meets the native deadline with long paths and survives cmd expansion and preserves UTF-8 input, ANSI output and stderr', {timeout:30000},async t=>{
  const probe="const fs=require('node:fs');const timer=setTimeout(()=>process.exit(98),8000);const chunks=[];process.stdin.on('data',x=>chunks.push(x));process.stdin.on('end',()=>{if(process.argv[2]!=='--config'||JSON.parse(fs.readFileSync(process.argv[3],'utf8')).version!==4)process.exit(97);process.stdout.write(Buffer.concat([Buffer.from('\\x1b[36m'),...chunks,Buffer.from('\\x1b[0m')]));process.stderr.write('synthetic stderr');clearTimeout(timer);});";
  const f=await fixture(t,{payload:{'formatter/dist/ccstatusline.js':Buffer.from(probe),...Object.fromEntries(await Promise.all(['launch','protocol','paths'].map(async name=>['update/'+name+'.cjs',await fs.readFile(path.join(__dirname,name+'.cjs'))])))}},{special:true});
  const longSettings=path.join(f.root,...Array.from({length:7},(_,i)=>'settings-'+i+'x'.repeat(110)),'settings.json');
  await fs.mkdir(path.dirname(longSettings),{recursive:true});await fs.copyFile(f.config.settings_path,longSettings);f.config.settings_path=longSettings;
  const longRoot=path.join(f.root,...Array.from({length:6},(_,i)=>'release-'+i+'y'.repeat(100)));
  const moved=path.join(longRoot,'versions',f.ref.release_id);await fs.mkdir(path.dirname(moved),{recursive:true});await fs.rename(f.directory,moved);
  f.verifiedRelease=await verifyInstalledRelease({root:longRoot,releaseRef:f.ref},{publicKey:f.publicKey});
  const plan=await api().resolveLaunch({root:longRoot,mode:'cli',argv:[],verifiedRelease:f.verifiedRelease},{config:f.config,cwd:f.cwd});
  const command=JSON.parse(plan.args[1].slice('tui.status_line_command.command='.length));
  assert.ok(command.length<512,'live command must stay below CMD limits regardless of settings path length');
  const child=spawn(command,[],{
    shell:path.join(process.env.SystemRoot,'System32','cmd.exe'),windowsHide:true,cwd:f.cwd,
    env:{...plan.env,CODEXS_TRIPWIRE:'must-not-expand'},stdio:['pipe','pipe','pipe'],
  });
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0);
  child.stdout.on('data',x=>{stdout=Buffer.concat([stdout,x]);});
  child.stderr.on('data',x=>{stderr=Buffer.concat([stderr,x]);});
  const finished=once(child,'close');
  const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},2000);
  t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();});
  const input=Buffer.from('{"codex":{"schema":1},"text":"synthetic สี 🌟"}\n');
  child.stdin.on('error',()=>{});
  child.stdin.end(input);
  const [exit,signal]=await finished;
  assert.equal(signal,null);
  assert.equal(exit,0,stderr.toString());
  assert.deepEqual(stdout,Buffer.concat([Buffer.from([27,91,51,54,109]),input,Buffer.from([27,91,48,109])]));
  assert.equal(stderr.toString(),'synthetic stderr');
});

const { runtimeInstallation, physicalStateCommit } = require('../test-support/update-fixtures.cjs');
const { transition } = require('./state.cjs');

async function startInstalled(t,f,argv=[],env={},mode='editor') {
  const child=spawn(process.execPath,[path.join(f.root,'bootstrap','bootstrap.cjs'),mode,...argv],{
    cwd:f.root,env:{...process.env,...env},stdio:['pipe','pipe','pipe'],windowsHide:true,
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',text=>{stdout+=text;});
  child.stderr.on('data',text=>{stderr+=text;});
  child.stdin.on('error',()=>{});
  const closed=once(child,'close');
  const timeout=setTimeout(()=>{if(child.exitCode===null)child.kill();},15000);
  t.after(async()=>{clearTimeout(timeout);if(child.exitCode===null)child.kill();await closed.catch(()=>{});});
  return {child,closed,output:()=>({stdout,stderr})};
}
async function waitRecord(file,processHandle) {
  const stop=Date.now()+10000;
  while(Date.now()<stop) {
    try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(processHandle.child.exitCode!==null)throw Error('Synthetic launch exited before readiness: '+processHandle.output().stderr);
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('Synthetic launch readiness timed out');
}
const editorProbe = "const fs=require('node:fs'),path=require('node:path');const record={native:path.resolve(__dirname,'..','..','bin','codex.exe'),helper:process.env.PATH.split(path.delimiter)[0],formatter:__filename,cwd:process.cwd(),argv:process.argv.slice(2)};fs.writeFileSync(process.env.SYNTHETIC_RECORD,JSON.stringify(record));const timer=setTimeout(()=>process.exit(99),12000);process.stdin.resume();process.stdin.once('data',()=>{clearTimeout(timer);process.exit(7);});";

test('live A remains pinned after B promotion through the real atomic coordinator', {timeout:30000},async t=>{
  const f=await runtimeInstallation(t);
  const a=await f.install(1,{payload:{'formatter/dist/ccstatusline.js':Buffer.from(editorProbe)}});
  let state=await f.writeState(a.ref);
  const settingsBefore=await fs.readFile(f.config.settings_path);
  const recordA=path.join(f.root,'record-a.json'),recordB=path.join(f.root,'record-b.json');
  const old=await startInstalled(t,f,[],{SYNTHETIC_RECORD:recordA});
  const observedA=await waitRecord(recordA,old);
  const b=await f.install(2,{payload:{'formatter/dist/ccstatusline.js':Buffer.from(editorProbe)}});
  state=transition(transition(transition(state,{type:'manifest-seen',ref:b.ref}),{type:'stage-ready',ref:b.ref}),{type:'promote'});
  await physicalStateCommit(f.root,state);
  const fresh=await startInstalled(t,f,[],{SYNTHETIC_RECORD:recordB});
  const observedB=await waitRecord(recordB,fresh);
  assert.equal(old.child.exitCode,null);
  for(const [record,release] of [[observedA,a],[observedB,b]]){
    assert.equal(record.native,path.join(release.directory,'bin','codex.exe'));
    assert.equal(record.helper,path.join(release.directory,'codex-path'));
    assert.equal(record.formatter,path.join(release.directory,'formatter','dist','ccstatusline.js'));
    assert.equal(record.cwd,f.root);
  }
  old.child.stdin.end('stop');fresh.child.stdin.end('stop');
  assert.deepEqual(await old.closed,[7,null],old.output().stderr);
  assert.deepEqual(await fresh.closed,[7,null],fresh.output().stderr);
  assert.deepEqual(await fs.readFile(f.config.settings_path),settingsBefore);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8')).current.sequence,2);
});

test('runtime exits pass through without automatic conversation replay',async t=>{
  for(const exitCode of [0,7]) {
    await t.test('exit '+exitCode,async t=>{
      const f=await runtimeInstallation(t);
      const record=path.join(f.root,'launch-count');
      const body="const fs=require('node:fs');fs.appendFileSync(process.env.SYNTHETIC_RECORD,'one\\n');process.exit("+exitCode+");";
      const a=await f.install(1,{payload:{'formatter/dist/ccstatusline.js':Buffer.from(body)}});
      await f.writeState(a.ref);
      const before=await fs.readFile(path.join(f.root,'current.json'));
      const run=await startInstalled(t,f,['literal "quotes"',''],{SYNTHETIC_RECORD:record});
      assert.deepEqual(await run.closed,[exitCode,null],run.output().stderr);
      assert.equal(await fs.readFile(record,'utf8'),'one\n');
      assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
    });
  }
});

test('process start failure returns a bounded error once and leaves state unchanged',async t=>{
  const f=await fixture(t);
  const before=await fs.readFile(path.join(f.root,'current.json'));
  await assert.rejects(api().main({mode:'editor',argv:[],verifiedRelease:f.verifiedRelease},{
    root:f.root,config:{...f.config,node_path:path.join(f.root,'missing-node.exe')},cwd:f.cwd,publicKey:f.publicKey,verifyInstalledRelease,readSnapshot:require('./state.cjs').readInstallation,dispatchVerified:(input,ports)=>api().launchResolved(input,ports),
  }),{code:'LAUNCH_START'});
  assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
});

test('installed bootstrap reports bounded cross-module errors without exposing private messages',async t=>{
  for(const [code,want] of [['SETTINGS_HOLD','SETTINGS_HOLD'],['private/path','BOOTSTRAP_IO']]) {
    await t.test(want,async t=>{
      const f=await runtimeInstallation(t);
      const body="exports.main=async()=>{const e=new Error('private synthetic content');e.name='UpdateError';e.code="+JSON.stringify(code)+";throw e;};";
      const a=await f.install(1,{payload:{'update/launch.cjs':Buffer.from(body)}});
      await f.writeState(a.ref);
      const run=await startInstalled(t,f);
      assert.deepEqual(await run.closed,[1,null]);
      assert.equal(run.output().stderr,'codexs: '+want+'\n');
      assert.equal(run.output().stdout,'');
    });
  }
});

test('signal dispatch cancels the owned child once without replay or pointer rollback',{timeout:30000},async t=>{
  for (const [signal,want] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',process.platform === 'win32' ? 1 : 129]]) {
    await t.test(signal,async t=>{
      const f=await runtimeInstallation(t);
      const record=path.join(f.root,'interrupt-record');
      const source=await fs.readFile(path.join(__dirname,'launch.cjs'),'utf8');
      const dispatch="const ordinaryMain=module.exports.main;module.exports.main=async(...args)=>{const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.env.SYNTHETIC_RECORD)){clearInterval(timer);process.emit("+JSON.stringify(signal)+");}},10);try{return await ordinaryMain(...args)}finally{clearInterval(timer)}};";
      const probe="const fs=require('node:fs');fs.appendFileSync(process.env.SYNTHETIC_RECORD,'one\\n');setTimeout(()=>process.exit(99),3000);process.stdin.resume();";
      const a=await f.install(1,{payload:{'update/launch.cjs':Buffer.from(source+'\n'+dispatch),'formatter/dist/ccstatusline.js':Buffer.from(probe)}});
      await f.writeState(a.ref);
      const before=await fs.readFile(path.join(f.root,'current.json'));
      const run=await startInstalled(t,f,[],{SYNTHETIC_RECORD:record});
      assert.deepEqual(await run.closed,[want,null],run.output().stderr);
      assert.equal(await fs.readFile(record,'utf8'),'one\n');
      assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
    });
  }
});

test('installed worker uses the real coordinator without network on throttled and clock-recovery paths',{timeout:30000},async t=>{
  for(const mode of ['throttled','clock-backward']) {
    await t.test(mode,async t=>{
      const f=await runtimeInstallation(t);
      const a=await f.install();
      const now=Date.now();
      await f.writeState(a.ref,{last_check_ms:mode==='throttled'?now:now+7200000,next_check_ms:mode==='throttled'?now+3600000:now+10800000});
      const settingsBefore=await fs.readFile(f.config.settings_path);
      assert.equal(typeof api().coordinate,'function','production coordinator binding must exist');
      const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
      const result=await api().coordinate({mode:'check',verifiedRelease},{root:f.root,config:f.config,publicKey:f.publicKey,verifyInstalledRelease});
      assert.deepEqual(result,{code:mode==='throttled'?'THROTTLED':'CLOCK_ROLLBACK',stateChanged:mode!=='throttled'});
      const after=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
      assert.deepEqual(after.current,a.ref);
      assert.equal(after.failures,0);
      if(mode==='clock-backward'){
        assert.ok(after.last_check_ms>=now&&after.last_check_ms<now+30000);
        assert.equal(after.next_check_ms-after.last_check_ms,3600000);
      }
      assert.deepEqual(await fs.readFile(f.config.settings_path),settingsBefore);
    });
  }
});

test('coordinator authenticates its operational script immediately before executing it',async t=>{
  const f=await runtimeInstallation(t);
  const a=await f.install();
  await f.writeState(a.ref);
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  await fs.appendFile(path.join(a.directory,'update','coordinator.ps1'),'; throw "must not execute";');
  assert.equal(typeof api().coordinate,'function');
  await assert.rejects(api().coordinate({mode:'check',verifiedRelease},{
    root:f.root,config:f.config,publicKey:f.publicKey,verifyInstalledRelease,
  }),{code:'BOOTSTRAP_INVENTORY'});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8')).failures,0);
});

const {probeInstallation}=require('../test-support/update-fixtures.cjs');

test('production probes isolate synthetic personal settings and verify native/formatter identities',async t=>{
  assert.equal(typeof api().createUpdatePorts,'function','real probe ports must exist');
  const f=await probeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const personal=path.join(f.root,'synthetic-personal');
  await fs.mkdir(personal);await fs.writeFile(path.join(personal,'auth.json'),'synthetic auth sentinel');
  const ports=api().createUpdatePorts({verifiedRelease},{
    root:f.root,config:f.config,env:{...process.env,HOME:personal,CODEX_HOME:personal,SYNTHETIC_SECRET:'must not reach probes'},
  });
  const paths={node:process.execPath,native:path.join(a.directory,'bin','codex.exe'),formatter:path.join(a.directory,'formatter','dist','ccstatusline.js')};
  assert.deepEqual(await ports.probeVersion(paths),{native:'0.166.0',formatter:'2.2.32'});
  await ports.smoke(paths);
  const record=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/);
  const cwd=Buffer.from(record[0],'base64').toString();
  assert.ok(cwd.startsWith(path.join(f.root,'probes')+path.sep));
  assert.equal(Buffer.from(record[1],'base64').toString(),cwd);
  assert.equal(Buffer.from(record[2],'base64').toString(),cwd);
  assert.equal(record[3],'False');
  const args=record[5].split('|').map(x=>Buffer.from(x,'base64').toString());
  assert.deepEqual(args,['codexs-smoke','--node',process.execPath,'--formatter',paths.formatter]);
  assert.equal(await fs.readFile(path.join(personal,'auth.json'),'utf8'),'synthetic auth sentinel');
  assert.equal(await ports.readSettingsVersion(),4);
});

test('production diagnostics reject wrong versions, unknown fields, failed cleanup and native failures',async t=>{
  assert.equal(typeof api().createUpdatePorts,'function');
  const f=await probeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config});
  const paths={node:process.execPath,native:path.join(a.directory,'bin','codex.exe'),formatter:path.join(a.directory,'formatter','dist','ccstatusline.js')};
  for(const [control,method,code] of [
    ['bad-version','probeVersion','STAGE_VERSION'],
    ['smoke-extra','smoke','SMOKE_PROTOCOL'],
    ['smoke-cleanup','smoke','SMOKE_PROTOCOL'],
    ['smoke-error','smoke','SMOKE_OUTPUT'],
    ['oversized','smoke','SMOKE_IO'],
  ]) {
    await t.test(control,async()=>{
      await fs.writeFile(path.join(f.root,'control'),control);
      await assert.rejects(ports[method](paths),{code});
    });
  }
});

test('probe timeout terminates only its owned synthetic executable and preserves settings',async t=>{
  assert.equal(typeof api().createUpdatePorts,'function');
  const f=await probeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  await fs.writeFile(path.join(f.root,'control'),'timeout');
  const before=await fs.readFile(f.config.settings_path);
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config,probeTimeoutMs:500});
  const paths={node:process.execPath,native:path.join(a.directory,'bin','codex.exe'),formatter:path.join(a.directory,'formatter','dist','ccstatusline.js')};
  const start=Date.now();
  await assert.rejects(ports.smoke(paths),{code:'SMOKE_TIMEOUT'});
  assert.ok(Date.now()-start<5000);
  assert.deepEqual(await fs.readFile(f.config.settings_path),before);
  const record=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/);
  assert.throws(()=>process.kill(Number(record[4]),0),{code:'ESRCH'});
});

test('free-space conversion and settings holds use real adapter contracts without migration',async t=>{
  assert.equal(typeof api().createUpdatePorts,'function');
  const f=await fixture(t);
  const ports=api().createUpdatePorts({verifiedRelease:f.verifiedRelease},{root:f.root,config:f.config,statfs:async()=>({bavail:11n,bsize:4096n})});
  assert.equal(await ports.freeBytes(f.root),45056);
  await fs.writeFile(f.config.settings_path,'{"version":5,"unknown":["preserve"]}');
  const before=await fs.readFile(f.config.settings_path);
  assert.equal(await ports.readSettingsVersion(),5);
  assert.deepEqual(await fs.readFile(f.config.settings_path),before);
});

test('real extraction adapter pins the signed extractor and owned staging paths',async t=>{
  assert.equal(typeof api().createUpdatePorts,'function');
  const {tinyZip}=require('../test-support/update-fixtures.cjs');
  const {createHash}=require('node:crypto');
  const f=await runtimeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const work=path.join(f.root,'staging-fixture');await fs.mkdir(work);
  const archive=path.join(work,'archive.zip'),inventory=path.join(work,'inventory.json'),destination=path.join(work,'payload');
  await tinyZip(archive,{'สี/hello.txt':'synthetic'});
  await fs.writeFile(inventory,JSON.stringify([{path:'สี/hello.txt',bytes:9,sha256:createHash('sha256').update('synthetic').digest('hex')}]));
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config});
  await ports.extract({archive,destination,inventory,allowedRoot:work});
  assert.equal(await fs.readFile(path.join(destination,'สี','hello.txt'),'utf8'),'synthetic');
  await assert.rejects(ports.extract({archive,destination:path.join(f.root,'outside-work'),inventory,allowedRoot:work}),{code:'ARCHIVE_REJECTED'});
});

test('normal launch promotes a verified ready release and pins its native executable',{timeout:30000},async t=>{
  const f=await probeInstallation(t),a=await f.install(1),b=await f.install(2);
  await f.writeState(a.ref,{ready:b.ref,highest:{sequence:2,manifest_sha256:b.ref.manifest_sha256}});
  const before=await fs.readFile(f.config.settings_path);
  const run=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
  assert.deepEqual(await run.closed,[2,null],run.output().stderr);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  assert.deepEqual(state.current,b.ref);assert.deepEqual(state.previous,a.ref);assert.equal(state.ready,null);
  const record=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/);
  assert.equal(Buffer.from(record[6],'base64').toString(),path.join(b.directory,'bin','codex.exe'));
  assert.deepEqual(await fs.readFile(f.config.settings_path),before);
});

test('a corrupt ready release is rejected while the current release remains launchable',{timeout:30000},async t=>{
  const f=await probeInstallation(t),a=await f.install(1),b=await f.install(2);
  await f.writeState(a.ref,{ready:b.ref,highest:{sequence:2,manifest_sha256:b.ref.manifest_sha256}});
  await fs.appendFile(path.join(b.directory,'formatter','dist','ccstatusline.js'),'tampered');
  const run=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
  assert.deepEqual(await run.closed,[2,null],run.output().stderr);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  assert.deepEqual(state.current,a.ref);assert.equal(state.ready,null);assert.deepEqual(state.rejected,[b.ref.release_id]);
  assert.equal(state.highest.sequence,2);
});

test('prelaunch corruption restores only an independently authenticated predecessor',{timeout:30000},async t=>{
  const f=await probeInstallation(t),a=await f.install(1),b=await f.install(2);
  await f.writeState(b.ref,{previous:a.ref});
  await fs.appendFile(path.join(b.directory,'bin','codex.exe'),'tampered');
  const before=await fs.readFile(f.config.settings_path);
  const run=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
  assert.deepEqual(await run.closed,[2,null],run.output().stderr);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  assert.deepEqual(state.current,a.ref);assert.deepEqual(state.rejected,[b.ref.release_id]);assert.equal(state.highest.sequence,2);
  assert.deepEqual(await fs.readFile(f.config.settings_path),before);
});

test('runtime failure never replays work and exact rollback changes only the managed pointer',{timeout:30000},async t=>{
  const f=await probeInstallation(t),a=await f.install(1),b=await f.install(2);
  await f.writeState(b.ref,{previous:a.ref});
  await fs.writeFile(path.join(f.root,'control'),'cli-exit23');
  const before=await fs.readFile(path.join(f.root,'current.json'));
  const settings=await fs.readFile(f.config.settings_path);
  const run=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
  assert.deepEqual(await run.closed,[23,null],run.output().stderr);
  assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
  const rollback=await startInstalled(t,f,['rollback'],{HOME:f.root,CODEX_HOME:f.root},'cli');
  assert.deepEqual(await rollback.closed,[0,null],rollback.output().stderr);
  assert.equal(rollback.output().stdout,'ROLLED_BACK\n');
  const state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  assert.deepEqual(state.current,a.ref);assert.equal(state.highest.sequence,2);assert.deepEqual(state.rejected,[b.ref.release_id]);
  assert.deepEqual(await fs.readFile(f.config.settings_path),settings);
});

test('concurrent launches reserve one hourly background check through the real worker',{timeout:30000},async t=>{
  const f=await probeInstallation(t);
  const launchSource=await fs.readFile(path.join(__dirname,'launch.cjs'),'utf8');
  const httpSource=await fs.readFile(path.join(__dirname,'http.cjs'),'utf8');
  const fakeDisk="const actualFactory=createUpdatePorts;createUpdatePorts=(input,ports)=>actualFactory(input,{...ports,statfs:async()=>({bavail:8589934592n,bsize:1n})});";
  const fakeFeed="module.exports.fetchStableRelease=async()=>{const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(path.resolve(__dirname,'..','..','..','feed-count'),'one'+String.fromCharCode(10));const deadline=Date.now()+5000;while(!fs.existsSync(path.resolve(__dirname,'..','..','..','feed-release'))){if(Date.now()>deadline)throw new Error('SYNTHETIC_FEED_DEADLINE');await new Promise(r=>setTimeout(r,25));}return {unchanged:true};};";
  const a=await f.install(1,{payload:{'update/launch.cjs':Buffer.from(launchSource+'\n'+fakeDisk),'update/http.cjs':Buffer.from(httpSource+'\n'+fakeFeed)}});
  await f.writeState(a.ref,{last_check_ms:0,next_check_ms:0});
  const one=await startInstalled(t,f),two=await startInstalled(t,f);
  assert.deepEqual(await one.closed,[0,null],one.output().stderr);
  assert.deepEqual(await two.closed,[0,null],two.output().stderr);
  const enteredBy=Date.now()+10000;
  while(!(await fs.access(path.join(f.root,'feed-count')).then(()=>true,()=>false))){if(Date.now()>enteredBy)throw Error('Synthetic background feed did not start');await new Promise(r=>setTimeout(r,25));}
  await fs.writeFile(path.join(f.root,'feed-release'),'release after both clients exit');
  const deadline=Date.now()+15000;
  let state,finished=false;
  while(Date.now()<deadline){
    state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
    try {
      if(state.last_check_ms>0&&state.failures===0){
        const lock=await fs.open(path.join(f.root,'update.lock'),'r+');await lock.close();
        finished=true;break;
      }
    }catch{}
    await new Promise(r=>setTimeout(r,25));
  }
  const feedSeen=await fs.readFile(path.join(f.root,'feed-count'),'utf8').catch(()=>null);
  assert.equal(finished,true,'background worker must finish its owned transaction: '+JSON.stringify({state,feedSeen}));
  assert.equal(await fs.readFile(path.join(f.root,'feed-count'),'utf8'),'one\n');
  assert.deepEqual(state.current,a.ref);assert.equal(state.next_check_ms-state.last_check_ms,3600000);
  const after=await fs.readFile(path.join(f.root,'current.json'));
  const again=await startInstalled(t,f);
  assert.deepEqual(await again.closed,[0,null],again.output().stderr);
  assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),after);
  assert.equal(await fs.readFile(path.join(f.root,'feed-count'),'utf8'),'one\n');
});

test('native cleanup failure codes retain their exact bounded classification',async t=>{
  const f=await probeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config});
  const paths={node:process.execPath,native:path.join(a.directory,'bin','codex.exe'),formatter:path.join(a.directory,'formatter','dist','ccstatusline.js')};
  for(const code of ['SMOKE_RUNNER_CLEANUP','SMOKE_DIRECTORY_CLEANUP','SMOKE_RUNNER_AND_DIRECTORY_CLEANUP','SMOKE_TIMEOUT_DIRECTORY_CLEANUP']){
    await t.test(code,async()=>{
      await fs.writeFile(path.join(f.root,'control'),'smoke-code:'+code);
      await assert.rejects(ports.smoke(paths),{code});
    });
  }
  await fs.writeFile(path.join(f.root,'control'),'smoke-prefix:SMOKE_OUTPUT');
  await assert.rejects(ports.smoke(paths),{code:'SMOKE_OUTPUT'});
});

test('actual enrolled shims preserve both modes from unrelated directories without a source checkout',{timeout:120000},async t=>{
  const {promisify}=require('node:util'),execute=promisify(require('node:child_process').execFile);
  const {zipDirectory}=require('../test-support/update-fixtures.cjs');
  const f=await probeInstallation(t);
  const editor=[
    "import fs from 'node:fs';",
    "if(process.argv.length===3&&process.argv[2]==='--version'){console.log('2.2.32');}",
    "else{fs.writeFileSync(process.env.CODEXS_TEST_RECORD,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),path:process.env.PATH,secret:process.env.SYNTHETIC_SECRET,npm:process.env.CODEX_MANAGED_BY_NPM,packageRoot:process.env.CODEX_MANAGED_PACKAGE_ROOT,file:process.argv[1]}));process.exitCode=17;}",
  ].join('\n');
  let a=await f.install(1,{payload:{'formatter/dist/ccstatusline.js':Buffer.from(editor)}});
  const sourceRoot=path.join(f.root,'synthetic source checkout'),pkg=path.join(sourceRoot,'update');
  await fs.mkdir(pkg,{recursive:true});
  for(const name of ['bootstrap.cjs','protocol.cjs','paths.cjs','stage.cjs','state.cjs','http.cjs','launch.cjs','archive.ps1','coordinator.ps1','enroll.ps1']){
    await fs.copyFile(path.join(__dirname,name),path.join(pkg,name));
  }
  const archive=path.join(sourceRoot,'bundle.zip');
  await zipDirectory(archive,a.directory,a.release.files.map(x=>x.path));a=await f.sealArchive(a,archive);
  const options={
    AllowedRoot:f.root,InstallRoot:path.join(f.root,'installed \u03bb %CODEXS_TRIPWIRE% !bang! & caret^'),
    AllowedShimRoot:f.root,ShimRoot:path.join(f.root,'shims \u03bb %CODEXS_TRIPWIRE% !bang!'),
    PackageRoot:pkg,Bundle:archive,Manifest:path.join(a.directory,'release.json'),Signature:path.join(a.directory,'release.sig'),
    PublicKey:path.join(f.root,'bootstrap','release-public-key.pem'),NodePath:process.execPath,SettingsPath:f.config.settings_path,
  };
  const unicodeNode=path.join(f.root,'explicit node \u03bb \u0e2a\u0e35','node.exe');await fs.mkdir(path.dirname(unicodeNode),{recursive:true});await fs.copyFile(process.execPath,unicodeNode);options.NodePath=unicodeNode;
  const data=Buffer.from(JSON.stringify(options),'utf8').toString('base64');
  const body=[
    "$ErrorActionPreference='Stop'",
    "$o=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json",
    "$options=@{};foreach($p in $o.PSObject.Properties){$options[$p.Name]=$p.Value}",
    ". ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $o.PackageRoot 'enroll.ps1'))))",
    "$ops=Get-CodexsEnrollmentOperations;$ops.FreeBytes={param($Path) return [long]8589934592}",
    "Invoke-CodexsEnrollmentCore $options $ops -Install|ConvertTo-Json -Compress",
  ].join('\n');
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  await execute(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:65536});
  for(const name of ['codexs.cmd','codexs-statusline.cmd'])assert.ok((await fs.readFile(path.join(options.ShimRoot,name))).every(byte=>byte<128),'CMD shim must contain only ASCII');
  for(const name of ['codexs.ps1','codexs-statusline.ps1'])assert.equal(await fs.access(path.join(options.ShimRoot,name)).then(()=>true,()=>false),true,'PowerShell companion must exist');
  const current=JSON.parse(await fs.readFile(path.join(options.InstallRoot,'current.json'),'utf8'));
  await physicalStateCommit(options.InstallRoot,{...current,last_check_ms:Date.now(),next_check_ms:Date.now()+3600000});
  const stateBefore=await fs.readFile(path.join(options.InstallRoot,'current.json'));
  const settingsBefore=await fs.readFile(options.SettingsPath);
  await fs.rm(sourceRoot,{recursive:true});
  await fs.rm(path.join(f.root,'versions'),{recursive:true});
  await fs.rm(path.join(f.root,'bootstrap'),{recursive:true});
  await fs.unlink(path.join(f.root,'synthetic-probe.exe'));
  const record=path.join(f.root,'editor-record');
  const env={...process.env,PATH:options.ShimRoot+path.delimiter+path.join(process.env.SystemRoot,'System32'),
    SYNTHETIC_SECRET:'retained',CODEX_MANAGED_BY_NPM:'obsolete',CODEX_MANAGED_PACKAGE_ROOT:'obsolete',
    CODEXS_TEST_RECORD:record,CODEXS_TRIPWIRE:'must-never-expand',HOME:path.join(f.root,'synthetic-home'),CODEX_HOME:path.join(f.root,'synthetic-codex-home')};
  for(const key of Object.keys(env))if(key.toUpperCase()==='PATH'&&key!=='PATH')delete env[key];
  const where=path.join(process.env.SystemRoot,'System32','where.exe');
  for(const name of ['git','gh','npm','bun','codex']){
    await assert.rejects(execute(where,[name],{env,windowsHide:true,timeout:3000}),error=>error.code===1);
  }
  const expected=['two words','\u03bb','','literal"quote','100%','!literal!','123','-c','user_override=true'];
  for(const caller of ['powershell','cmd','cmd-delayed','cmd-legacy-codepage']){
    for(const directory of ['caller one','caller two \u03bb']){
      const cwd=path.join(f.root,directory);await fs.mkdir(cwd,{recursive:true});
      for(const mode of ['cli','editor']){
        const command=(mode==='cli'?'codexs':'codexs-statusline')+(caller==='powershell'?'':'.cmd');
        let failure;
        if(caller==='powershell'){
          const script="$ErrorActionPreference='Stop';$testArgs=@('two words','\u03bb','','literal\"quote','100%','!literal!',123,'-c','user_override=true');& '"+command+"' @testArgs;exit $LASTEXITCODE";
          try{await execute(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd,env,windowsHide:true,timeout:15000,maxBuffer:65536});}
          catch(error){failure=error;}
        }else{
          let args='"two words" "\u03bb" "" "literal\\"quote" "100%" "!literal!" 123 -c "user_override=true"';
          if(caller==='cmd-delayed')args=args.replace('!literal!','^!literal^!');
          try{await execute(path.join(process.env.SystemRoot,'System32','cmd.exe'),['/d',caller==='cmd-delayed'?'/v:on':'/v:off','/s','/c',(caller==='cmd-legacy-codepage'?'chcp 437 >nul & ':'')+command+' '+args],{cwd,env,windowsHide:true,windowsVerbatimArguments:true,timeout:15000,maxBuffer:65536});}
          catch(error){failure=error;}
        }
        assert.ok(failure,caller+' '+mode+' must preserve the synthetic exit');
        assert.equal(failure.code,mode==='cli'?2:17,caller+' '+mode+' '+String(failure.stderr));
        if(mode==='cli'){
          const lines=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/);
          const decode=value=>Buffer.from(value,'base64').toString('utf8');
          assert.equal(decode(lines[0]),cwd);
          assert.equal(decode(lines[1]),env.HOME);assert.equal(decode(lines[2]),env.CODEX_HOME);assert.equal(lines[3],'True');
          const args=lines[5].split('|').map(decode);
          assert.equal(args[0],'-c');assert.match(args[1],/^tui\.status_line_command\.command=/);
          assert.deepEqual(args.slice(2),expected,caller+' native argv');
          assert.equal(decode(lines[6]),path.join(options.InstallRoot,'versions',a.ref.release_id,'bin','codex.exe'));
        }else{
          const found=JSON.parse(await fs.readFile(record,'utf8'));
          assert.equal(found.cwd,cwd);assert.equal(found.secret,'retained');
          assert.equal(found.npm,undefined);assert.equal(found.packageRoot,undefined);
          assert.deepEqual(found.args,['--codex','--config',options.SettingsPath,...expected],caller+' editor argv');
          assert.equal(found.file,path.join(options.InstallRoot,'versions',a.ref.release_id,'formatter','dist','ccstatusline.js'));
          assert.equal(found.path.split(path.delimiter)[0],path.join(options.InstallRoot,'versions',a.ref.release_id,'codex-path'));
        }
      }
    }
  }
  assert.deepEqual(await fs.readFile(options.SettingsPath),settingsBefore);
  assert.deepEqual(await fs.readFile(path.join(options.InstallRoot,'current.json')),stateBefore);
});

test('real extraction adapter accepts large inventories without overflowing its bounded output',{timeout:30000},async t=>{
  const {zipDirectory}=require('../test-support/update-fixtures.cjs');
  const {createHash}=require('node:crypto');
  const f=await runtimeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const work=path.join(f.root,'large-inventory-adapter'),source=path.join(work,'source');
  await fs.mkdir(path.join(source,'synthetic'),{recursive:true});
  const files=[];
  for(let i=0;i<100;i++){
    const name='synthetic/entry-'+String(i).padStart(3,'0')+'.txt',bytes=Buffer.from('test');
    await fs.writeFile(path.join(source,name),bytes);
    files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const archive=path.join(work,'archive.zip'),inventory=path.join(work,'inventory.json'),destination=path.join(work,'payload');
  const text=JSON.stringify(files);assert.ok(Buffer.byteLength(text)>8192);
  await zipDirectory(archive,source,files.map(file=>file.path));await fs.writeFile(inventory,text);
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config});
  await ports.extract({archive,destination,inventory,allowedRoot:work});
  for(const file of files)assert.equal(await fs.readFile(path.join(destination,file.path),'utf8'),'test');
});

test('an empty installed manifest recovers only through the authenticated predecessor',{timeout:30000},async t=>{
  const f=await probeInstallation(t),a=await f.install(1),b=await f.install(2);
  await f.writeState(b.ref,{previous:a.ref});
  await fs.writeFile(path.join(b.directory,'release.json'),'');
  const stateBefore=await fs.readFile(path.join(f.root,'current.json'));
  const settingsBefore=await fs.readFile(f.config.settings_path);
  await assert.rejects(require('./bootstrap.cjs').bootstrap({mode:'cli',argv:['--version']},{root:f.root}),{code:'MANIFEST_SCHEMA'});
  assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),stateBefore);
  const run=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
  assert.deepEqual(await run.closed,[2,null],run.output().stderr);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  assert.deepEqual(state.current,a.ref);assert.deepEqual(state.rejected,[b.ref.release_id]);
  assert.equal(state.highest.sequence,2);assert.equal(state.previous,null);
  const record=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/);
  assert.equal(Buffer.from(record[6],'base64').toString(),path.join(a.directory,'bin','codex.exe'));
  assert.deepEqual(await fs.readFile(f.config.settings_path),settingsBefore);
});

test('a transient version-probe timeout permits a later retry of the same signed release',{timeout:30000},async t=>{
  const f=await probeInstallation(t),a=await f.install(1);
  let b=await f.install(2,{payload:Object.fromEntries(Array.from({length:100},(_,i)=>['extra/entry-'+String(i).padStart(3,'0')+'.txt',Buffer.from('synthetic')]))});
  assert.ok(Buffer.byteLength(JSON.stringify(b.release.files))>8192);
  const source=path.join(f.root,'synthetic-candidate-source'),archive=path.join(f.root,'synthetic-candidate.zip');
  assert.equal(path.dirname(b.directory),path.join(f.root,'versions'));assert.equal(path.dirname(source),f.root);
  await fs.rename(b.directory,source);b={...b,directory:source};
  await require('../test-support/update-fixtures.cjs').zipDirectory(archive,source,b.release.files.map(file=>file.path));
  b=await f.sealArchive(b,archive);
  await f.writeState(a.ref,{last_check_ms:0,next_check_ms:0});
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  let state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8')),now=10000000;
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config,
    statfs:async()=>({bavail:8589934592n,bsize:1n}),probeTimeoutMs:500});
  const feed={manifestBytes:await fs.readFile(path.join(b.directory,'release.json')),signature:await fs.readFile(path.join(b.directory,'release.sig')),assetId:1};
  const updatePorts={...ports,publicKey:f.publicKey,readState:async()=>({state}),
    commitState:async(root,next)=>{assert.equal(root,f.root);state=next;},
    fetchStableRelease:async()=>feed,now:()=>now,
    downloadAsset:async({destination})=>fs.copyFile(archive,destination,require('node:fs').constants.COPYFILE_EXCL)};
  const runUpdate=require('./stage.cjs').runUpdate;
  await fs.writeFile(path.join(f.root,'control'),'timeout');
  const first=await runUpdate({mode:'check',root:f.root,request:{}},updatePorts);
  assert.equal(first.code,'STAGE_IO');
  assert.deepEqual(state.rejected,[]);assert.equal(state.ready,null);assert.equal(state.highest.sequence,2);
  await fs.writeFile(path.join(f.root,'control'),'ok');
  now+=86400000;
  const second=await runUpdate({mode:'check',root:f.root,request:{}},updatePorts);
  assert.equal(second.code,'READY');assert.deepEqual(state.ready,b.ref);assert.deepEqual(state.rejected,[]);
  assert.deepEqual(state.current,a.ref);
});

test('extractor host start failures and timeouts stay retryable and preserve the same archive',{timeout:30000},async t=>{
  const {tinyZip}=require('../test-support/update-fixtures.cjs'),{createHash}=require('node:crypto');
  const f=await runtimeInstallation(t),original=await fs.readFile(path.join(__dirname,'archive.ps1'),'utf8');
  const delayed=original.replace('function Assert-ArchiveOwnedPath',
    "if([IO.File]::Exists((Join-Path $AllowedRoot 'slow'))){[Threading.Thread]::Sleep(10000)}\nfunction Assert-ArchiveOwnedPath");
  const a=await f.install(1,{payload:{'update/archive.ps1':Buffer.from(delayed)}});
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  const work=path.join(f.root,'host-extract'),archive=path.join(work,'archive.zip'),inventory=path.join(work,'inventory.json');
  await fs.mkdir(work);await tinyZip(archive,{'app.txt':'test'});
  await fs.writeFile(inventory,JSON.stringify([{path:'app.txt',bytes:4,sha256:createHash('sha256').update('test').digest('hex')}]));
  const target=path.join(work,'payload'),base={root:f.root,config:f.config};
  const missing=api().createUpdatePorts({verifiedRelease},{...base,env:{SystemRoot:path.join(f.root,'missing-system')}});
  await assert.rejects(missing.extract({archive,destination:target,inventory,allowedRoot:work}),{code:'EXTRACT_IO'});
  const controls={...base,extractTimeoutMs:1000},ports=api().createUpdatePorts({verifiedRelease},controls);
  await fs.writeFile(path.join(work,'slow'),'synthetic');
  await assert.rejects(ports.extract({archive,destination:target,inventory,allowedRoot:work}),{code:'EXTRACT_IO'});
  await fs.unlink(path.join(work,'slow'));controls.extractTimeoutMs=120000;
  await ports.extract({archive,destination:target,inventory,allowedRoot:work});
  assert.equal(await fs.readFile(path.join(target,'app.txt'),'utf8'),'test');
});
test('native smoke may complete its cleanup after the old fifteen second cutoff',{timeout:35000},async t=>{
  const f=await probeInstallation(t),a=await f.install();
  const verifiedRelease=await verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});
  await fs.writeFile(path.join(f.root,'control'),'smoke-long-cleanup');
  const ports=api().createUpdatePorts({verifiedRelease},{root:f.root,config:f.config});
  const start=Date.now();
  await ports.smoke({node:process.execPath,native:path.join(a.directory,'bin','codex.exe'),formatter:path.join(a.directory,'formatter/dist/ccstatusline.js')});
  assert.ok(Date.now()-start>=20000 && Date.now()-start<25000);
  const pid=Number((await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/)[4]);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('client supervision budgets reserve the approved native cleanup interval',()=>{
  assert.deepEqual(api().limits,{version:5000,smoke:25000,extract:120000,local:60000,outerLocal:70000,check:900000,outerCheck:910000,validator:5000,cleanup:5000});
  assert.equal(Object.isFrozen(api().limits),true);
});

test('the first promoted session executes the final signed launcher implementation',{timeout:30000},async t=>{
  const f=await probeInstallation(t),source=await fs.readFile(path.join(__dirname,'launch.cjs'),'utf8');
  const marked=label=>source.replace('...argv];',"'--launcher-"+label+"',...argv];");
  const a=await f.install(1,{payload:{'update/launch.cjs':Buffer.from(marked('A'))}});
  const b=await f.install(2,{payload:{'update/launch.cjs':Buffer.from(marked('B'))}});
  await f.writeState(a.ref,{ready:b.ref,highest:{sequence:2,manifest_sha256:b.ref.manifest_sha256}});
  for(let i=1;i<=2;i++){
    const run=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
    assert.deepEqual(await run.closed,[2,null],run.output().stderr);
    const lines=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\r?\n/);
    const args=lines[5].split('|').map(value=>Buffer.from(value,'base64').toString());
    assert.equal(args[2],'--launcher-B');
    assert.equal((await fs.readdir(f.root)).filter(name=>name.startsWith('native-launch-')).length,i);
  }
});
test('two observed corrupt-current recoveries do not roll back the winner twice',{timeout:30000},async t=>{
  const f=await probeInstallation(t);let source=await fs.readFile(path.join(__dirname,'launch.cjs'),'utf8');
  const barrier=[
    "const fs=require('node:fs'),path=require('node:path'),base=path.resolve(__dirname,'..','..','..');",
    "let winner=false;try{const fd=fs.openSync(path.join(base,'recovery-owner'),'wx');fs.closeSync(fd);winner=true;}catch(e){if(e.code!=='EEXIST')throw e;}",
    "fs.writeFileSync(path.join(base,'recovery-observed-'+process.pid),'synthetic');",
    "const stop=Date.now()+10000;while(fs.readdirSync(base).filter(x=>x.startsWith('recovery-observed-')).length<2){if(Date.now()>stop)throw Error('SYNTHETIC_BARRIER');await new Promise(r=>setTimeout(r,10));}",
    "if(!winner){while(!fs.existsSync(path.join(base,'recovery-winner-done'))){if(Date.now()>stop)throw Error('SYNTHETIC_WINNER');await new Promise(r=>setTimeout(r,10));}}",
  ].join('\n');
  source+='\nconst originalMain=module.exports.main;module.exports.main=async(input,ports)=>{if(!ports.recoverPrevious)return originalMain(input,ports);'+barrier+'\nconst code=await originalMain(input,ports);if(winner)fs.writeFileSync(path.join(base,\"recovery-winner-done\"),\"synthetic\");return code;};';
  const a=await f.install(1,{payload:{'update/launch.cjs':Buffer.from(source)}}),b=await f.install(2);
  await f.writeState(b.ref,{previous:a.ref});await fs.writeFile(path.join(b.directory,'release.json'),'');
  const stateBefore=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  const one=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli'),two=await startInstalled(t,f,[],{HOME:f.root,CODEX_HOME:f.root},'cli');
  const exits=await Promise.all([one.closed,two.closed]);assert.deepEqual(exits[0],[2,null],one.output().stderr);assert.deepEqual(exits[1],[2,null],two.output().stderr);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'));
  assert.deepEqual(state.current,a.ref);assert.equal(state.previous,null);assert.deepEqual(state.rejected,[b.ref.release_id]);
  assert.deepEqual(state.highest,stateBefore.highest);
  assert.equal((await fs.readdir(f.root)).filter(name=>name.startsWith('native-launch-')).length,2);
});

test('old footer callbacks keep their authenticated formatter after promotion and preserve nonzero status',{timeout:30000},async t=>{
  const f=await runtimeInstallation(t);
  const payload=label=>Buffer.from("const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat([Buffer.from('"+label+"'),...chunks]));process.stderr.write('independent');process.exitCode=17;});");
  const a=await f.install(1,{payload:{'formatter/dist/ccstatusline.js':payload('A')}});
  let state=await f.writeState(a.ref);
  const resolve=async ref=>api().resolveLaunch({root:f.root,mode:'cli',argv:[],verifiedRelease:await verifyInstalledRelease({root:f.root,releaseRef:ref},{publicKey:f.publicKey})},{config:f.config});
  const old=await resolve(a.ref);
  const b=await f.install(2,{payload:{'formatter/dist/ccstatusline.js':payload('B')}});
  state=transition(transition(transition(state,{type:'manifest-seen',ref:b.ref}),{type:'stage-ready',ref:b.ref}),{type:'promote'});
  await physicalStateCommit(f.root,state);
  const fresh=await resolve(b.ref);
  for(const [plan,label]of [[old,'A'],[fresh,'B']]){
    const command=JSON.parse(plan.args[1].slice('tui.status_line_command.command='.length));
    const child=spawn(command,[],{shell:path.join(process.env.SystemRoot,'System32/cmd.exe'),windowsHide:true,env:plan.env,stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[];child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));child.stdin.on('error',()=>{});
    const done=once(child,'close'),timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},2000);
    t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();});
    const bytes=Buffer.from([0,127,255,10]);child.stdin.end(bytes);
    const [code,signal]=await done;clearTimeout(timer);
    assert.equal(signal,null);assert.equal(code,17,Buffer.concat(stderr).toString());
    assert.deepEqual(Buffer.concat(stdout),Buffer.concat([Buffer.from(label),bytes]));
    assert.equal(Buffer.concat(stderr).toString(),'independent');
  }
});

test('aliased TEMP preserves actual probe isolation and owned fixture cleanup',{timeout:45000},async t=>{
  const {promisify}=require('node:util'),execute=promisify(require('node:child_process').execFile);
  const tempRoot=require('node:fs').realpathSync.native(require('node:os').tmpdir());
  const parent=await fs.mkdtemp(path.join(tempRoot,'codexs-temp-alias-test-'));
  t.after(async()=>{
    if(path.dirname(parent)!==tempRoot || !path.basename(parent).startsWith('codexs-temp-alias-test-'))throw Error('Unsafe alias fixture cleanup');
    await fs.rm(parent,{recursive:true,maxRetries:10,retryDelay:100});
  });
  const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script="$ErrorActionPreference='Stop';$folder=(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CODEXS_ALIAS_PARENT);[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($folder.ShortPath)))";
  const short=await execute(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,CODEXS_ALIAS_PARENT:parent},windowsHide:true,timeout:10000});
  let alias=Buffer.from(short.stdout.trim(),'base64').toString('utf8');
  const shortAlias=alias.toLowerCase()!==parent.toLowerCase();
  // A case alias keeps this regression executable on volumes with new 8.3 names disabled.
  if(!shortAlias)alias=path.join(path.dirname(parent),path.basename(parent).toUpperCase());
  assert.notEqual(alias,parent,'regression must use a distinct path spelling');
  assert.equal(await fs.realpath(alias),parent,'alias must resolve to the owned physical directory');
  const driver=path.join(parent,'probe.cjs');
  const program=[
    "'use strict';",
    "const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');",
    "const helper=require(process.argv[2]),update=path.join(path.dirname(process.argv[2]),'..','update'),cleanups=[];",
    "(async()=>{let fixtureRoot;",
    "try{const f=await helper.probeInstallation({after:fn=>cleanups.push(fn)});fixtureRoot=f.root;",
    "const a=await f.install(),verifiedRelease=await require(path.join(update,'bootstrap.cjs')).verifyInstalledRelease({root:f.root,releaseRef:a.ref},{publicKey:f.publicKey});",
    "const ports=require(path.join(update,'launch.cjs')).createUpdatePorts({verifiedRelease},{root:f.root,config:f.config});",
    "const paths={node:process.execPath,native:path.join(a.directory,'bin/codex.exe'),formatter:path.join(a.directory,'formatter/dist/ccstatusline.js')};",
    "assert.deepEqual(await ports.probeVersion(paths),{native:'0.166.0',formatter:'2.2.32'});await ports.smoke(paths);",
    "const row=(await fs.readFile(path.join(f.root,'probe-record'),'utf8')).trim().split(/\\r?\\n/),decode=value=>Buffer.from(value,'base64').toString('utf8'),cwd=decode(row[0]);",
    "assert.ok(cwd.startsWith(path.join(f.root,'probes')+path.sep),'actual probe cwd must stay in the fixture probe directory');",
    "assert.equal(decode(row[1]),cwd);assert.equal(decode(row[2]),cwd);assert.equal(row[3],'False');",
    "assert.equal(path.dirname(f.root),require('node:fs').realpathSync.native(require('node:os').tmpdir()));",
    "}finally{for(const cleanup of cleanups.reverse())await cleanup();}",
    "await assert.rejects(fs.stat(fixtureRoot),{code:'ENOENT'},'fixture cleanup must remove its owned directory');",
    "console.log(JSON.stringify({probe_isolated:true,cleanup:true}));",
    "})().catch(error=>{console.error(error.stack);process.exitCode=1;});",
  ].join('\n');
  await fs.writeFile(driver,program);
  const env={...process.env,TEMP:alias,TMP:alias,SYNTHETIC_SECRET:'alias-proof-private-sentinel'};delete env.NODE_TEST_CONTEXT;
  let result;
  try{result=await execute(process.execPath,[driver,path.join(__dirname,'..','test-support/update-fixtures.cjs')],{env,windowsHide:true,timeout:30000,maxBuffer:1048576});}
  catch(error){assert.fail('aliased TEMP probe failed: '+error.stderr);}
  assert.deepEqual(JSON.parse(result.stdout.trim()),{probe_isolated:true,cleanup:true});
  t.diagnostic('TEMP alias exercised: '+(shortAlias?'8.3':'case'));
});
