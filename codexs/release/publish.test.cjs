'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, generateKeyPairSync, sign, verify } = require('node:crypto');
const { releaseManifest, fixtureTempRoot, upstreamPackages } = require('../test-support/update-fixtures.cjs');
const { encodeRelease, verifyRelease } = require('../update/protocol.cjs');

const api = () => require('./publish.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const tag = sequence => 'codexs-v1.0.0-codex0.166.0-r'+sequence;
const assetNames = ['release.json','release.sig','codexs-windows-x64.zip','codexs-enrollment.zip','enrollment.json'];

async function publisherFixture(t) {
  const parent=fixtureTempRoot(),root=await fs.mkdtemp(path.join(parent,'codexs-publisher-test-'));
  t.after(async()=>{if(await fs.realpath(root)!==root||path.dirname(root)!==parent||!path.basename(root).startsWith('codexs-publisher-test-'))throw Error('Unsafe publisher fixture cleanup');await fs.rm(root,{recursive:true,maxRetries:10,retryDelay:100});});
  const release=releaseManifest(),evidence=release.evidence,base=structuredClone(release);
  delete base.sequence;delete base.release_id;delete base.evidence;
  const archive=Buffer.from('synthetic accepted payload, never executed'),enrollment=Buffer.from('synthetic enrollment archive');
  base.archive={name:'codexs-windows-x64.zip',bytes:archive.length,sha256:digest(archive)};
  const enrollmentMetadata={controller_sha:base.overlay_sha,files:[{path:'update/bootstrap.cjs',bytes:1,sha256:'e'.repeat(64)}],bytes:enrollment.length,sha256:digest(enrollment)};
  const bundle={archivePath:path.join(root,'codexs-windows-x64.zip'),manifestBase:base};
  await fs.writeFile(bundle.archivePath,archive);await fs.writeFile(path.join(root,'codexs-enrollment.zip'),enrollment);await fs.writeFile(path.join(root,'enrollment.json'),encodeRelease(enrollmentMetadata));
  const keys=generateKeyPairSync('ed25519'),events=[],assets=new Map(),signRequests=[];
  const readyUpstream=structuredClone(base.upstream),readyPackages=structuredClone(base.packages);
  const state={releases:[{id:80,tag:tag(8),draft:false,prerelease:false,body:'codexs-publish-v1\nidentity_sha256='+'0'.repeat(64),assets:[]}],tags:[{tag:tag(7),sha:base.overlay_sha}]};
  let nextAsset=201;
  const ports={controllerSha:base.overlay_sha,publicKey:keys.publicKey,
    async listReleases(){events.push('inventory');return structuredClone(state);},
    async createDraft({tag,body}){events.push('create');const result={id:91,tag,body,draft:true,prerelease:false,assets:[]};state.releases.push(result);state.tags.push({tag,sha:base.overlay_sha});return structuredClone(result);},
    async upload({releaseId,name,bytes,contentType}){events.push('upload:'+name);assert.ok(assetNames.includes(name));assert.ok(Buffer.isBuffer(bytes));assert.ok(typeof contentType==='string');const release=state.releases.find(item=>item.id===releaseId);assert.ok(release);assert.equal(release.assets.some(asset=>asset.name===name),false,'publisher overwrote an existing name');const result={id:nextAsset++,name,size:bytes.length};release.assets.push(result);assets.set(result.id,Buffer.from(bytes));return {...result};},
    async readAsset(source){
      if(source.kind==='local'){const resolved=path.resolve(source.path);if(path.dirname(resolved)!==root)throw Object.assign(Error('synthetic path rejection'),{code:'PUBLISH_ARCHIVE'});return fs.readFile(resolved);}
      events.push('read:'+source.name);const release=state.releases.find(item=>item.id===source.releaseId);const asset=release?.assets.find(item=>item.id===source.assetId&&item.name===source.name);assert.ok(asset,'unknown release asset');return Buffer.from(assets.get(asset.id));
    },
    async makeStable({releaseId}){events.push('stable');const result=state.releases.find(item=>item.id===releaseId);assert.ok(result);result.draft=false;return structuredClone(result);},
    async sign(keyRef,bytes){events.push('sign');assert.equal(keyRef,'CODEXS_RELEASE_SIGNING_KEY');signRequests.push(Buffer.from(bytes));return sign(null,bytes,keys.privateKey);},
    async latestUpstream(){events.push('latest');return {...structuredClone(readyUpstream),packages:structuredClone(readyPackages)};},
  };
  const input={bundle,evidence,keyRef:'CODEXS_RELEASE_SIGNING_KEY'};
  function uploaded(name){const release=state.releases.find(item=>item.id===91),asset=release?.assets.find(item=>item.name===name);return asset?assets.get(asset.id):null;}
  return {root,input,ports,keys,events,state,assets,signRequests,uploaded,archive,enrollment};
}

test('task10 publisher: signs exact accepted bytes and promotes only after every readback',async t=>{
  const f=await publisherFixture(t),result=await api().publishStable(f.input,f.ports);
  assert.deepEqual(result,{tag:tag(9),sequence:9,releaseId:91});
  const manifest=f.uploaded('release.json'),signature=f.uploaded('release.sig');
  assert.equal(signature.length,64);assert.equal(verify(null,Buffer.concat([Buffer.from('codexs-release-v1\0'),manifest]),f.keys.publicKey,signature),true);
  const decoded=verifyRelease(manifest,signature,f.keys.publicKey,{nodeMajor:22});
  assert.equal(decoded.release_id,tag(9));assert.equal(decoded.sequence,9);assert.deepEqual(decoded.evidence,f.input.evidence);
  assert.equal(decoded.archive.sha256,digest(f.uploaded('codexs-windows-x64.zip')));assert.deepEqual(f.uploaded('codexs-windows-x64.zip'),f.archive);
  for(const name of assetNames)assert.ok(f.events.indexOf('read:'+name)<f.events.indexOf('stable'));
  assert.ok(f.events.indexOf('sign')<f.events.indexOf('create'));assert.equal(f.events.at(-1),'stable');
});

for(const suite of ['quick','feature','full','config','formatter','updater','installer','bundle'])for(const [kind,mutate]of [
  ['missing',e=>{delete e.suites[suite];}],['empty',e=>{e.suites[suite].passed=0;}],['failed',e=>{e.suites[suite].failed=1;}],['nonzero',e=>{e.suites[suite].exit=1;}],
])test('task10 publisher: rejects '+kind+' '+suite+' before signing or draft creation',async t=>{
  const f=await publisherFixture(t);mutate(f.input.evidence);
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'MANIFEST_SCHEMA'});
  assert.equal(f.signRequests.length,0);assert.equal(f.events.includes('create'),false);assert.equal(f.events.includes('stable'),false);
});

for(const [kind,mutate]of [
  ['candidate evidence',f=>{f.input.evidence.candidate_sha='e'.repeat(40);}],
  ['upstream evidence',f=>{f.input.evidence.upstream_sha='e'.repeat(40);}],
  ['formatter evidence',f=>{f.input.evidence.formatter_sha='e'.repeat(40);}],
  ['unknown manifest field',f=>{f.input.bundle.manifestBase.command='synthetic-untrusted-command';}],
  ['failed build',f=>{f.input.evidence.build_exit=1;}],
  ['Node incompatibility',f=>{f.input.bundle.manifestBase.node_min=23;}],
  ['missing upstream',f=>{delete f.input.bundle.manifestBase.upstream;}],
  ['missing formatter',f=>{delete f.input.bundle.manifestBase.formatter;}],
  ['missing archive',f=>{delete f.input.bundle.manifestBase.archive;}],
  ['missing inventory',f=>{delete f.input.bundle.manifestBase.files;}],
  ['missing packages',f=>{delete f.input.bundle.manifestBase.packages;}],
])test('task10 publisher: rejects '+kind+' before signing',async t=>{
  const f=await publisherFixture(t);mutate(f);
  await assert.rejects(api().publishStable(f.input,f.ports),{code:kind==='Node incompatibility'?'COMPATIBILITY':'MANIFEST_SCHEMA'});assert.equal(f.signRequests.length,0);assert.equal(f.events.includes('create'),false);
});

test('task10 publisher: rejects a changed archive before signing',async t=>{
  const f=await publisherFixture(t);await fs.writeFile(f.input.bundle.archivePath,'synthetic corrupted archive');
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_ARCHIVE'});assert.equal(f.signRequests.length,0);assert.equal(f.events.includes('create'),false);
});

test('task10 publisher: snapshots caller metadata before asynchronous ports can mutate it',async t=>{
  const f=await publisherFixture(t),original=f.ports.listReleases;
  f.ports.listReleases=async()=>{f.input.bundle.manifestBase.upstream.sha='e'.repeat(40);f.input.evidence.upstream_sha='e'.repeat(40);return original();};
  await api().publishStable(f.input,f.ports);
  assert.equal(JSON.parse(f.uploaded('release.json')).upstream.sha,'a'.repeat(40));
});

test('task10 publisher: reserves every orphan and historical sequence beyond one page',async t=>{
  const f=await publisherFixture(t);for(let n=10;n<=150;n++)f.state.tags.push({tag:tag(n),sha:f.ports.controllerSha});
  assert.deepEqual(await api().publishStable(f.input,f.ports),{tag:tag(151),sequence:151,releaseId:91});
});

for(const invalid of [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1])test('task10 publisher: rejects exhausted or unsafe reserved sequence '+invalid,async t=>{
  const f=await publisherFixture(t);f.state.tags.push({tag:tag(invalid),sha:f.ports.controllerSha});
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_SEQUENCE'});assert.equal(f.signRequests.length,0);assert.equal(f.events.includes('create'),false);
});

test('task10 publisher: rejects a malformed reserved product tag instead of reusing its counter',async t=>{
  const f=await publisherFixture(t);f.state.tags.push({tag:'codexs-v1.0.0-codex0.166.0-r01',sha:f.ports.controllerSha});
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_SEQUENCE'});assert.equal(f.signRequests.length,0);
});

for(const when of [1,2])for(const change of ['newer version','retag'])test('task10 publisher: rejects '+change+' at upstream check '+when,async t=>{
  const f=await publisherFixture(t),original=f.ports.latestUpstream;let calls=0;
  f.ports.latestUpstream=async()=>{const current=await original();if(++calls===when){if(change==='retag')current.sha='e'.repeat(40);else{current.version='0.167.0';current.tag='rust-v0.167.0';}}return current;};
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_SUPERSEDED'});assert.equal(f.events.includes('stable'),false);if(when===1)assert.equal(f.signRequests.length,0);
});

test('task10 publisher: blocks publication when stable upstream discovery is pending',async t=>{
  const f=await publisherFixture(t);f.ports.latestUpstream=async()=>null;
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_SUPERSEDED'});assert.equal(f.signRequests.length,0);
});

for(const after of [0,1,2,3,4])test('task10 publisher: identical retry resumes after '+after+' uploaded assets without overwriting',async t=>{
  const f=await publisherFixture(t),upload=f.ports.upload;let count=0;
  f.ports.upload=async request=>{if(count++===after)throw Error('synthetic interrupted upload');return upload(request);};
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_NETWORK'});assert.equal(f.events.includes('stable'),false);
  f.ports.upload=upload;assert.deepEqual(await api().publishStable(f.input,f.ports),{tag:tag(9),sequence:9,releaseId:91});
  assert.equal(f.events.filter(value=>value==='create').length,1);for(const name of assetNames)assert.equal(f.events.filter(value=>value==='upload:'+name).length,1);
});

test('task10 publisher: a lost upload response is resolved by reading existing identical bytes on retry',async t=>{
  const f=await publisherFixture(t),upload=f.ports.upload;let once=true;
  f.ports.upload=async request=>{const result=await upload(request);if(once){once=false;throw Error('synthetic response lost');}return result;};
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_NETWORK'});
  await api().publishStable(f.input,f.ports);for(const name of assetNames)assert.equal(f.events.filter(value=>value==='upload:'+name).length,1);
});

test('task10 publisher: identical published retry returns its identity without signing or promoting again',async t=>{
  const f=await publisherFixture(t);await api().publishStable(f.input,f.ports);const signed=f.signRequests.length;f.events.length=0;
  assert.deepEqual(await api().publishStable(f.input,f.ports),{tag:tag(9),sequence:9,releaseId:91});assert.equal(f.signRequests.length,signed);
  assert.equal(f.events.includes('create'),false);assert.equal(f.events.includes('stable'),false);assert.equal(f.events.some(value=>value.startsWith('upload:')),false);
});

test('task10 publisher: duplicate published identities cannot select an arbitrary release',async t=>{
  const f=await publisherFixture(t);await api().publishStable(f.input,f.ports);
  const existing=f.state.releases.find(item=>item.id===91);
  f.state.releases.push({id:92,tag:tag(10),draft:true,prerelease:false,body:existing.body,assets:[]});f.events.length=0;
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_IMMUTABLE'});
  assert.equal(f.events.includes('stable'),false);assert.equal(f.events.includes('create'),false);
});

test('task10 publisher: a changed existing asset blocks retry and stays untouched',async t=>{
  const f=await publisherFixture(t),upload=f.ports.upload;let count=0;
  f.ports.upload=async request=>{if(count++===2)throw Error('synthetic interrupted upload');return upload(request);};
  await assert.rejects(api().publishStable(f.input,f.ports));f.ports.upload=upload;
  const draft=f.state.releases.find(item=>item.id===91),asset=draft.assets[0];f.assets.set(asset.id,Buffer.from('synthetic changed existing asset'));f.events.length=0;
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_IMMUTABLE'});assert.equal(f.events.includes('stable'),false);assert.equal(f.events.some(value=>value.startsWith('upload:')),false);
  assert.equal(f.assets.get(asset.id).toString(),'synthetic changed existing asset');
});

test('task10 publisher: failed readback prevents stable promotion and leaves a draft',async t=>{
  const f=await publisherFixture(t),read=f.ports.readAsset;
  f.ports.readAsset=async source=>source.kind==='release'?Buffer.from('synthetic bad readback'):read(source);
  await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_IMMUTABLE'});assert.equal(f.events.includes('stable'),false);assert.equal(f.state.releases.find(item=>item.id===91).draft,true);
});

test('task10 publisher: malformed signature output or a wrong key cannot become a public asset',async t=>{
  for(const badSign of [async()=>Buffer.alloc(65),async(_ref,bytes)=>sign(null,bytes,generateKeyPairSync('ed25519').privateKey)]){
    const f=await publisherFixture(t);f.ports.sign=badSign;
    await assert.rejects(api().publishStable(f.input,f.ports),{code:'PUBLISH_KEY'});assert.equal(f.events.includes('create'),false);assert.equal(f.events.includes('stable'),false);
  }
});

function discoveryFixture() {
  const packages=upstreamPackages(),calls=[];
  const ports={
    async listUpstreamReleases({page,perPage}){calls.push(['list',page,perPage]);return {releases:page===1?[{tag_name:'rust-v0.166.0',draft:false,prerelease:false}]:[],hasNext:false};},
    async resolveTag(value){calls.push(['tag',value]);return 'a'.repeat(40);},
    async getPackage(value){calls.push(['package',value]);return structuredClone(value.endsWith('-win32-x64')?packages.helper:packages.main);},
  };
  return {ports,calls,packages};
}

test('task10 ports: discovery resolves the numeric newest stable tag and exact packages',async()=>{
  const f=discoveryFixture();f.ports.listUpstreamReleases=async()=>({releases:[{tag_name:'rust-v0.9.0',draft:false,prerelease:false},{tag_name:'rust-v9.0.0',draft:false,prerelease:true},{tag_name:'rust-v8.0.0',draft:true,prerelease:false},{tag_name:'rust-v0.166.0',draft:false,prerelease:false}],hasNext:false});
  const result=await api().discoverUpstream(f.ports);
  assert.equal(result.version,'0.166.0');assert.equal(result.sha,'a'.repeat(40));assert.equal(result.packages.helper.version,'0.166.0-win32-x64');
  assert.deepEqual(f.calls,[['tag','rust-v0.166.0'],['package','0.166.0'],['package','0.166.0-win32-x64']]);
});

test('task10 ports: discovery reads subsequent release pages before choosing a version',async()=>{
  const f=discoveryFixture();f.ports.listUpstreamReleases=async({page})=>({releases:[{tag_name:page===1?'rust-v0.9.0':'rust-v0.166.0',draft:false,prerelease:false}],hasNext:page===1});
  assert.equal((await api().discoverUpstream(f.ports)).version,'0.166.0');
});

for(const missing of ['main','helper'])test('task10 ports: missing '+missing+' package defers discovery',async()=>{
  const f=discoveryFixture(),get=f.ports.getPackage;f.ports.getPackage=version=>(missing==='helper')===version.endsWith('-win32-x64')?null:get(version);
  assert.equal(await api().discoverUpstream(f.ports),null);
});

test('task10 ports: no stable release defers discovery without registry work',async()=>{
  const f=discoveryFixture();f.ports.listUpstreamReleases=async()=>({releases:[{tag_name:'rust-v0.167.0-beta.1',draft:false,prerelease:true}],hasNext:false});
  assert.equal(await api().discoverUpstream(f.ports),null);assert.equal(f.calls.length,0);
});

for(const [name,change,code]of [
  ['malformed stable version',f=>{f.ports.listUpstreamReleases=async()=>({releases:[{tag_name:'rust-v01.0.0',draft:false,prerelease:false}],hasNext:false});},'UPSTREAM_IDENTITY'],
  ['invalid integrity',f=>{f.packages.main.dist.integrity='sha512-short';},'PACKAGE_INTEGRITY'],
  ['platform layout',f=>{f.packages.helper.cpu=['arm64'];},'PACKAGE_LAYOUT'],
  ['moving tag response',f=>{f.ports.resolveTag=async()=> 'main';},'UPSTREAM_IDENTITY'],
  ['incomplete pagination',f=>{f.ports.listUpstreamReleases=async()=>({releases:[],hasNext:true});},'UPSTREAM_IDENTITY'],
])test('task10 ports: discovery rejects '+name,async()=>{
  const f=discoveryFixture();change(f);await assert.rejects(api().discoverUpstream(f.ports),{code});
});

function httpResponse(data,status=200,headers={}) {
  return new Response(Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data)),{status,headers});
}

async function publisherHTTPFixture(t) {
  const f=await publisherFixture(t);f.requests=[];f.mainSha=f.ports.controllerSha;f.upstreamSha='a'.repeat(40);f.packages=upstreamPackages();
  const raw=release=>({...release,tag_name:release.tag,assets:release.assets.map(asset=>({...asset,state:'uploaded'}))});
  f.transport=async(url,options)=>{
    const parsed=new URL(url),method=options.method||'GET';f.requests.push({url,method,headers:{...options.headers},body:options.body});
    const pathname=parsed.pathname;
    if(parsed.hostname==='api.github.com'){
      if(pathname==='/repos/TK-06/codexs/git/ref/heads/main')return httpResponse({object:{sha:f.mainSha}});
      if(pathname==='/repos/openai/codex/releases')return httpResponse([{tag_name:'rust-v0.166.0',draft:false,prerelease:false}]);
      if(pathname==='/repos/openai/codex/git/ref/tags/rust-v0.166.0')return httpResponse(f.tagObject||{object:{type:'commit',sha:f.upstreamSha}});
      if(pathname.startsWith('/repos/openai/codex/git/tags/'))return httpResponse(f.tagObjects?.[pathname.split('/').at(-1)]||{});
      if(pathname==='/repos/TK-06/codexs/releases'&&method==='GET'){
        const page=Number(parsed.searchParams.get('page')||1),pages=f.releasePages||[f.state.releases];
        return httpResponse((pages[page-1]||[]).map(raw),200,page<pages.length?{link:'<https://api.github.com/next>; rel="next"'}:{});
      }
      if(pathname==='/repos/TK-06/codexs/tags'){
        const page=Number(parsed.searchParams.get('page')||1),pages=f.tagPages||[f.state.tags];
        return httpResponse((pages[page-1]||[]).map(item=>({name:item.tag,commit:{sha:item.sha}})),200,page<pages.length?{link:'<https://api.github.com/next>; rel="next"'}:{});
      }
      if(pathname==='/repos/TK-06/codexs/releases'&&method==='POST'){
        const body=JSON.parse(Buffer.from(options.body).toString());assert.equal(body.target_commitish,f.ports.controllerSha);assert.equal(body.draft,true);assert.equal(body.prerelease,false);assert.equal(body.make_latest,'false');
        return httpResponse(raw(await f.ports.createDraft({tag:body.tag_name,body:body.body})),201);
      }
      if(/^\/repos\/TK-06\/codexs\/releases\/\d+$/.test(pathname)){
        const id=Number(pathname.split('/').at(-1)),release=f.state.releases.find(item=>item.id===id);
        if(method==='PATCH'){const body=JSON.parse(Buffer.from(options.body).toString());assert.deepEqual(body,{draft:false,make_latest:'true',prerelease:false});return httpResponse(raw(await f.ports.makeStable({releaseId:id})));}
        return httpResponse(raw(release));
      }
      if(/^\/repos\/TK-06\/codexs\/releases\/assets\/\d+$/.test(pathname)){
        const id=Number(pathname.split('/').at(-1));return new Response(null,{status:302,headers:{location:f.assetRedirect||'https://release-assets.githubusercontent.com/synthetic/'+id}});
      }
    }
    if(parsed.hostname==='uploads.github.com'){
      const id=Number(pathname.split('/').at(-2)),name=parsed.searchParams.get('name');
      return httpResponse({...await f.ports.upload({releaseId:id,name,bytes:Buffer.from(options.body),contentType:options.headers['Content-Type']}),state:'uploaded'},201);
    }
    if(parsed.hostname==='registry.npmjs.org')return httpResponse(pathname.endsWith('-win32-x64')?f.packages.helper:f.packages.main);
    if(parsed.hostname==='release-assets.githubusercontent.com')return httpResponse(f.assets.get(Number(pathname.split('/').at(-1))));
    throw Error('Unexpected synthetic publisher route');
  };
  f.options={token:'synthetic-token',keyRef:'CODEXS_RELEASE_SIGNING_KEY',publicKey:f.keys.publicKey,bundleRoot:f.root,controllerSha:f.ports.controllerSha,fetch:(...args)=>f.transport(...args)};
  return f;
}

async function syntheticKey(f,work) {
  const previous=process.env.CODEXS_RELEASE_SIGNING_KEY;
  process.env.CODEXS_RELEASE_SIGNING_KEY=f.keys.privateKey.export({type:'pkcs8',format:'pem'});
  try{return await work();}finally{if(previous===undefined)delete process.env.CODEXS_RELEASE_SIGNING_KEY;else process.env.CODEXS_RELEASE_SIGNING_KEY=previous;}
}

test('task10 ports: construction is inert and real adapters publish only to fixed endpoints',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options);assert.equal(f.requests.length,0);
  const result=await syntheticKey(f,()=>api().publishStable(f.input,ports));assert.equal(result.sequence,9);
  for(const request of f.requests){const host=new URL(request.url).hostname;
    if(['api.github.com','uploads.github.com'].includes(host))assert.equal(request.headers.Authorization,'Bearer synthetic-token');else assert.equal(request.headers.Authorization,undefined);
    assert.equal(JSON.stringify(request.headers).includes('PRIVATE KEY'),false);
  }
  assert.ok(f.requests.some(request=>new URL(request.url).hostname==='uploads.github.com'));
  assert.equal(f.requests.filter(request=>request.method==='PATCH').length,1);
});

test('task10 ports: promotion independently reads back stable release metadata',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options);await syntheticKey(f,()=>api().publishStable(f.input,ports));
  const promoted=f.requests.findIndex(request=>request.method==='PATCH');assert.ok(promoted>=0);assert.equal(f.requests[promoted+1]?.method,'GET');assert.equal(f.requests[promoted+1]?.url,'https://api.github.com/repos/TK-06/codexs/releases/91');
});

test('task10 ports: complete release and orphan-tag pagination preserves all records',async t=>{
  const f=await publisherHTTPFixture(t);f.releasePages=[f.state.releases,[{id:150,tag:tag(150),draft:true,prerelease:false,body:'synthetic reserved',assets:[]}]];f.tagPages=[f.state.tags,[{tag:tag(151),sha:f.ports.controllerSha}]];
  const result=await api().createPublisherPorts(f.options).listReleases();assert.equal(result.releases.length,2);assert.equal(result.tags.length,2);assert.equal(result.tags[1].tag,tag(151));
});

test('task10 ports: a changed main controller blocks every mutation',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options);f.mainSha='e'.repeat(40);
  await assert.rejects(ports.createDraft({tag:tag(9),body:'codexs-publish-v1\nidentity_sha256='+'1'.repeat(64)}),{code:'CONTROLLER_CHANGED'});
  assert.equal(f.requests.some(request=>request.method!=='GET'),false);
});

test('task10 ports: foreign release-asset redirects cannot receive credentials or a request',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options);
  await syntheticKey(f,()=>api().publishStable(f.input,ports));const release=f.state.releases.find(item=>item.id===91),asset=release.assets[0];f.assetRedirect='https://invalid.example/stolen';
  await assert.rejects(ports.readAsset({kind:'release',releaseId:91,assetId:asset.id,name:asset.name,maxBytes:4*1024**2}),{code:'PUBLISH_NETWORK'});
  assert.equal(f.requests.some(request=>new URL(request.url).hostname==='invalid.example'),false);
});

test('task10 ports: local reads reject traversal and hard links',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options);
  await assert.rejects(ports.readAsset({kind:'local',path:path.join(f.root,'..','codexs-windows-x64.zip'),maxBytes:256*1024**2}),{code:'PUBLISH_ARCHIVE'});
  await fs.link(f.input.bundle.archivePath,path.join(f.root,'synthetic-hard-link'));
  await assert.rejects(ports.readAsset({kind:'local',path:f.input.bundle.archivePath,maxBytes:256*1024**2}),{code:'PUBLISH_ARCHIVE'});
});

for(const name of ['rate limit','server error','redirect','oversized metadata','malformed metadata'])test('task10 ports: rejects '+name+' without a write',async t=>{
  const f=await publisherHTTPFixture(t);f.transport=async()=>{
    if(name==='rate limit')return httpResponse({},429);
    if(name==='server error')return httpResponse({},500);
    if(name==='redirect')return new Response(null,{status:302,headers:{location:'https://invalid.example/'}});
    if(name==='oversized metadata')return httpResponse(Buffer.alloc(2*1024**2+1));
    return httpResponse(Buffer.from('{'));
  };
  await assert.rejects(api().createPublisherPorts(f.options).listReleases(),{code:'PUBLISH_NETWORK'});
  assert.equal(f.events.includes('create'),false);
});

test('task10 ports: annotated tags resolve once and cycles are rejected',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options);f.tagObject={object:{type:'tag',sha:'e'.repeat(40)}};f.tagObjects={['e'.repeat(40)]:{object:{type:'commit',sha:'a'.repeat(40)}}};
  assert.equal((await ports.latestUpstream()).sha,'a'.repeat(40));f.tagObjects['e'.repeat(40)]={object:{type:'tag',sha:'e'.repeat(40)}};
  await assert.rejects(ports.latestUpstream(),{code:'UPSTREAM_IDENTITY'});
});

test('task10 ports: wrong private key cannot sign for the pinned public key',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options),wrong=generateKeyPairSync('ed25519'),previous=process.env.CODEXS_RELEASE_SIGNING_KEY;
  process.env.CODEXS_RELEASE_SIGNING_KEY=wrong.privateKey.export({type:'pkcs8',format:'pem'});
  try{await assert.rejects(ports.sign('CODEXS_RELEASE_SIGNING_KEY',Buffer.concat([Buffer.from('codexs-release-v1\0'),encodeRelease(releaseManifest())])),{code:'PUBLISH_KEY'});}finally{if(previous===undefined)delete process.env.CODEXS_RELEASE_SIGNING_KEY;else process.env.CODEXS_RELEASE_SIGNING_KEY=previous;}
  assert.equal(f.requests.length,0);
});

test('task10 ports: shared upstream error codes survive the publisher boundary without private messages',async t=>{
  const f=await publisherFixture(t);f.ports.latestUpstream=async()=>{throw Object.assign(Error('synthetic private transport detail'),{code:'PACKAGE_LAYOUT'});};
  await assert.rejects(api().publishStable(f.input,f.ports),error=>error.code==='PACKAGE_LAYOUT'&&!error.message.includes('private transport detail'));
});

test('task10 ports: control and streamed asset deadlines abort incomplete bodies',async t=>{
  const f=await publisherHTTPFixture(t),ports=api().createPublisherPorts(f.options),budgets=[];
  const timers=new Set();
  t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  // Mock streams own no I/O handle; keep each synthetic deadline referenced.
  const timeout=milliseconds=>{
    budgets.push(milliseconds);
    const controller=new AbortController();
    const timer=setTimeout(()=>{timers.delete(timer);controller.abort(new DOMException('Synthetic deadline','TimeoutError'));},10);
    timers.add(timer);return controller.signal;
  };
  t.mock.method(AbortSignal,'timeout',timeout);
  f.transport=async()=>new Response(new ReadableStream({start(){}}));
  await assert.rejects(ports.listReleases(),{code:'PUBLISH_NETWORK'});
  assert.ok(budgets.includes(15000));
  t.mock.restoreAll();
  await syntheticKey(f,async()=>{
    const local=await publisherHTTPFixture(t),real=api().createPublisherPorts(local.options);
    await syntheticKey(local,()=>api().publishStable(local.input,real));
    const saved=local.transport,asset=local.state.releases.find(item=>item.id===91).assets[0];
    local.transport=(url,options)=>new URL(url).hostname==='release-assets.githubusercontent.com'?Promise.resolve(new Response(new ReadableStream({start(){}}))):saved(url,options);
    t.mock.method(AbortSignal,'timeout',timeout);
    await assert.rejects(real.readAsset({kind:'release',releaseId:91,assetId:asset.id,name:asset.name,maxBytes:4*1024**2}),{code:'PUBLISH_NETWORK'});
    assert.ok(budgets.includes(180000));
  });
});

test('task10 ports: endless own-release pagination is rejected as incomplete',async t=>{
  const f=await publisherHTTPFixture(t),saved=f.transport;f.transport=async(url,options)=>url.includes('/git/ref/heads/main')?saved(url,options):httpResponse([],200,{link:'<https://api.github.com/ignored>; rel="next"'});
  await assert.rejects(api().createPublisherPorts(f.options).listReleases(),{code:'PUBLISH_NETWORK'});
});
