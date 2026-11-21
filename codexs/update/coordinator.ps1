function Get-CodexsWorkerBudget([string]$Mode) {
    if($Mode -ceq 'check'){return [long]900000}
    if($Mode -cin @('promote','rollback')){return [long]60000}
    throw 'COORDINATOR_REQUEST'
}

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
        $context=@{Root=$root;Lock=$lock;StateChanged=$false;ValidateState=$ValidateState;Checkpoint=$Checkpoint}
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


function Write-CodexsWorkerDiagnostic($Context,[string]$Code,[long]$DurationMs) {
    if($null -eq $Context -or $null -eq $Context.Lock -or -not $Context.Lock.CanWrite -or
       $Code -cnotmatch '^[A-Z][A-Z0-9_]{0,63}$' -or $DurationMs -lt 0){throw 'COORDINATOR_LOCK'}
    $lock=Assert-CodexsCoordinatorPath $Context.Root 'update.lock'
    if($Context.Lock.Name -ine $lock){throw 'COORDINATOR_LOCK'}
    $file=Assert-CodexsCoordinatorPath $Context.Root 'update-status.json'
    $temporary=Assert-CodexsCoordinatorPath $Context.Root ('status.tmp-'+[guid]::NewGuid().ToString('N'))
    $record=@{schema=1;code=$Code;checked_at_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();duration_ms=$DurationMs}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json $record -Compress))
    try{
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        if([IO.File]::Exists($file)){[IO.File]::Replace($temporary,$file,[System.Management.Automation.Language.NullString]::Value,$true)}
        else{[IO.File]::Move($temporary,$file)}
    }finally{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}

function New-CodexsWorkerJob {
    if(-not ('CodexsUpdateWorkerJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class CodexsUpdateWorkerJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorkingSet,MaxWorkingSet; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)]
    struct Counters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct Extended { public Basic Limits; public Counters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr info,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    readonly SafeFileHandle handle;
    public CodexsUpdateWorkerJob() {
        handle=new SafeFileHandle(CreateJobObject(IntPtr.Zero,null),true);
        if(handle.IsInvalid) throw new InvalidOperationException("COORDINATOR_JOB");
        var info=new Extended();info.Limits.Flags=0x2000;
        int size=Marshal.SizeOf(typeof(Extended));IntPtr memory=Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(info,memory,false);
            if(!SetInformationJobObject(handle.DangerousGetHandle(),9,memory,(uint)size)) {handle.Dispose();throw new InvalidOperationException("COORDINATOR_JOB");}
        } finally {Marshal.FreeHGlobal(memory);}
    }
    public void Assign(IntPtr process) {
        if(!AssignProcessToJobObject(handle.DangerousGetHandle(),process)) throw new InvalidOperationException("COORDINATOR_JOB");
    }
    public void Dispose() {handle.Dispose();}
}
'@ -ErrorAction Stop
    }
    return [CodexsUpdateWorkerJob]::new()
}

function Invoke-CodexsWorkerHost($Context, [string]$NodePath, [string]$WorkerPath, $Request) {
    if($null -eq $Context -or $null -eq $Context.Lock -or -not $Context.Lock.CanWrite){throw 'COORDINATOR_LOCK'}
    $lock=Assert-CodexsCoordinatorPath $Context.Root 'update.lock'
    if($Context.Lock.Name -ine $lock -or $null -eq $Context.ValidateState){throw 'COORDINATOR_LOCK'}
    if($Request -isnot [Collections.IDictionary] -or
       ((@($Request.Keys|Sort-Object) -join ',') -cnotin @('mode,releaseRef,root','expectedCurrent,mode,releaseRef,root') -or ($Request.Contains('expectedCurrent') -and $Request.mode -cne 'rollback')) -or
       $Request.mode -cnotin @('check','promote','rollback') -or
       $Request.root -isnot [string] -or [IO.Path]::GetFullPath($Request.root).TrimEnd('') -ine $Context.Root){throw 'COORDINATOR_REQUEST'}
    $ref=$Request.releaseRef
    $refKeys=if($ref -is [Collections.IDictionary]){@($ref.Keys)}elseif($ref -is [pscustomobject]){@($ref.PSObject.Properties.Name)}else{@()}
    if((@($refKeys|Sort-Object) -join ',') -cne 'manifest_sha256,release_id,sequence' -or
       $ref.release_id -isnot [string] -or $ref.release_id -cnotmatch '^codexs-v[0-9.]+-codex[0-9.]+-r[1-9][0-9]*$' -or
       $ref.manifest_sha256 -isnot [string] -or $ref.manifest_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
       ($ref.sequence -isnot [int] -and $ref.sequence -isnot [long]) -or $ref.sequence -lt 1 -or $ref.sequence -gt 9007199254740991){throw 'COORDINATOR_REQUEST'}
    $versions=Assert-CodexsCoordinatorPath $Context.Root 'versions'
    $release=Assert-CodexsCoordinatorPath $versions $ref.release_id
    $update=Assert-CodexsCoordinatorPath $release 'update'
    $expected=Assert-CodexsCoordinatorPath $update 'launch.cjs'
    $bootstrapDir=Assert-CodexsCoordinatorPath $Context.Root 'bootstrap'
    $entry=Assert-CodexsCoordinatorPath $bootstrapDir 'bootstrap.cjs'
    if([IO.Path]::GetFullPath($WorkerPath) -ine $expected -or -not [IO.File]::Exists($expected) -or
       -not [IO.Path]::IsPathRooted($NodePath) -or -not [IO.File]::Exists($NodePath) -or -not [IO.File]::Exists($entry)){throw 'COORDINATOR_PATH'}
    $payloadData=@{mode=$Request.mode;releaseRef=$ref};if($Request.Contains('expectedCurrent')){$payloadData.expectedCurrent=$Request.expectedCurrent}
    $payload=$payloadData|ConvertTo-Json -Depth 8 -Compress
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $process=[Diagnostics.Process]::new();$job=$null;$started=$false;$elapsed=[Diagnostics.Stopwatch]::StartNew()
    $utf8=[Text.UTF8Encoding]::new($false)
    $process.StartInfo.FileName=$NodePath
    $process.StartInfo.Arguments='"'+$entry+'" worker '+$encoded
    $process.StartInfo.UseShellExecute=$false;$process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardInput=$true;$process.StartInfo.RedirectStandardOutput=$true;$process.StartInfo.RedirectStandardError=$true
    $process.StartInfo.StandardOutputEncoding=$utf8;$process.StartInfo.StandardErrorEncoding=$utf8
    $process.StartInfo.WorkingDirectory=$Context.Root
    try {
        $job=New-CodexsWorkerJob
        $started=$process.Start();if(-not $started){throw 'COORDINATOR_WORKER'}
        $job.Assign($process.Handle)
        # The pinned bootstrap cannot load operational code before this ownership barrier.
        $process.StandardInput.WriteLine('{"type":"start"}');$process.StandardInput.Flush()
        $outBuffer=[char[]]::new(8192);$errBuffer=[byte[]]::new(4096)
        $outRead=$process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)
        $errRead=$process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length)
        $pending=[Text.StringBuilder]::new();$stderrCount=0;$nextId=[long]1;$resultCode=$null
        $deadline=$elapsed.ElapsedMilliseconds+(Get-CodexsWorkerBudget $Request.mode)
        while($null -ne $outRead -or $null -ne $errRead -or -not $process.HasExited) {
            if($elapsed.ElapsedMilliseconds -gt $deadline){throw 'COORDINATOR_TIMEOUT'}
            if($null -ne $errRead -and $errRead.IsCompleted) {
                $count=$errRead.GetAwaiter().GetResult();$stderrCount+=$count
                if($stderrCount -gt 4096){throw 'COORDINATOR_OUTPUT'}
                $errRead=if($count -eq 0){$null}else{$process.StandardError.BaseStream.ReadAsync($errBuffer,0,$errBuffer.Length)}
            }
            if($null -ne $outRead -and $outRead.IsCompleted) {
                $count=$outRead.GetAwaiter().GetResult()
                if($count -eq 0){$outRead=$null}
                else {
                    $piece=[string]::new($outBuffer,0,$count)
                    if($piece -cmatch '[^ -~
]'){throw 'COORDINATOR_PROTOCOL'}
                    [void]$pending.Append($piece)
                    if($pending.Length -gt 6291456){throw 'COORDINATOR_PROTOCOL'}
                    $text=$pending.ToString()
                    while($text.Contains("`n")) {
                        $newline=$text.IndexOf("`n")
                        $line=$text.Substring(0,$newline).TrimEnd("`r")
                        $text=$text.Substring($newline+1)
                        if($null -ne $resultCode){throw 'COORDINATOR_PROTOCOL'}
                        if($line -cmatch '^{"type":"commit","id":([1-9][0-9]{0,15}),"state":"([A-Za-z0-9+/]*={0,2})"}$') {
                            $id=[long]::Parse($matches[1]);$base64=$matches[2]
                            if($id -ne $nextId -or $id -gt 9007199254740991){throw 'COORDINATOR_PROTOCOL'}
                            try {$bytes=[Convert]::FromBase64String($base64)}catch{throw 'COORDINATOR_PROTOCOL'}
                            if($bytes.Length -gt 4194304 -or [Convert]::ToBase64String($bytes) -cne $base64){throw 'COORDINATOR_PROTOCOL'}
                            Write-CodexsCoordinatorState -Context $Context -Bytes $bytes -ValidateState $Context.ValidateState -Checkpoint $Context.Checkpoint
                            $process.StandardInput.WriteLine('{"type":"ack","id":'+$id+',"code":"OK"}');$process.StandardInput.Flush()
                            $nextId++
                        } elseif($line -cmatch '^{"type":"result","code":"([A-Z][A-Z0-9_]{0,63})","stateChanged":(true|false)}$') {
                            $resultCode=$matches[1]
                            if(($matches[2] -ceq 'true') -ne [bool]$Context.StateChanged){throw 'COORDINATOR_PROTOCOL'}
                            $deadline=$elapsed.ElapsedMilliseconds+5000
                            $process.StandardInput.Close()
                        } else {throw 'COORDINATOR_PROTOCOL'}
                    }
                    [void]$pending.Clear();[void]$pending.Append($text)
                    $outRead=$process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)
                }
            }
            [Threading.Thread]::Sleep(5)
        }
        if(-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0 -or $null -eq $resultCode -or $pending.Length -ne 0){throw 'COORDINATOR_WORKER'}
        if($Request.mode -ceq 'check' -and $resultCode -cne 'THROTTLED'){try{Write-CodexsWorkerDiagnostic $Context $resultCode $elapsed.ElapsedMilliseconds}catch{}}
        return @{code=$resultCode}
    } catch {
         $code=if($_.Exception.Message -cmatch '^COORDINATOR_[A-Z_]+$'){$_.Exception.Message}else{'COORDINATOR_WORKER'}
        if($Request.mode -ceq 'check'){try{Write-CodexsWorkerDiagnostic $Context $code $elapsed.ElapsedMilliseconds}catch{}}
        throw $code
    } finally {
        if($job){$job.Dispose()}
        if($started){try{if(-not $process.HasExited){$process.Kill()};[void]$process.WaitForExit(5000)}catch{}}
        $process.Dispose()
    }
}
