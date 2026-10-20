#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][guid]$VMId,[Parameter(Mandatory)][guid]$EnvironmentId,[Parameter(Mandatory)][string]$Report)
$ErrorActionPreference='Stop'
$full=[IO.Path]::GetFullPath($Report)
if([IO.Path]::GetFileName($full) -notmatch '^watchdog-[a-f0-9-]{36}\.json$' -or [IO.File]::Exists($full)){throw 'Expected a fresh watchdog report'}
$name='mu-win-'+$EnvironmentId.ToString('N')
$until=[DateTime]::UtcNow.AddSeconds(40)
do{
 $vm=Get-VM -Id $VMId
 if($vm.Name -ne $name -or $vm.Notes -ne ('MuCodeSandbox Windows preview '+$name)){throw 'VM ownership changed'}
 if($vm.State -eq 'Off'){break}
 Start-Sleep -Milliseconds 200
}while([DateTime]::UtcNow -lt $until)
$result=@{vmId=$VMId.ToString('D');id=$EnvironmentId.ToString('D');state=[string]$vm.State;offConfirmed=($vm.State -eq 'Off')} | ConvertTo-Json -Compress
$stream=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($result);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
if($vm.State -ne 'Off'){exit 1}
