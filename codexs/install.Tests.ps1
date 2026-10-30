param([string]$InstallerPath)

$ErrorActionPreference = 'Stop'
if (-not $InstallerPath) {
    $InstallerPath = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'install.ps1' } else { Join-Path (Get-Location) 'codexs/install.ps1' }
}
. ([scriptblock]::Create([IO.File]::ReadAllText($installerPath)))
$script:passed = 0
$script:failed = 0
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codexs-installer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Assert-True($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}
function Check([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Output "PASS $Name" }
    catch { $script:failed++; Write-Output "FAIL $Name : $($_.Exception.Message)" }
}
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
function New-Fixture {
    $root = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    foreach ($name in @('source/codex-rs','main','helper/vendor/x86_64-pc-windows-msvc/bin','helper/vendor/x86_64-pc-windows-msvc/codex-path','helper/vendor/x86_64-pc-windows-msvc/codex-resources','allowed','shims','elsewhere')) {
        New-Item -ItemType Directory -Path (Join-Path $root $name) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $root 'source/codex-rs/Cargo.toml'), "[workspace.package]`nversion = `"0.162.1`"`n")
    $vendor = Join-Path $root 'helper/vendor/x86_64-pc-windows-msvc'
    foreach ($name in @('bin/codex.exe','codex-path/rg.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe')) {
        [IO.File]::WriteAllText((Join-Path $vendor $name), 'synthetic-vendor')
    }
    Write-Json (Join-Path $root 'main/package.json') @{name='@openai/codex';version='0.162.1';optionalDependencies=@{'@openai/codex-win32-x64'='npm:@openai/codex@0.162.1-win32-x64'}}
    Write-Json (Join-Path $root 'helper/package.json') @{name='@openai/codex';version='0.162.1-win32-x64';os=@('win32');cpu=@('x64')}
    foreach ($name in @('candidate.exe','node.exe','formatter.js','settings.json')) { [IO.File]::WriteAllText((Join-Path $root $name), 'synthetic') }
    $evidence = @{source_sha=('a'*40);version='0.162.1';target='x86_64-pc-windows-msvc';binary_sha256=(Get-FileHash -LiteralPath (Join-Path $root 'candidate.exe') -Algorithm SHA256).Hash;feature_run='1';acceptance_run='2';feature=@{exit=0;passed=144;failed=0};full=@{exit=0;passed=5789;failed=0};config=@{exit=0;passed=366;failed=0};build_exit=0}
    Write-Json (Join-Path $root 'evidence.json') $evidence
    $options = @{SourceRoot=(Join-Path $root 'source');BinaryPath=(Join-Path $root 'candidate.exe');MainPackageRoot=(Join-Path $root 'main');HelperPackageRoot=(Join-Path $root 'helper');EvidencePath=(Join-Path $root 'evidence.json');NodePath=(Join-Path $root 'node.exe');FormatterPath=(Join-Path $root 'formatter.js');SettingsPath=(Join-Path $root 'settings.json');AllowedRoot=(Join-Path $root 'allowed');InstallRoot=(Join-Path $root 'allowed/codexs');ShimRoot=(Join-Path $root 'shims');AllowedShimRoot=$root}
    $ops = @{SourceSha={param($p) 'a'*40};BinaryVersion={param($p) 'codex-cli 0.162.1'};BinaryArchitecture={param($p) 'x64'};FreeBytes={param($p) [long]20GB};RunningPaths={ @() };CopyVendor={param($from,$to) Copy-Item -LiteralPath $from -Destination $to -Recurse -ErrorAction Stop};MoveDirectory={param($from,$to) [IO.Directory]::Move($from,$to)};WriteShim={param($p,$content) [IO.File]::WriteAllText($p,$content,[Text.UTF8Encoding]::new($false))}}
    $ops.FormatterVersion={param($node,$formatter) 'codexs-statusline 1.0.0'}
    @{Root=$root;Vendor=$vendor;Options=$options;Ops=$ops;Evidence=$evidence}
}
function Reject([string]$Name, [scriptblock]$Change, [string]$Pattern) {
    Check $Name {
        $f=New-Fixture; & $Change $f
        $existed=Test-Path -LiteralPath $f.Options.InstallRoot
        $message=$null
        try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $message=$_.Exception.Message }
        Assert-True ($null -ne $message -and $message -match $Pattern) "Expected rejection '$Pattern', got '$message'"
        Assert-True ((Test-Path -LiteralPath $f.Options.InstallRoot) -eq $existed) 'Preflight changed installation'
    }
}
try {
    Check 'derives product version from the supplied formatter diagnostic' {
        $f=New-Fixture
        $seen=@{}
        $f.Ops.FormatterVersion={param($node,$formatter) $seen.node=$node; $seen.formatter=$formatter; 'codexs-statusline 2.3.4-beta.1+proof'}.GetNewClosure()
        $result=Invoke-CodexsInstall $f.Options $f.Ops
        $config=[IO.File]::ReadAllText((Join-Path $result.InstallRoot 'launch.json')) | ConvertFrom-Json
        Assert-True ($config.product_version -ceq '2.3.4-beta.1+proof' -and $config.version -ceq '0.162.1') 'Product version not independently derived'
        Assert-True ($seen.node -ceq $f.Options.NodePath -and $seen.formatter -ceq $f.Options.FormatterPath) 'Explicit formatter inputs not probed'
    }
    foreach ($diagnostic in @('', 'ccstatusline 2.2.32', 'codexs-statusline 01.0.0', 'codexs-statusline 1.0', "codexs-statusline 1.0.0`nextra", 'codexs-statusline 1.0.0-01')) {
        Reject "invalid formatter diagnostic [$diagnostic]" {param($f) $f.Ops.FormatterVersion={param($node,$formatter) $diagnostic}.GetNewClosure()} 'formatter.*version'
    }
    Reject 'missing formatter version operation' {param($f) $f.Ops.Remove('FormatterVersion')} 'formatter.*version'
    Reject 'failed formatter version operation' {param($f) $f.Ops.FormatterVersion={throw 'Formatter version probe failed'}} 'formatter.*version'
    Check 'production formatter probe and both launcher version modes need no config or TTY' {
        $f=New-Fixture
        $f.Options.NodePath=(Get-Command node.exe -ErrorAction Stop).Source
        [IO.File]::WriteAllText($f.Options.FormatterPath,"if(JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--codex','--version']) && JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--codex','-V'])) process.exit(31); console.log('codexs-statusline 1.0.0');")
        $f.Ops.FormatterVersion=(Get-CodexsInstallOperations).FormatterVersion
        $result=Invoke-CodexsInstall $f.Options $f.Ops
        Assert-True ($result.ProductVersion -ceq '1.0.0') 'Production diagnostic not parsed'
        Remove-Item -LiteralPath $f.Options.SettingsPath
        Remove-Item -LiteralPath (Join-Path $result.InstallRoot 'bin/codex.exe')
        foreach ($flag in @('--version','-V')) {
            $output=@(& (Join-Path $f.Options.ShimRoot 'codexs.cmd') $flag); $code=$LASTEXITCODE
            Assert-True ($code -eq 0 -and $output.Count -eq 1 -and $output[0] -ceq 'codexs 1.0.0 (Codex CLI 0.162.1)') 'CLI product diagnostic incorrect'
            $output=@(& (Join-Path $f.Options.ShimRoot 'codexs-statusline.cmd') $flag); $code=$LASTEXITCODE
            Assert-True ($code -eq 0 -and $output.Count -eq 1 -and $output[0] -ceq 'codexs-statusline 1.0.0') 'Editor diagnostic did not forward --codex without config'
        }
        [IO.File]::WriteAllText($f.Options.FormatterPath,"console.log('codexs-statusline 1.0.0'); process.exitCode=19;")
        $caught=$false
        try { & $f.Ops.FormatterVersion $f.Options.NodePath $f.Options.FormatterPath | Out-Null } catch { $caught=$_.Exception.Message -match 'Formatter version probe failed' }
        Assert-True $caught 'Nonzero formatter probe accepted'
    }
    Check 'stages the complete vendor and both managed command shims' {
        $f=New-Fixture; $result=Invoke-CodexsInstall $f.Options $f.Ops
        Assert-True (Test-Path -LiteralPath (Join-Path $f.Options.InstallRoot 'codex-path/rg.exe')) 'Missing path helper'
        Assert-True (Test-Path -LiteralPath (Join-Path $f.Options.InstallRoot 'codex-resources/codex-command-runner.exe')) 'Missing resource helper'
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $f.Options.InstallRoot 'bin/codex.exe')).Hash -eq (Get-FileHash -LiteralPath $f.Options.BinaryPath).Hash) 'Candidate not staged'
        foreach ($name in @('codexs.cmd','codexs-statusline.cmd')) {
            $shim=[IO.File]::ReadAllText((Join-Path $f.Options.ShimRoot $name))
            Assert-True ($shim -match 'setlocal' -and $shim -match 'CODEX_MANAGED_BY_NPM=' -and $shim -match '%\*' -and $shim -match 'exit /b') 'Shim contract missing'
        }
        Assert-True (Test-Path -LiteralPath (Join-Path $result.InstallRoot 'launch.cjs')) 'Missing launcher'
    }
    Reject 'missing source manifest' {param($f) Remove-Item -LiteralPath (Join-Path $f.Options.SourceRoot 'codex-rs/Cargo.toml')} 'Missing'
    Reject 'mismatched main package version' {param($f) Write-Json (Join-Path $f.Options.MainPackageRoot 'package.json') @{name='@openai/codex';version='0.165.0'}} 'version'
    Reject 'mismatched helper alias' {param($f) Write-Json (Join-Path $f.Options.HelperPackageRoot 'package.json') @{name='@openai/codex';version='0.165.0-win32-x64';os=@('win32');cpu=@('x64')}} 'helper'
    Reject 'wrong helper architecture' {param($f) Write-Json (Join-Path $f.Options.HelperPackageRoot 'package.json') @{name='@openai/codex';version='0.162.1-win32-x64';os=@('win32');cpu=@('arm64')}} 'architecture'
    Reject 'wrong source revision evidence' {param($f) $f.Evidence.source_sha='b'*40; Write-Json $f.Options.EvidencePath $f.Evidence} 'source'
    Reject 'changed candidate bytes' {param($f) [IO.File]::AppendAllText($f.Options.BinaryPath,'changed')} 'hash'
    Reject 'failed native acceptance' {param($f) $f.Evidence.full.failed=1; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'string acceptance count' {param($f) $f.Evidence.full.passed='not-a-count'; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'boolean acceptance count' {param($f) $f.Evidence.full.passed=$true; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'fractional acceptance count' {param($f) $f.Evidence.full.passed=0.5; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'unsafe acceptance count' {param($f) $f.Evidence.full.passed=1e30; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'missing acceptance exit' {param($f) $f.Evidence.full.Remove('exit'); Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'string acceptance exit' {param($f) $f.Evidence.full.exit='0'; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'boolean failed count' {param($f) $f.Evidence.full.failed=$false; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'boolean build exit' {param($f) $f.Evidence.build_exit=$false; Write-Json $f.Options.EvidencePath $f.Evidence} 'acceptance'
    Reject 'wrong native version' {param($f) $f.Ops.BinaryVersion={param($p) 'codex-cli 0.165.0'}} 'version'
    Reject 'wrong native binary architecture' {param($f) $f.Ops.BinaryArchitecture={param($p) 'arm64'}} 'architecture'
    Reject 'disk bytes below eight GiB' {param($f) $f.Ops.FreeBytes={param($p) [long](8GB-1)}} 'disk'
    Reject 'unavailable disk reading' {param($f) $f.Ops.FreeBytes={param($p) $null}} 'disk'
    Reject 'missing vendor resource' {param($f) Remove-Item -LiteralPath (Join-Path $f.Vendor 'codex-resources/codex-command-runner.exe')} 'helper'
    Reject 'destination escapes allowed root' {param($f) $f.Options.InstallRoot=Join-Path $f.Root 'outside'} 'path'
    Reject 'destination is the allowed root' {param($f) $f.Options.InstallRoot=$f.Options.AllowedRoot} 'path'
    Reject 'unrelated existing user shim' {param($f) [IO.File]::WriteAllText((Join-Path $f.Options.ShimRoot 'codexs.cmd'),'unrelated user command')} 'shim'
    Check 'rejects a vendor junction without changing its owned target' {
        $f=New-Fixture
        $target=Join-Path $f.Root 'junction-target'
        $link=Join-Path $f.Vendor 'reparse-link'
        New-Item -ItemType Directory -Path $target | Out-Null
        [IO.File]::WriteAllText((Join-Path $target 'keep.txt'),'keep')
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        try {
            $message=$null
            try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $message=$_.Exception.Message }
            Assert-True ($message -match 'reparse') 'Vendor junction was accepted'
            Assert-True ([IO.File]::ReadAllText((Join-Path $target 'keep.txt')) -eq 'keep') 'Junction target changed'
        } finally {
            if (-not ([IO.Path]::GetFullPath($link)).StartsWith([IO.Path]::GetFullPath($f.Root)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe junction cleanup path' }
            [IO.Directory]::Delete($link)
        }
    }
    Check 'normalizes relative input paths before storing launcher configuration' {
        $f=New-Fixture
        Push-Location $f.Root
        try {
            $f.Options.NodePath='node.exe'
            Invoke-CodexsInstall $f.Options $f.Ops | Out-Null
            $config=[IO.File]::ReadAllText((Join-Path $f.Options.InstallRoot 'launch.json')) | ConvertFrom-Json
            Assert-True ([IO.Path]::IsPathRooted($config.node)) 'Launcher stored a relative Node path'
        } finally { Pop-Location }
    }

    foreach ($failure in @('copy','first-rename','second-rename','shim')) {
        Check "preserves old installation on $failure failure" {
            $f=New-Fixture
            New-Item -ItemType Directory -Path $f.Options.InstallRoot | Out-Null
            [IO.File]::WriteAllText((Join-Path $f.Options.InstallRoot 'old.txt'),'old')
            if ($failure -eq 'copy') { $f.Ops.CopyVendor={param($a,$b) throw 'synthetic copy failure'} }
            elseif ($failure -eq 'shim') { $f.Ops.WriteShim={param($a,$b) throw 'synthetic shim failure'} }
            else {
                $counter=@{n=0}; $failAt=if ($failure -eq 'first-rename') {1} else {2}
                $f.Ops.MoveDirectory={param($a,$b) $counter.n++; if($counter.n -eq $failAt){throw 'synthetic rename failure'}; [IO.Directory]::Move($a,$b)}.GetNewClosure()
            }
            $caught=$false
            try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $caught=$_.Exception.Message -match 'synthetic (copy|rename|shim) failure' }
            Assert-True $caught 'Failure was swallowed'
            Assert-True ([IO.File]::ReadAllText((Join-Path $f.Options.InstallRoot 'old.txt')) -eq 'old') 'Old install was lost'
        }
    }
    Check 'retains existing backups and creates a new backup only after safe staging' {
        $f=New-Fixture; $prior=Join-Path $f.Options.AllowedRoot 'codexs.prev'
        New-Item -ItemType Directory -Path $prior,$f.Options.InstallRoot | Out-Null
        [IO.File]::WriteAllText((Join-Path $prior 'oldest.txt'),'oldest')
        [IO.File]::WriteAllText((Join-Path $f.Options.InstallRoot 'old.txt'),'old')
        $result=Invoke-CodexsInstall $f.Options $f.Ops
        Assert-True (Test-Path -LiteralPath (Join-Path $prior 'oldest.txt')) 'Existing backup removed'
        Assert-True (Test-Path -LiteralPath (Join-Path $result.BackupRoot 'old.txt')) 'Previous installation not retained'
    }
    Check 'refuses an incomplete staged copy before moving the old install' {
        $f=New-Fixture
        New-Item -ItemType Directory -Path $f.Options.InstallRoot | Out-Null
        [IO.File]::WriteAllText((Join-Path $f.Options.InstallRoot 'old.txt'),'old')
        $f.Ops.CopyVendor={param($a,$b) Copy-Item -LiteralPath $a -Destination $b -Recurse; Remove-Item -LiteralPath (Join-Path $b 'codex-path/rg.exe')}
        $message=$null
        try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $message=$_.Exception.Message }
        Assert-True ($message -match 'Staged vendor helper') 'Incomplete stage accepted'
        Assert-True (Test-Path -LiteralPath (Join-Path $f.Options.InstallRoot 'old.txt')) 'Old install moved before validation'
    }
    Check 'rejects a running installed helper without terminating it' {
        $f=New-Fixture
        $running=Join-Path $f.Options.InstallRoot 'codex-resources/codex-command-runner.exe'
        $f.Ops.RunningPaths={ $running }.GetNewClosure()
        $caught=$false
        try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $caught=$_.Exception.Message -match 'running' }
        Assert-True $caught 'Running helper not rejected'
    }
    Check 'rejects an exclusively locked old binary' {
        $f=New-Fixture
        New-Item -ItemType Directory -Path (Join-Path $f.Options.InstallRoot 'bin') | Out-Null
        $old=Join-Path $f.Options.InstallRoot 'bin/codex.exe'; [IO.File]::WriteAllText($old,'old')
        $lock=[IO.File]::Open($old,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try {
            $caught=$false
            try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $caught=$_.Exception.Message -match 'locked' }
            Assert-True $caught 'Locked binary not rejected'
        } finally { $lock.Dispose() }
    }
    Check 'reports rollback failure and retains the old backup for recovery' {
        $f=New-Fixture
        New-Item -ItemType Directory -Path $f.Options.InstallRoot | Out-Null
        [IO.File]::WriteAllText((Join-Path $f.Options.InstallRoot 'old.txt'),'old')
        $counter=@{n=0}
        $f.Ops.MoveDirectory={param($a,$b) $counter.n++; if($counter.n -ge 2){throw 'synthetic rollback failure'}; [IO.Directory]::Move($a,$b)}.GetNewClosure()
        $message=$null
        try { Invoke-CodexsInstall $f.Options $f.Ops | Out-Null } catch { $message=$_.Exception.Message }
        Assert-True ($message -match 'Rollback failed') 'Rollback failure was hidden'
        $backups=@(Get-ChildItem -LiteralPath $f.Options.AllowedRoot -Directory | Where-Object { $_.Name -like 'codexs.prev-*' })
        Assert-True ($backups.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'old.txt'))) 'Recoverable backup missing'
    }
    Check 'launchers work from unrelated directories, preserve arguments/environment and return exit status' {
        $f=New-Fixture
        $f.Options.InstallRoot=Join-Path $f.Options.AllowedRoot 'codexs space λ'
        $elsewhere=Join-Path $f.Root 'another directory λ'
        New-Item -ItemType Directory -Path $elsewhere | Out-Null
        $probe=Join-Path $f.Root 'native-probe.exe'
        $className='CodexsProbe'+[guid]::NewGuid().ToString('N')
        $source=@"
using System;
using System.Text;
public class $className {
  public static int Main(string[] args) {
    foreach (var arg in args) Console.WriteLine("ARG:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));
    Console.WriteLine("NPM:" + (Environment.GetEnvironmentVariable("CODEX_MANAGED_BY_NPM") ?? ""));
    Console.WriteLine("ROOT:" + (Environment.GetEnvironmentVariable("CODEX_MANAGED_PACKAGE_ROOT") ?? ""));
    Console.WriteLine("CWD:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(Environment.CurrentDirectory)));
    Console.WriteLine("PATH:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(Environment.GetEnvironmentVariable("PATH"))));
    return 23;
  }
}
"@
        Add-Type -TypeDefinition $source -OutputAssembly $probe -OutputType ConsoleApplication
        Copy-Item -LiteralPath $probe -Destination $f.Options.BinaryPath -Force
        $f.Evidence.binary_sha256=(Get-FileHash -LiteralPath $f.Options.BinaryPath -Algorithm SHA256).Hash
        Write-Json $f.Options.EvidencePath $f.Evidence
        $f.Options.NodePath=(Get-Command node.exe -ErrorAction Stop).Source
        [IO.File]::WriteAllText($f.Options.FormatterPath,"for(const a of process.argv.slice(2)) console.log('ARG:'+Buffer.from(a).toString('base64')); console.log('CWD:'+Buffer.from(process.cwd()).toString('base64')); process.exitCode=17;")
        Invoke-CodexsInstall $f.Options $f.Ops | Out-Null
        $oldNpm=$env:CODEX_MANAGED_BY_NPM; $oldRoot=$env:CODEX_MANAGED_PACKAGE_ROOT; $oldPath=$env:PATH
        try {
            $env:CODEX_MANAGED_BY_NPM='1'; $env:CODEX_MANAGED_PACKAGE_ROOT='synthetic'; $env:PATH=$f.Options.ShimRoot+';'+$env:PATH
            Push-Location $elsewhere
            try {
                $output=@(& codexs.cmd 'argument with spaces' 'synthetic-unicode-λ'); $nativeExit=$LASTEXITCODE
                Assert-True ($nativeExit -eq 23) "CLI exit was $nativeExit"
                $args=@($output | Where-Object { $_ -like 'ARG:*' } | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.Substring(4))) })
                Assert-True ($args.Count -eq 4 -and $args[0] -eq '-c' -and $args[1].StartsWith('tui.status_line_command.command=') -and $args[2] -eq 'argument with spaces' -and $args[3] -eq 'synthetic-unicode-λ') 'CLI argument forwarding failed'
                $command=$args[1].Substring('tui.status_line_command.command='.Length) | ConvertFrom-Json
                $expectedCommand='"'+$f.Options.NodePath+'" "'+$f.Options.FormatterPath+'" --config "'+$f.Options.SettingsPath+'"'
                Assert-True ($command -ceq $expectedCommand) 'Nested native footer command quoting changed'
                Assert-True ($output -contains 'NPM:' -and $output -contains 'ROOT:') 'npm environment leaked'
                $cwd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($output | Where-Object { $_ -like 'CWD:*' }).Substring(4)))
                Assert-True ($cwd -eq (Get-Location).Path) 'Working directory changed'
                $childPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($output | Where-Object { $_ -like 'PATH:*' }).Substring(5)))
                Assert-True ($childPath.StartsWith((Join-Path $f.Options.InstallRoot 'codex-path')+';')) 'Helper PATH not prepended'
                $output=@(& codexs-statusline.cmd 'editor argument'); $nativeExit=$LASTEXITCODE
                Assert-True ($nativeExit -eq 17) "Editor exit was $nativeExit"
                $args=@($output | Where-Object { $_ -like 'ARG:*' } | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.Substring(4))) })
                Assert-True ($args.Count -eq 4 -and $args[0] -eq '--codex' -and $args[1] -eq '--config' -and $args[2] -eq $f.Options.SettingsPath -and $args[3] -eq 'editor argument') 'Editor config/argument forwarding failed'
                $output=@(& codexs.cmd '""' 'literal\"quote' '-c' "tui.status_line_command.command='user override'"); $nativeExit=$LASTEXITCODE
                $args=@($output | Where-Object { $_ -like 'ARG:*' } | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.Substring(4))) })
                Assert-True ($nativeExit -eq 23 -and $args.Count -eq 6 -and $args[2] -ceq '' -and $args[3] -ceq 'literal"quote' -and $args[4] -ceq '-c' -and $args[5] -ceq "tui.status_line_command.command='user override'") ('CLI empty/quote/override forwarding failed: '+($args|ConvertTo-Json -Compress))
                $output=@(& codexs-statusline.cmd '""' 'literal\"quote'); $nativeExit=$LASTEXITCODE
                $args=@($output | Where-Object { $_ -like 'ARG:*' } | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.Substring(4))) })
                Assert-True ($nativeExit -eq 17 -and $args.Count -eq 5 -and $args[3] -ceq '' -and $args[4] -ceq 'literal"quote') ('Editor empty/quote forwarding failed: '+($args|ConvertTo-Json -Compress))
            } finally { Pop-Location }
        } finally {
            $env:CODEX_MANAGED_BY_NPM=$oldNpm; $env:CODEX_MANAGED_PACKAGE_ROOT=$oldRoot; $env:PATH=$oldPath
        }
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^codexs-installer-[0-9a-f]{32}$') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output "Installer assertions: $script:passed passed; $script:failed failed"
if ($script:failed -gt 0) { throw 'Installer assertions failed' }
$global:LASTEXITCODE=0
