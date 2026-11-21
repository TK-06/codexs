'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchInstallation } = require('../test-support/update-fixtures.cjs');

function api() {
  let value;
  assert.doesNotThrow(() => { value = require('./bootstrap.cjs'); }, 'the pinned bootstrap must exist');
  assert.equal(typeof value.verifyInstalledRelease, 'function');
  assert.equal(typeof value.bootstrap, 'function');
  return value;
}
const absent = file => fs.access(file).then(() => false, () => true);

test('authenticated operational code loads only after complete inventory verification', async t => {
  const f = await launchInstallation(t);
  const a = await f.install();
  await f.writeState(a.ref);
  const verified = await api().verifyInstalledRelease({ root: f.root, releaseRef: a.ref }, { publicKey: f.publicKey });
  assert.equal(verified.releaseRoot, a.directory);
  assert.deepEqual(verified.releaseRef, a.ref);
  assert.equal(await absent(f.marker), true);
  assert.equal(await api().bootstrap({ mode: 'cli', argv: [] }, { root: f.root }), 17);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'loaded');
});

test('unsigned operational code never loads', async t => {
  for (const attack of ['signature', 'digest', 'missing signature']) {
    await t.test(attack, async t => {
      const f = await launchInstallation(t);
      const a = await f.install();
      const ref = { ...a.ref };
      if (attack === 'signature') await fs.writeFile(path.join(a.directory,'release.sig'),Buffer.alloc(64));
      if (attack === 'digest') ref.manifest_sha256 = 'f'.repeat(64);
      if (attack === 'missing signature') await fs.unlink(path.join(a.directory,'release.sig'));
      await f.writeState(ref);
      await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}), error => ['SIGNATURE','MANIFEST_MISMATCH','BOOTSTRAP_INVENTORY'].includes(error.code));
      assert.equal(await absent(f.marker), true);
    });
  }
});

test('inventory changes block imports', async t => {
  for (const name of ['update/launch.cjs','update/coordinator.ps1','bin/codex.exe','codex-path/rg.exe','formatter/dist/ccstatusline.js']) {
    await t.test(name, async t => {
      const f = await launchInstallation(t);
      const a = await f.install();
      await f.writeState(a.ref);
      await fs.appendFile(path.join(a.directory,...name.split('/')),'tampered');
      await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}),{code:'BOOTSTRAP_INVENTORY'});
      assert.equal(await absent(f.marker), true);
    });
  }
});

test('a signed manifest missing an operational module is still not launchable', async t => {
  const f = await launchInstallation(t);
  const a = await f.install(1,{payload:{'update/coordinator.ps1':null}});
  await f.writeState(a.ref);
  await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}),{code:'BOOTSTRAP_PACKAGE'});
  assert.equal(await absent(f.marker), true);
});

test('pointer backup is the only recovery input', async t => {
  const f = await launchInstallation(t);
  const a = await f.install();
  await f.writeState(a.ref);
  const backup = path.join(f.root,'current.previous.json');
  const saved = await fs.readFile(path.join(f.root,'current.json'));
  await fs.writeFile(backup,saved);
  await fs.writeFile(path.join(f.root,'current.json'),'{invalid');
  assert.equal(await api().bootstrap({mode:'cli',argv:[]},{root:f.root}),17);
  assert.equal(await fs.readFile(path.join(f.root,'current.json'),'utf8'),'{invalid');
  assert.deepEqual(await fs.readFile(backup),saved);
  await fs.unlink(f.marker);
  await fs.writeFile(backup,'{}');
  await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}),{code:'STATE_RECOVERY'});
  assert.equal(await absent(f.marker),true);
});

test('ABI and Node maintenance holds preserve current', async t => {
  for (const manifest of [{bootstrap_min:2},{node_min:Number(process.versions.node.split('.')[0])+1}]) {
    await t.test(JSON.stringify(manifest), async t => {
      const f = await launchInstallation(t);
      const a = await f.install(1,{manifest});
      await f.writeState(a.ref);
      const before = await fs.readFile(path.join(f.root,'current.json'));
      await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}),{code:'COMPATIBILITY'});
      assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
      assert.equal(await absent(f.marker),true);
    });
  }
});

test('read-only product diagnostics do not load operational code or require settings', async t => {
  const f = await launchInstallation(t);
  const a = await f.install();
  await f.writeState(a.ref);
  await fs.unlink(f.config.settings_path);
  const before = await fs.readFile(path.join(f.root,'current.json'));
  for (const [mode,argv,want] of [
    ['cli',['--version'],'codexs 1.0.0 (Codex CLI 0.166.0)\n'],
    ['cli',['-V'],'codexs 1.0.0 (Codex CLI 0.166.0)\n'],
    ['editor',['--version'],'codexs-statusline 1.0.0\n'],
    ['editor',['-V'],'codexs-statusline 1.0.0\n'],
  ]) {
    let output='';
    assert.equal(await api().bootstrap({mode,argv},{root:f.root,write:text=>{output+=text;}}),0);
    assert.equal(output,want);
  }
  let status='';
  assert.equal(await api().bootstrap({mode:'cli',argv:['update-status']},{root:f.root,write:text=>{status+=text;}}),0);
  assert.equal(JSON.parse(status).current.release_id,a.ref.release_id);
  assert.equal(await absent(f.marker),true);
  assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
});

test('junction release directories cannot load outside code', async t => {
  const f = await launchInstallation(t);
  const a = await f.install();
  await f.writeState(a.ref);
  const moved=path.join(f.root,'outside');
  await fs.rename(a.directory,moved);
  await fs.symlink(moved,a.directory,'junction');
  await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}),{code:'PATH'});
  assert.equal(await absent(f.marker),true);
});

test('unrecognized bootstrap configuration is rejected without importing code', async t => {
  const f = await launchInstallation(t);
  const a = await f.install();
  await f.writeState(a.ref);
  await fs.writeFile(path.join(f.root,'bootstrap','config.json'),JSON.stringify({...f.config,feed:'https://invalid.example/'}));
  await assert.rejects(api().bootstrap({mode:'cli',argv:[]},{root:f.root}),{code:'BOOTSTRAP_CONFIG'});
  assert.equal(await absent(f.marker),true);
});

test('update-status reports independent versions and bounded last-check reason without loading release code',async t=>{
  const f=await launchInstallation(t),a=await f.install();await f.writeState(a.ref);
  await fs.unlink(f.config.settings_path);
  const record={schema:1,code:'NETWORK',checked_at_ms:123456,duration_ms:321};
  const file=path.join(f.root,'update-status.json');await fs.writeFile(file,JSON.stringify(record));
  const before=await fs.readFile(path.join(f.root,'current.json'));let text='';
  await api().bootstrap({mode:'cli',argv:['update-status']},{root:f.root,write:x=>{text+=x;}});
  const status=JSON.parse(text);
  assert.equal(status.product_version,'1.0.0');assert.equal(status.upstream_version,'0.166.0');
  assert.deepEqual(status.last_check,record);assert.equal(status.diagnostic_code,'OK');
  assert.equal(await absent(f.marker),true);assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
  assert.equal(await fs.readFile(file,'utf8'),JSON.stringify(record));
});
test('missing malformed oversized or private status records remain bounded and read-only',async t=>{
  const f=await launchInstallation(t),a=await f.install();await f.writeState(a.ref);
  const file=path.join(f.root,'update-status.json');
  for(const value of [null,'{bad',JSON.stringify({schema:1,code:'NETWORK',checked_at_ms:1,duration_ms:1,private:'SYNTHETIC_PRIVATE_PAYLOAD'}),'x'.repeat(4097)]){
    if(value===null)await fs.rm(file,{force:true});else await fs.writeFile(file,value);
    let text='';await api().bootstrap({mode:'cli',argv:['update-status']},{root:f.root,write:x=>{text+=x;}});
    const status=JSON.parse(text);assert.equal(status.last_check,null);assert.equal(status.diagnostic_code,'STATUS_UNAVAILABLE');
    assert.ok(!text.includes('SYNTHETIC_PRIVATE_PAYLOAD'));assert.equal(await absent(f.marker),true);
    if(value===null)assert.equal(await absent(file),true);else assert.equal(await fs.readFile(file,'utf8'),value);
  }
});

test('a pending enrollment journal blocks launch before settings or operational imports',async t=>{
  const f=await launchInstallation(t),a=await f.install();await f.writeState(a.ref);
  await fs.unlink(f.config.settings_path);
  const journal=f.root+'.enroll.json';
  assert.equal(path.dirname(journal),path.dirname(f.root));
  t.after(()=>fs.rm(journal,{force:true}));
  await fs.writeFile(journal,'synthetic pending transaction');
  const before=await fs.readFile(path.join(f.root,'current.json'));
  for(const argv of [[],['--version'],['update-status']])await assert.rejects(api().bootstrap({mode:'cli',argv},{root:f.root}),{code:'ENROLL_RECOVERY_REQUIRED'});
  assert.equal(await absent(f.marker),true);assert.deepEqual(await fs.readFile(path.join(f.root,'current.json')),before);
});
