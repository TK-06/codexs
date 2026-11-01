[CmdletBinding()]
param([string]$Archive,[string]$Destination,[string]$Inventory,[string]$AllowedRoot)

function Assert-ArchiveOwnedPath([string]$Root,[string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Candidate)) { throw 'ARCHIVE_REJECTED' }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Candidate)
    if ($base -eq [IO.Path]::GetPathRoot($base).TrimEnd('\') -or -not $full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'ARCHIVE_REJECTED' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ARCHIVE_REJECTED' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($cursor -eq $parent) { break }
        $cursor = $parent
    }
    return $full
}

function Assert-ArchiveName($Name) {
    if ($Name -isnot [string] -or -not $Name -or $Name.Length -gt 1024 -or $Name -match '[\x00-\x1f\x7f<>:"\\|?*]') { throw 'ARCHIVE_REJECTED' }
    for ($index=0; $index -lt $Name.Length; $index++) {
        if ([char]::IsHighSurrogate($Name[$index])) {
            if ($index+1 -ge $Name.Length -or -not [char]::IsLowSurrogate($Name[$index+1])) { throw 'ARCHIVE_REJECTED' }
            $index++
        } elseif ([char]::IsLowSurrogate($Name[$index])) { throw 'ARCHIVE_REJECTED' }
    }
    foreach ($part in $Name.Split('/')) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[ .]$' -or $part -match '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)') { throw 'ARCHIVE_REJECTED' }
    }
    if ($Name.ToLowerInvariant() -in @('release.json','release.sig','codexs-windows-x64.zip')) { throw 'ARCHIVE_REJECTED' }
}

function Test-ArchiveInteger($Value) {
    return (($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and
        -not [double]::IsNaN([double]$Value) -and -not [double]::IsInfinity([double]$Value) -and
        [double]$Value -ge 0 -and [double]$Value -le 2147483648 -and [math]::Truncate([double]$Value) -eq [double]$Value)
}

function Read-ArchiveLayout([IO.Stream]$Stream) {
    if ($Stream.Length -lt 22 -or $Stream.Length -gt 268435456) { throw 'ARCHIVE_REJECTED' }
    $reader = [IO.BinaryReader]::new($Stream,[Text.Encoding]::UTF8,$true)
    try {
        $Stream.Position = $Stream.Length-22
        $footer = $reader.ReadBytes(22)
        if ([BitConverter]::ToUInt32($footer,0) -ne 0x06054b50 -or [BitConverter]::ToUInt16($footer,4) -ne 0 -or
            [BitConverter]::ToUInt16($footer,6) -ne 0 -or [BitConverter]::ToUInt16($footer,20) -ne 0) { throw 'ARCHIVE_REJECTED' }
        $count = [BitConverter]::ToUInt16($footer,10)
        $size = [long][BitConverter]::ToUInt32($footer,12)
        $offset = [long][BitConverter]::ToUInt32($footer,16)
        if ($count -lt 1 -or $count -gt 10000 -or $count -ne [BitConverter]::ToUInt16($footer,8) -or $offset+$size -ne $Stream.Length-22) { throw 'ARCHIVE_REJECTED' }
        $Stream.Position = $offset
        for ($index=0; $index -lt $count; $index++) {
            $header = $reader.ReadBytes(46)
            if ($header.Length -ne 46 -or [BitConverter]::ToUInt32($header,0) -ne 0x02014b50) { throw 'ARCHIVE_REJECTED' }
            $flags = [BitConverter]::ToUInt16($header,8)
            $method = [BitConverter]::ToUInt16($header,10)
            $compressed = [long][BitConverter]::ToUInt32($header,20)
            $expanded = [long][BitConverter]::ToUInt32($header,24)
            $nameLength = [BitConverter]::ToUInt16($header,28)
            $attributes = [BitConverter]::ToInt32($header,38)
            $localOffset = [long][BitConverter]::ToUInt32($header,42)
            # Release ZIP v1 deliberately excludes extra fields/comments, including Unix hardlink metadata.
            if (($flags -band (-bnot 0x080e)) -ne 0 -or $method -notin @(0,8) -or $expanded -gt 2147483648 -or
                $nameLength -eq 0 -or [BitConverter]::ToUInt16($header,30) -ne 0 -or [BitConverter]::ToUInt16($header,32) -ne 0 -or
                [BitConverter]::ToUInt16($header,34) -ne 0 -or (($attributes -shr 16) -band 0xf000) -notin @(0,0x4000,0x8000) -or
                ($attributes -band 0x400) -ne 0) { throw 'ARCHIVE_REJECTED' }
            $name = $reader.ReadBytes($nameLength)
            $next = $Stream.Position
            if ($name.Length -ne $nameLength -or $next -gt $offset+$size -or $localOffset+30 -gt $offset) { throw 'ARCHIVE_REJECTED' }
            $Stream.Position = $localOffset
            $local = $reader.ReadBytes(30)
            if ($local.Length -ne 30 -or [BitConverter]::ToUInt32($local,0) -ne 0x04034b50 -or
                [BitConverter]::ToUInt16($local,6) -ne $flags -or [BitConverter]::ToUInt16($local,8) -ne $method -or
                [BitConverter]::ToUInt16($local,26) -ne $nameLength -or [BitConverter]::ToUInt16($local,28) -ne 0 -or
                $localOffset+30+$nameLength+$compressed -gt $offset) { throw 'ARCHIVE_REJECTED' }
            $localCompressed = [long][BitConverter]::ToUInt32($local,18)
            $localExpanded = [long][BitConverter]::ToUInt32($local,22)
            $localCrc = [BitConverter]::ToUInt32($local,14)
            $centralCrc = [BitConverter]::ToUInt32($header,16)
            if (($flags -band 8) -eq 0) {
                if ($localCompressed -ne $compressed -or $localExpanded -ne $expanded -or $localCrc -ne $centralCrc) { throw 'ARCHIVE_REJECTED' }
            } elseif ($localCompressed -notin @(0,$compressed) -or $localExpanded -notin @(0,$expanded) -or $localCrc -notin @(0,$centralCrc)) { throw 'ARCHIVE_REJECTED' }
            $localName = $reader.ReadBytes($nameLength)
            if ([Convert]::ToBase64String($name) -cne [Convert]::ToBase64String($localName)) { throw 'ARCHIVE_REJECTED' }
            $Stream.Position = $next
        }
        if ($Stream.Position -ne $offset+$size) { throw 'ARCHIVE_REJECTED' }
    } finally { $reader.Dispose() }
}

function Invoke-CodexsExtract([string]$ZipPath,[string]$OutputPath,[string]$InventoryPath,[string]$Root) {
    Add-Type -AssemblyName System.IO.Compression
    $zipFile = Assert-ArchiveOwnedPath $Root $ZipPath
    $outputRoot = Assert-ArchiveOwnedPath $Root $OutputPath
    $inventoryFile = Assert-ArchiveOwnedPath $Root $InventoryPath
    if ((Test-Path -LiteralPath $outputRoot) -or (Get-Item -LiteralPath $inventoryFile).Length -gt 4194304) { throw 'ARCHIVE_REJECTED' }
    $parsed = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($inventoryFile))
    if ($parsed -isnot [array]) { throw 'ARCHIVE_REJECTED' }
    $files = @($parsed)
    if ($files.Count -lt 1 -or $files.Count -gt 10000) { throw 'ARCHIVE_REJECTED' }
    $expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $parents = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    foreach ($file in $files) {
        if ((@($file.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'bytes,path,sha256') { throw 'ARCHIVE_REJECTED' }
        Assert-ArchiveName $file.path
        if (-not (Test-ArchiveInteger $file.bytes) -or $file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'ARCHIVE_REJECTED' }
        $name = $file.path.Normalize([Text.NormalizationForm]::FormC)
        if ($expected.ContainsKey($name)) { throw 'ARCHIVE_REJECTED' }
        $expected.Add($name,$file)
        $parts = $name.Split('/')
        for ($i=1; $i -lt $parts.Length; $i++) { [void]$parents.Add(($parts[0..($i-1)] -join '/')) }
        $total += [long]$file.bytes
        if ($total -gt 2147483648) { throw 'ARCHIVE_REJECTED' }
    }
    foreach ($name in $expected.Keys) { if ($parents.Contains($name)) { throw 'ARCHIVE_REJECTED' } }
    $stream = [IO.File]::Open($zipFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $zip = $null
    try {
        Read-ArchiveLayout $stream
        $stream.Position = 0
        $zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$true)
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $seenFiles = 0
        foreach ($entry in $zip.Entries) {
            $directory = $entry.FullName.EndsWith('/')
            $name = $entry.FullName.TrimEnd('/')
            Assert-ArchiveName $name
            $canonicalName = $name.Normalize([Text.NormalizationForm]::FormC)
            if (-not $seen.Add($canonicalName)) { throw 'ARCHIVE_REJECTED' }
            if ($directory) {
                if ($entry.Length -ne 0 -or -not $parents.Contains($canonicalName)) { throw 'ARCHIVE_REJECTED' }
            } else {
                if (-not $expected.ContainsKey($canonicalName) -or $expected[$canonicalName].path -cne $entry.FullName -or $entry.Length -ne $expected[$canonicalName].bytes) { throw 'ARCHIVE_REJECTED' }
                $seenFiles++
            }
            [void](Assert-ArchiveOwnedPath $Root (Join-Path $outputRoot $name.Replace('/','\')))
        }
        if ($seenFiles -ne $expected.Count) { throw 'ARCHIVE_REJECTED' }
        [void][IO.Directory]::CreateDirectory($outputRoot)
        $actualTotal = [long]0
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $target = Assert-ArchiveOwnedPath $Root (Join-Path $outputRoot $entry.FullName.Replace('/','\'))
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            [void](Assert-ArchiveOwnedPath $Root $target)
            $inputStream = $entry.Open()
            $outputStream = $null
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $outputStream = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                $buffer = New-Object byte[] 65536
                $actual = [long]0
                while (($read = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
                    $actual += $read; $actualTotal += $read
                    if ($actual -gt $entry.Length -or $actualTotal -gt 2147483648) { throw 'ARCHIVE_REJECTED' }
                    [void]$sha.TransformBlock($buffer,0,$read,$buffer,0)
                    $outputStream.Write($buffer,0,$read)
                }
                [void]$sha.TransformFinalBlock([byte[]]@(),0,0)
                $digest = ([BitConverter]::ToString($sha.Hash)).Replace('-','').ToLowerInvariant()
                if ($actual -ne $entry.Length -or $digest -cne $expected[$entry.FullName.Normalize([Text.NormalizationForm]::FormC)].sha256) { throw 'ARCHIVE_REJECTED' }
                $outputStream.Flush($true)
            } finally { if ($outputStream) { $outputStream.Dispose() }; $inputStream.Dispose(); $sha.Dispose() }
        }
        return [pscustomobject]@{files=$files;bytes=$actualTotal}
    } finally { if ($zip) { $zip.Dispose() }; $stream.Dispose() }
}

if ($Archive) {
    $ErrorActionPreference = 'Stop'
    try { Invoke-CodexsExtract $Archive $Destination $Inventory $AllowedRoot | ConvertTo-Json -Depth 6 -Compress }
    catch { throw 'ARCHIVE_REJECTED' }
}
