'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { UpdateError, verifyRelease, encodeRelease, parseState } = require('./protocol.cjs');
const { resolveOwned, readBoundedFile, verifyInventory } = require('./paths.cjs');

const MAX = 4 * 1024 * 1024;
const REQUIRED = Object.freeze([
  'bin/codex.exe', 'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe',
  'codex-resources/codex-windows-sandbox-setup.exe', 'packages/main/package.json',
  'packages/helper/package.json', 'formatter/package.json', 'formatter/dist/ccstatusline.js',
  ...['launch','protocol','paths','state','http','stage'].map(name => 'update/' + name + '.cjs'),
  'update/archive.ps1', 'update/coordinator.ps1',
]);
const fail = code => { throw new UpdateError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function validateRef(ref) {
  if (!ref || typeof ref !== 'object') fail('STATE_SCHEMA');
  parseState(encodeRelease({
    schema: 1, current: ref, previous: null, ready: null,
    highest: { sequence: ref.sequence, manifest_sha256: ref.manifest_sha256 },
    rejected: [], last_check_ms: 0, next_check_ms: 0, failures: 0,
  }));
}

async function verifyInstalledRelease({ root, releaseRef }, ports = {}) {
  validateRef(releaseRef);
  const releaseRoot = resolveOwned(root, 'versions/' + releaseRef.release_id);
  // These sidecar names are constants, never manifest-supplied payload paths.
  resolveOwned(releaseRoot, 'ancestry-check');
  const manifestFile = path.join(releaseRoot, 'release.json');
  const signatureFile = path.join(releaseRoot, 'release.sig');
  const read = (file, maxBytes) => readBoundedFile(file, { maxBytes, code: 'BOOTSTRAP_INVENTORY' });
  const manifestBytes = await read(manifestFile, MAX);
  const signature = await read(signatureFile, 64);
  const release = verifyRelease(manifestBytes, signature, ports.publicKey, ports.policy);
  if (release.release_id !== releaseRef.release_id || release.sequence !== releaseRef.sequence ||
      hash(manifestBytes) !== releaseRef.manifest_sha256) fail('MANIFEST_MISMATCH');
  const names = new Set(release.files.map(file => file.path));
  if (REQUIRED.some(name => !names.has(name))) fail('BOOTSTRAP_PACKAGE');
  await verifyInventory(releaseRoot, release.files, { installed: true, code: 'BOOTSTRAP_INVENTORY' });
  if (!(await read(manifestFile, MAX)).equals(manifestBytes) ||
      !(await read(signatureFile, 64)).equals(signature)) fail('BOOTSTRAP_INVENTORY');
  return Object.freeze({ releaseRef: Object.freeze({ ...releaseRef }), release, releaseRoot });
}

async function readSnapshot(root) {
  for (const name of ['current.json','current.previous.json']) {
    let bytes;
    try {
      bytes = await readBoundedFile(resolveOwned(root,name), { maxBytes: MAX, code: 'STATE_SCHEMA' });
    } catch (error) {
      if (error.code === 'STATE_SCHEMA') continue;
      throw error;
    }
    try { return { state: parseState(bytes), recovered: name !== 'current.json' }; }
    catch { /* Only the named backup can substitute for an invalid primary. */ }
  }
  fail('STATE_RECOVERY');
}

async function configuration(root) {
  const file = resolveOwned(root, 'bootstrap/config.json');
  let config;
  try {
    const bytes = await readBoundedFile(file,{ maxBytes: 16384, code: 'BOOTSTRAP_CONFIG' });
    config = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch (error) { if (error.code === 'PATH') throw error; fail('BOOTSTRAP_CONFIG'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).sort().join(',') !== 'abi,node_path,schema,settings_path,shim_marker,shim_root' ||
      config.schema !== 1 || config.abi !== 1 || config.shim_marker !== 'codexs managed shim' ||
      !['node_path','settings_path','shim_root'].every(name =>
        typeof config[name] === 'string' && path.isAbsolute(config[name]) && !/[\x00-\x1f]/.test(config[name]))) fail('BOOTSTRAP_CONFIG');
  const versions = path.resolve(root,'versions').toLowerCase();
  const settings = path.resolve(config.settings_path).toLowerCase();
  if (settings === versions || settings.startsWith(versions + path.sep)) fail('BOOTSTRAP_CONFIG');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('COMPATIBILITY');
  return Object.freeze(config);
}


async function readCheckDiagnostic(root) {
  try {
    const bytes=await readBoundedFile(resolveOwned(root,'update-status.json'),{maxBytes:4096,code:'STATUS_SCHEMA'});
    const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
    if(!value || Object.keys(value).sort().join(',')!=='checked_at_ms,code,duration_ms,schema' ||
       value.schema!==1 || typeof value.code!=='string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ||
       !['checked_at_ms','duration_ms'].every(name=>Number.isSafeInteger(value[name])&&value[name]>=0))return null;
    return value;
  }catch{return null;}
}

async function bootstrap({ mode, argv }, ports = {}) {
  if (!['cli','editor'].includes(mode) || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) fail('LAUNCH_INPUT');
  const root = ports.root || path.resolve(__dirname,'..');
  if(!path.isAbsolute(root))fail('PATH');
  try{await require('node:fs/promises').lstat(root+'.enroll.json');fail('ENROLL_RECOVERY_REQUIRED');}catch(error){if(error.code!=='ENOENT')fail('ENROLL_RECOVERY_REQUIRED');}
  const config = await configuration(root);
  const publicKey = await readBoundedFile(resolveOwned(root,'bootstrap/release-public-key.pem'),{ maxBytes: 16384, code: 'BOOTSTRAP_KEY' });
  const snapshot = await readSnapshot(root);
  const readOnly=argv.length===1 && (['--version','-V'].includes(argv[0]) || (mode==='cli' && argv[0]==='update-status'));
  let verifiedRelease,recoverPrevious=false;
  try {
    if(!snapshot.state.current || snapshot.state.rejected.includes(snapshot.state.current.release_id))fail('STATE_RECOVERY');
    verifiedRelease=await verifyInstalledRelease({root,releaseRef:snapshot.state.current},{publicKey,policy:ports.policy});
  } catch(error) {
    if(readOnly || !['BOOTSTRAP_INVENTORY','BOOTSTRAP_PACKAGE','SIGNATURE','MANIFEST_MISMATCH','MANIFEST_SCHEMA','PATH','STATE_RECOVERY'].includes(error.code) ||
       !snapshot.state.previous || snapshot.state.rejected.includes(snapshot.state.previous.release_id))throw error;
    verifiedRelease=await verifyInstalledRelease({root,releaseRef:snapshot.state.previous},{publicKey,policy:ports.policy});
    recoverPrevious=true;
  }
  const write = ports.write || (text => process.stdout.write(text));
  if (argv.length === 1 && ['--version','-V'].includes(argv[0])) {
    write(mode === 'cli'
      ? 'codexs ' + verifiedRelease.release.product_version + ' (Codex CLI ' + verifiedRelease.release.upstream.version + ')\n'
      : 'codexs-statusline ' + verifiedRelease.release.product_version + '\n');
    return 0;
  }
  if (mode === 'cli' && argv.length === 1 && argv[0] === 'update-status') {
    const last_check=await readCheckDiagnostic(root);
    write(JSON.stringify({ ...snapshot.state, recovered:snapshot.recovered,
      product_version:verifiedRelease.release.product_version,upstream_version:verifiedRelease.release.upstream.version,
      last_check,diagnostic_code:last_check?'OK':'STATUS_UNAVAILABLE' }) + '\n');
    return 0;
  }
  const operational = require(resolveOwned(verifiedRelease.releaseRoot,'update/launch.cjs'));
  if (typeof operational.main !== 'function') fail('BOOTSTRAP_PACKAGE');
  return operational.main({mode,argv,verifiedRelease},{
    ...ports, root, config, publicKey, verifyInstalledRelease, readSnapshot, snapshot, recoverPrevious,
    dispatchVerified:async(selected,selectedPorts)=>{
      const final=await verifyInstalledRelease({root,releaseRef:selected.verifiedRelease.releaseRef},{publicKey,policy:ports.policy});
      const launcher=require(resolveOwned(final.releaseRoot,'update/launch.cjs'));
      if(typeof launcher.launchResolved!=='function')fail('BOOTSTRAP_PACKAGE');
      return launcher.launchResolved({mode,argv,verifiedRelease:final},{...selectedPorts,root,config,publicKey,verifyInstalledRelease,readSnapshot});
    },
  });
}

module.exports = { verifyInstalledRelease, bootstrap, REQUIRED };


async function startBarrier() {
  await new Promise((resolve,reject) => {
    let bytes=Buffer.alloc(0);
    const stop=error => {cleanup();reject(error);};
    const data=chunk => {
      bytes=Buffer.concat([bytes,chunk]);
      if(bytes.length>1024){stop(new UpdateError('COORDINATOR_PROTOCOL'));return;}
      if(!bytes.includes(10))return;
      const line=bytes.toString('utf8');
      if(line !== '{"type":"start"}\n' && line !== '{"type":"start"}\r\n'){stop(new UpdateError('COORDINATOR_PROTOCOL'));return;}
      cleanup();resolve();
    };
    const ended=()=>stop(new UpdateError('COORDINATOR_PROTOCOL'));
    const timer=setTimeout(ended,5000);
    function cleanup(){clearTimeout(timer);process.stdin.removeListener('data',data);process.stdin.removeListener('end',ended);process.stdin.pause();}
    process.stdin.on('data',data);process.stdin.once('end',ended);process.stdin.resume();
  });
}

async function workerEntry(encoded) {
  if(typeof encoded !== 'string' || encoded.length>8192)fail('UPDATE_INPUT');
  let request;
  try {
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)fail('UPDATE_INPUT');
    request=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  } catch {fail('UPDATE_INPUT');}
  if(!request || !(Object.keys(request).sort().join(',')==='mode,releaseRef' || request.mode==='rollback' && Object.keys(request).sort().join(',')==='expectedCurrent,mode,releaseRef') ||
     !['check','promote','rollback'].includes(request.mode))fail('UPDATE_INPUT');
  validateRef(request.releaseRef);
  if(Object.hasOwn(request,'expectedCurrent') && request.expectedCurrent!==null)validateRef(request.expectedCurrent);
  await startBarrier();
  const root=path.resolve(__dirname,'..'),config=await configuration(root);
  const publicKey=await readBoundedFile(resolveOwned(root,'bootstrap/release-public-key.pem'),{maxBytes:16384,code:'BOOTSTRAP_KEY'});
  const verifiedRelease=await verifyInstalledRelease({root,releaseRef:request.releaseRef},{publicKey});
  const operational=require(resolveOwned(verifiedRelease.releaseRoot,'update/launch.cjs'));
  if(typeof operational.runWorker!=='function')fail('BOOTSTRAP_PACKAGE');
  return operational.runWorker({mode:request.mode,verifiedRelease,...(Object.hasOwn(request,'expectedCurrent')?{expectedCurrent:request.expectedCurrent}:{})},{root,config,publicKey,verifyInstalledRelease,readSnapshot});
}

async function validateStateEntry() {
  const chunks=[];let total=0;
  for await(const chunk of process.stdin){total+=chunk.length;if(total>MAX)fail('STATE_SCHEMA');chunks.push(chunk);}
  parseState(Buffer.concat(chunks));return 0;
}


async function backgroundEntry(encoded) {
  if(typeof encoded!=='string' || encoded.length>8192)fail('UPDATE_INPUT');
  let request;
  try {
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)fail('UPDATE_INPUT');
    request=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  } catch{fail('UPDATE_INPUT');}
  if(!request || Object.keys(request).sort().join(',')!=='mode,releaseRef' || request.mode!=='check')fail('UPDATE_INPUT');
  validateRef(request.releaseRef);
  const root=path.resolve(__dirname,'..'),config=await configuration(root);
  const publicKey=await readBoundedFile(resolveOwned(root,'bootstrap/release-public-key.pem'),{maxBytes:16384,code:'BOOTSTRAP_KEY'});
  const verifiedRelease=await verifyInstalledRelease({root,releaseRef:request.releaseRef},{publicKey});
  const operational=require(resolveOwned(verifiedRelease.releaseRoot,'update/launch.cjs'));
  if(typeof operational.coordinate!=='function')fail('BOOTSTRAP_PACKAGE');
  await operational.coordinate({mode:'check',verifiedRelease},{root,config,publicKey,verifyInstalledRelease,readSnapshot});
  return 0;
}

if (require.main === module) {
  const mode=process.argv[2];
  const work = mode==='background' && process.argv.length===4 ? backgroundEntry(process.argv[3])
    : mode==='worker' && process.argv.length===4 ? workerEntry(process.argv[3])
    : mode==='validate-state' && process.argv.length===3 ? validateStateEntry()
    : bootstrap({mode,argv:process.argv.slice(3)});
  work.then(code => {process.exitCode=code;}).catch(error => {
    const code=error && error.name==='UpdateError' && typeof error.code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'BOOTSTRAP_IO';
    process.stderr.write('codexs: '+code+'\n');process.exitCode=1;
  });
}
