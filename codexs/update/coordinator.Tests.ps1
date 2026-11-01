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
} finally {
    foreach($process in $script:ownedProcesses){try{if(-not $process.HasExited){$process.Kill();[void]$process.WaitForExit(5000)}}finally{$process.Dispose()}}
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if((Split-Path -Parent $resolved) -ine $parent -or (Split-Path -Leaf $resolved) -notlike 'codexs-coordinator-test-*'){throw 'Unsafe coordinator test cleanup'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ('Coordinator assertions: '+$script:passed+' passed; '+$script:failures.Count+' failed')
if($script:failures.Count){throw ($script:failures -join "`n")}
