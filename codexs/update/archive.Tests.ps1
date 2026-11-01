param([string]$ArchiveScript = (Join-Path (Get-Location) 'codexs/update/archive.ps1'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codexs-archive-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$script:passed = 0
$script:failures = [Collections.Generic.List[string]]::new()

function Assert-ArchiveTest([bool]$Condition) { if (-not $Condition) { throw 'Synthetic archive assertion failed' } }
function Check-ArchiveTest([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Output ('PASS ' + $Name) }
    catch { $script:failures.Add($Name + ': ' + $_.Exception.Message); Write-Output ('FAIL ' + $Name + ': ' + $_.Exception.Message) }
}
function New-ArchiveFixture([object[]]$Entries) {
    $root = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($root)
    $archive = Join-Path $root 'bundle.zip'
    $stream = [IO.File]::Open($archive,[IO.FileMode]::CreateNew)
    $zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false,[Text.Encoding]::UTF8)
    $inventory = @()
    try {
        foreach ($item in $Entries) {
            $entry = $zip.CreateEntry($item.Name)
            $entry.LastWriteTime = [DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
            if ($item.ContainsKey('Attributes')) { $entry.ExternalAttributes = $item.Attributes }
            $bytes = [Text.Encoding]::UTF8.GetBytes($item.Text)
            $output = $entry.Open()
            try { $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
            $inventory += @{path=$item.Name;bytes=$bytes.Length;sha256=$digest}
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    $readStream = [IO.File]::OpenRead($archive)
    $readZip = [IO.Compression.ZipArchive]::new($readStream,[IO.Compression.ZipArchiveMode]::Read,$false)
    try {
        Assert-ArchiveTest ($readZip.Entries.Count -eq $Entries.Count)
        for ($i=0; $i -lt $Entries.Count; $i++) { Assert-ArchiveTest ($readZip.Entries[$i].FullName -ceq $Entries[$i].Name) }
    } finally { $readZip.Dispose(); $readStream.Dispose() }
    $fixture = @{Root=$root;Archive=$archive;Destination=(Join-Path $root 'payload');Inventory=(Join-Path $root 'inventory.json');Files=$inventory}
    Write-ArchiveInventory $fixture $inventory
    return $fixture
}
function Write-ArchiveInventory($Fixture, [object[]]$Files) {
    [IO.File]::WriteAllText($Fixture.Inventory,(ConvertTo-Json -InputObject @($Files) -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
}
function Invoke-ArchiveFixture($Fixture) {
    & ([scriptblock]::Create([IO.File]::ReadAllText($ArchiveScript))) -Archive $Fixture.Archive -Destination $Fixture.Destination -Inventory $Fixture.Inventory -AllowedRoot $Fixture.Root
}
function Reject-ArchiveFixture($Fixture) {
    $rejected = $false
    try { Invoke-ArchiveFixture $Fixture | Out-Null }
    catch { if ($_.Exception.Message -cne 'ARCHIVE_REJECTED') { throw }; $rejected = $true }
    Assert-ArchiveTest $rejected
    Assert-ArchiveTest (-not (Test-Path -LiteralPath $Fixture.Destination))
}
function Add-UnixArchiveExtra($Fixture) {
    $raw = [IO.File]::ReadAllBytes($Fixture.Archive)
    $footer = $raw.Length-22
    $oldCentral = [int][BitConverter]::ToUInt32($raw,$footer+16)
    $oldSize = [BitConverter]::ToUInt32($raw,$footer+12)
    $localInsert = 30+[BitConverter]::ToUInt16($raw,26)
    $extra = [byte[]]@(13,0,0,0)
    $first = [byte[]]($raw[0..($localInsert-1)] + $extra + $raw[$localInsert..($raw.Length-1)])
    $central = $oldCentral+4
    $centralInsert = $central+46+[BitConverter]::ToUInt16($first,$central+28)
    $updated = [byte[]]($first[0..($centralInsert-1)] + $extra + $first[$centralInsert..($first.Length-1)])
    [BitConverter]::GetBytes([uint16]4).CopyTo($updated,28)
    [BitConverter]::GetBytes([uint16]4).CopyTo($updated,$central+30)
    [BitConverter]::GetBytes([uint32]($oldSize+4)).CopyTo($updated,$updated.Length-10)
    [BitConverter]::GetBytes([uint32]$central).CopyTo($updated,$updated.Length-6)
    [IO.File]::WriteAllBytes($Fixture.Archive,$updated)
}

try {
    Check-ArchiveTest 'Unicode and spaces extract with verified bytes' {
        $f = New-ArchiveFixture @(@{Name='hello world/สี.txt';Text='synthetic content'})
        Invoke-ArchiveFixture $f | Out-Null
        Assert-ArchiveTest ([IO.File]::ReadAllText((Join-Path $f.Destination 'hello world/สี.txt')) -ceq 'synthetic content')
    }
    Check-ArchiveTest 'unsafe final entry prevents all extraction writes' {
        $f = New-ArchiveFixture @(@{Name='safe.txt';Text='safe'},@{Name='../outside.txt';Text='bad'})
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'case duplicate ZIP entries fail despite unique inventory' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'},@{Name='APP';Text='same'})
        Write-ArchiveInventory $f @($f.Files[0])
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'missing or extra payload file fails before writing' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'},@{Name='extra';Text='extra'})
        Write-ArchiveInventory $f @($f.Files[0])
        Reject-ArchiveFixture $f
        $g = New-ArchiveFixture @(@{Name='app';Text='same'})
        Write-ArchiveInventory $g @($g.Files[0],@{path='missing';bytes=0;sha256=('a'*64)})
        Reject-ArchiveFixture $g
    }
    Check-ArchiveTest 'declared content size mismatch fails before writing' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        $f.Files[0].bytes = 99
        Write-ArchiveInventory $f $f.Files
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'inventory must be an array rather than a single file object' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        [IO.File]::WriteAllText($f.Inventory,($f.Files[0] | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'Unix symlink metadata is rejected before writing' {
        $f = New-ArchiveFixture @(@{Name='link';Text='outside';Attributes=-1577123840})
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'Unix link extra metadata is rejected before writing' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        Add-UnixArchiveExtra $f
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'local and central declared lengths must agree before writing' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        $raw = [IO.File]::ReadAllBytes($f.Archive)
        $central = [BitConverter]::ToUInt32($raw,$raw.Length-6)
        [BitConverter]::GetBytes([uint32]1).CopyTo($raw,$central+24)
        [IO.File]::WriteAllBytes($f.Archive,$raw)
        $f.Files[0].bytes = 1
        Write-ArchiveInventory $f $f.Files
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'junction destination cannot modify an outside sentinel' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        $outside = Join-Path $testRoot ('outside-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($outside)
        $sentinel = Join-Path $outside 'sentinel'
        [IO.File]::WriteAllText($sentinel,'synthetic sentinel')
        $link = Join-Path $f.Root 'escape'
        [void](New-Item -ItemType Junction -Path $link -Target $outside)
        try {
            $f.Destination = Join-Path $link 'payload'
            Reject-ArchiveFixture $f
            Assert-ArchiveTest ([IO.File]::ReadAllText($sentinel) -ceq 'synthetic sentinel')
        } finally { [IO.Directory]::Delete($link) }
    }
    Check-ArchiveTest 'reserved device and sidecar names are rejected' {
        foreach ($name in @('CON.txt','bin/COM1','bin/file:stream','bin/trailing.','release.json')) {
            $f = New-ArchiveFixture @(@{Name=$name;Text='same'})
            Reject-ArchiveFixture $f
        }
    }
    Check-ArchiveTest 'archive comments cannot add unreviewed metadata' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        $bytes = [IO.File]::ReadAllBytes($f.Archive)
        $bytes[$bytes.Length-2] = 1
        [IO.File]::WriteAllBytes($f.Archive,([byte[]]($bytes + [byte]65)))
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'compressed archive size ceiling rejects without allocation' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        $stream = [IO.File]::Open($f.Archive,[IO.FileMode]::Open,[IO.FileAccess]::Write)
        try { $stream.SetLength(268435457) } finally { $stream.Dispose() }
        Reject-ArchiveFixture $f
    }
    Check-ArchiveTest 'unexpected expanded hash cannot report success' {
        $f = New-ArchiveFixture @(@{Name='app';Text='same'})
        $f.Files[0].sha256 = 'a'*64
        Write-ArchiveInventory $f $f.Files
        $rejected = $false
        try { Invoke-ArchiveFixture $f | Out-Null } catch { if ($_.Exception.Message -cne 'ARCHIVE_REJECTED') { throw }; $rejected = $true }
        Assert-ArchiveTest $rejected
    }
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^codexs-archive-test-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup' }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
}
Write-Output ("Archive assertions: $passed passed; $($failures.Count) failed")
if ($failures.Count) { throw ($failures -join "`n") }
$global:LASTEXITCODE = 0
