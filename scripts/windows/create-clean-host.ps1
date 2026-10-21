#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$configFile=[IO.Path]::GetFullPath($ConfigPath);$directory=[IO.Path]::GetDirectoryName($configFile)
if([IO.Path]::GetFileName($configFile) -ne 'config.json' -or [IO.Path]::GetFileName($directory) -notmatch '^clean-host-[a-f0-9-]{36}$'){throw 'Dedicated clean-host fixture required'}
$c=[IO.File]::ReadAllText($configFile) | ConvertFrom-Json
if($c.name -notmatch '^mu-win-clean-[a-f0-9]{32}$' -or $c.imageSha256 -ne '2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29'){throw 'Fixed diagnostic image and identity required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new([int]$c.ownerPid,$directory)
$iso=$null;$vhd=$null;$vm=$null;$created=$false
$state=$guard.Reserve('state.json')
function Save-State([string]$phase,[string]$status='running') {[IO.File]::WriteAllText($state,(@{phase=$phase;status=$status;name=$c.name;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
try {
 Save-State 'checking-image'
 $image=[IO.Path]::GetFullPath([string]$c.image)
 if([IO.Path]::GetFileName($image) -ne 'windows11-iot-enterprise-ltsc-eval-x64.iso' -or (Get-Item -LiteralPath $image).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Expected the verified local evaluation ISO'}
 if((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $c.imageSha256){throw 'Microsoft ISO digest mismatch'}
 if(@(Get-VM -ErrorAction Stop | Where-Object Name -eq $c.name).Count){throw 'Diagnostic VM already exists'}
 $storage=$guard.CreateArtifacts();$diskFile=Join-Path $storage 'windows.vhdx'
 if(Test-Path -LiteralPath $diskFile){throw 'Fresh diagnostic disk required'}
 Save-State 'mounting-official-image'
 $iso=Mount-DiskImage -ImagePath $image -Access ReadOnly -PassThru
 $isoVolume=$iso | Get-Volume
 if(-not $isoVolume.DriveLetter){throw 'Read-only ISO drive unavailable'}
 Save-State 'verifying-microsoft-setup-signatures'
 $mediaRoot=([string]$isoVolume.DriveLetter)+':\';$signatures=@();$signatureLog=$guard.Reserve('media-auth.json')
 $signers=@{'setup.exe'='3DA3E1A591E67BAA377A31CC88CA4B3C4815478F';'sources/setuphost.exe'='D8FB0CC66A08061B42D46D03546F0D42CBC49B7C'}
 foreach($relative in @('setup.exe','sources/setuphost.exe')){
  $signature=Get-AuthenticodeSignature -LiteralPath (Join-Path $mediaRoot $relative)
  $signatures+=@{file=$relative;status=[string]$signature.Status;signer=$signature.SignerCertificate.Subject;thumbprint=$signature.SignerCertificate.Thumbprint}
  [IO.File]::WriteAllText($signatureLog,($signatures | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
  if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $signers[$relative]){throw 'Pinned Microsoft setup signature rejected'}
 }
 $wim=([string]$isoVolume.DriveLetter)+':\sources\install.wim'
 $images=@(Get-WindowsImage -ImagePath $wim -ErrorAction Stop | Where-Object {$_.ImageName -like '*IoT*Enterprise*'})
 if($images.Count -ne 1){throw 'Expected one IoT Enterprise evaluation image'}
 Save-State 'creating-new-virtual-disk'
 $vhd=New-VHD -Path $diskFile -SizeBytes 96GB -Dynamic -ErrorAction Stop
 $mounted=Mount-VHD -Path $diskFile -PassThru
 $disk=Get-Disk -Number $mounted.DiskNumber -ErrorAction Stop
 function Assert-DiagnosticDisk {
  $actual=Get-VHD -DiskNumber $disk.Number -ErrorAction Stop
  $device=Get-Disk -Number $disk.Number -ErrorAction Stop
  if([IO.Path]::GetFullPath($actual.Path) -ne [IO.Path]::GetFullPath($diskFile) -or $device.IsBoot -or $device.IsSystem -or $device.Size -ne 96GB){throw 'Refusing to alter a disk outside this new VHDX'}
 }
 Assert-DiagnosticDisk
 if($disk.PartitionStyle -ne 'RAW'){throw 'New VHDX is not empty'}
 Initialize-Disk -InputObject $disk -PartitionStyle GPT -ErrorAction Stop | Out-Null
 Assert-DiagnosticDisk
 $efi=New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -AssignDriveLetter
 $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel MU-CLEAN-EFI -Confirm:$false -Force | Out-Null
 Assert-DiagnosticDisk
 New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' | Out-Null
 $windows=New-Partition -DiskNumber $disk.Number -UseMaximumSize -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' -AssignDriveLetter
 $windows | Format-Volume -FileSystem NTFS -NewFileSystemLabel MU-CLEAN-WINDOWS -Confirm:$false -Force | Out-Null
 Assert-DiagnosticDisk
 $windowsRoot=([string]$windows.DriveLetter)+':\';$efiRoot=([string]$efi.DriveLetter)+':'
 if((Get-Partition -DriveLetter $windows.DriveLetter).DiskNumber -ne $disk.Number -or (Get-Partition -DriveLetter $efi.DriveLetter).DiskNumber -ne $disk.Number){throw 'Diagnostic partition identity changed'}
 Save-State 'applying-fresh-windows-image'
 & (Join-Path $env:SystemRoot 'System32/dism.exe') /Apply-Image /ImageFile:$wim /Index:$($images[0].ImageIndex) /ApplyDir:$windowsRoot /CheckIntegrity /Quiet
 if($LASTEXITCODE -ne 0){throw 'Windows image application failed'}
 Assert-DiagnosticDisk
 $panther=Join-Path $windowsRoot 'Windows/Panther/Unattend';New-Item -ItemType Directory -Path $panther -Force | Out-Null
 Copy-Item -LiteralPath (Join-Path $directory 'unattend.xml') -Destination (Join-Path $panther 'Unattend.xml')
 Copy-Item -LiteralPath (Join-Path $directory 'guest-seed') -Destination (Join-Path $windowsRoot 'MuLab') -Recurse
 $lab=Join-Path $windowsRoot 'MuLab';$labAcl=[Security.AccessControl.DirectorySecurity]::new();$labAcl.SetAccessRuleProtection($true,$false)
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){$labAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 $labAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));[IO.Directory]::SetAccessControl($lab,$labAcl)
 $private=Join-Path $windowsRoot 'MuLab/private';$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};[IO.Directory]::SetAccessControl($private,$acl)
 Dismount-VHD -Path $diskFile;$vhd=$null
 Dismount-DiskImage -ImagePath $image;$iso=$null
 # Firmware and BCD preparation run only inside the disconnected evaluation VM.
 Save-State 'windows-image-ready-for-guest-pe' 'prepared'
}catch {$failure=$_;try{$log=$guard.Reserve('failure.log');[IO.File]::WriteAllText($log,($failure.Exception.ToString()+[Environment]::NewLine+$failure.ScriptStackTrace),[Text.UTF8Encoding]::new($false));Save-State 'failed' 'failed'}catch{};if($created -and $vm){$current=Get-VM -Id $vm.Id -ErrorAction Stop;if($current.Notes -eq ('MuCodeSandbox clean Windows diagnostic '+$c.name) -and $current.State -ne 'Off'){Stop-VM -VM $current -TurnOff -Force}};throw $failure}
finally{if($vhd){Dismount-VHD -Path $diskFile -ErrorAction SilentlyContinue};if($iso){Dismount-DiskImage -ImagePath $image -ErrorAction SilentlyContinue};$guard.Dispose()}
