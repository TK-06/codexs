[CmdletBinding()]
param([string]$Bundle,[string]$Manifest,[string]$Signature,[string]$PublicKey,[string]$NodePath,[string]$SettingsPath,[switch]$Install)

$script:CodexsEnrollmentPackageRoot=$PSScriptRoot

function Assert-CodexsEnrollmentPath([string]$Root,[string]$Candidate) {
    if([string]::IsNullOrEmpty($Root) -or [string]::IsNullOrEmpty($Candidate) -or
       -not [IO.Path]::IsPathRooted($Root) -or -not [IO.Path]::IsPathRooted($Candidate)){throw 'ENROLL_PATH'}
    $base=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full=[IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    if($base.Length -le 3 -or -not $full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ENROLL_PATH'}
    for($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
        if([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ENROLL_PATH'}
        }
        if($cursor -eq [IO.Path]::GetPathRoot($cursor)){break}
    }
    return $full
}

function Get-CodexsEnrollmentOperations {
    return @{
        FreeBytes={param($Path) return [long]([IO.DriveInfo]::new([IO.Path]::GetPathRoot($Path))).AvailableFreeSpace}
        NodeMajor={param($Path) try{$result=@(& $Path -p 'process.versions.node');if($LASTEXITCODE -ne 0 -or $result.Count -ne 1 -or $result[0] -cnotmatch '^([0-9]+)\.[0-9]+\.[0-9]+$'){throw 'ENROLL_NODE'};return [int]$matches[1]}catch{throw 'ENROLL_NODE'}}
        CreateDirectory={param($Path) [void][IO.Directory]::CreateDirectory($Path)}
        CopyFile={param($Source,$Target) [IO.File]::Copy($Source,$Target,$false)}
        MoveDirectory={param($Source,$Target) [IO.Directory]::Move($Source,$Target)}
        WriteShim={
            param($Path,[byte[]]$Bytes)
            $temporary=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
            $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
            try{if([IO.File]::Exists($Path)){[IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value,$true)}else{[IO.File]::Move($temporary,$Path)}}
            finally{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
        }
        RunningFiles={
            $files=[Collections.Generic.List[string]]::new()
            foreach($process in [Diagnostics.Process]::GetProcesses()){
                try{$files.Add($process.MainModule.FileName)}catch{}finally{$process.Dispose()}
            }
            return $files.ToArray()
        }
    }
}

function Invoke-CodexsEnrollmentNode($Options,[string]$Mode,$Extra=@{}) {
    $data=@{
        mode=$Mode;package_root=$Options.PackageRoot;bundle=$Options.Bundle;manifest=$Options.Manifest;
        signature=$Options.Signature;key=$Options.PublicKey;node=$Options.NodePath;settings=$Options.SettingsPath
    }
    foreach($name in $Extra.Keys){$data[$name]=$Extra[$name]}
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $data -Depth 12 -Compress)))
    if($encoded.Length -gt 16384){throw 'ENROLL_INPUT'}
    $program=@'
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const ctx=JSON.parse(Buffer.from(process.argv[2],'base64'));
const protocol=require(path.join(ctx.package_root,'protocol.cjs'));
const owned=require(path.join(ctx.package_root,'paths.cjs'));
const bootstrap=require(path.join(ctx.package_root,'bootstrap.cjs'));
const fail=code=>{throw new protocol.UpdateError(code)};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 if(Number(process.versions.node.split('.')[0])<22)fail('COMPATIBILITY');
 if(ctx.mode==='state'){protocol.parseState(Buffer.from(ctx.state_b64,'base64'));return {ok:true};}

 if(ctx.mode==='recover-installed'){
   const e=ctx.expected,root=ctx.stage_root;
   const read=(name,maxBytes=4194304)=>owned.readBoundedFile(owned.resolveOwned(root,name),{maxBytes,code:'ENROLL_RECOVERY_REQUIRED'});
   const installedKey=await read('bootstrap/release-public-key.pem',16384);
   if(hash(installedKey)!==e.key_sha256)fail('ENROLL_RECOVERY_REQUIRED');
   for(const [name,digest]of Object.entries(e.bootstrap_hashes)){
     if(hash(await read('bootstrap/'+name))!==digest)fail('ENROLL_RECOVERY_REQUIRED');
   }
   const marker=(await read('.enroll-owner.json',128)).toString('utf8');
   if(marker!==JSON.stringify({schema:1,id:e.id}))fail('ENROLL_RECOVERY_REQUIRED');
   const config=JSON.parse((await read('bootstrap/config.json',16384)).toString('utf8'));
   if(!protocol.encodeRelease(config).equals(protocol.encodeRelease(e.config)))fail('ENROLL_CONFIG');
   await bootstrap.verifyInstalledRelease({root,releaseRef:e.ref},{publicKey:installedKey});
   const actual=await require(path.join(ctx.package_root,'state.cjs')).readInstallation(root);
   if(!protocol.encodeRelease(actual.state).equals(Buffer.from(e.final_state,'base64')))fail('STATE_SCHEMA');
   return {ok:true};
 }

 const manifest=await owned.readBoundedFile(ctx.manifest,{maxBytes:4194304,code:'MANIFEST_SCHEMA'});
 const signature=await owned.readBoundedFile(ctx.signature,{maxBytes:64,code:'SIGNATURE'});
 const key=await owned.readBoundedFile(ctx.key,{maxBytes:16384,code:'SIGNATURE'});
 const release=protocol.verifyRelease(manifest,signature,key);
 owned.validateInventory(release.files);
 if(!Array.isArray(bootstrap.REQUIRED)||bootstrap.REQUIRED.some(name=>!release.files.some(file=>file.path===name)))fail('ENROLL_PACKAGE');
 if(ctx.manifest_sha256 && hash(manifest)!==ctx.manifest_sha256)fail('MANIFEST_MISMATCH');
 if(ctx.key_sha256 && hash(key)!==ctx.key_sha256)fail('SIGNATURE');
 if(await owned.hashFile(ctx.bundle,release.archive.bytes,'DOWNLOAD_HASH')!==release.archive.sha256)fail('DOWNLOAD_HASH');
 let settings;
 try{settings=JSON.parse((await owned.readBoundedFile(ctx.settings,{maxBytes:4194304,code:'SETTINGS_HOLD'})).toString('utf8'))}catch{fail('SETTINGS_HOLD')}
 if(!settings||settings.version!==4)fail('SETTINGS_HOLD');
 const ref={release_id:release.release_id,sequence:release.sequence,manifest_sha256:hash(manifest)};
 const initial={schema:1,current:null,previous:null,ready:null,highest:{sequence:ref.sequence,manifest_sha256:ref.manifest_sha256},rejected:[],last_check_ms:0,next_check_ms:0,failures:0};
 protocol.parseState(protocol.encodeRelease(initial));
 const {transition}=require(path.join(ctx.package_root,'state.cjs'));
 const final=transition(transition(initial,{type:'stage-ready',ref}),{type:'promote'});
 const bootstrap_hashes={};
 for(const name of ['bootstrap.cjs','protocol.cjs','paths.cjs'])bootstrap_hashes[name]=hash(await owned.readBoundedFile(path.join(ctx.package_root,name),{maxBytes:4194304,code:'ENROLL_PACKAGE'}));
 if(ctx.mode==='stage'){
   const {stageRelease}=require(path.join(ctx.package_root,'stage.cjs'));
   const ports=require(path.join(ctx.package_root,'launch.cjs')).createUpdatePorts(
     {verifiedRelease:{releaseRoot:path.dirname(ctx.package_root)}},
     {root:ctx.stage_root,config:{node_path:ctx.node,settings_path:ctx.settings},statfs:async()=>({bavail:BigInt(ctx.free_bytes),bsize:1n})});
   const actual=await stageRelease({root:ctx.stage_root,manifestBytes:manifest,signature},{
     ...ports,publicKey:key,assetId:1,commitState:async()=>fail('COORDINATOR_REQUIRED'),
     downloadAsset:async({destination})=>fs.copyFile(ctx.bundle,destination,require('node:fs').constants.COPYFILE_EXCL),
   });
   if(JSON.stringify(actual)!==JSON.stringify(ref))fail('MANIFEST_MISMATCH');
 }
 if(ctx.mode==='installed'){
   const cfg=JSON.parse((await owned.readBoundedFile(owned.resolveOwned(ctx.stage_root,'bootstrap/config.json'),{maxBytes:16384,code:'ENROLL_CONFIG'})).toString('utf8'));
   if(!ctx.expected_config || !protocol.encodeRelease(cfg).equals(protocol.encodeRelease(ctx.expected_config)))fail('ENROLL_CONFIG');
   const copiedKey=await owned.readBoundedFile(owned.resolveOwned(ctx.stage_root,'bootstrap/release-public-key.pem'),{maxBytes:16384,code:'SIGNATURE'});
   if(hash(copiedKey)!==hash(key))fail('SIGNATURE');
   for(const [name,digest]of Object.entries(bootstrap_hashes)){
     if(hash(await owned.readBoundedFile(owned.resolveOwned(ctx.stage_root,'bootstrap/'+name),{maxBytes:4194304,code:'ENROLL_PACKAGE'}))!==digest)fail('ENROLL_PACKAGE');
   }
   await bootstrap.verifyInstalledRelease({root:ctx.stage_root,releaseRef:ref},{publicKey:key});
   const actual=await require(path.join(ctx.package_root,'state.cjs')).readInstallation(ctx.stage_root);
   if(!protocol.encodeRelease(actual.state).equals(protocol.encodeRelease(final)))fail('STATE_SCHEMA');
 }
 return {ok:true,release_id:release.release_id,product_version:release.product_version,upstream_version:release.upstream.version,
  manifest_sha256:ref.manifest_sha256,key_sha256:hash(key),initial_state:protocol.encodeRelease(initial).toString('base64'),
  final_state:protocol.encodeRelease(final).toString('base64'),files:release.files.length,bytes:release.archive.bytes,bootstrap_hashes};
})().then(result=>console.log(JSON.stringify(result))).catch(error=>{
 const code=error&&error.name==='UpdateError'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:'ENROLL_VERIFY';
 console.log(JSON.stringify({ok:false,code}));process.exitCode=1;
});
'@
    $lines=@($program|& $Options.NodePath - $encoded)
    $exit=$LASTEXITCODE
    $text=$lines -join [Environment]::NewLine
    if($text.Length -gt 32768){throw 'ENROLL_PROTOCOL'}
    try{$result=ConvertFrom-Json $text}catch{throw 'ENROLL_PROTOCOL'}
    if($exit -ne 0 -or $result.ok -ne $true){
        if($result.code -is [string] -and $result.code -cmatch '^[A-Z][A-Z0-9_]{0,63}$'){throw $result.code}
        throw 'ENROLL_VERIFY'
    }
    return $result
}

function Write-CodexsEnrollmentState($Options,[string]$Root,[string]$Base64) {
    . ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $Options.PackageRoot 'coordinator.ps1'))))
    $bytes=[Convert]::FromBase64String($Base64)
    $validate={
        param([byte[]]$Value)
        try{Invoke-CodexsEnrollmentNode $Options 'state' @{state_b64=[Convert]::ToBase64String($Value)}|Out-Null;return $true}catch{return $false}
    }
    $result=Invoke-CodexsCoordinator -Request @{mode='check';root=$Root} -ValidateState $validate -Operation {param($Request,$Context) @{code='ENROLLED';nextState=$bytes}}
    if($result.code -cne 'ENROLLED'){throw 'ENROLL_BUSY'}
}

function New-CodexsEnrollmentShim([string]$Node,[string]$Entry,[string]$Mode) {
    $companion=if($Mode -ceq 'cli'){'codexs.ps1'}else{'codexs-statusline.ps1'}
    $lines=@('@echo off','REM codexs managed shim','setlocal DisableDelayedExpansion','set "CODEX_MANAGED_BY_NPM="','set "CODEX_MANAGED_PACKAGE_ROOT="',('"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "%~dp0'+$companion+'" --codexs-cmd-argv %*'),'exit /b %errorlevel%')
    return [Text.UTF8Encoding]::new($false).GetBytes(($lines -join [Environment]::NewLine)+[Environment]::NewLine)
}


function New-CodexsEnrollmentPowerShellShim([string]$Node,[string]$Entry,[string]$Mode) {
    $launcher=@'
const entry=Buffer.from(process.argv[1],'base64').toString('utf8');const argv=JSON.parse(Buffer.from(process.argv[2],'base64').toString('utf8'));require(entry).bootstrap({mode:process.argv[3],argv}).then(c=>{process.exitCode=c}).catch(e=>{const c=e&&e.name==='UpdateError'&&typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)?e.code:'BOOTSTRAP_IO';console.error('codexs: '+c);process.exitCode=1});
'@
    $node64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Node))
    $entry64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Entry))
    $program64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($launcher))
    $lines=@(
        '# codexs managed shim',
        ('$node=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('''+$node64+'''))'),
        '$values=@($args);$raw=[Environment]::GetCommandLineArgs()',
        'if($raw.Length -ge 6 -and $raw[1] -ceq ''-NoProfile'' -and $raw[2] -ceq ''-NonInteractive'' -and $raw[3] -ceq ''-File'' -and $raw[4] -ceq $PSCommandPath -and $raw[5] -ceq ''--codexs-cmd-argv''){$values=@($raw | Select-Object -Skip 6)}',
        '$forwarded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($values | ForEach-Object {[string]$_}) -Compress)))',
        ('$program=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('''+$program64+'''))'),
        ('& $node -e $program '''+$entry64+''' $forwarded '''+$Mode+''''),
        'exit $LASTEXITCODE'
    )
    return [Text.UTF8Encoding]::new($false).GetBytes(($lines -join [Environment]::NewLine)+[Environment]::NewLine)
}


function Get-CodexsEnrollmentHash([string]$File,[int]$Maximum=65536) {
    if(-not [IO.File]::Exists($File) -or ([IO.FileInfo]$File).Length -gt $Maximum){throw 'ENROLL_RECOVERY_REQUIRED'}
    $sha=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($File)
    try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}
}
function Get-CodexsEnrollmentNames {return @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')}
function Get-CodexsEnrollmentMarker([string]$Id) {return '{"schema":1,"id":"'+$Id+'"}'}
function Invoke-CodexsEnrollmentCheckpoint($Operations,[string]$Phase,$Journal) {
    if($Operations.ContainsKey('Checkpoint') -and $null -ne $Operations.Checkpoint){& $Operations.Checkpoint $Phase $Journal|Out-Null}
}
function Get-CodexsEnrollmentJournalPath($Options) {
    return Assert-CodexsEnrollmentPath $Options.AllowedRoot ($Options.InstallRoot+'.enroll.json')
}
function Write-CodexsEnrollmentJournal($Options,$Journal) {
    $file=Get-CodexsEnrollmentJournalPath $Options
    $temporary=Assert-CodexsEnrollmentPath $Options.AllowedRoot ($file+'.tmp-'+[guid]::NewGuid().ToString('N'))
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json $Journal -Depth 18 -Compress))
    if($bytes.Length -gt 262144){throw 'ENROLL_RECOVERY_REQUIRED'}
    try{
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        if([IO.File]::Exists($file)){[IO.File]::Replace($temporary,$file,[System.Management.Automation.Language.NullString]::Value,$true)}
        else{[IO.File]::Move($temporary,$file)}
    }finally{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}
function Get-CodexsEnrollmentKeys($Value) {
    [string[]]$names=@($Value.PSObject.Properties.Name);[Array]::Sort($names,[StringComparer]::Ordinal);return ($names -join ',')
}
function Read-CodexsEnrollmentJournal($Options) {
    $file=Get-CodexsEnrollmentJournalPath $Options
    try{
        if(-not [IO.File]::Exists($file) -or ([IO.FileInfo]$file).Length -gt 262144){throw 'invalid'}
        $j=ConvertFrom-Json ([IO.File]::ReadAllText($file))
        if((Get-CodexsEnrollmentKeys $j) -cne 'expected,had_old,id,new_shims,old_root_sha256,old_shims,phase,schema'){throw 'invalid'}
        if($j.schema -ne 1 -or $j.id -isnot [string] -or $j.id -cnotmatch '^[a-f0-9]{32}$' -or $j.had_old -isnot [bool] -or
           $j.phase -cnotin @('prepared','old-moved','new-moved','shim-codexs.cmd','shim-codexs-statusline.cmd','shim-codexs.ps1','shim-codexs-statusline.ps1','committed')){throw 'invalid'}
        if($j.had_old){if($j.old_root_sha256 -isnot [string] -or $j.old_root_sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'invalid'}}
        elseif($null -ne $j.old_root_sha256){throw 'invalid'}
        foreach($set in @('old_shims','new_shims')){
            if((Get-CodexsEnrollmentKeys $j.$set) -cne 'codexs-statusline.cmd,codexs-statusline.ps1,codexs.cmd,codexs.ps1'){throw 'invalid'}
            foreach($name in (Get-CodexsEnrollmentNames)){
                $value=$j.$set.$name
                if($null -eq $value -and $set -ceq 'old_shims'){continue}
                if($value -isnot [string] -or $value.Length -gt 21848){throw 'invalid'}
                $bytes=[Convert]::FromBase64String($value)
                if($bytes.Length -gt 16384 -or [Convert]::ToBase64String($bytes) -cne $value){throw 'invalid'}
                $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
                $header=if($name.EndsWith('.ps1')){'\A# codexs managed shim\r?\n'}else{'\A@echo off\r?\nREM codexs managed shim\r?\n'}
                if($text -cnotmatch $header){throw 'invalid'}
            }
        }
        $e=$j.expected
        if((Get-CodexsEnrollmentKeys $e) -cne 'bootstrap_hashes,config,final_state,id,key_sha256,ref' -or $e.id -cne $j.id -or $e.key_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
           $e.final_state -isnot [string] -or $e.final_state.Length -gt 8192 -or $e.config.shim_root -ine $Options.ShimRoot){throw 'invalid'}
        if((Get-CodexsEnrollmentKeys $e.bootstrap_hashes) -cne 'bootstrap.cjs,paths.cjs,protocol.cjs'){throw 'invalid'}
        foreach($name in @('bootstrap.cjs','paths.cjs','protocol.cjs')){if($e.bootstrap_hashes.$name -cnotmatch '^[a-f0-9]{64}$'){throw 'invalid'}}
        return $j
    }catch{throw 'ENROLL_RECOVERY_REQUIRED'}
}
function Get-CodexsEnrollmentFile64([string]$File) {
    if([IO.Directory]::Exists($File)){throw 'ENROLL_SHIM_OWNER'}
    if(-not [IO.File]::Exists($File)){return $null}
    if(([IO.FileInfo]$File).Length -gt 16384){throw 'ENROLL_SHIM_OWNER'}
    return [Convert]::ToBase64String([IO.File]::ReadAllBytes($File))
}
function Assert-CodexsEnrollmentShims($Options,$Expected) {
    foreach($name in (Get-CodexsEnrollmentNames)){
        $file=Assert-CodexsEnrollmentPath $Options.AllowedShimRoot (Join-Path $Options.ShimRoot $name)
        if((Get-CodexsEnrollmentFile64 $file) -cne $Expected.$name){throw 'ENROLL_SHIM_VERIFY'}
    }
}
function Repair-CodexsEnrollment($Options,$Operations,$Journal,[switch]$Live) {
    $root=Assert-CodexsEnrollmentPath $Options.AllowedRoot $Options.InstallRoot
    $backup=Assert-CodexsEnrollmentPath $Options.AllowedRoot ($root+'.backup-'+$Journal.id)
    $failed=Assert-CodexsEnrollmentPath $Options.AllowedRoot ($root+'.failed-'+$Journal.id)
    $stage=Assert-CodexsEnrollmentPath $Options.AllowedRoot (Join-Path (Split-Path -Parent $root) ('codexs-enroll-'+$Journal.id))
    if($Journal.phase -ceq 'committed'){
        Invoke-CodexsEnrollmentNode $Options 'recover-installed' @{stage_root=$root;expected=$Journal.expected}|Out-Null
        Assert-CodexsEnrollmentShims $Options $Journal.new_shims
        [IO.File]::Delete((Get-CodexsEnrollmentJournalPath $Options))
        return [pscustomobject]@{Installed=$true;Recovered=$true;Code='ENROLLED';InstallRoot=$root;ShimRoot=$Options.ShimRoot;BackupRoot=$(if($Journal.had_old){$backup}else{$null})}
    }
    $rootExists=[IO.Directory]::Exists($root)
    $oldAtRoot=$false;$newAtRoot=$false
    if($rootExists){
        $marker=Assert-CodexsEnrollmentPath $Options.AllowedRoot (Join-Path $root '.enroll-owner.json')
        if([IO.File]::Exists($marker) -and ([IO.FileInfo]$marker).Length -le 128){
            $newAtRoot=[IO.File]::ReadAllText($marker) -ceq (Get-CodexsEnrollmentMarker $Journal.id)
        }
        if(-not $newAtRoot -and $Journal.had_old -and -not [IO.Directory]::Exists((Join-Path $root 'bootstrap'))){
            $oldAtRoot=(Get-CodexsEnrollmentHash (Join-Path $root 'launch.json')) -ceq $Journal.old_root_sha256
        }
        if(-not $newAtRoot -and -not $oldAtRoot){throw 'ENROLL_RECOVERY_REQUIRED'}
    }
    if($Journal.had_old -and -not $oldAtRoot){
        if(-not [IO.Directory]::Exists($backup) -or (Get-CodexsEnrollmentHash (Join-Path $backup 'launch.json')) -cne $Journal.old_root_sha256){throw 'ENROLL_RECOVERY_REQUIRED'}
    }
    foreach($name in (Get-CodexsEnrollmentNames)){
        $file=Assert-CodexsEnrollmentPath $Options.AllowedShimRoot (Join-Path $Options.ShimRoot $name)
        $current=Get-CodexsEnrollmentFile64 $file
        if(-not $Live -and $current -cne $Journal.old_shims.$name -and $current -cne $Journal.new_shims.$name){throw 'ENROLL_RECOVERY_REQUIRED'}
    }
    if($newAtRoot){
        try{& $Operations.MoveDirectory $root $failed}catch{if([IO.Directory]::Exists($root) -or -not [IO.Directory]::Exists($failed)){throw}}
    }
    if($Journal.had_old -and -not $oldAtRoot){
        try{& $Operations.MoveDirectory $backup $root}catch{if([IO.Directory]::Exists($backup) -or -not [IO.Directory]::Exists($root)){throw}}
    }
    foreach($name in (Get-CodexsEnrollmentNames)){
        $file=Assert-CodexsEnrollmentPath $Options.AllowedShimRoot (Join-Path $Options.ShimRoot $name)
        $old=$Journal.old_shims.$name
        if((Get-CodexsEnrollmentFile64 $file) -ceq $old){continue}
        if($null -eq $old){[IO.File]::Delete($file)}
        else{& $Operations.WriteShim $file ([Convert]::FromBase64String($old))}
    }
    Assert-CodexsEnrollmentShims $Options $Journal.old_shims
    if([IO.Directory]::Exists($stage)){
        $marker=Assert-CodexsEnrollmentPath $Options.AllowedRoot (Join-Path $stage '.enroll-owner.json')
        if(-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker) -cne (Get-CodexsEnrollmentMarker $Journal.id)){throw 'ENROLL_RECOVERY_REQUIRED'}
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
    [IO.File]::Delete((Get-CodexsEnrollmentJournalPath $Options))
    return [pscustomobject]@{Installed=$false;Recovered=$true;Code='ENROLL_RECOVERED';InstallRoot=$root;ShimRoot=$Options.ShimRoot;BackupRoot=$null}
}
function Invoke-CodexsEnrollmentCore($Options,$Operations,[switch]$Install) {
    $root=Assert-CodexsEnrollmentPath $Options.AllowedRoot $Options.InstallRoot
    [void](Assert-CodexsEnrollmentPath $Options.AllowedShimRoot $Options.ShimRoot)
    $journal=Get-CodexsEnrollmentJournalPath $Options
    if(-not $Install){
        if([IO.File]::Exists($journal) -or [IO.Directory]::Exists($journal)){throw 'ENROLL_RECOVERY_REQUIRED'}
        return Invoke-CodexsEnrollmentUnlocked $Options $Operations
    }
    $lockPath=Assert-CodexsEnrollmentPath $Options.AllowedRoot ($root+'.enroll.lock')
    $lock=$null
    try{
        if([IO.Directory]::Exists($lockPath) -or [IO.File]::Exists($lockPath) -and ([IO.FileInfo]$lockPath).Length -ne 0){throw 'ENROLL_OWNER'}
        try{$lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
        catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){throw 'ENROLL_BUSY'};throw 'ENROLL_IO'}
        Invoke-CodexsEnrollmentCheckpoint $Operations 'lease-held' $null
        if([IO.File]::Exists($journal) -or [IO.Directory]::Exists($journal)){
            try{return Repair-CodexsEnrollment $Options $Operations (Read-CodexsEnrollmentJournal $Options)}catch{throw 'ENROLL_RECOVERY_REQUIRED'}
        }
        return Invoke-CodexsEnrollmentUnlocked $Options $Operations -Install
    }finally{if($lock){$lock.Dispose()}}
}

function Invoke-CodexsEnrollmentUnlocked($Options,$Operations,[switch]$Install) {
    $root=Assert-CodexsEnrollmentPath $Options.AllowedRoot $Options.InstallRoot
    $shims=Assert-CodexsEnrollmentPath $Options.AllowedShimRoot $Options.ShimRoot
    foreach($name in @('Bundle','Manifest','Signature','PublicKey','NodePath','SettingsPath','PackageRoot')){
        if($Options[$name] -isnot [string] -or -not [IO.Path]::IsPathRooted($Options[$name])){throw 'ENROLL_INPUT'}
    }
    if([IO.Path]::GetFullPath($Options.SettingsPath).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'SETTINGS_HOLD'}
    if((& $Operations.NodeMajor $Options.NodePath) -lt 22){throw 'COMPATIBILITY'}
    if((& $Operations.FreeBytes $Options.AllowedRoot) -lt 8589934592){throw 'LOW_DISK'}
    $oldShims=@{}
    foreach($name in @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')){
        $file=Assert-CodexsEnrollmentPath $Options.AllowedShimRoot (Join-Path $shims $name)
        if([IO.Directory]::Exists($file)){throw 'ENROLL_SHIM_OWNER'}
        $oldShims[$name]=$null
        if([IO.File]::Exists($file)){
            $header=if($name.EndsWith('.ps1')){'\A# codexs managed shim\r?\n'}else{'\A@echo off\r?\nREM codexs managed shim\r?\n'}
            if(([IO.FileInfo]$file).Length -gt 16384 -or [IO.File]::ReadAllText($file) -cnotmatch $header){throw 'ENROLL_SHIM_OWNER'}
            $oldShims[$name]=[IO.File]::ReadAllBytes($file)
        }
    }
    $hadOld=[IO.Directory]::Exists($root)
    if([IO.File]::Exists($root)){throw 'ENROLL_OWNER'}
    if($hadOld){
        if([IO.Directory]::Exists((Join-Path $root 'bootstrap'))){throw 'ENROLL_EXISTS'}
        try{
            $legacy=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $root 'launch.json')))
            if($legacy.source_sha -cnotmatch '^[a-f0-9]{40}$' -or $legacy.version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or $legacy.product_version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$'){throw 'ENROLL_OWNER'}
        }catch{throw 'ENROLL_OWNER'}
        foreach($file in (& $Operations.RunningFiles)){
            if($file -is [string] -and $file.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ENROLL_RUNNING'}
        }
    }
    $proof=Invoke-CodexsEnrollmentNode $Options 'verify'
    $receipt=@{Installed=$false;InstallRoot=$root;ShimRoot=$shims;ReleaseId=$proof.release_id;ProductVersion=$proof.product_version;NativeVersion=$proof.upstream_version;PublicKeySha256=$proof.key_sha256;BackupRoot=$null}
    if(-not $Install){return [pscustomobject]$receipt}
    $id=[guid]::NewGuid().ToString('N')
    $stage=Assert-CodexsEnrollmentPath $Options.AllowedRoot (Join-Path (Split-Path -Parent $root) ('codexs-enroll-'+$id))
    $backup=Assert-CodexsEnrollmentPath $Options.AllowedRoot ($root+'.backup-'+$id)
    $failed=Assert-CodexsEnrollmentPath $Options.AllowedRoot ($root+'.failed-'+$id)
    $movedOld=$false;$movedNew=$false;$writingShims=$false;$journalWritten=$false
    try {
        & $Operations.CreateDirectory $stage
        Write-CodexsEnrollmentState $Options $stage $proof.initial_state
        $extra=@{stage_root=$stage;manifest_sha256=$proof.manifest_sha256;key_sha256=$proof.key_sha256;free_bytes=(& $Operations.FreeBytes $stage)}
        $staged=Invoke-CodexsEnrollmentNode $Options 'stage' $extra
        if($staged.manifest_sha256 -cne $proof.manifest_sha256 -or $staged.key_sha256 -cne $proof.key_sha256){throw 'ENROLL_MISMATCH'}
        $boot=Assert-CodexsEnrollmentPath $Options.AllowedRoot (Join-Path $stage 'bootstrap')
        & $Operations.CreateDirectory $boot
        foreach($name in @('bootstrap.cjs','protocol.cjs','paths.cjs')){& $Operations.CopyFile (Join-Path $Options.PackageRoot $name) (Join-Path $boot $name)}
        & $Operations.CopyFile $Options.PublicKey (Join-Path $boot 'release-public-key.pem')
        $config=@{schema=1;abi=1;node_path=$Options.NodePath;settings_path=$Options.SettingsPath;shim_root=$shims;shim_marker='codexs managed shim'}
        [IO.File]::WriteAllText((Join-Path $boot 'config.json'),(ConvertTo-Json $config -Compress),[Text.UTF8Encoding]::new($false))
        $extra.expected_config=$config
        Write-CodexsEnrollmentState $Options $stage $staged.final_state
        Invoke-CodexsEnrollmentNode $Options 'installed' $extra|Out-Null
        $old64=@{};$new64=@{}
        foreach($name in (Get-CodexsEnrollmentNames)){
            $old64[$name]=if($null -eq $oldShims[$name]){$null}else{[Convert]::ToBase64String($oldShims[$name])}
            $mode=if($name -cin @('codexs.cmd','codexs.ps1')){'cli'}else{'editor'}
            $bytes=if($name.EndsWith('.ps1')){New-CodexsEnrollmentPowerShellShim $Options.NodePath (Join-Path $root 'bootstrap/bootstrap.cjs') $mode}else{New-CodexsEnrollmentShim $Options.NodePath (Join-Path $root 'bootstrap/bootstrap.cjs') $mode}
            $new64[$name]=[Convert]::ToBase64String($bytes)
        }
        $oldDigest=if($hadOld){Get-CodexsEnrollmentHash (Join-Path $root 'launch.json')}else{$null}
        $final=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($staged.final_state)))
        $j=@{schema=1;id=$id;phase='prepared';had_old=$hadOld;old_root_sha256=$oldDigest;old_shims=$old64;new_shims=$new64;
            expected=@{id=$id;ref=$final.current;config=$config;bootstrap_hashes=$staged.bootstrap_hashes;key_sha256=$proof.key_sha256;final_state=$staged.final_state}}
        [IO.File]::WriteAllText((Join-Path $stage '.enroll-owner.json'),(Get-CodexsEnrollmentMarker $id),[Text.UTF8Encoding]::new($false))
        Write-CodexsEnrollmentJournal $Options $j;$journalWritten=$true
        Assert-CodexsEnrollmentShims $Options ([pscustomobject]$old64)
        if($hadOld -and (Get-CodexsEnrollmentHash (Join-Path $root 'launch.json')) -cne $oldDigest){throw 'ENROLL_OWNER'}
        Invoke-CodexsEnrollmentCheckpoint $Operations 'prepared' $j
        if($hadOld){try{& $Operations.MoveDirectory $root $backup}finally{$movedOld=[IO.Directory]::Exists($backup)}}
        $j.phase='old-moved';Write-CodexsEnrollmentJournal $Options $j
        Invoke-CodexsEnrollmentCheckpoint $Operations 'old-moved' $j
        try{& $Operations.MoveDirectory $stage $root}finally{$movedNew=[IO.Directory]::Exists($root) -and -not [IO.Directory]::Exists($stage)}
        $j.phase='new-moved';Write-CodexsEnrollmentJournal $Options $j
        Invoke-CodexsEnrollmentCheckpoint $Operations 'new-moved' $j
        $installedExtra=@{stage_root=$root;manifest_sha256=$proof.manifest_sha256;key_sha256=$proof.key_sha256;expected_config=$config}
        Invoke-CodexsEnrollmentNode $Options 'installed' $installedExtra|Out-Null
        & $Operations.CreateDirectory $shims
        $writingShims=$true
        foreach($name in @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')){
            $mode=if($name -cin @('codexs.cmd','codexs.ps1')){'cli'}else{'editor'}
            $file=Assert-CodexsEnrollmentPath $Options.AllowedShimRoot (Join-Path $shims $name)
            $bytes=if($name.EndsWith('.ps1')){New-CodexsEnrollmentPowerShellShim $Options.NodePath (Join-Path $root 'bootstrap/bootstrap.cjs') $mode}else{New-CodexsEnrollmentShim $Options.NodePath (Join-Path $root 'bootstrap/bootstrap.cjs') $mode}
            & $Operations.WriteShim $file $bytes
            $j.phase='shim-'+$name;Write-CodexsEnrollmentJournal $Options $j
            Invoke-CodexsEnrollmentCheckpoint $Operations $j.phase $j
        }
        Invoke-CodexsEnrollmentNode $Options 'recover-installed' @{stage_root=$root;expected=$j.expected}|Out-Null
        Assert-CodexsEnrollmentShims $Options ([pscustomobject]$new64)
        $j.phase='committed';Write-CodexsEnrollmentJournal $Options $j
        Invoke-CodexsEnrollmentCheckpoint $Operations 'committed' $j
        [IO.File]::Delete((Get-CodexsEnrollmentJournalPath $Options))
        $receipt.Installed=$true
        if($movedOld){$receipt.BackupRoot=$backup}
        return [pscustomobject]$receipt
    } catch {
        $problem=$_.Exception.Message
        if($journalWritten){try{Repair-CodexsEnrollment $Options $Operations (Read-CodexsEnrollmentJournal $Options) -Live:$writingShims|Out-Null}catch{throw 'ENROLL_RECOVERY_REQUIRED'}}
        if($problem -cmatch '^[A-Z][A-Z0-9_]{0,63}$'){throw $problem}
        throw 'ENROLL_FAILED'
    } finally {
        if([IO.Directory]::Exists($stage) -and -not [IO.File]::Exists((Get-CodexsEnrollmentJournalPath $Options))){
            $safe=Assert-CodexsEnrollmentPath $Options.AllowedRoot $stage
            if((Split-Path -Leaf $safe) -cnotmatch '^codexs-enroll-[a-f0-9]{32}$'){throw 'ENROLL_PATH'}
            Remove-Item -LiteralPath $safe -Recurse -Force
        }
    }
}

function Invoke-CodexsEnrollment {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$Bundle,[Parameter(Mandatory=$true)][string]$Manifest,[Parameter(Mandatory=$true)][string]$Signature,[Parameter(Mandatory=$true)][string]$PublicKey,[Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$SettingsPath,[switch]$Install)
    if(-not $script:CodexsEnrollmentPackageRoot){throw 'ENROLL_PACKAGE'}
    $options=@{Bundle=$Bundle;Manifest=$Manifest;Signature=$Signature;PublicKey=$PublicKey;NodePath=$NodePath;SettingsPath=$SettingsPath;
        PackageRoot=$script:CodexsEnrollmentPackageRoot;AllowedRoot=$env:LOCALAPPDATA;InstallRoot=(Join-Path $env:LOCALAPPDATA 'codexs');
        AllowedShimRoot=$env:USERPROFILE;ShimRoot=(Join-Path $env:USERPROFILE '.local/bin')}
    Invoke-CodexsEnrollmentCore $options (Get-CodexsEnrollmentOperations) -Install:$Install
}
if($Bundle){Invoke-CodexsEnrollment -Bundle $Bundle -Manifest $Manifest -Signature $Signature -PublicKey $PublicKey -NodePath $NodePath -SettingsPath $SettingsPath -Install:$Install}
