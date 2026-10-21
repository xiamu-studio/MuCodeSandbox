[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('status','prepare')][string]$Action,[string]$TaskFile)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator component required'}

function Get-HostComponentStatus {
 $os=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
 $computer=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
 $processors=@(Get-CimInstance Win32_Processor -ErrorAction Stop)
 $arch=if(@($processors | Where-Object {$_.Architecture -ne 9}).Count -eq 0){'x64'}elseif(@($processors | Where-Object {$_.Architecture -eq 12}).Count){'arm64'}else{'other'}
 $hypervisor=[bool]$computer.HypervisorPresent
 $firmware=if($hypervisor){$true}elseif(@($processors | Where-Object {$null -eq $_.VirtualizationFirmwareEnabled}).Count){$null}else{@($processors | Where-Object {-not $_.VirtualizationFirmwareEnabled}).Count -eq 0}
 $slat=if($hypervisor){$true}elseif(@($processors | Where-Object {$null -eq $_.SecondLevelAddressTranslationExtensions}).Count){$null}else{@($processors | Where-Object {-not $_.SecondLevelAddressTranslationExtensions}).Count -eq 0}
 $feature='unavailable';try{$value=Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction Stop;$feature=switch([string]$value.State){'Enabled'{'enabled'} 'EnablePending'{'pending'} 'DisablePending'{'pending'} 'Disabled'{'disabled'} 'DisabledWithPayloadRemoved'{'disabled'} default{'error'}}}catch{if($_.Exception.HResult -ne -2146498548){$feature='unavailable'}}
 $capability='error';try{$value=Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction Stop;$capability=switch([string]$value.State){'Installed'{'installed'} 'NotPresent'{'missing'} 'InstallPending'{'pending'} 'UninstallPending'{'pending'} default{'error'}}}catch{}
 $files=(Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32/OpenSSH/ssh.exe') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32/OpenSSH/ssh-keygen.exe') -PathType Leaf)
 $module=[bool](Get-Module -ListAvailable Hyper-V)
 $service=Get-Service vmms -ErrorAction SilentlyContinue
 $serviceRunning=$service -and $service.Status -eq 'Running'
 $supported=$arch -eq 'x64' -and [int]$os.BuildNumber -ge 22000 -and $feature -ne 'unavailable'
 $pending=$feature -eq 'pending' -or $capability -eq 'pending'
 $ready=$supported -and $feature -eq 'enabled' -and $module -and $serviceRunning -and $hypervisor -and $files -and -not $pending
 [ordered]@{edition=[string](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name EditionID).EditionID;build=[string]$os.BuildNumber;architecture=$arch;supported=[bool]$supported;firmwareVirtualization=$firmware;slat=$slat;hypervisorPresent=$hypervisor;hyperV=$feature;managementModule=$module;vmmsRunning=[bool]$serviceRunning;sshCapability=$capability;sshClientPresent=[bool]$files;restartRequired=[bool]($pending -or ($feature -eq 'enabled' -and -not $hypervisor));ready=[bool]$ready;bootId=$os.LastBootUpTime.ToUniversalTime().ToString('o')}
}
if($Action -eq 'status'){Get-HostComponentStatus | ConvertTo-Json -Depth 6 -Compress;exit 0}
if(-not $TaskFile -or [IO.Path]::GetFileName($TaskFile) -notmatch '^job-[a-f0-9-]{36}\.json$' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($TaskFile)) -ne 'host-components'){throw 'Fixed host component job required'}
$state=[IO.File]::ReadAllText($TaskFile) | ConvertFrom-Json
$state.status='running';$state.phase='checking';$state.processId=$PID;$state.processStart=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()
function Save-HostJob {
 $next=$TaskFile+'.'+[guid]::NewGuid().ToString('N')+'.next'
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($state | ConvertTo-Json -Depth 8 -Compress))
 $file=[IO.File]::Open($next,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
 [IO.File]::Replace($next,$TaskFile,[NullString]::Value)
}
function Save-HostChange([string]$name,[bool]$restartNeeded) {
 $state.changed=@($state.changed)+$name
 $state.restartNeeded=[bool]($state.restartNeeded -or $restartNeeded)
 Save-HostJob
}
$lock=$null
try {
 $lockFile=Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/host-components.lock'
 $lock=[IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $before=Get-HostComponentStatus;$state.snapshot=$before;Save-HostJob
 if(-not $before.supported -or $before.firmwareVirtualization -ne $true -or $before.slat -ne $true){throw 'Unsupported host requirements'}
 if(-not $before.ready -and -not $before.restartRequired){
  if($before.hyperV -ne 'enabled' -or -not $before.managementModule){
   $state.phase='enable-hyperv';Save-HostJob
   $result=Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart -ErrorAction Stop
   Save-HostChange 'hyperv' ([bool]$result.RestartNeeded)
  }
  if(-not $before.sshClientPresent){
   $state.phase='install-ssh';Save-HostJob
   $result=Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -NoRestart -ErrorAction Stop
   Save-HostChange 'ssh-client' ([bool]$result.RestartNeeded)
  }
  $middle=Get-HostComponentStatus
  if($middle.hypervisorPresent -and $middle.hyperV -eq 'enabled' -and -not $middle.vmmsRunning){
   $state.phase='start-service';Save-HostJob
   Set-Service vmms -StartupType Automatic -ErrorAction Stop;Start-Service vmms -ErrorAction Stop;Save-HostChange 'vmms' $false
  }
 }
 $after=Get-HostComponentStatus
 $state.snapshot=$after;$state.restartNeeded=[bool]($state.restartNeeded -or $after.restartRequired);$state.bootId=$after.bootId;$state.status='completed';$state.phase='complete';$state.errorCode=$null;Save-HostJob
}catch {
 $failure=$_
 # Servicing can finish one component before a later component fails. Preserve
 # those durable receipts even when a fresh status query is also unavailable.
 try{$after=Get-HostComponentStatus;$state.snapshot=$after;$state.restartNeeded=[bool]($state.restartNeeded -or $after.restartRequired)}catch{}
 try{[IO.File]::WriteAllText($TaskFile+'.error.log',($failure.Exception.ToString()+[Environment]::NewLine+$failure.ScriptStackTrace),[Text.UTF8Encoding]::new($false))}catch{}
 $state.status='failed';$state.phase='failed';$state.errorCode=[int]$failure.Exception.HResult;Save-HostJob;exit 1
}finally{if($lock){$lock.Dispose()}}
