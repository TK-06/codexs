'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants, createReadStream } = require('node:fs');
const { builtinModules } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { UpdateError, encodeRelease } = require('../update/protocol.cjs');
const { resolveOwned, validateInventory, readBoundedFile, hashFile, verifyInventory } = require('../update/paths.cjs');

const SHA=/^[a-f0-9]{40}$/, HASH=/^[a-f0-9]{64}$/, VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RUNTIME=['launch.cjs','protocol.cjs','paths.cjs','state.cjs','http.cjs','stage.cjs','archive.ps1','coordinator.ps1'];
const REQUIRED=['bin/codex.exe','codex-package.json','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe','packages/main/package.json','packages/helper/package.json','licenses/codex/LICENSE','licenses/helpers/LICENSE'];
const SUITES=['quick','feature','full','config','formatter','updater','installer'];
const fail=code=>{throw new UpdateError(code);};
const matches=(value,pattern)=>typeof value==='string'&&pattern.test(value);
function object(value,keys,code) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail(code);
}
function version(value) { return matches(value,VERSION)&&value.split('.').every(part=>Number.isSafeInteger(Number(part))); }
function under(a,b) { const left=path.resolve(a).toLowerCase(),right=path.resolve(b).toLowerCase();return left===right||left.startsWith(right+path.sep); }
function evidence(input,native,formatter) {
  const code='PACKAGE_EVIDENCE';
  object(input,['candidate_sha','upstream_sha','formatter_sha','runs','suites','build_exit'],code);
  if(input.candidate_sha!==native.sha||input.upstream_sha!==native.upstream.sha||input.formatter_sha!==formatter.sha)fail('PACKAGE_IDENTITY');
  object(input.suites,SUITES,code);
  for(const suite of Object.values(input.suites)) {
    object(suite,['passed','failed','ignored','exit'],code);
    if(!Number.isSafeInteger(suite.passed)||suite.passed<1||!Number.isSafeInteger(suite.ignored)||suite.ignored<0||suite.failed!==0||suite.exit!==0)fail(code);
  }
  if(input.build_exit!==0||!Array.isArray(input.runs)||!input.runs.length||input.runs.length>1000)fail(code);
  const seen=new Set();
  for(const ref of input.runs) {
    object(ref,['repository','run','attempt','job','artifact'],code);
    const key=JSON.stringify(ref);
    if(ref.repository!=='TK-06/codexs'||['run','attempt','job','artifact'].some(name=>!Number.isSafeInteger(ref[name])||ref[name]<1)||seen.has(key))fail(code);
    seen.add(key);
  }
}
function identities(input) {
  object(input,['nativeTree','formatterDist','formatterPackage','overlay','preBundleEvidence'],'PACKAGE_INPUT');
  const {nativeTree:native,formatterPackage:formatter,overlay}=input;
  object(native,['root','sha','upstream','packages','productVersion'],'PACKAGE_INPUT');
  object(formatter,['path','sha','version'],'PACKAGE_INPUT');object(overlay,['sha','metadata',...(overlay&&Object.hasOwn(overlay,'candidate')?['candidate']:[])],'PACKAGE_INPUT');
  object(native.upstream,['version','tag','sha'],'PACKAGE_IDENTITY');
  object(overlay.metadata,['schema','base_sha','accepted_sha','patch_sha256','paths','formatter_sha','required_suites'],'PACKAGE_IDENTITY');
  if(!matches(native.sha,SHA)||!matches(formatter.sha,SHA)||!matches(overlay.sha,SHA)||!matches(native.upstream.sha,SHA)||!version(native.productVersion)||!version(native.upstream.version)||native.upstream.tag!==`rust-v${native.upstream.version}`||overlay.metadata.schema!==1||!matches(overlay.metadata.base_sha,SHA)||!matches(overlay.metadata.accepted_sha,SHA)||!matches(overlay.metadata.patch_sha256,HASH)||!Array.isArray(overlay.metadata.paths)||!overlay.metadata.paths.length)fail('PACKAGE_IDENTITY');
  if(Object.hasOwn(overlay,'candidate')) {
    const proof=overlay.candidate,code='PACKAGE_IDENTITY';
    object(proof,['candidate_sha','upstream_sha','overlay_sha','patch_sha256','paths'],code);
    if(proof.candidate_sha!==native.sha||proof.upstream_sha!==native.upstream.sha||proof.overlay_sha!==overlay.sha||proof.patch_sha256!==overlay.metadata.patch_sha256||!matches(proof.patch_sha256,HASH)||
       !Array.isArray(proof.paths)||!proof.paths.length||new Set(proof.paths.map(name=>typeof name==='string'?name.toLowerCase():name)).size!==proof.paths.length||
       proof.paths.some(name=>typeof name!=='string'||!name.startsWith('codex-rs/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||/\.(?:snap(?:\.new)?|pending-snap)$/i.test(name)||!overlay.metadata.paths.includes(name)))fail(code);
  } else if(overlay.metadata.base_sha!==native.upstream.sha||overlay.metadata.accepted_sha!==native.sha)fail('PACKAGE_IDENTITY');
  if(overlay.metadata.formatter_sha!==formatter.sha||!Array.isArray(overlay.metadata.required_suites)||overlay.metadata.required_suites.length!==4||new Set(overlay.metadata.required_suites).size!==4||!['feature','full','config','build'].every(name=>overlay.metadata.required_suites.includes(name)))fail('PACKAGE_IDENTITY');
  object(native.packages,['main','helper'],'PACKAGE_METADATA');
  for(const [name,pkg]of Object.entries(native.packages)) {
    object(pkg,['name','version','integrity'],'PACKAGE_METADATA');
    if(pkg.name!=='@openai/codex'||pkg.version!==(name==='main'?native.upstream.version:native.upstream.version+'-win32-x64')||!matches(pkg.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/)||Buffer.from(pkg.integrity.slice(7),'base64').toString('base64')!==pkg.integrity.slice(7))fail('PACKAGE_METADATA');
  }
  evidence(input.preBundleEvidence,native,formatter);
}

async function scan(root,allowed,code) {
  resolveOwned(root,'ancestry-check');
  const result=[];let total=0;
  async function walk(relative='') {
    const directory=relative?resolveOwned(root,relative):root;
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const name=relative?relative+'/'+entry.name:entry.name,file=resolveOwned(root,name);
      if(entry.isSymbolicLink()||/(?:^|\/)(?:node_modules|\.git|src|__tests__)(?:\/|$)|\.(?:test\.cjs|Tests\.ps1|snap(?:\.new)?|pending-snap|map|pdb)$/i.test(name))fail(code);
      if(entry.isDirectory()) {
        if(!allowed(name,true))fail(code);
        await walk(name);
      } else {
        if(!entry.isFile()||!allowed(name,false))fail(code);
        const info=await fs.lstat(file);total+=info.size;
        if(result.length>=10000||total>2*1024**3)fail(code);
        result.push({path:name,bytes:info.size,sha256:await hashFile(file,info.size,code)});
      }
    }
  }
  await walk();validateInventory(result);
  return result.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}
async function json(file,code) {
  try {return JSON.parse((await readBoundedFile(file,{code})).toString('utf8'));}
  catch{fail(code);}
}
async function peX64(file) {
  const handle=await fs.open(file,'r');
  try {
    const header=Buffer.alloc(64),signature=Buffer.alloc(6);
    if((await handle.read(header,0,64,0)).bytesRead!==64||header.toString('ascii',0,2)!=='MZ')fail('PACKAGE_ARCHITECTURE');
    const offset=header.readUInt32LE(60);
    if(offset<64||offset>(await handle.stat()).size-6||(await handle.read(signature,0,6,offset)).bytesRead!==6||signature.readUInt32LE(0)!==0x4550||signature.readUInt16LE(4)!==0x8664)fail('PACKAGE_ARCHITECTURE');
  } finally {await handle.close();}
}
function nativePath(name,directory) {
  const roots=['bin','codex-path','codex-resources','licenses'];
  if(roots.some(root=>name===root||name.startsWith(root+'/')))return true;
  if(!directory&&name==='codex-package.json')return true;
  return directory?['packages','packages/main','packages/helper'].includes(name):['packages/main/package.json','packages/helper/package.json'].includes(name);
}
function moduleSpecifiers(source) {
  const result=[];let cursor=0,mode='',previous={kind:'punct',value:';'};
  function token(kind,value) {
    if(mode==='call'&&kind!=='string')fail('PACKAGE_FORMATTER');
    if(mode==='call-end'&&(kind!=='punct'||value!==')'))fail('PACKAGE_FORMATTER');
    const wasCall=mode==='call';
    if(kind==='string'&&['from','import','call'].includes(mode))result.push(value);
    mode=wasCall?'call-end':kind==='word'&&['from','import','require'].includes(value)?(value==='require'?'require':value):
      kind==='punct'&&value==='('&&['import','require'].includes(mode)?'call':'';
    previous={kind,value};
  }
  function string(quote) {
    cursor++;let value='';
    while(cursor<source.length) {
      let char=source[cursor++];
      if(char===quote)return value;
      if(char==='\\') {
        char=source[cursor++];
        if(char==='u'||char==='x') {
          if(char==='u'&&source[cursor]==='{') {
            const end=source.indexOf('}',cursor+1),hex=source.slice(cursor+1,end);
            if(end<0||! /^[a-fA-F0-9]{1,6}$/.test(hex)||parseInt(hex,16)>0x10ffff)fail('PACKAGE_FORMATTER');
            value+=String.fromCodePoint(parseInt(hex,16));cursor=end+1;continue;
          }
          const width=char==='u'?4:2,hex=source.slice(cursor,cursor+width);
          if(!new RegExp('^[a-fA-F0-9]{'+width+'}$').test(hex))fail('PACKAGE_FORMATTER');
          value+=String.fromCharCode(parseInt(hex,16));cursor+=width;
        } else if(char==='\r'||char==='\n') {if(char==='\r'&&source[cursor]==='\n')cursor++;}
        else value+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'})[char]??char;
      } else value+=char;
    }
    fail('PACKAGE_FORMATTER');
  }
  function template() {
    if(mode==='call'){
      const value=string('`');if(value.includes('${'))fail('PACKAGE_FORMATTER');token('string',value);return;
    }
    cursor++;
    while(cursor<source.length) {
      const char=source[cursor++];
      if(char==='\\'){cursor++;continue;}
      if(char==='`'){token('template','');return;}
      if(char==='$'&&source[cursor]==='{'){cursor++;mode='';previous={kind:'punct',value:'{'};scan(true);}
    }
    fail('PACKAGE_FORMATTER');
  }
  function scan(expression=false) {
    let depth=0;const parentheses=[];
    while(cursor<source.length) {
      const char=source[cursor],next=source[cursor+1];
      if(/\s/.test(char)){cursor++;continue;}
      if(char==='/'&&next==='/'){while(cursor<source.length&&!/[\r\n]/.test(source[cursor]))cursor++;continue;}
      if(char==='/'&&next==='*'){const end=source.indexOf('*/',cursor+2);if(end<0)fail('PACKAGE_FORMATTER');cursor=end+2;continue;}
      if(char==='"'||char==="'"){const value=string(char);token('string',value);continue;}
      if(char==='`'){template();continue;}
      const regex=char==='/'&&(previous.kind==='control'||(previous.kind==='punct'&&![')',']','}','.'].includes(previous.value))||(previous.kind==='word'&&['return','throw','case','yield','await','typeof','void','delete'].includes(previous.value)));
      if(regex) {
        cursor++;let bracket=false,closed=false;
        while(cursor<source.length){const value=source[cursor++];if(value==='\\'){cursor++;continue;}if(value==='[')bracket=true;else if(value===']')bracket=false;else if(value==='/'&&!bracket){closed=true;break;}else if(/[\r\n]/.test(value))break;}
        if(!closed)fail('PACKAGE_FORMATTER');
        while(cursor<source.length&&/[a-z]/i.test(source[cursor]))cursor++;
        token('regexp','');continue;
      }
      if(/[0-9]/.test(char)) {
        const start=cursor++;while(cursor<source.length&&/[A-Za-z0-9_.]/.test(source[cursor]))cursor++;
        token('number',source.slice(start,cursor));continue;
      }
      if(/[A-Za-z_$]/.test(char)) {
        const start=cursor++;while(cursor<source.length&&/[A-Za-z0-9_$]/.test(source[cursor]))cursor++;
        token('word',source.slice(start,cursor));continue;
      }
      cursor++;
      if(expression&&char==='}'&&depth===0)return;
      if(char==='{')depth++;else if(char==='}')depth--;
      if(char==='(')parentheses.push(previous.kind==='word'&&['if','while','for','with','switch','catch'].includes(previous.value));
      if(char===')'&&parentheses.pop()){token('control',char);continue;}
      token('punct',char);
    }
    if(expression)fail('PACKAGE_FORMATTER');
  }
  scan();return result;
}
async function checkFormatter(root,files) {
  const names=new Set(files.map(file=>file.path));
  if(!names.has('ccstatusline.js'))fail('PACKAGE_FORMATTER');
  for(const file of files.filter(file=>/\.(?:js|mjs|cjs)$/.test(file.path))) {
    const source=(await readBoundedFile(resolveOwned(root,file.path),{code:'PACKAGE_FORMATTER'})).toString('utf8');
    for(const specifier of moduleSpecifiers(source)) {
      const builtin=specifier.startsWith('node:')?specifier.slice(5):specifier;
      if(builtinModules.includes(builtin)||builtinModules.includes('node:'+builtin))continue;
      if(!specifier.startsWith('.'))fail('PACKAGE_FORMATTER');
      const imported=path.posix.normalize(path.posix.join(path.posix.dirname(file.path),specifier));
      if(imported.startsWith('../')||!names.has(imported)||! /\.(?:js|mjs|cjs|json)$/.test(imported))fail('PACKAGE_FORMATTER');
    }
  }
}
async function copyFile(source,target,expected) {
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.copyFile(source,target,constants.COPYFILE_EXCL);
  if(await hashFile(target,expected.bytes,'PACKAGE_CHANGED')!==expected.sha256||await hashFile(source,expected.bytes,'PACKAGE_CHANGED')!==expected.sha256)fail('PACKAGE_CHANGED');
}
async function createZip(source,archive,inventory,root) {
  if(process.platform!=='win32')fail('PACKAGE_PLATFORM');
  const data=Buffer.from(JSON.stringify({source,archive,inventory,root,script:path.join(__dirname,'../update/archive.ps1')})).toString('base64');
  const command="$ErrorActionPreference='Stop';$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"'))|ConvertFrom-Json;& ([scriptblock]::Create([IO.File]::ReadAllText($d.script))) -Create -Source $d.source -Archive $d.archive -Inventory $d.inventory -AllowedRoot $d.root";
  try {
    const result=await execFile(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:60000,maxBuffer:65536});
    if(result.stdout.trim()!=='{"schema":1,"code":"CREATED"}')fail('PACKAGE_ARCHIVE');
  } catch {fail('PACKAGE_ARCHIVE');}
}

async function assembleBundle(input,outputRoot) {
  try {
    identities(input);
    const {nativeTree:native,formatterDist,formatterPackage:formatter,overlay,preBundleEvidence}=input;
    if(typeof outputRoot!=='string'||!path.isAbsolute(outputRoot)||typeof native.root!=='string'||!path.isAbsolute(native.root)||typeof formatterDist!=='string'||!path.isAbsolute(formatterDist)||typeof formatter.path!=='string'||!path.isAbsolute(formatter.path))fail('PACKAGE_INPUT');
    const inputs=[native.root,formatterDist,path.dirname(formatter.path)];
    if(inputs.some(root=>under(outputRoot,root)||under(root,outputRoot)))fail('PACKAGE_INPUT');
    resolveOwned(outputRoot,'ancestry-check');
    const nativeFiles=await scan(native.root,nativePath,'PACKAGE_LAYOUT'),names=new Set(nativeFiles.map(file=>file.path));
    if(REQUIRED.some(name=>!names.has(name)))fail('PACKAGE_LAYOUT');
    const main=await json(resolveOwned(native.root,'packages/main/package.json'),'PACKAGE_METADATA');
    const helper=await json(resolveOwned(native.root,'packages/helper/package.json'),'PACKAGE_METADATA');
    if(main.name!==native.packages.main.name||main.version!==native.upstream.version||main.optionalDependencies?.['@openai/codex-win32-x64']!==`npm:@openai/codex@${native.packages.helper.version}`||helper.name!==native.packages.helper.name||helper.version!==native.packages.helper.version||!Array.isArray(helper.os)||!helper.os.includes('win32')||!Array.isArray(helper.cpu)||!helper.cpu.includes('x64'))fail('PACKAGE_METADATA');
    const layout=await json(resolveOwned(native.root,'codex-package.json'),'PACKAGE_METADATA');
    object(layout,['layoutVersion','version','target','variant','entrypoint','resourcesDir','pathDir'],'PACKAGE_METADATA');
    if(layout.layoutVersion!==1||layout.version!==native.upstream.version||layout.target!=='x86_64-pc-windows-msvc'||layout.variant!=='codex'||layout.entrypoint!=='bin/codex.exe'||layout.resourcesDir!=='codex-resources'||layout.pathDir!=='codex-path')fail('PACKAGE_METADATA');
    for(const file of nativeFiles.filter(file=>/\.(exe|dll)$/i.test(file.path)))await peX64(resolveOwned(native.root,file.path));
    const metadata=await json(formatter.path,'PACKAGE_FORMATTER');
    if(metadata.name!=='ccstatusline'||!version(metadata.version)||metadata.version!==formatter.version||metadata.type!=='module')fail('PACKAGE_FORMATTER');
    // The source identity is carried by immutable hosted checkout evidence, never inferred from package version.
    const formatterVersion=metadata.version;
    const formatterFiles=await scan(formatterDist,()=>true,'PACKAGE_FORMATTER');
    await checkFormatter(formatterDist,formatterFiles);
    const license=resolveOwned(path.dirname(formatter.path),'LICENSE');
    await readBoundedFile(license,{code:'PACKAGE_FORMATTER'});
    await fs.mkdir(outputRoot,{recursive:true});
    const work=resolveOwned(outputRoot,'draft-'+randomUUID());await fs.mkdir(work);
    const payload=resolveOwned(work,'payload');await fs.mkdir(payload);
    for(const file of nativeFiles)await copyFile(resolveOwned(native.root,file.path),resolveOwned(payload,file.path),file);
    for(const file of formatterFiles)await copyFile(resolveOwned(formatterDist,file.path),resolveOwned(payload,'formatter/dist/'+file.path),file);
    for(const [source,name]of [[formatter.path,'formatter/package.json'],[license,'licenses/formatter/LICENSE'],...RUNTIME.map(name=>[path.join(__dirname,'../update',name),'update/'+name])]) {
      const info=await fs.lstat(source),file={bytes:info.size,sha256:await hashFile(source,info.size,'PACKAGE_INPUT')};
      await copyFile(source,resolveOwned(payload,name),file);
    }
    const evidenceFile=resolveOwned(payload,'evidence/pre-bundle.json');await fs.mkdir(path.dirname(evidenceFile));await fs.writeFile(evidenceFile,encodeRelease(preBundleEvidence),{flag:'wx'});
    const files=await scan(payload,()=>true,'PACKAGE_LAYOUT');validateInventory(files);
    const inventory=resolveOwned(work,'inventory.json');await fs.writeFile(inventory,encodeRelease(files),{flag:'wx'});
    const archivePath=path.join(work,'codexs-windows-x64.zip');await createZip(payload,archivePath,inventory,work);
    await verifyInventory(payload,files,{code:'PACKAGE_CHANGED'});
    const info=await fs.lstat(archivePath);
    if(info.size<1||info.size>256*1024**2)fail('PACKAGE_ARCHIVE');
    const manifestBase={schema:1,repository:'TK-06/codexs',channel:'stable',product_version:native.productVersion,upstream:structuredClone(native.upstream),native_sha:native.sha,overlay_sha:overlay.sha,formatter:{sha:formatter.sha,version:formatterVersion},target:'x86_64-pc-windows-msvc',bootstrap_min:1,node_min:22,archive:{name:'codexs-windows-x64.zip',bytes:info.size,sha256:await hashFile(archivePath,info.size,'PACKAGE_ARCHIVE')},files,packages:structuredClone(native.packages)};
    return {archivePath,manifestBase};
  } catch(error) {
    if(error instanceof UpdateError)throw error;
    fail('PACKAGE_IO');
  }
}
async function assembleEnrollmentPackage(input,outputRoot) {
  try {
    object(input,['controllerSha'],'PACKAGE_IDENTITY');
    if(!matches(input.controllerSha,SHA))fail('PACKAGE_IDENTITY');
    if(typeof outputRoot!=='string'||!path.isAbsolute(outputRoot)||under(__dirname,outputRoot)||under(outputRoot,path.join(__dirname,'../update')))fail('PACKAGE_INPUT');
    resolveOwned(outputRoot,'ancestry-check');
    const sources=[...RUNTIME,'bootstrap.cjs','enroll.ps1'].map(name=>[path.join(__dirname,'../update',name),'update/'+name]);
    sources.push([path.join(__dirname,'../../LICENSE'),'licenses/codex/LICENSE']);
    const inputs=[];
    for(const[source,name]of sources){const info=await fs.lstat(source);inputs.push({source,path:name,bytes:info.size,sha256:await hashFile(source,info.size,'PACKAGE_INPUT')});}
    await fs.mkdir(outputRoot,{recursive:true});const work=resolveOwned(outputRoot,'enrollment-'+randomUUID());await fs.mkdir(work);
    const payload=resolveOwned(work,'payload');await fs.mkdir(payload);
    for(const file of inputs)await copyFile(file.source,resolveOwned(payload,file.path),file);
    const files=await scan(payload,()=>true,'PACKAGE_LAYOUT'),inventory=resolveOwned(work,'inventory.json');
    await fs.writeFile(inventory,encodeRelease(files),{flag:'wx'});
    const archivePath=resolveOwned(work,'codexs-enrollment.zip');await createZip(payload,archivePath,inventory,work);
    await verifyInventory(payload,files,{code:'PACKAGE_CHANGED'});
    const info=await fs.lstat(archivePath);
    if(info.size<1||info.size>256*1024**2)fail('PACKAGE_ARCHIVE');
    return {archivePath,files,bytes:info.size,sha256:await hashFile(archivePath,info.size,'PACKAGE_ARCHIVE'),controller_sha:input.controllerSha};
  } catch(error) {if(error instanceof UpdateError)throw error;fail('PACKAGE_IO');}
}
// Only trusted, SRI-authenticated registry inputs use the Windows-provided bsdtar.
// Candidate packages supply data, never lifecycle commands or a packaging script.
async function extractNpmPackage(input,outputRoot) {
  let scratch;
  try {
    object(input,['archive','integrity'],'PACKAGE_INPUT');
    if(process.platform!=='win32')fail('PACKAGE_PLATFORM');
    if(typeof input.archive!=='string'||!path.isAbsolute(input.archive)||typeof outputRoot!=='string'||!path.isAbsolute(outputRoot)||under(input.archive,outputRoot)||!matches(input.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/)||Buffer.from(input.integrity.slice(7),'base64').toString('base64')!==input.integrity.slice(7))fail('PACKAGE_INPUT');
    resolveOwned(outputRoot,'ancestry-check');resolveOwned(path.dirname(input.archive),path.basename(input.archive));
    const info=await fs.lstat(input.archive);
    if(!info.isFile()||info.size<1||info.size>256*1024**2)fail('PACKAGE_INTEGRITY');
    // Make the inspected/extracted input the same immutable, privately owned copy.
    scratch=await fs.mkdtemp(path.join(path.dirname(outputRoot),'.codexs-npm-'));
    const archive=resolveOwned(scratch,'input.tgz');await fs.copyFile(input.archive,archive,constants.COPYFILE_EXCL);
    const hash=createHash('sha512');for await(const chunk of createReadStream(archive))hash.update(chunk);
    if('sha512-'+hash.digest('base64')!==input.integrity)fail('PACKAGE_INTEGRITY');
    const tar=path.join(process.env.SystemRoot,'System32/tar.exe'),options={windowsHide:true,timeout:60000,maxBuffer:8*1024**2,encoding:'utf8'};
    const listing=(await execFile(tar,['-tf',archive],options)).stdout.trimEnd().split(/\r?\n/);
    const details=(await execFile(tar,['-tvf',archive,'--numeric-owner'],options)).stdout.trimEnd().split(/\r?\n/);
    if(!listing.length||listing.length>10000||listing.length!==details.length)fail('PACKAGE_ARCHIVE');
    const entries=[],names=new Set();let total=0;
    for(let i=0;i<listing.length;i++) {
      const match=details[i].match(/^([d-][^ ]*)\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/);
      if(!match||match[3]!==listing[i])fail('PACKAGE_ARCHIVE');
      const directory=match[1][0]==='d',name=listing[i].replace(directory?/\/$/:/$^/,'');
      if(name!=='package'&&!name.startsWith('package/'))fail('PACKAGE_ARCHIVE');
      resolveOwned(scratch,name);
      const normalized=name.normalize('NFC').toLowerCase(),bytes=Number(match[2]);
      if(names.has(normalized)||!Number.isSafeInteger(bytes)||bytes<0||directory&&bytes!==0)fail('PACKAGE_ARCHIVE');
      names.add(normalized);total+=bytes;if(total>2*1024**3)fail('PACKAGE_ARCHIVE');
      entries.push({path:name,bytes,directory});
    }
    const files=entries.filter(entry=>!entry.directory).map(({path:name,bytes})=>({path:name,bytes,sha256:'0'.repeat(64)}));
    validateInventory(files);
    const fileNames=new Set(files.map(file=>file.path.normalize('NFC').toLowerCase()));
    for(const entry of entries)for(let cursor=entry.path;cursor.includes('/');){cursor=cursor.slice(0,cursor.lastIndexOf('/'));if(fileNames.has(cursor.normalize('NFC').toLowerCase()))fail('PACKAGE_ARCHIVE');}
    const content=resolveOwned(scratch,'content');await fs.mkdir(content);
    await execFile(tar,['-xf',archive,'-C',content,'--no-same-owner','--no-same-permissions'],options);
    const tree=await scan(content,()=>true,'PACKAGE_ARCHIVE');
    if(tree.length!==files.length||tree.some(file=>!files.some(expected=>file.path===expected.path&&file.bytes===expected.bytes)))fail('PACKAGE_ARCHIVE');
    await fs.mkdir(outputRoot,{recursive:true});const destination=resolveOwned(outputRoot,'npm-'+randomUUID());
    const packageRoot=resolveOwned(content,'package');resolveOwned(scratch,'content/package');
    await fs.rename(packageRoot,destination);
    return destination;
  } catch(error){if(error instanceof UpdateError)throw error;fail('PACKAGE_ARCHIVE');}
  finally {
    if(scratch){const parent=path.resolve(path.dirname(outputRoot));if(path.dirname(path.resolve(scratch))!==parent||!path.basename(scratch).startsWith('.codexs-npm-'))fail('PACKAGE_INPUT');await fs.rm(scratch,{recursive:true,maxRetries:10,retryDelay:100});}
  }
}
async function prepareNativeTree(input,outputRoot) {
  try {
    object(input,['candidate','main','helper','native','license','notice'],'PACKAGE_INPUT');
    const {candidate,main,helper,native,license,notice}=input;
    object(candidate,['sha','upstream_sha','version'],'PACKAGE_IDENTITY');
    if(!matches(candidate.sha,SHA)||!matches(candidate.upstream_sha,SHA)||!version(candidate.version)||[native,license,notice].some(value=>!Buffer.isBuffer(value)||!value.length)||native.length>512*1024**2||license.length>4*1024**2||notice.length>4*1024**2)fail('PACKAGE_INPUT');
    for(const pkg of [main,helper])object(pkg,['archive','metadata'],'PACKAGE_METADATA');
    const upstream=require('../upstream/upstream.cjs').selectUpstream([{draft:false,prerelease:false,tag_name:'rust-v'+candidate.version,sha:candidate.upstream_sha}],main.metadata,helper.metadata);
    if(!upstream)fail('PACKAGE_METADATA');
    const mainRoot=await extractNpmPackage({archive:main.archive,integrity:upstream.packages.main.integrity},outputRoot);
    const helperRoot=await extractNpmPackage({archive:helper.archive,integrity:upstream.packages.helper.integrity},outputRoot);
    const packages={main:await json(resolveOwned(mainRoot,'package.json'),'PACKAGE_METADATA'),helper:await json(resolveOwned(helperRoot,'package.json'),'PACKAGE_METADATA')};
    const extracted=require('../upstream/upstream.cjs').selectUpstream([{draft:false,prerelease:false,tag_name:upstream.tag,sha:upstream.sha}],{...packages.main,dist:{integrity:upstream.packages.main.integrity}},{...packages.helper,dist:{integrity:upstream.packages.helper.integrity}});
    if(!extracted)fail('PACKAGE_METADATA');
    const vendor=resolveOwned(helperRoot,'vendor/x86_64-pc-windows-msvc'),files=await scan(vendor,nativePath,'PACKAGE_LAYOUT');
    await peX64(resolveOwned(vendor,'bin/codex.exe'));
    const tree=resolveOwned(outputRoot,'native-'+randomUUID());await fs.mkdir(tree);
    for(const file of files)if(file.path!=='bin/codex.exe')await copyFile(resolveOwned(vendor,file.path),resolveOwned(tree,file.path),file);
    await fs.mkdir(resolveOwned(tree,'bin'),{recursive:true});await fs.writeFile(resolveOwned(tree,'bin/codex.exe'),native,{flag:'wx'});
    for(const [kind,metadata]of Object.entries(packages)){
      const target=resolveOwned(tree,'packages/'+kind+'/package.json');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,encodeRelease(metadata),{flag:'wx'});
    }
    for(const kind of ['codex','helpers']){
      const directory=resolveOwned(tree,'licenses/'+kind);await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(resolveOwned(directory,'LICENSE'),license,{flag:'wx'});await fs.writeFile(resolveOwned(directory,'NOTICE'),notice,{flag:'wx'});
    }
    for(const file of await scan(tree,nativePath,'PACKAGE_LAYOUT'))if(/\.(exe|dll)$/i.test(file.path))await peX64(resolveOwned(tree,file.path));
    return {root:tree,sha:candidate.sha,upstream:{version:upstream.version,tag:upstream.tag,sha:upstream.sha},packages:upstream.packages};
  }catch(error){if(error instanceof UpdateError)throw error;if(error?.name==='UpdateError')fail('PACKAGE_METADATA');fail('PACKAGE_IO');}
}
async function fetchOfficialPackages(sourceVersion,outputRoot,ports={}) {
  try {
    if(!version(sourceVersion)||typeof outputRoot!=='string'||!path.isAbsolute(outputRoot)||ports.fetch!==undefined&&typeof ports.fetch!=='function')fail('PACKAGE_INPUT');
    resolveOwned(outputRoot,'ancestry-check');
    const request=ports.fetch||globalThis.fetch,packages={};
    for(const kind of ['main','helper']) {
      const version=sourceVersion+(kind==='helper'?'-win32-x64':''),tarball='https://registry.npmjs.org/@openai/codex/-/codex-'+version+'.tgz';
      const options={method:'GET',redirect:'error',credentials:'omit',headers:{'User-Agent':'codexs-release-package'},signal:AbortSignal.timeout(60000)};
      const response=await request('https://registry.npmjs.org/@openai%2fcodex/'+version,options);
      if(response.status!==200||!response.body)fail('PACKAGE_HTTP');
      const chunks=[];let size=0;
      for await(const part of response.body){size+=part.length;if(size>2*1024**2)fail('PACKAGE_HTTP');chunks.push(Buffer.from(part));}
      const metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(metadata.name!=='@openai/codex'||metadata.version!==version||metadata.dist?.tarball!==tarball||!matches(metadata.dist?.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/))fail('PACKAGE_METADATA');
      const archiveResponse=await request(tarball,{...options,signal:AbortSignal.timeout(60000)});
      if(archiveResponse.status!==200||!archiveResponse.body)fail('PACKAGE_HTTP');
      const declared=archiveResponse.headers.get('content-length');
      if(declared!==null&&(!/^[1-9]\d*$/.test(declared)||Number(declared)>256*1024**2))fail('PACKAGE_HTTP');
      await fs.mkdir(outputRoot,{recursive:true});const archive=resolveOwned(outputRoot,kind+'-'+randomUUID()+'.tgz'),handle=await fs.open(archive,'wx'),hash=createHash('sha512');size=0;
      try {
        for await(const part of archiveResponse.body){const chunk=Buffer.from(part);size+=chunk.length;if(size>256*1024**2)fail('PACKAGE_HTTP');hash.update(chunk);let offset=0;while(offset<chunk.length){const written=await handle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)fail('PACKAGE_IO');offset+=written.bytesWritten;}}
        if(!size||declared!==null&&size!==Number(declared)||'sha512-'+hash.digest('base64')!==metadata.dist.integrity)fail('PACKAGE_INTEGRITY');
      }finally{await handle.close();}
      packages[kind]={archive,metadata};
    }
    if(!require('../upstream/upstream.cjs').selectUpstream([{draft:false,prerelease:false,tag_name:'rust-v'+sourceVersion,sha:'0'.repeat(40)}],packages.main.metadata,packages.helper.metadata))fail('PACKAGE_METADATA');
    return packages;
  }catch(error){if(error instanceof UpdateError)throw error;fail('PACKAGE_HTTP');}
}
module.exports={assembleBundle,assembleEnrollmentPackage,extractNpmPackage,prepareNativeTree,fetchOfficialPackages};
