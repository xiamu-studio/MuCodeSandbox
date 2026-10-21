#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)][int]$OwnerPid, [switch]$ResumeBoot)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ConfigPath))
if ([IO.Path]::GetFileName($ConfigPath) -ne 'config.json' -or [IO.Path]::GetFileName($directory) -notmatch '^pro-host-[a-f0-9-]{36}$') { throw 'Dedicated Pro fixture required' }
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard = [MuPacketLabGuard]::new($OwnerPid, $directory)
$c = $guard.ReadCommand('config.json') | ConvertFrom-Json
$boot = $guard.ReadCommand('boot-inputs.json') | ConvertFrom-Json
$storage = $guard.ReopenArtifacts(); $diskFile = Join-Path $storage 'windows.vhdx'
$state = $guard.Reserve('start-' + [guid]::NewGuid().ToString('N') + '.json')
$mounted = $false; $vm = $null
function Save-ProStart([string]$phase, [string]$status = 'running', $details = $null) { [IO.File]::WriteAllText($state, (@{ phase = $phase; status = $status; time = [DateTime]::UtcNow.ToString('o'); details = $details } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false)) }
function Assert-ProDisk {
    $actual = Get-VHD -DiskNumber $disk.Number; $device = Get-Disk -Number $disk.Number
    if ([IO.Path]::GetFullPath($actual.Path) -ne [IO.Path]::GetFullPath($diskFile) -or $actual.ParentPath -or $actual.Size -ne 160GB -or $device.IsBoot -or $device.IsSystem -or [string]$actual.DiskIdentifier -ne [string]$boot.diskIdentifier) { throw 'Pro continuation disk identity changed' }
}
function Assert-ProVM {
    $actual = Get-VM -Id $vm.Id
    $disks = @(Get-VMHardDiskDrive -VM $actual)
    if ($actual.Name -ne $c.name -or $actual.Notes -ne ('MuCodeSandbox isolated Pro diagnostic ' + $c.name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne [IO.Path]::GetFullPath($diskFile) -or @(Get-VMNetworkAdapter -VM $actual | Where-Object SwitchName).Count) { throw 'Pro continuation VM boundary changed' }
    return $actual
}
try {
    Save-ProStart 'verifying-existing-pro-deployment'
    if ($c.ownerPid -ne $OwnerPid -or $c.flavor -ne 'pro26300' -or $c.name -notmatch '^mu-win-pro-[a-f0-9]{32}$' -or $boot.format -ne 1 -or $boot.nonce -ne $c.nonce -or -not $boot.ordinaryUserPreparation -or $boot.isoSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Verified Pro continuation inputs required' }
    if ($ResumeBoot) {
        $existing = $guard.ReadCommand('machine.json') | ConvertFrom-Json
        $vm = Get-VM -Id ([guid]$existing.id)
        $null = Assert-ProVM
        if ($existing.name -ne $c.name -or $vm.State -ne 'Off') { throw 'Only the confirmed stopped Pro VM can resume boot preparation' }
    } elseif ((Test-Path -LiteralPath (Join-Path $directory 'machine.json')) -or @(Get-VM | Where-Object Name -eq $c.name).Count) { throw 'An already created Pro VM must be inspected' }
    $vhd = Get-VHD -Path $diskFile
    if ($vhd.Attached -or $vhd.ParentPath -or $vhd.Size -ne 160GB -or [string]$vhd.DiskIdentifier -ne [string]$boot.diskIdentifier) { throw 'The known unattached Pro VHDX is required' }
    $references = @(Get-VM | Get-VMHardDiskDrive | Where-Object { [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($diskFile) })
    if (($ResumeBoot -and ($references.Count -ne 1 -or $references[0].VMId -ne $vm.Id)) -or (-not $ResumeBoot -and $references.Count)) { throw 'An unrelated VM references this disk' }
    $bootPath = [IO.Path]::GetFullPath([string]$boot.iso); $bootParent = [IO.Path]::GetDirectoryName($bootPath)
    if ([IO.Path]::GetFileName($bootPath) -ne 'pro-boot.iso' -or [IO.Path]::GetDirectoryName($bootParent) -ne $directory -or [IO.Path]::GetFileName($bootParent) -notmatch '^boot-inputs-[a-f0-9-]{36}$') { throw 'Dedicated derived boot ISO required' }
    $guard.PinInputFile($bootPath)
    if ((Get-FileHash -LiteralPath $bootPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $boot.isoSha256) { throw 'Derived Pro boot ISO changed' }
    # Hyper-V consumes an administrator-protected, immutable media copy. The
    # ordinary user's working ISO is not kept as the VM's live DVD attachment.
    $mediaDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) ('MuCodeSandbox-ProMedia-' + $c.name)
    $mediaDirectoryAcl = [Security.AccessControl.DirectorySecurity]::new()
    $mediaDirectoryAcl.SetAccessRuleProtection($true, $false)
    $mediaDirectoryAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($value in @('S-1-5-18','S-1-5-32-544')) { $mediaDirectoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
    if (-not (Test-Path -LiteralPath $mediaDirectory)) { [IO.Directory]::CreateDirectory($mediaDirectory, $mediaDirectoryAcl) | Out-Null }
    $actualMediaAcl = [IO.Directory]::GetAccessControl($mediaDirectory)
    if ([IO.File]::GetAttributes($mediaDirectory) -band [IO.FileAttributes]::ReparsePoint -or $actualMediaAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544') -or @($actualMediaAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') }).Count) { throw 'Unexpected Pro media directory preserved' }
    $protectedBoot = Join-Path $mediaDirectory ('pro-boot-' + [guid]::NewGuid().ToString('N') + '.iso')
    Copy-Item -LiteralPath $bootPath -Destination $protectedBoot
    if ((Get-FileHash -LiteralPath $protectedBoot -Algorithm SHA256).Hash.ToLowerInvariant() -ne $boot.isoSha256) { throw 'Protected boot media copy differs' }
    $attached = Mount-VHD -Path $diskFile -ReadOnly -PassThru; $mounted = $true
    $disk = Get-Disk -Number $attached.DiskNumber; Assert-ProDisk
    $efi = @(Get-Partition -DiskNumber $disk.Number | Where-Object GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}')
    $data = @(Get-Partition -DiskNumber $disk.Number | Where-Object GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}')
    if ($efi.Count -ne 1 -or $efi[0].PartitionNumber -ne $boot.efiPartition -or $efi[0].Size -ne 260MB -or $data.Count -ne 1 -or -not $data[0].DriveLetter) { throw 'Pro partition layout changed' }
    $windowsRoot = ([string]$data[0].DriveLetter) + ':\'
    $marker = Get-Content -LiteralPath (Join-Path $windowsRoot 'MuLab/private/deployment.json') -Raw | ConvertFrom-Json
    if ($marker.flavor -ne 'pro26300' -or $marker.nonce -ne $c.nonce) { throw 'Original Pro guest marker changed' }
    foreach ($entry in $c.stagedHashes.psobject.Properties) { if ((Get-FileHash -LiteralPath (Join-Path $windowsRoot ('MuLab/' + $entry.Name)) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Deployed Pro payload differs from the staged original' } }
    if ((Get-FileHash -LiteralPath (Join-Path $windowsRoot 'Windows/Panther/Unattend/Unattend.xml') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $c.unattendSha256) { throw 'Original Pro answer file changed' }
    Dismount-VHD -Path $diskFile; $mounted = $false
    if ($guard.Owner.HasExited -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB -lt 14GB) { throw 'Ordinary owner or Pro memory capacity unavailable' }
    Save-ProStart 'preparing-disconnected-pro-vm'
    if (-not $ResumeBoot) { $vm = New-VM -Name $c.name -Generation 2 -MemoryStartupBytes 10GB -VHDPath $diskFile -Path (Join-Path $storage 'machine') }
    $vm | Set-VM -Notes ('MuCodeSandbox isolated Pro diagnostic ' + $c.name) -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled -AutomaticCheckpointsEnabled $false
    Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true; Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
    Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
    if (-not $ResumeBoot) {
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
        Set-VMKeyProtector -VM $vm -NewLocalKeyProtector; Enable-VMTPM -VM $vm
    } elseif ((Get-VMFirmware -VM $vm).SecureBoot -ne 'On' -or -not (Get-VMSecurity -VM $vm).TpmEnabled) { throw 'Original Pro Secure Boot and TPM must remain enabled' }
    $vmSid = [Security.Principal.NTAccount]::new('NT VIRTUAL MACHINE', [string]$vm.Id).Translate([Security.Principal.SecurityIdentifier])
    $mediaAcl = [IO.File]::GetAccessControl($protectedBoot)
    $mediaAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($vmSid, 'Read', 'Allow'))
    [IO.File]::SetAccessControl($protectedBoot, $mediaAcl)
    if ($ResumeBoot) { [IO.File]::WriteAllText($guard.Reserve('machine-prior-' + [guid]::NewGuid().ToString('N') + '.json'), ($existing | ConvertTo-Json), [Text.UTF8Encoding]::new($false)); $machineFile = Join-Path $directory 'machine.json' }
    else { $machineFile = $guard.Reserve('machine.json') }
    [IO.File]::WriteAllText($machineFile, (@{ id = [string]$vm.Id; name = $vm.Name; disk = $diskFile; isoSha256 = $c.imageSha256; bootIso = $protectedBoot; bootMediaDirectory = $mediaDirectory; bootIsoSha256 = $boot.isoSha256; networkConnected = $false; nestedVirtualization = $true } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $dvds = @(Get-VMDvdDrive -VM $vm)
    if ($dvds.Count -gt 1 -or ($dvds.Count -eq 1 -and $dvds[0].Path -and $dvds[0].Path -ne $existing.bootIso)) { throw 'Unexpected Pro DVD attachment preserved' }
    if ($dvds.Count) { $dvds[0] | Set-VMDvdDrive -Path $protectedBoot; $dvd = Get-VMDvdDrive -VM $vm }
    else { $dvd = Add-VMDvdDrive -VM $vm -Path $protectedBoot -Passthru }
    Set-VMFirmware -VM $vm -FirstBootDevice $dvd
    $null = Assert-ProVM; Start-VM -VM $vm | Out-Null
    Save-ProStart 'running-fixed-guest-winpe-startup'
    $until = [DateTime]::UtcNow.AddMinutes(10)
    do { Start-Sleep -Seconds 3; $current = Assert-ProVM; if ($current.State -eq 'Off') { break }; if ($guard.Owner.HasExited -or [DateTime]::UtcNow -gt $until) { throw 'Guest WinPE completion not confirmed; existing disk and VM retained' } } while ($true)
    $attached = Mount-VHD -Path $diskFile -ReadOnly -PassThru; $mounted = $true
    $disk = Get-Disk -Number $attached.DiskNumber; Assert-ProDisk
    $data = Get-Partition -DiskNumber $disk.Number | Where-Object GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'
    if (-not $data.DriveLetter) { throw 'Pro Windows volume missing after WinPE' }
    $receipt = Get-Content -LiteralPath (([string]$data.DriveLetter) + ':\MuLab\public\boot-repair.json') -Raw | ConvertFrom-Json
    if (-not $receipt.bootRepair -or $receipt.nonce -ne $c.nonce) { throw 'Pro guest boot preparation receipt missing' }
    Dismount-VHD -Path $diskFile; $mounted = $false
    Get-VMDvdDrive -VM $vm | Set-VMDvdDrive -Path $null
    Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm)
    $null = Assert-ProVM; Start-VM -VM $vm | Out-Null
    Save-ProStart 'pro-first-boot' 'prepared' @{ originalProDiskReused = $true; guestBootRepairVerified = $true; hostBcdCommands = 0; hostReboots = 0 }
} catch {
    $failure = $_
    Save-ProStart 'failed' 'failed' @{ message = $failure.Exception.Message; stack = $failure.ScriptStackTrace }
    if ($vm) { try { $current = Assert-ProVM; if ($current.State -ne 'Off') { Stop-VM -VM $current -TurnOff -Force } } catch {} }
    throw $failure
} finally { if ($mounted) { Dismount-VHD -Path $diskFile -ErrorAction SilentlyContinue }; $guard.Dispose() }
