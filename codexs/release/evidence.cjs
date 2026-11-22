'use strict';

const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { TextDecoder } = require('node:util');
const { UpdateError, encodeRelease } = require('../update/protocol.cjs');

const SCOPES = ['quick', 'feature', 'full', 'config', 'build', 'formatter', 'bundle'];
const NATIVE = new Set(['feature', 'full', 'config', 'build']);
const SHA = /^[a-f0-9]{40}$/;
const JOBS = { quick:'Quick workflow and status-line formatting checks', formatter:'Pinned formatter acceptance', bundle:'Extracted Windows bundle acceptance' };
// Independently reviewed historical native jobs for the explicitly approved reuse.
// A locator cannot authorize its own controller revision.
const NATIVE_REUSE=[
  {scope:'feature',run:44904997566,attempt:1,job:136850076882,artifact:14710796318,controller_sha:'4afa8342f5457d130c1d528abf0882eb67234d28',validation_id:'task8g-alias'},
  ...[
    ['full',136172829353,14623551679],
    ['config',136172829371,14614442421],
    ['build',136172829406,14622732074],
  ].map(([scope,job,artifact])=>({scope,run:44701739542,attempt:1,job,artifact,controller_sha:'247935fa164114a89829ba8b228ab12dedc5110a',validation_id:'task7-autoload-cleanup-20261120',...(scope==='build'?{binary_artifact:14623201225}:{})})),
];
const fail = code => { throw new UpdateError(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lines = value => value.split(/\r*\n/).filter(line => line.length);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function fields(value, names, code = 'EVIDENCE_INPUT') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail(code);
}
function one(text, pattern) {
  const matches = lines(text).map(line => line.match(pattern)).filter(Boolean);
  if (matches.length !== 1) fail('EVIDENCE_OUTCOME');
  return matches[0];
}
function counts(passed, ignored = 0) {
  if (!Number.isSafeInteger(passed) || passed < 1 || !integer(ignored)) fail('EVIDENCE_OUTCOME');
  return { passed, failed:0, ignored, exit:0 };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// GitHub log artifacts have their own ZIP metadata. They are never extracted or executed.
// Bound decompression before parsing; the separately authenticated digest covers every byte.
function readArtifact(bytes,limits={archive:32*1024**2,file:32*1024**2,total:64*1024**2}) {
  const code = 'EVIDENCE_ARTIFACT';
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > limits.archive) fail(code);
    const end = bytes.length - 22;
    if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6) || bytes.readUInt16LE(end+20)) fail(code);
    const count = bytes.readUInt16LE(end+10), size = bytes.readUInt32LE(end+12), start = bytes.readUInt32LE(end+16);
    if (!count || count > 1024 || count !== bytes.readUInt16LE(end+8) || start + size !== end) fail(code);
    const result = new Map(), names = new Set(), regions = [];
    let cursor = start, total = 0;
    for (let index=0; index<count; index++) {
      if (cursor+46>end || bytes.readUInt32LE(cursor)!==0x02014b50) fail(code);
      const flags=bytes.readUInt16LE(cursor+8), method=bytes.readUInt16LE(cursor+10), crc=bytes.readUInt32LE(cursor+16);
      const compressed=bytes.readUInt32LE(cursor+20), expanded=bytes.readUInt32LE(cursor+24);
      const length=bytes.readUInt16LE(cursor+28), extra=bytes.readUInt16LE(cursor+30), comment=bytes.readUInt16LE(cursor+32), local=bytes.readUInt32LE(cursor+42);
      const attributes=bytes.readUInt32LE(cursor+38);
      if (flags & ~0x808 || ![0,8].includes(method) || !length || length>1024 || cursor+46+length+extra+comment>end || expanded>limits.file || bytes.readUInt16LE(cursor+34) || ((attributes>>>16)&0xf000)===0xa000 || attributes&0x400) fail(code);
      const rawName=bytes.subarray(cursor+46,cursor+46+length), name=new TextDecoder('utf-8',{fatal:true}).decode(rawName);
      if (/[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.replace(/\/$/,'').split('/').some(part=>!part||part==='.'||part==='..') || names.has(name.normalize('NFC').toLowerCase())) fail(code);
      names.add(name.normalize('NFC').toLowerCase());
      if (local+30>start || bytes.readUInt32LE(local)!==0x04034b50 || bytes.readUInt16LE(local+6)!==flags || bytes.readUInt16LE(local+8)!==method || bytes.readUInt16LE(local+26)!==length) fail(code);
      const dataStart=local+30+length+bytes.readUInt16LE(local+28), dataEnd=dataStart+compressed;
      if (dataEnd>start || !bytes.subarray(local+30,local+30+length).equals(rawName) || regions.some(([a,b])=>local<b&&dataEnd>a)) fail(code);
      regions.push([local,dataEnd]); total+=expanded;
      if (total>limits.total) fail(code);
      const source=bytes.subarray(dataStart,dataEnd), data=method===0?source:inflateRawSync(source,{maxOutputLength:Math.max(1,expanded)});
      if (data.length!==expanded || crc32(data)!==crc) fail(code);
      if (name.endsWith('/')) { if(expanded) fail(code); }
      else result.set(name,data);
      cursor+=46+length+extra+comment;
    }
    if (cursor!==end) fail(code);
    return result;
  } catch { fail(code); }
}

function text(files, name, max=4*1024**2) {
  const raw=files.get(name);
  if (!raw || raw.length>max) fail('EVIDENCE_OUTCOME');
  try { return new TextDecoder('utf-8',{fatal:true}).decode(raw).replace(/^\uFEFF/,''); }
  catch { fail('EVIDENCE_OUTCOME'); }
}
function json(files,name) {
  try {
    const source=text(files,name), stack=[];
    for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
      const token=match[0];
      if(token==='{'||token==='[')stack.push({object:token==='{',key:true,keys:new Set()});
      else if(token==='}'||token===']'){if(!stack.length)fail('EVIDENCE_OUTCOME');stack.pop();}
      else if(token===','){if(stack.at(-1)?.object)stack.at(-1).key=true;}
      else if(token.startsWith('"')&&stack.at(-1)?.object&&stack.at(-1).key){const key=JSON.parse(token),current=stack.at(-1);if(current.keys.has(key))fail('EVIDENCE_OUTCOME');current.keys.add(key);current.key=false;}
      if(stack.length>64)fail('EVIDENCE_OUTCOME');
    }
    if(stack.length)fail('EVIDENCE_OUTCOME');
    return JSON.parse(source);
  } catch { fail('EVIDENCE_OUTCOME'); }
}

function nativeOutcome(files, ref, candidate) {
  const outcome=one(text(files,'outcome.txt'),/^scope=([a-z-]+) source=([a-f0-9]{40}) native_exit=(\d+) passed=(\d+) failed=(\d+) ignored=(\d+) total=(\d+) guard_stop=([^ ]+) wrapper=(.*)$/);
  const [,scope,sha,exit,passed,failed,ignored,total,stop,wrapper]=outcome;
  const state=json(files,'guard-state.json');
  one(text(files,'setup.log'),new RegExp('^source='+candidate.sha+' scope='+ref.scope+' rust=.+ target=.+$'));
  if(scope!==ref.scope||sha!==candidate.sha||exit!=='0'||failed!=='0'||stop!=='none'||wrapper||text(files,'native-exit.txt').trim()!=='0'||state.source_sha!==candidate.sha||state.scope!==ref.scope||state.workspace_version!==candidate.version||Number(total)!==Number(passed)+Number(failed)+Number(ignored))fail('EVIDENCE_OUTCOME');
  const cargo=text(files,'cargo.log',32*1024**2);
  const command={
    build:'build --release --locked -p codex-cli --bin codex --timings',
    config:'test --release --locked -p codex-config --timings --no-fail-fast',
    feature:'test --release --locked -p codex-tui --config profile.release.package.codex-tui.opt-level=1 --timings --lib status_line_command',
    full:'test --release --locked -p codex-tui --config profile.release.package.codex-tui.opt-level=1 --timings --no-fail-fast -- --test-threads=1',
  }[scope];
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(lines(cargo).filter(line=>/^scope=.* native_command=/.test(line)).length!==1)fail('EVIDENCE_OUTCOME');
  one(cargo,new RegExp('^scope='+scope+' source='+candidate.sha+' rust=1\\.95\\.0 jobs=1 release=true locked=true lto=off debug=0 tui_opt='+(scope==='config'?'n/a':'1')+' native_command=.+[\\\\/]rustup\\.(?:exe|EXE) '+escape('run 1.95.0 cargo '+command)+'$'));
  if(scope==='build') {
    if(passed!=='0'||ignored!=='0'||total!=='0')fail('EVIDENCE_OUTCOME');
    one(cargo,/^\s*Finished `release` profile \[optimized\] target\(s\) in .+$/);
    one(cargo,new RegExp('^cli_version_exit=0 output=codex-cli '+candidate.version.replaceAll('.','\\.')+'$'));
    return {build_exit:0};
  }
  const summaries=lines(cargo).filter(line=>line.startsWith('test result:'));
  if(!summaries.length)fail('EVIDENCE_OUTCOME');
  let cargoPassed=0,cargoIgnored=0;
  for(const line of summaries) {
    const result=line.match(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in .+$/);
    if(!result||result[2]!=='0'||result[4]!=='0'||['full','config'].includes(scope)&&result[5]!=='0')fail('EVIDENCE_OUTCOME');
    cargoPassed+=Number(result[1]);cargoIgnored+=Number(result[3]);
    if(!integer(cargoPassed)||!integer(cargoIgnored))fail('EVIDENCE_OUTCOME');
  }
  if(cargoPassed!==Number(passed)||cargoIgnored!==Number(ignored))fail('EVIDENCE_OUTCOME');
  return {suites:{[scope]:counts(Number(passed),Number(ignored))}};
}

function assertions(source,label) {
  if(lines(source).filter(line=>line.startsWith(label+' assertions:')).length!==1)fail('EVIDENCE_OUTCOME');
  return counts(Number(one(source,new RegExp('^'+label+' assertions: ([1-9][0-9]*) passed; 0 failed$'))[1]));
}
function archiveIdentity(value,code) {
  fields(value,['bytes','sha256'],code);
  if(!integer(value.bytes)||value.bytes<1||value.bytes>256*1024**2||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))fail(code);
}
function validateBundleInputs(value,code) {
  fields(value,['pre_evidence_sha256','formatter_artifact'],code);
  if(typeof value.pre_evidence_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.pre_evidence_sha256))fail(code);
  fields(value.formatter_artifact,['repository','run','attempt','job','artifact'],code);
  if(value.formatter_artifact.repository!=='TK-06/codexs'||['run','attempt','job','artifact'].some(key=>!integer(value.formatter_artifact[key])||value.formatter_artifact[key]<1))fail(code);
}
function verifyUpload(log,artifact) {
  if(typeof log!=='string'||Buffer.byteLength(log)>16*1024**2)fail('EVIDENCE_JOB');
  const plain=log.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z /gm,'').replace(/\r/g,'');
  const action='##[group]Run actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f\n';
  const blocks=plain.split(/(?=^##\[group\]Run )/m).filter(block=>block.startsWith(action));
  const escaped=artifact.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const expected=[
    new RegExp('^  name: '+escaped+'$','m'),
    new RegExp('^SHA256 digest of uploaded artifact is '+artifact.digest.slice(7)+'$','m'),
    new RegExp('^Artifact '+escaped+' successfully finalized\\. Artifact ID '+artifact.id+'$','m'),
    new RegExp('^Artifact '+escaped+' has been successfully uploaded! Final size is '+artifact.size_in_bytes+' bytes\\. Artifact ID is '+artifact.id+'$','m'),
  ];
  if(blocks.filter(block=>expected.every(pattern=>pattern.test(block))).length!==1)fail('EVIDENCE_JOB');
}
function verifyArtifactMetadata(artifact,ref,name,maxBytes) {
  if(!artifact||artifact.id!==ref.artifact||artifact.name!==name||artifact.expired!==false||artifact.workflow_run?.id!==ref.run||artifact.workflow_run?.head_sha!==ref.controller_sha||typeof artifact.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)||!integer(artifact.size_in_bytes)||artifact.size_in_bytes<1||artifact.size_in_bytes>maxBytes)fail('EVIDENCE_ARTIFACT');
}
function suiteLogs(files,scope) {
  const suites={};
  if(scope==='quick') {
    const quick=text(files,'quick.log');
    if(lines(quick).filter(line=>line.startsWith('RESULT ')).length!==1)fail('EVIDENCE_OUTCOME');
    suites.quick=counts(Number(one(quick,/^RESULT passed=([1-9][0-9]*) failed=0$/)[1]));
    suites.installer=assertions(text(files,'installer.log'),'Installer');
    const updater=text(files,'updater.log',32*1024**2), passed=Number(one(updater,/^# pass ([1-9][0-9]*)$/)[1]);
    const tests=Number(one(updater,/^# tests ([1-9][0-9]*)$/)[1]), skipped=Number(one(updater,/^# skipped (\d+)$/)[1]);
    for(const field of ['tests','pass','fail','cancelled','skipped','todo']) {
      if(lines(updater).filter(line=>line.startsWith('# '+field+' ')).length!==1)fail('EVIDENCE_OUTCOME');
    }
    for(const field of ['fail','cancelled','todo'])one(updater,new RegExp('^# '+field+' 0$'));
    one(updater,/^# codexs verified suites ([1-9][0-9]*)$/);
    if(tests!==passed+skipped)fail('EVIDENCE_OUTCOME');
    const powershell=['Archive','Coordinator','Enrollment'].map(label=>assertions(updater,label).passed);
    suites.updater=counts(passed+powershell.reduce((a,b)=>a+b,0),skipped);
  } else if(scope==='formatter') {
    const source=text(files,'tests.log',32*1024**2), passed=Number(one(source,/^\s*(\d+) pass$/)[1]);
    const skips=lines(source).map(line=>line.match(/^\s*(\d+) skip$/)).filter(Boolean);
    if(skips.length>1)fail('EVIDENCE_OUTCOME');
    const ignored=skips.length?Number(skips[0][1]):0;
    one(source,/^\s*0 fail$/);
    const total=one(source,/^Ran (\d+) tests? across ([1-9][0-9]*) files?\. \[.+\]$/);
    if(Number(total[1])!==passed+ignored)fail('EVIDENCE_OUTCOME');
    suites.formatter=counts(passed,ignored);
    const checks=text(files,'checks.log'); one(checks,/^lint_exit=0$/);one(checks,/^build_exit=0$/);
  } else {
    suites.bundle=assertions(text(files,'bundle.log'),'Bundle');
  }
  return suites;
}
function receiptOutcome(files, ref, candidate, formatter) {
  const receipt=json(files,'acceptance.json');
  fields(receipt,['schema','scope','candidate_sha','upstream_sha','formatter_sha','controller_sha','suites','build_exit',...(ref.scope==='bundle'?['archive','inputs']:[])],'EVIDENCE_OUTCOME');
  if(receipt.schema!==1||receipt.scope!==ref.scope||receipt.candidate_sha!==candidate.sha||receipt.upstream_sha!==candidate.upstream_sha||receipt.formatter_sha!==formatter.sha||receipt.controller_sha!==ref.controller_sha||receipt.build_exit!==null)fail('EVIDENCE_OUTCOME');
  const suites=suiteLogs(files,ref.scope);
  if(ref.scope==='bundle'){archiveIdentity(receipt.archive,'EVIDENCE_OUTCOME');validateBundleInputs(receipt.inputs,'EVIDENCE_OUTCOME');if(receipt.archive.bytes!==candidate.archive.bytes||receipt.archive.sha256!==candidate.archive.sha256)fail('EVIDENCE_OUTCOME');}
  fields(receipt.suites,Object.keys(suites),'EVIDENCE_OUTCOME');
  for(const [name,expected]of Object.entries(suites)) {
    fields(receipt.suites[name],['passed','failed','ignored','exit'],'EVIDENCE_OUTCOME');
    if(Object.keys(expected).some(key=>receipt.suites[name][key]!==expected[key]))fail('EVIDENCE_OUTCOME');
  }
  return {suites,...(ref.scope==='bundle'?{inputs:receipt.inputs}:{})};
}

function validateSources(candidate,formatter,needArchive) {
    fields(candidate,['sha','upstream_sha','version',...(candidate&&Object.hasOwn(candidate,'archive')?['archive']:[])]);fields(formatter,['sha','version']);
    if(![candidate.sha,candidate.upstream_sha,formatter.sha].every(value=>typeof value==='string'&&SHA.test(value))||![candidate.version,formatter.version].every(v=>typeof v==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)&&v.split('.').every(part=>Number.isSafeInteger(Number(part)))))fail('EVIDENCE_INPUT');
    if(needArchive||Object.hasOwn(candidate,'archive'))archiveIdentity(candidate.archive,'EVIDENCE_INPUT');
}
function createAcceptanceReceipt(input) {
  fields(input,['scope','candidate','formatter','controller_sha','files',...(input?.scope==='bundle'?['bundleInputs']:[])]);
  const {scope,candidate,formatter,controller_sha,files}=input;
  if(!['quick','formatter','bundle'].includes(scope)||typeof controller_sha!=='string'||!SHA.test(controller_sha)||!(files instanceof Map))fail('EVIDENCE_INPUT');
  validateSources(candidate,formatter,scope==='bundle');
  const receipt={schema:1,scope,candidate_sha:candidate.sha,upstream_sha:candidate.upstream_sha,formatter_sha:formatter.sha,controller_sha,suites:suiteLogs(files,scope),build_exit:null};
  if(scope==='bundle'){validateBundleInputs(input.bundleInputs,'EVIDENCE_INPUT');receipt.archive={...candidate.archive};receipt.inputs=structuredClone(input.bundleInputs);}
  return receipt;
}

async function verifiedJob(ref,github) {
  if(typeof github.controllerSha!=='string'||!SHA.test(github.controllerSha))fail('EVIDENCE_TRUST');
  if(ref.controller_sha!==github.controllerSha&&!NATIVE_REUSE.some(approved=>Object.entries(approved).every(([key,value])=>ref[key]===value)))fail('EVIDENCE_TRUST');
  const run=await github.getRun(ref.repository,ref.run,ref.attempt),job=await github.getJob(ref.repository,ref.job);
  if(!run||run.id!==ref.run||run.run_attempt!==ref.attempt||run.status!=='completed'||run.conclusion!=='success'||run.head_sha!==ref.controller_sha||run.path!=='.github/workflows/codexs-statusline.yml'||run.repository?.full_name!==ref.repository||!['workflow_dispatch','workflow_call'].includes(run.event))fail('EVIDENCE_RUN');
  const native=NATIVE.has(ref.scope),step=native?'Run guarded native Cargo operation':'Record complete acceptance';
  if(!job||job.id!==ref.job||job.run_id!==ref.run||job.run_attempt!==ref.attempt||job.head_sha!==ref.controller_sha||job.status!=='completed'||job.conclusion!=='success'||job.name!==(native?`Windows (${ref.scope})`:JOBS[ref.scope])||!Array.isArray(job.steps)||job.steps.filter(item=>item.name===step&&item.status==='completed'&&item.conclusion==='success').length!==1)fail('EVIDENCE_JOB');
}

async function downloadDistributionArtifact(input,github) {
  try {
    fields(input,['ref','kind','artifact']);const {ref,kind,artifact:id}=input;
    const scopes={native:'build',formatter:'formatter',bundle:'bundle'},prefixes={native:'codexs-cli',formatter:'codexs-formatter-dist',bundle:'codexs-bundle-draft'};
    if(!Object.hasOwn(scopes,kind)||!ref||ref.scope!==scopes[kind])fail('EVIDENCE_INPUT');
    fields(ref,['scope','repository','run','attempt','job','artifact','controller_sha','validation_id',...(kind==='native'?['binary_artifact']:[])]);
    if(ref.repository!=='TK-06/codexs'||typeof ref.controller_sha!=='string'||!SHA.test(ref.controller_sha)||typeof ref.validation_id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(ref.validation_id)||['run','attempt','job','artifact'].some(key=>!integer(ref[key])||ref[key]<1)||!integer(id)||id<1||id===ref.artifact||kind==='native'&&id!==ref.binary_artifact||!github||['getRun','getJob','getArtifact','getJobLog','downloadArtifact'].some(key=>typeof github[key]!=='function'))fail('EVIDENCE_INPUT');
    await verifiedJob(ref,github);
    const max=kind==='formatter'?32*1024**2:256*1024**2,artifact=await github.getArtifact(ref.repository,id);
    verifyArtifactMetadata(artifact,{...ref,artifact:id},`${prefixes[kind]}-${ref.validation_id}-${ref.run}-${ref.attempt}`,max);
    verifyUpload(await github.getJobLog(ref.repository,ref.job),artifact);
    const bytes=await github.downloadArtifact(ref.repository,id,{maxBytes:max});
    if(!Buffer.isBuffer(bytes)||bytes.length!==artifact.size_in_bytes||sha256(bytes)!==artifact.digest.slice(7))fail('EVIDENCE_ARTIFACT');
    const files=readArtifact(bytes,{archive:max,file:kind==='native'?512*1024**2:max,total:512*1024**2});
    const names=[...files.keys()];
    if(kind==='native'&&(names.length!==1||names[0]!=='codex.exe'))fail('EVIDENCE_ARTIFACT');
    if(kind==='formatter'&&(!['package.json','LICENSE','dist/ccstatusline.js'].every(name=>files.has(name))||names.some(name=>!['package.json','LICENSE'].includes(name)&&!name.startsWith('dist/'))))fail('EVIDENCE_ARTIFACT');
    if(kind==='bundle'&&(names.length!==4||!['codexs-windows-x64.zip','manifest-base.json','codexs-enrollment.zip','enrollment.json'].every(name=>files.has(name))))fail('EVIDENCE_ARTIFACT');
    return files;
  }catch(error){if(error instanceof UpdateError)throw error;fail('EVIDENCE_IO');}
}

async function collect(input,github,pre) {
  try {
    fields(input,['candidate','formatter','runs']);
    const {candidate,formatter,runs}=input;
    validateSources(candidate,formatter,!pre);
    const scopes=SCOPES.filter(scope=>!pre||scope!=='bundle');
    if(!Array.isArray(runs)||runs.length>SCOPES.length)fail('EVIDENCE_INPUT');
    const seen=new Set();
    for(const ref of runs) {
      fields(ref,['scope','repository','run','attempt','job','artifact','controller_sha','validation_id',...(ref.scope==='build'?['binary_artifact']:[])]);
      if(!scopes.includes(ref.scope)||seen.has(ref.scope)||ref.repository!=='TK-06/codexs'||typeof ref.controller_sha!=='string'||!SHA.test(ref.controller_sha)||typeof ref.validation_id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(ref.validation_id)||['run','attempt','job','artifact'].some(key=>!integer(ref[key])||!ref[key]))fail('EVIDENCE_INPUT');
      if(ref.scope==='build'&&(!integer(ref.binary_artifact)||ref.binary_artifact<1||ref.binary_artifact===ref.artifact))fail('EVIDENCE_INPUT');
      seen.add(ref.scope);
    }
    if(scopes.some(scope=>!seen.has(scope)))fail('EVIDENCE_INCOMPLETE');
    if(!github||['getRun','getJob','getArtifact','getJobLog','downloadArtifact'].some(key=>typeof github[key]!=='function'))fail('EVIDENCE_INPUT');
    const suites={}, references=[];let buildExit,bundleInputs;
    for(const scope of scopes) {
      const ref=runs.find(item=>item.scope===scope);
      await verifiedJob(ref,github);
      const artifact=await github.getArtifact(ref.repository,ref.artifact),native=NATIVE.has(scope);
      const name=`${native?'codexs-statusline':'codexs-task9'}-${scope}-${ref.validation_id}-${ref.run}-${ref.attempt}`;
      verifyArtifactMetadata(artifact,ref,name,32*1024**2);
      const jobLog=await github.getJobLog(ref.repository,ref.job);
      verifyUpload(jobLog,artifact);
      const bytes=await github.downloadArtifact(ref.repository,ref.artifact);
      if(!Buffer.isBuffer(bytes)||bytes.length!==artifact.size_in_bytes||sha256(bytes)!==artifact.digest.slice(7))fail('EVIDENCE_ARTIFACT');
      const files=readArtifact(bytes), outcome=native?nativeOutcome(files,ref,candidate):receiptOutcome(files,ref,candidate,formatter);
      if(outcome.suites)Object.assign(suites,outcome.suites);
      if(scope==='bundle')bundleInputs=outcome.inputs;
      if(outcome.build_exit===0)buildExit=0;
      references.push({repository:ref.repository,run:ref.run,attempt:ref.attempt,job:ref.job,artifact:ref.artifact});
      if(scope==='build') {
        const binaryRef={...ref,artifact:ref.binary_artifact},binary=await github.getArtifact(ref.repository,ref.binary_artifact);
        verifyArtifactMetadata(binary,binaryRef,`codexs-cli-${ref.validation_id}-${ref.run}-${ref.attempt}`,256*1024**2);
        verifyUpload(jobLog,binary);
        references.push({repository:ref.repository,run:ref.run,attempt:ref.attempt,job:ref.job,artifact:ref.binary_artifact});
      }
    }
    if(buildExit!==0)fail('EVIDENCE_INCOMPLETE');
    if(!pre) {
      const bundle=runs.find(ref=>ref.scope==='bundle'),formatterRun=runs.find(ref=>ref.scope==='formatter');
      const preEvidence={candidate_sha:candidate.sha,upstream_sha:candidate.upstream_sha,formatter_sha:formatter.sha,runs:references.filter(ref=>ref.artifact!==bundle.artifact),suites:Object.fromEntries(Object.entries(suites).filter(([scope])=>scope!=='bundle')),build_exit:0};
      if(sha256(encodeRelease(preEvidence))!==bundleInputs.pre_evidence_sha256)fail('EVIDENCE_BINDING');
      const bound=bundleInputs.formatter_artifact;
      if(['repository','run','attempt','job'].some(key=>bound[key]!==formatterRun[key])||bound.artifact===formatterRun.artifact)fail('EVIDENCE_BINDING');
      await downloadDistributionArtifact({ref:formatterRun,kind:'formatter',artifact:bound.artifact},github);
      references.push({...bound});
    }
    return {candidate_sha:candidate.sha,upstream_sha:candidate.upstream_sha,formatter_sha:formatter.sha,runs:references,suites,build_exit:buildExit};
  } catch(error) {
    if(error instanceof UpdateError)throw error;
    fail('EVIDENCE_IO');
  }
}

const collectEvidence=(input,github)=>collect(input,github,false);
const collectPreBundleEvidence=(input,github)=>collect(input,github,true);

function createGithubClient(options) {
  if(!options||typeof options.token!=='string'||! /^[\x21-\x7e]{1,512}$/.test(options.token)||options.fetch!==undefined&&typeof options.fetch!=='function')fail('EVIDENCE_INPUT');
  if(options.controllerSha!==undefined&&(typeof options.controllerSha!=='string'||!SHA.test(options.controllerSha)))fail('EVIDENCE_INPUT');
  const request=options.fetch||globalThis.fetch;
  function route(repository,id,suffix) {
    if(repository!=='TK-06/codexs'||!Number.isSafeInteger(id)||id<1)fail('EVIDENCE_INPUT');
    return 'https://api.github.com/repos/TK-06/codexs/actions/'+suffix(id);
  }
  async function read(url,max,redirects=false) {
    try {
      const signal=AbortSignal.timeout(15000);let current=url,api=true;
      for(let hops=0;hops<3;hops++) {
        const headers=api?{Accept:'application/vnd.github+json',Authorization:'Bearer '+options.token,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'codexs-release-evidence'}:{'User-Agent':'codexs-release-evidence'};
        const response=await request(current,{method:'GET',headers,redirect:'manual',credentials:'omit',signal});
        if([301,302,303,307,308].includes(response.status)) {
          if(!redirects)fail('EVIDENCE_HTTP');
          const location=response.headers.get('location');
          if(!location||location.length>8192)fail('EVIDENCE_HTTP');
          const next=new URL(location);
          if(next.protocol!=='https:'||next.username||next.password||next.port||next.hash||!( /^productionresults[a-z0-9]+\.blob\.core\.windows\.net$/.test(next.hostname)||next.hostname==='pipelines.actions.githubusercontent.com'))fail('EVIDENCE_HTTP');
          if(response.body)await response.body.cancel();
          current=next.href;api=false;continue;
        }
        if(response.status!==200||!response.body)fail('EVIDENCE_HTTP');
        const length=response.headers.get('content-length');
        if(length!==null&&(!/^(0|[1-9]\d*)$/.test(length)||Number(length)>max))fail('EVIDENCE_HTTP');
        const chunks=[];let total=0;
        for await(const part of response.body){const bytes=Buffer.from(part);total+=bytes.length;if(total>max)fail('EVIDENCE_HTTP');chunks.push(bytes);}
        return Buffer.concat(chunks,total);
      }
      fail('EVIDENCE_HTTP');
    } catch {fail('EVIDENCE_HTTP');}
  }
  async function metadata(url) {
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(url,2*1024**2)));}
    catch{fail('EVIDENCE_HTTP');}
  }
  return {
    controllerSha:options.controllerSha,
    async getRun(repository,id,attempt){if(!Number.isSafeInteger(attempt)||attempt<1)fail('EVIDENCE_INPUT');return metadata(route(repository,id,value=>`runs/${value}/attempts/${attempt}`));},
    async getJob(repository,id){return metadata(route(repository,id,value=>`jobs/${value}`));},
    async getArtifact(repository,id){return metadata(route(repository,id,value=>`artifacts/${value}`));},
    async downloadArtifact(repository,id,limits){
      let max=32*1024**2;
      if(limits!==undefined){fields(limits,['maxBytes']);if(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1||limits.maxBytes>256*1024**2)fail('EVIDENCE_INPUT');max=limits.maxBytes;}
      return read(route(repository,id,value=>`artifacts/${value}/zip`),max,true);
    },
    async getJobLog(repository,id){const raw=await read(route(repository,id,value=>`jobs/${value}/logs`),16*1024**2,true);try{return new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('EVIDENCE_HTTP');}},
  };
}
module.exports={collectEvidence,collectPreBundleEvidence,createGithubClient,createAcceptanceReceipt,downloadDistributionArtifact};
