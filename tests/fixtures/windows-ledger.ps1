[CmdletBinding()]
param([string]$Directory,[string]$Source,[ValidateSet('fresh','legacy','orphans','loss','corruption','interrupted','conflict','missing','schema','links','permissions','limit','recovery-missing','recovery-corrupt','recovery-stale','recovery-trust','disk-growth','disk-growth-schema')][string]$Case)
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
 'disk-growth' {
  $s=Seed;$script:denyPrimary=$false
  $validator=[Action[string]]{param($file) if($script:denyPrimary -and $file -eq $primary){throw [IO.IOException]::new('Synthetic growth publication interruption')}}
  $s=[MuProtectedLedger]::new($root,$sid,$validator);$loaded=$s.Load()
  $loaded[$id]['diskGiB']=40;$growth=[Collections.Generic.Dictionary[string,object]]::new();$growth.Add('fromGiB',32);$growth.Add('targetGiB',40);$growth.Add('diskIdentifier','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');$growth.Add('fileIdentity',('a'*24));$loaded[$id]['diskGrowth']=$growth
  $script:denyPrimary=$true;Reject {$s.Save($loaded)} 'IOException';$script:denyPrimary=$false
  $loaded=(Store).Load();Check ($loaded[$id].diskGrowth.targetGiB -eq 40 -and $loaded[$id].diskGiB -eq 40 -and $loaded[$id].diskGrowth.fromGiB -eq 32) 'Interrupted growth intent was not restored from the newer durable copy';Check-Copies
  $loaded[$id].Remove('diskGrowth')|Out-Null;(Store).Save($loaded);Check-Copies;Check (-not (Store).Load()[$id].ContainsKey('diskGrowth')) 'Completed growth journal did not clear'
 }
 'disk-growth-schema' {
  $record['diskGiB']=40;$growth=[Collections.Generic.Dictionary[string,object]]::new();$growth.Add('fromGiB',32);$growth.Add('targetGiB',40);$growth.Add('diskIdentifier','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');$growth.Add('fileIdentity',('a'*24));$record['diskGrowth']=$growth;Seed|Out-Null;$valid=[IO.File]::ReadAllText($primary)
  foreach($kind in @('shrink','target','identifier','file','unknown','missing-vm','null','builder')){
   $x=$json.DeserializeObject($valid);$r=$x.records[$id];switch($kind){'shrink'{$r.diskGrowth.fromGiB=40};'target'{$r.diskGrowth.targetGiB=41};'identifier'{$r.diskGrowth.diskIdentifier='wrong'};'file'{$r.diskGrowth.fileIdentity='wrong'};'unknown'{$r.diskGrowth['path']='C:\foreign.vhdx'};'missing-vm'{$r.Remove('platformId')|Out-Null};'null'{$r.diskGrowth=$null};'builder'{$r['baseBuilder']=$true}}
   $text=$json.Serialize($x);[IO.File]::WriteAllText($primary,$text);[IO.File]::WriteAllText($backup,$text);Reject {(Store).Load()|Out-Null} 'UnauthorizedAccessException';Check ([IO.File]::ReadAllText($primary) -ceq $text -and [IO.File]::ReadAllText($backup) -ceq $text) 'Invalid growth evidence was overwritten';Check ([IO.File]::ReadAllText($canary) -ceq 'original guest bytes') 'Guest data changed'
  }
 }
 'recovery-missing' {
  $s=Store;$loaded=$s.InspectRecovery();Check ($loaded.Count -eq 0 -and $s.UnregisteredStorageCount -eq 1) 'Recovery silently adopted orphan data';Check (-not [IO.File]::Exists($primary) -and -not [IO.File]::Exists($backup)) 'Read-only recovery initialized a registry'
  Reject {(Store).Load() | Out-Null} 'UnauthorizedAccessException';$fingerprint=$s.RecoveryFingerprint();$s.SaveRecovery($records,$fingerprint);Check-Copies;Check ((Store).Load().Count -eq 1) 'Explicit recovered registration could not reopen normally'
 }
 'recovery-corrupt' {
  [IO.File]::WriteAllText($primary,'{"version":');[IO.File]::WriteAllBytes($backup,[byte[]]@(255,254));$s=Store;$loaded=$s.InspectRecovery();Check ($loaded.Count -eq 0 -and [IO.File]::ReadAllText($primary) -ceq '{"version":') 'Recovery inspection changed corrupt bytes'
  $s.SaveRecovery($records,$s.RecoveryFingerprint());Check-Copies;$archives=@(Get-ChildItem -LiteralPath $root -Filter 'vms.before-recovery-*.json');Check ($archives.Count -eq 2) 'Both damaged originals must be retained';Check (@($archives|Where-Object{[Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) -ceq [Convert]::ToBase64String([byte[]]@(255,254))}).Count -eq 1) 'Original malformed UTF-8 was lost'
 }
 'recovery-stale' {
  Seed | Out-Null;$s=Store;$s.InspectRecovery()|Out-Null;$fingerprint=$s.RecoveryFingerprint();$original=[IO.File]::ReadAllText($primary);[IO.File]::WriteAllText($primary,$original+' ')
  Reject {$s.SaveRecovery($records,$fingerprint)} 'IOException';Check ([IO.File]::ReadAllText($primary) -ceq ($original+' ') -and [IO.File]::ReadAllText($backup) -ceq $original) 'Stale recovery rewrote evidence';Check (@(Get-ChildItem -LiteralPath $root -Filter 'vms.before-recovery-*.json').Count -eq 0) 'Stale review archived before rejection'
 }
 'recovery-trust' {
  Seed | Out-Null;$validator=[Action[string]]{param($file) if($file -eq $primary){throw [UnauthorizedAccessException]::new('Synthetic trust refusal')}};$s=[MuProtectedLedger]::new($root,$sid,$validator)
  Reject {$s.InspectRecovery()|Out-Null} 'UnauthorizedAccessException';Reject {$s.RecoveryFingerprint()|Out-Null} 'UnauthorizedAccessException';Check-Copies
 }
 'limit' {
  Seed | Out-Null;$text=[IO.File]::ReadAllText($primary);$text=[regex]::Replace($text,'"revision":\d+','"revision":9223372036854775806');[IO.File]::WriteAllText($primary,$text);[IO.File]::WriteAllText($backup,$text)
  $s=Store;$loaded=$s.Load();Reject {$s.Save($loaded)} 'IOException';Check ([IO.File]::ReadAllText($primary) -ceq $text -and [IO.File]::ReadAllText($backup) -ceq $text) 'Revision exhaustion changed a valid copy'
 }
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
