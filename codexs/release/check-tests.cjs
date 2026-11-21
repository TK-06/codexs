'use strict';
const path=require('node:path');
const {run}=require('node:test');
const {tap}=require('node:test/reporters');
const invalid=()=>{const error=Error('CHECK_TESTS');error.code='CHECK_TESTS';throw error;};
async function checkNodeSuites({files,requiredSuites=files},ports={}){
  if(!Array.isArray(files)||!files.length||!Array.isArray(requiredSuites)||!requiredSuites.length ||
     [...files,...requiredSuites].some(file=>typeof file!=='string'||!path.isAbsolute(file)))invalid();
  files=files.map(file=>path.resolve(file));requiredSuites=requiredSuites.map(file=>path.resolve(file));
  if(new Set(files).size!==files.length || new Set(requiredSuites).size!==requiredSuites.length || requiredSuites.some(file=>!files.includes(file)))invalid();
  const suites=new Map();let summary,broken=false;
  const countsValid=counts=>counts && ['cancelled','failed','passed','skipped','suites','tests','todo','topLevel'].every(key=>Number.isSafeInteger(counts[key])&&counts[key]>=0);
  async function* observed(){
    for await(const event of (ports.run||run)({files,concurrency:true})){
      if(event.type==='test:summary'){
        const data=event.data;
        if(!data || data.success!==true || !countsValid(data.counts) || data.counts.passed<1 || data.counts.tests<1 || data.counts.failed || data.counts.cancelled)broken=true;
        if(data && data.file!==undefined){
          const file=typeof data.file==='string'?path.resolve(data.file):'';
          if(!files.includes(file)||suites.has(file))broken=true;
          else suites.set(file,{file,counts:data.counts});
        }else{
          if(summary)broken=true;
          summary=data;
        }
      }
      yield event;
    }
  }
  if(ports.write){for await(const chunk of tap(observed()))ports.write(chunk);}
  else{for await(const event of observed()){void event;}}
  if(broken || !summary || suites.size!==files.length || requiredSuites.some(file=>!suites.has(file)))invalid();
  return {suites:files.map(file=>suites.get(file)),summary:summary.counts};
}
module.exports={checkNodeSuites};
if(require.main===module){
  const files=process.argv.slice(2);
  checkNodeSuites({files,requiredSuites:files},{write:chunk=>process.stdout.write(chunk)})
    .then(result=>{console.log('# codexs verified suites '+result.suites.length);})
    .catch(()=>{console.error('codexs: CHECK_TESTS');process.exitCode=1;});
}
