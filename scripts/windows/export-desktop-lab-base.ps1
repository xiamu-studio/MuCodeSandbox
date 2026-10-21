#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$LabConfigPath)
$ErrorActionPreference='Stop'
$c=[IO.File]::ReadAllText($LabConfigPath) | ConvertFrom-Json
if([IO.Path]::GetFileName([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LabConfigPath))) -notmatch '^desktop-lab-[a-f0-9-]{36}$'){throw 'Expected a dedicated desktop fixture directory'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new([int]$c.ownerPid,[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LabConfigPath)))
try{
 $id=[guid]$c.id;$vm=Get-VM -Id ([guid]$c.platformId) -ErrorAction Stop;$name='mu-win-'+$id.ToString('N')
 if($vm.Name -ne $name -or $vm.Notes -ne ('MuCodeSandbox Windows preview '+$name) -or $vm.State -ne 'Off' -or $vm.CreationTime.ToUniversalTime() -lt [DateTime]::Parse($c.createdAt).ToUniversalTime().AddSeconds(-5)){throw 'Only the new stopped fixture builder can be exported'}
 $parent=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('MuCodeSandbox-HyperVBroker-v1\users\'+$guard.Sid+'\vms\'+$id.ToString('D'))
 $disks=@(Get-VMHardDiskDrive -VM $vm);$source=Join-Path $parent 'disk.vhdx'
 if($disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne $source){throw 'Fixture builder disk identity changed'}
 $destination=$guard.Reserve('fixture-base.vhdx')
 $inputStream=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{$outputStream=[IO.File]::Open($destination,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$inputStream.CopyTo($outputStream);$outputStream.Flush($true)}finally{$outputStream.Dispose()}}finally{$inputStream.Dispose()}
 $report=$guard.Reserve('fixture-base.json');[IO.File]::WriteAllText($report,(@{image=$destination;imageSha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}finally{$guard.Dispose()}
