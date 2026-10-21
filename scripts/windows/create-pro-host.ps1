#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)][int]$OwnerPid)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
# Keep PowerShell 7 module paths out of this Windows PowerShell deployment.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$configFile = [IO.Path]::GetFullPath($ConfigPath)
$directory = [IO.Path]::GetDirectoryName($configFile)
if ([IO.Path]::GetFileName($configFile) -ne 'config.json' -or [IO.Path]::GetFileName($directory) -notmatch '^pro-host-[a-f0-9-]{36}$') { throw 'Dedicated Pro diagnostic fixture required' }
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard = [MuPacketLabGuard]::new($OwnerPid, $directory)
$c = $guard.ReadCommand('config.json') | ConvertFrom-Json
if ($c.format -ne 1 -or $c.flavor -ne 'pro26300' -or $c.ownerPid -ne $OwnerPid -or $c.name -notmatch '^mu-win-pro-[a-f0-9]{32}$' -or $c.nonce -notmatch '^[a-f0-9]{64}$' -or $c.imageSha256 -ne 'b795b52d598bf8fdea5975844731f4a50c5713876cefc513884354272b023af0' -or $c.imageIndex -ne 4 -or $c.virtualSizeGiB -ne 160 -or $c.edition -ne 'Professional') { throw 'Fixed Pro deployment identity required' }
$iso = $null; $mounted = $false; $diskFile = $null
$state = $guard.Reserve('state.json')
function Save-ProState([string]$phase, [string]$status = 'running', $details = $null) {
    [IO.File]::WriteAllText($state, (@{ phase = $phase; status = $status; name = $c.name; time = [DateTime]::UtcNow.ToString('o'); details = $details } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
function Assert-DiagnosticDisk {
    $actual = Get-VHD -DiskNumber $disk.Number -ErrorAction Stop
    $device = Get-Disk -Number $disk.Number -ErrorAction Stop
    if ([IO.Path]::GetFullPath($actual.Path) -ne [IO.Path]::GetFullPath($diskFile) -or $device.IsBoot -or $device.IsSystem -or $device.Size -ne 160GB -or $actual.ParentPath) { throw 'Refusing any disk outside the fresh Pro VHDX' }
}
try {
    Save-ProState 'checking-inputs'
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $image = [IO.Path]::GetFullPath([string]$c.image)
    if ($image -ne (Join-Path $repo '.mu-data/windows-pro-assets/windows11-client-x64-zh-cn-26300.9457.iso')) { throw 'Fixed verified Pro ISO required' }
    $guard.PinInputFile($image)
    if ((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $c.imageSha256) { throw 'Pro ISO changed' }
    if (@(Get-VM | Where-Object Name -eq $c.name).Count -or (Test-Path -LiteralPath (Join-Path $directory 'machine.json'))) { throw 'Existing Pro VM must be inspected' }
    if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($directory)).AvailableFreeSpace -lt 192GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB -lt 14GB) { throw 'Insufficient bounded Pro fixture disk or memory capacity' }
    $storage = $guard.CreateArtifacts()
    $diskFile = Join-Path $storage 'windows.vhdx'
    $iso = Mount-DiskImage -ImagePath $image -Access ReadOnly -PassThru
    $volume = $iso | Get-Volume
    if (-not $volume.DriveLetter) { throw 'Pro ISO read-only volume missing' }
    $media = ([string]$volume.DriveLetter) + ':\'
    $signatures = @(foreach ($relative in @('setup.exe', 'sources/setuphost.exe')) {
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $media $relative)
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') { throw 'Microsoft setup signature rejected' }
        @{ file = $relative; status = [string]$signature.Status; thumbprint = $signature.SignerCertificate.Thumbprint }
    })
    [IO.File]::WriteAllText($guard.Reserve('media-auth.json'), ($signatures | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $wim = Join-Path $media 'sources/install.wim'
    $pro = Get-WindowsImage -ImagePath $wim -Index 4
    if ($pro.EditionId -ne 'Professional' -or $pro.Architecture -ne 9 -or [string]$pro.Version -notlike '10.0.26300.*') { throw 'Expected the actual Pro WIM image' }
    Save-ProState 'creating-new-pro-vhd'
    New-VHD -Path $diskFile -SizeBytes 160GB -Dynamic | Out-Null
    $attached = Mount-VHD -Path $diskFile -PassThru; $mounted = $true
    $disk = Get-Disk -Number $attached.DiskNumber
    Assert-DiagnosticDisk
    if ($disk.PartitionStyle -ne 'RAW') { throw 'Fresh raw Pro VHDX required' }
    Initialize-Disk -InputObject $disk -PartitionStyle GPT | Out-Null
    Assert-DiagnosticDisk
    $efi = New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -AssignDriveLetter
    $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel MU-PRO-EFI -Confirm:$false -Force | Out-Null
    Assert-DiagnosticDisk
    New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' | Out-Null
    $windows = New-Partition -DiskNumber $disk.Number -UseMaximumSize -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' -AssignDriveLetter
    $windows | Format-Volume -FileSystem NTFS -NewFileSystemLabel MU-PRO-WINDOWS -Confirm:$false -Force | Out-Null
    Assert-DiagnosticDisk
    $windowsRoot = ([string]$windows.DriveLetter) + ':\'
    Save-ProState 'applying-windows-pro-image'
    & (Join-Path $env:SystemRoot 'System32/dism.exe') /Apply-Image /ImageFile:$wim /Index:4 /ApplyDir:$windowsRoot /CheckIntegrity /Quiet
    if ($LASTEXITCODE -ne 0) { throw 'Pro image application failed' }
    Assert-DiagnosticDisk
    $lab = Join-Path $windowsRoot 'MuLab'
    $null = New-Item -ItemType Directory -Path $lab
    $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false)
    foreach ($value in @('S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.Directory]::SetAccessControl($lab, $acl)
    $privateAcl = [Security.AccessControl.DirectorySecurity]::new(); $privateAcl.SetAccessRuleProtection($true, $false)
    foreach ($value in @('S-1-5-18', 'S-1-5-32-544')) { $privateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
    $privateDirectory = Join-Path $lab 'private'
    New-Item -ItemType Directory -Path $privateDirectory | Out-Null
    [IO.Directory]::SetAccessControl($privateDirectory, $privateAcl)
    Save-ProState 'copying-ordinary-user-seed'
    $guard.CopyGuestSeed($lab)
    foreach ($entry in $c.stagedHashes.psobject.Properties) {
        if ((Get-FileHash -LiteralPath (Join-Path $lab $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Staged Pro payload changed during copy' }
    }
    [IO.Directory]::SetAccessControl((Join-Path $lab 'private'), $privateAcl)
    $panther = Join-Path $windowsRoot 'Windows/Panther/Unattend'
    New-Item -ItemType Directory -Path $panther -Force | Out-Null
    [IO.Directory]::SetAccessControl($panther, $privateAcl)
    $answer = $guard.ReadCommand('unattend.xml')
    $answerBytes = [Text.Encoding]::UTF8.GetBytes($answer)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $answerHash = [BitConverter]::ToString($sha.ComputeHash($answerBytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($answerHash -ne $c.unattendSha256) { throw 'Pro answer file changed' }
    [IO.File]::WriteAllText((Join-Path $panther 'Unattend.xml'), $answer, [Text.UTF8Encoding]::new($false))
    Dismount-VHD -Path $diskFile; $mounted = $false
    Dismount-DiskImage -ImagePath $image; $iso = $null
    Save-ProState 'pro-image-prepared' 'prepared' @{ hostBcdCommands = 0; hostReboots = 0; vmCreated = $false }
} catch {
    $failure = $_
    try { [IO.File]::WriteAllText($guard.Reserve('failure.log'), ($failure.Exception.ToString() + [Environment]::NewLine + $failure.ScriptStackTrace)); Save-ProState 'failed' 'failed' @{ message = $failure.Exception.Message } } catch {}
    throw $failure
} finally {
    if ($mounted) { Dismount-VHD -Path $diskFile -ErrorAction SilentlyContinue }
    if ($iso) { Dismount-DiskImage -ImagePath $image -ErrorAction SilentlyContinue }
    $guard.Dispose()
}
