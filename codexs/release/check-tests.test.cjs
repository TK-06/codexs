'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codexs-suite-test-'));
  t.after(async()=>{if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('codexs-suite-test-'))throw Error('Unsafe owned suite cleanup');await fs.rm(root,{recursive:true});});
  return async(name,source)=>{const file=path.join(root,name+'.test.cjs');await fs.writeFile(file,source);return file;};
}
function api(){let value;assert.doesNotThrow(()=>{value=require('./check-tests.cjs');},'suite checker must exist');assert.equal(typeof value.checkNodeSuites,'function');return value.checkNodeSuites;}
async function actualSuites(files){
  const {promisify}=require('node:util'),execute=promisify(require('node:child_process').execFile);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const program="require(process.argv[2]).checkNodeSuites({files:process.argv.slice(3)},{write:c=>process.stdout.write(c)}).then(result=>console.log('# result '+JSON.stringify(result))).catch(e=>{console.error(e.code);process.exitCode=1;});";
  const driver=path.join(path.dirname(files[0]),'owned-runner.cjs');await fs.writeFile(driver,program);
  const result=await execute(process.execPath,[driver,path.join(__dirname,'check-tests.cjs'),...files],{env,windowsHide:true,timeout:15000,maxBuffer:1048576});
  return {result:JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('# result ')).slice(9)),output:result.stdout};
}
test('required suite checker accepts actual cases from every file and streams TAP',async t=>{
  const create=await fixture(t),files=await Promise.all(['one','two'].map(name=>create(name,"require('node:test').test('synthetic executed case',()=>{});\n")));
  api();const {result,output}=await actualSuites(files);
  assert.equal(result.suites.length,2);assert.equal(result.summary.passed,2);assert.equal(result.summary.failed,0);
  assert.ok(result.suites.every(s=>s.counts.passed===1 && s.counts.cancelled===0));assert.match(output,/synthetic executed case/);
});
test('healthy neighbors cannot hide empty skipped todo cancelled failing or missing mandatory suites',async t=>{
  const create=await fixture(t),healthy=await create('healthy',"require('node:test').test('synthetic healthy',()=>{});\n");
  for(const [name,source]of Object.entries({
    empty:'// empty synthetic file\n',
    skipped:"require('node:test').test.skip('synthetic skip',()=>{});\n",
    todo:"require('node:test').test.todo('synthetic todo');\n",
    cancelled:"const c=new AbortController();require('node:test').test('synthetic pending',{signal:c.signal},()=>new Promise(()=>{}));setTimeout(()=>c.abort(),20);\n",
    failing:"require('node:test').test('synthetic failure',()=>{throw Error('synthetic');});\n",
  })){
    await t.test(name,async()=>{const bad=await create(name,source);await assert.rejects(actualSuites([healthy,bad]),error=>error.code===1 && /CHECK_TESTS/.test(error.stderr));});
  }
  const missing=await create('not-discovered',"require('node:test').test('synthetic omitted',()=>{});\n");
  await assert.rejects(api()({files:[healthy],requiredSuites:[healthy,missing]}),{code:'CHECK_TESTS'});
  await assert.rejects(api()({files:[healthy,healthy],requiredSuites:[healthy]}),{code:'CHECK_TESTS'});
});
test('suite checker rejects duplicate unattributed missing or malformed summaries',async t=>{
  const create=await fixture(t),file=await create('case',"require('node:test').test('synthetic case',()=>{});\n");
  const counts={cancelled:0,failed:0,passed:1,skipped:0,suites:0,tests:1,todo:0,topLevel:1};
  const row=file=>({type:'test:summary',data:{file,success:true,counts}});
  for(const rows of [[row(file),row(file),row(undefined)],[row(file+'.unknown'),row(undefined)],[row(undefined)],[row(file)],[row(file),{...row(undefined),data:{...row(undefined).data,counts:{...counts,failed:1}}}]]){
    await assert.rejects(api()({files:[file],requiredSuites:[file]},{run:()=>({async *[Symbol.asyncIterator](){yield* rows;}})}),{code:'CHECK_TESTS'});
  }
});
