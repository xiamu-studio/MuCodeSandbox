[CmdletBinding()]
param([ValidateSet('hold-start','disk','memory','inspect','collect')][string]$Action,[string]$Nonce)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'MU-CLEAN-LAB' -or (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID -ne 'IoTEnterpriseSEval'){throw 'Dedicated evaluation guest required'}
if($Nonce -notmatch '^[a-f0-9]{64}$'){throw 'Bound synthetic owner nonce required'}
if(-not ('MuResourceMetrics' -as [type])){Add-Type -TypeDefinition ('using System;using System.IO;using System.Text;using System.Runtime.InteropServices;'+[Environment]::NewLine+[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__METRICS_SOURCE__')))}
$sid=(Get-LocalUser MuLabUser).SID.Value;$common=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MuCodeSandbox-HyperVBroker-v1';$root=Join-Path $common ('users/'+$sid)
function Receipt([string]$name,$value){$value.nonce=$Nonce;[IO.File]::WriteAllText(('C:\MuLab\approved\resource-'+$name+'.json'),($value | ConvertTo-Json -Depth 16 -Compress))}
function Released([string]$name){$file='C:\MuLab\public\resource-release-'+$name+'.json';if(-not (Test-Path -LiteralPath $file)){return $false};return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).nonce -eq $Nonce}
function Session {return (Get-Content -LiteralPath (Join-Path $root 'resource-session.json') -Raw | ConvertFrom-Json).session}
function Wait-Release([string]$name){$clock=[Diagnostics.Stopwatch]::StartNew();while(-not (Released $name)){if($clock.ElapsedMilliseconds -gt 120000){throw 'Synthetic pressure release was not acknowledged'};Start-Sleep -Milliseconds 100}}
function Trip([string]$session,[string]$reason){$file=Join-Path $root 'resource-trip.json';if(-not (Test-Path -LiteralPath $file)){return $null};$trip=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json;if($trip.session -eq $session -and $trip.reason -eq $reason){return $trip};return $null}
if($Action -eq 'inspect'){return @{metrics=([MuResourceMetrics]::Read($root));observed=$(if(Test-Path -LiteralPath C:\MuLab\approved\resource-memory-observed.json){Get-Content C:\MuLab\approved\resource-memory-observed.json -Raw | ConvertFrom-Json}else{$null});vms=@(Get-VM | Select-Object Name,@{Name='state';Expression={[string]$_.State}},MemoryAssigned);trip=$(if(Test-Path -LiteralPath (Join-Path $root 'resource-trip.json')){Get-Content -LiteralPath (Join-Path $root 'resource-trip.json') -Raw | ConvertFrom-Json}else{$null})}}
if($Action -eq 'hold-start'){
 $lock=[IO.File]::Open((Join-Path $common 'start.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{Receipt 'start-held' @{complete=$true};Wait-Release 'start'}finally{$lock.Dispose()};Receipt 'start-released' @{complete=$true};return
}
if($Action -in @('disk','memory')){
 $vms=@(Get-VM);if($vms.Count -ne 2 -or @($vms | Where-Object {$_.Notes -notlike 'MuCodeSandbox Windows preview mu-win-*'}).Count){throw 'Only the two synthetic native VMs may remain'}
 $session=Session
 if($Action -eq 'disk'){
  $file='C:\MuLab\private\resource-disk-pressure.bin';if(Test-Path -LiteralPath $file){throw 'Inspect the prior pressure file instead of replacing it'}
  $before=[MuResourceMetrics]::Read($root);if($before.freeDisk -lt 8GB){throw 'Evaluation volume must have at least 8 GiB before pressure testing'}
  $filler=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
   $filler.SetLength($before.freeDisk-1536MB);$filler.Flush($true);$actual=[MuResourceMetrics]::Read($root);if($actual.freeDisk -ge 2GB){throw 'Real volume pressure was not achieved'}
   Receipt 'disk-held' @{complete=$true;actualFreeBytes=$actual.freeDisk;session=$session};Wait-Release 'disk'
   $trip=Trip $session 'disk';if(-not $trip){throw 'The native disk fence did not produce its protected session receipt'}
   [IO.File]::WriteAllText('C:\MuLab\approved\resource-disk-trip.json',($trip | ConvertTo-Json -Compress))
  }finally{$filler.Dispose();[IO.File]::Delete($file)}
  Receipt 'disk-released' @{complete=$true;freeDiskBytes=([MuResourceMetrics]::Read($root)).freeDisk};return
 }
 if(-not ('MuSyntheticLockedMemoryLoad' -as [type])){Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Diagnostics;using System.Runtime.InteropServices;
public sealed class MuSyntheticLockedMemoryLoad:IDisposable {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr VirtualAlloc(IntPtr address,UIntPtr size,uint allocation,uint protection);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool VirtualFree(IntPtr address,UIntPtr size,uint mode);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool VirtualLock(IntPtr address,UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool VirtualUnlock(IntPtr address,UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessWorkingSetSize(IntPtr process,out UIntPtr min,out UIntPtr max);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetProcessWorkingSetSize(IntPtr process,UIntPtr min,UIntPtr max);
 readonly List<IntPtr> blocks=new List<IntPtr>();readonly List<int> lengths=new List<int>();readonly Process process=Process.GetCurrentProcess();readonly UIntPtr originalMin,originalMax;readonly long baseline;long allocated;
 public MuSyntheticLockedMemoryLoad(){if(!GetProcessWorkingSetSize(process.Handle,out originalMin,out originalMax))throw new Exception("Working set snapshot unavailable");baseline=process.WorkingSet64;}
 public void Add(int count){long min=checked(baseline+allocated+count+64L*1024*1024);if(!SetProcessWorkingSetSize(process.Handle,(UIntPtr)(ulong)min,(UIntPtr)(ulong)(min+128L*1024*1024)))throw new Exception("Bounded working set request failed: "+Marshal.GetLastWin32Error());var block=VirtualAlloc(IntPtr.Zero,(UIntPtr)(uint)count,0x3000,4);if(block==IntPtr.Zero)throw new Exception("Synthetic allocation failed");if(!VirtualLock(block,(UIntPtr)(uint)count)){VirtualFree(block,UIntPtr.Zero,0x8000);throw new Exception("Synthetic page lock failed: "+Marshal.GetLastWin32Error());}blocks.Add(block);lengths.Add(count);allocated+=count;for(int i=0;i<count;i+=4096)Marshal.WriteByte(block,i,123);}
 public void Touch(){for(int n=0;n<blocks.Count;n++)for(int i=0;i<lengths[n];i+=4096)Marshal.WriteByte(blocks[n],i,123);}
 public void Dispose(){for(int n=0;n<blocks.Count;n++){VirtualUnlock(blocks[n],(UIntPtr)(uint)lengths[n]);VirtualFree(blocks[n],UIntPtr.Zero,0x8000);}blocks.Clear();lengths.Clear();SetProcessWorkingSetSize(process.Handle,originalMin,originalMax);process.Dispose();}
}
'@}
 $memory=[MuSyntheticLockedMemoryLoad]::new();$before=[MuResourceMetrics]::Read($root);$budget=[Math]::Max([long]0,$before.availableMemory-384MB);if($budget -gt 4GB){$memory.Dispose();throw 'Start a bounded synthetic VM before the memory-pressure test'}
 try{
  [long]$allocated=0
  $clock=[Diagnostics.Stopwatch]::StartNew()
  while(-not (Trip $session 'memory')){
   $actual=[MuResourceMetrics]::Read($root);$remaining=[Math]::Min([long](4GB-$allocated),[Math]::Max([long]0,$actual.availableMemory-384MB))
   if($remaining -gt 0){$count=[int][Math]::Min([long]64MB,$remaining);$memory.Add($count);$allocated+=$count}else{$memory.Touch()}
   if($clock.ElapsedMilliseconds -gt 90000){Receipt 'memory-observed' @{before=$before;allocatedBytes=$allocated;after=([MuResourceMetrics]::Read($root));session=$session};throw 'Real critical memory pressure was not observed'}
   Start-Sleep -Milliseconds 100
  }
  $trip=Trip $session 'memory';[IO.File]::WriteAllText('C:\MuLab\approved\resource-memory-trip.json',($trip | ConvertTo-Json -Compress));Receipt 'memory-held' @{complete=$true;session=$session;allocatedBytes=$allocated;nativeTrip=$trip};Wait-Release 'memory'
 }finally{$memory.Dispose()}
 Receipt 'memory-released' @{complete=$true;availableMemoryBytes=([MuResourceMetrics]::Read($root)).availableMemory};return
}
if($Action -eq 'collect'){
 $results=@{};foreach($phase in @('resource-seed','resource-disk','resource-memory','resource-recover')){$r=Get-Content -LiteralPath ('C:\MuLab\approved\'+$phase+'-result.json') -Raw | ConvertFrom-Json;if(-not $r.complete){throw ('Incomplete resource phase '+$phase)};$results[$phase]=$r}
 if(@(Get-VM).Count -or -not $results['resource-recover'].nested.removed -or (Test-Path -LiteralPath C:\MuLab\private\resource-disk-pressure.bin)){throw 'Resource test cleanup is incomplete'}
 $registry=Get-Content -LiteralPath (Join-Path $root 'vms.json') -Raw | ConvertFrom-Json;if(@($registry.records.PSObject.Properties).Count){throw 'Protected allocations remain'}
 $hashes=@{};foreach($file in @('C:\MuLab\client.mjs','C:\MuLab\resource-client.mjs','C:\MuLab\product\resources\app\dist-server\native\windows\HyperVBroker.cs','C:\MuLab\product\resources\app\dist-server\native\windows\Resources.cs','C:\MuLab\product\resources\app\dist-server\native\windows\ResourceMetrics.cs','C:\MuLab\product\resources\app\dist-server\scripts\windows\hyperv.ps1','C:\MuLab\product\resources\app\dist-server\server\platform\windows\runtime.js','C:\MuLab\product\resources\app\dist-server\server\platform\windows\broker.js')){$hashes[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
 $winlogon='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon';if((Get-ItemProperty -LiteralPath $winlogon).DefaultUserName -eq 'MuLabUser'){Remove-ItemProperty -LiteralPath $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue;Set-ItemProperty -LiteralPath $winlogon -Name AutoAdminLogon -Value '0' -Type String;Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 0 -Type DWord}
 return @{results=$results;sourceHashes=$hashes;nestedGuestsRemaining=0;syntheticAutologonDisabled=$true;diskPressureReleased=$true;aiWebsitesVisited=0}
}
