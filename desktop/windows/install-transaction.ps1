# Runs as the installing user. Only application files and this application's
# registry keys belong to the transaction; user profiles and VM disks do not.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry64')
$guid = [string]$env:MU_WINDOWS_APP_GUID
if ($guid -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { exit 6 }
$keys = @("Software\$guid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
$locatorKey = "Software\MuCodeSandbox\WindowsPreviewInstaller\$guid"
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Local-Root([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Missing application directory' }
    $full = [IO.Path]::GetFullPath($value).TrimEnd('\')
    if ($full -notmatch '^[a-zA-Z]:\\' -or $full.Length -le 3) { throw 'Local application directory required' }
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -ne 'Fixed') { throw 'Fixed local application volume required' }
    $cursor = [IO.Path]::GetPathRoot($full)
    foreach ($part in $full.Substring($cursor.Length).Split('\')) {
        if ($part -eq '' -or $part.TrimEnd(' ', '.') -ne $part -or $part.Contains(':')) { throw 'Ambiguous application path' }
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point preserved' }
        }
    }
    return $full
}
function Json-File([string]$file) {
    $null = Local-Root $file
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 131072) { throw 'Invalid transaction record' }
    return [IO.File]::ReadAllText($file) | ConvertFrom-Json
}
function Durable-Json([string]$file, $value) {
    $null = Local-Root $file
    $temporary = $file + '.new-' + [Guid]::NewGuid().ToString('N')
    $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 12 -Compress))
    if ($bytes.Length -gt 131072) { throw 'Transaction record exceeds its readable bound' }
    $stream = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $file) }
}
function Registry-Snapshot([string]$key) {
    $opened = $hive.OpenSubKey($key)
    if (-not $opened) { return @{ exists = $false; values = @() } }
    try {
        if ($opened.SubKeyCount -or $opened.ValueCount -gt 64) { throw 'Unexpected application registry data preserved' }
        $values = @(foreach ($name in $opened.GetValueNames()) {
            $kind = $opened.GetValueKind($name).ToString()
            if ($kind -notin @('String', 'DWord')) { throw 'Unexpected registry value preserved' }
            $value = $opened.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
            if ($name.Length -gt 256 -or ([string]$value).Length -gt 8192) { throw 'Registry value too large' }
            @{ name = $name; kind = $kind; value = $value }
        })
        return @{ exists = $true; values = $values }
    } finally { $opened.Dispose() }
}
function Restore-Registry($snapshots) {
    for ($index = 0; $index -lt 2; $index++) {
        $null = Registry-Snapshot $keys[$index]
        $hive.DeleteSubKey($keys[$index], $false)
        if ($snapshots[$index].exists) {
            $opened = $hive.CreateSubKey($keys[$index])
            try {
                foreach ($value in $snapshots[$index].values) {
                    if ($value.kind -eq 'DWord') { $opened.SetValue($value.name, [int]$value.value, 'DWord') }
                    else { $opened.SetValue($value.name, [string]$value.value, 'String') }
                }
                $opened.Flush()
            } finally { $opened.Dispose() }
        }
    }
}
function Registered-Root {
    $opened = $hive.OpenSubKey($keys[0])
    if (-not $opened) { return '' }
    try { return [string]$opened.GetValue('InstallLocation', '') } finally { $opened.Dispose() }
}
function Assert-Closed($roots) {
    foreach ($process in @(Get-CimInstance Win32_Process)) {
        if (-not $process.ExecutablePath) { continue }
        foreach ($root in $roots) {
            if ($process.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Application directory is still in use' }
        }
    }
}
function Process-Identity([int]$id) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $process) { return @{ id = $id; ticks = '0' } }
    return @{ id = $id; ticks = $process.StartTime.ToUniversalTime().Ticks.ToString() }
}
function Is-Alive($identity) {
    $actual = Process-Identity ([int]$identity.id)
    return $actual.ticks -ne '0' -and $actual.ticks -eq [string]$identity.ticks
}
function Tree([string]$root) {
    $null = Local-Root $root
    if (-not [IO.Directory]::Exists($root)) { throw 'Application directory missing' }
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($root)
    $lines = New-Object 'Collections.Generic.List[string]'
    [long]$bytes = 0
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $attributes = [IO.File]::GetAttributes($entry)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Application link preserved' }
            $relative = $entry.Substring($root.Length + 1)
            if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($entry); $lines.Add('D:' + $relative) }
            else {
                $stream = [IO.File]::Open($entry, 'Open', 'Read', 'Read')
                $hasher = [Security.Cryptography.SHA256]::Create()
                try {
                    $bytes += $stream.Length
                    if ($bytes -gt 8GB) { throw 'Application backup exceeds its bounded scope' }
                    $digest = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
                    $lines.Add('F:' + $relative + ':' + $stream.Length + ':' + $digest)
                } finally { $hasher.Dispose(); $stream.Dispose() }
            }
            if ($lines.Count -gt 30000 -or $bytes -gt 8GB) { throw 'Application backup exceeds its bounded scope' }
        }
    }
    $array = $lines.ToArray()
    [Array]::Sort($array, [StringComparer]::Ordinal)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($array -join [char]10)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Copy-Tree([string]$source, [string]$destination) {
    $null = Local-Root $source; $null = Local-Root $destination
    if (Test-Path -LiteralPath $destination) { throw 'Backup already exists; preserved' }
    $null = [IO.Directory]::CreateDirectory($destination)
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($source)
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $attributes = [IO.File]::GetAttributes($entry)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Application link preserved' }
            $target = Join-Path $destination $entry.Substring($source.Length + 1)
            if ($attributes -band [IO.FileAttributes]::Directory) { $null = [IO.Directory]::CreateDirectory($target); $pending.Push($entry) }
            else {
                $input = [IO.File]::Open($entry, 'Open', 'Read', 'Read')
                $output = [IO.File]::Open($target, 'CreateNew', 'Write', 'None')
                try { $input.CopyTo($output); $output.Flush($true) } finally { $input.Dispose(); $output.Dispose() }
            }
        }
    }
}
function Recognized-App([string]$root) {
    $package = Json-File (Join-Path $root 'resources\app\package.json')
    $manifest = Json-File (Join-Path $root 'resources\windows-runtime-manifest.json')
    if ($package.name -ne 'mucodesandbox-windows-preview' -or $manifest.format -ne 1 -or $manifest.channel -ne 'unsigned-windows-preview' -or -not [IO.File]::Exists((Join-Path $root 'MuCodeSandbox Windows Preview.exe'))) { throw 'Unrecognized application preserved' }
    return [string]$package.version
}
function Quarantine([string]$root, [string]$nonce) {
    $null = Local-Root $root
    if (-not (Test-Path -LiteralPath $root)) { return }
    $target = Local-Root ($root + '.mu-incomplete-' + $nonce)
    if (Test-Path -LiteralPath $target) { throw 'Previous incomplete files preserved; review required' }
    [IO.Directory]::Move($root, $target)
}
function Clear-Record {
    $null = Local-Root $journalFile
    [IO.File]::Delete($journalFile)
    $hive.DeleteSubKey($locatorKey, $false)
}
function Validate-Record($record) {
    if ($record.format -ne 1 -or $record.sid -ne $sid -or $record.root -ne $selected -or $record.nonce -notmatch '^[a-f0-9]{32}$' -or $record.state -notin @('copying', 'prepared', 'restoring', 'committed') -or @($record.roots).Count -lt 1 -or @($record.roots).Count -gt 2 -or @($record.registry).Count -ne 2) { throw 'Unknown transaction preserved' }
    $seen = @()
    foreach ($entry in $record.roots) {
        $full = Local-Root $entry.path
        if ($full -ne $entry.path -or $full -in $seen -or ($entry.existed -and $entry.digest -notmatch '^[a-f0-9]{64}$')) { throw 'Invalid backup boundary' }
        $seen += $full
        $null = Local-Root ($full + '.mu-backup-' + $record.nonce)
    }
    if ($record.roots[0].path -ne $selected) { throw 'Installation target changed' }
    if ($seen.Count -eq 2 -and ($seen[0].StartsWith($seen[1] + '\', 'OrdinalIgnoreCase') -or $seen[1].StartsWith($seen[0] + '\', 'OrdinalIgnoreCase'))) { throw 'Nested recovery roots rejected' }
    if (@($record.roots).Count -eq 2) {
        $location = @($record.registry[0].values | Where-Object { $_.name -eq 'InstallLocation' })
        if ($location.Count -ne 1 -or $location[0].value -ne $record.roots[1].path) { throw 'Registered backup boundary changed' }
    }
    foreach ($snapshot in $record.registry) {
        if (@($snapshot.values).Count -gt 64) { throw 'Registry snapshot too large' }
        foreach ($value in $snapshot.values) {
            if ($value.name.Length -gt 256 -or ([string]$value.value).Length -gt 8192 -or $value.kind -notin @('String', 'DWord')) { throw 'Invalid registry snapshot' }
        }
    }
}
function Clean-Committed($record) {
    foreach ($entry in $record.roots) {
        $backup = Local-Root ($entry.path + '.mu-backup-' + $record.nonce)
        if (-not (Test-Path -LiteralPath $backup)) { continue }
        # Interrupted cleanup or unexpected contents are retained, never guessed.
        if ((Tree $backup) -eq $entry.digest) { [IO.Directory]::Delete($backup, $true) }
        else { Quarantine $backup $record.nonce }
    }
    Clear-Record
}
try {
    $selected = Local-Root $env:MU_WINDOWS_INSTALL_ROOT
    $journalFile = $selected + '.mu-install.json'
    $locator = $hive.OpenSubKey($locatorKey)
    $pendingRoot = ''
    if ($locator) { try { $pendingRoot = [string]$locator.GetValue('TransactionRoot', '') } finally { $locator.Dispose() } }
    if ($pendingRoot -and $pendingRoot -ne $selected) { throw 'Finish the pending installation at its original directory first' }
    $action = [string]$env:MU_WINDOWS_TRANSACTION_ACTION
    if ($action -eq 'recover') {
        if (-not [IO.File]::Exists($journalFile)) {
            if ($pendingRoot) { $hive.DeleteSubKey($locatorKey, $false) }
            exit 0
        }
        $record = Json-File $journalFile
        Validate-Record $record
        if ((Is-Alive $record.owner) -or (Is-Alive $record.writer)) { throw 'Another installation is still active' }
        Assert-Closed @($record.roots | ForEach-Object { $_.path; $_.path + '.mu-backup-' + $record.nonce })
        if ($record.state -eq 'committed') { Clean-Committed $record; exit 0 }
        # Verify ALL required copies before changing either application root.
        foreach ($entry in $record.roots) {
            $backup = $entry.path + '.mu-backup-' + $record.nonce
            if ($entry.existed -and (-not [IO.Directory]::Exists($entry.path) -or (Tree $entry.path) -ne $entry.digest)) {
                if ($record.state -eq 'copying' -or -not [IO.Directory]::Exists($backup) -or (Tree $backup) -ne $entry.digest) { throw 'Recovery backup incomplete or changed; all files preserved' }
            }
        }
        $record.state = 'restoring'; Durable-Json $journalFile $record
        foreach ($entry in $record.roots) {
            $backup = Local-Root ($entry.path + '.mu-backup-' + $record.nonce)
            if ($entry.existed) {
                if ([IO.Directory]::Exists($entry.path) -and (Tree $entry.path) -eq $entry.digest) {
                    if (Test-Path -LiteralPath $backup) {
                        if ((Tree $backup) -eq $entry.digest) { [IO.Directory]::Delete($backup, $true) }
                        else { Quarantine $backup $record.nonce }
                    }
                } else {
                    Quarantine $entry.path $record.nonce
                    [IO.Directory]::Move($backup, $entry.path)
                }
            } else { Quarantine $entry.path $record.nonce }
        }
        Restore-Registry $record.registry
        Clear-Record
        [Console]::WriteLine('Previous installation restored; incomplete files retained separately')
        exit 0
    }
    if ($action -eq 'prepare') {
        if (Test-Path -LiteralPath $journalFile) { throw 'A previous transaction requires recovery' }
        $registered = Registered-Root
        $paths = @($selected)
        if ($registered) { $registered = Local-Root $registered; if ($registered -ne $selected) { $paths += $registered } }
        if ($paths.Count -eq 2 -and ($paths[0].StartsWith($paths[1] + '\', 'OrdinalIgnoreCase') -or $paths[1].StartsWith($paths[0] + '\', 'OrdinalIgnoreCase'))) { throw 'Nested application roots rejected' }
        Assert-Closed $paths
        $snapshots = @(Registry-Snapshot $keys[0]; Registry-Snapshot $keys[1])
        $roots = @(foreach ($root in $paths) {
            $exists = [IO.Directory]::Exists($root)
            if ($exists -and @(Get-ChildItem -LiteralPath $root -Force).Count) { $null = Recognized-App $root }
            elseif ($exists) { $exists = $false }
            $digest = ''; if ($exists) { $digest = Tree $root }
            @{ path = $root; existed = $exists; digest = $digest }
        })
        $owner = Process-Identity ([int]$env:MU_WINDOWS_INSTALL_PID)
        if ($owner.ticks -eq '0') { throw 'Installer process no longer exists' }
        $record = @{ format = 1; sid = $sid; root = $selected; nonce = [Guid]::NewGuid().ToString('N'); state = 'copying'; owner = $owner; writer = (Process-Identity $PID); roots = $roots; registry = $snapshots }
        Durable-Json $journalFile $record
        $locator = $hive.CreateSubKey($locatorKey)
        try { $locator.SetValue('TransactionRoot', $selected, 'String'); $locator.Flush() } finally { $locator.Dispose() }
        foreach ($entry in $roots) {
            if (-not $entry.existed) { continue }
            $backup = $entry.path + '.mu-backup-' + $record.nonce
            Copy-Tree $entry.path $backup
            if ((Tree $backup) -ne $entry.digest -or (Tree $entry.path) -ne $entry.digest) { throw 'Backup verification failed; original preserved' }
        }
        Assert-Closed $paths
        $record.state = 'prepared'; Durable-Json $journalFile $record
        exit 0
    }
    if ($action -eq 'commit') {
        $record = Json-File $journalFile; Validate-Record $record
        if ($record.state -ne 'prepared' -or [int]$record.owner.id -ne [int]$env:MU_WINDOWS_INSTALL_PID -or -not (Is-Alive $record.owner)) { throw 'Installer transaction owner changed' }
        if ((Recognized-App $selected) -ne $env:MU_WINDOWS_INSTALL_VERSION -or (Registered-Root) -ne $selected) { throw 'Installed release or registration changed' }
        $manifest = Json-File (Join-Path $selected 'resources\windows-runtime-manifest.json')
        $release = Json-File (Join-Path $selected 'resources\app\dist-server\windows-release.json')
        if ($manifest.release.version -ne $env:MU_WINDOWS_INSTALL_VERSION -or $release.version -ne $env:MU_WINDOWS_INSTALL_VERSION -or $manifest.release.fileVersion -ne $release.fileVersion) { throw 'Installed release records disagree' }
        $record.state = 'committed'; Durable-Json $journalFile $record
        Clean-Committed $record
        exit 0
    }
    throw 'Unknown installer transaction action'
} catch {
    [Console]::Error.WriteLine('Windows Preview installation recovery could not be verified. Application backups and user data were preserved. ' + $_.Exception.Message)
    exit 6
} finally { $hive.Dispose() }
