#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$LabProfilePath)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$c=[IO.File]::ReadAllText($LabProfilePath) | ConvertFrom-Json
if($c.version -ne 1 -or $c.nonce -notmatch '^[a-f0-9]{64}$' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LabProfilePath))) -ne ('packet-lab-'+[guid]$c.subjectId)){throw 'Invalid fresh packet lab profile'}
if([DateTime]::Parse($c.createdAt).ToUniversalTime() -lt [DateTime]::UtcNow.AddMinutes(-5) -or [DateTime]::Parse($c.createdAt).ToUniversalTime() -gt [DateTime]::UtcNow.AddSeconds(30) -or $c.subjectId -eq $c.sinkId){throw 'Packet lab creation window expired'}
$guard=[MuPacketLabGuard]::new([int]$c.ownerPid,[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LabProfilePath)))
$mutex=[Threading.Mutex]::new($false,'Global\MuCodeSandbox.PacketLab.v1')
$locked=$false;$captureStarted=$false;$filterAdded=$false;$controlOpen=$false;$sinkChanged=$false;$ownFilter=$null;$cleanupErrors=@();$traceKey=$null
$pkt=Join-Path ([Environment]::GetFolderPath('Windows')) 'System32/pktmon.exe'
function PacketCommand([string[]]$PacketArguments){$value=& $pkt @PacketArguments 2>&1 | Out-String;if($LASTEXITCODE -ne 0){throw ('Pktmon command failed: '+$PacketArguments[0])};return $value.Trim()}
function Idle([string]$value){return $value -match '\u6ca1\u6709\u8fd0\u884c|not running'}
function EmptyFilters([string]$value){return $value -match '(?s)^\s*(\u6570\u636e\u5305\u7b5b\u9009\u5668|Packet [Ff]ilters):\s*(\u65e0|None)\s*$'}
function WriteResult([string]$name,$value){$file=$guard.Reserve($name);[IO.File]::WriteAllText($file,($value | ConvertTo-Json -Depth 24 -Compress),[Text.UTF8Encoding]::new($false))}
function Owned([guid]$id,[guid]$platform){
 $vm=Get-VM -Id $platform -ErrorAction Stop;$name='mu-win-'+$id.ToString('N')
 $expected=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('MuCodeSandbox-HyperVBroker-v1\users\'+$guard.Sid+'\vms\'+$id.ToString('D'))
 if($vm.Name -ne $name -or $vm.Notes -ne ('MuCodeSandbox Windows preview '+$name)){throw 'Fresh diagnostic VM name/ownership changed'}
 $actual=[IO.Path]::GetFullPath($vm.Path).TrimEnd('\');$disks=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
 if(($actual -ne $expected -and -not $actual.StartsWith($expected+'\',[StringComparison]::OrdinalIgnoreCase)) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne (Join-Path $expected 'disk.vhdx')){throw 'Diagnostic VM storage is outside its registered allocation'}
 if($vm.CreationTime.ToUniversalTime() -lt ([DateTime]::Parse($c.createdAt).ToUniversalTime().AddSeconds(-5))){throw 'Diagnostic VM predates this fresh experiment'}
 $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop);if($nics.Count -ne 1 -or $vm.AutomaticStartAction -ne 'Nothing'){throw 'Diagnostic VM topology changed'}
 return $vm
}
function PrivateSwitch($vm){$nic=Get-VMNetworkAdapter -VM $vm;$switch=Get-VMSwitch -Id $nic.SwitchId -ErrorAction Stop;if($switch.SwitchType -ne 'Private' -or $switch.Name -ne $vm.Name -or $switch.Notes -ne $vm.Notes -or @(Get-VMNetworkAdapter -ManagementOS -ErrorAction Stop | Where-Object {$_.SwitchId -eq $switch.Id}).Count -or @(Get-VM -ErrorAction Stop | Get-VMNetworkAdapter | Where-Object {$_.SwitchId -eq $switch.Id}).Count -ne 1){throw 'Diagnostic switch has an unexpected connection'};return $switch}
function ClosedAcl($vm){$rules=@(Get-VMNetworkAdapterExtendedAcl -VM $vm -ErrorAction Stop);if($rules.Count -ne 2){throw 'Expected exactly two closed IP ACLs'};foreach($direction in @('Inbound','Outbound')){if(@($rules | Where-Object {[string]$_.Direction -eq $direction -and [string]$_.Action -eq 'Deny' -and $_.Weight -eq 1 -and [string]$_.LocalIPAddress -eq 'ANY' -and [string]$_.RemoteIPAddress -eq 'ANY'}).Count -ne 1){throw 'Diagnostic ACL changed'}}}
function RestoreAcl($vm){Get-VMNetworkAdapterExtendedAcl -VM $vm | Remove-VMNetworkAdapterExtendedAcl;foreach($direction in @('Inbound','Outbound')){Add-VMNetworkAdapterExtendedAcl -VM $vm -Action Deny -Direction $direction -LocalIPAddress ANY -RemoteIPAddress ANY -Weight 1};ClosedAcl $vm}
function VerifyFilter{if((PacketCommand @('filter','list')) -ne $ownFilter){throw 'Another packet filter changed during the experiment'}}
function StopOwnCapture{
 if($captureStarted){$state=PacketCommand @('status');if(Idle $state){throw 'Packet trace stopped unexpectedly'};VerifyFilter;$identity=[MuPacketLabGuard]::CaptureIdentity();if($identity.key -ne $traceKey){throw 'Pktmon trace identity changed; foreign capture preserved'};if($identity.lostEvents -ne 0){$script:cleanupErrors+='Host trace reported lost events'};PacketCommand @('stop') | Out-Null;if(-not (Idle (PacketCommand @('status')))){throw 'Packet capture stop was not confirmed'};$script:captureStarted=$false}
}
try{
 $locked=$mutex.WaitOne(0);if(-not $locked){throw 'Another MuCodeSandbox packet experiment is active'}
 if(-not (Idle (PacketCommand @('status'))) -or -not (EmptyFilters (PacketCommand @('filter','list')))){throw 'Existing pktmon session or filters preserved; packet experiment cannot start'}
 $subject=Owned ([guid]$c.subjectId) ([guid]$c.subjectPlatformId);$sink=Owned ([guid]$c.sinkId) ([guid]$c.sinkPlatformId)
 if($subject.State -ne 'Off' -or $sink.State -ne 'Off'){throw 'Fresh packet subjects must be off before observation'}
 $subjectSwitch=PrivateSwitch $subject;$sinkSwitch=PrivateSwitch $sink;ClosedAcl $subject;ClosedAcl $sink
 $subjectMac=(Get-VMNetworkAdapter -VM $subject).MacAddress;$sinkMac=(Get-VMNetworkAdapter -VM $sink).MacAddress
 if($subjectMac -eq $sinkMac -or @((Get-VM -ErrorAction Stop | Get-VMNetworkAdapter) | Where-Object {$_.MacAddress -eq $subjectMac}).Count -ne 1 -or @(Get-NetAdapter | Where-Object {$_.MacAddress -and $_.MacAddress.Replace('-','') -eq $subjectMac}).Count){throw 'Subject MAC is not exclusive to the fresh VM'}
 # Converters require nonexistent output files. The pinned administrator-only
 # directory prevents user path replacement until capture/conversion is over.
 $artifacts=$guard.CreateArtifacts();$etl=Join-Path $artifacts 'PktMon.etl';$flow=Join-Path $artifacts 'flow.pcapng';$drop=Join-Path $artifacts 'drop.pcapng';$txt=Join-Path $artifacts 'capture.txt';$stats=Join-Path $artifacts 'statistics.txt'
 Set-Location -LiteralPath $artifacts
 $filterName='MuPacket-'+$c.nonce.Substring(0,16);$mac=($subjectMac -replace '(.{2})(?=.)','$1-')
 PacketCommand @('filter','add',$filterName,'-m',$mac) | Out-Null;$filterAdded=$true;$ownFilter=PacketCommand @('filter','list')
 PacketCommand @('start','--capture','--comp','all','--type','all','--pkt-size','256','--file-size','32','--log-mode','memory') | Out-Null;$captureStarted=$true
 try{$traceKey=([MuPacketLabGuard]::CaptureIdentity()).key}catch{VerifyFilter;PacketCommand @('stop') | Out-Null;$captureStarted=$false;throw}
 $captureAt=[DateTime]::UtcNow.ToString('o')
 # The sink is another empty, freshly allocated VM. It has no host uplink and
 # observes raw Ethernet before its own Linux IP firewall; it never forwards.
 Get-VMNetworkAdapter -VM $sink | Connect-VMNetworkAdapter -VMSwitch $subjectSwitch;$sinkChanged=$true
 Get-VMNetworkAdapterExtendedAcl -VM $sink | Remove-VMNetworkAdapterExtendedAcl
 Start-VM -VM $sink | Out-Null
 WriteResult 'ready.json' @{pid=$PID;captureStartedAt=$captureAt;subjectMac=$subjectMac;sinkMac=$sinkMac;subjectSwitchId=[string]$subjectSwitch.Id;noHostAdapter=$true;traceKey=$traceKey}
 $sequence=1;$until=[DateTime]::UtcNow.AddMinutes(12)
 while(-not $guard.Owner.HasExited -and [DateTime]::UtcNow -lt $until){
  $command='command-'+$sequence+'.json';$commandPath=Join-Path $guard.DirectoryPath $command
  if(-not [IO.File]::Exists($commandPath)){Start-Sleep -Milliseconds 100;continue}
  try{$request=$guard.ReadCommand($command) | ConvertFrom-Json;if(@($request.PSObject.Properties.Name | Where-Object {$_ -notin @('nonce','action')}).Count -or $request.nonce -ne $c.nonce -or $request.action -notin @('snapshot','control-open','control-close','finish')){throw 'Invalid diagnostic command'}}catch{WriteResult ('reply-'+$sequence+'.json') @{ok=$false;error='Invalid diagnostic command'};$sequence++;continue}
  try{
   VerifyFilter;$subject=Owned ([guid]$c.subjectId) ([guid]$c.subjectPlatformId);$sink=Owned ([guid]$c.sinkId) ([guid]$c.sinkPlatformId)
   if((Get-VMNetworkAdapter -VM $subject).SwitchId -ne $subjectSwitch.Id -or (Get-VMNetworkAdapter -VM $sink).SwitchId -ne $subjectSwitch.Id -or (Get-VMSwitch -Id $subjectSwitch.Id).SwitchType -ne 'Private' -or @(Get-VM -ErrorAction Stop | Get-VMNetworkAdapter | Where-Object {$_.SwitchId -eq $subjectSwitch.Id}).Count -ne 2){throw 'Capture topology changed'}
   $identity=[MuPacketLabGuard]::CaptureIdentity();if($identity.key -ne $traceKey -or $identity.lostEvents -ne 0){throw 'Trace changed or reported lost events'}
   switch($request.action){
    'snapshot' {WriteResult ('reply-'+$sequence+'.json') @{ok=$true;capturedAt=[DateTime]::UtcNow.ToString('o');traceIdentity=$identity;counters=(PacketCommand @('counters','--json'));components=(PacketCommand @('list','--json'))}}
    'control-open' {ClosedAcl $subject;Get-VMNetworkAdapterExtendedAcl -VM $subject | Remove-VMNetworkAdapterExtendedAcl;$controlOpen=$true;WriteResult ('reply-'+$sequence+'.json') @{ok=$true}}
    'control-close' {RestoreAcl $subject;$controlOpen=$false;WriteResult ('reply-'+$sequence+'.json') @{ok=$true}}
    'finish' {WriteResult ('reply-'+$sequence+'.json') @{ok=$true};break}
   }
  }catch{WriteResult ('reply-'+$sequence+'.json') @{ok=$false;error=$_.Exception.Message};throw}
  if($request.action -eq 'finish'){break};$sequence++
 }
}catch{try{WriteResult 'error.json' @{error=$_.Exception.Message}}catch{}}
finally{
 try{if($controlOpen){RestoreAcl (Owned ([guid]$c.subjectId) ([guid]$c.subjectPlatformId));$controlOpen=$false}}catch{$cleanupErrors+='Subject ACL restoration failed'}
 try{if($sinkChanged){$sink=Owned ([guid]$c.sinkId) ([guid]$c.sinkPlatformId);if($sink.State -ne 'Off'){Stop-VM -VM $sink -TurnOff -Force};Get-VMNetworkAdapter -VM $sink | Connect-VMNetworkAdapter -VMSwitch $sinkSwitch;RestoreAcl $sink}}catch{$cleanupErrors+='Sink restoration failed'}
 try{StopOwnCapture}catch{$cleanupErrors+='Capture ownership/stop verification failed'}
 try{if($filterAdded){if($captureStarted){throw 'Capture is still active; filters preserved'};VerifyFilter;PacketCommand @('filter','remove') | Out-Null;if(-not (EmptyFilters (PacketCommand @('filter','list')))){throw 'Filter cleanup not confirmed'}}}catch{$cleanupErrors+='Changed filters were preserved'}
 try{
  if(-not $captureStarted -and $etl -and [IO.File]::Exists($etl) -and (Get-Item -LiteralPath $etl).Length -gt 0){
   PacketCommand @('etl2pcap',$etl,'--out',$flow) | Out-Null;PacketCommand @('etl2pcap',$etl,'--out',$drop,'--drop-only') | Out-Null
   PacketCommand @('etl2txt',$etl,'--out',$txt,'--timestamp','--hex','--verbose') | Out-Null
   [IO.File]::WriteAllText($stats,(PacketCommand @('etl2txt',$etl,'--stats')),[Text.UTF8Encoding]::new($false))
   $guard.PublishArtifacts()
  }
 }catch{$cleanupErrors+='Capture conversion failed'}
 try{WriteResult 'finished.json' @{cleanupErrors=$cleanupErrors;restored=($cleanupErrors.Count -eq 0);endedAt=[DateTime]::UtcNow.ToString('o')}}catch{}
 if($locked){$mutex.ReleaseMutex()};$mutex.Dispose();$guard.Dispose()
}
