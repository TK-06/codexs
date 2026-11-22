'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assembleBundle, assembleEnrollmentPackage, extractNpmPackage, prepareNativeTree, fetchOfficialPackages } = require('./package.cjs');
const { releaseManifest, fixtureTempRoot } = require('../test-support/update-fixtures.cjs');

async function fixture(t) {
  const parent = fixtureTempRoot(), root = await fs.mkdtemp(path.join(parent, 'codexs-package-test-'));
  t.after(async () => {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('codexs-package-test-')) throw Error('Unsafe package fixture cleanup');
    await fs.rm(root, { recursive:true, maxRetries:10, retryDelay:100 });
  });
  const manifest = releaseManifest(), nativeRoot = path.join(root,'native'), formatterRoot = path.join(root,'formatter');
  const pe = Buffer.alloc(72); pe.write('MZ'); pe.writeUInt32LE(64,60); pe.writeUInt32LE(0x4550,64); pe.writeUInt16LE(0x8664,68);
  const payload = {
    'bin/codex.exe':pe, 'codex-path/rg.exe':pe,
    'codex-resources/codex-command-runner.exe':pe, 'codex-resources/codex-windows-sandbox-setup.exe':pe,
    'codex-package.json':JSON.stringify({layoutVersion:1,version:'0.166.0',target:'x86_64-pc-windows-msvc',variant:'codex',entrypoint:'bin/codex.exe',resourcesDir:'codex-resources',pathDir:'codex-path'}),
    'packages/main/package.json':JSON.stringify({name:'@openai/codex',version:'0.166.0',optionalDependencies:{'@openai/codex-win32-x64':'npm:@openai/codex@0.166.0-win32-x64'}}),
    'packages/helper/package.json':JSON.stringify({name:'@openai/codex',version:'0.166.0-win32-x64',os:['win32'],cpu:['x64']}),
    'licenses/codex/LICENSE':'synthetic native license', 'licenses/helpers/LICENSE':'synthetic helper license',
  };
  for (const [name,value] of Object.entries(payload)) { const target=path.join(nativeRoot,...name.split('/')); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,value); }
  await fs.mkdir(path.join(formatterRoot,'dist','chunks'),{recursive:true});
  await fs.writeFile(path.join(formatterRoot,'dist','ccstatusline.js'), 'import {theme} from "./chunks/theme.js"; console.log(theme);\n');
  await fs.writeFile(path.join(formatterRoot,'dist','chunks','theme.js'), 'export const theme = "synthetic";\n');
  await fs.writeFile(path.join(formatterRoot,'package.json'), JSON.stringify({name:'ccstatusline',version:'2.2.32',type:'module'}));
  await fs.writeFile(path.join(formatterRoot,'LICENSE'), 'synthetic formatter license');
  const preBundleEvidence=structuredClone(manifest.evidence); delete preBundleEvidence.suites.bundle;
  const input = {
    nativeTree:{root:nativeRoot,sha:manifest.native_sha,upstream:manifest.upstream,packages:manifest.packages,productVersion:'1.0.0'},
    formatterDist:path.join(formatterRoot,'dist'), formatterPackage:{path:path.join(formatterRoot,'package.json'),sha:manifest.formatter.sha,version:'2.2.32'},
    overlay:{sha:manifest.overlay_sha,metadata:{schema:1,base_sha:manifest.upstream.sha,accepted_sha:manifest.native_sha,patch_sha256:'e'.repeat(64),paths:['codex-rs/cli/src/main.rs'],formatter_sha:manifest.formatter.sha,required_suites:['feature','full','config','build']}},
    preBundleEvidence,
  };
  return {root,input,outputRoot:path.join(root,'output'),nativeRoot,formatterRoot};
}

test('complete assembly preserves native layout, all formatter chunks, metadata, runtime modules and licenses', async t => {
  const f = await fixture(t), draft = await assembleBundle(f.input,f.outputRoot), m=draft.manifestBase;
  assert.deepEqual(Object.keys(draft).sort(),['archivePath','manifestBase']);
  assert.equal(m.product_version,'1.0.0'); assert.equal(m.native_sha,'b'.repeat(40));
  assert.deepEqual(m.formatter,{sha:'d'.repeat(40),version:'2.2.32'});
  for(const key of ['sequence','release_id','evidence']) assert.equal(Object.hasOwn(m,key),false);
  const names=m.files.map(file=>file.path);
  for(const name of ['bin/codex.exe','codex-package.json','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe','formatter/package.json','formatter/dist/ccstatusline.js','formatter/dist/chunks/theme.js','licenses/formatter/LICENSE','licenses/codex/LICENSE','evidence/pre-bundle.json',...['launch.cjs','protocol.cjs','paths.cjs','state.cjs','http.cjs','stage.cjs','coordinator.ps1','archive.ps1'].map(name=>'update/'+name)]) assert.ok(names.includes(name),name);
  assert.equal(names.some(name=>/node_modules|\.test\.|\.Tests\.|release\.sig|release\.json|\.snap/.test(name)),false);
  const bytes=await fs.readFile(draft.archivePath);
  assert.equal(m.archive.name,'codexs-windows-x64.zip'); assert.equal(m.archive.bytes,bytes.length);
  assert.equal(m.archive.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.notEqual(m.archive.sha256,m.files.find(file=>file.path==='bin/codex.exe').sha256);
  assert.deepEqual(names,[...names].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
});

test('identical inputs produce identical ZIP bytes and file inventories', async t => {
  const f=await fixture(t), a=await assembleBundle(f.input,f.outputRoot), b=await assembleBundle(f.input,f.outputRoot);
  assert.notEqual(a.archivePath,b.archivePath);
  assert.deepEqual(a.manifestBase,b.manifestBase);
  assert.deepEqual(await fs.readFile(a.archivePath),await fs.readFile(b.archivePath));
});

for(const name of ['bin/codex.exe','codex-package.json','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe','packages/helper/package.json','licenses/helpers/LICENSE']) {
  test('assembly rejects missing native input '+name,async t=>{
    const f=await fixture(t);await fs.unlink(path.join(f.nativeRoot,...name.split('/')));
    await assert.rejects(assembleBundle(f.input,f.outputRoot),error=>error.name==='UpdateError'&&/^PACKAGE_/.test(error.code));
  });
}

test('assembly rejects a missing statically imported formatter chunk',async t=>{
  const f=await fixture(t);await fs.unlink(path.join(f.formatterRoot,'dist/chunks/theme.js'));
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_FORMATTER'});
});

test('formatter dependency checks ignore import-like text inside strings comments and regex literals',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),[
    'const description = "from \'./descriptive.js\'";',
    '// import "./comment-only.js";',
    '/* from "./block-comment.js" */',
    'const expression = /import"fake-module"/;',
    'import {theme} from "./chunks/theme.js"; console.log(theme,description,expression);',
  ].join('\n'));
  assert.ok((await assembleBundle(f.input,f.outputRoot)).manifestBase.files.some(file=>file.path==='formatter/dist/chunks/theme.js'));
});

test('literal dynamic imports inside template expressions still require their emitted chunks',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),'const value = `${await import("./chunks/absent.js")}`;\n');
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_FORMATTER'});
});

test('formatter dependency checks distinguish division after numeric literals from regex literals',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),'const interval = 1000 / 60;\nimport {theme} from "./chunks/theme.js"; console.log(interval,theme);\n');
  assert.equal((await assembleBundle(f.input,f.outputRoot)).manifestBase.formatter.version,'2.2.32');
});

test('formatter dependency checks accept Unicode code-point escapes in emitted JavaScript',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),'const icon = "\\u{1f680}";\nimport {theme} from "./chunks/theme.js"; console.log(icon,theme);\n');
  assert.ok((await assembleBundle(f.input,f.outputRoot)).manifestBase.files.length>0);
});

test('formatter dependency checks ignore regex import-like text after a control-flow condition',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),'if (true) /import"not-a-module"/.test("synthetic");\nimport {theme} from "./chunks/theme.js"; console.log(theme);\n');
  assert.ok((await assembleBundle(f.input,f.outputRoot)).manifestBase.files.length>0);
});

test('assembly rejects ESM metadata or package version disagreement',async t=>{
  for(const metadata of [{name:'ccstatusline',version:'2.2.32'},{name:'ccstatusline',version:'2.2.31',type:'module'}]) {
    const f=await fixture(t);await fs.writeFile(f.input.formatterPackage.path,JSON.stringify(metadata));
    await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_FORMATTER'});
  }
});

test('assembly rejects development files rather than silently shipping them',async t=>{
  for(const name of ['src/dev.ts','dist/debug.snap.new','dist/node_modules/secret.js']) {
    const f=await fixture(t),target=path.join(f.nativeRoot,...name.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'synthetic');
    await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_LAYOUT'});
  }
});

test('assembly refuses a conflicting native, upstream or formatter evidence identity',async t=>{
  for(const field of ['candidate_sha','upstream_sha','formatter_sha']) {
    const f=await fixture(t);f.input.preBundleEvidence[field]='f'.repeat(40);
    await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_IDENTITY'});
  }
});

test('assembly accepts the real overlay descriptor and enforces its formatter pin and required suites',async t=>{
  const f=await fixture(t),actual=JSON.parse(await fs.readFile(path.join(__dirname,'../upstream/overlay.json'),'utf8'));
  f.input.overlay.metadata={...actual,base_sha:'a'.repeat(40),accepted_sha:'b'.repeat(40),formatter_sha:'d'.repeat(40)};
  assert.equal((await assembleBundle(f.input,f.outputRoot)).manifestBase.formatter.sha,'d'.repeat(40));
  f.input.overlay.metadata.formatter_sha='e'.repeat(40);
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_IDENTITY'});
  f.input.overlay.metadata.formatter_sha='d'.repeat(40);f.input.overlay.metadata.required_suites=['feature'];
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_IDENTITY'});
});

for(const [name,source,extra]of [
  ['literal template import','await import(`./missing.js`);',null],
  ['mjs child','import "./chunks/theme.mjs";',['chunks/theme.mjs','import "./absent.mjs";']],
  ['computed module','const target="./chunks/theme.js";await import(target);',null],
  ['computed suffix','await import("./chunks/theme.js"+".absent");',null],
  ['unknown builtin','import "node:codexs_missing_builtin";',null],
])test('formatter closure rejects '+name,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),source);
  if(extra)await fs.writeFile(path.join(f.formatterRoot,'dist',extra[0]),extra[1]);
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_FORMATTER'});
});

test('formatter closure accepts a complete literal template import',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.formatterRoot,'dist/ccstatusline.js'),'await import(`./chunks/theme.js`);');
  assert.ok((await assembleBundle(f.input,f.outputRoot)).manifestBase.files.length);
});

test('assembly does not accept invented final bundle evidence as an input',async t=>{
  const f=await fixture(t);f.input.preBundleEvidence.suites.bundle={passed:12,failed:0,ignored:0,exit:0};
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_EVIDENCE'});
});

test('assembly rejects wrong helper architecture and version before any candidate execution',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.nativeRoot,'packages/helper/package.json'),JSON.stringify({name:'@openai/codex',version:'0.165.0-win32-x64',os:['win32'],cpu:['arm64']}));
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_METADATA'});
});

test('vendor layout metadata must match the selected version target and entrypoint',async t=>{
  for(const change of [{version:'0.165.0'},{layoutVersion:2},{target:'aarch64-pc-windows-msvc'},{entrypoint:'../outside.exe'}]){
    const f=await fixture(t),target=path.join(f.nativeRoot,'codex-package.json'),metadata=JSON.parse(await fs.readFile(target,'utf8'));
    await fs.writeFile(target,JSON.stringify({...metadata,...change}));
    await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_METADATA'});
  }
});

test('assembly preserves code-mode and voice helpers along with their manifests and third-party notices',async t=>{
  const f=await fixture(t);
  const names=['bin/codex-code-mode-host.exe','codex-resources/voice/bin/gstapp.dll','codex-resources/voice/manifest.json','codex-resources/voice/NOTICE.md','codex-resources/voice/licenses/LGPL-2.1.txt'];
  for(const name of names){const target=path.join(f.nativeRoot,...name.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,/\.(exe|dll)$/.test(name)?await fs.readFile(path.join(f.nativeRoot,'bin/codex.exe')):'synthetic vendor file, never executed');}
  const result=await assembleBundle(f.input,f.outputRoot);
  for(const name of names)assert.ok(result.manifestBase.files.some(file=>file.path===name),name);
});

test('additional vendor executables and DLLs must also be Windows x64 PE files',async t=>{
  const f=await fixture(t),target=path.join(f.nativeRoot,'codex-resources/voice/bin/gstapp.dll'),pe=await fs.readFile(path.join(f.nativeRoot,'bin/codex.exe'));
  pe.writeUInt16LE(0xaa64,68);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,pe);
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_ARCHITECTURE'});
});

test('assembly rejects a non-x64 PE helper',async t=>{
  const f=await fixture(t),target=path.join(f.nativeRoot,'codex-path/rg.exe'),pe=await fs.readFile(target);pe.writeUInt16LE(0xaa64,68);await fs.writeFile(target,pe);
  await assert.rejects(assembleBundle(f.input,f.outputRoot),{code:'PACKAGE_ARCHITECTURE'});
});

test('assembly refuses an output nested in its inputs and preserves caller files',async t=>{
  const f=await fixture(t),sentinel=path.join(f.nativeRoot,'sentinel');await fs.writeFile(sentinel,'keep');
  await assert.rejects(assembleBundle(f.input,path.join(f.nativeRoot,'output')),error=>error.name==='UpdateError');
  assert.equal(await fs.readFile(sentinel,'utf8'),'keep');
});

test('one-time enrollment is packaged separately with the reviewed verifier and complete operational closure',async t=>{
  const f=await fixture(t),enrollment=await assembleEnrollmentPackage({controllerSha:'c'.repeat(40)},f.outputRoot);
  assert.equal(path.basename(enrollment.archivePath),'codexs-enrollment.zip');
  assert.equal(enrollment.controller_sha,'c'.repeat(40));
  const names=enrollment.files.map(file=>file.path);
  assert.equal(names.length,11);
  for(const name of ['bootstrap.cjs','enroll.ps1','protocol.cjs','paths.cjs','state.cjs','http.cjs','stage.cjs','launch.cjs','archive.ps1','coordinator.ps1'])assert.ok(names.includes('update/'+name),name);
  assert.equal(names.some(name=>/\.test\.|\.Tests\.|private|release-public-key|config\.json|codex\.exe/.test(name)),false);
  const raw=await fs.readFile(enrollment.archivePath);
  assert.equal(enrollment.bytes,raw.length);assert.equal(enrollment.sha256,createHash('sha256').update(raw).digest('hex'));
  const regular=await assembleBundle(f.input,f.outputRoot);
  assert.equal(regular.manifestBase.files.some(file=>/update\/(?:bootstrap\.cjs|enroll\.ps1)/.test(file.path)),false);
});

test('enrollment packaging rejects coercible or absent controller identity before writing output',async t=>{
  const f=await fixture(t);
  for(const controllerSha of ['',null,['c'.repeat(40)]])await assert.rejects(assembleEnrollmentPackage({controllerSha},f.outputRoot),{code:'PACKAGE_IDENTITY'});
  await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
});

// Minimal synthetic ustar archives; none of their contents are executable.
function npmTar(entries) {
  const blocks=[];
  for(const entry of entries) {
    const data=Buffer.from(entry.data||''),header=Buffer.alloc(512);
    header.write(entry.name,0,100,'utf8');header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
    header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);
    header.write(entry.type||'0',156);if(entry.link)header.write(entry.link,157,100,'utf8');header.write('ustar\0',257);header.write('00',263);
    header.write([...header].reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);
    blocks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  return require('node:zlib').gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
async function npmFixture(t,entries) {
  const f=await fixture(t),archive=path.join(f.root,'package.tgz'),bytes=npmTar(entries);
  await fs.writeFile(archive,bytes);
  return {...f,archive,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')};
}

test('official-package extraction verifies SRI and preserves complete regular-file contents',async t=>{
  const f=await npmFixture(t,[{name:'package/package.json',data:'{"name":"synthetic"}'},{name:'package/vendor/notice.txt',data:'synthetic notice'}]);
  assert.equal(typeof extractNpmPackage,'function');
  const result=await extractNpmPackage({archive:f.archive,integrity:f.integrity},f.outputRoot);
  assert.equal(await fs.readFile(path.join(result,'package.json'),'utf8'),'{"name":"synthetic"}');
  assert.equal(await fs.readFile(path.join(result,'vendor/notice.txt'),'utf8'),'synthetic notice');
  assert.ok(result.startsWith(f.outputRoot+path.sep));
});

test('official-package extraction rejects wrong integrity before creating output',async t=>{
  const f=await npmFixture(t,[{name:'package/package.json',data:'{}'}]);
  assert.equal(typeof extractNpmPackage,'function');
  await assert.rejects(extractNpmPackage({archive:f.archive,integrity:'sha512-'+Buffer.alloc(64).toString('base64')},f.outputRoot),{code:'PACKAGE_INTEGRITY'});
  await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
});

for(const [name,entries] of Object.entries({
  traversal:[{name:'package/../escape',data:'bad'}],
  outside:[{name:'outside/file',data:'bad'}],
  symlink:[{name:'package/package.json',data:'{}'},{name:'package/link',type:'2',link:'../../outside'}],
  hardlink:[{name:'package/package.json',data:'{}'},{name:'package/link',type:'1',link:'package/package.json'}],
  device:[{name:'package/device',type:'3'}],
  collision:[{name:'package/A',data:'one'},{name:'package/a',data:'two'}],
  parent:[{name:'package/a',data:'one'},{name:'package/a/child',data:'two'}],
}))test('official-package extraction rejects '+name+' without writing an extracted tree',async t=>{
  const f=await npmFixture(t,entries);
  assert.equal(typeof extractNpmPackage,'function');
  await assert.rejects(extractNpmPackage({archive:f.archive,integrity:f.integrity},f.outputRoot),error=>error.name==='UpdateError');
  await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
});

async function nativePreparation(t,{omitOriginal=false,badOriginal=false}={}) {
  const f=await fixture(t),pkg={};
  for(const kind of ['main','helper']) {
    const metadata=JSON.parse(await fs.readFile(path.join(f.nativeRoot,'packages',kind,'package.json'),'utf8'));
    const entries=[{name:'package/package.json',data:JSON.stringify(metadata)}];
    if(kind==='helper')for(const name of ['bin/codex.exe','bin/codex-code-mode-host.exe','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe','codex-package.json'])entries.push({name:'package/vendor/x86_64-pc-windows-msvc/'+name,data:await fs.readFile(path.join(f.nativeRoot,name==='bin/codex-code-mode-host.exe'?'bin/codex.exe':name))});
    const original=entries.find(entry=>entry.name.endsWith('/bin/codex.exe'));
    if(original&&badOriginal)original.data=Buffer.from('synthetic non-PE original entrypoint');
    const raw=npmTar(omitOriginal?entries.filter(entry=>entry!==original):entries),archive=path.join(f.root,kind+'.tgz');await fs.writeFile(archive,raw);
    pkg[kind]={archive,metadata:{...metadata,dist:{integrity:'sha512-'+createHash('sha512').update(raw).digest('base64')}}};
  }
  return {...f,input:{candidate:{sha:'b'.repeat(40),upstream_sha:'a'.repeat(40),version:'0.166.0'},...pkg,native:await fs.readFile(path.join(f.nativeRoot,'bin/codex.exe')),license:Buffer.from('synthetic upstream license'),notice:Buffer.from('synthetic upstream notice')}};
}

test('native preparation preserves all helper files and replaces only the staged native executable',async t=>{
  const f=await nativePreparation(t);f.input.native=Buffer.concat([f.input.native,Buffer.from('accepted candidate')]);
  assert.equal(typeof prepareNativeTree,'function');
  const prepared=await prepareNativeTree(f.input,f.outputRoot);
  assert.deepEqual(await fs.readFile(path.join(prepared.root,'bin/codex.exe')),f.input.native);
  assert.notDeepEqual(await fs.readFile(path.join(prepared.root,'bin/codex-code-mode-host.exe')),f.input.native);
  assert.equal(await fs.readFile(path.join(prepared.root,'licenses/codex/NOTICE'),'utf8'),'synthetic upstream notice');
  assert.equal(prepared.packages.helper.integrity,f.input.helper.metadata.dist.integrity);
  assert.equal(prepared.sha,f.input.candidate.sha);
});

test('native preparation rejects unpaired package metadata and missing license inputs',async t=>{
  const f=await nativePreparation(t);
  assert.equal(typeof prepareNativeTree,'function');
  for(const change of [{license:Buffer.alloc(0)},{helper:{...f.input.helper,metadata:{...f.input.helper.metadata,version:'0.165.0-win32-x64'}}}])await assert.rejects(prepareNativeTree({...f.input,...change},f.outputRoot),error=>error.name==='UpdateError');
});

for(const options of [{omitOriginal:true},{badOriginal:true}])test('native preparation validates the original entrypoint before replacing it '+JSON.stringify(options),async t=>{
  const f=await nativePreparation(t,options);
  await assert.rejects(prepareNativeTree(f.input,f.outputRoot),error=>error.name==='UpdateError');
});

test('official-package downloads use fixed registry routes and authenticate both archives without scripts',async t=>{
  const f=await nativePreparation(t),calls=[];
  assert.equal(typeof fetchOfficialPackages,'function');
  const fetch=async(url,options)=>{
    calls.push(url);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);
    const kind=url.includes('-win32-x64')?'helper':'main',metadata={...f.input[kind].metadata,dist:{...f.input[kind].metadata.dist,tarball:'https://registry.npmjs.org/@openai/codex/-/codex-'+f.input[kind].metadata.version+'.tgz'}};
    return url.endsWith('.tgz')?new Response(await fs.readFile(f.input[kind].archive)):Response.json(metadata);
  };
  const result=await fetchOfficialPackages('0.166.0',f.outputRoot,{fetch});
  assert.equal(calls.length,4);assert.equal(calls[0],'https://registry.npmjs.org/@openai%2fcodex/0.166.0');
  for(const kind of ['main','helper'])assert.deepEqual(await fs.readFile(result[kind].archive),await fs.readFile(f.input[kind].archive));
});

test('official-package downloads reject redirected package URLs and mismatched integrity',async t=>{
  const f=await nativePreparation(t);
  assert.equal(typeof fetchOfficialPackages,'function');
  for(const bad of ['url','integrity']){
    const fetch=async url=>{
      if(url.endsWith('.tgz'))return new Response('substituted bytes');
      const metadata=f.input.main.metadata;
      return Response.json({...metadata,dist:{...metadata.dist,tarball:bad==='url'?'https://example.invalid/package.tgz':'https://registry.npmjs.org/@openai/codex/-/codex-0.166.0.tgz'}});
    };
    await assert.rejects(fetchOfficialPackages('0.166.0',f.outputRoot,{fetch}),error=>error.name==='UpdateError');
  }
});

async function hostedPreparation(t,extra={}) {
  const f=await nativePreparation(t),{evidenceFixture,evidenceZip}=require('../test-support/update-fixtures.cjs'),acceptance=evidenceFixture();
  if(extra.native)f.input.native=extra.native;
  const controller=path.join(f.root,'controller');await fs.mkdir(path.join(controller,'codexs/upstream'),{recursive:true});await fs.mkdir(path.join(controller,'native-source'),{recursive:true});
  for(const [name,value]of [['LICENSE',f.input.license],['NOTICE',f.input.notice]])await fs.writeFile(path.join(controller,'native-source',name),value);
  const patch=Buffer.from('synthetic patch'),actualOverlay=JSON.parse(await fs.readFile(path.join(__dirname,'../upstream/overlay.json'),'utf8'));
  const overlay={...actualOverlay,base_sha:'a'.repeat(40),accepted_sha:'b'.repeat(40),formatter_sha:'d'.repeat(40),patch_sha256:createHash('sha256').update(patch).digest('hex')};
  await fs.writeFile(path.join(controller,'codexs/upstream/overlay.json'),JSON.stringify(overlay));await fs.writeFile(path.join(controller,'codexs/upstream/overlay.patch'),patch);
  const build=acceptance.input.runs.find(ref=>ref.scope==='build'),binary=evidenceZip({'codex.exe':f.input.native});
  acceptance.bytes.set(build.binary_artifact,binary);Object.assign(acceptance.artifacts.get(build.binary_artifact),{size_in_bytes:binary.length,digest:'sha256:'+createHash('sha256').update(binary).digest('hex')});acceptance.replaceFiles('build',()=>{});
  const dist=extra.formatter||await fs.readFile(path.join(f.formatterRoot,'dist/ccstatusline.js'));
  const formatterArtifact=acceptance.addDistributionArtifact('formatter',{'dist/ccstatusline.js':dist,'dist/chunks/theme.js':await fs.readFile(path.join(f.formatterRoot,'dist/chunks/theme.js')),'package.json':await fs.readFile(path.join(f.formatterRoot,'package.json')),LICENSE:'synthetic formatter license'});
  const request={runs:acceptance.input.runs.filter(ref=>ref.scope!=='bundle'),formatter_artifact:formatterArtifact};
  const content=await fs.readFile(path.join(__dirname,'../../.github/workflows/codexs-statusline.yml'),'utf8');
  const workflow=(extra.crlf?content.replace(/\r?\n/g,'\r\n'):content).replace(/\r\n?/g,'\n'),job=workflow.match(/^  bundle_acceptance:\r?\n([\s\S]*?)(?=^  [a-z_]+:|$(?![\s\S]))/m);
  assert.ok(job,'missing actual bundle preparation job');
  const match=job[1].match(/\$program=@'\r?\n([\s\S]*?)\r?\n          '@/);assert.ok(match,'missing actual bundle preparation program');
  const program=match[1].replace(/^          /gm,''),env={...process.env,GITHUB_WORKSPACE:controller,RUNNER_TEMP:f.root,GITHUB_OUTPUT:path.join(f.root,'outputs'),GITHUB_ENV:path.join(f.root,'env'),GITHUB_SHA:'c'.repeat(40),GH_TOKEN:'synthetic-read-token',CODEXS_NATIVE_SHA:'b'.repeat(40),CODEXS_UPSTREAM_SHA:'a'.repeat(40),CODEXS_SOURCE_VERSION:'0.166.0',CODEXS_FORMATTER_SHA:'d'.repeat(40),CODEXS_FORMATTER_VERSION:'2.2.32',CODEXS_PRODUCT_VERSION:'1.0.0',CODEXS_EVIDENCE_REQUEST:JSON.stringify(request)};
  const fakeProcess={env,stdout:{write(){}},stderr:{write(text){throw Error(text);}},exitCode:0};
  const original=require;
  await new Function('require','process',program.replace('(async()=>','return (async()=>'))(function(name){
    if(name===path.join(controller,'codexs/release/evidence.cjs'))return {...original('./evidence.cjs'),createGithubClient:()=>acceptance.github};
    if(name===path.join(controller,'codexs/release/package.cjs'))return {...original('./package.cjs'),fetchOfficialPackages:async()=>({main:f.input.main,helper:f.input.helper})};
    if(name.startsWith(controller+path.sep))return original(path.join(__dirname,'../..',path.relative(controller,name)));
    return original(name);
  },fakeProcess);
  assert.equal(fakeProcess.exitCode,0);assert.equal(env.GH_TOKEN,undefined);
  const outputs=await fs.readFile(env.GITHUB_OUTPUT,'utf8'),draftPath=outputs.match(/^draft_path=(.+)$/m)?.[1];assert.ok(draftPath);
  const manifest=JSON.parse(await fs.readFile(path.join(draftPath,'manifest-base.json'),'utf8'));
  assert.equal(manifest.native_sha,'b'.repeat(40));assert.equal(manifest.formatter.sha,'d'.repeat(40));
  assert.equal(manifest.files.some(file=>file.path==='bin/codex-code-mode-host.exe'),true);
  assert.equal(manifest.archive.sha256,createHash('sha256').update(await fs.readFile(path.join(draftPath,'codexs-windows-x64.zip'))).digest('hex'));
  return {...f,env,work:outputs.match(/^work_path=(.+)$/m)[1],draftPath,manifest,job:job[1]};
}

test('actual hosted bundle preparation consumes verified inputs and emits a complete draft without executing native code',async t=>{
  await hostedPreparation(t);
});

async function extractedGate(t,extra={}) {
  const {probeInstallation}=require('../test-support/update-fixtures.cjs'),probe=await probeInstallation(t);
  const native=await fs.readFile(path.join(probe.root,'synthetic-probe.exe'));
  const formatter=Buffer.from([
    "import fs from 'node:fs';",
    "if(process.argv.includes('--version')){console.log(process.argv.includes('--codex')?'codexs-statusline 1.0.0':'2.2.32');}else{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const payload=JSON.parse(input);"+(extra.privacyAttempt?"try{fs.readFileSync(payload.transcript_path);}catch{}":"")+"const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8'));console.log(config.lines[0][0].customText.slice(0,Number(process.env.CCSTATUSLINE_WIDTH||80)));});}",
  ].join('\n'));
  const f=await hostedPreparation(t,{...extra,native,formatter});
  assert.equal(await fs.stat(path.join(probe.root,'probe-record')).catch(()=>null),null,'preparation must not execute the native fixture');
  const chunk=f.job.split(/^      - name: /m).find(text=>text.startsWith('Test extracted distribution outside source checkouts\n'));
  assert.ok(chunk,'missing actual extracted distribution gate');
  const program=chunk.match(/\$program=@'\r?\n([\s\S]*?)\r?\n          '@/)[1].replace(/^          /gm,'');
  const fakeProcess={execPath:process.execPath,env:{...f.env,GITHUB_WORKSPACE:rootForTests(),CODEXS_BUNDLE_WORK:f.work,CODEXS_BUNDLE_DRAFT:f.draftPath},exitCode:0};
  const diagnostic=[];
  const load=name=>name==='node:util'?{...require(name),promisify(fn){const run=require(name).promisify(fn);return(file,args,options)=>{
    const promise=run(file,args,options);promise.then(result=>{if(options.env?.CODEXS_TEST_SHIM)diagnostic.push({shim:path.basename(options.env.CODEXS_TEST_SHIM),stdout:result.stdout.trim().slice(0,200),stderr_bytes:result.stderr.length});},error=>diagnostic.push({code:error.code,codes:String(error.stderr||'').match(/(?:MANIFEST_SCHEMA|SIGNATURE|ENROLL_[A-Z_]+|LOW_DISK|STAGE_[A-Z_]+|SMOKE_[A-Z_]+|BUNDLE_[A-Z_]+)/g),powershell_id:String(error.stderr||'').match(/FullyQualifiedErrorId\s*:\s*([^\r\n]+)/)?.[1]}));return promise;
  };}}:require(name);
  await new Function('require','process',program.replace('(async()=>','return (async()=>'))(load,fakeProcess);
  const log=await fs.readFile(path.join(f.work,'logs/bundle.log'),'utf8');
  if(fakeProcess.exitCode===0) {
    const record=f.job.split(/^      - name: /m).find(text=>text.startsWith('Record complete acceptance\n'));
    assert.ok(record,'missing actual bundle receipt step');
    const receiptProgram=record.match(/\$program=@'\r?\n([\s\S]*?)\r?\n          '@/)[1].replace(/^          /gm,'');
    new Function('require','process',receiptProgram)(require,fakeProcess);
    assert.equal(fakeProcess.exitCode,0,'bundle receipt must record the actual tested inputs');
    const receipt=JSON.parse(await fs.readFile(path.join(f.work,'logs/acceptance.json'),'utf8'));
    assert.equal(receipt.inputs.pre_evidence_sha256,createHash('sha256').update(await fs.readFile(path.join(f.work,'pre-bundle.json'))).digest('hex'));
    assert.equal(receipt.archive.sha256,f.manifest.archive.sha256);
  }
  assert.ok(await fs.stat(path.join(probe.root,'probe-record')));
  return {...f,code:fakeProcess.exitCode,log,diagnostic};
}

test('actual extracted-bundle gate enrolls and verifies only synthetic executables through the real client',async t=>{
  const f=await extractedGate(t);assert.equal(f.code,0,f.log+JSON.stringify(f.diagnostic));assert.match(f.log,/^Bundle assertions: [1-9]\d* passed; 0 failed\n$/);
});
test('actual extracted-bundle gate works from CRLF workflow text',async t=>{
  const f=await extractedGate(t,{crlf:true});assert.equal(f.code,0,f.log+JSON.stringify(f.diagnostic));
});
test('actual privacy gate rejects a caught forbidden access even when rendering succeeds',async t=>{
  const f=await extractedGate(t,{privacyAttempt:true});assert.notEqual(f.code,0,'caught privacy attempt was accepted');assert.match(f.log,/1 failed/);
});
function rootForTests(){return path.resolve(__dirname,'../..');}
