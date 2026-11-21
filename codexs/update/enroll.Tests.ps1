param(
    [string]$EnrollmentScript=(Join-Path (Get-Location) 'codexs/update/enroll.ps1'),
    [Alias('NodePath')][string]$TestNodePath=(Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference='Stop'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('codexs-enroll-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$script:passed=0
$script:failures=[Collections.Generic.List[string]]::new()
$script:fixtureRoots=[Collections.Generic.List[string]]::new()
if([IO.File]::Exists($EnrollmentScript)){. ([scriptblock]::Create([IO.File]::ReadAllText($EnrollmentScript)))}
function Assert-EnrollTest([bool]$Value,[string]$Message='Synthetic enrollment assertion failed'){if(-not $Value){throw $Message}}
function Check-EnrollTest([string]$Name,[scriptblock]$Body){
    try{& $Body;$script:passed++;Write-Output ('PASS '+$Name)}
    catch{$script:failures.Add($Name+': '+$_.Exception.Message);Write-Output ('FAIL '+$Name+': '+$_.Exception.Message)}
}
function Require-EnrollApi {
    Assert-EnrollTest ($null -ne (Get-Command Invoke-CodexsEnrollmentCore -ErrorAction SilentlyContinue)) 'signed enrollment core must exist'
    Assert-EnrollTest ($null -ne (Get-Command Get-CodexsEnrollmentOperations -ErrorAction SilentlyContinue))
}
function New-EnrollFixture([string]$Kind='valid') {
    $module=Join-Path (Split-Path -Parent (Split-Path -Parent $EnrollmentScript)) 'test-support/update-fixtures.cjs'
    $data=@{kind=$Kind;module=$module;node=$TestNodePath}|ConvertTo-Json -Compress
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($data))
    $program=@'
const fs=require('node:fs/promises'),path=require('node:path');const input=JSON.parse(Buffer.from(process.argv[2],'base64'));const cleanup=[];(async()=>{const helper=require(input.module);const f=await helper.probeInstallation({after:fn=>cleanup.push(fn)});const options=input.kind==='abi'?{manifest:{bootstrap_min:2}}:input.kind==='missing-module'?{payload:{'update/coordinator.ps1':null}}:{};let a=await f.install(1,options);const pkg=path.join(f.root,'installer','update');await fs.mkdir(pkg,{recursive:true});for(const name of ['bootstrap.cjs','protocol.cjs','paths.cjs','stage.cjs','state.cjs','http.cjs','launch.cjs','archive.ps1','coordinator.ps1','enroll.ps1'])await fs.copyFile(path.join(path.dirname(input.module),'..','update',name),path.join(pkg,name));const bundle=path.join(f.root,'bundle.zip');await helper.zipDirectory(bundle,a.directory,a.release.files.map(x=>x.path));a=await f.sealArchive(a,bundle);if(input.kind==='signature')await fs.writeFile(path.join(a.directory,'release.sig'),Buffer.alloc(64));const settings=path.join(f.root,'settings.json');await fs.writeFile(settings,JSON.stringify({version:4,lines:[[{id:'one',type:'custom-text',customText:'synthetic'}],[{id:'two',type:'custom-text',customText:'retained second line'}]],unknown_future:{keep:true}}));console.log(JSON.stringify({root:f.root,ref:a.ref,options:{AllowedRoot:f.root,InstallRoot:path.join(f.root,'installed codexs'),AllowedShimRoot:f.root,ShimRoot:path.join(f.root,'shims'),PackageRoot:pkg,Bundle:bundle,Manifest:path.join(a.directory,'release.json'),Signature:path.join(a.directory,'release.sig'),PublicKey:path.join(f.root,'bootstrap','release-public-key.pem'),NodePath:input.node,SettingsPath:settings}}));})().catch(async error=>{for(const fn of cleanup)await fn().catch(()=>{});console.error(error.message);process.exitCode=1});
'@
    $output=@($program | & $TestNodePath - $encoded)
    if($LASTEXITCODE -ne 0){throw 'Synthetic signed enrollment fixture failed'}
    $receipt=ConvertFrom-Json ($output -join [Environment]::NewLine)
    $full=[IO.Path]::GetFullPath($receipt.root)
    Assert-EnrollTest ((Split-Path -Parent $full) -ieq ([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')))
    Assert-EnrollTest ((Split-Path -Leaf $full) -like 'codexs-launch-test-*')
    $script:fixtureRoots.Add($full)
    foreach($name in @('auth.json','history.jsonl')){[IO.File]::WriteAllText((Join-Path $full ('synthetic-'+$name)),('synthetic untouched '+$name))}
    $options=@{};foreach($property in $receipt.options.PSObject.Properties){$options[$property.Name]=$property.Value}
    $ops=Get-CodexsEnrollmentOperations
    $ops.FreeBytes={param($Path) return [long]8589934592}
    return @{Root=$full;Options=$options;Ops=$ops;Ref=$receipt.ref}
}
function Call-Enroll($Fixture,[switch]$Install) {
    Invoke-CodexsEnrollmentCore -Options $Fixture.Options -Operations $Fixture.Ops -Install:$Install
}
function Prepare-OwnedPrototype($Fixture) {
    [void][IO.Directory]::CreateDirectory($Fixture.Options.InstallRoot)
    [void][IO.Directory]::CreateDirectory($Fixture.Options.ShimRoot)
    $manifest=@{source_sha=('a'*40);version='0.162.1';product_version='1.0.0'}
    [IO.File]::WriteAllText((Join-Path $Fixture.Options.InstallRoot 'launch.json'),(ConvertTo-Json $manifest -Compress),[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $Fixture.Options.InstallRoot 'legacy-sentinel'),'synthetic old installation')
    foreach($name in @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')){[IO.File]::WriteAllText((Join-Path $Fixture.Options.ShimRoot $name),(($([string]$(if($name.EndsWith('.ps1')){'# codexs managed shim'}else{'@echo off'+[Environment]::NewLine+'REM codexs managed shim'})))+[Environment]::NewLine+'# synthetic old '+$name),[Text.UTF8Encoding]::new($false))}
}
$script:enrollmentChildren=[Collections.Generic.List[Diagnostics.Process]]::new()
function Start-EnrollChild($Fixture,[string]$Phase) {
    $marker=Join-Path $Fixture.Root 'enrollment-checkpoint'
    $release=Join-Path $Fixture.Root 'enrollment-release'
    $scriptText=@'
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$options=@{};$data=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ENROLL_TEST_OPTIONS)));foreach($p in $data.PSObject.Properties){$options[$p.Name]=$p.Value}
. ([scriptblock]::Create([IO.File]::ReadAllText($env:ENROLL_TEST_SCRIPT)))
$ops=Get-CodexsEnrollmentOperations;$ops.FreeBytes={param($Path) return [long]8589934592}
$phase=$env:ENROLL_TEST_PHASE;$marker=$env:ENROLL_TEST_MARKER;$release=$env:ENROLL_TEST_RELEASE
$checkpoint={param($Name,$Journal) if($Name -ceq $phase){[IO.File]::WriteAllText($marker,$Name);$end=[DateTime]::UtcNow.AddSeconds(60);while(-not [IO.File]::Exists($release)){if([DateTime]::UtcNow -gt $end){throw 'SYNTHETIC_CHECKPOINT_DEADLINE'};[Threading.Thread]::Sleep(10)}}}.GetNewClosure()
$ops.Checkpoint=$checkpoint
$move=$ops.MoveDirectory;$root=$options.InstallRoot
$ops.MoveDirectory={param($Source,$Target) if($Source -ceq $root -and $Target.StartsWith($root+'.backup-')){& $checkpoint 'prepared' $null};& $move $Source $Target;if($Source -ceq $root -and $Target.StartsWith($root+'.backup-')){& $checkpoint 'old-moved' $null};if($Target -ceq $root -and (Split-Path -Leaf $Source) -like 'codexs-enroll-*'){& $checkpoint 'new-moved' $null}}.GetNewClosure()
$write=$ops.WriteShim
$ops.WriteShim={param($Path,[byte[]]$Bytes) & $write $Path $Bytes;& $checkpoint ('shim-'+(Split-Path -Leaf $Path)) $null}.GetNewClosure()
$result=Invoke-CodexsEnrollmentCore $options $ops -Install
& $checkpoint 'committed' $null
[Console]::Out.WriteLine((ConvertTo-Json $result -Compress))
'@
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables['ENROLL_TEST_OPTIONS']=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $Fixture.Options -Compress)))
    $info.EnvironmentVariables['ENROLL_TEST_SCRIPT']=$EnrollmentScript
    $info.EnvironmentVariables['ENROLL_TEST_PHASE']=$Phase;$info.EnvironmentVariables['ENROLL_TEST_MARKER']=$marker;$info.EnvironmentVariables['ENROLL_TEST_RELEASE']=$release
    $child=[Diagnostics.Process]::Start($info);$script:enrollmentChildren.Add($child)
    $stop=[DateTime]::UtcNow.AddSeconds(30)
    while(-not [IO.File]::Exists($marker)){
        if($child.HasExited){throw ('Synthetic installer missed checkpoint: '+$Phase+' '+$child.StandardError.ReadToEnd())}
        if([DateTime]::UtcNow -gt $stop){throw 'Synthetic installer readiness timeout'}
        [Threading.Thread]::Sleep(20)
    }
    return $child
}

try {
    Check-EnrollTest 'default shim writer replaces an owned existing command without losing bytes' {
        Require-EnrollApi
        $file=Join-Path $testRoot 'owned.cmd'
        [IO.File]::WriteAllText($file,'synthetic old shim')
        $ops=Get-CodexsEnrollmentOperations
        & $ops.WriteShim $file ([Text.Encoding]::UTF8.GetBytes('synthetic new shim'))
        Assert-EnrollTest ([IO.File]::ReadAllText($file) -ceq 'synthetic new shim')
        Assert-EnrollTest (@(Get-ChildItem -LiteralPath $testRoot -File -Filter 'owned.cmd.tmp-*').Count -eq 0)
    }
    Check-EnrollTest 'signed preview verifies inputs without creating install state shims or changing settings' {
        Require-EnrollApi
        $f=New-EnrollFixture
        $settings=[IO.File]::ReadAllBytes($f.Options.SettingsPath)
        $result=Call-Enroll $f
        Assert-EnrollTest (-not $result.Installed -and $result.ReleaseId -ceq $f.Ref.release_id)
        Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.InstallRoot))
        Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.ShimRoot))
        Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.Options.SettingsPath)) -ceq [Convert]::ToBase64String($settings))
    }
    Check-EnrollTest 'invalid signature ABI and operational inventory prevent installation writes' {
        Require-EnrollApi
        foreach($kind in @('signature','abi','missing-module')){
            $f=New-EnrollFixture $kind;$failed=$false
            try{Call-Enroll $f -Install|Out-Null}catch{$failed=$true;$actualCode=$_.Exception.Message}
            Assert-EnrollTest $failed
            if($kind){$expectedCode=if($kind -ceq 'signature'){'SIGNATURE'}elseif($kind -ceq 'abi'){'COMPATIBILITY'}else{'ENROLL_PACKAGE'};Assert-EnrollTest ($actualCode -ceq $expectedCode) ('invalid fixture '+$kind+' rejected for '+$actualCode)}
            Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.InstallRoot))
            Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.ShimRoot))
        }
    }
    Check-EnrollTest 'prerequisite disk and settings holds preserve the original settings bytes' {
        Require-EnrollApi
        $f=New-EnrollFixture
        foreach($reason in @('node','disk','settings')){
            $f.Ops=Get-CodexsEnrollmentOperations
            $f.Ops.FreeBytes={param($Path) return [long]8589934592}
            if($reason -ceq 'node'){$f.Ops.NodeMajor={param($Path) return 21}}
            if($reason -ceq 'disk'){$f.Ops.FreeBytes={param($Path) return [long]8589934591}}
            if($reason -ceq 'settings'){[IO.File]::WriteAllText($f.Options.SettingsPath,'{"version":5,"unknown":["preserve"]}')}
            $before=[IO.File]::ReadAllBytes($f.Options.SettingsPath);$failed=$false
            try{Call-Enroll $f -Install|Out-Null}catch{$failed=$true}
            Assert-EnrollTest $failed
            Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.InstallRoot))
            Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.Options.SettingsPath)) -ceq [Convert]::ToBase64String($before))
        }
    }
    Check-EnrollTest 'unowned shims and unknown existing installations cannot be replaced' {
        Require-EnrollApi
        $f=New-EnrollFixture
        [void][IO.Directory]::CreateDirectory($f.Options.ShimRoot)
        $shim=Join-Path $f.Options.ShimRoot 'codexs.cmd';[IO.File]::WriteAllText($shim,'synthetic unrelated command')
        $failed=$false;try{Call-Enroll $f -Install|Out-Null}catch{$failed=$true}
        Assert-EnrollTest $failed
        Assert-EnrollTest ([IO.File]::ReadAllText($shim) -ceq 'synthetic unrelated command')
        [IO.File]::Delete($shim)
        [void][IO.Directory]::CreateDirectory($f.Options.InstallRoot)
        [IO.File]::WriteAllText((Join-Path $f.Options.InstallRoot 'unknown'),'synthetic unrelated directory')
        $failed=$false;try{Call-Enroll $f -Install|Out-Null}catch{$failed=$true}
        Assert-EnrollTest $failed
        Assert-EnrollTest ([IO.File]::ReadAllText((Join-Path $f.Options.InstallRoot 'unknown')) -ceq 'synthetic unrelated directory')
    }
    Check-EnrollTest 'signed installation is complete and refuses implicit reenrollment' {
        Require-EnrollApi
        $f=New-EnrollFixture
        $settings=[IO.File]::ReadAllBytes($f.Options.SettingsPath)
        $result=Call-Enroll $f -Install
        Assert-EnrollTest $result.Installed
        $state=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $f.Options.InstallRoot 'current.json')))
        Assert-EnrollTest ($state.current.release_id -ceq $f.Ref.release_id)
        foreach($file in @('bootstrap/bootstrap.cjs','bootstrap/protocol.cjs','bootstrap/paths.cjs','bootstrap/config.json','bootstrap/release-public-key.pem')){Assert-EnrollTest ([IO.File]::Exists((Join-Path $f.Options.InstallRoot $file)))}
        foreach($name in @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')){Assert-EnrollTest ([IO.File]::Exists((Join-Path $f.Options.ShimRoot $name)))}
        $failed=$false;try{Call-Enroll $f -Install|Out-Null}catch{$failed=$true}
        Assert-EnrollTest $failed
        Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.Options.SettingsPath)) -ceq [Convert]::ToBase64String($settings))
    }
    Check-EnrollTest 'enrollment restores the old installation at each copy move and shim failure boundary' {
        Require-EnrollApi
        foreach($boundary in @('copy-before','old-move-before','old-move-after','new-move-before','new-move-after','first-shim-after','second-shim-after','third-shim-after','fourth-shim-after')){
            $f=New-EnrollFixture;Prepare-OwnedPrototype $f
            $before=[IO.File]::ReadAllBytes($f.Options.SettingsPath)
            $shimBytes=@{};foreach($name in @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')){$shimBytes[$name]=[IO.File]::ReadAllBytes((Join-Path $f.Options.ShimRoot $name))}
            $copy=$f.Ops.CopyFile;$move=$f.Ops.MoveDirectory;$write=$f.Ops.WriteShim;$root=$f.Options.InstallRoot;$count=@{n=0}
            if($boundary -ceq 'copy-before'){
                $f.Ops.CopyFile={param($Source,$Target) if((Split-Path -Leaf $Target) -ceq 'protocol.cjs'){throw 'SYNTHETIC_BOUNDARY'};& $copy $Source $Target}.GetNewClosure()
            } elseif($boundary -like '*move*'){
                $f.Ops.MoveDirectory={
                    param($Source,$Target)
                    $selected=($boundary -like 'old-*' -and $Source -ceq $root) -or ($boundary -like 'new-*' -and $Target -ceq $root -and (Split-Path -Leaf $Source) -like 'codexs-enroll-*')
                    if($selected -and $boundary -like '*before'){throw 'SYNTHETIC_BOUNDARY'}
                    & $move $Source $Target
                    if($selected -and $boundary -like '*after'){throw 'SYNTHETIC_BOUNDARY'}
                }.GetNewClosure()
            } else {
                $f.Ops.WriteShim={param($Path,[byte[]]$Bytes) $count.n++;& $write $Path $Bytes;if(($boundary -ceq 'first-shim-after' -and $count.n -eq 1) -or ($boundary -ceq 'second-shim-after' -and $count.n -eq 2) -or ($boundary -ceq 'third-shim-after' -and $count.n -eq 3) -or ($boundary -ceq 'fourth-shim-after' -and $count.n -eq 4)){throw 'SYNTHETIC_BOUNDARY'}}.GetNewClosure()
            }
            $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
            Assert-EnrollTest ($code -ceq 'SYNTHETIC_BOUNDARY') ('intended boundary '+$boundary+' must fail explicitly; code='+$code)
            Assert-EnrollTest ([IO.File]::Exists((Join-Path $root 'legacy-sentinel'))) ('old installation restored: '+$boundary)
            foreach($name in $shimBytes.Keys){Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $f.Options.ShimRoot $name))) -ceq [Convert]::ToBase64String($shimBytes[$name]))}
            Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.Options.SettingsPath)) -ceq [Convert]::ToBase64String($before))
        }
    }
    Check-EnrollTest 'bootstrap copy corruption and changed final state block activation and restore the old root' {
        Require-EnrollApi
        foreach($kind in @('bootstrap','state')){
            $f=New-EnrollFixture;Prepare-OwnedPrototype $f
            $copy=$f.Ops.CopyFile;$move=$f.Ops.MoveDirectory;$root=$f.Options.InstallRoot
            if($kind -ceq 'bootstrap'){
                $f.Ops.CopyFile={param($Source,$Target) & $copy $Source $Target;if((Split-Path -Leaf $Target) -ceq 'paths.cjs'){[IO.File]::AppendAllText($Target,'synthetic corruption')}}.GetNewClosure()
            }else{
                $f.Ops.MoveDirectory={param($Source,$Target) & $move $Source $Target;if($Target -ceq $root -and (Split-Path -Leaf $Source) -like 'codexs-enroll-*'){$file=Join-Path $root 'current.json';$state=ConvertFrom-Json ([IO.File]::ReadAllText($file));$state.rejected=@($state.current.release_id);[IO.File]::WriteAllText($file,(ConvertTo-Json $state -Compress -Depth 12),[Text.UTF8Encoding]::new($false))}}.GetNewClosure()
            }
            $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
            $expected=if($kind -ceq 'bootstrap'){'ENROLL_PACKAGE'}else{'STATE_SCHEMA'}
            Assert-EnrollTest ($code -ceq $expected) ('corrupt '+$kind+' must fail '+$expected+'; code='+$code)
            Assert-EnrollTest ([IO.File]::Exists((Join-Path $root 'legacy-sentinel')))
        }
    }
    Check-EnrollTest 'failed recovery retains the old backup and reports a bounded maintenance code' {
        Require-EnrollApi
        $f=New-EnrollFixture;Prepare-OwnedPrototype $f
        $move=$f.Ops.MoveDirectory
        $f.Ops.WriteShim={param($Path,[byte[]]$Bytes) throw 'SYNTHETIC_SHIM_FAILURE'}
        $f.Ops.MoveDirectory={param($Source,$Target) if((Split-Path -Leaf $Source) -like '*.backup-*'){throw 'SYNTHETIC_RECOVERY_FAILURE'};& $move $Source $Target}.GetNewClosure()
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_RECOVERY_REQUIRED')
        $backups=@(Get-ChildItem -LiteralPath $f.Root -Directory | Where-Object {$_.Name -like '*.backup-*'})
        Assert-EnrollTest ($backups.Count -eq 1)
        Assert-EnrollTest ([IO.File]::ReadAllText((Join-Path $backups[0].FullName 'legacy-sentinel')) -ceq 'synthetic old installation')
    }
    Check-EnrollTest 'PowerShell shim collisions and junction destinations fail before replacing owned files' {
        Require-EnrollApi
        $f=New-EnrollFixture
        [void][IO.Directory]::CreateDirectory($f.Options.ShimRoot)
        $file=Join-Path $f.Options.ShimRoot 'codexs.ps1'
        [IO.File]::WriteAllText($file,'synthetic unrelated PowerShell command')
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_SHIM_OWNER')
        Assert-EnrollTest ([IO.File]::ReadAllText($file) -ceq 'synthetic unrelated PowerShell command')
        Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.InstallRoot))
        $f=New-EnrollFixture
        $outside=Join-Path $f.Root 'junction sentinel';[void][IO.Directory]::CreateDirectory($outside)
        [IO.File]::WriteAllText((Join-Path $outside 'sentinel'),'synthetic untouched junction target')
        New-Item -ItemType Junction -Path $f.Options.InstallRoot -Target $outside|Out-Null
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_PATH')
        Assert-EnrollTest ([IO.File]::ReadAllText((Join-Path $outside 'sentinel')) -ceq 'synthetic untouched junction target')
    }
    Check-EnrollTest 'a missing explicit Node prerequisite reports only a bounded code' {
        Require-EnrollApi
        $f=New-EnrollFixture
        $f.Options.NodePath=Join-Path $f.Root 'missing-synthetic-node.exe'
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_NODE') 'missing Node must not expose its command/path error'
        Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.InstallRoot) -and -not [IO.Directory]::Exists($f.Options.ShimRoot))
    }
    Check-EnrollTest 'an OS enrollment lease excludes another installer before replacement' {
        $f=New-EnrollFixture;Prepare-OwnedPrototype $f
        $lock=[IO.File]::Open(($f.Options.InstallRoot+'.enroll.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $code=$null;try{try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}}finally{$lock.Dispose()}
        Assert-EnrollTest ($code -ceq 'ENROLL_BUSY')
        Assert-EnrollTest ([IO.File]::Exists((Join-Path $f.Options.InstallRoot 'legacy-sentinel')))
    }
    Check-EnrollTest 'overlapping installers leave exactly one enrolled winner' {
        $f=New-EnrollFixture;Prepare-OwnedPrototype $f
        $child=Start-EnrollChild $f 'lease-held'
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_BUSY')
        [IO.File]::WriteAllText((Join-Path $f.Root 'enrollment-release'),'continue')
        Assert-EnrollTest ($child.WaitForExit(30000))
        Assert-EnrollTest ($child.ExitCode -eq 0) ($child.StandardError.ReadToEnd())
        $receipt=ConvertFrom-Json ($child.StandardOutput.ReadToEnd());Assert-EnrollTest $receipt.Installed
        $before=[IO.File]::ReadAllBytes((Join-Path $f.Options.InstallRoot 'current.json'))
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_EXISTS')
        Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $f.Options.InstallRoot 'current.json'))) -ceq [Convert]::ToBase64String($before))
    }
    Check-EnrollTest 'process death at each activation boundary is recoverable without source assets' {
        foreach($phase in @('prepared','old-moved','new-moved','shim-codexs.cmd','shim-codexs-statusline.cmd','shim-codexs.ps1','shim-codexs-statusline.ps1','committed')){
            $f=New-EnrollFixture;Prepare-OwnedPrototype $f
            $settings=[IO.File]::ReadAllBytes($f.Options.SettingsPath);$old=@{}
            foreach($name in @('codexs.cmd','codexs-statusline.cmd','codexs.ps1','codexs-statusline.ps1')){$old[$name]=[IO.File]::ReadAllBytes((Join-Path $f.Options.ShimRoot $name))}
            $child=Start-EnrollChild $f $phase
            Assert-EnrollTest ([IO.File]::Exists(($f.Options.InstallRoot+'.enroll.json'))) ('journal must precede '+$phase)
            $child.Kill();Assert-EnrollTest ($child.WaitForExit(5000))
            foreach($name in @('Bundle','Manifest','Signature','PublicKey')){
                $asset=[IO.Path]::GetFullPath($f.Options[$name]);Assert-EnrollTest ($asset.StartsWith($f.Root+'\',[StringComparison]::OrdinalIgnoreCase))
                [IO.File]::Delete($asset)
            }
            $receipt=Call-Enroll $f -Install
            if($phase -ceq 'committed'){Assert-EnrollTest $receipt.Installed}
            else{
                Assert-EnrollTest ($receipt.Recovered -and -not $receipt.Installed) ('recovered old installation at '+$phase)
                Assert-EnrollTest ([IO.File]::Exists((Join-Path $f.Options.InstallRoot 'legacy-sentinel')))
                foreach($name in $old.Keys){Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $f.Options.ShimRoot $name))) -ceq [Convert]::ToBase64String($old[$name]))}
            }
            Assert-EnrollTest (-not [IO.File]::Exists(($f.Options.InstallRoot+'.enroll.json')))
            Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($f.Options.SettingsPath)) -ceq [Convert]::ToBase64String($settings))
        }
    }
    Check-EnrollTest 'recovery preserves unknown data and remains retryable after another interruption' {
        $f=New-EnrollFixture;Prepare-OwnedPrototype $f
        $child=Start-EnrollChild $f 'shim-codexs.cmd';$child.Kill();Assert-EnrollTest ($child.WaitForExit(5000))
        $journal=$f.Options.InstallRoot+'.enroll.json';$before=[IO.File]::ReadAllBytes($journal)
        foreach($invalid in @('{"schema":1,"id":"../outside"}',('x'*262145))){
            [IO.File]::WriteAllText($journal,$invalid)
            $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
            Assert-EnrollTest ($code -ceq 'ENROLL_RECOVERY_REQUIRED')
            Assert-EnrollTest ([IO.File]::ReadAllText($journal) -ceq $invalid)
        }
        [IO.File]::WriteAllBytes($journal,$before)
        $shim=Join-Path $f.Options.ShimRoot 'codexs.cmd';$new=[IO.File]::ReadAllBytes($shim)
        [IO.File]::WriteAllText($shim,'synthetic user change after crash')
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_RECOVERY_REQUIRED')
        Assert-EnrollTest ([IO.File]::ReadAllText($shim) -ceq 'synthetic user change after crash')
        [IO.File]::WriteAllBytes($shim,$new)
        $write=$f.Ops.WriteShim
        $f.Ops.WriteShim={param($Path,[byte[]]$Bytes) throw 'SYNTHETIC_RECOVERY_INTERRUPTION'}
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_RECOVERY_REQUIRED')
        Assert-EnrollTest ([IO.File]::Exists((Join-Path $f.Options.InstallRoot 'legacy-sentinel')))
        Assert-EnrollTest ([IO.File]::Exists($journal))
        $f.Ops.WriteShim=$write
        $receipt=Call-Enroll $f -Install
        Assert-EnrollTest ($receipt.Recovered -and -not $receipt.Installed)
        Assert-EnrollTest (-not [IO.File]::Exists($journal))
    }
    Check-EnrollTest 'interrupted first enrollment restores absent installation and commands' {
        $f=New-EnrollFixture
        $child=Start-EnrollChild $f 'shim-codexs.ps1';$child.Kill();Assert-EnrollTest ($child.WaitForExit(5000))
        $receipt=Call-Enroll $f -Install
        Assert-EnrollTest ($receipt.Recovered -and -not $receipt.Installed)
        Assert-EnrollTest (-not [IO.Directory]::Exists($f.Options.InstallRoot))
        foreach($name in (Get-CodexsEnrollmentNames)){Assert-EnrollTest (-not [IO.File]::Exists((Join-Path $f.Options.ShimRoot $name)))}
    }
    Check-EnrollTest 'final config and shim verification refuses a false successful receipt' {
        foreach($kind in @('config','shim')){
            $f=New-EnrollFixture;Prepare-OwnedPrototype $f;$root=$f.Options.InstallRoot
            $move=$f.Ops.MoveDirectory;$write=$f.Ops.WriteShim;$count=@{n=0}
            if($kind -ceq 'config'){
                $f.Ops.MoveDirectory={param($Source,$Target) & $move $Source $Target;if($Target -ceq $root -and (Split-Path -Leaf $Source) -like 'codexs-enroll-*'){$file=Join-Path $root 'bootstrap/config.json';$value=ConvertFrom-Json ([IO.File]::ReadAllText($file));$value.settings_path=Join-Path $root 'wrong-settings';[IO.File]::WriteAllText($file,(ConvertTo-Json $value -Compress))}}.GetNewClosure()
            }else{
                $f.Ops.WriteShim={param($Path,[byte[]]$Bytes) $count.n++;& $write $Path $Bytes;if($count.n -eq 4){[IO.File]::WriteAllText($Path,'synthetic corrupted new shim')}}.GetNewClosure()
            }
            $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
            Assert-EnrollTest ($code -cin @('ENROLL_CONFIG','ENROLL_SHIM_VERIFY')) ('false success blocked: '+$kind+' '+$code)
            Assert-EnrollTest ([IO.File]::Exists((Join-Path $root 'legacy-sentinel')))
        }
    }
    Check-EnrollTest 'missing settings and an active old executable hold enrollment without writing' {
        Require-EnrollApi
        $f=New-EnrollFixture
        [IO.File]::Delete($f.Options.SettingsPath)
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'SETTINGS_HOLD')
        Assert-EnrollTest (-not [IO.File]::Exists($f.Options.SettingsPath) -and -not [IO.Directory]::Exists($f.Options.InstallRoot))
        $f=New-EnrollFixture;Prepare-OwnedPrototype $f
        $active=Join-Path $f.Options.InstallRoot 'bin/codex.exe'
        $f.Ops.RunningFiles={return @($active)}.GetNewClosure()
        $code=$null;try{Call-Enroll $f -Install|Out-Null}catch{$code=$_.Exception.Message}
        Assert-EnrollTest ($code -ceq 'ENROLL_RUNNING')
        Assert-EnrollTest ([IO.File]::Exists((Join-Path $f.Options.InstallRoot 'legacy-sentinel')))
    }
    Check-EnrollTest 'failure writing the second shim restores the complete old installation and shim pair' {
        Require-EnrollApi
        $f=New-EnrollFixture;Prepare-OwnedPrototype $f
        $one=Join-Path $f.Options.ShimRoot 'codexs.cmd';$two=Join-Path $f.Options.ShimRoot 'codexs-statusline.cmd'
        $oldOne=[IO.File]::ReadAllBytes($one);$oldTwo=[IO.File]::ReadAllBytes($two)
        $writer=$f.Ops.WriteShim;$counter=@{n=0;failedAt=0}
        $f.Ops.WriteShim={param($Path,[byte[]]$Bytes) $counter.n++;if($counter.n -eq 2){$counter.failedAt=$counter.n;throw 'SYNTHETIC_SHIM_FAILURE'};& $writer $Path $Bytes}.GetNewClosure()
        $failed=$false;$failureCode=$null;try{Call-Enroll $f -Install|Out-Null}catch{$failed=$true;$failureCode=$_.Exception.Message}
        Assert-EnrollTest $failed
        Assert-EnrollTest ($counter.failedAt -eq 2 -and $failureCode -ceq 'SYNTHETIC_SHIM_FAILURE') ('injected second-shim failure must actually be reached: writes='+$counter.n+' code='+$failureCode)
        Assert-EnrollTest ([IO.File]::ReadAllText((Join-Path $f.Options.InstallRoot 'legacy-sentinel')) -ceq 'synthetic old installation')
        Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($one)) -ceq [Convert]::ToBase64String($oldOne))
        Assert-EnrollTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($two)) -ceq [Convert]::ToBase64String($oldTwo))
    }
} finally {
    foreach($child in $script:enrollmentChildren){try{if(-not $child.HasExited){$child.Kill();[void]$child.WaitForExit(5000)}}finally{$child.Dispose()}}
    foreach($root in $script:fixtureRoots){
        $full=[IO.Path]::GetFullPath($root);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if((Split-Path -Parent $full) -ine $parent -or (Split-Path -Leaf $full) -notlike 'codexs-launch-test-*'){throw 'Unsafe signed fixture cleanup'}
        if([IO.Directory]::Exists($full)){
            foreach($name in @('auth.json','history.jsonl')){if([IO.File]::ReadAllText((Join-Path $full ('synthetic-'+$name))) -cne ('synthetic untouched '+$name)){$script:failures.Add('synthetic auth/history sentinel changed')}}
            Remove-Item -LiteralPath $full -Recurse -Force
        }
    }
    $full=[IO.Path]::GetFullPath($testRoot);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if((Split-Path -Parent $full) -ine $parent -or (Split-Path -Leaf $full) -notlike 'codexs-enroll-test-*'){throw 'Unsafe enrollment suite cleanup'}
    Remove-Item -LiteralPath $full -Recurse -Force
}
Write-Output ('Enrollment assertions: '+$script:passed+' passed; '+$script:failures.Count+' failed')
if($script:failures.Count){throw ($script:failures -join [Environment]::NewLine)}
$global:LASTEXITCODE=0
