# Module entry: load into a trusted coordinator host. Operation/validation ports
# are supplied by that host; no standalone request can directly commit state.
function Assert-CodexsCoordinatorPath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrEmpty($Root) -or $Root -notmatch '^[A-Za-z]:[\\/]' -or
        [string]::IsNullOrEmpty($Relative) -or $Relative -match '[\\/:\x00]' -or $Relative -in @('.','..')) { throw 'COORDINATOR_PATH' }
    $base=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    if($base.Length -le 3){throw 'COORDINATOR_PATH'}
    $path=Join-Path $base $Relative
    $cursor=$path
    while($cursor){
        if(Test-Path -LiteralPath $cursor){
            if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'COORDINATOR_PATH'}
        }
        $parent=Split-Path -Parent $cursor
        if($parent -eq $cursor){break}
        $cursor=$parent
    }
    return $path
}

function Test-CodexsStateBytes([byte[]]$Bytes, [scriptblock]$ValidateState) {
    if($null -eq $Bytes -or $Bytes.Length -eq 0 -or $Bytes.Length -gt 4194304 -or $null -eq $ValidateState){return $false}
    try {
        $valid=& $ValidateState $Bytes
        return ($valid -is [bool] -and $valid)
    } catch {return $false}
}

function Write-CodexsCoordinatorState($Context, [byte[]]$Bytes, [scriptblock]$ValidateState, [scriptblock]$Checkpoint) {
    if($null -eq $Context -or $null -eq $Context.Lock -or -not $Context.Lock.CanWrite){throw 'COORDINATOR_LOCK'}
    $current=Assert-CodexsCoordinatorPath $Context.Root 'current.json'
    $backup=Assert-CodexsCoordinatorPath $Context.Root 'current.previous.json'
    $lock=Assert-CodexsCoordinatorPath $Context.Root 'update.lock'
    if($Context.Lock.Name -ine $lock){throw 'COORDINATOR_LOCK'}
    if(-not (Test-CodexsStateBytes $Bytes $ValidateState)){throw 'COORDINATOR_STATE'}
    $temp=Assert-CodexsCoordinatorPath $Context.Root ('current.tmp-'+[guid]::NewGuid().ToString('N'))
    $stream=$null
    try {
        $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $stream.Write($Bytes,0,$Bytes.Length)
        if($Checkpoint){& $Checkpoint 'written' | Out-Null}
        $stream.Flush($true)
        if($Checkpoint){& $Checkpoint 'flushed' | Out-Null}
    } finally {if($stream){$stream.Dispose()}}
    if(Test-Path -LiteralPath $current){
        # Never replace the last valid backup with a corrupt primary during recovery.
        $primaryValid=$false
        if(([IO.FileInfo]$current).Length -le 4194304){$primaryValid=Test-CodexsStateBytes ([IO.File]::ReadAllBytes($current)) $ValidateState}
        if($primaryValid){
            [IO.File]::Replace($temp,$current,$backup,$true)
        } else {
            $preserved=Assert-CodexsCoordinatorPath $Context.Root ('current.corrupt-'+[guid]::NewGuid().ToString('N'))
            [IO.File]::Move($current,$preserved)
            [IO.File]::Move($temp,$current)
        }
    } else {[IO.File]::Move($temp,$current)}
    $Context.StateChanged=$true
    if($Checkpoint){& $Checkpoint 'replaced' | Out-Null}
}

function Invoke-CodexsCoordinator($Request, [scriptblock]$Operation, [scriptblock]$ValidateState, [scriptblock]$Checkpoint) {
    $keys=@($Request.Keys | Sort-Object)
    if($null -eq $Request -or $Request -isnot [Collections.IDictionary] -or
        ($keys -join ',') -cne 'mode,root' -or $Request.mode -isnot [string] -or
        $Request.mode -cnotin @('check','promote','rollback') -or $Request.root -isnot [string] -or $null -eq $Operation){throw 'COORDINATOR_REQUEST'}
    try {$lockPath=Assert-CodexsCoordinatorPath $Request.root 'update.lock'}
    catch {throw 'COORDINATOR_PATH'}
    $root=Split-Path -Parent $lockPath
    if(-not [IO.Directory]::Exists($root)){throw 'COORDINATOR_PATH'}
    $lock=$null
    try {
        try {$lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
        catch [IO.IOException] {
            $native=$_.Exception.HResult -band 65535
            if($native -eq 32 -or $native -eq 33){return @{code='BUSY';stateChanged=$false}}
            throw 'COORDINATOR_IO'
        }
        # This host-only capability lets the worker commit progress before a
        # download or smoke operation. It never reacquires or releases the lock.
        $context=@{Root=$root;Lock=$lock;StateChanged=$false}
        $result=& $Operation @{mode=$Request.mode;root=$root} $context
        if($result -isnot [Collections.IDictionary] -or $result.code -isnot [string] -or $result.code -cnotmatch '^[A-Z][A-Z0-9_]{0,63}$' -or
            @($result.Keys | Where-Object {$_ -cnotin @('code','nextState')}).Count){throw 'COORDINATOR_RESULT'}
        if($result.Contains('nextState')){
            if($result.nextState -isnot [byte[]]){throw 'COORDINATOR_STATE'}
            Write-CodexsCoordinatorState -Context $context -Bytes $result.nextState -ValidateState $ValidateState -Checkpoint $Checkpoint
        }
        return @{code=$result.code;stateChanged=$context.StateChanged}
    } catch {
        if($_.Exception.Message -cmatch '^COORDINATOR_[A-Z_]+$'){throw $_.Exception.Message}
        throw 'COORDINATOR_FAILED'
    } finally {if($lock){$lock.Dispose()}}
}
