'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { footerOverlay,upstreamPackages,evidenceFixture } = require('../test-support/update-fixtures.cjs');
const { createHash } = require('node:crypto');
const { collectPreBundleEvidence } = require('./evidence.cjs');

function api() { return require('./controller.cjs'); }

function acceptanceFixture() {
  const f=evidenceFixture(),events=[],dispatches=[],ids={feature:110,cleanup:120,formatter:150,bundle:160,evidence:170};let elapsed=0;
  const input={controllerSha:'c'.repeat(40),candidateSha:f.input.candidate.sha,upstreamSha:f.input.candidate.upstream_sha,sourceVersion:f.input.candidate.version,formatterSha:f.input.formatter.sha,formatterVersion:f.input.formatter.version,productVersion:'1.0.0',mode:'routine',parentRunId:900,parentAttempt:1,nativeReuse:null};
  function relabel(scope,run,label){const ref=f.input.runs.find(item=>item.scope===scope),oldRun=ref.run,oldLabel=ref.validation_id;ref.run=run;ref.validation_id=label;f.jobs.get(ref.job).run_id=run;
    for(const artifact of f.artifacts.values())if(artifact.workflow_run.id===oldRun&&artifact.name.includes('-'+oldLabel+'-')){artifact.name=artifact.name.replace('-'+oldLabel+'-'+oldRun+'-','-'+label+'-'+run+'-');artifact.workflow_run.id=run;}
    f.replaceFiles(scope,()=>{});
  }
  const ports={
    now:()=>elapsed,sleep:async ms=>{events.push('sleep');elapsed+=ms;},
    async dispatch({scope,inputs}){
      events.push('dispatch:'+scope);dispatches.push({scope,inputs:structuredClone(inputs)});const run=ids[scope],meta=f.runs.get(run)||f.runs.get(110);
      f.runs.set(run,{...meta,id:run,status:'queued',conclusion:null});
      const groups={feature:['quick','feature'],cleanup:['full','config','build'],formatter:input.nativeReuse?['quick','formatter']:['formatter'],bundle:['bundle'],evidence:[]};
      for(const selected of groups[scope])relabel(selected,run,inputs.validation_id);
      if(scope==='bundle'){
        const request=JSON.parse(inputs.evidence_request);f.sealBundleInputs(await collectPreBundleEvidence({candidate:{sha:input.candidateSha,upstream_sha:input.upstreamSha,version:input.sourceVersion},formatter:f.input.formatter,runs:request.runs},f.github));
        f.addDistributionArtifact('bundle',{'codexs-windows-x64.zip':'synthetic','manifest-base.json':'{}','codexs-enrollment.zip':'synthetic','enrollment.json':'{}'});
      }
      if(scope==='evidence'){
        f.jobs.set(171,{id:171,run_id:run,run_attempt:1,head_sha:input.controllerSha,status:'completed',conclusion:'success',name:'Complete release evidence',steps:[{name:'Collect completed exact-archive evidence',status:'completed',conclusion:'success'}]});
        f.artifacts.set(172,{id:172,name:'codexs-task9-evidence-'+inputs.validation_id+'-'+run+'-1',expired:false,size_in_bytes:12,digest:'sha256:'+'1'.repeat(64),workflow_run:{id:run,head_sha:input.controllerSha}});
      }
      return {runId:run};
    },
    async getRun(id){events.push('get:'+id);const run=structuredClone(f.runs.get(id));if(elapsed>0){run.status='completed';run.conclusion='success';}return run;},
    async getJobs(id){return [...f.jobs.values()].filter(job=>job.run_id===id).map(job=>structuredClone(job));},
    async getArtifacts(id){return [...f.artifacts.values()].filter(artifact=>artifact.workflow_run.id===id).map(artifact=>structuredClone(artifact));},
    preBundle:request=>collectPreBundleEvidence(request,f.github),
  };
  // The public collector sees only completed runs; simulated completion follows one clock tick.
  const get=f.github.getRun;f.github.getRun=async(repository,id)=>{const run=await get(repository,id);if(elapsed>0){run.status='completed';run.conclusion='success';}return run;};
  return {f,input,ports,events,dispatches};
}

test('task10 orchestration: starts independent runs together then gates bundle and completed final evidence',async()=>{
  const f=acceptanceFixture(),result=await api().runAcceptance(f.input,f.ports);
  assert.deepEqual(f.events.slice(0,3),['dispatch:feature','dispatch:cleanup','dispatch:formatter']);
  assert.deepEqual(f.dispatches.map(item=>item.scope),['feature','cleanup','formatter','bundle','evidence']);
  assert.equal(result.request.runs.length,7);assert.equal(result.final.run,170);assert.equal(result.final.controller_sha,f.input.controllerSha);assert.equal(result.final.artifact,172);
  for(const call of f.dispatches){const suffix={feature:'f',cleanup:'c',formatter:'m',bundle:'b',evidence:'e'}[call.scope];assert.equal(call.inputs.validation_id,'r'+createHash('sha256').update('900/1/'+call.scope).digest('hex').slice(0,24)+'-'+suffix);}
  assert.equal(f.events.indexOf('dispatch:bundle')>f.events.indexOf('sleep'),true);
});

for(const [name,mutate]of [
  ['wrong head',run=>{run.head_sha='e'.repeat(40);}],['wrong attempt',run=>{run.run_attempt=2;}],['wrong event',run=>{run.event='push';}],['wrong repository',run=>{run.repository.full_name='other/repo';}],['wrong workflow',run=>{run.path='.github/workflows/other.yml';}],
  ['cancelled',run=>{run.status='completed';run.conclusion='cancelled';}],['failed',run=>{run.status='completed';run.conclusion='failure';}],
])test('task10 orchestration: rejects '+name+' without downstream bundle or evidence',async()=>{
  const f=acceptanceFixture(),get=f.ports.getRun;f.ports.getRun=async id=>{const run=await get(id);mutate(run);return run;};
  await assert.rejects(api().runAcceptance(f.input,f.ports),{code:'ACCEPTANCE_IDENTITY'});assert.equal(f.dispatches.some(call=>['bundle','evidence'].includes(call.scope)),false);
});

for(const name of ['renamed job','duplicate job','expired artifact','missing artifact','zero-discovery','guard stopped'])test('task10 orchestration: rejects '+name+' before bundle',async()=>{
  const f=acceptanceFixture(),jobs=f.ports.getJobs,artifacts=f.ports.getArtifacts;
  if(name==='renamed job')f.ports.getJobs=async id=>(await jobs(id)).map(job=>({...job,name:'unrecognized'}));
  if(name==='duplicate job')f.ports.getJobs=async id=>{const values=await jobs(id);return [...values,...values];};
  if(name==='expired artifact')f.ports.getArtifacts=async id=>(await artifacts(id)).map(item=>({...item,expired:true}));
  if(name==='missing artifact')f.ports.getArtifacts=async()=>[];
  if(name==='zero-discovery'||name==='guard stopped'){const dispatch=f.ports.dispatch;f.ports.dispatch=async request=>{const result=await dispatch(request);if(request.scope==='feature')f.f.replaceFiles('feature',files=>{if(name==='zero-discovery')files['cargo.log']=files['cargo.log'].replace('150 passed','0 passed');else files['outcome.txt']=files['outcome.txt'].replace('guard_stop=none','guard_stop=memory');});return result;};}
  await assert.rejects(api().runAcceptance(f.input,f.ports),error=>error.name==='UpdateError');assert.equal(f.dispatches.some(call=>call.scope==='bundle'),false);
});

test('task10 orchestration: queued children exhaust one total budget without real waiting',async()=>{
  const f=acceptanceFixture(),get=f.ports.getRun;f.ports.getRun=async id=>({...await get(id),status:'queued',conclusion:null});
  await assert.rejects(api().runAcceptance(f.input,f.ports),{code:'ACCEPTANCE_TIMEOUT'});assert.equal(f.dispatches.length,3);assert.equal(f.ports.now(),240*60*1000);
});

test('task10 orchestration: an invalid initial monotonic clock fails before dispatch',async()=>{
  const f=acceptanceFixture();let calls=0;f.ports.now=()=>calls++===0?NaN:0;f.ports.sleep=async()=>{throw Error('synthetic invalid-clock stop');};
  await assert.rejects(api().runAcceptance(f.input,f.ports),{code:'ACCEPTANCE_IDENTITY'});assert.equal(f.dispatches.length,0);
});

test('task10 orchestration: explicit approved native reuse runs fresh quick formatter bundle and evidence only',async()=>{
  const f=acceptanceFixture();f.input.mode='initial';
  const approved=[{scope:'feature',run:44904997566,job:136850076882,artifact:14710796318,controller_sha:'4afa8342f5457d130c1d528abf0882eb67234d28',validation_id:'task8g-alias'},...[
    ['full',136172829353,14623551679],['config',136172829371,14614442421],['build',136172829406,14622732074],
  ].map(([scope,job,artifact])=>({scope,run:44701739542,job,artifact,controller_sha:'247935fa164114a89829ba8b228ab12dedc5110a',validation_id:'task7-autoload-cleanup-20261120',...(scope==='build'?{binary_artifact:14623201225}:{})}))];
  for(const patch of approved){
    const ref=f.f.input.runs.find(ref=>ref.scope===patch.scope),old={...ref},oldRun=f.f.runs.get(old.run),oldJob=f.f.jobs.get(old.job);Object.assign(ref,patch);
    f.f.runs.set(ref.run,{...oldRun,id:ref.run,head_sha:ref.controller_sha});f.f.jobs.set(ref.job,{...oldJob,id:ref.job,run_id:ref.run,head_sha:ref.controller_sha});
    for(const [oldId,newId]of [[old.artifact,ref.artifact],...(ref.scope==='build'?[[old.binary_artifact,ref.binary_artifact]]:[])]){
      const item=structuredClone(f.f.artifacts.get(oldId));item.id=newId;item.name=item.name.replace('-'+old.validation_id+'-'+old.run+'-','-'+ref.validation_id+'-'+ref.run+'-');item.workflow_run={id:ref.run,head_sha:ref.controller_sha};f.f.artifacts.set(newId,item);f.f.bytes.set(newId,f.f.bytes.get(oldId));
    }
    f.f.replaceFiles(ref.scope,()=>{});
  }
  f.input.nativeReuse=structuredClone(f.f.input.runs.filter(ref=>['feature','full','config','build'].includes(ref.scope)));
  const result=await api().runAcceptance(f.input,f.ports);assert.deepEqual(f.dispatches.map(call=>call.scope),['formatter','bundle','evidence']);assert.equal(result.request.runs.length,7);
});

test('task10 orchestration: routine reuse and malformed or duplicate locators fail closed',async()=>{
  for(const mode of ['routine','validate']){const f=acceptanceFixture();f.input.mode=mode;f.input.nativeReuse=[{scope:'feature'},{scope:'feature'},{scope:'config'},{scope:'build'}];await assert.rejects(api().runAcceptance(f.input,f.ports),{code:'ACCEPTANCE_IDENTITY'});assert.equal(f.dispatches.length,0);}
});

test('task10 orchestration: an unapproved complete native reuse request cannot reach bundle',async()=>{
  const f=acceptanceFixture();f.input.mode='initial';f.input.nativeReuse=structuredClone(f.f.input.runs.filter(ref=>['feature','full','config','build'].includes(ref.scope)));for(const ref of f.input.nativeReuse)ref.controller_sha='e'.repeat(40);
  const dispatch=f.ports.dispatch;f.ports.dispatch=async request=>{const result=await dispatch(request);if(request.scope==='formatter'){
    const quick=f.f.input.runs.find(ref=>ref.scope==='quick'),format=f.f.input.runs.find(ref=>ref.scope==='formatter'),old=quick.run;quick.run=format.run;quick.validation_id=format.validation_id;f.f.jobs.get(quick.job).run_id=format.run;
    const artifact=f.f.artifacts.get(quick.artifact);artifact.name=artifact.name.replace('-fixture-'+old+'-','-'+quick.validation_id+'-'+quick.run+'-');artifact.workflow_run.id=quick.run;f.f.replaceFiles('quick',()=>{});
  }return result;};
  await assert.rejects(api().runAcceptance(f.input,f.ports),{code:'EVIDENCE_TRUST'});assert.equal(f.dispatches.length,1);
});

test('task10 orchestration: failed completed bundle never dispatches final evidence',async()=>{
  const f=acceptanceFixture(),get=f.ports.getRun;f.ports.getRun=async id=>{const run=await get(id);if(id===160){run.status='completed';run.conclusion='failure';}return run;};
  await assert.rejects(api().runAcceptance(f.input,f.ports),{code:'ACCEPTANCE_IDENTITY'});assert.equal(f.dispatches.some(call=>call.scope==='evidence'),false);
});

function controllerHTTPFixture(change=()=>{}) {
  const requests=[];let main='c'.repeat(40);
  const fetch=async(url,options)=>{requests.push({url,options});const response=()=>new Response(JSON.stringify({object:{sha:main}}));
    if(url.includes('/git/ref/heads/main'))return response();return change({url,options,setMain:sha=>{main=sha;}})||new Response(JSON.stringify({workflow_run_id:800,run_url:'https://api.github.com/repos/TK-06/codexs/actions/runs/800',html_url:'https://github.com/TK-06/codexs/actions/runs/800'}));};
  return {requests,options:{token:'synthetic-token',controllerSha:'c'.repeat(40),fetch},input:{scope:'feature',inputs:{candidate_sha:'b'.repeat(40),baseline_sha:'a'.repeat(40),validation_id:'synthetic',formatter_sha:'d'.repeat(40),formatter_version:'2.2.32',source_version:'0.166.0',product_version:'1.0.0'}}};
}

test('task10 orchestration: production dispatch is inert until called and binds the returned HTTP-200 ID',async()=>{
  const f=controllerHTTPFixture(),ports=api().createControllerPorts(f.options);assert.equal(f.requests.length,0);assert.deepEqual(await ports.dispatch(f.input),{runId:800});
  assert.equal(f.requests.length,3);const request=f.requests[1];assert.equal(request.url,'https://api.github.com/repos/TK-06/codexs/actions/workflows/codexs-statusline.yml/dispatches');assert.equal(request.options.headers['X-GitHub-Api-Version'],'2026-03-10');assert.equal(JSON.parse(request.options.body).ref,'main');assert.equal(request.options.method,'POST');
});

test('task10 orchestration: missing dispatch identity is rejected before any HTTP request',async()=>{
  const f=controllerHTTPFixture();delete f.input.inputs.candidate_sha;
  await assert.rejects(api().createControllerPorts(f.options).dispatch(f.input),{code:'CONTROLLER_POLICY'});assert.equal(f.requests.length,0);
});

test('task10 orchestration: production job pagination returns the complete exact attempt',async()=>{
  const f=controllerHTTPFixture(({url})=>new Response(JSON.stringify({total_count:2,jobs:[{id:url.includes('page=2')?2:1}]}))),ports=api().createControllerPorts(f.options);
  assert.deepEqual(await ports.getJobs(800),[{id:1},{id:2}]);assert.equal(f.requests.length,2);assert.equal(f.requests.every(item=>item.url.includes('/runs/800/attempts/1/jobs?per_page=100&page=')),true);
});

for(const name of ['204','missing ID','unsafe ID','timeout','main moved'])test('task10 orchestration: dispatch '+name+' cannot guess or retry a run',async()=>{
  const f=controllerHTTPFixture(({setMain})=>{if(name==='204')return new Response(null,{status:204});if(name==='missing ID')return new Response('{}');if(name==='unsafe ID')return new Response('{"workflow_run_id":9007199254740992}');if(name==='timeout')throw Error('synthetic private timeout');setMain('e'.repeat(40));return new Response('{"workflow_run_id":800}');});
  await assert.rejects(api().createControllerPorts(f.options).dispatch(f.input),{code:name==='main moved'?'CONTROLLER_CHANGED':'DISPATCH_UNCERTAIN'});assert.equal(f.requests.filter(item=>item.options.method==='POST').length,1);
});

function policyContext(release=false) {
  return {repository:'TK-06/codexs',eventName:'workflow_dispatch',ref:'refs/heads/main',workflowRef:'TK-06/codexs/.github/workflows/codexs-'+(release?'release':'upstream')+'.yml@refs/heads/main',mode:'routine',updatesEnabled:'true',releasesEnabled:'false',controllerSha:'b'.repeat(40)};
}

test('task10 controller: main manual validation, manual initial and enabled routine have separate capabilities',()=>{
  const upstream=policyContext(),release=policyContext(true);
  assert.deepEqual(api().authorizeRun(upstream),{prepare:true,validate:true,publish:false});
  assert.deepEqual(api().authorizeRun({...release,mode:'validate'}),{prepare:false,validate:true,publish:false});
  assert.deepEqual(api().authorizeRun({...release,mode:'initial'}),{prepare:false,validate:true,publish:true});
  assert.equal(api().authorizeRun({...release,eventName:'workflow_call',mode:'initial'}).publish,false);
  assert.equal(api().authorizeRun({...release,eventName:'workflow_call',releasesEnabled:'true'}).publish,true);
  assert.equal(api().authorizeRun({...upstream,mode:'initial',releasesEnabled:'true'}).publish,false);
});

for(const [name,changes]of [
  ['unset updates',{updatesEnabled:''}],['false updates',{updatesEnabled:'false'}],['case-varied updates',{updatesEnabled:'True'}],
  ['non-main',{ref:'refs/heads/topic'}],['foreign repository',{repository:'other/codexs'}],['foreign workflow',{workflowRef:'TK-06/codexs/.github/workflows/other.yml@refs/heads/main'}],
  ['pull request',{eventName:'pull_request'}],['workflow-ref drift',{workflowRef:'TK-06/codexs/.github/workflows/codexs-upstream.yml@refs/heads/topic'}],
])test('task10 controller: disabled or untrusted '+name+' cannot prepare',()=>{
  assert.deepEqual(api().authorizeRun({...policyContext(),...changes}),{prepare:false,validate:false,publish:false});
});

for(const flag of ['', 'false','True','TRUE'])test('task10 controller: routine publication rejects release flag '+JSON.stringify(flag),()=>{
  assert.equal(api().authorizeRun({...policyContext(true),releasesEnabled:flag}).publish,false);
});

for(const change of [context=>{context.mode='anything';},context=>{delete context.ref;},context=>{context.controllerSha='main';},context=>{context.secret='synthetic';}])test('task10 controller: malformed context fails closed',()=>{
  const context=policyContext();change(context);assert.throws(()=>api().authorizeRun(context),{code:'CONTROLLER_POLICY'});
});

function preparationFixture({existing=false,conflict=false,wrongExisting=false}={}) {
  const overlay=footerOverlay(),workspace=path.join(os.tmpdir(),'codexs-candidate-controller-synthetic'),calls=[],writes=[],packages=upstreamPackages();
  const context=policyContext(),branch='automation/upstream/0.166.0-'+context.controllerSha.slice(0,12),candidateSha='f'.repeat(40);
  const message='codexs-upstream:v1\nupstream_sha='+'a'.repeat(40)+'\noverlay_sha='+context.controllerSha+'\npatch_sha256='+overlay.patch_sha256;
  const ports={
    async listUpstreamReleases(){return {releases:[{tag_name:'rust-v0.166.0',draft:false,prerelease:false}],hasNext:false};},
    async resolveTag(){return 'a'.repeat(40);},async getPackage(version){return version.endsWith('-win32-x64')?packages.helper:packages.main;},
    async readFormatterManifest(sha){assert.equal(sha,overlay.formatter_sha);return {version:'2.2.32'};},
    async getJson(url){calls.push(url);if(url.includes('/git/ref/heads/'))return existing?{object:{sha:candidateSha}}:null;
      if(url.includes('/git/commits/'))return {message:wrongExisting?'unrelated':message};
      return {sha:candidateSha,parents:[{sha:'a'.repeat(40)}],commit:{message},files:[{filename:wrongExisting?'outside.rs':overlay.paths[1],status:'modified'}]};},
    async git(args,cwd){calls.push(args);assert.equal(cwd,workspace);if(args[0]==='apply'&&conflict)throw Error('synthetic private failure');if(args[0]==='diff')return overlay.paths.join('\n');if(args[0]==='rev-parse')return candidateSha;return '';},
    async readFile(file){if(file.endsWith('.codexs-owned-workspace'))return 'codexs-candidate-workspace-v1\n';if(file.endsWith('Cargo.lock'))return 'version = 4\n\n[[package]]\nname = "codex-tui"\nversion = "0.0.0"\n';if(file.includes(path.join('tui','Cargo.toml')))return '[package]\nname = "codex-tui"\nversion.workspace = true\n';return '[workspace]\nmembers = ["tui"]\n\n[workspace.package]\nversion = "0.166.0"\n';},
    async writeFile(){},async publishCandidate(request){writes.push(request);},
  };
  return {input:{context,overlay,formatter:{sha:overlay.formatter_sha,version:'2.2.32'},workspace},ports,calls,writes,branch,candidateSha};
}

test('task10 controller: prepares a pinned candidate and requests only its dedicated non-force ref',async()=>{
  const f=preparationFixture(),before=structuredClone(f.input);before.overlay.patch_bytes=Buffer.from(before.overlay.patch_bytes);const result=await api().prepareUpdate(f.input,f.ports);
  assert.equal(result.branch,f.branch);assert.equal(result.candidate.candidate_sha,f.candidateSha);assert.equal(result.upstream.version,'0.166.0');assert.deepEqual(result.formatter,f.input.formatter);
  assert.deepEqual(f.writes,[{workspace:f.input.workspace,branch:f.branch,candidateSha:f.candidateSha}]);assert.deepEqual(f.input,before);
});

test('task10 controller: exact existing candidate is verified and reused without a writer call',async()=>{
  const f=preparationFixture({existing:true}),result=await api().prepareUpdate(f.input,f.ports);
  assert.equal(result.candidate.candidate_sha,f.candidateSha);assert.equal(f.writes.length,0);assert.equal(f.calls.some(call=>Array.isArray(call)),false);
});

test('task10 controller: matching remote message cannot conceal a wrong parent or changed file',async()=>{
  for(const bad of ['parent','file']){
    const f=preparationFixture({existing:true}),get=f.ports.getJson;f.ports.getJson=async url=>{const raw=await get(url);if(url.includes('/codexs/commits/')){if(bad==='parent')raw.parents[0].sha='e'.repeat(40);else raw.files[0].filename='outside.rs';}return raw;};
    await assert.rejects(api().prepareUpdate(f.input,f.ports),{code:'CANDIDATE_PROVENANCE'});assert.equal(f.writes.length,0);
  }
});

for(const [name,create,change,code]of [
  ['overlay conflict',{conflict:true},()=>{},'OVERLAY_CONFLICT'],['conflicting remote ref',{existing:true,wrongExisting:true},()=>{},'CANDIDATE_IDENTITY'],
  ['wrong controller',{},f=>{f.input.overlay.revision='c'.repeat(40);},'OVERLAY_IDENTITY'],
  ['wrong formatter source',{},f=>{f.input.formatter.sha='a'.repeat(40);},'CONTROLLER_POLICY'],
  ['wrong formatter version',{},f=>{f.input.formatter.version='2.2.33';},'CONTROLLER_POLICY'],
])test('task10 controller: rejects '+name+' before candidate publication',async()=>{
  const f=preparationFixture(create);change(f);await assert.rejects(api().prepareUpdate(f.input,f.ports),{code});assert.equal(f.writes.length,0);
});

for(const name of ['disabled','no stable','registry race'])test('task10 controller: '+name+' defers without Git or publication',async()=>{
  const f=preparationFixture();if(name==='disabled')f.input.context.updatesEnabled='false';if(name==='no stable')f.ports.listUpstreamReleases=async()=>({releases:[],hasNext:false});if(name==='registry race')f.ports.getPackage=async()=>null;
  assert.equal(await api().prepareUpdate(f.input,f.ports),null);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
});

function candidateFixture() {
  const overlay = {schema:1,base_sha:'a'.repeat(40),accepted_sha:'e'.repeat(40),patch_sha256:'f'.repeat(64),paths:['codex-rs/cli/src/main.rs','codex-rs/tui/src/status_line_command.rs'],formatter_sha:'f'.repeat(40),required_suites:['feature','full','config','build']};
  const context = {candidateSha:'b'.repeat(40),upstreamSha:'c'.repeat(40),controllerSha:'d'.repeat(40),overlay};
  const commit = {repository:'TK-06/codexs',sha:context.candidateSha,parents:[context.upstreamSha],message:'codexs-upstream:v1\nupstream_sha='+context.upstreamSha+'\noverlay_sha='+context.controllerSha+'\npatch_sha256='+overlay.patch_sha256,files:[{filename:'codex-rs/cli/src/main.rs',status:'modified'}],complete:true};
  return {context,commit};
}

test('task10 candidate: verifies a new immutable commit without rewriting its frozen overlay', () => {
  const f=candidateFixture(),before=structuredClone(f);
  assert.deepEqual(api().verifyCandidate(f.context,f.commit),{candidate_sha:'b'.repeat(40),upstream_sha:'c'.repeat(40),overlay_sha:'d'.repeat(40),patch_sha256:'f'.repeat(64),paths:['codex-rs/cli/src/main.rs']});
  assert.deepEqual(f,before);
});

test('task10 candidate: accepts one producer trailing newline and records both rename paths', () => {
  const f=candidateFixture();f.commit.message+='\n';f.commit.files=[{filename:'codex-rs/tui/src/status_line_command.rs',previous_filename:'codex-rs/cli/src/main.rs',status:'renamed'}];
  assert.deepEqual(api().verifyCandidate(f.context,f.commit).paths,['codex-rs/cli/src/main.rs','codex-rs/tui/src/status_line_command.rs']);
});

for(const [name,mutate]of [
  ['wrong repository',f=>{f.commit.repository='other/repository';}],
  ['wrong commit',f=>{f.commit.sha='a'.repeat(40);}],
  ['wrong parent',f=>{f.commit.parents=['a'.repeat(40)];}],
  ['multiple parents',f=>{f.commit.parents.push('a'.repeat(40));}],
  ['missing parent',f=>{f.commit.parents=[];}],
  ['incomplete file page',f=>{f.commit.complete=false;}],
  ['empty files',f=>{f.commit.files=[];}],
  ['foreign changed path',f=>{f.commit.files=[{filename:'.github/workflows/evil.yml',status:'added'}];}],
  ['foreign previous path',f=>{f.commit.files=[{filename:'codex-rs/cli/src/main.rs',previous_filename:'outside.txt',status:'renamed'}];}],
  ['missing rename source',f=>{f.commit.files[0].status='renamed';}],
  ['duplicate paths',f=>{f.commit.files.push({...f.commit.files[0]});}],
  ['coercible candidate SHA',f=>{f.context.candidateSha=[f.context.candidateSha];}],
  ['wrong controller',f=>{f.context.controllerSha='a'.repeat(40);}],
  ['wrong patch identity',f=>{f.context.overlay.patch_sha256='a'.repeat(64);}],
  ['unknown proof context',f=>{f.context.command='synthetic-untrusted-command';}],
  ['extra commit message field',f=>{f.commit.message+='\ncommand=synthetic';}],
  ['leading message whitespace',f=>{f.commit.message=' '+f.commit.message;}],
  ['extra trailing message line',f=>{f.commit.message+='\n\n';}],
])test('task10 candidate: rejects '+name,()=>{
  const f=candidateFixture();mutate(f);
  assert.throws(()=>api().verifyCandidate(f.context,f.commit),{name:'UpdateError',code:'CANDIDATE_PROVENANCE'});
});

for(const name of ['codex-rs/tui/src/status.snap','codex-rs/tui/src/status.snap.new','codex-rs/tui/src/status.pending-snap','codex-rs/../escape.rs','codex-rs\\escape.rs'])test('task10 candidate: rejects forbidden path '+name,()=>{
  const f=candidateFixture();f.context.overlay.paths.push(name);f.commit.files=[{filename:name,status:'added'}];
  assert.throws(()=>api().verifyCandidate(f.context,f.commit),{code:'CANDIDATE_PROVENANCE'});
});

function commitResponse(f,changes={}) {
  const bytes=Buffer.from(JSON.stringify({sha:f.commit.sha,parents:f.commit.parents.map(sha=>({sha})),commit:{message:f.commit.message},files:f.commit.files}));
  return {status:200,headers:new Headers(),body:(async function*(){yield bytes;})(),...changes};
}

test('task10 candidate: loads the fixed commit endpoint with a bounded read-only request',async()=>{
  const f=candidateFixture(),requests=[];
  const result=await api().loadCandidateProof(f.context,{token:'synthetic-token',fetch:async(url,options)=>{requests.push({url,options});return commitResponse(f);}});
  assert.equal(result.candidate_sha,'b'.repeat(40));assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://api.github.com/repos/TK-06/codexs/commits/'+'b'.repeat(40)+'?per_page=100');
  assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.redirect,'manual');
  assert.equal(requests[0].options.headers.Authorization,'Bearer synthetic-token');assert.ok(requests[0].options.signal instanceof AbortSignal);
});

for(const [name,response]of [
  ['redirect',f=>commitResponse(f,{status:302,headers:new Headers({location:'https://invalid.example/'})})],
  ['pagination',f=>commitResponse(f,{headers:new Headers({link:'<https://api.github.com/next>; rel="next"'})})],
  ['denied response',f=>commitResponse(f,{status:403})],
  ['invalid JSON',()=>({status:200,headers:new Headers(),body:(async function*(){yield Buffer.from('{');})()})],
  ['oversized JSON',()=>({status:200,headers:new Headers(),body:(async function*(){yield Buffer.alloc(2*1024**2+1);})()})],
])test('task10 candidate: rejects '+name+' from commit transport',async()=>{
  const f=candidateFixture();
  await assert.rejects(api().loadCandidateProof(f.context,{token:'synthetic-token',fetch:async()=>response(f)}),{code:'CANDIDATE_PROVENANCE'});
});
