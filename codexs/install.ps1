[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$BinaryPath,
    [string]$MainPackageRoot,
    [string]$HelperPackageRoot,
    [string]$EvidencePath,
    [string]$NodePath,
    [string]$FormatterPath,
    [string]$SettingsPath,
    [switch]$Install
)

function Assert-CodexsPath {
    param([string]$Root, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Path)) { throw 'Unsafe empty path' }
    $base=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($base -eq [IO.Path]::GetPathRoot($base).TrimEnd('\') -or -not $full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path outside intended root: $full" }
    $cursor=$full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe reparse-point path' }
        }
        $parent=[IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }; $cursor=$parent
    }
    $full
}

function Assert-CodexsUnlocked {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        try { $handle=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $handle.Dispose() }
        catch { throw "Installed file is locked or not writable: $Path" }
    }
}

function Test-CodexsJsonInteger {
    param($Value, [switch]$Positive)
    if ($Value -isnot [int] -and $Value -isnot [long] -and $Value -isnot [double] -and $Value -isnot [decimal]) { return $false }
    $number=[double]$Value
    $minimum=if ($Positive) {1} else {0}
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and $number -ge $minimum -and $number -le 9007199254740991 -and [Math]::Truncate($number) -eq $number
}

function Get-CodexsInstallOperations {
    @{
        FormatterVersion={ param($node,$formatter)
            $ErrorActionPreference='Continue'; $result=& $node $formatter --codex --version; $nativeExit=$LASTEXITCODE
            if ($nativeExit -ne 0) { throw 'Formatter version probe failed' }; $result -join "`n"
        }
        SourceSha={ param($p)
            $dirty=& git -C $p status --porcelain --untracked-files=no -- codex-rs
            $nativeExit=$LASTEXITCODE
            if ($nativeExit -ne 0 -or $dirty) { throw 'Cannot verify unchanged native source; codex-rs has tracked changes' }
            $result=& git -C $p rev-parse HEAD
            $nativeExit=$LASTEXITCODE
            if ($nativeExit -ne 0) { throw 'Cannot verify source revision' }; ($result -join '').Trim()
        }
        BinaryVersion={ param($p)
            $ErrorActionPreference='Continue'; $result=& $p --version; $nativeExit=$LASTEXITCODE
            if ($nativeExit -ne 0) { throw 'Binary version probe failed' }; ($result -join '').Trim()
        }
        BinaryArchitecture={ param($p)
            $reader=[IO.BinaryReader]::new([IO.File]::OpenRead($p))
            try {
                if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Invalid binary architecture header' }
                $reader.BaseStream.Position=0x3c; $offset=$reader.ReadUInt32()
                if ([long]$offset+6 -gt $reader.BaseStream.Length) { throw 'Invalid binary architecture offset' }
                $reader.BaseStream.Position=$offset
                if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Binary architecture must be Windows x64' }
                'x64'
            } finally { $reader.Dispose() }
        }
        FreeBytes={ param($p) [IO.DriveInfo]::new([IO.Path]::GetPathRoot($p)).AvailableFreeSpace }
        RunningPaths={ @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $_.ExecutablePath } | Where-Object { $_ }) }
        CopyVendor={ param($a,$b) Copy-Item -LiteralPath $a -Destination $b -Recurse -ErrorAction Stop }
        MoveDirectory={ param($a,$b) [IO.Directory]::Move($a,$b) }
        WriteShim={ param($p,$content) [IO.File]::WriteAllText($p,$content,[Text.UTF8Encoding]::new($false)) }
    }
}

function Invoke-CodexsInstall {
    param([hashtable]$Options, [hashtable]$Operations)
    $ErrorActionPreference='Stop'
    $Options=$Options.Clone()
    if (-not $Operations) { $Operations=Get-CodexsInstallOperations }
    $destination=Assert-CodexsPath $Options.AllowedRoot $Options.InstallRoot
    $shimRoot=Assert-CodexsPath $Options.AllowedShimRoot $Options.ShimRoot
    foreach ($key in @('SourceRoot','BinaryPath','MainPackageRoot','HelperPackageRoot','EvidencePath','NodePath','FormatterPath','SettingsPath')) {
        if (-not $Options[$key] -or -not (Test-Path -LiteralPath $Options[$key])) { throw "Missing input: $key" }
        $Options[$key]=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Options[$key])
    }
    $cargo=Join-Path $Options.SourceRoot 'codex-rs/Cargo.toml'
    if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) { throw 'Missing source manifest' }
    $versionMatch=[regex]::Match([IO.File]::ReadAllText($cargo),'(?ms)^\[workspace\.package\]\s*\r?\nversion\s*=\s*"([^"]+)"')
    if (-not $versionMatch.Success) { throw 'Cannot read source version' }
    $version=$versionMatch.Groups[1].Value
    if (-not $Operations.FormatterVersion) { throw 'Missing formatter version probe' }
    $diagnostic=& $Operations.FormatterVersion $Options.NodePath $Options.FormatterPath
    # SemVer 2.0: numeric prerelease identifiers cannot contain leading zeroes.
    $numeric='(?:0|[1-9][0-9]*)'
    $identifier='(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
    $semver="$numeric\.$numeric\.$numeric(?:-$identifier(?:\.$identifier)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    if ($diagnostic -isnot [string] -or $diagnostic -cnotmatch "\Acodexs-statusline ($semver)\z") { throw 'Malformed or unsupported formatter product version diagnostic' }
    $productVersion=$Matches[1]
    $main=[IO.File]::ReadAllText((Join-Path $Options.MainPackageRoot 'package.json')) | ConvertFrom-Json
    $helper=[IO.File]::ReadAllText((Join-Path $Options.HelperPackageRoot 'package.json')) | ConvertFrom-Json
    if ($main.name -ne '@openai/codex' -or $main.version -ne $version) { throw 'Main package/source version mismatch' }
    $alias=$main.optionalDependencies.'@openai/codex-win32-x64'
    if ($alias -cne "npm:@openai/codex@$version-win32-x64" -or $helper.name -ne '@openai/codex' -or $helper.version -cne "$version-win32-x64") { throw 'Platform helper version/alias mismatch' }
    if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $helper.cpu -notcontains 'x64' -or $helper.os -notcontains 'win32') { throw 'Unsupported architecture; Windows x64 required' }
    $evidence=[IO.File]::ReadAllText($Options.EvidencePath) | ConvertFrom-Json
    $sourceSha=& $Operations.SourceSha $Options.SourceRoot
    if ($evidence.source_sha -cnotmatch '^[a-f0-9]{40}$' -or $evidence.source_sha -cne $sourceSha) { throw 'Evidence/source revision mismatch' }
    if ($evidence.version -cne $version -or $evidence.target -cne 'x86_64-pc-windows-msvc') { throw 'Evidence version/architecture mismatch' }
    foreach ($suite in @('feature','full','config')) {
        $summary=$evidence.$suite
        if (-not (Test-CodexsJsonInteger $summary.exit) -or $summary.exit -ne 0 -or -not (Test-CodexsJsonInteger $summary.failed) -or $summary.failed -ne 0 -or -not (Test-CodexsJsonInteger $summary.passed -Positive)) { throw 'Missing, malformed or failed native acceptance evidence' }
    }
    if (-not (Test-CodexsJsonInteger $evidence.build_exit) -or $evidence.build_exit -ne 0 -or -not $evidence.feature_run -or -not $evidence.acceptance_run) { throw 'Missing or malformed successful build/acceptance references' }
    if ($evidence.binary_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $Options.BinaryPath -Algorithm SHA256).Hash -ine $evidence.binary_sha256) { throw 'Candidate binary hash mismatch' }
    if ((& $Operations.BinaryArchitecture $Options.BinaryPath) -cne 'x64') { throw 'Candidate binary architecture mismatch' }
    if ((& $Operations.BinaryVersion $Options.BinaryPath) -cne "codex-cli $version") { throw 'Candidate binary version mismatch' }
    $free=& $Operations.FreeBytes $destination
    if ($null -eq $free -or [long]$free -lt 8GB) { throw 'Insufficient/unavailable raw disk bytes; at least eight GiB required' }
    $vendor=Join-Path $Options.HelperPackageRoot 'vendor/x86_64-pc-windows-msvc'
    $required=@('bin/codex.exe','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe')
    foreach ($relative in $required) {
        $helperPath=Assert-CodexsPath $Options.HelperPackageRoot (Join-Path $vendor $relative)
        if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw "Missing vendor helper: $relative" }
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $vendor -Recurse -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe vendor reparse-point path' }
    }
    foreach ($running in @(& $Operations.RunningPaths)) {
        if ($running -and ([IO.Path]::GetFullPath($running)).StartsWith($destination+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'An installed binary/helper is running; close it before installation' }
    }
    if (Test-Path -LiteralPath $destination) {
        foreach ($item in @(Get-ChildItem -LiteralPath $destination -Recurse -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe installed reparse-point path' }
            if (-not $item.PSIsContainer) { Assert-CodexsUnlocked $item.FullName }
        }
    }
    $shimPaths=@('codexs.cmd','codexs-statusline.cmd') | ForEach-Object { Assert-CodexsPath $shimRoot (Join-Path $shimRoot $_) }
    $oldShims=@{}
    foreach ($path in $shimPaths) {
        if (Test-Path -LiteralPath $path) {
            if (-not [IO.File]::ReadAllText($path).Contains('REM codexs managed shim')) { throw 'Refusing to overwrite unrelated user shim' }
            Assert-CodexsUnlocked $path; $oldShims[$path]=[IO.File]::ReadAllBytes($path)
        } else { $oldShims[$path]=$null }
    }
    $id=[guid]::NewGuid().ToString('N')
    $stage=Assert-CodexsPath $Options.AllowedRoot ($destination+'.stage-'+$id)
    $backup=Assert-CodexsPath $Options.AllowedRoot ($destination+'.prev-'+$id)
    $failed=Assert-CodexsPath $Options.AllowedRoot ($destination+'.failed-'+$id)
    $movedOld=$false; $movedNew=$false; $writingShims=$false
    try {
        New-Item -ItemType Directory -Path $Options.AllowedRoot -Force | Out-Null
        & $Operations.CopyVendor $vendor $stage
        Copy-Item -LiteralPath $Options.BinaryPath -Destination (Join-Path $stage 'bin/codex.exe') -Force -ErrorAction Stop
        foreach ($relative in $required) { if (-not (Test-Path -LiteralPath (Join-Path $stage $relative) -PathType Leaf)) { throw 'Staged vendor helper is missing' } }
        if ((Get-FileHash -LiteralPath (Join-Path $stage 'bin/codex.exe') -Algorithm SHA256).Hash -ine $evidence.binary_sha256 -or (& $Operations.BinaryVersion (Join-Path $stage 'bin/codex.exe')) -cne "codex-cli $version") { throw 'Staged binary hash/version mismatch' }
        $launchConfig=@{node=$Options.NodePath;formatter=$Options.FormatterPath;settings=$Options.SettingsPath;source_sha=$sourceSha;version=$version;product_version=$productVersion}
        [IO.File]::WriteAllText((Join-Path $stage 'launch.json'),($launchConfig | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        $launcher=@'
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(root, 'launch.json'), 'utf8'));
const mode = process.argv[1];
const forwarded = process.argv.slice(2);
const editor = mode === 'editor';
if (!editor && mode !== 'cli') { console.error('Unknown codexs launch mode'); process.exit(1); }
const versionOnly = forwarded.length === 1 && ['--version', '-V'].includes(forwarded[0]);
if (!editor && versionOnly) {
    console.log('codexs ' + config.product_version + ' (Codex CLI ' + config.version + ')');
    process.exit(0);
}
const binary = editor ? config.node : path.join(root, 'bin', 'codex.exe');
for (const file of (editor && versionOnly ? [config.node, config.formatter] : [binary, config.node, config.formatter, config.settings])) {
    if (!fs.existsSync(file)) { console.error('Missing codexs launch file: ' + file); process.exit(1); }
}
const command = '"' + config.node + '" "' + config.formatter + '" --config "' + config.settings + '"';
const args = editor
    ? (versionOnly ? [config.formatter, '--codex', ...forwarded] : [config.formatter, '--codex', '--config', config.settings, ...forwarded])
    : ['-c', 'tui.status_line_command.command=' + JSON.stringify(command), ...forwarded];
const env = { ...process.env, PATH: path.join(root, 'codex-path') + path.delimiter + (process.env.PATH || '') };
delete env.CODEX_MANAGED_BY_NPM;
delete env.CODEX_MANAGED_PACKAGE_ROOT;
const child = spawn(binary, args, { stdio: 'inherit', env });
child.on('error', error => { console.error('Cannot start codexs: ' + error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { try { child.kill(signal); } catch {} });
}
child.on('exit', code => { process.exitCode = code === null ? 1 : code; });
'@
        [IO.File]::WriteAllText((Join-Path $stage 'launch.cjs'),$launcher,[Text.UTF8Encoding]::new($false))
        $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Join-Path $destination 'launch.cjs')))
        $node=$Options.NodePath.Replace('%','%%')
        $shims=@{}
        foreach ($name in @('codexs.cmd','codexs-statusline.cmd')) {
            $mode=if ($name -eq 'codexs.cmd') {'cli'} else {'editor'}
            $shims[$name]="@echo off`r`nREM codexs managed shim`r`nsetlocal`r`nset `"CODEX_MANAGED_BY_NPM=`"`r`nset `"CODEX_MANAGED_PACKAGE_ROOT=`"`r`nset `"CODEXS_LAUNCHER=$encoded`"`r`n`"$node`" -e `"require(Buffer.from(process.env.CODEXS_LAUNCHER,'base64').toString('utf8'))`" $mode %*`r`nexit /b %errorlevel%`r`n"
            [IO.File]::WriteAllText((Join-Path $stage $name),$shims[$name],[Text.UTF8Encoding]::new($false))
        }
        if (Test-Path -LiteralPath $destination) { & $Operations.MoveDirectory $destination $backup; $movedOld=$true }
        & $Operations.MoveDirectory $stage $destination; $movedNew=$true
        New-Item -ItemType Directory -Path $shimRoot -Force | Out-Null
        $writingShims=$true
        foreach ($name in @('codexs.cmd','codexs-statusline.cmd')) { & $Operations.WriteShim (Join-Path $shimRoot $name) $shims[$name] }
        [pscustomobject]@{InstallRoot=$destination;ShimRoot=$shimRoot;BackupRoot=$(if($movedOld){$backup}else{$null});SourceSha=$sourceSha;Version=$version;ProductVersion=$productVersion}
    } catch {
        $problem=$_.Exception.Message; $rollbackProblems=@()
        if ($writingShims) {
            foreach ($path in $shimPaths) {
                try { if ($null -eq $oldShims[$path]) { if(Test-Path -LiteralPath $path){ Remove-Item -LiteralPath $path -Force } } else { [IO.File]::WriteAllBytes($path,$oldShims[$path]) } }
                catch { $rollbackProblems += $_.Exception.Message }
            }
        }
        try {
            if ($movedNew) { & $Operations.MoveDirectory $destination $failed }
            if ($movedOld) { & $Operations.MoveDirectory $backup $destination }
        } catch { $rollbackProblems += $_.Exception.Message }
        if ($rollbackProblems.Count -gt 0) { throw "Install failed: $problem. Rollback failed: $($rollbackProblems -join '; '). Retained backup: $backup" }
        throw "Install failed: $problem. Previous installation/shims retained or restored."
    } finally {
        if (Test-Path -LiteralPath $stage) {
            $safe=Assert-CodexsPath $Options.AllowedRoot $stage
            Remove-Item -LiteralPath $safe -Recurse -Force -ErrorAction Stop
        }
    }
}

if ($Install) {
    $options=@{SourceRoot=$SourceRoot;BinaryPath=$BinaryPath;MainPackageRoot=$MainPackageRoot;HelperPackageRoot=$HelperPackageRoot;EvidencePath=$EvidencePath;NodePath=$NodePath;FormatterPath=$FormatterPath;SettingsPath=$SettingsPath;AllowedRoot=$env:LOCALAPPDATA;InstallRoot=(Join-Path $env:LOCALAPPDATA 'codexs');AllowedShimRoot=$env:USERPROFILE;ShimRoot=(Join-Path $env:USERPROFILE '.local/bin')}
    Invoke-CodexsInstall $options (Get-CodexsInstallOperations)
}
