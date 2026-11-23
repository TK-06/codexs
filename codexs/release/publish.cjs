'use strict';

const path = require('node:path');
const { createHash, createPublicKey, createPrivateKey, sign: signBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { TextDecoder } = require('node:util');
const { UpdateError, encodeRelease, validateRelease, verifyRelease } = require('../update/protocol.cjs');

const MAX_ZIP = 256 * 1024 ** 2;
const MAX_JSON = 4 * 1024 ** 2;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const PREFIX = Buffer.from('codexs-release-v1\0');
const POLICY = {nodeMajor:22,bootstrap:1};
const ASSETS = ['release.json','release.sig','codexs-windows-x64.zip','codexs-enrollment.zip','enrollment.json'];
const fail = code => { throw new UpdateError(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeInt = (value,min=1) => Number.isSafeInteger(value) && value >= min;
function fields(value,keys,code='MANIFEST_SCHEMA') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}
function boundedBytes(value,max,code) {
  if (!Buffer.isBuffer(value) || value.length<1 || value.length>max) fail(code);
  return Buffer.from(value);
}
function jsonBytes(bytes) {
  try {
    const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
    if (!encodeRelease(value).equals(bytes)) fail('PUBLISH_ARCHIVE');
    return value;
  } catch { fail('PUBLISH_ARCHIVE'); }
}
function productSequence(tag) {
  if (typeof tag !== 'string') fail('PUBLISH_SEQUENCE');
  if (!tag.startsWith('codexs-')) return null;
  const version='(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
  const match=tag.match(new RegExp('^codexs-v'+version+'-codex'+version+'-r([1-9]\\d*)$'));
  if (!match || match.slice(1).some(part=>!Number.isSafeInteger(Number(part)))) fail('PUBLISH_SEQUENCE');
  return Number(match[7]);
}
function sameUpstream(observed,base) {
  try {
    return observed && observed.version===base.upstream.version && observed.tag===base.upstream.tag && observed.sha===base.upstream.sha &&
      encodeRelease(observed.packages).equals(encodeRelease(base.packages));
  } catch { return false; }
}
function releaseAssets(release) {
  if (!safeInt(release?.id) || !Array.isArray(release.assets) || release.assets.length>ASSETS.length) fail('PUBLISH_IMMUTABLE');
  const found=new Map();
  for (const asset of release.assets) {
    if (!safeInt(asset?.id) || !ASSETS.includes(asset.name) || found.has(asset.name) || !safeInt(asset.size)) fail('PUBLISH_IMMUTABLE');
    found.set(asset.name,asset);
  }
  return found;
}
async function checkAssets(release,expected,ports,{complete=false}={}) {
  const assets=releaseAssets(release);
  if (complete && assets.size!==ASSETS.length) fail('PUBLISH_IMMUTABLE');
  for (const [name,asset] of assets) {
    const wanted=expected.get(name);
    if (!wanted || asset.size!==wanted.length) fail('PUBLISH_IMMUTABLE');
    const bytes=await ports.readAsset({kind:'release',releaseId:release.id,assetId:asset.id,name,maxBytes:wanted.length});
    if (!Buffer.isBuffer(bytes) || !bytes.equals(wanted)) fail('PUBLISH_IMMUTABLE');
  }
  return assets;
}
async function acceptedLocal(bundle,provisional,ports) {
  if (typeof bundle.archivePath !== 'string' || !path.isAbsolute(bundle.archivePath) || path.basename(bundle.archivePath)!=='codexs-windows-x64.zip') fail('PUBLISH_ARCHIVE');
  const read=async(name,max)=>boundedBytes(await ports.readAsset({kind:'local',path:path.join(path.dirname(bundle.archivePath),name),maxBytes:max}),max,'PUBLISH_ARCHIVE');
  const archive=await read('codexs-windows-x64.zip',MAX_ZIP);
  if (archive.length!==provisional.archive.bytes || sha256(archive)!==provisional.archive.sha256) fail('PUBLISH_ARCHIVE');
  const enrollmentBytes=await read('enrollment.json',MAX_JSON),enrollment=jsonBytes(enrollmentBytes);
  fields(enrollment,['controller_sha','files','bytes','sha256'],'PUBLISH_ARCHIVE');
  if (enrollment.controller_sha!==ports.controllerSha || !safeInt(enrollment.bytes) || enrollment.bytes>MAX_ZIP || typeof enrollment.sha256!=='string' || !HASH.test(enrollment.sha256)) fail('PUBLISH_ARCHIVE');
  validateRelease({...provisional,files:enrollment.files},POLICY);
  const enrollmentZip=await read('codexs-enrollment.zip',MAX_ZIP);
  if (enrollmentZip.length!==enrollment.bytes || sha256(enrollmentZip)!==enrollment.sha256) fail('PUBLISH_ARCHIVE');
  return {enrollment,assets:new Map([['codexs-windows-x64.zip',archive],['codexs-enrollment.zip',enrollmentZip],['enrollment.json',enrollmentBytes]])};
}

async function publishStable(input,ports) {
  try {
    fields(input,['bundle','evidence','keyRef']);
    if (input.keyRef!=='CODEXS_RELEASE_SIGNING_KEY') fail('PUBLISH_KEY');
    // Snapshot caller metadata before the first asynchronous boundary.
    const {bundle,evidence}=structuredClone({bundle:input.bundle,evidence:input.evidence});
    fields(bundle,['archivePath','manifestBase']);
    const base=bundle.manifestBase;
    if (!base || ['sequence','release_id','evidence'].some(key=>Object.hasOwn(base,key))) fail('MANIFEST_SCHEMA');
    const makeRelease=sequence=>({...base,sequence,release_id:'codexs-v'+base.product_version+'-codex'+base.upstream?.version+'-r'+sequence,evidence});
    const provisional=makeRelease(1);validateRelease(provisional,POLICY);
    if (!ports || typeof ports.controllerSha!=='string' || !SHA.test(ports.controllerSha) || base.overlay_sha!==ports.controllerSha) fail('CONTROLLER_CHANGED');
    for (const name of ['listReleases','createDraft','upload','readAsset','makeStable','sign','latestUpstream']) if (typeof ports[name]!=='function') fail('PUBLISH_NETWORK');
    const local=await acceptedLocal(bundle,provisional,ports);
    const identity=sha256(encodeRelease({manifestBase:base,evidence,enrollment:local.enrollment}));
    const body='codexs-publish-v1\nidentity_sha256='+identity;
    const inventory=await ports.listReleases();fields(inventory,['releases','tags'],'PUBLISH_SEQUENCE');
    if (!Array.isArray(inventory.releases) || !Array.isArray(inventory.tags) || inventory.releases.length>10000 || inventory.tags.length>10000) fail('PUBLISH_SEQUENCE');
    let highest=0;
    for (const collection of [inventory.releases,inventory.tags]) {
      const seen=new Set();
      for (const item of collection) {
        const number=productSequence(item?.tag);if (number===null) continue;
        if (seen.has(item.tag)) fail('PUBLISH_SEQUENCE');seen.add(item.tag);highest=Math.max(highest,number);
      }
    }
    const matching=inventory.releases.filter(release=>release.body===body);
    if (matching.length>1) fail('PUBLISH_IMMUTABLE');
    let release=matching[0];
    const sequence=release?productSequence(release.tag):highest+1;
    if (!safeInt(sequence)) fail('PUBLISH_SEQUENCE');
    const manifest=makeRelease(sequence);validateRelease(manifest,POLICY);
    if (release && (release.tag!==manifest.release_id || typeof release.draft!=='boolean' || release.prerelease!==false)) fail('PUBLISH_IMMUTABLE');
    const manifestBytes=encodeRelease(manifest);if (manifestBytes.length>MAX_JSON) fail('MANIFEST_SCHEMA');
    local.assets.set('release.json',manifestBytes);
    if (release && !release.draft) {
      const saved=releaseAssets(release).get('release.sig');if (!saved) fail('PUBLISH_IMMUTABLE');
      const signature=await ports.readAsset({kind:'release',releaseId:release.id,assetId:saved.id,name:'release.sig',maxBytes:64});
      try { verifyRelease(manifestBytes,signature,ports.publicKey,POLICY); } catch { fail('PUBLISH_IMMUTABLE'); }
      local.assets.set('release.sig',Buffer.from(signature));
      await checkAssets(release,local.assets,ports,{complete:true});
      return {tag:manifest.release_id,sequence,releaseId:release.id};
    }
    if (!sameUpstream(await ports.latestUpstream(),base)) fail('PUBLISH_SUPERSEDED');
    const signature=await ports.sign(input.keyRef,Buffer.concat([PREFIX,manifestBytes]));
    try { if (!Buffer.isBuffer(signature) || signature.length!==64) fail('PUBLISH_KEY');verifyRelease(manifestBytes,signature,ports.publicKey,POLICY); } catch { fail('PUBLISH_KEY'); }
    local.assets.set('release.sig',Buffer.from(signature));
    if (!release) release=await ports.createDraft({tag:manifest.release_id,body});
    if (release?.tag!==manifest.release_id || release.body!==body || release.draft!==true || release.prerelease!==false) fail('PUBLISH_IMMUTABLE');
    const existing=await checkAssets(release,local.assets,ports);
    for (const name of ASSETS) {
      if (existing.has(name)) continue;
      const bytes=local.assets.get(name),asset=await ports.upload({releaseId:release.id,name,bytes:Buffer.from(bytes),contentType:name.endsWith('.json')?'application/json':'application/octet-stream'});
      if (!safeInt(asset?.id) || asset.name!==name || asset.size!==bytes.length) fail('PUBLISH_IMMUTABLE');
      release.assets.push({...asset});
    }
    await checkAssets(release,local.assets,ports,{complete:true});
    if (!sameUpstream(await ports.latestUpstream(),base)) fail('PUBLISH_SUPERSEDED');
    const stable=await ports.makeStable({releaseId:release.id});
    if (stable?.id!==release.id || stable.tag!==manifest.release_id || stable.draft!==false || stable.prerelease!==false) fail('PUBLISH_IMMUTABLE');
    return {tag:manifest.release_id,sequence,releaseId:release.id};
  } catch (error) {
    const code=error?.code;
    if (typeof code==='string' && code.length<=64 && /^(?:PUBLISH_[A-Z_]+|UPSTREAM_[A-Z_]+|PACKAGE_[A-Z_]+|EVIDENCE_[A-Z_]+|CONTROLLER_CHANGED|MANIFEST_SCHEMA|COMPATIBILITY|RELEASE_POLICY)$/.test(code)) fail(code);
    fail('PUBLISH_NETWORK');
  }
}

function stableVersion(value) {
  if(typeof value!=='string'||! /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))fail('UPSTREAM_IDENTITY');
  const parts=value.split('.').map(Number);if(!parts.every(Number.isSafeInteger))fail('UPSTREAM_IDENTITY');return parts;
}

async function discoverUpstream(ports) {
  const releases=[];
  for(let page=1;page<=100;page++){
    const result=await ports.listUpstreamReleases({page,perPage:100});
    if(!Array.isArray(result?.releases)||result.releases.length>100||typeof result.hasNext!=='boolean')fail('UPSTREAM_IDENTITY');
    for(const release of result.releases){
      if(!release||typeof release.draft!=='boolean'||typeof release.prerelease!=='boolean'||typeof release.tag_name!=='string')fail('UPSTREAM_IDENTITY');
      if(release.draft||release.prerelease||!release.tag_name.startsWith('rust-v'))continue;
      releases.push({...release,parts:stableVersion(release.tag_name.slice(6))});
    }
    if(!result.hasNext)break;if(page===100)fail('UPSTREAM_IDENTITY');
  }
  releases.sort((a,b)=>{for(let i=0;i<3;i++)if(a.parts[i]!==b.parts[i])return a.parts[i]>b.parts[i]?-1:1;return 0;});
  if(!releases.length)return null;
  const tag=releases[0].tag_name,version=tag.slice(6),sha=await ports.resolveTag(tag);
  if(typeof sha!=='string'||!SHA.test(sha))fail('UPSTREAM_IDENTITY');
  const [main,helper]=await Promise.all([ports.getPackage(version),ports.getPackage(version+'-win32-x64')]);
  return require('../upstream/upstream.cjs').selectUpstream([{tag_name:tag,draft:false,prerelease:false,sha}],main,helper);
}

// A key-free, fixed-origin transport shared by discovery and orchestration.
// All deadlines cover headers AND the body. No write is retried automatically.
function createControlClient(options) {
  if(!options||typeof options.token!=='string'||! /^[\x21-\x7e]{1,512}$/.test(options.token)||!SHA.test(options.controllerSha)||options.fetch!==undefined&&typeof options.fetch!=='function')fail('PUBLISH_NETWORK');
  const token=options.token,controllerSha=options.controllerSha,request=options.fetch||globalThis.fetch;
  const api='https://api.github.com',fork='/repos/TK-06/codexs';
  async function read(url,{method='GET',body,headers={},maxBytes=2*1024**2,timeout=15000,binary=false,nullable=false,expected=200}={}) {
    const signal=AbortSignal.timeout(timeout);let response,reader;
    const aborted=new Promise((_,reject)=>{const abort=()=>reject(new UpdateError('PUBLISH_NETWORK'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
    // The abort promise is observed even when a synthetic fetch ignores its signal.
    const wait=work=>Promise.race([work,aborted]);
    try{
      for(let hop=0;;hop++){
        const parsed=new URL(url),host=parsed.hostname;
        if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash)fail('PUBLISH_NETWORK');
        const authenticated=host==='api.github.com'||host==='uploads.github.com';
        if(host==='api.github.com'&&!/^\/repos\/(?:TK-06\/codexs|openai\/codex)\//.test(parsed.pathname))fail('PUBLISH_NETWORK');
        if(host==='uploads.github.com'&&!/^\/repos\/TK-06\/codexs\/releases\/[1-9]\d*\/assets$/.test(parsed.pathname))fail('PUBLISH_NETWORK');
        if(!authenticated&&!['registry.npmjs.org','github.com','release-assets.githubusercontent.com'].includes(host))fail('PUBLISH_NETWORK');
        if(!authenticated&&method!=='GET')fail('PUBLISH_NETWORK');
        response=await wait(request(url,{method,body,redirect:'manual',credentials:'omit',signal,headers:{Accept:binary?'application/octet-stream':'application/vnd.github+json','User-Agent':'codexs-controller',...(authenticated?{Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2026-03-10'}:{}),...headers}}));
        if(binary&&method==='GET'&&[301,302,303,307,308].includes(response.status)){
          if(hop>=3)fail('PUBLISH_NETWORK');
          const next=new URL(response.headers.get('location'),url);
          if(!['github.com','release-assets.githubusercontent.com'].includes(next.hostname)||next.protocol!=='https:'||next.username||next.password||next.port)fail('PUBLISH_NETWORK');
          if(response.body)void response.body.cancel().catch(()=>{});url=next.href;continue;
        }
        if(nullable&&response.status===404){if(response.body)void response.body.cancel().catch(()=>{});return null;}
        if(response.status!==expected||!response.body)fail('PUBLISH_NETWORK');break;
      }
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^(0|[1-9]\d*)$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>maxBytes))fail('PUBLISH_NETWORK');
      reader=response.body.getReader();const chunks=[];let total=0;
      for(;;){const part=await wait(reader.read());if(part.done)break;const bytes=Buffer.from(part.value);total+=bytes.length;if(total>maxBytes)fail('PUBLISH_NETWORK');chunks.push(bytes);}
      const bytes=Buffer.concat(chunks,total),next=/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get('link')||'');
      return {value:binary?bytes:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)),hasNext:next};
    }catch{if(reader)void reader.cancel().catch(()=>{});else if(response?.body)void response.body.cancel().catch(()=>{});fail('PUBLISH_NETWORK');}
  }
  async function json(route,options={}){return read(api+route,{...options,body:options.body===undefined?undefined:Buffer.from(JSON.stringify(options.body)),headers:{...(options.body===undefined?{}:{'Content-Type':'application/json'}),...options.headers}});}
  async function main(){const result=await json(fork+'/git/ref/heads/main');if(result.value?.object?.sha!==controllerSha)fail('CONTROLLER_CHANGED');}
  async function pages(route){const values=[];for(let page=1;page<=100;page++){const result=await json(route+(route.includes('?')?'&':'?')+'per_page=100&page='+page);if(!Array.isArray(result.value)||result.value.length>100)fail('PUBLISH_NETWORK');values.push(...result.value);if(!result.hasNext)return values;}fail('PUBLISH_NETWORK');}
  return {json,read,main,pages};
}

function createDiscoveryPorts(client) {
  return {
    async listUpstreamReleases({page,perPage}){const result=await client.json('/repos/openai/codex/releases?per_page='+perPage+'&page='+page);return {releases:result.value,hasNext:result.hasNext};},
    async resolveTag(tag){
      stableVersion(tag.slice(6));if(!tag.startsWith('rust-v'))fail('UPSTREAM_IDENTITY');
      let result=(await client.json('/repos/openai/codex/git/ref/tags/'+tag)).value,seen=new Set();
      for(let hop=0;hop<=5;hop++){
        const object=result?.object;if(!object||!SHA.test(object.sha))fail('UPSTREAM_IDENTITY');
        if(object.type==='commit')return object.sha;
        if(object.type!=='tag'||hop===5||seen.has(object.sha))fail('UPSTREAM_IDENTITY');seen.add(object.sha);
        result=(await client.json('/repos/openai/codex/git/tags/'+object.sha)).value;
      }
      fail('UPSTREAM_IDENTITY');
    },
    async getPackage(version){stableVersion(version.replace(/-win32-x64$/,''));const result=await client.read('https://registry.npmjs.org/@openai%2Fcodex/'+version,{nullable:true});return result?.value||null;},
  };
}

function assetLimit(name){if(name==='release.sig')return 64;if(name==='release.json'||name==='enrollment.json')return MAX_JSON;if(name==='codexs-windows-x64.zip'||name==='codexs-enrollment.zip')return MAX_ZIP;fail('PUBLISH_ARCHIVE');}
function assetRecord(raw){if(!safeInt(raw?.id)||typeof raw.name!=='string'||!safeInt(raw.size)||raw.state!=='uploaded')fail('PUBLISH_NETWORK');return {id:raw.id,name:raw.name,size:raw.size};}
function releaseRecord(raw){if(!safeInt(raw?.id)||typeof raw.tag_name!=='string'||typeof raw.draft!=='boolean'||typeof raw.prerelease!=='boolean'||!Array.isArray(raw.assets)||raw.assets.length>100||raw.body!==null&&typeof raw.body!=='string')fail('PUBLISH_NETWORK');return {id:raw.id,tag:raw.tag_name,draft:raw.draft,prerelease:raw.prerelease,body:raw.body||'',assets:raw.assets.map(assetRecord)};}

async function readOwned(root,file,maxBytes) {
  let handle;
  try{
    if(typeof file!=='string'||!path.isAbsolute(file)||!path.isAbsolute(root)||!safeInt(maxBytes)||maxBytes>assetLimit(path.basename(file)))fail('PUBLISH_ARCHIVE');
    const relative=path.relative(root,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))fail('PUBLISH_ARCHIVE');
    const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    if(!same(await fs.realpath(root),path.resolve(root)))fail('PUBLISH_ARCHIVE');
    let cursor=root;for(const part of relative.split(path.sep)){cursor=path.join(cursor,part);if((await fs.lstat(cursor)).isSymbolicLink())fail('PUBLISH_ARCHIVE');}
    if(!same(await fs.realpath(file),path.resolve(file)))fail('PUBLISH_ARCHIVE');
    const before=await fs.lstat(file);if(!before.isFile()||before.nlink!==1||before.size<1||before.size>maxBytes)fail('PUBLISH_ARCHIVE');
    handle=await fs.open(file,'r');const initial=await handle.stat();if(initial.ino!==before.ino||initial.dev!==before.dev)fail('PUBLISH_ARCHIVE');
    const chunks=[];let size=0;for(;;){const buffer=Buffer.alloc(Math.min(1024**2,maxBytes-size+1)),{bytesRead}=await handle.read(buffer);if(!bytesRead)break;size+=bytesRead;if(size>maxBytes)fail('PUBLISH_ARCHIVE');chunks.push(buffer.subarray(0,bytesRead));}
    const after=await handle.stat(),named=await fs.lstat(file);
    if(after.size!==size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1||named.ino!==after.ino||named.dev!==after.dev||named.isSymbolicLink())fail('PUBLISH_ARCHIVE');
    return Buffer.concat(chunks,size);
  }catch{fail('PUBLISH_ARCHIVE');}finally{if(handle)await handle.close();}
}

function createPublisherPorts(options) {
  const client=createControlClient(options),controllerSha=options.controllerSha,root=options.bundleRoot;
  let publicKey;try{publicKey=options.publicKey?.type==='public'?options.publicKey:createPublicKey(options.publicKey);if(publicKey.asymmetricKeyType!=='ed25519'||options.keyRef!=='CODEXS_RELEASE_SIGNING_KEY'||typeof root!=='string'||!path.isAbsolute(root))fail('PUBLISH_KEY');}catch{fail('PUBLISH_KEY');}
  const fork='/repos/TK-06/codexs',discovery=createDiscoveryPorts(client);
  async function getRelease(id){if(!safeInt(id))fail('PUBLISH_IMMUTABLE');return releaseRecord((await client.json(fork+'/releases/'+id)).value);}
  return {
    controllerSha,publicKey,
    async listReleases(){await client.main();const [releases,tags]=await Promise.all([client.pages(fork+'/releases'),client.pages(fork+'/tags')]);return {releases:releases.map(releaseRecord),tags:tags.map(item=>{if(typeof item?.name!=='string'||!SHA.test(item.commit?.sha))fail('PUBLISH_NETWORK');return {tag:item.name,sha:item.commit.sha};})};},
    async createDraft({tag,body}){productSequence(tag);if(!/^codexs-publish-v1\nidentity_sha256=[a-f0-9]{64}$/.test(body))fail('PUBLISH_IMMUTABLE');await client.main();return releaseRecord((await client.json(fork+'/releases',{method:'POST',expected:201,body:{tag_name:tag,target_commitish:controllerSha,name:tag,body,draft:true,prerelease:false,make_latest:'false'}})).value);},
    async upload({releaseId,name,bytes,contentType}){
      const limit=assetLimit(name);boundedBytes(bytes,limit,'PUBLISH_ARCHIVE');if(!['application/json','application/octet-stream'].includes(contentType))fail('PUBLISH_ARCHIVE');
      const release=await getRelease(releaseId);if(!release.draft||release.prerelease||release.assets.some(asset=>asset.name===name))fail('PUBLISH_IMMUTABLE');await client.main();
      return assetRecord((await client.read('https://uploads.github.com'+fork+'/releases/'+releaseId+'/assets?name='+encodeURIComponent(name),{method:'POST',expected:201,body:Buffer.from(bytes),headers:{'Content-Type':contentType},timeout:180000})).value);
    },
    async readAsset(source){
      if(source?.kind==='local')return readOwned(root,source.path,source.maxBytes);
      if(source?.kind!=='release'||!safeInt(source.assetId)||!safeInt(source.maxBytes)||source.maxBytes>assetLimit(source.name))fail('PUBLISH_ARCHIVE');
      const release=await getRelease(source.releaseId),asset=release.assets.find(item=>item.id===source.assetId);
      if(!asset||asset.name!==source.name||asset.size>source.maxBytes)fail('PUBLISH_IMMUTABLE');
      const bytes=(await client.read('https://api.github.com'+fork+'/releases/assets/'+source.assetId,{binary:true,maxBytes:source.maxBytes,timeout:180000})).value;
      if(bytes.length!==asset.size)fail('PUBLISH_IMMUTABLE');return bytes;
    },
    async makeStable({releaseId}){
      const release=await getRelease(releaseId);if(!release.draft||release.prerelease)fail('PUBLISH_IMMUTABLE');await client.main();
      const promoted=releaseRecord((await client.json(fork+'/releases/'+releaseId,{method:'PATCH',body:{draft:false,prerelease:false,make_latest:'true'}})).value),saved=await getRelease(releaseId);
      const canonical=record=>encodeRelease({...record,assets:[...record.assets].sort((a,b)=>a.name.localeCompare(b.name,'en'))});
      if(promoted.id!==releaseId||promoted.tag!==release.tag||promoted.body!==release.body||promoted.draft||promoted.prerelease||!canonical(promoted).equals(canonical(saved)))fail('PUBLISH_IMMUTABLE');
      return saved;
    },
    async sign(keyRef,prefixedBytes){
      try{
        if(keyRef!=='CODEXS_RELEASE_SIGNING_KEY'||!Buffer.isBuffer(prefixedBytes)||prefixedBytes.length>PREFIX.length+MAX_JSON||!prefixedBytes.subarray(0,PREFIX.length).equals(PREFIX))fail('PUBLISH_KEY');
        const raw=process.env.CODEXS_RELEASE_SIGNING_KEY;if(typeof raw!=='string'||raw.length>16384||!raw.startsWith('-----BEGIN PRIVATE KEY-----'))fail('PUBLISH_KEY');
        const privateKey=createPrivateKey(raw);if(privateKey.asymmetricKeyType!=='ed25519'||!createPublicKey(privateKey).export({type:'spki',format:'der'}).equals(publicKey.export({type:'spki',format:'der'})))fail('PUBLISH_KEY');
        const manifest=jsonBytes(prefixedBytes.subarray(PREFIX.length));validateRelease(manifest,POLICY);if(manifest.overlay_sha!==controllerSha)fail('PUBLISH_KEY');
        return signBytes(null,Buffer.from(prefixedBytes),privateKey);
      }catch{fail('PUBLISH_KEY');}
    },
    async latestUpstream(){await client.main();return discoverUpstream(discovery);},
  };
}

module.exports = { publishStable, discoverUpstream, createPublisherPorts, createControlClient, createDiscoveryPorts };
