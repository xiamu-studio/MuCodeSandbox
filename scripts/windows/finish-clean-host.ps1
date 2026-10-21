#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[switch]$UseGuestPE)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if(-not $UseGuestPE){throw 'Boot preparation is supported only inside the evaluation VM Windows PE'}
$directoryPath=[IO.Path]::GetFullPath($Directory)
if([IO.Path]::GetFileName($directoryPath) -notmatch '^clean-host-[a-f0-9-]{36}$'){throw 'Dedicated clean-host fixture required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,$directoryPath);$mounted=$false;$vm=$null;$created=$false
$runId=[guid]::NewGuid().ToString('N');$report=$guard.Reserve('finish-'+$runId+'.json')
function Save-Finish([string]$phase,$details=$null){[IO.File]::WriteAllText($report,(@{phase=$phase;time=[DateTime]::UtcNow.ToString('o');details=$details} | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}
try{
 $c=[IO.File]::ReadAllText((Join-Path $directoryPath 'config.json')) | ConvertFrom-Json
 if($c.name -notmatch '^mu-win-clean-[a-f0-9]{32}$' -or $c.imageSha256 -ne '2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29'){throw 'Unexpected diagnostic identity'}
 $registered=$null;$existing=Join-Path $directoryPath 'machine.json'
 if(Test-Path -LiteralPath $existing){
  if(-not $UseGuestPE){throw 'An existing diagnostic VM must be inspected'}
  $identity=[IO.File]::ReadAllText($existing) | ConvertFrom-Json;$registered=Get-VM -Id ([guid]$identity.id)
  $attached=@(Get-VMHardDiskDrive -VM $registered)
  if($registered.Name -ne $c.name -or $registered.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$c.name) -or $registered.State -ne 'Off' -or $attached.Count -ne 1 -or [IO.Path]::GetFullPath($attached[0].Path) -ne [IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'))){throw 'Only this stopped diagnostic VM can resume PE preparation'}
 }elseif(@(Get-VM | Where-Object Name -eq $c.name).Count){throw 'Diagnostic VM already exists'}
 $storage=$guard.ReopenArtifacts();$diskFile=Join-Path $storage 'windows.vhdx'
 $vhd=Get-VHD -Path $diskFile
 if($vhd.Size -ne 96GB -or $vhd.VhdType -ne 'Dynamic' -or $vhd.ParentPath -or $vhd.Attached){throw 'Expected the unattached newly deployed standalone diagnostic disk'}
 Save-Finish 'mounting-deployed-vhd'
 $vhd=Mount-VHD -Path $diskFile -PassThru;$mounted=$true;$disk=Get-Disk -Number $vhd.DiskNumber
 function Assert-DiagnosticDisk {
  $actual=Get-VHD -DiskNumber $disk.Number;$device=Get-Disk -Number $disk.Number
  if([IO.Path]::GetFullPath($actual.Path) -ne [IO.Path]::GetFullPath($diskFile) -or $device.IsBoot -or $device.IsSystem -or $device.Size -ne 96GB){throw 'Refusing to alter a disk outside this new VHDX'}
 }
 Assert-DiagnosticDisk
 $partitions=@(Get-Partition -DiskNumber $disk.Number);$efi=@($partitions | Where-Object GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}');$windows=@($partitions | Where-Object GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}')
 if($efi.Count -ne 1 -or $windows.Count -ne 1 -or $efi[0].Size -ne 260MB){throw 'Expected the fresh EFI and Windows layout'}
 foreach($partition in @($efi[0],$windows[0])){if(-not $partition.DriveLetter){Assert-DiagnosticDisk;$partition | Add-PartitionAccessPath -AssignDriveLetter}}
 $efi=Get-Partition -DiskNumber $disk.Number -PartitionNumber $efi[0].PartitionNumber;$windows=Get-Partition -DiskNumber $disk.Number -PartitionNumber $windows[0].PartitionNumber
 $windowsRoot=([string]$windows.DriveLetter)+':\';$efiRoot=([string]$efi.DriveLetter)+':'
 if(-not (Test-Path -LiteralPath (Join-Path $windowsRoot 'Windows/System32/config/BCD-Template')) -or -not (Test-Path -LiteralPath (Join-Path $windowsRoot 'MuLab/public'))){throw 'Expected the freshly applied Windows image and synthetic seed'}
 Assert-DiagnosticDisk
 if((Get-Partition -DriveLetter $windows.DriveLetter).DiskNumber -ne $disk.Number -or (Get-Partition -DriveLetter $efi.DriveLetter).DiskNumber -ne $disk.Number){throw 'Diagnostic volume identity changed'}
 Dismount-VHD -Path $diskFile;$mounted=$false
 Save-Finish 'creating-disconnected-vm'
 $vm=if($registered){$registered}else{New-VM -Name $c.name -Generation 2 -MemoryStartupBytes 10GB -VHDPath $diskFile -Path (Join-Path $storage 'machine')};$created=$true
 $vm | Set-VM -Notes ('MuCodeSandbox clean Windows diagnostic '+$c.name) -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled -AutomaticCheckpointsEnabled $false
 Set-VMProcessor -VM $vm -Count 4 -ExposeVirtualizationExtensions $true;Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
 Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
 if(-not $registered){Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows}elseif((Get-VMFirmware -VM $vm).SecureBoot -ne 'On'){throw 'Secure Boot must remain enabled on this evaluation VM'}
 if(-not $registered){Set-VMKeyProtector -VM $vm -NewLocalKeyProtector;Enable-VMTPM -VM $vm;[IO.File]::WriteAllText($guard.Reserve('machine.json'),(@{id=[string]$vm.Id;name=$vm.Name;disk=$diskFile;isoSha256=$c.imageSha256;networkConnected=$false;nestedVirtualization=$true} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
 if($UseGuestPE){
  if((Get-FileHash -LiteralPath $c.image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $c.imageSha256){throw 'Microsoft setup ISO changed'}
  Get-VMDvdDrive -VM $vm | Remove-VMDvdDrive
  $dvd=Add-VMDvdDrive -VM $vm -Path $c.image -Passthru;Set-VMFirmware -VM $vm -FirstBootDevice $dvd
  Save-Finish 'guest-windows-pe-boot-preparation';Start-VM -VM $vm | Out-Null
  $keyboard=Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_Keyboard -Filter ("SystemName='"+[string]$vm.Id+"'")
  $keys=@();for($i=0;$i -lt 20;$i++){Start-Sleep -Milliseconds 500;$key=Invoke-CimMethod -InputObject $keyboard -MethodName TypeKey -Arguments @{keyCode=[uint32]32};$keys+=[int]$key.ReturnValue}
  Save-Finish 'waiting-for-windows-pe-repair' @{bootKeyResults=$keys}
  if($keys -notcontains 0){throw ('Evaluation VM boot key was rejected: '+($keys -join ','))}
  # This evaluation ISO's modern Setup UI does not consume the secondary CD's
  # implicit answer file. Open its supported WinPE command prompt and run only
  # the fixed repair script already attached to this disconnected diagnostic VM.
  Start-Sleep -Seconds 15
  $keyboard=Get-WmiObject -Namespace root/virtualization/v2 -Class Msvm_Keyboard -Filter ("SystemName='"+[string]$vm.Id+"'")
  $keyboard.TypeKey(27) | Out-Null;Start-Sleep -Milliseconds 300
  try{$keyboard.PressKey(16) | Out-Null;$keyboard.TypeKey(121) | Out-Null}finally{$keyboard.ReleaseKey(16) | Out-Null}
  Start-Sleep -Seconds 2
  $select='(echo select disk 0 & echo select partition '+[string]$efi.PartitionNumber+' & echo assign letter=S & echo exit) | diskpart'
  $typed=$keyboard.TypeText($select);if($typed.ReturnValue -ne 0){throw 'Fixed guest EFI selection rejected'};$keyboard.TypeKey(13) | Out-Null;Start-Sleep -Seconds 2
  $command='for %w in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do @if exist %w:\MuLab\private\credentials.json (bcdboot %w:\Windows /s S: /f UEFI /c /v > %w:\MuLab\public\boot-repair.log 2>&1 & if not errorlevel 1 (echo {"bootRepair":true} > %w:\MuLab\public\boot-repair.json & wpeutil shutdown))'
  $typed=$keyboard.TypeText($command);if($typed.ReturnValue -ne 0){throw 'Fixed Windows PE repair command rejected'};$keyboard.TypeKey(13) | Out-Null
  Save-Finish 'running-fixed-guest-pe-command' @{efiPartitionNumber=$efi.PartitionNumber}
  $until=[DateTime]::UtcNow.AddMinutes(8)
  do{$actual=Get-VM -Id $vm.Id;if($actual.Name -ne $c.name -or $actual.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$c.name)){throw 'Evaluation VM identity changed'};if($actual.State -eq 'Off'){break};if([DateTime]::UtcNow -gt $until){throw 'Windows PE did not confirm completion; test resources retained'};Start-Sleep -Seconds 3}while($true)
  Save-Finish 'verifying-guest-boot-repair'
  $vhd=Mount-VHD -Path $diskFile -PassThru;$mounted=$true;$disk=Get-Disk -Number $vhd.DiskNumber;Assert-DiagnosticDisk
  $data=Get-Partition -DiskNumber $disk.Number | Where-Object GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'
  if(-not $data.DriveLetter){$data | Add-PartitionAccessPath -AssignDriveLetter;$data=Get-Partition -DiskNumber $disk.Number -PartitionNumber $data.PartitionNumber}
  $result=Join-Path (([string]$data.DriveLetter)+':\') 'MuLab/public/boot-repair.json'
  if(-not (Test-Path -LiteralPath $result) -or -not ([IO.File]::ReadAllText($result) | ConvertFrom-Json).bootRepair){throw 'Guest boot repair receipt missing'}
  Dismount-VHD -Path $diskFile;$mounted=$false
  Get-VMDvdDrive -VM $vm | Set-VMDvdDrive -Path $null;Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm)
 }
 Start-VM -VM $vm | Out-Null;Save-Finish 'guest-first-boot'
}catch{
 $failure=$_;Save-Finish 'failed' @{message=$failure.Exception.Message;stack=$failure.ScriptStackTrace}
 if($created -and $vm){$current=Get-VM -Id $vm.Id;if($current.Notes -eq ('MuCodeSandbox clean Windows diagnostic '+$c.name) -and $current.State -ne 'Off'){Stop-VM -VM $current -TurnOff -Force}}
 throw $failure
}finally{if($mounted){Dismount-VHD -Path $diskFile -ErrorAction SilentlyContinue};$guard.Dispose()}
