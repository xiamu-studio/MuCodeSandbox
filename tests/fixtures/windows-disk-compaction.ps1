param([string]$Source)
$ErrorActionPreference='Stop'
$text=[IO.File]::ReadAllText($Source)
$start=$text.IndexOf("  'compact-disk' {",[StringComparison]::Ordinal)
$end=$text.IndexOf("  'review-allocation' {",$start,[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw 'Compaction implementation boundary missing'}
$body=$text.Substring($start,$end-$start)
$body=$body.Substring($body.IndexOf('{')+1);$body=$body.Substring(0,$body.LastIndexOf('}'))
$work=[ScriptBlock]::Create($body)
$id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';$platform='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$c=[pscustomobject]@{brokerResourceLimit=$true;expectedPlatformId=$platform;compactDiskIdentifier=$id;diskGiB=32;disk='C:\synthetic\disk.vhdx'}
function ReviewAllocation {
 if($script:mode -eq 'untrusted-reference'){throw 'Synthetic shared dependency'}
 if($script:mode -eq 'vm-after' -and $script:optimized){return @{platformId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';diskGiB=32}|ConvertTo-Json -Compress}
 return @{platformId=$platform;diskGiB=32}|ConvertTo-Json -Compress
}
function Get-VHD {param($Path,$ErrorAction)
 $changed=$script:optimized -and $script:mode -eq 'changed-after'
 [pscustomobject]@{Attached=($script:mode -eq 'attached');ParentPath=$(if($script:mode -eq 'parent'){'C:\synthetic\parent.vhdx'}else{''});VhdFormat='VHDX';VhdType='Dynamic';Size=$(if($script:mode -eq 'wrong-size'){31GB}else{32GB});DiskIdentifier=$(if($changed){[guid]'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}else{[guid]$id})}
}
function Optimize-VHD {param($Path,$Mode,$ErrorAction)
 if($Path -cne $c.disk -or $Mode -cne 'Pretrimmed'){throw 'Unexpected command'}
 $script:optimized=$true;if($script:mode -eq 'failed'){throw 'Synthetic optimize failure'}
}
foreach($mode in @('valid','untrusted-reference','attached','parent','wrong-size','failed','changed-after','vm-after','invalid-id','no-authority')){
 $script:mode=$mode;$script:optimized=$false;$c.compactDiskIdentifier=if($mode -eq 'invalid-id'){'invalid'}else{$id};$c.brokerResourceLimit=$mode -ne 'no-authority'
 $errorSeen=$false;$result=$null
 try{$result=& $work}catch{$errorSeen=$true}
 if($mode -eq 'valid'){
  if($errorSeen -or -not $script:optimized){throw 'Valid fixed operation failed'}
  $receipt=$result|ConvertFrom-Json
  if($receipt.diskIdentifier -cne $id -or $receipt.platformId -cne $platform -or $receipt.bytes -ne 32GB -or $receipt.diskGiB -ne 32){throw 'Invalid completion receipt'}
 }else{
  if(-not $errorSeen -or $null -ne $result){throw ('Uncertain operation returned success: '+$mode)}
  if($mode -in @('untrusted-reference','attached','parent','wrong-size','invalid-id','no-authority') -and $script:optimized){throw ('Rejected input reached optimize: '+$mode)}
 }
}
