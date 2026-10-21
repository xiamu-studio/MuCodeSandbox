[CmdletBinding()]
param([string]$Directory,[string]$Native,[ValidateSet('disk','memory','quota','metrics')][string]$Case)
$ErrorActionPreference='Stop'
$header='using System;using System.IO;using System.Linq;using System.Text;using System.Threading;using System.Collections.Generic;using System.Security.Cryptography;using System.Runtime.InteropServices;'
$cache=[IO.File]::ReadAllText((Join-Path $Native 'ImageCache.cs')).Split(@('public sealed class MuCacheView'),[StringSplitOptions]::None)[0]
$policy=[IO.File]::ReadAllText((Join-Path $Native 'Resources.cs')).Split(@('public static partial class MuHyperVBroker'),[StringSplitOptions]::None)[0]
Add-Type -TypeDefinition ($header+[Environment]::NewLine+$cache+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native 'ResourceMetrics.cs'))+[Environment]::NewLine+$policy) -ReferencedAssemblies @('System.dll','System.Core.dll')
function Check([bool]$value,[string]$message){if(-not $value){throw $message}}
function Reject([scriptblock]$work,[string]$code){$done=$false;try{& $work}catch{$e=$_.Exception.GetBaseException();if($e -is [MuStorageException]){if($e.Code -ne $code){throw $e}}elseif($e.GetType().Name -ne $code){throw $e};$done=$true};Check $done 'Invalid resource admission succeeded'}
switch($Case){
 'disk' {
  Check ([MuResourceMetrics]::DiskFootprint(32GB) -gt 32GB+64MB) 'Disk format overhead was not reserved'
  Check ([MuResourceMetrics]::DiskFootprint(1GB) -eq 1GB+64MB) 'Minimum disk metadata reserve is missing'
  [MuResourcePolicy]::DiskRequest(44GB,10GB,32GB)
  Reject {[MuResourcePolicy]::DiskRequest(44GB-1,10GB,32GB)} 'RESOURCE_DISK'
  Reject {[MuResourcePolicy]::DiskRequest(2GB-1,0,0)} 'RESOURCE_DISK'
  Reject {[MuResourcePolicy]::DiskRequest([long]::MaxValue,[long]::MaxValue,1)} 'RESOURCE_DISK'
  Reject {[MuResourcePolicy]::DiskRequest(1,0,-1)} 'ArgumentException'
 }
 'memory' {
  Check ([MuResourcePolicy]::MemoryReserve(10GB) -eq 1GB -and [MuResourcePolicy]::MemoryCritical(10GB) -eq 512MB) 'Incorrect memory floors'
  [MuResourcePolicy]::MemoryRequest(10GB,7GB,6GB)
  Reject {[MuResourcePolicy]::MemoryRequest(10GB,7GB-1,6GB)} 'RESOURCE_MEMORY'
  Reject {[MuResourcePolicy]::MemoryRequest(10GB,10GB,8GB+1)} 'RESOURCE_MEMORY'
  Reject {[MuResourcePolicy]::MemoryRequest(10GB,11GB,1GB)} 'ArgumentException'
 }
 'quota' {
  [MuResourcePolicy]::Quota(768,256)
  Reject {[MuResourcePolicy]::Quota(769,256)} 'RESOURCE_QUOTA'
  Reject {[MuResourcePolicy]::Quota([long]::MaxValue,16)} 'RESOURCE_QUOTA'
  Reject {[MuResourcePolicy]::Quota(-1,32)} 'ArgumentException'
 }
 'metrics' {
  $snapshot=[MuResourceMetrics]::Read($Directory);Check ($snapshot.totalMemory -gt 0 -and $snapshot.availableMemory -ge 0 -and $snapshot.availableMemory -le $snapshot.totalMemory -and $snapshot.freeDisk -ge 0) 'Invalid live Windows metrics'
  $file=Join-Path $Directory 'allocated.bin';$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew);try{$stream.SetLength(16MB);$stream.Flush($true)}finally{$stream.Dispose()}
  Check ([MuResourceMetrics]::AllocatedBytes($file) -ge 0) 'Allocated bytes missing';Check ([MuResourceMetrics]::Volume($file) -ceq [MuResourceMetrics]::Volume($Directory)) 'File and directory volume identities differ'
 }
}
