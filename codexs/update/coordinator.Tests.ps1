param([string]$CoordinatorScript = (Join-Path (Get-Location) 'codexs/update/coordinator.ps1'), [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source)
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codexs-coordinator-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$script:passed = 0
$script:failures = [Collections.Generic.List[string]]::new()
$script:ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$stateModule = Join-Path (Split-Path -Parent $CoordinatorScript) 'state.cjs'
$protocolModule = Join-Path (Split-Path -Parent $CoordinatorScript) 'protocol.cjs'
$validate = {
    param([byte[]]$Bytes)
    $raw = [Convert]::ToBase64String($Bytes)
    & $NodePath -e 'try{require(process.argv[1]).parseState(Buffer.from(process.argv[2],''base64''))}catch{process.exit(1)}' $protocolModule $raw | Out-Null
    return ($LASTEXITCODE -eq 0)
}
function Assert-CoordinatorTest([bool]$Condition) { if (-not $Condition) { throw 'Synthetic coordinator assertion failed' } }
function Check-CoordinatorTest([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Output ('PASS ' + $Name) }
    catch { $script:failures.Add($Name + ': ' + $_.Exception.Message); Write-Output ('FAIL ' + $Name + ': ' + $_.Exception.Message) }
}
function New-CoordinatorRoot {
    $root = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($root)
    return $root
}
function State-Bytes([int]$Sequence) {
    $hash = ([string]$Sequence) * 64
    $state = @{schema=1;current=@{release_id=('codexs-v1.0.0-codex0.166.0-r'+$Sequence);sequence=$Sequence;manifest_sha256=$hash};previous=$null;ready=$null;highest=@{sequence=$Sequence;manifest_sha256=$hash};rejected=@();last_check_ms=0;next_check_ms=0;failures=0}
    return [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $state -Depth 8 -Compress))
}
function Commit-Fixture([string]$Root, [byte[]]$Bytes, [scriptblock]$Checkpoint) {
    Invoke-CodexsCoordinator -Request @{mode='check';root=$Root} -ValidateState $validate -Checkpoint $Checkpoint -Operation { param($Request) return @{code='OK';nextState=$Bytes} }
}
function Start-OwnedCoordinator([string]$Root, [bool]$Hold) {
    $script = @'
$ErrorActionPreference='Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_TEST_MODULE)))
$root=$env:CODEXS_TEST_ROOT
$result=Invoke-CodexsCoordinator -Request @{mode='check';root=$root} -Operation {
  param($Request)
  [IO.File]::WriteAllText((Join-Path $Request.root 'acquired'), 'synthetic')
  if($env:CODEXS_TEST_HOLD -eq '1'){
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    while(-not (Test-Path -LiteralPath (Join-Path $Request.root 'release'))){
      if([DateTime]::UtcNow -gt $deadline){throw 'TEST_HOLDER_DEADLINE'}
      Start-Sleep -Milliseconds 20
    }
  }
  return @{code='OK'}
}
ConvertTo-Json $result -Compress
'@
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.EnvironmentVariables['CODEXS_TEST_MODULE'] = $CoordinatorScript
    $info.EnvironmentVariables['CODEXS_TEST_ROOT'] = $Root
    $info.EnvironmentVariables['CODEXS_TEST_HOLD'] = $(if($Hold){'1'}else{'0'})
    $process = [Diagnostics.Process]::Start($info)
    $script:ownedProcesses.Add($process)
    return $process
}
function Finish-OwnedCoordinator($Process) {
    Assert-CoordinatorTest ($Process.WaitForExit(10000))
    $output = $Process.StandardOutput.ReadToEnd()
    $errorText = $Process.StandardError.ReadToEnd()
    if($Process.ExitCode -ne 0){throw ('Owned worker failed: '+$errorText)}
    return (ConvertFrom-Json $output)
}


function New-WorkerCase([string]$Body) {
    $root=New-CoordinatorRoot
    $release='codexs-v1.0.0-codex0.166.0-r1'
    $bootstrap=Join-Path $root 'bootstrap'
    $update=Join-Path $root ('versions/'+$release+'/update')
    [void][IO.Directory]::CreateDirectory($bootstrap)
    [void][IO.Directory]::CreateDirectory($update)
    $entry=@'
const path=require('node:path');const request=JSON.parse(Buffer.from(process.argv[3],'base64'));process.stdin.once('data',()=>{require(path.join(__dirname,'..','versions',request.releaseRef.release_id,'update','launch.cjs'));});process.stdin.resume();
'@
    [IO.File]::WriteAllText((Join-Path $bootstrap 'bootstrap.cjs'),$entry,[Text.UTF8Encoding]::new($false))
    $worker=Join-Path $update 'launch.cjs'
    [IO.File]::WriteAllText($worker,$Body,[Text.UTF8Encoding]::new($false))
    $syntax=& $NodePath --check $worker 2>&1
    if($LASTEXITCODE -ne 0){throw ('Synthetic worker source does not parse: '+($syntax -join ' '))}
    [IO.File]::WriteAllBytes((Join-Path $root 'current.json'),(State-Bytes 1))
    $ref=(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString((State-Bytes 1)))).current
    return @{root=$root;worker=$worker;ref=$ref}
}
function Run-WorkerCase($Case) {
    return (Invoke-CodexsCoordinator -Request @{mode='check';root=$Case.root} -ValidateState $validate -Operation {
        param($Request,$Context)
        Invoke-CodexsWorkerHost -Context $Context -NodePath $NodePath -WorkerPath $Case.worker -Request @{mode=$Request.mode;root=$Request.root;releaseRef=$Case.ref}
    })
}
function Start-OwnedWorkerHost($Case) {
    $body=@'
$ErrorActionPreference='Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:CODEXS_TEST_MODULE)))
$ref=ConvertFrom-Json $env:CODEXS_TEST_REF
Invoke-CodexsCoordinator -Request @{mode='check';root=$env:CODEXS_TEST_ROOT} -ValidateState {param($Bytes) return $true} -Operation {
    param($Request,$Context)
    Invoke-CodexsWorkerHost -Context $Context -NodePath $env:CODEXS_TEST_NODE -WorkerPath $env:CODEXS_TEST_WORKER -Request @{mode=$Request.mode;root=$Request.root;releaseRef=$ref}
} | Out-Null
'@
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.EnvironmentVariables['CODEXS_TEST_MODULE']=$CoordinatorScript
    $info.EnvironmentVariables['CODEXS_TEST_ROOT']=$Case.root
    $info.EnvironmentVariables['CODEXS_TEST_NODE']=$NodePath
    $info.EnvironmentVariables['CODEXS_TEST_WORKER']=$Case.worker
    $info.EnvironmentVariables['CODEXS_TEST_REF']=ConvertTo-Json $Case.ref -Compress
    $process=[Diagnostics.Process]::Start($info)
    $script:ownedProcesses.Add($process)
    return $process
}

try {
    Check-CoordinatorTest 'actual exclusive handle returns busy without touching an active lock' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot
        $holder=Start-OwnedCoordinator $root $true
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        while(-not (Test-Path -LiteralPath (Join-Path $root 'acquired'))){
            if($holder.HasExited){throw $holder.StandardError.ReadToEnd()}
            if([DateTime]::UtcNow -gt $deadline){throw 'Owned holder readiness timeout'}
            Start-Sleep -Milliseconds 20
        }
        $lock=Join-Path $root 'update.lock'
        $contender=Start-OwnedCoordinator $root $false
        $result=Finish-OwnedCoordinator $contender
        Assert-CoordinatorTest ($result.code -ceq 'BUSY' -and -not $result.stateChanged)
        Assert-CoordinatorTest (Test-Path -LiteralPath $lock)
        $holder.Kill(); Assert-CoordinatorTest ($holder.WaitForExit(5000))
        Remove-Item -LiteralPath (Join-Path $root 'acquired')
        $after=Finish-OwnedCoordinator (Start-OwnedCoordinator $root $false)
        Assert-CoordinatorTest ($after.code -ceq 'OK')
        Assert-CoordinatorTest (Test-Path -LiteralPath (Join-Path $root 'acquired'))
    }
    Check-CoordinatorTest 'initial move and replacement retain one complete predecessor and settings bytes' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot; $settings=Join-Path $root 'settings-sentinel'
        [IO.File]::WriteAllText($settings,'synthetic unknown settings')
        $first=Commit-Fixture $root (State-Bytes 1)
        Assert-CoordinatorTest ($first.stateChanged)
        $second=Commit-Fixture $root (State-Bytes 2)
        Assert-CoordinatorTest ($second.stateChanged)
        Assert-CoordinatorTest ((ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $root 'current.json')))).current.sequence -eq 2)
        Assert-CoordinatorTest ((ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $root 'current.previous.json')))).current.sequence -eq 1)
        Assert-CoordinatorTest ([IO.File]::ReadAllText($settings) -ceq 'synthetic unknown settings')
    }
    Check-CoordinatorTest 'write flush and replacement crash boundaries recover a complete old or new state' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        foreach($boundary in @('written','flushed','replaced')){
            $root=New-CoordinatorRoot
            Commit-Fixture $root (State-Bytes 1) | Out-Null
            $failed=$false
            try { Commit-Fixture $root (State-Bytes 2) {param($Phase) if($Phase -ceq $boundary){throw 'Synthetic interrupted commit'}} | Out-Null } catch {$failed=$true}
            Assert-CoordinatorTest $failed
            $json=& $NodePath -e 'require(process.argv[1]).readInstallation(process.argv[2]).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exit(1))' $stateModule $root
            Assert-CoordinatorTest ($LASTEXITCODE -eq 0)
            $read=ConvertFrom-Json ($json -join "`n")
            $expected=1; if($boundary -ceq 'replaced'){$expected=2}
            Assert-CoordinatorTest ($read.state.current.sequence -eq $expected)
            Assert-CoordinatorTest ($read.state.highest.sequence -eq $expected)
        }
    }
    Check-CoordinatorTest 'repairing a corrupt primary does not overwrite the validated backup with corruption' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot
        [IO.File]::WriteAllBytes((Join-Path $root 'current.previous.json'),(State-Bytes 1))
        [IO.File]::WriteAllText((Join-Path $root 'current.json'),'corrupt synthetic primary')
        Commit-Fixture $root (State-Bytes 2) | Out-Null
        Assert-CoordinatorTest ((ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $root 'current.previous.json')))).current.sequence -eq 1)
        Assert-CoordinatorTest ((ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $root 'current.json')))).current.sequence -eq 2)
    }
    Check-CoordinatorTest 'invalid state and external internal-commit requests cannot create current state' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot
        foreach($invoke in @(
            {Commit-Fixture $root ([Text.Encoding]::UTF8.GetBytes('{"schema":99}'))},
            {Invoke-CodexsCoordinator -Request @{mode='commit-state';root=$root;bytes='untrusted'} -Operation {throw 'must not run'}},
            {Invoke-CodexsCoordinator -Request @{mode='check';root=$root;extra='untrusted'} -Operation {throw 'must not run'}}
        )){
            $failed=$false;try{& $invoke | Out-Null}catch{$failed=$true;Assert-CoordinatorTest ($_.Exception.Message -match '^COORDINATOR_[A-Z_]+$')}
            Assert-CoordinatorTest $failed
            Assert-CoordinatorTest (-not (Test-Path -LiteralPath (Join-Path $root 'current.json')))
        }
    }
    Check-CoordinatorTest 'junction state and lock paths cannot modify an outside sentinel' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot; $outside=New-CoordinatorRoot
        [IO.File]::WriteAllText((Join-Path $outside 'sentinel'),'outside synthetic sentinel')
        $link=Join-Path $root 'redirect'
        $null=New-Item -ItemType Junction -Path $link -Target $outside
        try {
            $failed=$false;try{Commit-Fixture $link (State-Bytes 1)|Out-Null}catch{$failed=$true}
            Assert-CoordinatorTest $failed
            Assert-CoordinatorTest (-not (Test-Path -LiteralPath (Join-Path $outside 'current.json')))
            Assert-CoordinatorTest ([IO.File]::ReadAllText((Join-Path $outside 'sentinel')) -ceq 'outside synthetic sentinel')
        } finally {[IO.Directory]::Delete($link)}
    }
    Check-CoordinatorTest 'stale lock contents never grant ownership or require deletion' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot; $lock=Join-Path $root 'update.lock'
        [IO.File]::WriteAllText($lock,'synthetic stale PID 999999')
        $result=Invoke-CodexsCoordinator -Request @{mode='promote';root=$root} -Operation {param($Request) return @{code='OK'}}
        Assert-CoordinatorTest ($result.code -ceq 'OK')
        Assert-CoordinatorTest ([IO.File]::ReadAllText($lock) -ceq 'synthetic stale PID 999999')
    }
    Check-CoordinatorTest 'malformed roots return bounded codes before reaching the worker' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $invalid='C:\synthetic-'+[char]0+'-invalid'
        $failed=$false
        try {Invoke-CodexsCoordinator -Request @{mode='check';root=$invalid} -Operation {throw 'Worker must not run'} | Out-Null}
        catch {$failed=$true;Assert-CoordinatorTest ($_.Exception.Message -cmatch '^COORDINATOR_[A-Z_]+$')}
        Assert-CoordinatorTest $failed
    }
    Check-CoordinatorTest 'worker can durably record highest before later work fails under the same lock' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $root=New-CoordinatorRoot
        Commit-Fixture $root (State-Bytes 1) | Out-Null
        $state=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString((State-Bytes 1)))
        $state.highest.sequence=2; $state.highest.manifest_sha256='2'*64
        $observed=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $state -Depth 8 -Compress))
        $failed=$false
        try {
            Invoke-CodexsCoordinator -Request @{mode='check';root=$root} -Operation {
                param($Request,$Context)
                Write-CodexsCoordinatorState -Context $Context -Bytes $observed -ValidateState $validate
                throw 'Synthetic interrupted download'
            } | Out-Null
        } catch {$failed=$true}
        Assert-CoordinatorTest $failed
        $actual=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $root 'current.json')))
        Assert-CoordinatorTest ($actual.current.sequence -eq 1 -and $actual.highest.sequence -eq 2)
        $after=Invoke-CodexsCoordinator -Request @{mode='check';root=$root} -Operation {param($Request) return @{code='OK'}}
        Assert-CoordinatorTest ($after.code -ceq 'OK')
    }

    Check-CoordinatorTest 'worker acknowledges only durably committed checkpoints under the existing lock' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        Assert-CoordinatorTest ($null -ne (Get-Command Invoke-CodexsWorkerHost -ErrorAction SilentlyContinue))
        $first=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString((State-Bytes 1)))
        $first.highest.sequence=2;$first.highest.manifest_sha256=('2'*64);$first.failures=1
        $first64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $first -Depth 8 -Compress)))
        $second64=[Convert]::ToBase64String((State-Bytes 2))
        $body=@'
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');const root=path.resolve(__dirname,'..','..','..');const peer=readline.createInterface({input:process.stdin});function send(x){process.stdout.write(JSON.stringify(x)+String.fromCharCode(10))}peer.on('line',line=>{const ack=JSON.parse(line);if(ack.type!=='ack'||ack.code!=='OK')process.exit(91);if(ack.id===1){const state=JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8'));if(state.current.sequence!==1||state.highest.sequence!==2||state.failures!==1)process.exit(92);send({type:'commit',id:2,state:'SECOND_STATE'});}else if(ack.id===2){send({type:'result',code:'READY',stateChanged:true});peer.close();process.stdin.pause();}else process.exit(93);});send({type:'commit',id:1,state:'FIRST_STATE'});
'@
        $case=New-WorkerCase ($body.Replace('FIRST_STATE',$first64).Replace('SECOND_STATE',$second64))
        $result=Run-WorkerCase $case
        Assert-CoordinatorTest ($result.code -ceq 'READY' -and $result.stateChanged)
        $state=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $case.root 'current.json')))
        Assert-CoordinatorTest ($state.current.sequence -eq 2)
        $backup=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $case.root 'current.previous.json')))
        Assert-CoordinatorTest ($backup.current.sequence -eq 1 -and $backup.highest.sequence -eq 2 -and $backup.failures -eq 1)
    }
    Check-CoordinatorTest 'malformed oversized or early-EOF worker frames cannot commit state' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        Assert-CoordinatorTest ($null -ne (Get-Command Invoke-CodexsWorkerHost -ErrorAction SilentlyContinue))
        $sources=@(
            'process.stdout.write(''{"type":"commit","id":2,"state":"VALID_STATE"}''+String.fromCharCode(10));',
            'process.stdout.write(''{"type":"result","code":"OK","stateChanged":false,"extra":true}''+String.fromCharCode(10));',
            'process.stdout.write(''{"type":"commit","id":1,"id":1,"state":"VALID_STATE"}''+String.fromCharCode(10));',
            'process.stdout.write(''x''.repeat(6291457));setInterval(()=>{},1000);',
            'process.stderr.write(''x''.repeat(8192));setInterval(()=>{},1000);',
            'process.exit(77);'
        )
        $validState=[Convert]::ToBase64String((State-Bytes 2))
        foreach($body in $sources) {
            $case=New-WorkerCase ($body.Replace('VALID_STATE',$validState))
            $before=[IO.File]::ReadAllBytes((Join-Path $case.root 'current.json'))
            $failed=$false
            try { Run-WorkerCase $case | Out-Null } catch {$failed=$true;Assert-CoordinatorTest ($_.Exception.Message -cmatch '^COORDINATOR_[A-Z_]+$')}
            Assert-CoordinatorTest $failed
            Assert-CoordinatorTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $case.root 'current.json'))) -ceq [Convert]::ToBase64String($before))
        }
    }
    Check-CoordinatorTest 'worker without the owned exclusive handle cannot start or write state' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        Assert-CoordinatorTest ($null -ne (Get-Command Invoke-CodexsWorkerHost -ErrorAction SilentlyContinue))
        $case=New-WorkerCase 'process.stdout.write(''{"type":"result","code":"OK","stateChanged":false}''+String.fromCharCode(10));'
        $failed=$false
        try {Invoke-CodexsWorkerHost -Context @{Root=$case.root;Lock=$null;StateChanged=$false} -NodePath $NodePath -WorkerPath $case.worker -Request @{mode='check';root=$case.root;releaseRef=$case.ref} | Out-Null}
        catch {$failed=$true;Assert-CoordinatorTest ($_.Exception.Message -ceq 'COORDINATOR_LOCK')}
        Assert-CoordinatorTest $failed
    }
    Check-CoordinatorTest 'a crashed worker preserves its acknowledged attempt and releases the lock' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        Assert-CoordinatorTest ($null -ne (Get-Command Invoke-CodexsWorkerHost -ErrorAction SilentlyContinue))
        $state=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString((State-Bytes 1)));$state.failures=1
        $state64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $state -Depth 8 -Compress)))
        $body=@'
const readline=require('node:readline');const peer=readline.createInterface({input:process.stdin});peer.once('line',line=>{if(JSON.parse(line).code!=='OK')process.exit(91);process.exit(77)});process.stdout.write(JSON.stringify({type:'commit',id:1,state:'STATE_BYTES'})+String.fromCharCode(10));
'@
        $case=New-WorkerCase ($body.Replace('STATE_BYTES',$state64))
        $failed=$false;try {Run-WorkerCase $case | Out-Null}catch{$failed=$true}
        Assert-CoordinatorTest $failed
        $actual=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $case.root 'current.json')))
        Assert-CoordinatorTest ($actual.current.sequence -eq 1 -and $actual.failures -eq 1)
        $after=Invoke-CodexsCoordinator -Request @{mode='check';root=$case.root} -Operation {param($Request) @{code='OK'}}
        Assert-CoordinatorTest ($after.code -ceq 'OK')
    }
    Check-CoordinatorTest 'host death closes the owned worker job and leaves no stale lock owner' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        Assert-CoordinatorTest ($null -ne (Get-Command Invoke-CodexsWorkerHost -ErrorAction SilentlyContinue))
        $body='const fs=require(''node:fs''),path=require(''node:path'');fs.writeFileSync(path.resolve(__dirname,''..'',''..'',''..'',''worker-pid''),String(process.pid));setInterval(()=>{},1000);'
        $case=New-WorkerCase $body
        $holder=Start-OwnedWorkerHost $case
        $pidFile=Join-Path $case.root 'worker-pid';$deadline=[DateTime]::UtcNow.AddSeconds(10)
        while(-not [IO.File]::Exists($pidFile)) {
            if($holder.HasExited){throw ('Owned host exited: '+$holder.StandardError.ReadToEnd())}
            if([DateTime]::UtcNow -gt $deadline){throw 'Owned worker readiness timeout'}
            Start-Sleep -Milliseconds 20
        }
        $workerProcess=[Diagnostics.Process]::GetProcessById([int]([IO.File]::ReadAllText($pidFile)))
        $null=$workerProcess.StartTime.Ticks
        $script:ownedProcesses.Add($workerProcess)
        $busy=Run-WorkerCase $case
        Assert-CoordinatorTest ($busy.code -ceq 'BUSY' -and -not $busy.stateChanged)
        $holder.Kill();Assert-CoordinatorTest ($holder.WaitForExit(5000))
        Assert-CoordinatorTest ($workerProcess.WaitForExit(5000))
        $after=Invoke-CodexsCoordinator -Request @{mode='check';root=$case.root} -Operation {param($Request) @{code='OK'}}
        Assert-CoordinatorTest ($after.code -ceq 'OK')
    }
    Check-CoordinatorTest 'only the lock-owning worker records bounded last-check diagnostics and BUSY preserves them' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        $case=New-WorkerCase 'process.stdout.write(''{"type":"result","code":"NETWORK","stateChanged":false}''+String.fromCharCode(10));'
        $before=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $result=Run-WorkerCase $case
        Assert-CoordinatorTest ($result.code -ceq 'NETWORK')
        $file=Join-Path $case.root 'update-status.json'
        Assert-CoordinatorTest ([IO.File]::Exists($file))
        $text=[IO.File]::ReadAllText($file);$status=ConvertFrom-Json $text
        Assert-CoordinatorTest (($status.PSObject.Properties.Name|Sort-Object) -join ',' -ceq 'checked_at_ms,code,duration_ms,schema')
        Assert-CoordinatorTest ($status.schema -eq 1 -and $status.code -ceq 'NETWORK' -and $status.checked_at_ms -ge $before -and $status.duration_ms -ge 0)
        Assert-CoordinatorTest (-not $text.Contains($case.root))
        $held=[IO.File]::Open((Join-Path $case.root 'update.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{$busy=Run-WorkerCase $case;Assert-CoordinatorTest ($busy.code -ceq 'BUSY')}finally{$held.Dispose()}
        Assert-CoordinatorTest ([IO.File]::ReadAllText($file) -ceq $text)
    }
    Check-CoordinatorTest 'stderr limit counts raw UTF8 bytes rather than decoded characters' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        foreach($count in @(1024,1025)){
            $body='process.stderr.write(String.fromCodePoint(128578).repeat('+$count+'));process.stdout.write(''{"type":"result","code":"OK","stateChanged":false}''+String.fromCharCode(10));'
            $case=New-WorkerCase $body
            $code=$null;try{$value=Run-WorkerCase $case;$code=$value.code}catch{$code=$_.Exception.Message}
            $expected=if($count -eq 1024){'OK'}else{'COORDINATOR_OUTPUT'}
            if($code -cne $expected){throw ('bytes='+($count*4)+' expected='+$expected+' actual='+$code)}
        }
    }
    Check-CoordinatorTest 'a throttled worker preserves the last actual check reason and timing' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        foreach($reason in @('NETWORK','RATE_LIMIT')){
            $body='process.stdout.write(''{"type":"result","code":"'+$reason+'","stateChanged":false}''+String.fromCharCode(10));'
            $case=New-WorkerCase $body
            $result=Run-WorkerCase $case;Assert-CoordinatorTest ($result.code -ceq $reason)
            $file=Join-Path $case.root 'update-status.json'
            $before=[IO.File]::ReadAllBytes($file)
            $next='process.stdout.write(''{"type":"result","code":"THROTTLED","stateChanged":false}''+String.fromCharCode(10));'
            [IO.File]::WriteAllText($case.worker,$next,[Text.UTF8Encoding]::new($false))
            & $NodePath --check $case.worker|Out-Null
            Assert-CoordinatorTest ($LASTEXITCODE -eq 0)
            $result=Run-WorkerCase $case;Assert-CoordinatorTest ($result.code -ceq 'THROTTLED')
            Assert-CoordinatorTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -ceq [Convert]::ToBase64String($before))
            Assert-CoordinatorTest ((ConvertFrom-Json ([IO.File]::ReadAllText($file))).code -ceq $reason)
        }
    }
    Check-CoordinatorTest 'worker budgets retain the approved foreground and background bounds' {
        . ([scriptblock]::Create([IO.File]::ReadAllText($CoordinatorScript)))
        Assert-CoordinatorTest ((Get-CodexsWorkerBudget 'check') -eq 900000)
        Assert-CoordinatorTest ((Get-CodexsWorkerBudget 'promote') -eq 60000)
        Assert-CoordinatorTest ((Get-CodexsWorkerBudget 'rollback') -eq 60000)
        $failed=$false;try{Get-CodexsWorkerBudget 'unknown'|Out-Null}catch{$failed=($_.Exception.Message -ceq 'COORDINATOR_REQUEST')}
        Assert-CoordinatorTest $failed
    }
} finally {
    foreach($process in $script:ownedProcesses){try{if(-not $process.HasExited){$process.Kill();[void]$process.WaitForExit(5000)}}finally{$process.Dispose()}}
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if((Split-Path -Parent $resolved) -ine $parent -or (Split-Path -Leaf $resolved) -notlike 'codexs-coordinator-test-*'){throw 'Unsafe coordinator test cleanup'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ('Coordinator assertions: '+$script:passed+' passed; '+$script:failures.Count+' failed')
if($script:failures.Count){throw ($script:failures -join "`n")}
