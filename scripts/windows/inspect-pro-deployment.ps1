#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][int]$OwnerPid)
$ErrorActionPreference = 'Stop'; $env:PSModulePath = Join-Path $PSHOME 'Modules'
$directoryPath = [IO.Path]::GetFullPath($Directory)
if ([IO.Path]::GetFileName($directoryPath) -notmatch '^pro-host-[a-f0-9-]{36}$') { throw 'Dedicated Pro fixture required' }
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard = [MuPacketLabGuard]::new($OwnerPid, $directoryPath)
$mounted = $false
try {
    $c = $guard.ReadCommand('config.json') | ConvertFrom-Json
    if ($c.flavor -ne 'pro26300' -or $c.name -notmatch '^mu-win-pro-[a-f0-9]{32}$') { throw 'Pro identity changed' }
    $storage = $guard.ReopenArtifacts()
    $diskFile = Join-Path $storage 'windows.vhdx'
    $vhd = Get-VHD -Path $diskFile
    if ($vhd.ParentPath -or $vhd.Size -ne 160GB -or $vhd.Attached) { throw 'Stopped standalone Pro disk required for inspection' }
    $references = @(Get-VM | Get-VMHardDiskDrive | Where-Object { [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($diskFile) })
    if ($references.Count -or (Test-Path -LiteralPath (Join-Path $directoryPath 'machine.json'))) { throw 'Only the pre-VM Pro deployment can be inspected here' }
    $activeMounts = @(Get-WindowsImage -Mounted | Where-Object { $_.Path.StartsWith($storage + '\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object Path,ImagePath,ImageIndex,MountStatus)
    $attached = Mount-VHD -Path $diskFile -ReadOnly -PassThru
    $mounted = $true
    $disk = Get-Disk -Number $attached.DiskNumber
    if ($disk.IsBoot -or $disk.IsSystem -or $disk.Size -ne 160GB -or [IO.Path]::GetFullPath((Get-VHD -DiskNumber $disk.Number).Path) -ne [IO.Path]::GetFullPath($diskFile)) { throw 'Pro inspection disk boundary changed' }
    $parts = @(Get-Partition -DiskNumber $disk.Number | Select-Object PartitionNumber,GptType,Size,DriveLetter)
    $efi = @($parts | Where-Object GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}')
    if ($efi.Count -ne 1 -or $efi[0].Size -ne 260MB) { throw 'Known Pro EFI layout missing' }
    $result = @{ complete = $true; scope = 'read-only-failed-pro-deployment-inspection'; nonce = $c.nonce; vmRegistered = $false; disk = $diskFile; diskIdentifier = [string]$vhd.DiskIdentifier; diskSize = $vhd.Size; efiPartition = $efi[0].PartitionNumber; partitions = $parts; activeOwnWimMounts = $activeMounts; wimMountDriver = @(Get-CimInstance Win32_SystemDriver -Filter "Name='WIMMount'" | Select-Object Name,State,ExitCode); hostBootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o') }
    [IO.File]::WriteAllText($guard.Reserve('deployment-inspection-' + [guid]::NewGuid().ToString('N') + '.json'), ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
} finally { if ($mounted) { Dismount-VHD -Path $diskFile }; $guard.Dispose() }
