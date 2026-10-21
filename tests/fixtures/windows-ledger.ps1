[CmdletBinding()]
param([string]$Directory,[string]$Source,[ValidateSet('fresh','legacy','orphans','loss','corruption','interrupted','conflict','missing','schema','links','permissions')][string]$Case)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
$header='using System;using System.IO;using System.Linq;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Web.Script.Serialization;'
Add-Type -TypeDefinition ($header+[Environment]::NewLine+[IO.File]::ReadAllText($Source)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
$root=[IO.Path]::GetFullPath($Directory);$sid='S-1-5-21-1-2-3-1001';$id='12345678-1234-4234-8234-123456789012';$vmId='87654321-4321-4321-8321-210987654321'
$primary=Join-Path $root 'vms.json';$backup=Join-Path $root 'vms.backup.json';$canary=Join-Path $root ('vms/'+$id+'/canary.txt')
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($canary)) | Out-Null;[IO.File]::WriteAllText($canary,'original guest bytes')
$record=[Collections.Generic.Dictionary[string,object]]::new();$digest='a'*64
foreach($pair in @(@('id',$id),@('ownerSid',$sid),@('image',(Join-Path $root ('images/'+$digest+'.vhdx'))),@('imageSha256',$digest),@('cpus',1),@('memoryGiB',2),@('diskGiB',32),@('stage','ready'),@('platformId',$vmId),@('everReady',$true))){$record.Add($pair[0],$pair[1])}
$records=[Collections.Generic.Dictionary[string,Collections.Generic.Dictionary[string,object]]]::new();$records.Add($id,$record)
$noop=[Action[string]]{param($file)};$json=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
function Store {return [MuProtectedLedger]::new($root,$sid,$noop)}
function Seed {$s=Store;$s.Save($records);return $s}
function Check([bool]$condition,[string]$reason){if(-not $condition){throw $reason}}
function Reject([scriptblock]$work,[string]$type){$rejected=$false;try{& $work}catch{$errorType=$_.Exception.GetBaseException().GetType().Name;if($errorType -ne $type){throw ('Unexpected rejection: '+$errorType+' '+$_.Exception.GetBaseException().Message)};$rejected=$true};Check $rejected 'The unsafe registry state was accepted'}
function Check-Copies {
 $a=[IO.File]::ReadAllText($primary);$b=[IO.File]::ReadAllText($backup);Check ($a -ceq $b) 'Replicated copies differ';$saved=$json.DeserializeObject($a);Check ($saved.version -eq 2 -and $saved.ownerSid -eq $sid -and $saved.records.Count -eq 1 -and $saved.records[$id].platformId -eq $vmId) 'Allocation identity changed';Check ([IO.File]::ReadAllText($canary) -ceq 'original guest bytes') 'Guest bytes changed'
}
switch($Case){
 'fresh' {
  $emptyRoot=Join-Path $root 'fresh';[IO.Directory]::CreateDirectory($emptyRoot) | Out-Null;$s=[MuProtectedLedger]::new($emptyRoot,$sid,$noop);$loaded=$s.Load();Check ($loaded.Count -eq 0) 'Fresh store contains allocations'
  $a=[IO.File]::ReadAllText((Join-Path $emptyRoot 'vms.json'));$b=[IO.File]::ReadAllText((Join-Path $emptyRoot 'vms.backup.json'));Check ($a -ceq $b -and $json.DeserializeObject($a).version -eq 2) 'Fresh replicas are incomplete'
 }
 'legacy' {
  [IO.File]::WriteAllText($primary,$json.Serialize($records));$loaded=(Store).Load();Check ($loaded[$id]['platformId'] -eq $vmId) 'Legacy VM lost';Check-Copies
 }
 'orphans' {
  Seed | Out-Null;$other=Join-Path $root 'vms/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';[IO.Directory]::CreateDirectory($other) | Out-Null;[IO.File]::WriteAllText((Join-Path $other 'keep.txt'),'unknown guest bytes')
  $s=Store;$loaded=$s.Load();Check ($loaded.Count -eq 1 -and $loaded.ContainsKey($id) -and $s.UnregisteredStorageCount -eq 1) 'Trusted entries were blocked or unknown data was adopted';Check ([IO.File]::ReadAllText((Join-Path $other 'keep.txt')) -ceq 'unknown guest bytes') 'Unknown storage was changed';Check-Copies
 }
 'loss' {
  Seed | Out-Null;[IO.File]::Delete($primary);(Store).Load() | Out-Null;Check-Copies
  [IO.File]::Delete($backup);(Store).Load() | Out-Null;Check-Copies
 }
 'corruption' {
  Seed | Out-Null
  foreach($path in @($primary,$backup,$primary)){
   $damaged=if($path -eq $primary -and @(Get-ChildItem -LiteralPath $root -Filter 'vms.rejected-*.json').Count){[byte[]]@(255,254)}else{[Text.Encoding]::UTF8.GetBytes('{"version":')}
   $count=@(Get-ChildItem -LiteralPath $root -Filter 'vms.rejected-*.json').Count
   [IO.File]::WriteAllBytes($path,$damaged);(Store).Load() | Out-Null;Check-Copies
   $retained=@(Get-ChildItem -LiteralPath $root -Filter 'vms.rejected-*.json');Check ($retained.Count -eq $count+1) 'Damaged original was not retained'
   Check (@($retained | Where-Object {[Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) -ceq [Convert]::ToBase64String($damaged)}).Count -ge 1) 'Retained bytes differ from the damaged file'
  }
 }
 'interrupted' {
  $s=Seed;$script:denyPrimary=$false
  $validator=[Action[string]]{param($file) if($script:denyPrimary -and $file -eq $primary){throw [IO.IOException]::new('Synthetic interruption before primary publication')}}
  $s=[MuProtectedLedger]::new($root,$sid,$validator);$loaded=$s.Load();$old=$json.DeserializeObject([IO.File]::ReadAllText($primary)).revision
  $loaded[$id]['stage']='vm-missing';$script:denyPrimary=$true
  Reject {$s.Save($loaded)} 'IOException';$script:denyPrimary=$false
  $ahead=$json.DeserializeObject([IO.File]::ReadAllText($backup));Check ($ahead.revision -gt $old -and $ahead.records[$id].stage -eq 'vm-missing') 'The newer backup was not durable'
  $loaded=(Store).Load();Check ($loaded[$id]['stage'] -eq 'vm-missing') 'The interrupted update was lost';Check-Copies
 }
 'conflict' {
  Seed | Out-Null;$saved=$json.DeserializeObject([IO.File]::ReadAllText($backup));$saved.records[$id].memoryGiB=3;[IO.File]::WriteAllText($backup,$json.Serialize($saved));$a=[IO.File]::ReadAllText($primary);$b=[IO.File]::ReadAllText($backup)
  Reject {(Store).Load() | Out-Null} 'InvalidDataException';Check ([IO.File]::ReadAllText($primary) -ceq $a -and [IO.File]::ReadAllText($backup) -ceq $b) 'Conflicting evidence was overwritten'
 }
 'missing' {
  Reject {(Store).Load() | Out-Null} 'UnauthorizedAccessException';Check (-not [IO.File]::Exists($primary) -and -not [IO.File]::Exists($backup)) 'Missing copies were silently recreated'
  [IO.File]::WriteAllText($primary,'{');[IO.File]::WriteAllText($backup,'[')
  Reject {(Store).Load() | Out-Null} 'InvalidDataException';Check ([IO.File]::ReadAllText($primary) -ceq '{' -and [IO.File]::ReadAllText($backup) -ceq '[') 'Unrecoverable evidence was overwritten'
 }
 'schema' {
  Seed | Out-Null;$original=[IO.File]::ReadAllText($primary)
  foreach($kind in @('owner','path','cpu','memory','stage','field','builder','version')){
   $saved=$json.DeserializeObject($original);$r=$saved.records[$id]
   switch($kind){owner{$r['ownerSid']='S-1-5-21-1-2-3-9999'}path{$r['image']=[string](Join-Path $root '../outside.vhdx')}cpu{$r['cpus']=0}memory{$r['memoryGiB']=1024}stage{$r['stage']='adopt-anything'}field{$r['command']='unexpected'}builder{$r['baseBuilder']=$true}version{$saved['version']=99}}
   $bad=$json.Serialize($saved);[IO.File]::WriteAllText($primary,$bad);Reject {(Store).Load() | Out-Null} 'UnauthorizedAccessException';Check ([IO.File]::ReadAllText($primary) -ceq $bad) 'Untrusted data was repaired as if it were ordinary corruption'
  }
 }
 'links' {
  Seed | Out-Null;$outside=Join-Path $root 'other-file.json';[IO.File]::Move($primary,$outside);$original=[IO.File]::ReadAllText($outside)
  New-Item -ItemType HardLink -Path $primary -Value $outside | Out-Null;Reject {(Store).Load() | Out-Null} 'UnauthorizedAccessException';Check ([IO.File]::ReadAllText($outside) -ceq $original) 'External hard-link data changed';[IO.File]::Delete($primary)
  $other=Join-Path $root 'other-directory';[IO.Directory]::CreateDirectory($other) | Out-Null;[IO.File]::WriteAllText((Join-Path $other 'keep.txt'),'retained')
  New-Item -ItemType Junction -Path $primary -Value $other | Out-Null;Reject {(Store).Load() | Out-Null} 'UnauthorizedAccessException';Check ([IO.File]::ReadAllText((Join-Path $other 'keep.txt')) -ceq 'retained') 'Junction target changed'
 }
 'permissions' {
  Seed | Out-Null;$a=[IO.File]::ReadAllText($primary)
  $deny=[Action[string]]{param($file) if($file -eq $primary){throw [UnauthorizedAccessException]::new('Synthetic file ACL rejection')}}
  $s=[MuProtectedLedger]::new($root,$sid,$deny);Reject {$s.Load() | Out-Null} 'UnauthorizedAccessException';Check ([IO.File]::ReadAllText($primary) -ceq $a) 'Trust rejection was silently repaired'
 }
}
Check ([IO.File]::ReadAllText($canary) -ceq 'original guest bytes') 'Guest data was changed'
