'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixtureTempRoot, evidenceFixture,footerOverlay,upstreamPackages,releaseManifest } = require('../test-support/update-fixtures.cjs');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/codexs-statusline.yml'), 'utf8').replace(/\r\n?/g,'\n');

function automaticWorkflow(name){return fs.readFileSync(path.join(root,'.github/workflows/codexs-'+name+'.yml'),'utf8').replace(/\r\n?/g,'\n');}
function automaticProgram(workflow,job,name){const shell=jobStepBody(job,name,automaticWorkflow(workflow)),match=shell.match(/\$program=@'\n([\s\S]*?)\n'@/);assert.ok(match,'actual Node boundary required');return match[1];}
async function runAutomatic(workflow,job,name,{env={},load=require}={}){
  const program=automaticProgram(workflow,job,name),processFixture={env:{GITHUB_WORKSPACE:root,GITHUB_REPOSITORY:'TK-06/codexs',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'TK-06/codexs/.github/workflows/codexs-'+workflow+'.yml@refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'900',GITHUB_RUN_ATTEMPT:'1',CODEXS_MODE:'validate',CODEXS_UPDATES_ENABLED:'',CODEXS_RELEASES_ENABLED:'',...env},exitCode:0},messages=[];
  const value=new Function('require','process','console',program.replace('(async()=>','return (async()=>'))(load,processFixture,{log:value=>messages.push(value),error:value=>messages.push(value)});
  await value;return {process:processFixture,messages};
}

test('task10 workflow: disabled discovery executes its actual guard without invoking any port',async()=>{
  for(const flag of ['', 'false','True']){
    let ports=0;const result=await runAutomatic('upstream','discover','Discover stable upstream',{env:{CODEXS_MODE:'routine',CODEXS_UPDATES_ENABLED:flag},load:name=>name===path.join(root,'codexs/release/controller.cjs')?{...require(name),createControllerPorts:()=>{ports++;throw Error('forbidden');}}:name==='node:fs/promises'?{appendFile:async()=>{}}:require(name)});
    assert.equal(result.process.exitCode,0);assert.equal(ports,0);
  }
});

test('task10 workflow: actual policy gate separates validation initial and routine publication',async()=>{
  for(const [mode,event,flag,publish]of [['validate','workflow_dispatch','true',false],['initial','workflow_dispatch','false',true],['initial','workflow_call','true',false],['routine','workflow_call','false',false],['routine','workflow_call','true',true]]){
    let output='';const result=await runAutomatic('release','policy','Authorize release mode',{env:{CODEXS_MODE:mode,GITHUB_EVENT_NAME:event,CODEXS_RELEASES_ENABLED:flag},load:name=>name==='node:fs/promises'?{appendFile:async(file,text)=>{output+=text;}}:require(name)});
    assert.equal(result.process.exitCode,0);assert.ok(output.includes('publish='+publish));
  }
});

test('task10 workflow: dependency graph pins actions and isolates the only signing environment',()=>{
  const upstream=automaticWorkflow('upstream'),release=automaticWorkflow('release');
  assert.match(upstream,/cron: '17 \*\/6 \* \* \*'/);assert.match(upstream,/group: codexs-upstream-controller\n  cancel-in-progress: false/);
  for(const text of [upstream,release]){assert.doesNotMatch(text,/secrets: inherit/);for(const use of text.matchAll(/uses: ([^\n#]+)/g))assert.match(use[1].trim(),/^(?:\.\/\.github\/workflows\/codexs-release.yml|actions\/(?:checkout|setup-node|upload-artifact)@[a-f0-9]{40})$/);}
  const jobs=[...release.matchAll(/^  ([a-z_]+):\n([\s\S]*?)(?=^  [a-z_]+:|$(?![\s\S]))/gm)].filter(match=>match[2].includes('runs-on:'));
  assert.deepEqual(jobs.filter(match=>/CODEXS_RELEASE_SIGNING_KEY: \$\{\{ secrets\./.test(match[2])).map(match=>match[1]),['publish']);
  const publish=jobs.find(match=>match[1]==='publish')[2];assert.match(publish,/needs: \[policy, acceptance\]/);assert.match(publish,/needs\.acceptance\.result == 'success'/);assert.match(publish,/needs\.policy\.outputs\.publish == 'true'/);assert.match(publish,/group: codexs-stable-publisher\n      cancel-in-progress: false/);
  assert.ok(publish.indexOf('Stage accepted publication data')<publish.indexOf('CODEXS_RELEASE_SIGNING_KEY:'));
  const signing=automaticProgram('release','publish','Sign and publish accepted bytes');assert.doesNotMatch(signing,/child_process|execFile|spawn|extract|prepareCandidate|prepareNativeTree|npm |cargo /);assert.match(signing,/publishStable/);
  assert.match(upstream,/secrets:\n      CODEXS_RELEASE_SIGNING_KEY: \$\{\{ secrets.CODEXS_RELEASE_SIGNING_KEY \}\}/);
});

test('task10 workflow: orchestration uses its actual inputs and does not expose a key',async()=>{
  const input={candidate_sha:'b'.repeat(40),baseline_sha:'a'.repeat(40),source_version:'0.166.0',formatter_sha:'d'.repeat(40),formatter_version:'2.2.32',product_version:'1.0.0',mode:'validate',native_reuse_request:''};let received,output='';
  const result=await runAutomatic('release','acceptance','Run completed acceptance',{env:{CODEXS_INPUT:JSON.stringify(input),GH_TOKEN:'synthetic-token'},load:name=>{
    if(name==='node:fs/promises')return {appendFile:async(file,text)=>{output+=text;}};
    if(name===path.join(root,'codexs/release/controller.cjs'))return {...require(name),createControllerPorts:()=>({dispatch:async()=>{}}),runAcceptance:async actual=>{received=actual;return {request:{},final:{}};}};
    return require(name);
  }});
  assert.equal(result.process.exitCode,0);assert.equal(received.candidateSha,input.candidate_sha);assert.equal(received.parentRunId,900);assert.equal(received.nativeReuse,null);assert.equal(output.startsWith('gate='),true);assert.equal(automaticProgram('release','acceptance','Run completed acceptance').includes('RELEASE_SIGNING_KEY'),false);
});

test('task10 workflow: LF and CRLF retain identical automatic entry programs',()=>{
  for(const [workflow,job,name]of [['upstream','discover','Discover stable upstream'],['upstream','prepare_candidate','Prepare dedicated candidate'],['release','policy','Authorize release mode'],['release','acceptance','Run completed acceptance'],['release','publish','Stage accepted publication data'],['release','publish','Sign and publish accepted bytes']]){
    const text=automaticWorkflow(workflow);assert.equal(jobStepBody(job,name,text),jobStepBody(job,name,text.replace(/\n/g,'\r\n')));
  }
});

test('task10 workflow: discovery skips an already signed accepted stable version regardless of object key order',async()=>{
  const crypto=require('node:crypto'),protocol=require('../update/protocol.cjs'),manifest=releaseManifest(),keys=crypto.generateKeyPairSync('ed25519'),bytes=protocol.encodeRelease(manifest),signature=crypto.sign(null,Buffer.concat([Buffer.from('codexs-release-v1\0'),bytes]),keys.privateKey);let output='';
  const result=await runAutomatic('upstream','discover','Discover stable upstream',{env:{CODEXS_UPDATES_ENABLED:'true',CODEXS_RELEASE_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'})},load:name=>{
    if(name==='node:fs/promises')return {appendFile:async(file,text)=>{output+=text;}};
    if(name===path.join(root,'codexs/release/controller.cjs'))return {...require(name),createControllerPorts:()=>({})};
    if(name===path.join(root,'codexs/release/publish.cjs'))return {...require(name),discoverUpstream:async()=>({version:manifest.upstream.version,tag:manifest.upstream.tag,sha:manifest.upstream.sha,packages:{main:manifest.packages.main,helper:manifest.packages.helper}}),createControlClient:()=>({main:async()=>{},json:async()=>({value:{id:1,tag_name:manifest.release_id,draft:false,prerelease:false,assets:[{id:2,name:'release.json'},{id:3,name:'release.sig'}]}})}),createPublisherPorts:()=>({readAsset:async source=>source.name==='release.json'?bytes:signature})};
    return require(name);
  }});
  assert.equal(result.process.exitCode,0,result.messages.join('|'));assert.equal(output,'ready=false\n');
});

async function actualCandidateWriter({changedMain=false,conflictingRef=false}={}){
  const metadata=footerOverlay(),patch=metadata.patch_bytes;delete metadata.revision;delete metadata.patch_bytes;
  const temporary=path.join(os.tmpdir(),"synthetic owned ไทย %PATH%! apostrophe'"),owned=path.join(temporary,'codexs-candidate-synthetic'),candidate='f'.repeat(40),controller='c'.repeat(40),gitCalls=[],written=new Map(),packages=upstreamPackages();let published=false,output='';
  const message='codexs-upstream:v1\nupstream_sha='+'a'.repeat(40)+'\noverlay_sha='+controller+'\npatch_sha256='+metadata.patch_sha256;
  const fakeFS={
    realpath:async value=>value,mkdtemp:async()=>owned,
    writeFile:async(file,bytes)=>{written.set(file,bytes);},appendFile:async(file,text)=>{output+=text;},
    readFile:async file=>{if(written.has(file))return written.get(file);if(file===path.join(root,'codexs/upstream/overlay.json'))return JSON.stringify(metadata);if(file===path.join(root,'codexs/upstream/overlay.patch'))return patch;if(file===path.join(root,'formatter-source/package.json'))return '{"version":"2.2.32"}';if(file.endsWith(path.join('tui','Cargo.toml')))return '[package]\nname = "codex-tui"\nversion.workspace = true\n';if(file.endsWith('Cargo.lock'))return 'version = 4\n\n[[package]]\nname = "codex-tui"\nversion = "0.0.0"\n';if(file.endsWith('Cargo.toml'))return '[workspace]\nmembers = ["tui"]\n[workspace.package]\nversion = "0.166.0"\n';throw Error('unexpected owned fixture read');},
  };
  const execFile=async(file,args,options)=>{
    gitCalls.push({file,args:[...args],options});const command=args.slice(4);let stdout='';
    if(command[0]==='rev-parse')stdout=options.cwd===owned?candidate:metadata.formatter_sha;
    if(command[0]==='diff')stdout=metadata.paths.join('\n');if(command[0]==='show')stdout=candidate+'\n'+'a'.repeat(40)+'\n'+message+'\n';if(command[0]==='push')published=true;
    return {stdout,stderr:''};
  };
  const transport=async url=>new Response(JSON.stringify(url.includes('/heads/main')?{object:{sha:changedMain?'e'.repeat(40):controller}}:url.includes('/git/ref/heads/')?(published?{object:{sha:candidate}}:conflictingRef?{object:{sha:'e'.repeat(40)}}:null):{message:'unrelated'}),{status:!url.includes('/heads/main')&&!published&&!conflictingRef?404:200});
  const ports={listUpstreamReleases:async()=>({releases:[{tag_name:'rust-v0.166.0',draft:false,prerelease:false}],hasNext:false}),resolveTag:async()=> 'a'.repeat(40),getPackage:async version=>version.endsWith('-win32-x64')?packages.helper:packages.main};
  const result=await runAutomatic('upstream','prepare_candidate','Prepare dedicated candidate',{env:{RUNNER_TEMP:temporary,CODEXS_UPDATES_ENABLED:'true',GH_TOKEN:'synthetic-token',CODEXS_EXPECTED_UPSTREAM:JSON.stringify({version:'0.166.0',tag:'rust-v0.166.0',sha:'a'.repeat(40)})},load:name=>{
    if(name==='node:fs/promises')return fakeFS;if(name==='node:util')return {promisify:()=>execFile};if(name==='node:child_process')return {execFile:()=>{throw Error('unpromisified execution forbidden');}};
    if(name===path.join(root,'codexs/release/controller.cjs'))return {...require(name),createControllerPorts:()=>ports};if(name===path.join(root,'codexs/release/publish.cjs'))return {...require(name),createControlClient:options=>require(name).createControlClient({...options,fetch:transport})};return require(name);
  }});
  return {result,gitCalls,owned,published,output};
}

test('task10 workflow: candidate writer preserves special paths in argument vectors and publishes only the derived ref',async()=>{
  const f=await actualCandidateWriter();assert.equal(f.result.process.exitCode,0,f.result.messages.join('|'));assert.equal(f.published,true);
  const push=f.gitCalls.filter(call=>call.args.includes('push'));assert.equal(push.length,1);assert.deepEqual(push[0].args.slice(-4),['push','--no-verify','https://github.com/TK-06/codexs.git','f'.repeat(40)+':refs/heads/automation/upstream/0.166.0-'+'c'.repeat(12)]);
  for(const call of f.gitCalls){assert.equal(call.file,'git');assert.equal(call.options.shell,undefined);assert.equal(call.args.some(arg=>arg==='--force'||arg.startsWith('+')),false);assert.equal(JSON.stringify(call.args).includes('synthetic-token'),false);assert.equal(call.options.env.CODEXS_RELEASE_SIGNING_KEY,undefined);}
  assert.equal(push[0].options.cwd,f.owned);assert.ok(push[0].options.env.GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic '));assert.match(f.output,/candidate_sha=ffffffff/);
});

for(const failure of ['changedMain','conflictingRef'])test('task10 workflow: actual candidate writer blocks '+failure+' without a push',async()=>{
  const f=await actualCandidateWriter({[failure]:true});assert.notEqual(f.result.process.exitCode,0);assert.equal(f.published,false);
});

function publicationWorkflowFixture(){
  const f=evidenceFixture(),crypto=require('node:crypto'),protocol=require('../update/protocol.cjs'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const base=releaseManifest(),archive=Buffer.from('synthetic runtime ZIP data, never executed'),enrollmentZip=Buffer.from('synthetic controller ZIP data, never executed');delete base.sequence;delete base.release_id;delete base.evidence;base.archive={name:'codexs-windows-x64.zip',bytes:archive.length,sha256:hash(archive)};
  const enrollment={controller_sha:'c'.repeat(40),bytes:enrollmentZip.length,sha256:hash(enrollmentZip),files:[{path:'update/bootstrap.cjs',bytes:1,sha256:'1'.repeat(64)}]};
  f.input.candidate.archive={bytes:archive.length,sha256:hash(archive)};f.replaceFiles('bundle',files=>{const receipt=JSON.parse(files['acceptance.json']);receipt.archive={...f.input.candidate.archive};files['acceptance.json']=JSON.stringify(receipt);});
  const entries={'codexs-windows-x64.zip':archive,'manifest-base.json':protocol.encodeRelease(base),'codexs-enrollment.zip':enrollmentZip,'enrollment.json':protocol.encodeRelease(enrollment)};
  const bundleArtifact=f.addDistributionArtifact('bundle',entries),format=f.input.runs.find(ref=>ref.scope==='formatter');
  const final={repository:'TK-06/codexs',run:170,attempt:1,controller_sha:'c'.repeat(40),validation_id:'synthetic-evidence',job:171,artifact:172},finalBytes=Buffer.from('synthetic completed final artifact');
  f.runs.set(final.run,{...f.runs.get(110),id:170});f.jobs.set(final.job,{...f.jobs.get(161),id:171,run_id:170,name:'Complete release evidence',steps:[{name:'Collect completed exact-archive evidence',status:'completed',conclusion:'success'}]});
  const name='codexs-task9-evidence-synthetic-evidence-170-1';f.artifacts.set(final.artifact,{id:172,name,expired:false,workflow_run:{id:170,head_sha:'c'.repeat(40)},size_in_bytes:finalBytes.length,digest:'sha256:'+hash(finalBytes)});f.bytes.set(172,finalBytes);
  f.jobLogs.set(171,'SHA256 digest of uploaded artifact is '+hash(finalBytes)+'\nArtifact '+name+' successfully finalized. Artifact ID 172\nArtifact '+name+' has been successfully uploaded! Final size is '+finalBytes.length+' bytes. Artifact ID is 172');
  const gate={request:{runs:f.input.runs,formatter_artifact:format.artifact+1000,bundle_artifact:bundleArtifact},final},input={candidate_sha:base.native_sha,baseline_sha:base.upstream.sha,source_version:base.upstream.version,formatter_sha:base.formatter.sha,formatter_version:base.formatter.version,product_version:base.product_version,mode:'initial',native_reuse_request:''};
  const parent=path.join(os.tmpdir(),'synthetic-publication-parent'),owned=path.join(parent,'codexs-publish-synthetic'),writes=new Map();let output='';
  const fakeFS={realpath:async value=>value,mkdtemp:async()=>owned,writeFile:async(file,bytes)=>{writes.set(file,Buffer.from(bytes));},appendFile:async(file,text)=>{output+=text;}};
  const env={CODEXS_MODE:'initial',CODEXS_INPUT:JSON.stringify(input),CODEXS_GATE:JSON.stringify(gate),GH_TOKEN:'synthetic-token',RUNNER_TEMP:parent};
  const load=name=>{if(name==='node:fs/promises')return fakeFS;if(name===path.join(root,'codexs/release/evidence.cjs'))return {...require(name),createGithubClient:()=>f.github};if(name===path.join(root,'codexs/release/publish.cjs'))return {...require(name),createControlClient:()=>({main:async()=>{}})};return require(name);};
  return {f,base,archive,enrollment,enrollmentZip,entries,gate,input,env,load,writes,owned,output:()=>output,reseal:()=>f.addDistributionArtifact('bundle',entries)};
}

test('task10 workflow: pre-key script recomputes all eight suites and stages only the accepted bytes',async()=>{
  const f=publicationWorkflowFixture(),result=await runAutomatic('release','publish','Stage accepted publication data',f);
  assert.equal(result.process.exitCode,0,result.messages.join('|'));assert.equal(result.process.env.GH_TOKEN,undefined);assert.equal(result.process.env.CODEXS_RELEASE_SIGNING_KEY,undefined);assert.equal(f.writes.size,5);
  const evidence=JSON.parse(f.writes.get(path.join(f.owned,'evidence.json')));assert.equal(Object.keys(evidence.suites).length,8);assert.equal(evidence.build_exit,0);assert.deepEqual(f.writes.get(path.join(f.owned,'codexs-windows-x64.zip')),f.archive);
  assert.equal(f.output(),'data_root='+f.owned+'\n');
});

for(const name of ['wrong final head','unfinished final','changed final bytes','zero discovery','changed runtime bytes','wrong enrollment'])test('task10 workflow: pre-key script rejects '+name+' without staging',async()=>{
  const f=publicationWorkflowFixture();
  if(name==='wrong final head')f.f.runs.get(170).head_sha='e'.repeat(40);if(name==='unfinished final')f.f.runs.get(170).status='in_progress';if(name==='changed final bytes')f.f.bytes.set(172,Buffer.from('substituted'));
  if(name==='zero discovery')f.f.replaceFiles('feature',files=>{files['cargo.log']=files['cargo.log'].replace('150 passed','0 passed');});
  if(name==='changed runtime bytes'){f.entries['codexs-windows-x64.zip']=Buffer.from('different runtime');f.reseal();}
  if(name==='wrong enrollment'){f.enrollment.controller_sha='e'.repeat(40);f.entries['enrollment.json']=require('../update/protocol.cjs').encodeRelease(f.enrollment);f.reseal();}
  const result=await runAutomatic('release','publish','Stage accepted publication data',f);assert.notEqual(result.process.exitCode,0);assert.equal(f.writes.size,0);
});

test('task10 workflow: signing entry passes staged data through the real data-only publisher',async()=>{
  const f=publicationWorkflowFixture(),stage=await runAutomatic('release','publish','Stage accepted publication data',f);assert.equal(stage.process.exitCode,0,stage.messages.join('|'));
  const crypto=require('node:crypto'),keys=crypto.generateKeyPairSync('ed25519'),assets=new Map(),release={id:1,tag:'',body:'',draft:true,prerelease:false,assets:[]};let signed=0,promoted=0;
  const ports={controllerSha:'c'.repeat(40),publicKey:keys.publicKey,listReleases:async()=>({releases:[],tags:[]}),createDraft:async({tag,body})=>{release.tag=tag;release.body=body;return structuredClone(release);},upload:async({name,bytes})=>{const asset={id:assets.size+1,name,size:bytes.length};assets.set(asset.id,Buffer.from(bytes));release.assets.push(asset);return asset;},readAsset:async source=>source.kind==='local'?f.writes.get(source.path):assets.get(source.assetId),makeStable:async()=>{promoted++;return {...release,draft:false};},sign:async(keyRef,bytes)=>{assert.equal(keyRef,'CODEXS_RELEASE_SIGNING_KEY');signed++;return crypto.sign(null,bytes,keys.privateKey);},latestUpstream:async()=>({...f.base.upstream,packages:f.base.packages})};
  const result=await runAutomatic('release','publish','Sign and publish accepted bytes',{env:{RUNNER_TEMP:f.env.RUNNER_TEMP,CODEXS_DATA_ROOT:f.owned,GH_TOKEN:'synthetic-token',CODEXS_RELEASE_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}),CODEXS_RELEASE_SIGNING_KEY:'synthetic-reference-only'},load:name=>{
    if(name==='node:fs/promises')return {realpath:async value=>value};if(name===path.join(root,'codexs/update/paths.cjs'))return {...require(name),readBoundedFile:async file=>f.writes.get(file)};
    if(name===path.join(root,'codexs/release/publish.cjs'))return {...require(name),createPublisherPorts:options=>{assert.equal(options.bundleRoot,f.owned);assert.equal(options.controllerSha,'c'.repeat(40));assert.equal(options.keyRef,'CODEXS_RELEASE_SIGNING_KEY');return ports;}};return require(name);
  }});
  assert.equal(result.process.exitCode,0,result.messages.join('|'));assert.equal(signed,1);assert.equal(promoted,1);assert.equal(assets.size,5);
});

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

function execute(name, context = {}, extra = {}, inspect, prelude = '', timeout = 10000) {
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
    const script = path.join(directory, 'step.ps1');
    fs.writeFileSync(script, prelude + '\n' + selected.body);
    env.CODEXS_TEST_SCRIPT = script;
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_TEST_SCRIPT)))'], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout });
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

function nativeJobEnabled(outputs) {
  const job=source.match(/^  windows:\r?\n([\s\S]*?)(?=^  [a-z_]+:|$(?![\s\S]))/m);
  assert.ok(job,'native job must remain defined');
  const condition=job[1].match(/^    if: (.+)$/m);
  if(!condition)return true;
  const expression=condition[1].replace(/^\$\{\{\s*|\s*\}\}$/g,'');
  const compare=expression.match(/^needs\.plan\.outputs\.([a-z_]+) == '([^']*)'$/);
  assert.ok(compare,'native policy must remain a supported explicit plan-output comparison');
  return outputs[compare[1]]===compare[2];
}

test('formatter bundle and evidence stages resolve immutable inputs without enabling a Cargo job',()=>{
  for(const scope of ['formatter','bundle','evidence']){
    const request={runs:[{}],formatter_artifact:1,...(scope==='evidence'?{bundle_artifact:2}:{})};
    const result=execute('Resolve execution scopes',caller({scope,formatter_sha:'d'.repeat(40),formatter_version:'2.2.32',source_version:'0.166.0',product_version:'1.0.0',evidence_request:JSON.stringify(request)}));
    assert.equal(result.status,0,result.stderr);
    const outputs=Object.fromEntries(result.outputs.trim().split(/\r?\n/).map(line=>{const split=line.indexOf('=');return [line.slice(0,split),line.slice(split+1)];}));
    assert.equal(outputs.native_required,'false');assert.equal(nativeJobEnabled(outputs),false);
    assert.deepEqual(JSON.parse(outputs.matrix),{scope:[scope]});
    const locator=JSON.parse(outputs.validation_summary);assert.equal(locator.verified,false);
    assert.ok(locator.artifacts.includes(`codexs-task9-${scope}-cleanup-101-1`));
  }
  for(const scope of ['feature','cleanup']){
    const result=execute('Resolve execution scopes',caller({scope}));assert.equal(result.status,0,result.stderr);
    const outputs=Object.fromEntries(result.outputs.trim().split(/\r?\n/).map(line=>{const split=line.indexOf('=');return [line.slice(0,split),line.slice(split+1)];}));
    assert.equal(outputs.native_required,'true');assert.equal(nativeJobEnabled(outputs),true);
  }
});

test('bundle-stage selection requires a full formatter SHA and stable source version',()=>{
  for(const overrides of [{formatter_sha:''},{formatter_sha:'main'},{formatter_version:''},{formatter_version:'2.2.32-beta.1'},{source_version:''},{source_version:'0.166.0-beta.1'},{candidate_sha:''},{baseline_sha:''}]){
    const result=execute('Resolve execution scopes',caller({scope:'formatter',formatter_sha:'d'.repeat(40),formatter_version:'2.2.32',source_version:'0.166.0',...overrides}));
    assert.notEqual(result.status,0,'accepted incomplete bundle-stage identity');
  }
});

test('bundle collection requires bounded data locators and a stable product version before scheduling',()=>{
  const base={scope:'bundle',formatter_sha:'d'.repeat(40),formatter_version:'2.2.32',source_version:'0.166.0',product_version:'1.0.0',evidence_request:JSON.stringify({runs:[{}],formatter_artifact:1})};
  for(const change of [{evidence_request:''},{evidence_request:'x'.repeat(17000)},{evidence_request:'{"command":"untrusted"}'},{product_version:'1.0.0-beta.1'}]){
    const result=execute('Resolve execution scopes',caller({...base,...change}));
    assert.notEqual(result.status,0,'accepted invalid bundle collection input');
  }
  for(const scope of ['bundle','evidence']){
    const request={runs:[{}],formatter_artifact:1,...(scope==='evidence'?{bundle_artifact:2}:{})};
    const result=execute('Resolve execution scopes',caller({...base,scope,evidence_request:JSON.stringify(request)}));
    assert.equal(result.status,0,result.stderr);
  }
});

test('bundle and final evidence jobs wait for quick checks and retain read-only artifact permissions',()=>{
  for(const [job,scope]of [['bundle_acceptance','bundle'],['release_evidence','evidence']]){
    const section=source.match(new RegExp('^  '+job+':\\r?\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))','m'));
    assert.ok(section,'missing actual job '+job);
    assert.match(section[1],new RegExp("^    if: inputs.scope == '"+scope+"'",'m'));
    assert.match(section[1],/^    needs: \[plan, quick_checks\]$/m);
    assert.match(section[1],/^      contents: read$/m);assert.match(section[1],/^      actions: read$/m);
    assert.doesNotMatch(section[1],/contents: write|secrets\.CODEXS_RELEASE_SIGNING_KEY|secrets: inherit|cargo (?:test|build)/);
  }
});

function jobStepBody(job,name,text=source) {
  text=text.replace(/\r\n?/g,'\n');
  const declaration=new RegExp('^  '+job+':\\r?\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))','m');
  const section=text.match(declaration);assert.ok(section,'missing actual job: '+job);
  const chunks=section[1].split(/^      - name: /m).slice(1),chunk=chunks.find(value=>value.split(/\r?\n/)[0]===name);
  assert.ok(chunk,'missing actual job step: '+name);
  const body=chunk.match(/^        run: \|\r?\n((?:          [^\r\n]*(?:\r?\n|$)|\r?\n)+)/m);
  assert.ok(body,'missing actual job script: '+name);return body[1].replace(/^          /gm,'');
}

async function candidateBundlePreflight(kind) {
  const shell=jobStepBody('bundle_acceptance','Prepare verified bundle inputs');
  const match=shell.match(/\$program=@'\n([\s\S]*?)\n'@/);assert.ok(match,'missing actual bundle preparation program');
  const program=match[1],end=program.indexOf('const parent=await fs.realpath');assert.ok(end>0,'missing native preparation boundary');
  const patch=Buffer.from('synthetic trusted overlay');
  const metadata={schema:1,base_sha:'a'.repeat(40),accepted_sha:'e'.repeat(40),patch_sha256:require('node:crypto').createHash('sha256').update(patch).digest('hex'),paths:['codex-rs/cli/src/main.rs'],formatter_sha:'f'.repeat(40),required_suites:['feature','full','config','build']};
  if(kind==='frozen'){metadata.base_sha='c'.repeat(40);metadata.accepted_sha='b'.repeat(40);}
  let requests=0;
  const fakeProcess={env:{GITHUB_WORKSPACE:root,GITHUB_SHA:'d'.repeat(40),GH_TOKEN:'synthetic-token',CODEXS_NATIVE_SHA:'b'.repeat(40),CODEXS_UPSTREAM_SHA:'c'.repeat(40),CODEXS_SOURCE_VERSION:'0.166.0',CODEXS_FORMATTER_SHA:'f'.repeat(40),CODEXS_FORMATTER_VERSION:'2.2.32',CODEXS_EVIDENCE_REQUEST:JSON.stringify({runs:[{scope:'build',binary_artifact:1},{scope:'formatter'}],formatter_artifact:2})}};
  const load=name=>{
    if(name==='node:fs/promises')return {readFile:async file=>{if(file===path.join(root,'codexs/upstream/overlay.json'))return JSON.stringify(metadata);if(file===path.join(root,'codexs/upstream/overlay.patch'))return patch;throw Error('Unexpected preflight file read');}};
    if(name===path.join(root,'codexs/release/evidence.cjs'))return {createGithubClient:()=>({}),collectPreBundleEvidence:async()=>({}),downloadDistributionArtifact:async()=>new Map()};
    if(name===path.join(root,'codexs/release/controller.cjs')){
      const actual=require(name);return {...actual,loadCandidateProof:(context,options)=>actual.loadCandidateProof(context,{...options,fetch:async()=>{
        requests++;
        const bytes=Buffer.from(JSON.stringify({sha:'b'.repeat(40),parents:[{sha:(kind==='bad'?'a':'c').repeat(40)}],commit:{message:'codexs-upstream:v1\nupstream_sha='+'c'.repeat(40)+'\noverlay_sha='+'d'.repeat(40)+'\npatch_sha256='+metadata.patch_sha256},files:[{filename:'codex-rs/cli/src/main.rs',status:'modified'}]}));
        return {status:200,headers:new Headers(),body:(async function*(){yield bytes;})()};
      }})};
    }
    return require(name);
  };
  const front=program.slice(0,end).replace('(async()=>','return (async()=>')+"return {token_present:Object.hasOwn(process.env,'GH_TOKEN')};})()";
  const result=await new Function('require','process',front)(load,fakeProcess);
  return {...result,requests};
}

test('task10 candidate: actual bundle preflight rejects an unproven future candidate before native preparation',async()=>{
  await assert.rejects(candidateBundlePreflight('bad'),{code:'CANDIDATE_PROVENANCE'});
});

test('task10 candidate: actual bundle preflight verifies future provenance before removing credentials',async()=>{
  assert.deepEqual(await candidateBundlePreflight('future'),{token_present:false,requests:1});
});

test('task10 candidate: actual bundle preflight retains the accepted frozen candidate path',async()=>{
  assert.deepEqual(await candidateBundlePreflight('frozen'),{token_present:false,requests:0});
});

test('actual Bash workflow bodies remain identical after a Windows CRLF checkout',()=>{
  const crlf=source.replace(/\r?\n/g,'\r\n');
  for(const name of ['Build and test pinned formatter','Record complete acceptance']){
    assert.equal(jobStepBody('formatter_acceptance',name,crlf),jobStepBody('formatter_acceptance',name));
  }
});

test('hosted formatter scripts run frozen canonical checks and produce measured receipts only after success',()=>{
  const build=jobStepBody('formatter_acceptance','Build and test pinned formatter');
  const record=jobStepBody('formatter_acceptance','Record complete acceptance');
  for(const mode of ['good','install','lint','test','build','empty','dirty']){
    const parent=fixtureTempRoot(),directory=fs.mkdtempSync(path.join(parent,'codexs-formatter-job-test-'));
    try {
      const formatter=path.join(directory,'formatter-source'),temp=path.join(directory,'temp');fs.mkdirSync(formatter);fs.mkdirSync(temp);
      fs.writeFileSync(path.join(formatter,'package.json'),JSON.stringify({name:'ccstatusline',version:'2.2.32',type:'module'}));fs.writeFileSync(path.join(formatter,'LICENSE'),'synthetic license');
      for(const name of ['release/evidence.cjs','update/protocol.cjs']){const destination=path.join(directory,'codexs',...name.split('/'));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,'codexs',...name.split('/')),destination);}
      const prelude=`
function git() { if [[ "$*" == *"rev-parse HEAD" ]]; then printf '%s\\n' "$CODEXS_FORMATTER_SHA"; elif [[ "$*" == *"diff --exit-code"* ]]; then [[ "$CODEXS_FORMATTER_CASE" != dirty ]]; else return 97; fi; }
function bun() {
  printf '%s\\n' "$*" >> "$CODEXS_BUN_CALLS"
  case "$*" in
    '--version') printf '1.4.5\\n';;
    'install --frozen-lockfile --ignore-scripts') [[ "$CODEXS_FORMATTER_CASE" != install ]];;
    'run lint') [[ "$CODEXS_FORMATTER_CASE" != lint ]];;
    'test') if [[ "$CODEXS_FORMATTER_CASE" == test ]]; then return 7; fi; if [[ "$CODEXS_FORMATTER_CASE" == empty ]]; then printf ' 0 pass\\n 0 fail\\nRan 0 tests across 1 file. [0.01s]\\n'; else printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [0.01s]\\n'; fi;;
    'run build') if [[ "$CODEXS_FORMATTER_CASE" == build ]]; then return 8; fi; mkdir -p dist; printf 'console.log("synthetic")\\n' > dist/ccstatusline.js;;
    *) return 99;;
  esac
}
`;
      const script=path.join(directory,'gate.sh');fs.writeFileSync(script,prelude+'\n'+build+'\n'+record);
      const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,GITHUB_WORKSPACE:directory.replaceAll('\\','/'),RUNNER_TEMP:temp.replaceAll('\\','/'),GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',CODEXS_NATIVE_SHA:'b'.repeat(40),CODEXS_UPSTREAM_SHA:'a'.repeat(40),CODEXS_FORMATTER_SHA:'d'.repeat(40),CODEXS_FORMATTER_VERSION:'2.2.32',CODEXS_SOURCE_VERSION:'0.166.0',CODEXS_FORMATTER_CASE:mode,CODEXS_BUN_CALLS:path.join(directory,'bun-calls').replaceAll('\\','/')};
      const result=spawnSync(path.join(process.env.ProgramFiles,'Git/bin/bash.exe'),['--noprofile','--norc',script.replaceAll('\\','/')],{cwd:directory,env,windowsHide:true,encoding:'utf8',timeout:15000});
      const receipt=path.join(temp,'codexs-task9-formatter-100-1','acceptance.json');
      if(mode==='good'){
        assert.equal(result.status,0,result.stderr);const data=JSON.parse(fs.readFileSync(receipt,'utf8'));
        assert.deepEqual(data.suites,{formatter:{passed:3,failed:0,ignored:0,exit:0}});assert.equal(data.formatter_sha,'d'.repeat(40));
        const calls=fs.readFileSync(env.CODEXS_BUN_CALLS,'utf8').trim().split(/\r?\n/);assert.ok(calls.includes('install --frozen-lockfile --ignore-scripts'));assert.ok(calls.includes('run lint'));assert.ok(calls.includes('test'));assert.ok(calls.includes('run build'));
      }else{assert.notEqual(result.status,0,'formatter accepted '+mode);assert.equal(fs.existsSync(receipt),false,'failed formatter stage produced acceptance');}
    } finally {
      if(path.dirname(directory)!==parent||!path.basename(directory).startsWith('codexs-formatter-job-test-'))throw Error('Unsafe formatter fixture cleanup');
      fs.rmSync(directory,{recursive:true,maxRetries:10,retryDelay:100});
    }
  }
});

test('actual quick receipt step records raw outcomes and rejects failed empty or missing logs',()=>{
  const body=jobStepBody('quick_checks','Record complete acceptance');
  for(const mode of ['good','failed','empty','missing']){
    const parent=fixtureTempRoot(),directory=fs.mkdtempSync(path.join(parent,'codexs-quick-receipt-test-'));
    try {
      const temp=path.join(directory,'temp'),logs=path.join(temp,'codexs-task9-quick-100-1');fs.mkdirSync(logs,{recursive:true});
      const f=evidenceFixture();f.replaceFiles('quick',files=>{for(const[name,value]of Object.entries(files))if(name!=='acceptance.json')fs.writeFileSync(path.join(logs,name),value);});
      if(mode==='failed')fs.appendFileSync(path.join(logs,'updater.log'),'# fail 1\n');
      if(mode==='empty')fs.writeFileSync(path.join(logs,'quick.log'),'RESULT passed=0 failed=0\n');
      if(mode==='missing')fs.unlinkSync(path.join(logs,'installer.log'));
      for(const name of ['release/evidence.cjs','update/protocol.cjs']){const target=path.join(directory,'codexs',...name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,'codexs',...name.split('/')),target);}
      const script=path.join(directory,'record.ps1');fs.writeFileSync(script,body);
      const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,GITHUB_WORKSPACE:directory,RUNNER_TEMP:temp,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',CODEXS_NATIVE_SHA:'b'.repeat(40),CODEXS_UPSTREAM_SHA:'a'.repeat(40),CODEXS_FORMATTER_SHA:'d'.repeat(40),CODEXS_FORMATTER_VERSION:'2.2.32',CODEXS_SOURCE_VERSION:'0.166.0',CODEXS_TEST_ENTRY:script};
      const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','& ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_TEST_ENTRY)))'],{cwd:directory,env,windowsHide:true,encoding:'utf8',timeout:15000});
      const file=path.join(logs,'acceptance.json');
      if(mode==='good'){assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(receipt.scope,'quick');assert.deepEqual(receipt.suites.updater,{passed:442,failed:0,ignored:0,exit:0});assert.equal(receipt.controller_sha,'c'.repeat(40));}
      else{assert.notEqual(result.status,0,'recorded quick acceptance for '+mode);assert.equal(fs.existsSync(file),false);}
    }finally{if(path.dirname(directory)!==parent||!path.basename(directory).startsWith('codexs-quick-receipt-test-'))throw Error('Unsafe receipt fixture cleanup');fs.rmSync(directory,{recursive:true,maxRetries:10,retryDelay:100});}
  }
});

test('actual quick probes capture outcomes using the original job identity despite synthetic environment changes',()=>{
  const result=execute('Verify workflow behavior without compiling Rust',{}, {CODEXS_TASK9_SCOPE:'formatter'},({result,env})=>{
    assert.equal(result.status,0,result.stderr);
    const file=path.join(env.RUNNER_TEMP,'codexs-task9-quick-101-1','quick.log');
    assert.equal(fs.existsSync(file),true,'quick capture lost the original job RUNNER_TEMP or run identity');
    assert.equal(fs.readFileSync(file,'utf8'),'RESULT passed=77 failed=0\n');
  },'',60000);
  assert.equal(result.error,undefined,'probe regression must finish within its own bounded watchdog');
});

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

for(const phase of ['node','archive','coordinator','enroll'])test('updater diagnostics survive interruption while '+phase+' is still running',{timeout:30000},async()=>{
  const {spawn}=require('node:child_process'),parent=fixtureTempRoot();
  const directory=fs.mkdtempSync(path.join(parent,'codexs-workflow-stream-test-'));
  const gate=path.join(directory,'release'),ready=path.join(directory,'produced'),witness=path.join(directory,'capture-scope-leaked');
  const marker='# synthetic '+phase+' progress',log=path.join(directory,'codexs-task9-quick-100-1/updater.log');
  const names=['release/check-tests','release/evidence','release/package','upstream/upstream','release/workflow','update/protocol','update/paths','update/bootstrap','update/launch','update/http','update/state','update/stage'];
  let child,closed=false,exit,stdout='',stderr='';
  try{
    for(const name of names){const file=path.join(directory,'codexs',name+'.test.cjs');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'// synthetic discovery fixture\n');}
    for(const suite of ['archive','coordinator','enroll'])fs.writeFileSync(path.join(directory,'codexs/update',suite+'.Tests.ps1'),"Wait-SyntheticProgress '"+suite+"'\nWrite-Output '"+({archive:'Archive',coordinator:'Coordinator',enroll:'Enrollment'}[suite])+" assertions: 1 passed; 0 failed'\n");
    const fixture=[
      'function Wait-SyntheticProgress([string]$Phase) {',
      '  Write-Output (\'# synthetic \'+$Phase+\' progress\')',
      '  if($Phase -ceq $env:CODEXS_SYNTHETIC_PHASE){',
      '    [IO.File]::WriteAllText($env:CODEXS_SYNTHETIC_READY,\'produced\')',
      '    $end=[DateTime]::UtcNow.AddSeconds(20)',
      '    while(-not [IO.File]::Exists($env:CODEXS_SYNTHETIC_GATE)){if([DateTime]::UtcNow -gt $end){throw \'SYNTHETIC_PROGRESS_DEADLINE\'};[Threading.Thread]::Sleep(10)}',
      '  }',
      '}',
      'function node {',
      '  if($env:CODEXS_TASK9_SCOPE){[IO.File]::WriteAllText($env:CODEXS_SYNTHETIC_CAPTURE_WITNESS,\'leaked\')}',
      '  Wait-SyntheticProgress \'node\'',
      '  Write-Output \'# tests 1\';Write-Output (\'# codexs verified suites \'+(@($args).Count-1));$global:LASTEXITCODE=0',
      '}',
    ].join('\n');
    const script=path.join(directory,'step.ps1');fs.writeFileSync(script,fixture+'\n'+step('Check isolated update modules').body);
    child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','& ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_SYNTHETIC_SCRIPT)))'],
      {cwd:directory,windowsHide:true,env:{...process.env,CODEXS_TASK9_SCOPE:'formatter',RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',CODEXS_SYNTHETIC_PHASE:phase,CODEXS_SYNTHETIC_GATE:gate,CODEXS_SYNTHETIC_READY:ready,CODEXS_SYNTHETIC_CAPTURE_WITNESS:witness,CODEXS_SYNTHETIC_SCRIPT:script}});
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
    const started=Date.now();while(!fs.existsSync(ready)&&!closed&&Date.now()-started<10000)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(fs.existsSync(ready),true,'synthetic suite must reach its owned barrier: '+stderr);
    let visible=false,saved=false;const deadline=Date.now()+3000;
    do{visible=stdout.includes(marker);saved=fs.existsSync(log)&&fs.readFileSync(log,'utf8').includes(marker);if(visible&&saved)break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
    assert.equal(closed,false,'progress must be observed before the suite exits');
    assert.equal(visible&&saved,true,'in-flight progress must reach console and durable capture: '+JSON.stringify({phase,visible,saved}));
    assert.equal(fs.existsSync(witness),false,'child fixtures must not inherit evidence-capture scope');
    child.kill();const result=await exit;
    assert.ok(result.code!==0||result.signal!==null,'interrupted suite cannot report successful completion');
    assert.equal((fs.readFileSync(log,'utf8').match(new RegExp(marker,'g'))||[]).length,1,'in-flight progress must remain saved after process termination');
    const completion=phase==='node'?'# codexs verified suites':({archive:'Archive',coordinator:'Coordinator',enroll:'Enrollment'}[phase])+' assertions:';
    assert.equal(fs.readFileSync(log,'utf8').includes(completion),false,'partial output must not invent the interrupted suite completion');
  }finally{
    fs.writeFileSync(gate,'release');
    if(child&&!closed){const timer=setTimeout(()=>child.kill(),5000);try{await exit;}finally{clearTimeout(timer);}}
    if(fs.realpathSync.native(directory)!==directory||path.dirname(directory)!==parent||!path.basename(directory).startsWith('codexs-workflow-stream-test-'))throw Error('Unsafe streaming fixture cleanup');
    fs.rmSync(directory,{recursive:true,maxRetries:10,retryDelay:100});
  }
});

// Keep this exact public contract independent of the implementation's allowlist.
const smokeCodes = [
  ...['ARGS', 'IO', 'ENV', 'TIMEOUT', 'OUTPUT', 'CANCELLED', 'RUNNER'].flatMap(primary =>
    ['', '_RUNNER_CLEANUP', '_DIRECTORY_CLEANUP', '_RUNNER_AND_DIRECTORY_CLEANUP'].map(cleanup => `SMOKE_${primary}${cleanup}`)),
  'SMOKE_RUNNER_CLEANUP', 'SMOKE_DIRECTORY_CLEANUP', 'SMOKE_RUNNER_AND_DIRECTORY_CLEANUP', 'SMOKE_UNSUPPORTED', 'SMOKE_RUNTIME',
];

test('quick native probes transport oversized runners through owned files and preserve exits', () => {
  const quick = step('Verify workflow behavior without compiling Rust').body;
  const launches = [...quick.matchAll(/^\s*\$env:CODEXS_PROBE_RUNNER_SCRIPT =[^\n]*\n[\s\S]*?^\s*\$exitCode = \$LASTEXITCODE/gm)].map(match => match[0]);
  assert.equal(launches.length, 3, 'all three quick-probe launch sites must use file transport');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  try {
    const fixture = path.join(directory, 'oversized-runner.ps1');
    fs.writeFileSync(fixture, '# ' + 'x'.repeat(30000) + "\n$LASTEXITCODE=$null\n& powershell.exe -NoProfile -NonInteractive -Command 'exit 7'\nif ($LASTEXITCODE -ne 7) { exit 9 }\n[Console]::Out.WriteLine('synthetic stdout'); exit 7\n");
    for (const [index, launch] of launches.entries()) {
      const id = `transport-${index}`;
      const script = path.join(directory, `${id}.ps1`);
      fs.writeFileSync(script, "$ErrorActionPreference='Stop'\n$probeRoot=$env:CODEXS_TEST_DIR\n" +
        `$id='${id}'\n$runner=[IO.File]::ReadAllText($env:CODEXS_TEST_FIXTURE)\n` + launch +
        "\nif ($exitCode -ne 7) { throw 'Probe exit was not preserved' }\nexit 0\n");
      const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_TEST_SCRIPT)))'],
        { env: { ...process.env, CODEXS_TEST_SCRIPT: script, CODEXS_TEST_DIR: directory, CODEXS_TEST_FIXTURE: fixture }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.ok(fs.statSync(path.join(directory, `${id}.runner.ps1`)).size > 30000);
      const bytes = fs.readFileSync(path.join(directory, `${id}.stderr`));
      const stderr = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
      assert.equal(stderr, '');
    }
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe transport test cleanup');
    fs.rmSync(directory, { recursive: true });
  }
});

test('native jobs require a validated plan and successful quick checks', () => {
  // Model default success prerequisites plus explicit data-only conditions.
  // A failed/skipped quick job must prevent Cargo even when native_required=true.
  const jobs = Object.fromEntries([...source.matchAll(/^  ([a-z_]+):\r?\n([\s\S]*?)(?=^  [a-z_]+:|$(?![\s\S]))/gm)].map(match => {
    const raw = match[2].match(/^    needs: (.+)$/m)?.[1].trim();
    const needs = raw ? (raw.startsWith('[') ? raw.slice(1, -1).split(',').map(value => value.trim()) : [raw]) : [];
    assert.ok(needs.every(value => /^[a-z_]+$/.test(value)), 'unsupported needs syntax');
    const condition=match[2].match(/^    if: (.+)$/m)?.[1].trim();
    return [match[1], {needs,condition}];
  }));
  const runnable=(name,results,outputs={native_required:'true'},inputs={scope:'feature'})=>{
    if(!jobs[name].needs.every(need=>results[need]==='success'))return false;
    if(!jobs[name].condition)return true;
    const condition=jobs[name].condition.replace(/^\$\{\{\s*|\s*\}\}$/g,'');
    const plan=condition.match(/^needs\.plan\.outputs\.([a-z_]+) == '([^']*)'$/);
    if(plan)return outputs[plan[1]]===plan[2];
    const input=condition.match(/^inputs\.([a-z_]+) == '([^']*)'$/);
    assert.ok(input,'unexpected job condition needs explicit evaluation');
    return inputs[input[1]]===input[2];
  };
  assert.deepEqual(jobs.quick_checks.needs, ['plan']);
  assert.deepEqual(jobs.windows.needs, ['plan', 'quick_checks']);
  assert.equal(runnable('windows', { plan: 'success', quick_checks: 'success' }), true);
  assert.equal(runnable('windows',{plan:'success',quick_checks:'success'},{native_required:'false'}),false);
  assert.equal(runnable('formatter_acceptance',{plan:'success'},{},{scope:'formatter'}),true);
  assert.equal(runnable('formatter_acceptance',{plan:'success'},{},{scope:'feature'}),false);
  for (const failure of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(runnable('windows', { plan: 'success', quick_checks: failure }), false);
    assert.equal(runnable('windows', { plan: failure, quick_checks: 'success' }), false);
    assert.equal(runnable('formatter_acceptance',{plan:failure},{},{scope:'formatter'}),false);
  }
});

test('candidate formatting checks every required native file and retains legacy invocations', () => {
  const files = ['tui/src/status_line_command.rs', 'tui/src/status_line_command_tests.rs',
    'tui/src/chatwidget/status_line_command_glue.rs', 'tui/src/chatwidget/status_line_command_integration_tests.rs',
    'tui/src/status_line_command_smoke.rs'];
  const quick = source.split('\n  quick_checks:')[1].split('\n  windows:')[0];
  const checkout = quick.match(/      - name: Checkout candidate for formatting\r?\n(?<body>[\s\S]*?)(?=      - name:)/)?.groups.body;
  assert.ok(checkout, 'selected candidate needs an isolated checkout');
  assert.match(checkout, /if: needs\.plan\.outputs\.candidate_sha != ''/);
  assert.match(checkout, /ref: \$\{\{ needs\.plan\.outputs\.candidate_sha \}\}/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(checkout, /path: candidate-format/);
  const plan = execute('Resolve execution scopes', caller());
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.outputs, new RegExp(`candidate_sha=${'a'.repeat(40)}`));
  for (const missing of [null, ...files, 'wrong-sha', 'legacy']) {
    const prelude = `
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $env:RUNNER_TEMP
$native = Join-Path $env:RUNNER_TEMP '${missing === 'legacy' ? '' : 'candidate-format/'}codex-rs'
foreach ($file in @(${files.filter(file => file !== missing && !(missing === 'legacy' && file.endsWith('_smoke.rs'))).map(file => `'${file}'`).join(',')})) {
  $target=Join-Path $native $file; [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)); [IO.File]::WriteAllText($target,'synthetic')
}
function git { $global:LASTEXITCODE=0; '${missing === 'wrong-sha' ? 'b' : 'a'}' * 40 }
function rustup { [IO.File]::WriteAllText((Join-Path $env:RUNNER_TEMP 'formatter-args.json'),(ConvertTo-Json -InputObject @($args) -Compress)); $global:LASTEXITCODE=0 }
`;
    const result = execute('Check status-line Rust formatting', {}, { FORMAT_CANDIDATE_SHA: missing === 'legacy' ? '' : 'a'.repeat(40) }, ({ env, result }) => {
      const record = path.join(env.RUNNER_TEMP, 'formatter-args.json');
      if (missing !== null && missing !== 'legacy') { assert.notEqual(result.status, 0); assert.equal(fs.existsSync(record), false); return; }
      assert.equal(result.status, 0, result.stderr);
      const args = JSON.parse(fs.readFileSync(record, 'utf8')).map(String);
      assert.deepEqual(args, ['run', '1.95.0', 'rustfmt', '--edition', '2024', '--check', ...files.filter(file => !(missing === 'legacy' && file.endsWith('_smoke.rs')))]);
      if (missing === 'legacy') assert.match(result.stdout, /Legacy formatting: diagnostic source unavailable/);
    }, prelude);
    if (missing === null || missing === 'legacy') assert.equal(result.status, 0, result.stderr);
  }
});

test('built CLI smoke gate rejects bad diagnostics and preserves isolated sentinels', async t => {
  const runner = step('Run guarded native Cargo operation').body.match(/^\$runnerSource = @'\n(?<body>.*?)^'@/ms)?.groups.body;
  const gate = runner?.match(/(?<body>^function Invoke-CodexsSmokeGate \{.*?)(?=^# End codexs smoke gate)/ms)?.groups.body;
  assert.ok(gate, 'missing executable CLI smoke gate');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-workflow-test-'));
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const binary = path.join(directory, 'synthetic-cli.exe');
  const run = (script, extra = {}) => {
    const file = path.join(directory, 'probe.ps1');
    fs.writeFileSync(file, script);
    return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_TEST_SCRIPT)))'],
      { env: { ...process.env, CODEXS_TEST_SCRIPT: file, RUNNER_TEMP: directory, CODEXS_LOG_DIR: directory, CODEXS_TEST_BINARY: binary, ...extra }, windowsHide: true, encoding: 'utf8', timeout: 40000 });
  };
  try {
    const compile = run(String.raw`$ErrorActionPreference='Stop'
Add-Type -OutputType ConsoleApplication -OutputAssembly $env:CODEXS_TEST_BINARY -TypeDefinition @'
using System;
using System.IO;
public class SmokeBoundaryProbe {
  public static int Main(string[] args) {
    string mode = Environment.GetEnvironmentVariable("CODEXS_TEST_SMOKE_MODE");
    File.AppendAllText(Environment.GetEnvironmentVariable("CODEXS_TEST_ARGS"), string.Join("|", args) + "\n");
    if (mode == "timeout") System.Threading.Thread.Sleep(30000);
    if (mode == "code") { Console.Error.WriteLine(Environment.GetEnvironmentVariable("CODEXS_TEST_CODE")); return 17; }
    if (mode == "stderr-cap") { Console.Error.Write(new string('x', 5000)); return 17; }
    if (mode == "stdout-cap") { Console.Write(new string('x', 5000)); return 17; }
    if (mode == "private-success") { Console.Error.WriteLine("PRIVATE_CREDENTIAL C:\\private\\payload"); return 17; }
    if (args.Length == 1) {
      Console.Error.WriteLine("SMOKE_ARGS"); return mode == "missing-zero" ? 0 : 1;
    }
    if (Array.IndexOf(args, "--unknown") >= 0) {
      Console.Error.WriteLine("SMOKE_ARGS"); return mode == "unknown-zero" ? 0 : 1;
    }
    string formatter = args[Array.IndexOf(args, "--formatter") + 1];
    if (Path.GetFileName(formatter).StartsWith("wrong")) {
      if (mode == "malformed-failure") { Console.Error.WriteLine("SMOKE_OUTPUT\n"); return 1; }
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
    for (const mode of ['good', 'fast-exit', 'extra', 'malformed', 'wrong-json', 'nonzero', 'missing-zero', 'unknown-zero', 'failure-zero', 'private-error', 'malformed-failure', 'sentinel-write', 'private-success', 'stdout-cap', 'stderr-cap', 'timeout', 'cleanup-failure', 'cleanup-and-primary', 'start-failure', 'log-failure']) {
      await t.test(mode, () => {
        const record = path.join(directory, `${mode}.args`);
        const log = path.join(directory, 'smoke-failures.jsonl');
        fs.rmSync(log, { force: true });
        const cleanup = mode === 'fast-exit' ? `
function Start-Process {
  $p=Microsoft.PowerShell.Management\\Start-Process @args
  Start-Sleep -Milliseconds 250
  return $p
}
function New-Object {
  $p=Microsoft.PowerShell.Utility\\New-Object @args
  if ($args[0] -ceq 'System.Diagnostics.Process') {
    $p | Add-Member ScriptMethod Start { $ok=$this.PSBase.Start(); Start-Sleep -Milliseconds 250; return $ok } -Force
  }
  return $p
}
` : mode.startsWith('cleanup-') ? `
function New-Object {
  $p=Microsoft.PowerShell.Utility\\New-Object @args
  if ($args[0] -ceq 'System.Diagnostics.Process') {
    $p | Add-Member ScriptMethod Dispose { $this.PSBase.Dispose(); throw 'PRIVATE_CLEANUP' } -Force
  }
  return $p
}
` : mode === 'start-failure' ? `
function New-Object {
  $p=Microsoft.PowerShell.Utility\\New-Object @args
  if ($args[0] -ceq 'System.Diagnostics.Process') {
    $p | Add-Member ScriptMethod Start { throw 'PRIVATE_CREDENTIAL C:\\private\\payload' } -Force
  }
  return $p
}
` : '';
        const result = run("$ErrorActionPreference='Stop'\n" + cleanup + gate + '\nInvoke-CodexsSmokeGate $env:CODEXS_TEST_BINARY',
          { CODEXS_TEST_SMOKE_MODE: ['log-failure', 'cleanup-and-primary'].includes(mode) ? 'nonzero' : mode, CODEXS_TEST_ARGS: record,
            ...(mode === 'log-failure' ? { CODEXS_LOG_DIR: path.join(directory, 'absent-log-directory') } : {}) });
        if (mode === 'good' || mode === 'fast-exit') {
          const diagnostic = fs.readdirSync(directory).filter(name => name.startsWith('codexs-smoke-gate-')).flatMap(name =>
            fs.readdirSync(path.join(directory, name)).filter(file => /\.(out|err)$/.test(file)).map(file =>
              [file, fs.readFileSync(path.join(directory, name, file), 'utf8')]));
          const failureRecord = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
          assert.equal(result.status, 0, result.stderr + JSON.stringify(diagnostic) + failureRecord);
          const args = fs.readFileSync(record, 'utf8').trim().split('\n');
          assert.equal(args.length, 4);
          assert.ok(args[0].startsWith('codexs-smoke|--node|'));
          assert.ok(args[0].includes('|--formatter|'));
          assert.equal(args[1], 'codexs-smoke');
          assert.ok(args[2].endsWith('|--unknown'));
          assert.equal(fs.existsSync(log), false);
        } else {
          assert.notEqual(result.status, 0, `gate accepted ${mode}`);
          assert.equal(result.error, undefined, 'outer test watchdog must not terminate the gate');
          assert.ok(!result.stderr.includes('PRIVATE_CREDENTIAL') && !result.stderr.includes('PRIVATE_CLEANUP'));
          if (mode === 'log-failure') { assert.match(result.stderr, /SMOKE_DIAGNOSTIC_INVALID/); return; }
          const rows = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
          assert.equal(rows.length, 1);
          const row = rows[0];
          assert.deepEqual(Object.keys(row).sort(), ['case', 'elapsed_ms', 'error_code', 'exit_code', 'stderr_bytes', 'stdout_bytes']);
          assert.ok(['success', 'missing', 'unknown', 'wrong'].includes(row.case));
          assert.equal(row.case, ['missing-zero'].includes(mode) ? 'missing' : mode === 'unknown-zero' ? 'unknown' : ['failure-zero', 'private-error', 'malformed-failure'].includes(mode) ? 'wrong' : 'success');
          assert.equal(row.error_code, ['missing-zero', 'unknown-zero'].includes(mode) ? 'SMOKE_ARGS' : mode === 'failure-zero' ? 'SMOKE_OUTPUT' : 'UNKNOWN');
          assert.ok(row.elapsed_ms >= 0 && row.stdout_bytes >= 0 && row.stderr_bytes >= 0);
          if (mode === 'nonzero') {
            assert.equal(row.exit_code, 9);
            assert.equal(row.stdout_bytes, Buffer.byteLength('{"schema":1,"runner":"ok","formatter":"ok","cleanup":"ok"}\r\n'));
            assert.equal(row.stderr_bytes, 0);
          }
          if (mode === 'stdout-cap') { assert.equal(row.stdout_bytes, 5000); assert.equal(row.stderr_bytes, 0); }
          if (mode === 'stderr-cap') { assert.equal(row.stdout_bytes, 0); assert.equal(row.stderr_bytes, 5000); }
          if (mode === 'cleanup-and-primary') { assert.equal(row.exit_code, 9); assert.match(result.stderr, /SMOKE_DIAGNOSTIC_INVALID/); }
          if (mode === 'cleanup-failure') assert.match(result.stderr, /SMOKE_PROCESS_CLEANUP/);
          if (mode === 'start-failure') { assert.equal(row.exit_code, 'unavailable'); assert.match(result.stderr, /SMOKE_PROCESS_FAILURE/); }
          if (mode === 'timeout') { assert.ok(row.elapsed_ms >= 25000 && row.elapsed_ms < 35000); assert.equal(fs.readFileSync(record, 'utf8').trim().split('\n').length, 1); }
          assert.ok(!fs.readFileSync(log, 'utf8').includes(directory));
        }
      });
    }
    for (const code of [...smokeCodes, 'SMOKE_CLEANUP', 'SMOKE_OUTPUT_PRIVATE', 'Error: SMOKE_ENV', 'SMOKE_ENV\nPRIVATE_CREDENTIAL', ' SMOKE_ENV', 'SMOKE_ENV\n\n']) {
      await t.test(`allowlist ${JSON.stringify(code)}`, () => {
        const log = path.join(directory, 'smoke-failures.jsonl'); fs.rmSync(log, { force: true });
        const result = run("$ErrorActionPreference='Stop'\n" + gate + '\nInvoke-CodexsSmokeGate $env:CODEXS_TEST_BINARY',
          { CODEXS_TEST_SMOKE_MODE: 'code', CODEXS_TEST_CODE: code, CODEXS_TEST_ARGS: path.join(directory, 'codes.args') });
        assert.notEqual(result.status, 0);
        const row = JSON.parse(fs.readFileSync(log, 'utf8').trim());
        assert.equal(row.exit_code, 17);
        assert.equal(row.case, 'success');
        assert.equal(row.stdout_bytes, 0);
        assert.equal(row.stderr_bytes, Buffer.byteLength(code + '\r\n'));
        assert.equal(row.error_code, smokeCodes.includes(code) ? code : code === 'Error: SMOKE_ENV' ? 'SMOKE_ENV' : 'UNKNOWN');
      });
    }
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codexs-workflow-test-')) throw Error('Unsafe smoke test cleanup');
    fs.rmSync(directory, { recursive: true });
  }
});

test('actual quick gates discover launcher suites and propagate every PowerShell suite failure',()=>{
  const tempRoot=fixtureTempRoot();
  const directory=fs.mkdtempSync(path.join(tempRoot,'codexs-workflow-test-'));
  const names=['release/check-tests','release/evidence','release/package','upstream/upstream','release/workflow','update/protocol','update/paths','update/bootstrap','update/launch','update/http','update/state','update/stage'];
  try{
    for(const name of names){const file=path.join(directory,'codexs',name+'.test.cjs');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'// synthetic discovery fixture\n');}
    for(const suite of ['archive','coordinator','enroll']){
      fs.writeFileSync(path.join(directory,'codexs/update',suite+'.Tests.ps1'),"if($env:CODEXS_SYNTHETIC_FAIL -ceq '"+suite+"'){throw 'SYNTHETIC_SUITE_FAILURE'};if($env:CODEXS_SYNTHETIC_FAIL -cne 'empty-"+suite+"'){Write-Output ('"+({archive:'Archive',coordinator:'Coordinator',enroll:'Enrollment'}[suite])+" assertions: 1 passed; 0 failed')}\n");
    }
    fs.writeFileSync(path.join(directory,'codexs/install.Tests.ps1'),"param($InstallerPath)\nif($env:CODEXS_SYNTHETIC_FAIL -ceq 'legacy'){throw 'SYNTHETIC_SUITE_FAILURE'};if($env:CODEXS_SYNTHETIC_FAIL -cne 'empty-legacy'){Write-Output ('Installer assertions: 1 passed; 0 failed')}\n");
    const log=path.join(directory,'node-args');
    const node="function node { if($env:CODEXS_TASK9_SCOPE){[IO.File]::WriteAllText($env:CODEXS_SYNTHETIC_CAPTURE_WITNESS,'leaked capture scope')};[IO.File]::WriteAllText($env:CODEXS_SYNTHETIC_NODE_ARGS,($args -join [Environment]::NewLine));Write-Output '# tests 1';Write-Output ('# codexs verified suites '+(@($args).Count-1));$global:LASTEXITCODE=0 }\n";
    const body=node+step('Check isolated codexs installer').body+'\n'+step('Check isolated update modules').body;
    for(const failure of ['none','archive','coordinator','enroll','legacy','empty-archive','empty-coordinator','empty-enroll','empty-legacy','missing-launch','missing-http','missing-state','missing-stage','missing-release-evidence','missing-release-package']){
      const removed=failure.startsWith('missing-release-')?path.join(directory,'codexs/release',failure.slice(16)+'.test.cjs'):failure.startsWith('missing-')?path.join(directory,'codexs/update',failure.slice(8)+'.test.cjs'):null;
      if(removed)fs.unlinkSync(removed);
      const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],
        {cwd:directory,env:{...process.env,CODEXS_TASK9_SCOPE:'formatter',RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',CODEXS_SYNTHETIC_CAPTURE_WITNESS:path.join(directory,'capture-leaked'),CODEXS_SYNTHETIC_FAIL:failure,CODEXS_SYNTHETIC_NODE_ARGS:log},windowsHide:true,encoding:'utf8',timeout:10000});
      if(failure==='none'){
        assert.equal(result.status,0,result.stderr);
        assert.equal(fs.existsSync(path.join(directory,'capture-leaked')),false,'controller evidence capture must not be inherited by child fixtures');
        for(const suite of ['archive','coordinator','enroll','legacy'])assert.ok(result.stdout.includes(({archive:'Archive',coordinator:'Coordinator',enroll:'Enrollment',legacy:'Installer'}[suite])+' assertions: 1 passed; 0 failed'),'missing execution: '+suite);
        const args=fs.readFileSync(log,'utf8').split(/\r?\n/);
        for(const name of names)assert.ok(args.includes(path.join(directory,'codexs',name+'.test.cjs')),'not discovered: '+name);
      }else assert.notEqual(result.status,0,'gate must reject '+failure);
      if(removed)fs.writeFileSync(removed,'// synthetic discovery fixture\n');
    }
  }finally{
    if(path.dirname(directory)!==tempRoot||!path.basename(directory).startsWith('codexs-workflow-test-'))throw Error('Unsafe gate-fixture cleanup');
    fs.rmSync(directory,{recursive:true});
  }
});
