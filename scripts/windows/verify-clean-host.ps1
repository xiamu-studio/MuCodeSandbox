#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][ValidateSet('before-reboot','after-reboot','power-inspect','power-discard-failed','power-clear-failed','power-prepare-reset','power-run','power-recover','power-progress','power-collect','inspect','ssh-inspect','ssh-remove','ssh-source','ssh-install','ssh-ready','ssh-collect','network-inspect','network-prepare','network','network-collect','adoption-seed','adoption-loss','adoption-review','adoption-approve','adoption-ui','adoption-ui-stage','adoption-ui-collect','adoption-final','adoption-inspect','adoption-collect','resource-prepare','resource-inspect','resource-seed','resource-disk','resource-memory','resource-recover','resource-collect','cache','cache-reset','cache-inspect','cache-ui-stage','cache-ui','cache-collect','ledger-seed','ledger-logon','ledger-orphan-create','ledger-check','ledger-final','ledger-deny','ledger-primary-loss','ledger-primary-corrupt','ledger-both-loss','ledger-restore','ledger-collect','oobe','reset-hyperv','collect-stop')][string]$Phase)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$directoryPath=[IO.Path]::GetFullPath($Directory)
if([IO.Path]::GetFileName($directoryPath) -notmatch '^clean-host-[a-f0-9-]{36}$'){throw 'Dedicated clean-host fixture required'}
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard=[MuPacketLabGuard]::new($OwnerPid,$directoryPath)
$session=$null;$report=$guard.Reserve('probe-'+[guid]::NewGuid().ToString('N')+'.json')
$machine=[IO.File]::ReadAllText((Join-Path $directoryPath 'machine.json')) | ConvertFrom-Json
$config=[IO.File]::ReadAllText((Join-Path $directoryPath 'config.json')) | ConvertFrom-Json
$credentials=[IO.File]::ReadAllText((Join-Path $directoryPath 'guest-seed/private/credentials.json')) | ConvertFrom-Json
function Save-Probe([string]$state,$result=$null) {
 [IO.File]::WriteAllText($report,(@{phase=$Phase;state=$state;time=[DateTime]::UtcNow.ToString('o');result=$result} | ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
}
function Assert-LabVM {
 if($machine.name -ne $config.name -or $machine.name -notmatch '^mu-win-clean-[a-f0-9]{32}$'){throw 'Diagnostic name changed'}
 $vm=Get-VM -Id ([guid]$machine.id) -ErrorAction Stop
 $expectedDisk=[IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'))
 $disks=@(Get-VMHardDiskDrive -VM $vm)
 if($vm.Name -ne $machine.name -or $vm.Notes -ne ('MuCodeSandbox clean Windows diagnostic '+$machine.name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne $expectedDisk -or [IO.Path]::GetFullPath($machine.disk) -ne $expectedDisk){throw 'Diagnostic VM identity changed'}
 if(@(Get-VMNetworkAdapter -VM $vm | Where-Object {$_.SwitchName}).Count){throw 'The clean Windows diagnostic must remain disconnected'}
 if(-not (Get-VMProcessor -VM $vm).ExposeVirtualizationExtensions){throw 'Nested virtualization is not exposed'}
 return $vm
}
function Connect-LabGuest {
 $vm=Assert-LabVM
 if($vm.State -ne 'Running'){throw 'Diagnostic guest must already be running'}
 $credential=[pscredential]::new([string]$credentials.adminUser,(ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force))
 $until=[DateTime]::UtcNow.AddMinutes(15)
 do{
  try{return New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop}catch{if([DateTime]::UtcNow -gt $until){throw 'PowerShell Direct is not ready; the evaluation guest is retained for inspection'};Start-Sleep -Seconds 3}
 }while($true)
}
try{
 $selected=Assert-LabVM
 if($Phase -eq 'resource-prepare'){
  if($selected.State -ne 'Off'){throw 'Capacity fixture expansion requires the evaluation VM Off'}
  $disk=[IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'));$vhd=Get-VHD -Path $disk
  if($vhd.ParentPath -or $vhd.Size -notin @(96GB,160GB)){throw 'Expected the known standalone evaluation VHDX'}
  if([IO.DriveInfo]::new([IO.Path]::GetPathRoot($disk)).AvailableFreeSpace -lt 176GB){throw 'Host free space is insufficient for the bounded 160 GiB pressure fixture'}
  if($vhd.Size -lt 160GB){Resize-VHD -Path $disk -SizeBytes 160GB}
  Start-VM -VM $selected | Out-Null
 }
 if($Phase -in @('ssh-inspect','network-prepare','ledger-seed','ledger-logon','power-inspect') -and $selected.State -eq 'Off'){Start-VM -VM $selected | Out-Null}
 Save-Probe 'connecting'
 $session=Connect-LabGuest
 $initial=Invoke-Command -Session $session -ScriptBlock {
  if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Synthetic guest administrator required'}
  if(-not (Test-Path -LiteralPath C:\MuLab\public\provisioned.json)){throw 'Guest bootstrap is incomplete'}
  [ordered]@{bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');hypervisor=[bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent;edition=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID}
 }
 if($Phase -eq 'resource-prepare'){
  $result=Invoke-Command -Session $session -ScriptBlock {
   if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or @(Get-VM).Count){throw 'Only the empty evaluation guest volume may be extended'}
   $partition=Get-Partition -DriveLetter C;$supported=Get-PartitionSupportedSize -DriveLetter C
   if($supported.SizeMax -gt $partition.Size){Resize-Partition -DriveLetter C -Size $supported.SizeMax | Out-Null}
   @{guestVolumeExtended=$true;guestVolumeBytes=(Get-Volume -DriveLetter C).Size;nestedGuests=0}
  }
  Save-Probe 'capacity-evaluation-volume-ready' $result;exit 0
 }
 if($Phase -eq 'power-inspect'){
  $value=Invoke-Command -Session $session -ScriptBlock {
   if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID -ne 'IoTEnterpriseSEval' -or @(Get-VM -ErrorAction Stop).Count){throw 'Power inspection requires the empty isolated evaluation guest'}
   $power=Join-Path $env:SystemRoot System32/powercfg.exe;$states=(& $power /a 2>&1|Out-String);if($LASTEXITCODE -ne 0){throw 'Power capabilities query failed'}
   $settings=Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
   @{availableStates=$states;hibernateEnabled=$settings.HibernateEnabled;hiberbootEnabled=$settings.HiberbootEnabled;bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');nestedGuests=0;settingsChanged=$false}
  }
  Assert-LabVM|Out-Null;Save-Probe 'power-capabilities-inspected' $value
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'power-capabilities-inspected-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase.StartsWith('power-')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-power-operator.ps1'))
  if($Phase -eq 'power-prepare-reset'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action prepare-reset};Save-Probe 'failed-synthetic-power-allocations-identified' $value;exit 0}
  if($Phase -eq 'power-progress'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action inspect};Save-Probe 'native-power-progress-inspected' $value;exit 0}
  if($Phase -eq 'power-collect'){
   $value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action collect}
   Assert-LabVM|Out-Null;Save-Probe 'native-power-evidence-collected' $value
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'native-power-complete-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase.StartsWith('resource-')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-resource-operator.ps1')).Replace('__METRICS_SOURCE__',[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../../native/windows/ResourceMetrics.cs'))))
  if($Phase -eq 'resource-inspect'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action inspect -Nonce ('0'*64)};Save-Probe 'resource-progress-inspected' $value;exit 0}
  if($Phase -eq 'resource-collect'){
   $evidence=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action collect -Nonce ('0'*64)}
   Assert-LabVM | Out-Null;Save-Probe 'resource-evidence-collected' $evidence
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'resources-complete-and-evaluation-vm-off' $evidence;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase.StartsWith('adoption-')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-adoption-operator.ps1'))
  if($Phase -eq 'adoption-inspect'){
   $value=Invoke-Command -Session $session -ScriptBlock {@{vms=@(Get-VM|Select-Object Name,@{Name='state';Expression={[string]$_.State}});clients=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -like '*client.mjs*adoption-*'}|Select-Object ProcessId,CreationDate);results=@(Get-ChildItem -LiteralPath C:\MuLab\public -File -Filter 'adoption-*-result.json'|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json});errors=@(Get-ChildItem -LiteralPath C:\MuLab\private -File -Filter 'adoption-*-broker-stderr.log'|ForEach-Object{@{name=$_.Name;bytes=$_.Length;text=$(if($_.Length){try{Get-Content -LiteralPath $_.FullName -Raw}catch{'log is still open by a running process'}}else{''})}})}}
   $value.storageAcl=Invoke-Command -Session $session -ScriptBlock {$seed=Get-Content -LiteralPath C:\MuLab\approved\adoption-seed-result.json -Raw|ConvertFrom-Json;$sid=(Get-LocalUser MuLabUser).SID.Value;$dir=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/vms/'+$seed.nested.config.id);foreach($file in @($dir,(Join-Path $dir disk.vhdx),(Join-Path $dir seed.iso))){if(Test-Path -LiteralPath $file){$acl=Get-Acl -LiteralPath $file;@{file=[IO.Path]::GetFileName($file);owner=$acl.Owner;rules=@($acl.Access|ForEach-Object{@{principal=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType}})}}}}
   Save-Probe 'adoption-progress-inspected' $value;exit 0
  }
  if($Phase -eq 'adoption-loss'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action loss};Save-Probe 'synthetic-copies-removed-for-explicit-adoption' $value;exit 0}
  if($Phase -in @('adoption-collect','adoption-ui-collect')){
   $action=if($Phase -eq 'adoption-ui-collect'){'collect-ui'}else{'collect'}
   $value=Invoke-Command -Session $session -ArgumentList $operatorSource,$action -ScriptBlock {param($source,$action) & ([ScriptBlock]::Create($source)) -Action $action}
   if($Phase -eq 'adoption-ui-collect'){$screenshot=$guard.Reserve('recovery-ui.png');Copy-Item -LiteralPath C:\MuLab\public\adoption-ui.png -Destination $screenshot -FromSession $session -Force;$value.screenshot=$screenshot}
   Assert-LabVM | Out-Null;Save-Probe 'adoption-evidence-collected' $value
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'adoption-complete-and-evaluation-vm-off' $value;exit 0};if($clock.ElapsedMilliseconds -gt 120000){throw 'Evaluation shutdown not confirmed'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase -eq 'cache-inspect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   @{vms=@(Get-VM | Select-Object Name,@{Name='state';Expression={[string]$_.State}});receipts=@(Get-ChildItem -LiteralPath C:\MuLab\approved -File -Filter 'cache-*.json' | Select-Object Name,LastWriteTime);clients=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*client.mjs*cache*'} | Select-Object ProcessId,CreationDate);result=$(if(Test-Path -LiteralPath C:\MuLab\public\cache-result.json){Get-Content C:\MuLab\public\cache-result.json -Raw | ConvertFrom-Json}else{$null})}
  }
  Save-Probe 'cache-progress-inspected' $evidence;exit 0
 }
 if($Phase -in @('cache-ui-stage','adoption-ui-stage')){
  Invoke-Command -Session $session -ScriptBlock {[IO.Directory]::CreateDirectory('C:\MuLab\test-tools') | Out-Null}
  foreach($tool in @(@{source='../../node_modules/electron/dist';target='C:\MuLab\test-tools\electron';file='electron.exe'},@{source='../../node_modules/playwright-core';target='C:\MuLab\test-tools\playwright-core';file='index.mjs'})){
   $source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot $tool.source));$present=Invoke-Command -Session $session -ArgumentList $tool.target,$tool.file -ScriptBlock {param($root,$file) Test-Path -LiteralPath (Join-Path $root $file)}
   if(-not $present){Copy-Item -LiteralPath $source -Destination $tool.target -ToSession $session -Recurse}
  }
  $dist=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../dist'));foreach($file in @(Get-ChildItem -LiteralPath $dist -File -Recurse)){$relative=$file.FullName.Substring($dist.Length+1);$target='C:\MuLab\product\resources\app\dist\'+$relative;Invoke-Command -Session $session -ArgumentList ([IO.Path]::GetDirectoryName($target)) -ScriptBlock {param($path) [IO.Directory]::CreateDirectory($path) | Out-Null};Copy-Item -LiteralPath $file.FullName -Destination $target -ToSession $session -Force}
  $uiFiles=if($Phase -eq 'adoption-ui-stage'){@('clean-host-recovery-ui.cjs','clean-host-recovery-ui.mjs')}else{@('clean-host-cache-ui.cjs','clean-host-cache-ui.mjs')}
  foreach($name in $uiFiles){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination ('C:\MuLab\'+$name.Replace('clean-host-','')) -ToSession $session -Force}
  Save-Probe 'local-only-cache-ui-tools-staged';exit 0
 }
 if($Phase -in @('cache','cache-ui','cache-reset','cache-collect')){
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-cache-operator.ps1'))
  if($Phase -eq 'cache-reset'){$value=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action reset -Nonce ('0'*64)};Save-Probe 'completed-cache-receipts-archived' $value;exit 0}
  if($Phase -eq 'cache-collect'){
   $evidence=Invoke-Command -Session $session -ArgumentList $operatorSource -ScriptBlock {param($source) & ([ScriptBlock]::Create($source)) -Action collect -Nonce ('0'*64)}
   $screenshot=$guard.Reserve('cache-ui.png');Copy-Item -LiteralPath C:\MuLab\public\cache-ui.png -Destination $screenshot -FromSession $session -Force
   Assert-LabVM | Out-Null;Save-Probe 'cache-evidence-collected' $evidence
   try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
   do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'cache-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
  }
 }
 if($Phase.StartsWith('ledger-')){
  if($Phase -eq 'ledger-logon'){
   Invoke-Command -Session $session -ScriptBlock {
    $ErrorActionPreference='Stop';$node='C:\MuLab\product\resources\node\node.exe';$c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
    if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $node -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Synthetic logon preparation requires no nested VM or live product process'}
    $task=Get-ScheduledTask -TaskName MuCleanHost-ledger-seed -ErrorAction SilentlyContinue
    if($task){if($task.State -eq 'Running' -or $task.Actions.Execute -ne $node -or $task.Actions.Arguments -ne '--no-warnings C:\MuLab\client.mjs ledger-seed'){throw 'Unexpected pending seed task'};Unregister-ScheduledTask -TaskName MuCleanHost-ledger-seed -Confirm:$false}
    $winlogon='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    foreach($pair in @(@('DefaultUserName',$c.user),@('DefaultDomainName',$env:COMPUTERNAME),@('DefaultPassword',$c.userPassword),@('AutoAdminLogon','1'))){Set-ItemProperty -LiteralPath $winlogon -Name $pair[0] -Value $pair[1] -Type String}
    Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 2 -Type DWord
   }
   Save-Probe 'restarting-only-empty-evaluation-guest-for-synthetic-user-logon'
   try{Invoke-Command -Session $session -ScriptBlock {Restart-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   exit 0
  }
  $operatorSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'clean-host-ledger-operator.ps1'))
  if($Phase -in @('ledger-primary-loss','ledger-primary-corrupt','ledger-both-loss','ledger-restore','ledger-orphan-create','ledger-collect')){
   $action=$Phase.Substring(7);$evidence=Invoke-Command -Session $session -ArgumentList $action,$operatorSource -ScriptBlock {param($action,$source) & ([ScriptBlock]::Create($source)) -Action $action}
   Assert-LabVM | Out-Null;Save-Probe 'ledger-operator-complete' $evidence
   if($Phase -eq 'ledger-collect'){
    try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
    Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
    do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'ledger-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
   }
   exit 0
  }
 }
 if($Phase -eq 'network-inspect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {$outer=Get-NetAdapter | Where-Object {$_.InterfaceDescription -eq 'Microsoft Hyper-V Network Adapter'};@{switches=@(Get-VMSwitch | Select-Object Name,Id,SwitchType);adapters=@(Get-NetAdapter -IncludeHidden | Select-Object Name,InterfaceGuid,InterfaceDescription,Status,MacAddress,ifIndex);outerDns=@(Get-DnsClientServerAddress -InterfaceIndex $outer.ifIndex | Select-Object AddressFamily,ServerAddresses);outerIp=@(Get-NetIPAddress -InterfaceIndex $outer.ifIndex | Select-Object AddressFamily,IPAddress,PrefixOrigin);outerDhcp=[string](Get-NetIPInterface -InterfaceIndex $outer.ifIndex -AddressFamily IPv4).Dhcp;nested=@(Get-VM | Select-Object Name,@{Name='state';Expression={[string]$_.State}});networkReceipts=@(Get-ChildItem -LiteralPath C:\MuLab\approved -File -Filter 'network-*.json' | Select-Object Name,LastWriteTime)}}
  Save-Probe 'network-inventory-complete' $evidence;exit 0
 }
 if($Phase -eq 'network-prepare'){
  $inputs=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.mu-data/windows-run/clean-host-network-inputs.json') -Raw | ConvertFrom-Json
  $inputsDirectory=[IO.Path]::GetFullPath($inputs.directory)
  if([IO.Path]::GetDirectoryName($inputsDirectory) -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.mu-data/windows-clean-host-assets')) -or [IO.Path]::GetFileName($inputsDirectory) -notmatch '^network-[a-f0-9-]{36}$'){throw 'Synthetic TLS fixture boundary changed'}
  foreach($name in @('fixture-key.pem','fixture-cert.pem','local-fixtures.js')){if((Get-FileHash -LiteralPath (Join-Path $inputsDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputs.hashes.$name){throw 'Synthetic TLS input changed'}}
  Invoke-Command -Session $session -ScriptBlock {if(@(Get-VM).Count -or (Get-VMSwitch -Name MuCleanNetwork -ErrorAction SilentlyContinue)){throw 'Network acceptance requires empty dedicated resources'};New-Item -ItemType Directory -Path C:\MuLab\network-fixtures -Force | Out-Null}
  foreach($name in @('fixture-key.pem','fixture-cert.pem')){Copy-Item -LiteralPath (Join-Path $inputsDirectory $name) -Destination ('C:\MuLab\network-fixtures\'+$name) -ToSession $session -Force}
  Copy-Item -LiteralPath (Join-Path $inputsDirectory 'local-fixtures.js') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\local-fixtures.js -ToSession $session -Force
  $outerAdapters=@(Get-VMNetworkAdapter -VM (Assert-LabVM));if($outerAdapters.Count -ne 1){throw 'Exactly one disconnected evaluation NIC is required'}
  $evidence=Invoke-Command -Session $session -ArgumentList $outerAdapters[0].MacAddress -ScriptBlock {
   param($mac) $ErrorActionPreference='Stop'
   if(Test-Path -LiteralPath C:\MuLab\approved\network-adapter.json){throw 'Network preparation evidence already exists; inspect it instead of replacing it'}
   $adapters=@(Get-NetAdapter | Where-Object {$_.MacAddress.Replace('-','') -eq $mac});if($adapters.Count -ne 1){throw 'Cannot uniquely bind the evaluation NIC'};$adapter=$adapters[0]
   $dhcp=[string](Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).Dhcp
   $dns4=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).ServerAddresses);$dns6=@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6).ServerAddresses)
   $legacy=@('fec0:0:0:ffff::1','fec0:0:0:ffff::2','fec0:0:0:ffff::3')
   if($adapter.Status -ne 'Disconnected' -or $dhcp -ne 'Enabled' -or $dns4.Count -or ($dns6.Count -and ($dns6 -join ',') -ne ($legacy -join ',')) -or @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.PrefixOrigin -eq 'Manual'}).Count){throw 'Only the unused DHCP evaluation NIC may be changed'}
   $record=@{interfaceGuid=[string]$adapter.InterfaceGuid;name=$adapter.Name;originalDhcp=$dhcp;originalDnsDefault=$true;originalDns6=$dns6;scope='the-outer-disconnected-nic-inside-the-windows-evaluation-guest'}
   [IO.File]::WriteAllText('C:\MuLab\approved\network-adapter.json',($record | ConvertTo-Json -Compress))
   New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.0.2.1 -PrefixLength 24 -AddressFamily IPv4 -PolicyStore ActiveStore | Out-Null
   return $record
  }
  Save-Probe 'synthetic-windows-network-prepared' $evidence;exit 0
 }
 if($Phase -eq 'network-collect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$result=Get-Content -LiteralPath C:\MuLab\approved\network-result.json -Raw | ConvertFrom-Json
   if(-not $result.complete -or -not $result.nested.removed -or @($result.nested.cases).Count -ne 3){throw 'All actual Windows network cases must pass'}
   $kinds=@($result.nested.cases | ForEach-Object {$_.kind} | Sort-Object);if(($kinds -join ',') -ne 'dns,link,route'){throw 'The three distinct Windows transitions are required'}
   foreach($case in $result.nested.cases){
    if(-not $case.started -or -not $case.detected -or -not $case.confirmedOff -or -not $case.removed){throw 'A Windows transition was not fully verified'}
    $receipt=Get-Content -LiteralPath ('C:\MuLab\approved\network-'+$case.kind+'-mutate.json') -Raw | ConvertFrom-Json
    if(-not $receipt.complete -or $receipt.nonce -ne $result.nonce -or $receipt.operation -ne 'mutate' -or $receipt.kind -ne $case.kind){throw 'The privileged network mutation receipt differs from the current owner result'}
   }
   if(@(Get-VM).Count){throw 'Nested VMs still remain'}
   $sid=(Get-LocalUser -Name MuLabUser).SID.Value;if(@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object {$_.SID.Value -eq $sid}).Count){throw 'The application user must remain ordinary'}
   $record=Get-Content -LiteralPath C:\MuLab\approved\network-adapter.json -Raw | ConvertFrom-Json
   $adapter=Get-NetAdapter -Name $record.name;if([string]$adapter.InterfaceGuid -ne $record.interfaceGuid -or $record.originalDhcp -ne 'Enabled' -or -not $record.originalDnsDefault){throw 'The diagnostic NIC identity changed'}
   if($adapter.Status -eq 'Disabled'){Enable-NetAdapter -Name $record.name -Confirm:$false}
   foreach($route in @(Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '198.51.100.0/24' -ErrorAction SilentlyContinue)){if($route.NextHop -ne '0.0.0.0' -or $route.RouteMetric -ne 1919){throw 'Unexpected synthetic route'};Remove-NetRoute -InputObject $route -Confirm:$false}
   Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.0.2.1 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
   Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -Dhcp Enabled;Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses
   if((Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).Dhcp -ne 'Enabled' -or @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress 192.0.2.1 -ErrorAction SilentlyContinue).Count -or @((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).ServerAddresses).Count -or (@((Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6).ServerAddresses) -join ',') -ne (@($record.originalDns6) -join ',')){throw 'Original diagnostic NIC configuration was not restored'}
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\network-client.mjs','C:\MuLab\product\resources\app\dist-server\scripts\windows\local-fixtures.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\service.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\monitor.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\manager.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\runtime.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
   @{result=$result;sourceHashes=$hashes;nestedGuestsRemaining=0;evaluationNicRestored=$true;physicalNetworkSwitchTested=$false;actualOsSleepTested=$false;aiWebsitesVisited=0}
  }
  Assert-LabVM | Out-Null;Save-Probe 'network-evidence-collected' $evidence
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'network-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'ssh-inspect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   @{capability=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;hyperV=[string](Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State;nestedGuests=@(Get-VM).Count;sshFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe);packages=@(Get-WindowsPackage -Online | Where-Object {$_.PackageName -match 'OpenSSH'} | Select-Object PackageName,PackageState);sources=@(Get-ChildItem -LiteralPath C:\Windows\servicing\Packages -Filter '*OpenSSH*' | Select-Object Name,Length);pendingReboot=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending');bootId=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');servicing=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'} | Select-Object ProcessId)}
  }
  Save-Probe 'ssh-inventory-complete' $evidence;exit 0
 }
 if($Phase -eq 'ssh-remove'){
  Save-Probe 'removing-only-the-evaluation-guest-ssh-client'
  $removed=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   if(@(Get-VM).Count){throw 'The isolated evaluation guest must contain no nested VMs'}
   if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Windows servicing is still running'}
   $capability=Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0'
   if($capability.State -ne 'Installed'){throw 'Inspect the previous removal instead of repeating it'}
   if(Test-Path -LiteralPath C:\MuLab\approved\ssh-removal.json){throw 'SSH removal evidence already exists; inspect it before another attempt'}
   $startup='C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk'
   if(Test-Path -LiteralPath $startup){if(Test-Path -LiteralPath C:\MuLab\private\ssh-prior-startup.lnk){throw 'Prior startup evidence already exists'};Move-Item -LiteralPath $startup -Destination C:\MuLab\private\ssh-prior-startup.lnk}
   $before=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
   $r=Remove-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction Stop
   $result=@{restartNeeded=[bool]$r.RestartNeeded;capability=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;sshFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe);keygenFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh-keygen.exe);bootBefore=$before;bootAfter=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');scope='only-disconnected-evaluation-guest'}
   [IO.File]::WriteAllText('C:\MuLab\approved\ssh-removal.json',($result | ConvertTo-Json -Compress));return $result
  }
  Save-Probe 'ssh-client-removed-from-evaluation-guest' $removed;exit 0
 }
 if($Phase -eq 'ssh-source'){
  # Fixed diagnostic-only source. Production servicing still uses Windows'
  # configured component source and never accepts caller-selected packages.
  $cab=Join-Path $PSScriptRoot '../../.mu-data/windows-clean-host-assets/fod-26100/OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab'
  if((Get-FileHash -LiteralPath $cab -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256'){throw 'Pinned official client CAB changed'}
  Invoke-Command -Session $session -ScriptBlock {
   if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Guests or servicing still remain'}
   if((Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State -ne 'NotPresent'){throw 'This test requires an actually missing client'}
   New-Item -ItemType Directory -Path C:\MuLab\private\fod -ErrorAction Stop | Out-Null
  }
  Copy-Item -LiteralPath $cab -Destination C:\MuLab\private\fod\OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab -ToSession $session
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$cab='C:\MuLab\private\fod\OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab'
   if((Get-FileHash -LiteralPath $cab -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256'){throw 'Guest CAB digest mismatch'}
   $policy='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Servicing'
   if(Test-Path -LiteralPath $policy){throw 'Do not replace an existing component source policy'}
   New-Item -Path $policy -Force | Out-Null;New-ItemProperty -LiteralPath $policy -Name LocalSourcePath -Value C:\MuLab\private\fod -PropertyType ExpandString | Out-Null
   @{cabSha256='6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256';source='Microsoft official Windows 11 24H2 FoD';policyScope='only-empty-evaluation-guest';productionScriptUnchanged=$true;networkDisconnected=$true}
  }
  Save-Probe 'offline-component-source-prepared' $evidence;exit 0
 }
 if($Phase -eq 'ssh-collect'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   $removed=Get-Content -LiteralPath C:\MuLab\approved\ssh-removal.json -Raw | ConvertFrom-Json
   $installed=Get-Content -LiteralPath C:\MuLab\approved\ssh-install-result.json -Raw | ConvertFrom-Json
   $ready=Get-Content -LiteralPath C:\MuLab\approved\ssh-ready-result.json -Raw | ConvertFrom-Json
   $sid=(Get-LocalUser -Name MuLabUser).SID.Value;$id=[guid]$installed.after.operation.id
   $job=Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/host-components/job-'+$id.ToString('D')+'.json')) -Raw | ConvertFrom-Json
   if(-not $installed.complete -or -not $ready.complete -or -not $installed.actualSshInstallationExercised -or -not $ready.nested.removed -or $job.status -ne 'completed' -or $job.changed -notcontains 'ssh-client' -or $removed.sshFile -or $removed.keygenFile){throw 'Actual missing-client installation and nested Linux acceptance must pass'}
   $offline=$null
   foreach($file in @(Get-ChildItem -LiteralPath C:\MuLab\private -File -Filter '*-ssh-install-result.json')){
    $prior=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if($prior.before.sshClientPresent -eq $false -and $prior.after.sshClientPresent -eq $false -and $prior.after.runtimeActive -eq $false -and $prior.after.operation.status -eq 'failed' -and $prior.after.operation.errorCode -eq -2145107924){
     $failedId=[guid]$prior.after.operation.id;$failedJob=Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/host-components/job-'+$failedId.ToString('D')+'.json')) -Raw | ConvertFrom-Json
     if($failedJob.status -eq 'failed' -and $failedJob.errorCode -eq -2145107924 -and $failedJob.bootId -eq $prior.before.bootId){$offline=@{operation=$prior.after.operation;runtimeActive=$false;ready=$false;protectedReceiptMatches=$true};break}
    }
   }
   if(-not $offline){throw 'The disconnected-source failure must also have a protected matching receipt'}
   if(@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Nested guests or servicing still remain'}
   if(@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object {$_.SID.Value -eq $sid}).Count){throw 'The application user must remain a standard user'}
   $policy='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Servicing'
   $key=Get-Item -LiteralPath $policy
   if($key.GetValue('LocalSourcePath') -ne 'C:\MuLab\private\fod' -or @($key.GetValueNames()).Count -ne 1 -or $key.SubKeyCount){throw 'The synthetic component policy changed; preserve it for inspection'}
   Remove-Item -LiteralPath $policy
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
   @{removed=$removed;installed=$installed;ready=$ready;offlineFailure=$offline;protectedJob=$job;sourceHashes=$hashes;syntheticSourcePolicyRemoved=$true;components=@{ssh=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;sshFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe);keygenFile=(Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh-keygen.exe)};nestedGuestsRemaining=0;applicationIsAdministrator=$false;aiWebsitesVisited=0}
  }
  Assert-LabVM | Out-Null;Save-Probe 'ssh-evidence-collected' $evidence
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'ssh-complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'collect-stop'){
  $evidence=Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$before=Get-Content -LiteralPath C:\MuLab\approved\before-reboot-result.json -Raw | ConvertFrom-Json;$after=Get-Content -LiteralPath C:\MuLab\approved\after-reboot-result.json -Raw | ConvertFrom-Json
   if(-not $before.complete -or -not $after.complete -or $before.after.operation.status -ne 'completed' -or -not $after.nested.removed){throw 'Both verified phases and nested cleanup must pass'}
   if(@(Get-VM).Count){throw 'Nested guest resources remain'}
   if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Windows servicing is still running'}
   $admins=@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Select-Object -ExpandProperty SID | ForEach-Object {$_.Value});$userSid=(Get-LocalUser -Name MuLabUser).SID.Value;if($admins -contains $userSid){throw 'The application account must remain a standard user'}
   $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\product\resources\node\node.exe','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs','C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1','C:\MuLab\product\resources\app\dist-server\server\platform\windows\runtime.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
   @{before=$before;after=$after;components=@{hyperV=[string](Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State;ssh=[string](Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').State;vmms=[string](Get-Service vmms).Status};applicationIsAdministrator=$false;nestedGuestsRemaining=0;sourceHashes=$hashes;aiWebsitesVisited=0}
  }
  Assert-LabVM | Out-Null;Save-Probe 'evidence-collected' $evidence
  try{Invoke-Command -Session $session -ScriptBlock {Stop-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null;$until=[DateTime]::UtcNow.AddMinutes(2)
  do{$vm=Assert-LabVM;if($vm.State -eq 'Off'){Save-Probe 'complete-and-evaluation-vm-off' $evidence;exit 0};if([DateTime]::UtcNow -gt $until){throw 'The evaluation VM has not confirmed shutdown'};Start-Sleep -Seconds 2}while($true)
 }
 if($Phase -eq 'reset-hyperv'){
  Save-Probe 'resetting-only-the-empty-evaluation-guest-role'
  try{Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop'
   if(@(Get-VM).Count){throw 'Nested guests must be removed before resetting this diagnostic role'}
   if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'}).Count){throw 'Windows component servicing is still running'}
   $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk');$link.Arguments='--no-warnings C:\MuLab\client.mjs before-reboot';$link.Save()
   Set-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoLogonCount -Value 4 -Type DWord
   $result=Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart -ErrorAction Stop
   [IO.File]::WriteAllText('C:\MuLab\public\reset-role.json',(@{nestedGuestsAbsent=$true;restartNeeded=[bool]$result.RestartNeeded;scope='only-this-evaluation-guest'} | ConvertTo-Json -Compress))
   Restart-Computer -Force
  }}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null
  $until=[DateTime]::UtcNow.AddMinutes(15)
  do{Start-Sleep -Seconds 5;try{$session=Connect-LabGuest;$boot=Invoke-Command -Session $session -ScriptBlock {(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')};if($boot -ne $initial.bootId){break};Remove-PSSession $session;$session=$null}catch{if($session){Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null}};if([DateTime]::UtcNow -gt $until){throw 'Evaluation role reset reboot has not completed'}}while($true)
  Save-Probe 'evaluation-role-reset-complete';exit 0
 }
 if($Phase -eq 'oobe'){
  Save-Probe 'preparing-supported-local-user-oobe'
  try{Invoke-Command -Session $session -ScriptBlock {
   $ErrorActionPreference='Stop';$c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
   $xml=@"
<?xml version="1.0" encoding="utf-8"?><unattend xmlns="urn:schemas-microsoft-com:unattend"><settings pass="oobeSystem"><component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><Reseal><Mode>OOBE</Mode><ForceShutdownNow>false</ForceShutdownNow></Reseal></component><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><AutoLogon><Password><Value>$($c.userPassword)</Value><PlainText>true</PlainText></Password><Domain>MU-CLEAN-LAB</Domain><Username>$($c.user)</Username><Enabled>true</Enabled><LogonCount>3</LogonCount></AutoLogon><OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE><TimeZone>UTC</TimeZone></component></settings></unattend>
"@
   [IO.File]::WriteAllText('C:\MuLab\private\oobe-unattend.xml',$xml,[Text.UTF8Encoding]::new($false))
   foreach($file in @('C:\Windows\Panther\Unattend\Unattend.xml','C:\Windows\Panther\Unattend.xml')){if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination ('C:\MuLab\private\prior-audit-'+[guid]::NewGuid().ToString('N')+'.xml');Remove-Item -LiteralPath $file}}
   $task=Get-ScheduledTask -TaskName MuCleanHost-before-reboot -ErrorAction SilentlyContinue;if($task){if($task.State -eq 'Running'){throw 'Stop the synthetic probe before OOBE transition'};Unregister-ScheduledTask -TaskName MuCleanHost-before-reboot -Confirm:$false}
   $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk');$link.TargetPath='C:\MuLab\product\resources\node\node.exe';$link.Arguments='--no-warnings C:\MuLab\client.mjs before-reboot';$link.WorkingDirectory='C:\MuLab\public';$link.WindowStyle=7;$link.Save()
   foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='sysprep.exe'")){if($process.ExecutablePath -eq 'C:\Windows\System32\Sysprep\sysprep.exe' -and $process.CommandLine -notmatch '/(oobe|audit|generalize|quiet)'){Stop-Process -Id $process.ProcessId -Force}}
   $started=Start-Process -FilePath C:\Windows\System32\Sysprep\sysprep.exe -ArgumentList @('/oobe','/reboot','/quiet','/unattend:C:\MuLab\private\oobe-unattend.xml') -WindowStyle Hidden -PassThru
   [IO.File]::WriteAllText('C:\MuLab\public\oobe-transition.json',(@{requested=$true;pid=$started.Id;syntheticStandardUser=$c.user} | ConvertTo-Json -Compress))
  }}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
  Save-Probe 'evaluation-guest-oobe-restart-requested';exit 0
 }
 if($Phase -eq 'inspect'){
  $diagnostic=Invoke-Command -Session $session -ScriptBlock {
   $tasks=@();foreach($name in @('MuCleanHost-before-reboot','MuCleanHost-after-reboot','MuCleanHost-ledger-seed','MuCleanHost-ledger-check','MuCleanHost-ledger-final','MuCleanHost-ledger-deny')){$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($task){$info=Get-ScheduledTaskInfo -TaskName $name;$tasks+=@{name=$name;state=[string]$task.State;lastResult=$info.LastTaskResult;user=$task.Principal.UserId;runLevel=[string]$task.Principal.RunLevel;logonType=[string]$task.Principal.LogonType;execute=$task.Actions.Execute;arguments=$task.Actions.Arguments}}}
   $files=@();foreach($file in @('C:\MuLab','C:\MuLab\public','C:\MuLab\client.mjs','C:\MuLab\product\resources\node\node.exe','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$acl=Get-Acl -LiteralPath $file;$files+=@{path=$file;protected=$acl.AreAccessRulesProtected;access=@($acl.Access | ForEach-Object {@{identity=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=$_.IsInherited}})}}
   $logs=@();foreach($file in Get-ChildItem -LiteralPath C:\MuLab\public -File | Where-Object {$_.Name -like '*-stderr.log' -or $_.Name -like '*-stdout.log' -or $_.Name -like '*-launcher.json'}){$logs+=@{name=$file.Name;text=([IO.File]::ReadAllText($file.FullName)).Substring(0,[math]::Min(8000,$file.Length))}}
   $setup=Get-ItemProperty 'HKLM:\SYSTEM\Setup';$owner=$null;if(Test-Path -LiteralPath C:\MuLab\public\before-reboot-owner.json){$owner=Get-Content -LiteralPath C:\MuLab\public\before-reboot-owner.json -Raw | ConvertFrom-Json;$process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$owner.pid);$owner=@{pid=$owner.pid;executable=$process.ExecutablePath;sid=$(if($process){(Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid}else{$null})}}
   $ledgerProcesses=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*client.mjs*ledger-*'} | Select-Object ProcessId,CreationDate,ExecutablePath)
   $ledgerEvents=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-15)} -ErrorAction SilentlyContinue | Where-Object {$_.Message -like '*node.exe*'} | Select-Object -First 4 Id,@{Name='message';Expression={$_.Message.Substring(0,[Math]::Min(1200,$_.Message.Length))}})
   @{tasks=$tasks;files=$files;logs=$logs;ledgerProcesses=$ledgerProcesses;ledgerEvents=$ledgerEvents;owner=$owner;loggedOnUser=(Get-CimInstance Win32_ComputerSystem).UserName;publicFiles=@(Get-ChildItem -LiteralPath C:\MuLab\public -File | Select-Object -ExpandProperty Name);users=@(Get-LocalUser -Name MuLabAdmin,MuLabUser | Select-Object Name,Enabled);groups=@(Get-LocalGroupMember -SID 'S-1-5-32-545' | Select-Object Name);setupInProgress=$setup.SystemSetupInProgress;auditInProgress=$setup.AuditInProgress;oobeInProgress=$setup.OOBEInProgress;sysprep=@(Get-CimInstance Win32_Process -Filter "Name='sysprep.exe'" | Select-Object ProcessId,CommandLine)}
  };Save-Probe 'inspected' @{initial=$initial;diagnostic=$diagnostic};exit 0
 }
 if($Phase -eq 'after-reboot'){
  $candidate=$null;foreach($file in @(Get-ChildItem -LiteralPath $directoryPath -File -Filter 'probe-*.json' | Sort-Object LastWriteTime -Descending)){$record=[IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json;if($record.phase -eq 'before-reboot' -and $record.result.complete -and $record.result.after.operation.status -eq 'completed'){$candidate=$record.result;break}}
  if(-not $candidate){throw 'A verified successful installation receipt is required'}
  $previous=Invoke-Command -Session $session -ArgumentList ($candidate | ConvertTo-Json -Depth 16 -Compress) -ScriptBlock {
   param($json) $r=$json | ConvertFrom-Json;$id=[guid]$r.after.operation.id;$sid=(Get-LocalUser -Name MuLabUser).SID.Value
   $job=Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$sid+'/host-components/job-'+$id.ToString('D')+'.json')) -Raw | ConvertFrom-Json
   if($job.status -ne 'completed' -or $job.bootId -ne $r.before.bootId -or $job.changed -notcontains 'hyperv'){throw 'Protected Windows servicing receipt differs from the tested owner result'}
   New-Item -ItemType Directory -Path C:\MuLab\approved -Force | Out-Null;[IO.File]::WriteAllText('C:\MuLab\approved\before-reboot-result.json',$json);return $r
  }
  if(-not $previous.after.operation.changed.Contains('hyperv') -or $previous.after.operation.status -in @('starting','running')){throw 'A terminal actual Hyper-V installation receipt is required before the operator restart'}
  if($initial.bootId -eq $previous.before.bootId){
   Invoke-Command -Session $session -ScriptBlock {$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\MuCleanHostProbe.lnk');$link.Arguments='--no-warnings C:\MuLab\client.mjs after-reboot';$link.Save()}
   Save-Probe 'operator-restarting-evaluation-guest'
   Assert-LabVM | Out-Null
   # This explicit diagnostic action restarts only the selected evaluation VM.
   # The application never performs this transition or reboots the host.
   try{Invoke-Command -Session $session -ScriptBlock {Restart-Computer -Force}}catch [System.Management.Automation.Remoting.PSRemotingTransportException]{}
   Remove-PSSession $session -ErrorAction SilentlyContinue;$session=$null
   Start-Sleep -Seconds 5;$session=Connect-LabGuest
  }
 }
 Save-Probe 'preparing-standard-user-probe'
 if($Phase.StartsWith('power-')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-power-client.mjs') -Destination C:\MuLab\power-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-channel.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\build-channel.ps1 -ToSession $session -Force
  foreach($name in @('runtime.js','manager.js','service.js','power.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
 }
 if($Phase.StartsWith('adoption-')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-adoption-client.mjs') -Destination C:\MuLab\adoption-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server/server/platform/windows/recovery.js') -Destination C:\MuLab\product\resources\app\dist-server\server\platform\windows\recovery.js -ToSession $session -Force
  if($Phase -eq 'adoption-ui'){foreach($name in @('recovery-service.js','recovery-candidates.js','recovery-wizard.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hyperv.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1 -ToSession $session -Force
 }
 if($Phase -eq 'network'){Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-network-client.mjs') -Destination C:\MuLab\network-client.mjs -ToSession $session -Force}
 if($Phase.StartsWith('ledger-') -or $Phase.StartsWith('resource-') -or $Phase.StartsWith('adoption-') -or $Phase.StartsWith('power-') -or $Phase -in @('cache','cache-ui')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-ledger-client.mjs') -Destination C:\MuLab\ledger-client.mjs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/ProtectedLedger.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\ProtectedLedger.cs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/HostComponents.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\HostComponents.cs -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/ImageCache.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\ImageCache.cs -ToSession $session -Force
  foreach($name in @('ResourceMetrics.cs','Resources.cs','Recovery.cs','RecoveryPermissions.cs','PowerWatch.cs','PowerProtection.cs','HyperVChannel.cs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../native/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\native\windows\'+$name) -ToSession $session -Force}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-channel.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\build-channel.ps1 -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-broker.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\build-broker.ps1 -ToSession $session -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../dist-server/server/platform/windows/broker.js') -Destination C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js -ToSession $session -Force
  if($Phase -in @('cache','cache-ui')){
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-cache-client.mjs') -Destination C:\MuLab\cache-client.mjs -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hyperv.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1 -ToSession $session -Force
   foreach($name in @('storage.js','service.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
  }
  if($Phase.StartsWith('resource-')){
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-resource-client.mjs') -Destination C:\MuLab\resource-client.mjs -ToSession $session -Force
   Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hyperv.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1 -ToSession $session -Force
   foreach($name in @('resources.js','runtime.js')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../../dist-server/server/platform/windows/'+$name)) -Destination ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\'+$name) -ToSession $session -Force}
  }
 }
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'clean-host-client.mjs') -Destination C:\MuLab\client.mjs -ToSession $session -Force
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../native/windows/HyperVBroker.cs') -Destination C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs -ToSession $session -Force
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host-components.ps1') -Destination C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1 -ToSession $session -Force
 $servicingHash=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'host-components.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
 Invoke-Command -Session $session -ArgumentList $servicingHash -ScriptBlock {param($hash) if(-not (Test-Path -LiteralPath C:\MuLab\private\package-original.json)){Copy-Item -LiteralPath C:\MuLab\private\package.json -Destination C:\MuLab\private\package-original.json};$m=Get-Content -LiteralPath C:\MuLab\private\package.json -Raw | ConvertFrom-Json;$m.hostScriptSha256=$hash;$m | ConvertTo-Json -Compress | Set-Content -LiteralPath C:\MuLab\private\package.json}
 $result=Invoke-Command -Session $session -ArgumentList $Phase,$operatorSource -ScriptBlock {
  param($phase,$operatorSource)
  $ErrorActionPreference='Stop';$node='C:\MuLab\product\resources\node\node.exe'
  $manifest=Get-Content -LiteralPath C:\MuLab\private\package.json -Raw | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.nodeSha256){throw 'Packaged Node digest changed'}
  if((Get-FileHash -LiteralPath C:\MuLab\product\resources\app\dist-server\scripts\windows\host-components.ps1 -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.hostScriptSha256){throw 'Packaged servicing script changed'}
  if($phase -in @('before-reboot','after-reboot','ssh-install','ssh-ready','network','resource-seed','resource-disk','resource-memory','resource-recover','cache','cache-ui','ledger-seed','ledger-check','ledger-final','ledger-deny') -or $phase.StartsWith('resource-') -or $phase.StartsWith('adoption-') -or $phase.StartsWith('power-')){
   $build=@'
import {buildBroker} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/broker.js';
import {writeFile} from 'node:fs/promises';
await writeFile('C:/MuLab/private/artifact.json',JSON.stringify(await buildBroker('C:/MuLab/private/build')));
'@
   [IO.File]::WriteAllText('C:\MuLab\private\build.mjs',$build)
   $priorPreference=$ErrorActionPreference;$ErrorActionPreference='Continue';$buildOutput=@(& $node --no-warnings C:\MuLab\private\build.mjs 2>&1);$buildExit=$LASTEXITCODE;$ErrorActionPreference=$priorPreference
   $buildText=$buildOutput | Out-String;[IO.File]::WriteAllText(('C:\MuLab\private\'+$phase+'-build.log'),$buildText)
   if($buildExit -ne 0){throw ('Guest broker build failed: '+$buildText.Substring([Math]::Max(0,$buildText.Length-6000)))}
   $artifact=Get-Content -LiteralPath C:\MuLab\private\artifact.json -Raw | ConvertFrom-Json
   & ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\MuLab\product\resources\app\dist-server\scripts\windows\install-broker.ps1'))) -Broker $artifact.broker -ExpectedBrokerHash $artifact.sha256 -Channel $artifact.channel -ExpectedChannelHash $artifact.channelSha256 -SourceDigest $artifact.sourceDigest
   if($LASTEXITCODE -ne 0){throw 'Guest protected broker installation failed'}
  }
  $c=Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
  $busy=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*'});if($busy.Count){throw 'Actual Windows servicing is still running; keep its owner and this VM alive'}
  $task='MuCleanHost-'+$phase;$old=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  # The supported OOBE autologon opens the synthetic standard user's own
  # interactive desktop. Its fixed Startup link launches the ordinary client.
  $ownerClock=[Diagnostics.Stopwatch]::StartNew();$ownerFile='C:\MuLab\public\'+$phase+'-owner.json'
  $live=$false
  if(Test-Path -LiteralPath $ownerFile){$previousOwner=[IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json;$previousProcess=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$previousOwner.pid);$live=$previousProcess -and $previousProcess.ExecutablePath -eq $node -and (Invoke-CimMethod -InputObject $previousProcess -MethodName GetOwnerSid).Sid -eq (Get-LocalUser -Name $c.user).SID.Value}
  if($old){
   if($old.Actions.Execute -ne $node -or $old.Principal.UserId -notin @($c.user,($env:COMPUTERNAME+'\'+$c.user),(Get-LocalUser -Name $c.user).SID.Value)){throw 'Existing diagnostic task identity changed'}
   if(-not $live){if($old.State -eq 'Running'){throw 'The previous diagnostic task is running without a verified owner; inspect it instead of restarting it'};Export-ScheduledTask -TaskName $task | Set-Content -LiteralPath ('C:\MuLab\private\'+$task+'-prior.xml');Unregister-ScheduledTask -TaskName $task -Confirm:$false}
  }
  if(-not $live){
   $attempt=[guid]::NewGuid().ToString('N');foreach($name in @(($phase+'-owner.json'),($phase+'-result.json'))){$file=Join-Path C:\MuLab\public $name;if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path C:\MuLab\private ($attempt+'-'+$name));Remove-Item -LiteralPath $file}}
   $principal=New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME+'\'+$c.user) -LogonType Interactive -RunLevel Limited
   $action=New-ScheduledTaskAction -Execute $node -Argument ('--no-warnings C:\MuLab\client.mjs '+$phase) -WorkingDirectory C:\MuLab\public
   $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;$settings.AllowDemandStart=$true
   Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)) | Out-Null;Start-ScheduledTask -TaskName $task
  }
  while(-not (Test-Path -LiteralPath $ownerFile)){
   if($ownerClock.ElapsedMilliseconds -gt 180000){throw 'The standard-user client did not start'};Start-Sleep -Milliseconds 250
  }
  $owner=[IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json;$ownerPid=$owner.pid;$nonce=$owner.nonce
  if($nonce -notmatch '^[a-f0-9]{64}$' -or [int]$ownerPid -le 0){throw 'Invalid standard-user endpoint'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$ownerPid)
  $expected=(Get-LocalUser -Name MuLabUser).SID.Value
  if($process.ExecutablePath -ne 'C:\MuLab\product\resources\node\node.exe' -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $expected){throw 'The diagnostic owner must be the synthetic standard-user Node client'}
  $bin=Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin';$meta=Get-Content -LiteralPath (Join-Path $bin 'current.json') -Raw | ConvertFrom-Json
  $broker=Join-Path $bin $meta.brokerFile
  if((Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.brokerSha256){throw 'Protected broker digest mismatch'}
  if($phase -in @('adoption-review','adoption-ui')){
   $start=[Diagnostics.ProcessStartInfo]::new($broker,('--owner '+$ownerPid+' --pipe '+$nonce+' --detect-host'));$start.WorkingDirectory=$bin;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardError=$true;$start.RedirectStandardOutput=$true
   $ordinary=[Diagnostics.Process]::Start($start);if(-not $ordinary.WaitForExit(30000)){throw 'Normal startup did not refuse missing registration copies'};$failure=$ordinary.StandardError.ReadToEnd()
   [IO.File]::WriteAllText('C:\MuLab\private\adoption-default-denied.log',$failure)
   if($ordinary.ExitCode -ne 1 -or $failure -notlike '*Unregistered VM storage remains*'){throw 'Normal startup failed for an unexpected reason'}
   [IO.File]::WriteAllText('C:\MuLab\approved\adoption-default-denied.json',(@{nonce=$nonce;normalStartupRejected=$true}|ConvertTo-Json -Compress))
  }
  if($phase -eq 'ledger-deny'){
   # Retain the actual process handle when startup is expected to exit quickly.
   $start=[Diagnostics.ProcessStartInfo]::new($broker,('--owner '+$ownerPid+' --pipe '+$nonce+' --detect-host'));$start.WorkingDirectory=$bin;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardError=$true;$start.RedirectStandardOutput=$true
   $agent=[Diagnostics.Process]::Start($start)
   if(-not $agent.WaitForExit(30000)){throw 'The missing-registry broker did not refuse startup'}
   $brokerFailure=$agent.StandardError.ReadToEnd();[IO.File]::WriteAllText('C:\MuLab\private\ledger-deny-broker-stderr.log',$brokerFailure)
   if($agent.ExitCode -ne 1 -or $brokerFailure -notlike '*Unregistered VM storage remains*'){throw ('The broker failed for an unexpected reason (exit '+$agent.ExitCode+'): '+$brokerFailure)}
   & ([ScriptBlock]::Create($operatorSource)) -Action deny -Nonce $nonce | Out-Null
  }else{$agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$ownerPid,'--pipe',$nonce,$(if($phase -in @('adoption-review','adoption-approve','adoption-ui')){'--recover-storage'}else{'--detect-host'})) -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ('C:\MuLab\private\'+$phase+'-broker-stdout.log') -RedirectStandardError ('C:\MuLab\private\'+$phase+'-broker-stderr.log') -PassThru}
  $handled=@{}
  function Invoke-SyntheticNetworkRequests {
   $record=Get-Content -LiteralPath C:\MuLab\approved\network-adapter.json -Raw | ConvertFrom-Json
   $adapter=Get-NetAdapter -Name $record.name;if([string]$adapter.InterfaceGuid -ne $record.interfaceGuid){throw 'The synthetic interface changed'}
   foreach($kind in @('link','dns','route')){foreach($operation in @('reset','mutate')){
    $name='network-'+$kind+'-'+$operation;$file=Join-Path C:\MuLab\public ($name+'.json')
    if($handled.ContainsKey($name) -or -not (Test-Path -LiteralPath $file)){continue}
    $request=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;if($request.nonce -ne $nonce){continue}
    if($request.kind -ne $kind -or $request.operation -ne $operation){throw 'Invalid synthetic network request'}
    if($operation -eq 'reset'){
     if($adapter.Status -eq 'Disabled'){Enable-NetAdapter -Name $record.name -Confirm:$false}
     Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses
     foreach($route in @(Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '198.51.100.0/24' -ErrorAction SilentlyContinue)){if($route.NextHop -ne '0.0.0.0' -or $route.RouteMetric -ne 1919){throw 'Unexpected synthetic route'};Remove-NetRoute -InputObject $route -Confirm:$false}
     Start-Sleep -Seconds 2
    }elseif($kind -eq 'link'){Disable-NetAdapter -Name $record.name -Confirm:$false}
    elseif($kind -eq 'dns'){Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses '203.0.113.53'}
    else{New-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '198.51.100.0/24' -NextHop '0.0.0.0' -RouteMetric 1919 -PolicyStore ActiveStore | Out-Null}
    [IO.File]::WriteAllText((Join-Path C:\MuLab\approved ($name+'.json')),(@{nonce=$nonce;kind=$kind;operation=$operation;complete=$true;scope='only-the-disconnected-nic-inside-the-windows-evaluation-guest'} | ConvertTo-Json -Compress));$handled[$name]=$true
   }}
  }
  $probeClock=[Diagnostics.Stopwatch]::StartNew();$resultFile='C:\MuLab\public\'+$phase+'-result.json'
  $ledgerInspected=$false
  do{
   if(Test-Path -LiteralPath $resultFile){$finished=[IO.File]::ReadAllText($resultFile) | ConvertFrom-Json;if($finished.pid -eq $ownerPid -and $finished.nonce -eq $nonce){
    New-Item -ItemType Directory -Path C:\MuLab\approved -Force | Out-Null;[IO.File]::WriteAllText(('C:\MuLab\approved\'+$phase+'-result.json'),($finished | ConvertTo-Json -Depth 16 -Compress))
    if($phase -eq 'ledger-check' -and $finished.complete){$scenario=$finished.nested.scenario;if($scenario -notin @('primary-loss','primary-corrupt')){throw 'Unexpected ledger recovery scenario'};[IO.File]::WriteAllText(('C:\MuLab\approved\ledger-'+$scenario+'-result.json'),($finished | ConvertTo-Json -Depth 16 -Compress))}
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue;return $finished
   }}
   if($agent.HasExited -and $phase -ne 'ledger-deny'){throw ('Protected broker exited: '+[IO.File]::ReadAllText(('C:\MuLab\private\'+$phase+'-broker-stderr.log')))}
   if($probeClock.ElapsedMilliseconds -gt 3900000){throw 'Servicing or the client is still running; no process or VM was stopped'}
   if($phase -eq 'network'){Invoke-SyntheticNetworkRequests}
   if($phase -eq 'power-run' -and -not $handled.ContainsKey('native-pause') -and (Test-Path -LiteralPath C:\MuLab\public\power-pause-request.json)){
    $request=Get-Content -LiteralPath C:\MuLab\public\power-pause-request.json -Raw|ConvertFrom-Json;if($request.nonce -eq $nonce){& ([ScriptBlock]::Create($operatorSource)) -Action broker-pause -Nonce $nonce -OwnerPid $ownerPid|Out-Null;$handled['native-pause']=$true}
   }
   if($phase -in @('adoption-review','adoption-approve','adoption-ui')){
    foreach($action in @('inspect-plan','change-seed','restore-seed','break-acl','restore-acl','break-permissions','restore-permissions','add-dependency','remove-dependency','inspect-adopted')){
     $name='adoption-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){$request=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;if($request.nonce -eq $nonce){if($request.action -ne $action){throw 'Unexpected adoption operator action'};& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce|Out-Null;$handled[$name]=$true}}
    }
   }
   if($phase -in @('cache','cache-ui')){
    foreach($action in @('seed','change','hold','remove-control','ui-seed','ui-change','permissions')){
     $name='cache-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){
      $request=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      if($request.nonce -eq $nonce){if($request.action -ne $action){throw 'Unexpected cache operator request'};& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce | Out-Null;$handled[$name]=$true}
     }
    }
   }
   if($phase.StartsWith('resource-')){
    foreach($action in @('hold-start','disk','memory')){
     $name='resource-'+$action;$file='C:\MuLab\public\'+$name+'-request.json'
     if(-not $handled.ContainsKey($name) -and (Test-Path -LiteralPath $file)){$request=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;if($request.nonce -eq $nonce){if($request.action -ne $action){throw 'Unexpected pressure operator action'};& ([ScriptBlock]::Create($operatorSource)) -Action $action -Nonce $nonce | Out-Null;$handled[$name]=$true}}
    }
   }
   if($phase -in @('ledger-check','ledger-final') -and -not $ledgerInspected -and (Test-Path -LiteralPath C:\MuLab\public\ledger-inspect-request.json)){
    $request=Get-Content -LiteralPath C:\MuLab\public\ledger-inspect-request.json -Raw | ConvertFrom-Json
    if($request.nonce -eq $nonce){& ([ScriptBlock]::Create($operatorSource)) -Action inspect -Nonce $nonce | Out-Null;$ledgerInspected=$true}
   }
   Start-Sleep -Seconds 2
  }while($true)
 }
 Assert-LabVM | Out-Null;Save-Probe 'finished' $result;if(-not $result.complete){exit 2};exit 0
}catch{Save-Probe 'failed' @{message=$_.Exception.Message;detail=$_.Exception.ToString();scriptStack=$_.ScriptStackTrace};throw}
finally{if($session){Remove-PSSession $session -ErrorAction SilentlyContinue};$guard.Dispose()}
