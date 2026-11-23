'use strict';

const { TextDecoder } = require('node:util');
const { UpdateError } = require('../update/protocol.cjs');
const { discoverUpstream, createControlClient, createDiscoveryPorts } = require('./publish.cjs');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createGithubClient,collectPreBundleEvidence } = require('./evidence.cjs');
const { prepareCandidate } = require('../upstream/upstream.cjs');

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const CANDIDATE = 'CANDIDATE_PROVENANCE';
const fail = code => { throw new UpdateError(code); };
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

function fields(value, keys, code = CANDIDATE) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}

function sourcePath(value) {
  return typeof value === 'string' && value.length <= 1024 && value.startsWith('codex-rs/') &&
    value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part)) &&
    !/\.(?:snap(?:\.new)?|pending-snap)$/i.test(value);
}

function candidateContext(context) {
  fields(context, ['candidateSha','upstreamSha','controllerSha','overlay']);
  if (![context.candidateSha,context.upstreamSha,context.controllerSha].every(value => matches(value,SHA)) || context.candidateSha === context.upstreamSha) fail(CANDIDATE);
  const overlay = context.overlay;
  fields(overlay, ['schema','base_sha','accepted_sha','patch_sha256','paths','formatter_sha','required_suites']);
  if (overlay.schema !== 1 || ![overlay.base_sha,overlay.accepted_sha,overlay.formatter_sha].every(value => matches(value,SHA)) || !matches(overlay.patch_sha256,HASH) ||
      !Array.isArray(overlay.paths) || !overlay.paths.length || overlay.paths.length > 10000 || !overlay.paths.every(sourcePath) ||
      new Set(overlay.paths.map(value => value.toLowerCase())).size !== overlay.paths.length ||
      JSON.stringify(overlay.required_suites) !== JSON.stringify(['feature','full','config','build'])) fail(CANDIDATE);
}

function verifyCandidate(context, commit) {
  candidateContext(context);
  fields(commit, ['repository','sha','parents','message','files','complete']);
  const expected = 'codexs-upstream:v1\nupstream_sha='+context.upstreamSha+'\noverlay_sha='+context.controllerSha+'\npatch_sha256='+context.overlay.patch_sha256;
  if (commit.repository !== 'TK-06/codexs' || commit.sha !== context.candidateSha || commit.complete !== true ||
      !Array.isArray(commit.parents) || commit.parents.length !== 1 || commit.parents[0] !== context.upstreamSha ||
      typeof commit.message !== 'string' || commit.message.replace(/\n$/,'') !== expected ||
      !Array.isArray(commit.files) || !commit.files.length || commit.files.length > 100) fail(CANDIDATE);
  const names = new Set(), paths = [];
  for (const file of commit.files) {
    if (!file || !['added','modified','removed','renamed'].includes(file.status) ||
        file.status === 'renamed' && typeof file.previous_filename !== 'string' ||
        file.status !== 'renamed' && Object.hasOwn(file,'previous_filename')) fail(CANDIDATE);
    for (const name of [file.filename,...(file.status === 'renamed' ? [file.previous_filename] : [])]) {
      if (!sourcePath(name) || !context.overlay.paths.includes(name) || names.has(name.toLowerCase())) fail(CANDIDATE);
      names.add(name.toLowerCase()); paths.push(name);
    }
  }
  return {candidate_sha:context.candidateSha,upstream_sha:context.upstreamSha,overlay_sha:context.controllerSha,patch_sha256:context.overlay.patch_sha256,paths:paths.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))};
}

async function loadCandidateProof(context, options) {
  try {
    candidateContext(context);
    if (!options || typeof options.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(options.token) || options.fetch !== undefined && typeof options.fetch !== 'function') fail(CANDIDATE);
    const response = await (options.fetch || globalThis.fetch)('https://api.github.com/repos/TK-06/codexs/commits/'+context.candidateSha+'?per_page=100', {
      method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(15000),
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+options.token,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'codexs-controller'},
    });
    if (response.status !== 200 || !response.body || response.headers.get('link')) fail(CANDIDATE);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > 2*1024**2)) fail(CANDIDATE);
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk); total += bytes.length;
      if (total > 2*1024**2) fail(CANDIDATE);
      chunks.push(bytes);
    }
    const raw = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks,total)));
    if (!Array.isArray(raw.parents) || !Array.isArray(raw.files)) fail(CANDIDATE);
    return verifyCandidate(context,{repository:'TK-06/codexs',sha:raw.sha,parents:raw.parents.map(parent=>parent?.sha),message:raw.commit?.message,files:raw.files,complete:true});
  } catch { fail(CANDIDATE); }
}

const PRODUCT_VERSION='1.0.0';
const REPOSITORY='TK-06/codexs';
const WORKFLOW=REPOSITORY+'/.github/workflows/codexs-';
function authorizeRun(context) {
  fields(context,['repository','eventName','ref','workflowRef','mode','updatesEnabled','releasesEnabled','controllerSha'],'CONTROLLER_POLICY');
  if(!['validate','initial','routine'].includes(context.mode)||!matches(context.controllerSha,SHA)||
      ['repository','eventName','ref','workflowRef','updatesEnabled','releasesEnabled'].some(key=>typeof context[key]!=='string'||context[key].length>512))fail('CONTROLLER_POLICY');
  const denied={prepare:false,validate:false,publish:false};
  if(context.repository!==REPOSITORY||context.ref!=='refs/heads/main')return denied;
  const upstream=context.workflowRef===WORKFLOW+'upstream.yml@refs/heads/main',release=context.workflowRef===WORKFLOW+'release.yml@refs/heads/main';
  const manual=context.eventName==='workflow_dispatch',scheduled=context.eventName==='schedule',called=context.eventName==='workflow_call';
  if(upstream){
    if(context.mode!=='routine'||!manual&&!scheduled||context.updatesEnabled!=='true')return denied;
    return {prepare:true,validate:true,publish:context.releasesEnabled==='true'};
  }
  if(!release||!manual&&!scheduled&&!called)return denied;
  if(context.mode==='initial')return manual?{prepare:false,validate:true,publish:true}:denied;
  if(context.mode==='validate')return manual?{prepare:false,validate:true,publish:false}:denied;
  return {prepare:false,validate:true,publish:context.releasesEnabled==='true'};
}

function boundedError(error,fallback) {
  const code=error?.code;
  fail(typeof code==='string'&&code.length<=64&&/^(?:CONTROLLER_[A-Z_]+|CANDIDATE_[A-Z_]+|UPSTREAM_[A-Z_]+|PACKAGE_[A-Z_]+|OVERLAY_[A-Z_]+|SOURCE_[A-Z_]+|WORKSPACE(?:_LOCK)?|PREPARATION_IO|EVIDENCE_[A-Z_]+|ACCEPTANCE_[A-Z_]+|DISPATCH_UNCERTAIN|PUBLISH_NETWORK)$/.test(code)?code:fallback);
}

async function prepareUpdate(input,ports) {
  try{
    fields(input,['context','overlay','formatter','workspace'],'CONTROLLER_POLICY');
    if(!authorizeRun(input.context).prepare)return null;
    const context={...input.context},overlay={...input.overlay,paths:[...input.overlay.paths],patch_bytes:Buffer.from(input.overlay.patch_bytes)},formatter={...input.formatter};
    fields(formatter,['sha','version'],'CONTROLLER_POLICY');
    if(overlay.revision!==context.controllerSha)fail('OVERLAY_IDENTITY');
    if(formatter.sha!==overlay.formatter_sha||!matches(formatter.sha,SHA))fail('CONTROLLER_POLICY');
    const manifest=await ports.readFormatterManifest(formatter.sha);
    if(manifest?.version!==formatter.version||!validVersion(formatter.version))fail('CONTROLLER_POLICY');
    const upstream=await discoverUpstream(ports);if(!upstream)return null;
    const branch='automation/upstream/'+upstream.version+'-'+context.controllerSha.slice(0,12),url='https://api.github.com/repos/TK-06/codexs/git/ref/heads/'+branch;
    const existing=await ports.getJson(url);
    const candidate=await prepareCandidate({upstream,overlay,workspace:input.workspace},{...ports,getJson:request=>request===url?Promise.resolve(existing):ports.getJson(request)});
    if(existing){
      const raw=await ports.getJson('https://api.github.com/repos/TK-06/codexs/commits/'+candidate.candidate_sha+'?per_page=100');
      const {revision,patch_bytes,...metadata}=overlay;
      verifyCandidate({candidateSha:candidate.candidate_sha,upstreamSha:upstream.sha,controllerSha:context.controllerSha,overlay:metadata},{repository:REPOSITORY,sha:raw?.sha,parents:raw?.parents?.map(parent=>parent.sha),message:raw?.commit?.message,files:raw?.files,complete:true});
    }else await ports.publishCandidate({workspace:input.workspace,branch,candidateSha:candidate.candidate_sha});
    return {upstream,candidate,formatter,branch};
  }catch(error){boundedError(error,'PREPARATION_IO');}
}

function validVersion(value){return typeof value==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)&&value.split('.').every(part=>Number.isSafeInteger(Number(part)));}

const positive=value=>Number.isSafeInteger(value)&&value>0;
const JOB_NAMES={quick:'Quick workflow and status-line formatting checks',formatter:'Pinned formatter acceptance',bundle:'Extracted Windows bundle acceptance',evidence:'Complete release evidence'};
const NATIVE=['feature','full','config','build'];
function runIdentity(run,id,controllerSha){
  if(!run||run.id!==id||run.run_attempt!==1||run.head_sha!==controllerSha||run.path!=='.github/workflows/codexs-statusline.yml'||run.repository?.full_name!==REPOSITORY||run.event!=='workflow_dispatch'||!['queued','in_progress','waiting','pending','requested','completed'].includes(run.status))fail('ACCEPTANCE_IDENTITY');
  if(run.status==='completed'&&run.conclusion!=='success')fail('ACCEPTANCE_IDENTITY');
}
function jobIdentity(job,scope,run,sha){
  const step=NATIVE.includes(scope)?'Run guarded native Cargo operation':scope==='evidence'?'Collect completed exact-archive evidence':'Record complete acceptance';
  if(!positive(job?.id)||job.run_id!==run||job.run_attempt!==1||job.head_sha!==sha||job.status!=='completed'||job.conclusion!=='success'||!Array.isArray(job.steps)||job.steps.filter(item=>item.name===step&&item.status==='completed'&&item.conclusion==='success').length!==1)fail('ACCEPTANCE_IDENTITY');
}
function chooseArtifact(artifacts,name,run,sha,max=32*1024**2){
  const found=artifacts.filter(item=>item.name===name);if(found.length!==1)fail('ACCEPTANCE_IDENTITY');const item=found[0];
  if(!positive(item.id)||item.expired!==false||!positive(item.size_in_bytes)||item.size_in_bytes>max||!/^sha256:[a-f0-9]{64}$/.test(item.digest)||item.workflow_run?.id!==run||item.workflow_run?.head_sha!==sha)fail('ACCEPTANCE_IDENTITY');return item.id;
}
function resolveScope(scope,child,metadata,controllerSha){
  const {jobs,artifacts}=metadata,name=NATIVE.includes(scope)?'Windows ('+scope+')':JOB_NAMES[scope],found=jobs.filter(item=>item.name===name);
  if(found.length!==1)fail('ACCEPTANCE_IDENTITY');const job=found[0];jobIdentity(job,scope,child.runId,controllerSha);
  const prefix=NATIVE.includes(scope)?'codexs-statusline':'codexs-task9',ending='-'+child.label+'-'+child.runId+'-1';
  const ref={scope,repository:REPOSITORY,run:child.runId,attempt:1,job:job.id,artifact:chooseArtifact(artifacts,prefix+'-'+scope+ending,child.runId,controllerSha),controller_sha:controllerSha,validation_id:child.label};
  if(scope==='build')ref.binary_artifact=chooseArtifact(artifacts,'codexs-cli'+ending,child.runId,controllerSha,256*1024**2);
  return ref;
}

async function runAcceptance(input,ports){
  try{
    fields(input,['controllerSha','candidateSha','upstreamSha','sourceVersion','formatterSha','formatterVersion','productVersion','mode','parentRunId','parentAttempt','nativeReuse'],'ACCEPTANCE_IDENTITY');
    input=structuredClone(input);
    if(![input.controllerSha,input.candidateSha,input.upstreamSha,input.formatterSha].every(value=>matches(value,SHA))||![input.sourceVersion,input.formatterVersion,input.productVersion].every(validVersion)||!positive(input.parentRunId)||!positive(input.parentAttempt)||!['validate','initial','routine'].includes(input.mode))fail('ACCEPTANCE_IDENTITY');
    const reuse=input.nativeReuse;
    if(reuse!==null){
      if(input.mode==='routine'||!Array.isArray(reuse)||reuse.length!==4||new Set(reuse.map(ref=>ref?.scope)).size!==4||NATIVE.some(scope=>!reuse.some(ref=>ref?.scope===scope)))fail('ACCEPTANCE_IDENTITY');
      for(const ref of reuse){fields(ref,['scope','repository','run','attempt','job','artifact','controller_sha','validation_id',...(ref.scope==='build'?['binary_artifact']:[])],'ACCEPTANCE_IDENTITY');if(ref.repository!==REPOSITORY||![ref.run,ref.attempt,ref.job,ref.artifact,...(ref.scope==='build'?[ref.binary_artifact]:[])].every(positive)||!matches(ref.controller_sha,SHA)||typeof ref.validation_id!=='string'||! /^[a-z][a-z0-9-]{0,31}$/.test(ref.validation_id))fail('ACCEPTANCE_IDENTITY');}
    }
    const start=ports.now();if(!Number.isSafeInteger(start)||start<0||start>Number.MAX_SAFE_INTEGER-240*60*1000)fail('ACCEPTANCE_IDENTITY');
    const deadline=start+240*60*1000;let last=start;const runIds=new Set();
    function budget(){const now=ports.now();if(!Number.isSafeInteger(now)||now<last)fail('ACCEPTANCE_IDENTITY');last=now;if(now>=deadline)fail('ACCEPTANCE_TIMEOUT');}
    const base={candidate_sha:input.candidateSha,baseline_sha:input.upstreamSha,formatter_sha:input.formatterSha,formatter_version:input.formatterVersion,source_version:input.sourceVersion,product_version:input.productVersion};
    async function dispatch(scope,request){
      budget();const suffix={feature:'f',cleanup:'c',formatter:'m',bundle:'b',evidence:'e'}[scope],label='r'+createHash('sha256').update(input.parentRunId+'/'+input.parentAttempt+'/'+scope).digest('hex').slice(0,24)+'-'+suffix;
      const result=await ports.dispatch({scope,inputs:{...base,validation_id:label,...(request?{evidence_request:JSON.stringify(request)}:{})}});
      if(!positive(result?.runId)||runIds.has(result.runId))fail('DISPATCH_UNCERTAIN');runIds.add(result.runId);return {runId:result.runId,label};
    }
    async function completed(children){
      for(;;){budget();const states=await Promise.all(children.map(child=>ports.getRun(child.runId)));let done=true;
        states.forEach((run,index)=>{runIdentity(run,children[index].runId,input.controllerSha);if(run.status!=='completed')done=false;});
        if(done)break;budget();await ports.sleep(Math.min(30000,deadline-ports.now()));
      }
      const values=await Promise.all(children.map(async child=>{const [jobs,artifacts]=await Promise.all([ports.getJobs(child.runId),ports.getArtifacts(child.runId)]);if(!Array.isArray(jobs)||!Array.isArray(artifacts)||jobs.length>10000||artifacts.length>10000)fail('ACCEPTANCE_IDENTITY');return {jobs,artifacts};}));
      budget();return values;
    }
    const children=await Promise.all((reuse?['formatter']:['feature','cleanup','formatter']).map(scope=>dispatch(scope)));
    const metadata=await completed(children),formatChild=children.at(-1),formatMeta=metadata.at(-1);
    const refs=reuse?[resolveScope('quick',formatChild,formatMeta,input.controllerSha),...reuse]:[resolveScope('quick',children[0],metadata[0],input.controllerSha),resolveScope('feature',children[0],metadata[0],input.controllerSha),...['full','config','build'].map(scope=>resolveScope(scope,children[1],metadata[1],input.controllerSha))];
    refs.push(resolveScope('formatter',formatChild,formatMeta,input.controllerSha));
    const formatterArtifact=chooseArtifact(formatMeta.artifacts,'codexs-formatter-dist-'+formatChild.label+'-'+formatChild.runId+'-1',formatChild.runId,input.controllerSha);
    const candidate={sha:input.candidateSha,upstream_sha:input.upstreamSha,version:input.sourceVersion},formatter={sha:input.formatterSha,version:input.formatterVersion};
    await ports.preBundle({candidate,formatter,runs:refs});budget();
    const bundle=await dispatch('bundle',{runs:refs,formatter_artifact:formatterArtifact}),[bundleMeta]=await completed([bundle]);
    refs.push(resolveScope('bundle',bundle,bundleMeta,input.controllerSha));
    const bundleArtifact=chooseArtifact(bundleMeta.artifacts,'codexs-bundle-draft-'+bundle.label+'-'+bundle.runId+'-1',bundle.runId,input.controllerSha,256*1024**2);
    const request={runs:refs,formatter_artifact:formatterArtifact,bundle_artifact:bundleArtifact};
    const final=await dispatch('evidence',request),[finalMeta]=await completed([final]),ref=resolveScope('evidence',final,finalMeta,input.controllerSha);
    const {scope,...locator}=ref;return {request,final:locator};
  }catch(error){boundedError(error,'ACCEPTANCE_IDENTITY');}
}

function createControllerPorts(options){
  const client=createControlClient(options),github=createGithubClient(options),clock=options.clock||{now:()=>Math.floor(performance.now()),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))},fork='/repos/TK-06/codexs';
  if(typeof clock.now!=='function'||typeof clock.sleep!=='function')fail('CONTROLLER_POLICY');
  async function collection(id,key){if(!positive(id))fail('ACCEPTANCE_IDENTITY');const all=[];let total;
    for(let page=1;page<=100;page++){const raw=(await client.json(fork+'/actions/runs/'+id+(key==='jobs'?'/attempts/1/jobs':'/artifacts')+'?per_page=100&page='+page)).value;
      if(!Array.isArray(raw?.[key])||raw[key].length>100||!Number.isSafeInteger(raw.total_count)||raw.total_count<0||raw.total_count>10000||total!==undefined&&raw.total_count!==total)fail('ACCEPTANCE_IDENTITY');
      total=raw.total_count;all.push(...raw[key]);if(all.length===total)return all;if(all.length>total||!raw[key].length)fail('ACCEPTANCE_IDENTITY');
    }fail('ACCEPTANCE_IDENTITY');
  }
  return {
    ...createDiscoveryPorts(client),now:()=>clock.now(),sleep:ms=>clock.sleep(ms),
    async dispatch({scope,inputs}){
      if(!['feature','cleanup','formatter','bundle','evidence'].includes(scope)||!inputs||Object.keys(inputs).some(key=>!['candidate_sha','baseline_sha','validation_id','formatter_sha','formatter_version','source_version','product_version','evidence_request'].includes(key)||typeof inputs[key]!=='string'||inputs[key].length>16384))fail('CONTROLLER_POLICY');
      fields(inputs,['candidate_sha','baseline_sha','validation_id','formatter_sha','formatter_version','source_version','product_version',...(['bundle','evidence'].includes(scope)?['evidence_request']:[])],'CONTROLLER_POLICY');
      if(![inputs.candidate_sha,inputs.baseline_sha,inputs.formatter_sha].every(value=>matches(value,SHA))||![inputs.source_version,inputs.formatter_version,inputs.product_version].every(validVersion)||! /^[a-z][a-z0-9-]{0,31}$/.test(inputs.validation_id))fail('CONTROLLER_POLICY');
      await client.main();let result;
      try{result=(await client.json(fork+'/actions/workflows/codexs-statusline.yml/dispatches',{method:'POST',body:{ref:'main',inputs:{...inputs,scope}}})).value;if(!positive(result?.workflow_run_id))fail('DISPATCH_UNCERTAIN');}
      catch{fail('DISPATCH_UNCERTAIN');}
      await client.main();return {runId:result.workflow_run_id};
    },
    getRun:id=>github.getRun(REPOSITORY,id,1),getJobs:id=>collection(id,'jobs'),getArtifacts:id=>collection(id,'artifacts'),
    preBundle:request=>collectPreBundleEvidence(request,github),
  };
}

module.exports = { verifyCandidate, loadCandidateProof, authorizeRun, prepareUpdate, PRODUCT_VERSION, runAcceptance, createControllerPorts };
