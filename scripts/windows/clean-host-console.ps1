#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[switch]$AdvanceLocalSetup)
$ErrorActionPreference='Stop';$directoryPath=[IO.Path]::GetFullPath($Directory)
if([IO.Path]::GetFileName($directoryPath) -notmatch '^clean-host-[a-f0-9-]{36}$'){throw 'Dedicated clean-host fixture required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs');Add-Type -AssemblyName System.Drawing
$guard=[MuPacketLabGuard]::new($OwnerPid,$directoryPath)
try{
 $m=[IO.File]::ReadAllText((Join-Path $directoryPath 'machine.json')) | ConvertFrom-Json;$vm=Get-VM -Id ([guid]$m.id)
 $disks=@(Get-VMHardDiskDrive -VM $vm)
 if($vm.Name -ne $m.name -or $vm.Name -notmatch '^mu-win-clean-[a-f0-9]{32}$' -or $vm.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$m.name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne [IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'))){throw 'Evaluation VM identity changed'}
 if($AdvanceLocalSetup){$keyboard=Get-WmiObject -Namespace root/virtualization/v2 -Class Msvm_Keyboard -Filter ("SystemName='"+[string]$vm.Id+"'");$key=$keyboard.TypeKey(13);if($key.ReturnValue -ne 0){throw 'Evaluation setup confirmation key rejected'};return}
 $system=Get-WmiObject -Namespace root/virtualization/v2 -Class Msvm_ComputerSystem -Filter ("Name='"+[string]$vm.Id+"'")
 $settings=@($system.GetRelated('Msvm_VirtualSystemSettingData','Msvm_SettingsDefineState',$null,$null,'SettingData','ManagedElement',$false,$null))
 $service=Get-WmiObject -Namespace root/virtualization/v2 -Class Msvm_VirtualSystemManagementService
 $parameters=$service.GetMethodParameters('GetVirtualSystemThumbnailImage');$parameters['TargetSystem']=$settings[0].Path.Path;$parameters['WidthPixels']=[uint16]800;$parameters['HeightPixels']=[uint16]600
 $result=$service.InvokeMethod('GetVirtualSystemThumbnailImage',$parameters,$null)
 [IO.File]::WriteAllText($guard.Reserve('console-meta-'+[guid]::NewGuid().ToString('N')+'.json'),(@{returnValue=$result.ReturnValue;bytes=$result.ImageData.Length;prefix=[BitConverter]::ToString($result.ImageData[0..15]);target=$parameters['TargetSystem'];state=[string]$vm.State} | ConvertTo-Json -Depth 4))
 $pixelBytes=800*600*2;$offset=0
 if($result.ReturnValue -ne 0 -or $result.ImageData.Length -notin @($pixelBytes,($pixelBytes+4))){throw 'Evaluation VM framebuffer unavailable'}
 if($result.ImageData.Length -eq $pixelBytes+4){$header=[int64]$result.ImageData[0]*16777216+[int64]$result.ImageData[1]*65536+[int64]$result.ImageData[2]*256+[int64]$result.ImageData[3];if($header -ne $result.ImageData.Length){throw 'Unexpected framebuffer length header'};$offset=4}
 $bitmap=[Drawing.Bitmap]::new(800,600,[Drawing.Imaging.PixelFormat]::Format16bppRgb565)
 try{$data=$bitmap.LockBits([Drawing.Rectangle]::new(0,0,800,600),[Drawing.Imaging.ImageLockMode]::WriteOnly,[Drawing.Imaging.PixelFormat]::Format16bppRgb565);try{[Runtime.InteropServices.Marshal]::Copy([byte[]]$result.ImageData,$offset,$data.Scan0,$pixelBytes)}finally{$bitmap.UnlockBits($data)};$bitmap.Save($guard.Reserve('console-'+[guid]::NewGuid().ToString('N')+'.png'),[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
}catch{[IO.File]::WriteAllText($guard.Reserve('console-error-'+[guid]::NewGuid().ToString('N')+'.log'),($_.Exception.ToString()+[Environment]::NewLine+$_.ScriptStackTrace));throw}
finally{$guard.Dispose()}
