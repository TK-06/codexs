'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { collectEvidence, collectPreBundleEvidence, createGithubClient, createAcceptanceReceipt, downloadDistributionArtifact } = require('./evidence.cjs');
const { evidenceFixture } = require('../test-support/update-fixtures.cjs');

test('distribution download binds native bytes to the successful build job upload and digest',async()=>{
  const f=evidenceFixture(),ref=f.input.runs.find(ref=>ref.scope==='build');
  assert.equal(typeof downloadDistributionArtifact,'function');
  const files=await downloadDistributionArtifact({ref,kind:'native',artifact:ref.binary_artifact},f.github);
  assert.equal(files.get('codex.exe').toString(),'synthetic native, never executed');
});

for(const [name,change]of [
  ['substituted bytes',(f,ref)=>f.bytes.set(ref.binary_artifact,Buffer.from('wrong'))],
  ['expired binary',(f,ref)=>{f.artifacts.get(ref.binary_artifact).expired=true;}],
  ['wrong source',(f,ref)=>{f.jobs.get(ref.job).head_sha='e'.repeat(40);}],
  ['failed run',(f,ref)=>{f.runs.get(ref.run).conclusion='failure';}],
  ['missing actual upload',(f,ref)=>f.jobLogs.set(ref.job,'synthetic fixture: no upload')],
])test('distribution download rejects '+name,async()=>{
  const f=evidenceFixture(),ref=f.input.runs.find(ref=>ref.scope==='build');change(f,ref);
  assert.equal(typeof downloadDistributionArtifact,'function');
  await assert.rejects(downloadDistributionArtifact({ref,kind:'native',artifact:ref.binary_artifact},f.github),error=>error.name==='UpdateError');
});

test('distribution download refuses an arbitrary artifact or kind before using GitHub',async()=>{
  const f=evidenceFixture(),ref=f.input.runs.find(ref=>ref.scope==='build');
  assert.equal(typeof downloadDistributionArtifact,'function');
  for(const input of [{ref,kind:'native',artifact:ref.artifact},{ref,kind:'formatter',artifact:ref.binary_artifact},{ref,kind:'command',artifact:ref.binary_artifact}])await assert.rejects(downloadDistributionArtifact(input,{}),{code:'EVIDENCE_INPUT'});
});

for(const kind of ['formatter','bundle'])test('distribution download authenticates the separate '+kind+' artifact',async()=>{
  const f=evidenceFixture(),ref=f.input.runs.find(ref=>ref.scope===kind),id=ref.artifact+1000;
  const {evidenceZip}=require('../test-support/update-fixtures.cjs'),{createHash}=require('node:crypto');
  const files=kind==='formatter'?{'dist/ccstatusline.js':'synthetic','package.json':'{}',LICENSE:'notice'}:{'codexs-windows-x64.zip':'synthetic','manifest-base.json':'{}','codexs-enrollment.zip':'synthetic','enrollment.json':'{}'};
  const raw=evidenceZip(files),artifact={...structuredClone(f.artifacts.get(ref.artifact)),id,name:`codexs-${kind==='formatter'?'formatter-dist':'bundle-draft'}-${ref.validation_id}-${ref.run}-${ref.attempt}`,size_in_bytes:raw.length,digest:'sha256:'+createHash('sha256').update(raw).digest('hex')};
  f.artifacts.set(id,artifact);f.bytes.set(id,raw);
  const stamp='2026-01-01T00:00:00.0000000Z ';
  const upload=['##[group]Run actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f','  name: '+artifact.name,'##[endgroup]','SHA256 digest of uploaded artifact is '+artifact.digest.slice(7),'Artifact '+artifact.name+' successfully finalized. Artifact ID '+id,'Artifact '+artifact.name+' has been successfully uploaded! Final size is '+raw.length+' bytes. Artifact ID is '+id].map(line=>stamp+line).join('\n');
  f.jobLogs.set(ref.job,f.jobLogs.get(ref.job)+upload+'\n');
  assert.equal(typeof downloadDistributionArtifact,'function');
  assert.deepEqual([...await downloadDistributionArtifact({ref,kind,artifact:id},f.github)].map(([name,value])=>[name,value.toString()]),Object.entries(files));
  f.artifacts.get(id).name='codexs-formatter-dist-different-150-1';
  await assert.rejects(downloadDistributionArtifact({ref,kind,artifact:id},f.github),{code:'EVIDENCE_ARTIFACT'});
});

test('complete acceptance binds actual native totals and all eight suites to immutable run identities', async () => {
  const f = evidenceFixture();
  const result = await collectEvidence(f.input, f.github);
  assert.equal(result.candidate_sha, 'b'.repeat(40));
  assert.equal(result.upstream_sha, 'a'.repeat(40));
  assert.equal(result.formatter_sha, 'd'.repeat(40));
  assert.deepEqual(result.suites.feature, { passed: 150, failed: 0, ignored: 0, exit: 0 });
  assert.deepEqual(result.suites.full, { passed: 6004, failed: 0, ignored: 8, exit: 0 });
  assert.deepEqual(result.suites.config, { passed: 403, failed: 0, ignored: 0, exit: 0 });
  assert.deepEqual(Object.keys(result.suites).sort(), ['bundle','config','feature','formatter','full','installer','quick','updater']);
  assert.equal(result.build_exit, 0);
  assert.equal(result.runs.length, 9);
  assert.ok(result.runs.some(ref=>ref.run===140&&ref.job===141&&ref.artifact===143),'accepted native binary artifact is retained separately from build logs');
  assert.ok(result.runs.every(ref => Object.keys(ref).sort().join(',') === 'artifact,attempt,job,repository,run'));
});

for(const scope of ['build','formatter'])test('bundle evidence refuses a different successful same-source '+scope+' run',async()=>{
  const f=evidenceFixture(),ref=f.input.runs.find(ref=>ref.scope===scope),old={...ref},shift=1000;
  f.runs.set(old.run+shift,{...f.runs.get(old.run),id:old.run+shift});
  f.jobs.set(old.job+shift,{...f.jobs.get(old.job),id:old.job+shift,run_id:old.run+shift});
  for(const id of [old.artifact,...(scope==='build'?[old.binary_artifact]:[])]){
    const artifact=structuredClone(f.artifacts.get(id));artifact.id=id+shift;artifact.name=artifact.name.replace('-'+old.run+'-','-'+(old.run+shift)+'-');artifact.workflow_run.id=old.run+shift;
    f.artifacts.set(id+shift,artifact);f.bytes.set(id+shift,f.bytes.get(id));
  }
  Object.assign(ref,{run:old.run+shift,job:old.job+shift,artifact:old.artifact+shift,...(scope==='build'?{binary_artifact:old.binary_artifact+shift}:{})});
  f.replaceFiles(scope,()=>{});
  if(scope==='formatter')f.addDistributionArtifact('formatter',{'dist/ccstatusline.js':'a second accepted formatter build','package.json':'{}',LICENSE:'synthetic'});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_BINDING'});
});

test('pre-bundle evidence is explicit and cannot satisfy complete acceptance', async () => {
  const f = evidenceFixture();
  f.input.runs = f.input.runs.filter(ref => ref.scope !== 'bundle');
  const result = await collectPreBundleEvidence(f.input, f.github);
  assert.equal(Object.hasOwn(result.suites, 'bundle'), false);
  await assert.rejects(collectEvidence(f.input, f.github), { code: 'EVIDENCE_INCOMPLETE' });
});

for(const scope of ['quick','formatter','bundle','full'])test('evidence rejects a self-declared replacement controller for '+scope,async()=>{
  const f=evidenceFixture(),ref=f.input.runs.find(ref=>ref.scope===scope);
  f.github.controllerSha='c'.repeat(40);ref.controller_sha='e'.repeat(40);
  f.runs.get(ref.run).head_sha=ref.controller_sha;f.jobs.get(ref.job).head_sha=ref.controller_sha;f.artifacts.get(ref.artifact).workflow_run.head_sha=ref.controller_sha;
  if(['quick','formatter','bundle'].includes(scope))f.replaceFiles(scope,files=>{const receipt=JSON.parse(files['acceptance.json']);receipt.controller_sha=ref.controller_sha;files['acceptance.json']=JSON.stringify(receipt);});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_TRUST'});
});

for(const scope of ['full','config'])test('complete '+scope+' evidence refuses consistent but filtered Cargo totals',async()=>{
  const f=evidenceFixture();f.replaceFiles(scope,files=>{files['cargo.log']=files['cargo.log'].replace('0 filtered out','1 filtered out');});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_OUTCOME'});
});
for(const scope of ['feature','full','config','build'])test('native evidence verifies the actual canonical invocation for '+scope,async()=>{
  const f=evidenceFixture();
  f.replaceFiles(scope,files=>{files['cargo.log']='scope='+scope+' source='+f.input.candidate.sha+' rust=1.95.0 jobs=1 release=true locked=true lto=off debug=0 tui_opt=1 native_command=synthetic/rustup.exe run 1.95.0 cargo test --release --locked -p codex-tui --lib partial_case\n'+files['cargo.log'];});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_OUTCOME'});
});

for (const [name, change] of [
  ['queued run', f => { f.runs.get(100).status = 'queued'; }],
  ['cancelled run', f => { f.runs.get(100).conclusion = 'cancelled'; }],
  ['failed sibling job in completed run', f => { f.runs.get(100).conclusion = 'failure'; }],
  ['wrong run attempt', f => { f.runs.get(100).run_attempt = 2; }],
  ['wrong controller source', f => { f.runs.get(100).head_sha = 'e'.repeat(40); }],
  ['unrecognized workflow', f => { f.runs.get(100).path = '.github/workflows/other.yml'; }],
  ['wrong job attempt', f => { f.jobs.get(101).run_attempt = 2; }],
  ['wrong job run', f => { f.jobs.get(101).run_id = 999; }],
  ['wrong job source',f=>{f.jobs.get(101).head_sha='e'.repeat(40);}],
  ['renamed feature suite', f => { f.jobs.get(111).name = 'Windows (subset)'; }],
  ['skipped guarded operation', f => { f.jobs.get(111).steps[0].conclusion = 'skipped'; }],
  ['expired artifact', f => { f.artifacts.get(102).expired = true; }],
  ['artifact from another run', f => { f.artifacts.get(102).workflow_run.id = 999; }],
  ['artifact from another source', f => { f.artifacts.get(102).workflow_run.head_sha = 'e'.repeat(40); }],
  ['artifact renamed as another invocation', f => { f.artifacts.get(102).name = 'codexs-task9-quick-other-100-1'; }],
  ['artifact bytes substituted after upload', f => { f.bytes.set(102, Buffer.from('substituted')); }],
  ['untrusted artifact digest', f => { f.artifacts.get(102).digest = 'sha256:' + '0'.repeat(64); }],
]) {
  test('acceptance rejects ' + name, async () => {
    const f = evidenceFixture(); change(f);
    await assert.rejects(collectEvidence(f.input, f.github), error => error.name === 'UpdateError' && /^EVIDENCE_/.test(error.code));
  });
}

for (const [name, change] of [
  ['guard stop', files => { files['outcome.txt'] = files['outcome.txt'].replace('guard_stop=none', 'guard_stop=memory'); }],
  ['wrong native source', files => { files['setup.log'] = files['setup.log'].replaceAll('b'.repeat(40), 'e'.repeat(40)); }],
  ['native nonzero exit', files => { files['native-exit.txt'] = '1\n'; }],
  ['zero discovery', files => { files['cargo.log'] = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n'; }],
  ['partial totals', files => { files['cargo.log'] = files['cargo.log'].replace('150 passed', '149 passed'); }],
  ['failed tests', files => { files['cargo.log'] = files['cargo.log'].replace('0 failed', '1 failed'); }],
  ['synthetic success line in a fixture', files => { files['cargo.log'] = 'fixture: test result: ok. 150 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n'; }],
  ['duplicate successful summary', files => { files['outcome.txt'] += files['outcome.txt']; }],
  ['unexpected wrapper failure', files => { files['outcome.txt'] = files['outcome.txt'].replace('wrapper=', 'wrapper=FAILED'); }],
]) {
  test('native evidence rejects ' + name, async () => {
    const f = evidenceFixture(); f.replaceFiles('feature', change);
    await assert.rejects(collectEvidence(f.input, f.github), { code: 'EVIDENCE_OUTCOME' });
  });
}

test('build acceptance requires the exact successful CLI version probe', async () => {
  const f = evidenceFixture();
  f.replaceFiles('build', files => { files['cargo.log'] = 'cli_version_exit=0 output=codex-cli 0.165.0\n'; });
  await assert.rejects(collectEvidence(f.input, f.github), { code: 'EVIDENCE_OUTCOME' });
});

test('complete canonical Cargo runs can aggregate several test binaries including an empty binary',async()=>{
  const f=evidenceFixture();
  f.replaceFiles('config',files=>{
    files['cargo.log']+='test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n';
    files['cargo.log']+='test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
    files['outcome.txt']=files['outcome.txt'].replace('passed=403','passed=405').replace('total=403','total=405');
  });
  f.sealBundleInputs(await collectPreBundleEvidence({...f.input,runs:f.input.runs.filter(ref=>ref.scope!=='bundle')},f.github));
  assert.deepEqual((await collectEvidence(f.input,f.github)).suites.config,{passed:405,failed:0,ignored:0,exit:0});
});

test('a failed Cargo binary cannot be hidden beside a successful binary',async()=>{
  const f=evidenceFixture();f.replaceFiles('config',files=>{files['cargo.log']+='test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n';});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_OUTCOME'});
});

test('receipt totals alone cannot certify formatter tests without the original canonical output', async () => {
  const f = evidenceFixture();
  f.replaceFiles('formatter', files => { files['tests.log'] = 'example: 3010 pass\n0 fail\n'; });
  await assert.rejects(collectEvidence(f.input, f.github), { code: 'EVIDENCE_OUTCOME' });
});

test('receipt identity and required suite names cannot be changed or omitted', async () => {
  for (const mutate of [
    receipt => { receipt.formatter_sha = 'e'.repeat(40); },
    receipt => { receipt.suites.subset = receipt.suites.updater; delete receipt.suites.updater; },
    receipt => { receipt.suites.updater.passed = 0; },
    receipt => { receipt.suites.updater.failed = 1; },
    receipt => { receipt.unreviewed = true; },
  ]) {
    const f = evidenceFixture();
    f.replaceFiles('quick', files => { const receipt = JSON.parse(files['acceptance.json']); mutate(receipt); files['acceptance.json'] = JSON.stringify(receipt); });
    await assert.rejects(collectEvidence(f.input, f.github), error => /^EVIDENCE_/.test(error.code));
  }
});

test('duplicate scope references never cover a missing complete suite', async () => {
  const f = evidenceFixture(); f.input.runs.push({ ...f.input.runs[0] });
  await assert.rejects(collectEvidence(f.input, f.github), { code: 'EVIDENCE_INPUT' });
});

test('final bundle evidence is bound to the exact archive bytes being considered for release',async()=>{
  const f=evidenceFixture();
  f.replaceFiles('bundle',files=>{const receipt=JSON.parse(files['acceptance.json']);receipt.archive.sha256='8'.repeat(64);files['acceptance.json']=JSON.stringify(receipt);});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_OUTCOME'});
});

test('complete acceptance requires archive identity while pre-bundle collection remains usable before assembly',async()=>{
  const f=evidenceFixture();delete f.input.candidate.archive;
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_INPUT'});
  f.input.runs=f.input.runs.filter(ref=>ref.scope!=='bundle');
  assert.equal((await collectPreBundleEvidence(f.input,f.github)).build_exit,0);
});

test('coercible source hashes are rejected as input rather than interpreted as source identities',async()=>{
  const f=evidenceFixture();f.input.candidate.sha=[f.input.candidate.sha];
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_INPUT'});
});

test('a conflicting failure summary cannot be hidden beside a successful assertion count',async()=>{
  const f=evidenceFixture();f.replaceFiles('quick',files=>{files['installer.log']+='Installer assertions: 46 passed; 1 failed\n';});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_OUTCOME'});
});

test('quick acceptance rejects a duplicate or failed TAP aggregate even beside a success aggregate',async()=>{
  const f=evidenceFixture();f.replaceFiles('quick',files=>{files['updater.log']+='# fail 1\n';});
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_OUTCOME'});
});

test('malformed and oversized artifact contents fail with a bounded public code', async () => {
  const f = evidenceFixture(); const raw = Buffer.from('not a ZIP');
  f.setArtifactBytes('quick',raw);
  await assert.rejects(collectEvidence(f.input, f.github), error => error.code === 'EVIDENCE_ARTIFACT' && !error.message.includes('not a ZIP'));
});

test('artifact identity must be uploaded by the selected successful job rather than another job in the same run',async()=>{
  const f=evidenceFixture();f.jobLogs.set(101,f.jobLogs.get(111));
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_JOB'});
});

test('artifact upload digest is bound to the exact accepted job upload',async()=>{
  const f=evidenceFixture();f.jobLogs.set(101,f.jobLogs.get(101).replace(f.artifacts.get(102).digest.slice(7),'0'.repeat(64)));
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_JOB'});
});

test('an echoed synthetic upload message outside the artifact action is not upload provenance',async()=>{
  const f=evidenceFixture();f.jobLogs.set(101,f.jobLogs.get(101).replace('Run actions/upload-artifact@','Run echo fixture@'));
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_JOB'});
});

test('native binary provenance is mandatory even when the build logs pass',async()=>{
  const f=evidenceFixture();delete f.input.runs.find(ref=>ref.scope==='build').binary_artifact;
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_INPUT'});
});

test('native binary artifacts from a different run or source cannot reuse successful build logs',async()=>{
  for(const mutate of [artifact=>{artifact.workflow_run.id=999;},artifact=>{artifact.workflow_run.head_sha='e'.repeat(40);},artifact=>{artifact.expired=true;},artifact=>{artifact.name='codexs-cli-unrelated-140-1';}]){
    const f=evidenceFixture();mutate(f.artifacts.get(143));
    await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_ARTIFACT'});
  }
});

test('accepted binary bytes must be the artifact actually uploaded by the selected native build job',async()=>{
  const f=evidenceFixture();f.jobLogs.set(141,f.jobLogs.get(141).split('2026-01-01T00:00:00.0000000Z ##[group]Run actions/upload-artifact@')[0]+'2026-01-01T00:00:00.0000000Z ##[group]Run actions/upload-artifact@'+f.jobLogs.get(141).split('2026-01-01T00:00:00.0000000Z ##[group]Run actions/upload-artifact@')[1]);
  await assert.rejects(collectEvidence(f.input,f.github),{code:'EVIDENCE_JOB'});
});

test('GitHub evidence adapter reads the requested immutable attempt and performs no write request',async()=>{
  const requests=[];
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({id:100,run_attempt:2}),{status:200});}});
  assert.deepEqual(await github.getRun('TK-06/codexs',100,2),{id:100,run_attempt:2});
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://api.github.com/repos/TK-06/codexs/actions/runs/100/attempts/2');
  assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.redirect,'manual');
});

function evidenceTransferClock(t) {
  let elapsed=0;
  const deadlines=[];
  t.mock.method(AbortSignal,'timeout',milliseconds=>{
    const controller=new AbortController();deadlines.push({at:elapsed+milliseconds,controller});return controller.signal;
  });
  const advance=milliseconds=>{
    elapsed+=milliseconds;
    for(const deadline of deadlines)if(deadline.at<=elapsed&&!deadline.controller.signal.aborted)deadline.controller.abort(new DOMException('synthetic transfer deadline','TimeoutError'));
  };
  t.after(()=>advance(Infinity));
  return {advance};
}

function pendingEvidenceBody(signal) {
  let controller,done=false;
  const abort=()=>{if(!done){done=true;controller.error(signal.reason);}};
  const response=new Response(new ReadableStream({
    start(value){controller=value;if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});},
    cancel(){done=true;signal.removeEventListener('abort',abort);},
  }),{status:200});
  return {response,finish(value){if(!done){done=true;signal.removeEventListener('abort',abort);controller.enqueue(Buffer.from(value));controller.close();}}};
}

for(const [kind,elapsed,payload]of [['log',15000,'synthetic job log'],['artifact',60000,'synthetic ZIP bytes']]){
  test('GitHub '+kind+' transfer accepts a valid body beyond the shorter deadline',{timeout:5000},async t=>{
    const clock=evidenceTransferClock(t);let body;
    const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async(url,{signal})=>{body=pendingEvidenceBody(signal);return body.response;}});
    const pending=(kind==='log'?github.getJobLog('TK-06/codexs',101):github.downloadArtifact('TK-06/codexs',102)).then(value=>({value}),error=>({code:error.code}));
    clock.advance(elapsed);body.finish(payload);
    assert.deepEqual(await pending,{value:kind==='log'?payload:Buffer.from(payload)});
  });
}

test('GitHub metadata body still expires at fifteen seconds',{timeout:5000},async t=>{
  const clock=evidenceTransferClock(t);let body;
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async(url,{signal})=>{body=pendingEvidenceBody(signal);return body.response;}});
  const pending=github.getArtifact('TK-06/codexs',102).then(value=>({value}),error=>({code:error.code}));
  clock.advance(15000);body.finish('{"id":102}');
  assert.deepEqual(await pending,{code:'EVIDENCE_HTTP'});
});

for(const [kind,limit]of [['log',60000],['artifact',180000]]){
  test('GitHub stalled '+kind+' transfer remains bounded at its transfer deadline',{timeout:5000},async t=>{
    const clock=evidenceTransferClock(t);let signal;
    const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async(url,options)=>{signal=options.signal;return pendingEvidenceBody(signal).response;}});
    const pending=(kind==='log'?github.getJobLog('TK-06/codexs',101):github.downloadArtifact('TK-06/codexs',102)).then(value=>({value}),error=>({code:error.code}));
    clock.advance(limit-1);assert.equal(signal.aborted,false,'transfer expired before its approved budget');
    clock.advance(1);assert.deepEqual(await pending,{code:'EVIDENCE_HTTP'});
  });
}

test('GitHub artifact redirects share one total transfer deadline',{timeout:5000},async t=>{
  const clock=evidenceTransferClock(t);let requests=0,body;
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async(url,{signal})=>{
    requests++;
    if(requests===1){clock.advance(120000);return new Response(null,{status:302,headers:{location:'https://productionresultssa1.blob.core.windows.net/synthetic'}});}
    body=pendingEvidenceBody(signal);return body.response;
  }});
  const pending=github.downloadArtifact('TK-06/codexs',102).then(value=>({value}),error=>({code:error.code}));
  await new Promise(setImmediate);
  assert.equal(requests,2);assert.ok(body);
  clock.advance(60000);assert.deepEqual(await pending,{code:'EVIDENCE_HTTP'});
});

test('GitHub artifact redirect receives no token after leaving the API origin',async()=>{
  const requests=[],payload=Buffer.from('synthetic archive');
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async(url,options)=>{
    requests.push({url,options});
    if(requests.length===1)return new Response(null,{status:302,headers:{location:'https://productionresultssa1.blob.core.windows.net/actions-results/synthetic?sig=synthetic'}});
    return new Response(payload,{status:200});
  }});
  assert.deepEqual(await github.downloadArtifact('TK-06/codexs',102),payload);
  assert.equal(requests[0].options.headers.Authorization,'Bearer SYNTHETIC_TOKEN');
  assert.equal(Object.hasOwn(requests[1].options.headers,'Authorization'),false);
  assert.equal(Object.values(requests[1].options.headers).some(value=>String(value).includes('SYNTHETIC_TOKEN')),false);
});

test('GitHub evidence adapter rejects untrusted or insecure redirects before contacting them',async()=>{
  for(const location of ['http://productionresultssa1.blob.core.windows.net/test','https://example.invalid/test','https://user:password@productionresultssa1.blob.core.windows.net/test']) {
    let requests=0;
    const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async()=>{requests++;return new Response(null,{status:302,headers:{location}});}});
    await assert.rejects(github.downloadArtifact('TK-06/codexs',102),{code:'EVIDENCE_HTTP'});
    assert.equal(requests,1);
  }
});

test('GitHub evidence adapter bounds metadata streams even when Content-Length is absent',async()=>{
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async()=>new Response(Buffer.alloc(2*1024*1024+1),{status:200})});
  await assert.rejects(github.getArtifact('TK-06/codexs',102),{code:'EVIDENCE_HTTP'});
});

test('GitHub evidence adapter rejects a different repository or coercible identifier before network access',async()=>{
  let requests=0;
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async()=>{requests++;throw Error('unexpected');}});
  await assert.rejects(github.getJob('untrusted/repository',101),{code:'EVIDENCE_INPUT'});
  await assert.rejects(github.getArtifact('TK-06/codexs','102'),{code:'EVIDENCE_INPUT'});
  assert.equal(requests,0);
});

test('GitHub evidence network failures expose neither credentials nor the redirected URL',async()=>{
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async()=>{throw Error('SYNTHETIC_TOKEN https://private.invalid/?sig=synthetic');}});
  await assert.rejects(github.getJobLog('TK-06/codexs',101),error=>error.name==='UpdateError'&&error.code==='EVIDENCE_HTTP'&&!/SYNTHETIC|private|sig=/.test(error.message));
});

test('native artifact preparation can set an exact bounded download size without changing log-artifact defaults',async()=>{
  const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async()=>new Response(Buffer.from('native'),{status:200})});
  await assert.rejects(github.downloadArtifact('TK-06/codexs',143,{maxBytes:5}),{code:'EVIDENCE_HTTP'});
  assert.deepEqual(await github.downloadArtifact('TK-06/codexs',143,{maxBytes:6}),Buffer.from('native'));
});

test('artifact download bounds cannot exceed the release archive ceiling or accept coercible values',async()=>{
  let requests=0;const github=createGithubClient({token:'SYNTHETIC_TOKEN',fetch:async()=>{requests++;return new Response('unexpected');}});
  for(const maxBytes of [0,'6',256*1024**2+1])await assert.rejects(github.downloadArtifact('TK-06/codexs',143,{maxBytes}),{code:'EVIDENCE_INPUT'});
  assert.equal(requests,0);
});

function receiptInput(f,scope) {
  let files,bundleInputs;
  f.replaceFiles(scope,data=>{files=new Map(Object.entries(data).filter(([name])=>name!=='acceptance.json').map(([name,value])=>[name,Buffer.from(value)]));if(scope==='bundle')bundleInputs=JSON.parse(data['acceptance.json']).inputs;});
  return {scope,candidate:f.input.candidate,formatter:f.input.formatter,controller_sha:'c'.repeat(40),files,...(scope==='bundle'?{bundleInputs}:{})};
}

test('hosted quick receipt derives measured totals from the actual gate log formats',()=>{
  const f=evidenceFixture(),receipt=createAcceptanceReceipt(receiptInput(f,'quick'));
  assert.deepEqual(receipt.suites,{quick:{passed:77,failed:0,ignored:0,exit:0},installer:{passed:46,failed:0,ignored:0,exit:0},updater:{passed:442,failed:0,ignored:0,exit:0}});
  assert.equal(receipt.build_exit,null);
  assert.equal(Object.hasOwn(receipt,'archive'),false);
});

test('formatter and bundle receipts preserve measured suite totals and exact tested archive identity',()=>{
  const f=evidenceFixture();
  assert.deepEqual(createAcceptanceReceipt(receiptInput(f,'formatter')).suites,{formatter:{passed:3010,failed:0,ignored:19,exit:0}});
  const bundle=createAcceptanceReceipt(receiptInput(f,'bundle'));
  assert.deepEqual(bundle.suites,{bundle:{passed:12,failed:0,ignored:0,exit:0}});
  assert.deepEqual(bundle.archive,{bytes:1234,sha256:'9'.repeat(64)});
});

test('receipt creation refuses failed raw checks and cannot invent acceptance for a native scope',()=>{
  const f=evidenceFixture(),input=receiptInput(f,'quick');input.files.set('quick.log',Buffer.from('RESULT passed=77 failed=1\n'));
  assert.throws(()=>createAcceptanceReceipt(input),{code:'EVIDENCE_OUTCOME'});
  assert.throws(()=>createAcceptanceReceipt({...input,scope:'feature'}),{code:'EVIDENCE_INPUT'});
});

test('actual final evidence job binds completed bundle bytes and retains both distribution artifact references',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
  const {fixtureTempRoot,evidenceZip,releaseManifest}=require('../test-support/update-fixtures.cjs');
  const parent=fixtureTempRoot(),directory=await fs.mkdtemp(path.join(parent,'codexs-evidence-job-test-'));
  t.after(async()=>{if(path.dirname(directory)!==parent||!path.basename(directory).startsWith('codexs-evidence-job-test-'))throw Error('Unsafe evidence fixture cleanup');await fs.rm(directory,{recursive:true,maxRetries:10,retryDelay:100});});
  const f=evidenceFixture(),archive=Buffer.from('synthetic bundle archive, never executed'),sha256=createHash('sha256').update(archive).digest('hex');
  f.input.candidate.archive={bytes:archive.length,sha256};
  f.replaceFiles('bundle',files=>{const receipt=JSON.parse(files['acceptance.json']);receipt.archive={...f.input.candidate.archive};files['acceptance.json']=JSON.stringify(receipt);});
  const base=releaseManifest();delete base.sequence;delete base.release_id;delete base.evidence;base.archive={name:'codexs-windows-x64.zip',...f.input.candidate.archive};
  const formatterArtifact=f.addDistributionArtifact('formatter',{'dist/ccstatusline.js':'synthetic','package.json':'{}',LICENSE:'synthetic notice'});
  const bundleArtifact=f.addDistributionArtifact('bundle',{'codexs-windows-x64.zip':archive,'manifest-base.json':JSON.stringify(base),'codexs-enrollment.zip':evidenceZip({'update/enroll.ps1':'synthetic'}),'enrollment.json':'{}'});
  const root=path.resolve(__dirname,'../..'),source=await fs.readFile(path.join(root,'.github/workflows/codexs-statusline.yml'),'utf8');
  const job=source.match(/^  release_evidence:\r?\n([\s\S]*?)(?=^  [a-z_]+:|$(?![\s\S]))/m);assert.ok(job);
  const program=job[1].match(/\$program=@'\r?\n([\s\S]*?)\r?\n          '@/)[1].replace(/^          /gm,'');
  const fakeProcess={env:{...process.env,GITHUB_WORKSPACE:root,RUNNER_TEMP:directory,GITHUB_OUTPUT:path.join(directory,'outputs'),GITHUB_RUN_ID:'170',GITHUB_RUN_ATTEMPT:'1',GH_TOKEN:'synthetic-read-token',CODEXS_NATIVE_SHA:'b'.repeat(40),CODEXS_UPSTREAM_SHA:'a'.repeat(40),CODEXS_SOURCE_VERSION:'0.166.0',CODEXS_FORMATTER_SHA:'d'.repeat(40),CODEXS_FORMATTER_VERSION:'2.2.32',CODEXS_PRODUCT_VERSION:'1.0.1',CODEXS_EVIDENCE_REQUEST:JSON.stringify({runs:f.input.runs,formatter_artifact:formatterArtifact,bundle_artifact:bundleArtifact})},exitCode:0};
  const load=name=>name===path.join(root,'codexs/release/evidence.cjs')?{...require('./evidence.cjs'),createGithubClient:()=>f.github}:require(name);
  await new Function('require','process',program.replace('(async()=>','return (async()=>'))(load,fakeProcess);
  assert.notEqual(fakeProcess.exitCode,0,'wrong product version was accepted');
  fakeProcess.exitCode=0;fakeProcess.env.CODEXS_PRODUCT_VERSION='1.0.0';fakeProcess.env.GH_TOKEN='synthetic-read-token';
  await new Function('require','process',program.replace('(async()=>','return (async()=>'))(load,fakeProcess);
  assert.equal(fakeProcess.exitCode,0);assert.equal(fakeProcess.env.GH_TOKEN,undefined);
  const output=path.join(directory,'codexs-task9-evidence-170-1'),evidence=JSON.parse(await fs.readFile(path.join(output,'evidence.json'),'utf8'));
  assert.deepEqual(evidence.suites.bundle,{passed:12,failed:0,ignored:0,exit:0});
  assert.ok(evidence.runs.some(ref=>ref.artifact===formatterArtifact),'final evidence must retain the formatter distribution artifact');
  assert.ok(evidence.runs.some(ref=>ref.artifact===bundleArtifact),'final evidence must retain the tested draft artifact');
  assert.equal(JSON.parse(await fs.readFile(path.join(output,'archive.json'),'utf8')).sha256,sha256);
});
