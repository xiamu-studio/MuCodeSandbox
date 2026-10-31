param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$ReceiptRoot)
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText($Source)
function Body([string]$startName,[string]$endName){
 $start=$text.IndexOf("  '$startName' {",[StringComparison]::Ordinal);$end=$text.IndexOf("  '$endName' {",$start,[StringComparison]::Ordinal)
 if($start -lt 0 -or $end -le $start){throw 'Action boundary missing'}
 $part=$text.Substring($start,$end-$start);$part=$part.Substring($part.IndexOf('{')+1);[ScriptBlock]::Create($part.Substring(0,$part.LastIndexOf('}')))
}
$submit=Body 'compact-disk-submit' 'compact-disk-job';$observe=Body 'compact-disk-job' 'compact-disk'
$diskId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';$platform='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';$jobId='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
$c=[pscustomobject]@{brokerResourceLimit=$true;expectedPlatformId=$platform;compactDiskIdentifier=$diskId;compactJobId=$jobId;diskGiB=32;disk='C:\synthetic\disk.vhdx'}
function ReviewAllocation {@{platformId=$platform;diskGiB=32}|ConvertTo-Json -Compress}
function Get-VHD {param($Path,$ErrorAction) [pscustomobject]@{Attached=($script:mode -eq 'attached');ParentPath='';VhdFormat='VHDX';VhdType='Dynamic';Size=32GB;DiskIdentifier=[guid]$diskId}}
function Get-CimInstance {param($Namespace,$ClassName,$Filter,$ErrorAction)
 if($ClassName -eq 'Msvm_ImageManagementService'){return [pscustomobject]@{Name='vhdsvc'}}
 if($ClassName -ne 'Msvm_StorageJob' -or $Filter -ne "InstanceID='$jobId'"){throw 'Unexpected query'}
 if($script:mode -eq 'missing'){return};if($script:mode -eq 'wrong-job'){$id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'}else{$id=$jobId}
 [pscustomobject]@{InstanceID=$id;JobState=$(if($script:mode -eq 'incomplete'){$null}else{7});ErrorCode=$(if($script:mode -eq 'missing-error'){$null}else{0});JobCompletionStatusCode=$(if($script:mode -eq 'missing-completion'){$null}else{0});JobType=$(if($script:mode -eq 'wrong-type'){4}else{3})}
}
function Invoke-CimMethod {param($InputObject,$MethodName,$Arguments,$ErrorAction)
 $script:submitted=$true;if($MethodName -ne 'CompactVirtualHardDisk' -or $Arguments.Mode -ne 3 -or $Arguments.Path -ne $c.disk){throw 'Wrong request'}
 if($script:mode -eq 'sync'){return [pscustomobject]@{ReturnValue=0;Job=$null}}
 if($script:mode -eq 'missing-id'){return [pscustomobject]@{ReturnValue=4096;Job=$null}}
 [pscustomobject]@{ReturnValue=4096;Job=[pscustomobject]@{InstanceID=$jobId.ToUpperInvariant();CimClass=[pscustomobject]@{CimClassName='Msvm_StorageJob'}}}
}
foreach($mode in @('valid','sync','attached','missing-id','no-authority')){
 $script:mode=$mode;$script:submitted=$false;$c.brokerResourceLimit=$mode -ne 'no-authority';$errorSeen=$false;$out=$null
 try{$out=& $submit|ConvertFrom-Json}catch{$errorSeen=$true}
 if($mode -in @('valid','sync')){if($errorSeen -or -not $script:submitted){throw ('Expected valid submit: '+$mode)};if($mode -eq 'valid' -and ($out.submitted -ne 'started' -or $out.jobId -cne $jobId)){throw 'Job identity changed'};if($mode -eq 'sync' -and ($out.submitted -ne 'completed' -or $null -ne $out.jobId)){throw 'Bad synchronous receipt'}}
 else{if(-not $errorSeen){throw ('Uncertain submit accepted: '+$mode)};if($mode -in @('attached','no-authority') -and $script:submitted){throw 'Rejected input reached provider'}}
}
$c.brokerResourceLimit=$true
$oldProfile=$env:USERPROFILE;$env:USERPROFILE=$ReceiptRoot
New-Item -ItemType Directory -Path (Join-Path $ReceiptRoot 'compaction-receipts') | Out-Null
$c | Add-Member -NotePropertyName compactOperationId -NotePropertyValue ''
foreach($mode in @('valid','sync')){
 $script:mode=$mode;$script:submitted=$false;$c.compactOperationId=[guid]::NewGuid().ToString('D')
 $out=& $submit|ConvertFrom-Json;$saved=Get-Content -Raw -LiteralPath (Join-Path (Join-Path $ReceiptRoot 'compaction-receipts') ($c.compactOperationId+'.json'))|ConvertFrom-Json
 if($saved.operationId -cne $c.compactOperationId -or $saved.diskIdentifier -cne $diskId -or $saved.platformId -cne $platform -or $saved.submitted -cne $out.submitted -or $saved.jobId -cne $out.jobId){throw 'Persisted provider receipt identity changed'}
 $script:submitted=$false;try{& $submit|Out-Null;throw 'Existing receipt was overwritten'}catch{if($script:submitted){throw 'Duplicate receipt reached provider'}}
}
$c.compactOperationId='malformed';$script:submitted=$false;try{& $submit|Out-Null;throw 'Invalid operation identity accepted'}catch{if($script:submitted){throw 'Invalid identity reached provider'}}
$c.compactOperationId='';$env:USERPROFILE=$oldProfile
foreach($mode in @('valid','missing','wrong-job','incomplete','missing-error','missing-completion','wrong-type')){
 $script:mode=$mode;$errorSeen=$false;$out=$null;try{$out=& $observe|ConvertFrom-Json}catch{$errorSeen=$true}
 if($mode -eq 'valid'){if($errorSeen -or $out.jobId -cne $jobId -or $out.state -ne 7 -or $out.errorCode -ne 0 -or $out.completionCode -ne 0){throw 'Observation changed'}}elseif(-not $errorSeen){throw ('Uncertain job accepted: '+$mode)}
}
