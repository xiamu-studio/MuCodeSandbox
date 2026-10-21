param([Parameter(Mandatory)][string]$Source,[ValidateSet('clock','registration','events')][string]$Case)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ('using System;using System.IO;using System.Threading;using System.Runtime.InteropServices;'+[IO.File]::ReadAllText($Source))
function Check([bool]$value,[string]$message){if(-not $value){throw $message}}
if($Case -eq 'clock'){
 Check ($null -eq [MuPowerContinuity]::Check(1010,1010,10100000,10100000,1000,10000000,0)) 'A continuous clock was rejected'
 Check ([MuPowerContinuity]::Check(7000,7000,70000000,70000000,1000,10000000,0) -eq 'monitor-gap') 'A stalled native process was accepted'
 Check ([MuPowerContinuity]::Check(1100,1100,8000000,11000000,1000,10000000,0) -eq 'resume') 'New sleep bias was accepted'
 Check ([MuPowerContinuity]::Check(1010,1010,10100000,40000000,1000,10000000,0) -eq 'clock-change') 'Wall clock discontinuity was accepted'
 Check ([MuPowerContinuity]::Check(900,900,9000000,9000000,1000,10000000,0) -eq 'monitor-gap') 'A reversed clock was accepted'
 Check ([MuPowerContinuity]::Check(1000,3000,30000000,30000000,1000,10000000,0) -eq 'monitor-unavailable') 'An ambiguous clock sample was accepted'
 Check ($null -eq [MuPowerContinuity]::Check(1010,1010,10200000,10100000,1000,10000000,0)) 'Tick quantization caused a false resume'
 return
}
$source=@'
public static class MuPowerTestReceiver {public static int Count;public static void Trip(){System.Threading.Interlocked.Increment(ref Count);}}
'@
Add-Type -TypeDefinition $source
$watch=[MuPowerWatch]::new([Delegate]::CreateDelegate([Action],[MuPowerTestReceiver].GetMethod('Trip')))
try{
 if($Case -eq 'registration'){for($i=0;$i -lt 50;$i++){$watch.Check();Start-Sleep -Milliseconds 10};Check (-not $watch.Fenced -and [MuPowerTestReceiver]::Count -eq 0) 'A live notification subscription fenced without a power event';return}
 $notify=[MuPowerWatch].GetMethod('Notify',[Reflection.BindingFlags]'NonPublic,Instance');[void]$notify.Invoke($watch,@([IntPtr]::Zero,[uint32]4,[IntPtr]::Zero));[void]$notify.Invoke($watch,@([IntPtr]::Zero,[uint32]18,[IntPtr]::Zero));Check ($watch.Fenced -and $watch.Issue -eq 'suspend' -and [MuPowerTestReceiver]::Count -eq 1) 'Power notifications did not close exactly one epoch'
 $rejected=$false;try{$watch.Check()}catch{$rejected=$true};Check $rejected 'A fenced power epoch became healthy again'
}finally{$watch.Dispose()}
