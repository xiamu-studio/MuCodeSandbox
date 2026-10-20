#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][guid[]]$EnvironmentIds,[Parameter(Mandatory)][guid[]]$VMIds,[Parameter(Mandatory)][string]$Report)
$ErrorActionPreference='Stop'
$full=[IO.Path]::GetFullPath($Report)
if($EnvironmentIds.Count -ne $VMIds.Count -or $EnvironmentIds.Count -gt 4 -or [IO.Path]::GetFileName($full) -notmatch '^removal-[a-f0-9-]{36}\.json$' -or [IO.File]::Exists($full)){throw 'Expected a fresh removal inspection'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$parent=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('MuCodeSandbox-HyperVBroker-v1\users\'+$sid+'\vms')
$results=@()
$allVMs=@(Get-VM -ErrorAction Stop)
$allSwitches=@(Get-VMSwitch -ErrorAction Stop)
for($index=0;$index -lt $EnvironmentIds.Count;$index++){
 $id=$EnvironmentIds[$index];$name='mu-win-'+$id.ToString('N')
 $absent=@($allVMs | Where-Object {$_.Id -eq $VMIds[$index] -or $_.Name -eq $name}).Count -eq 0 -and @($allSwitches | Where-Object {$_.Name -eq $name}).Count -eq 0 -and -not [IO.Directory]::Exists((Join-Path $parent $id.ToString('D')))
 $results+=@{id=$id.ToString('D');removed=[bool]$absent}
}
$stream=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes((@{results=$results;allRemoved=(@($results | Where-Object {-not $_.removed}).Count -eq 0)} | ConvertTo-Json -Depth 4 -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
if(@($results | Where-Object {-not $_.removed}).Count){exit 1}
