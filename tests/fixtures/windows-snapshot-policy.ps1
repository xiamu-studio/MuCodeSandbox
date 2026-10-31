param([string]$Broker,[string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
$assembly=[Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($Broker))
$type=$assembly.GetType('MuHyperVBroker',$true)
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$type.GetField('UserRoot',$flags).SetValue($null,[IO.Path]::GetFullPath($Directory))
$ownerSid='S-1-5-21-1-2-3-1001'
$type.GetField('OwnerSid',$flags).SetValue($null,$ownerSid)
$id=[guid]::NewGuid().ToString('D');$platform=[guid]::NewGuid().ToString('D')
$record=[Collections.Generic.Dictionary[string,object]]::new()
@{id=$id;ownerSid=$ownerSid;platformId=$platform;image=(Join-Path $Directory ('images/'+('a'*64)+'.vhdx'));imageSha256=('a'*64);sealedSource=('mu-base:'+('a'*64));cpus=2;memoryGiB=2;diskGiB=32;stage='ready';everReady=$true}.GetEnumerator()|ForEach-Object{$record.Add($_.Key,$_.Value)}
$type.GetField('Records',$flags).GetValue($null).Add($id,$record)
function Invoke-Native([string]$Name,[object[]]$Parameters){$methods=@($type.GetMethods($flags)|Where-Object{$_.Name -eq $Name -and $_.GetParameters().Length -eq $Parameters.Length});if($methods.Count -ne 1){throw 'Expected one exact native policy method'};try{return ,($methods[0].Invoke($null,$Parameters))}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};throw [Exception]::new(('Native policy '+$Name+': '+$cause.ToString()),$cause)}}
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$checks=[Collections.Generic.List[object]]::new()
function Pass([string]$Name){$checks.Add(@{name=$Name;passed=$true})}
function Rejected([scriptblock]$Action){try{& $Action;return $false}catch{$reason=$_.Exception;while($reason.InnerException){$reason=$reason.InnerException};if($reason -is [ArgumentException] -or $reason -is [UnauthorizedAccessException] -or $reason.GetType().Name -eq 'MuStorageException'){return $true};throw}}
$cipher='enc:'+([Convert]::ToBase64String([byte[]](1..64)))
$envelope=Invoke-Native 'SnapshotEnvelope' @($record,$cipher)
Require ($envelope['cpus'] -eq 2 -and $envelope['memoryGiB'] -eq 2 -and $envelope['diskGiB'] -eq 32 -and $envelope['ownerConfiguration'] -eq $cipher) 'Snapshot authority was not captured from its protected record'
Pass 'resource-authority-from-protected-record'
$json=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$serialized=$json.Serialize($envelope)
$parsed=Invoke-Native 'SnapshotEnvelope' @($record,$serialized,$true)
Require ($parsed['platformId'] -eq $platform -and $parsed['ownerSid'] -eq $ownerSid) 'Snapshot allocation identity changed'
Pass 'exact-owner-allocation-roundtrip'
foreach($case in @(@{name='foreign-owner';key='ownerSid';value='S-1-5-21-1-2-3-1002'},@{name='foreign-environment';key='id';value=([guid]::NewGuid().ToString('D'))},@{name='foreign-platform';key='platformId';value=([guid]::NewGuid().ToString('D'))},@{name='unknown-authority';key='execute';value='untrusted'},@{name='image-path';key='imageExtension';value='..\x'},@{name='nonboolean-sealed';key='sealed';value='true'},@{name='cpu-limit';key='cpus';value=17},@{name='memory-limit';key='memoryGiB';value=1},@{name='disk-limit';key='diskGiB';value=15},@{name='noncanonical-digest';key='imageSha256';value=('A'*64)})){
 $changed=$json.DeserializeObject($serialized);$changed[$case.key]=$case.value
 Require (Rejected {Invoke-Native 'SnapshotEnvelope' @($record,$json.Serialize($changed),$true) > $null}) ('Rejected invalid snapshot envelope: '+$case.name)
 Pass ('reject-'+$case.name)
}
$record['cpus']=4;$record['memoryGiB']=4;$record['diskGiB']=40
$restorable=Invoke-Native 'SnapshotEnvelope' @($record,$serialized,$true)
Require ($restorable['cpus'] -eq 2 -and $restorable['diskGiB'] -eq 32) 'Historical resource authority cannot be replayed after a resource change'
Pass 'historical-resource-replay-remains-bound-to-owner'
$binding=[Collections.Generic.Dictionary[string,object]]::new();foreach($field in @('cpus','memoryGiB','diskGiB','imageSha256')){$binding.Add($field,$record[$field])}
Invoke-Native 'SnapshotOwnerResources' @($record,$binding) > $null
Pass 'current-owner-capture-binds-protected-resources'
foreach($field in @('cpus','memoryGiB','diskGiB','imageSha256')){$old=$binding[$field];$binding[$field]=if($field -eq 'imageSha256'){'b'*64}else{if($field -eq 'cpus'){1}elseif($field -eq 'memoryGiB'){8}else{32}};Require (Rejected {Invoke-Native 'SnapshotOwnerResources' @($record,$binding) > $null}) ('Stale owner binding accepted '+$field);$binding[$field]=$old}
Pass 'stale-owner-capture-rejected-before-copy'
$currentEnvelope=Invoke-Native 'SnapshotEnvelope' @($record,$cipher)
Invoke-Native 'SnapshotRegisteredResources' @($record,$currentEnvelope) > $null
Pass 'commit-and-acknowledgement-require-replayed-registration'
Require (Rejected {Invoke-Native 'SnapshotRegisteredResources' @($record,$parsed) > $null}) 'Unreplayed historical resources could clear the restore fence'
$currentEnvelope['sealed']=$false
Require (Rejected {Invoke-Native 'SnapshotRegisteredResources' @($record,$currentEnvelope) > $null}) 'Changed protected image authority could clear the restore fence'
Pass 'unreplayed-resource-and-image-authority-cannot-clear-fence'
$active=Join-Path $Directory ('vms/'+$id+'/snapshots/restore-active');New-Item -ItemType Directory -Path $active > $null
foreach($action in @('start','disk','create','delete','prepare','grow-disk','disk-growth-status','backup-begin','register-channel','channel','snapshot-create','snapshot-prepare')){
 Require (Rejected {Invoke-Native 'SnapshotPending' @($id,$action) > $null}) ('Pending restore did not fence '+$action)
}
Pass 'pending-transaction-fences-all-ordinary-mutations'
foreach($action in @('allocation','status','inspect','stop','close-channel','recover','disk-compact-status','snapshot-list','snapshot-staging','snapshot-deletions','snapshot-status','snapshot-outcome','snapshot-recover','snapshot-commit','snapshot-acknowledge','snapshot-seed')){Invoke-Native 'SnapshotPending' @($id,$action) > $null}
Pass 'readonly-stop-and-explicit-reconciliation-stay-available'
$allocation=Invoke-Native 'Allocation' @($id)
Require ($allocation.snapshotRestorePending -eq $true) 'Allocation receipt omitted pending snapshot state'
Pass 'allocation-receipt-exposes-pending-fence'
foreach($action in @('snapshot-create','snapshot-prepare','snapshot-commit')){Require ([bool](Invoke-Native 'ResourceMutation' @($action))) ('Large mutation omitted resource/power admission '+$action)}
Pass 'copy-and-commit-use-resource-and-power-admission'
foreach($bad in @('plain:secret','enc:AA==',('enc:'+([Convert]::ToBase64String([byte[]](1..64)))+' '))){$request=[Collections.Generic.Dictionary[string,object]]::new();$request.Add('ownerConfiguration',$bad);Require (Rejected {Invoke-Native 'SnapshotCipher' @($request,'ownerConfiguration') > $null}) 'Invalid owner configuration accepted'}
Pass 'reject-plaintext-short-and-noncanonical-owner-cipher'
$largeCipher='enc:'+([Convert]::ToBase64String([byte[]]::new(300000)))
$largeOwner=[Collections.Generic.Dictionary[string,object]]::new();$largeOwner.Add('ownerConfiguration',$largeCipher)
Require ((Invoke-Native 'SnapshotCipher' @($largeOwner,'ownerConfiguration')) -eq $largeCipher) 'Complete bounded owner cipher was rejected'
$tooLargeCipher='enc:'+([Convert]::ToBase64String([byte[]]::new(400000)))
$tooLarge=[Collections.Generic.Dictionary[string,object]]::new();$tooLarge.Add('ownerConfiguration',$tooLargeCipher)
Require (Rejected {Invoke-Native 'SnapshotCipher' @($tooLarge,'ownerConfiguration') > $null}) 'Oversized owner cipher accepted'
Pass 'complete-owner-envelope-remains-bounded'
foreach($action in @('snapshot-create','snapshot-prepare')){$request=[Collections.Generic.Dictionary[string,object]]::new();$request.Add('action',$action);Invoke-Native 'RequestBounds' @($request,600000) > $null;Require (Rejected {Invoke-Native 'RequestBounds' @($request,1048577) > $null}) 'Snapshot request upper bound was removed'}
foreach($action in @('hello','snapshot-status','disk','backup-import')){$request=[Collections.Generic.Dictionary[string,object]]::new();$request.Add('action',$action);Invoke-Native 'RequestBounds' @($request,65536) > $null;Require (Rejected {Invoke-Native 'RequestBounds' @($request,65537) > $null}) 'Ordinary request upper bound was enlarged'}
Pass 'larger-owner-ipc-is-limited-to-create-and-prepare'
$localProcess=[Diagnostics.Process]::GetCurrentProcess()
$type.GetField('Owner',$flags).SetValue($null,$localProcess)
$actor=Invoke-Native 'SnapshotCoordinator' @($record)
$restoreType=$assembly.GetType('MuOfflineSnapshotStore+Restore',$true)
$transaction=[Activator]::CreateInstance($restoreType)
$transaction.coordinator=$actor
foreach($recovery in @($false,$true)){Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$recovery) > $null}
Pass 'exact-live-controller-may-reconcile-its-transaction'
$restoreType.GetField('coordinator').SetValue($transaction,$null)
Require (Rejected {Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$false) > $null}) 'Unbound legacy transaction could commit'
Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$true) > $null
Pass 'legacy-unbound-transaction-requires-recovery-adoption'
foreach($case in @(@{key='ownerSid';value='S-1-5-21-1-2-3-1002'},@{key='id';value=([guid]::NewGuid().ToString('D'))},@{key='pid';value=0},@{key='startedUtcTicks';value='01'},@{key='startedUtcTicks';value=1},@{key='unexpected';value='x'})){
 $invalidActor=$json.DeserializeObject($actor);$invalidActor[$case.key]=$case.value;$transaction.coordinator=$json.Serialize($invalidActor)
 Require (Rejected {Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$true) > $null}) 'Changed controller identity accepted'
}
Pass 'invalid-controller-allocation-and-process-fields-rejected'
foreach($badActor in @('','null','[]','{}',('x'*4097))){$transaction.coordinator=$badActor;Require (Rejected {Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$true) > $null}) 'Invalid controller serialization accepted'}
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$start.Arguments='-NoLogo -NoProfile -NonInteractive -Command "[Threading.Thread]::Sleep(60000)"'
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$other=[Diagnostics.Process]::Start($start)
try{
 $type.GetField('Owner',$flags).SetValue($null,$other)
 $otherActor=Invoke-Native 'SnapshotCoordinator' @($record)
 $type.GetField('Owner',$flags).SetValue($null,$localProcess)
 $transaction.coordinator=$otherActor
 foreach($recovery in @($false,$true)){Require (Rejected {Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$recovery) > $null}) 'Other live controller was bypassed'}
 Require (-not $other.HasExited) 'Bound controller fixture exited early'
 Pass 'other-live-process-blocks-recovery-and-commit'
 $reused=$json.DeserializeObject($otherActor);$reused['startedUtcTicks']=([long]::Parse($reused['startedUtcTicks'])+1).ToString([Globalization.CultureInfo]::InvariantCulture);$transaction.coordinator=$json.Serialize($reused)
 Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$true) > $null
 Require (Rejected {Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$false) > $null}) 'Different process start could directly commit'
 Pass 'same-pid-with-different-start-only-allows-recovery'
 $other.Kill();Require ($other.WaitForExit(5000)) 'Own controller fixture did not exit'
 $transaction.coordinator=$otherActor
 Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$true) > $null
 Require (Rejected {Invoke-Native 'SnapshotCoordinatorGuard' @($record,$transaction,$false) > $null}) 'Dead controller transaction could directly commit'
 Pass 'observed-controller-exit-allows-recovery-before-commit'
}finally{if(-not $other.HasExited){$other.Kill();$other.WaitForExit()};$other.Dispose();$type.GetField('Owner',$flags).SetValue($null,$localProcess)}
$fileRecordType=$assembly.GetType('MuOfflineSnapshotStore+FileRecord',$true)
$seedRecord=[Activator]::CreateInstance($fileRecordType);$seedRecord.key='seed';$seedRecord.sha256='c'*64;$seedRecord.bytes=49152
$diskRecord=[Activator]::CreateInstance($fileRecordType);$diskRecord.key='disk';$diskRecord.sha256='d'*64;$diskRecord.bytes=3145728
$transaction.id=[guid]::NewGuid().ToString('D');$transaction.snapshotId=[guid]::NewGuid().ToString('D');$transaction.environmentId=$id;$transaction.phase='committed';$transaction.previousConfiguration=$serialized;$transaction.configuration=$serialized
$recordArray=[Array]::CreateInstance($fileRecordType,2);$recordArray.SetValue($diskRecord,0);$recordArray.SetValue($seedRecord,1);$transaction.files=$recordArray;$transaction.previous=$recordArray
$outcome=Invoke-Native 'SnapshotOutcomeReceipt' @($record,$transaction)
$sha=[Security.Cryptography.SHA256]::Create();try{$expected=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($cipher)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
Require ($outcome.acknowledged -eq $true -and $outcome.transactionId -eq $transaction.id -and $outcome.ownerConfigurationSha256 -eq $expected -and $outcome.phase -eq 'committed' -and $outcome.seedBytes -eq 49152) 'Acknowledged outcome lost its exact bound decision'
Require (-not ($json.Serialize($outcome).Contains($cipher))) 'Acknowledged outcome exposed owner material'
Pass 'acknowledged-outcome-binds-transaction-and-only-returns-owner-digest'
$transaction.phase='rolled-back';$rolledBack=Invoke-Native 'SnapshotOutcomeReceipt' @($record,$transaction);Require ($rolledBack.phase -eq 'rolled-back' -and $rolledBack.transactionId -eq $transaction.id) 'Acknowledged rollback was lost'
foreach($phase in @('prepared','applied')){$transaction.phase=$phase;Require (Rejected {Invoke-Native 'SnapshotOutcomeReceipt' @($record,$transaction) > $null}) 'Unresolved transaction became acknowledged outcome'}
Pass 'unresolved-transactions-cannot-produce-acknowledged-outcome'
$deleteAuthority=Invoke-Native 'SnapshotDeleteAuthority' @($record)
Require ($deleteAuthority -match '^[a-f0-9]{64}$') 'Deletion authority digest is not canonical'
$clone=[Collections.Generic.Dictionary[string,object]]::new($record);$clone['id']=[guid]::NewGuid().ToString('D');Require ((Invoke-Native 'SnapshotDeleteAuthority' @($clone)) -ne $deleteAuthority) 'Deletion authority ignored environment identity'
$clone=[Collections.Generic.Dictionary[string,object]]::new($record);$clone['platformId']=[guid]::NewGuid().ToString('D');Require ((Invoke-Native 'SnapshotDeleteAuthority' @($clone)) -ne $deleteAuthority) 'Deletion authority ignored VM identity'
$type.GetField('OwnerSid',$flags).SetValue($null,'S-1-5-21-1-2-3-1002');try{Require ((Invoke-Native 'SnapshotDeleteAuthority' @($record)) -ne $deleteAuthority) 'Deletion authority ignored owner SID'}finally{$type.GetField('OwnerSid',$flags).SetValue($null,$ownerSid)}
Pass 'snapshot-deletion-authority-binds-owner-environment-and-vm'
$clone=[Collections.Generic.Dictionary[string,object]]::new($record);$clone['cpus']=1;$clone['diskGiB']=64;Require ((Invoke-Native 'SnapshotDeleteAuthority' @($clone)) -eq $deleteAuthority) 'Resource changes made prior deletion intent unresumable'
Pass 'deletion-authority-remains-stable-across-resource-configuration-changes'
Require (-not [bool](Invoke-Native 'ResourceMutation' @('snapshot-delete'))) 'Cleanup cannot remain available during disk pressure'
Require (Rejected {Invoke-Native 'SnapshotPending' @($id,'snapshot-delete') > $null}) 'Deletion bypassed the pending restore fence'
Invoke-Native 'SnapshotPending' @($id,'snapshot-deletions') > $null
Pass 'deletion-cleanup-keeps-restore-fence-and-allows-read-only-pending-inventory'
$live=$type.GetField('SnapshotLiveDeletes',$flags).GetValue($null);$cancel=[Threading.CancellationTokenSource]::new();$live.Add($id,$cancel)
try{
 foreach($action in @('allocation','status','inspect','channel')){$request=[Collections.Generic.Dictionary[string,object]]::new();$request.Add('action',$action);$request.Add('id',$id);Invoke-Native 'SnapshotLiveAdmission' @($id,$action,$request) > $null}
 Require (-not $cancel.IsCancellationRequested) 'Read-only live access cancelled the deletion'
 Pass 'live-deletion-preserves-actual-native-inspection-and-channel-admission'
 foreach($action in @('start','disk','delete','grow-disk','backup-begin','snapshot-list','snapshot-status','snapshot-create','snapshot-prepare','snapshot-delete')){$request=[Collections.Generic.Dictionary[string,object]]::new();$request.Add('action',$action);$request.Add('id',$id);Require (Rejected {Invoke-Native 'SnapshotLiveAdmission' @($id,$action,$request) > $null}) ('Live deletion did not fence '+$action)}
 Pass 'live-deletion-fences-mutating-and-exclusive-snapshot-store-paths'
 $request=[Collections.Generic.Dictionary[string,object]]::new();$request.Add('action','stop');$request.Add('id',$id);Invoke-Native 'SnapshotLiveAdmission' @($id,'stop',$request) > $null
 Require ($cancel.IsCancellationRequested) 'Independent stop did not cancel live deletion'
 Pass 'actual-native-stop-cancels-live-delete-without-awaiting-snapshot-store'
}finally{$live.Remove($id)>$null;$cancel.Dispose()}
foreach($mode in @($false,'true',1,$null)){
 $request=[Collections.Generic.Dictionary[string,object]]::new();@{action='snapshot-delete';id=$id;snapshotId=$id;name='旧快照';resumeOnly=$false}.GetEnumerator()|ForEach-Object{$request.Add($_.Key,$_.Value)};$request.Add('allowRunning',$mode)
 Require (Rejected {Invoke-Native 'SnapshotLiveDeletion' @($request,[Threading.CancellationToken]::None) > $null}) 'Malformed live capability reached authority or Hyper-V admission'
}
Pass 'actual-native-live-mode-is-explicit-and-strictly-boolean'
[Console]::Write(($checks | ConvertTo-Json -Depth 6 -Compress))
