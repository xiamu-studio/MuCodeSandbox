param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Production Hyper-V script did not parse'}
# Import only exact production function ASTs. The script entry point, module
# imports and administrative actions are never executed by this fixture.
foreach($name in @('OwnedVM','InspectVM','AllocationVM','SnapshotDependencyPath','ReviewSnapshotDeletion')){
 $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false))
 if($functions.Count -ne 1){throw ('Expected one production function '+$name)}
 . ([scriptblock]::Create($functions[0].Extent.Text))
}
$checks=[Collections.Generic.List[object]]::new()
$root=[IO.Path]::GetFullPath($Directory)
$id='12345678-1234-4234-8234-123456789abc';$platform='22345678-1234-4234-8234-123456789abc';$otherId='32345678-1234-4234-8234-123456789abc'
$allocation=Join-Path $root 'allocation';$snapshotRoot=Join-Path $allocation 'snapshots'
$copy=Join-Path $snapshotRoot $id;$retired=Join-Path $snapshotRoot ('delete-active-'+$id)
[void][IO.Directory]::CreateDirectory($copy);[void][IO.Directory]::CreateDirectory($retired)
$current=Join-Path $allocation 'disk.vhdx';$seed=Join-Path $allocation 'seed.iso'
$copyDisk=Join-Path $copy 'disk.vhdx';$copySeed=Join-Path $copy 'seed.iso';$retiredDisk=Join-Path $retired 'disk.vhdx';$retiredSeed=Join-Path $retired 'seed.iso'
$otherDisk=Join-Path $root 'other.vhdx';$parentDisk=Join-Path $root 'parent.vhdx'
$files=@($current,$seed,$copyDisk,$copySeed,$retiredDisk,$retiredSeed,$otherDisk,$parentDisk)
foreach($file in $files){[IO.File]::WriteAllText($file,'synthetic local fixture, not a virtual disk')}
function Reset-Fixture {
 $script:c=[pscustomobject]@{name='mu-win-12345678123442348234123456789abc';directory=$allocation;disk=$current;seed=$seed;expectedPlatformId=$platform;brokerResourceLimit=$true;snapshotId=$id;cpus=2;memoryGiB=2;diskGiB=32;mac='00155D123456'}
 $script:marker='MuCodeSandbox Windows preview '+$c.name
 $script:vm=[pscustomobject]@{Name=$c.name;Id=$platform;Path=$allocation;Notes=$marker;State='Running';Generation=1;CheckpointType='Disabled';AutomaticStopAction='TurnOff';AutomaticStartAction='Nothing'}
 $script:other=[pscustomobject]@{Name='unrelated';Id=$otherId;State='Off'}
 $script:vms=@($vm,$other);$script:ownPoints=@();$script:otherPoints=@()
 $script:ownDisks=@([pscustomobject]@{Path=$current;VMId=$platform});$script:otherDisks=@([pscustomobject]@{Path=$otherDisk;VMId=$otherId});$script:pointDisks=@()
 $script:ownDvds=@([pscustomobject]@{Path=$seed});$script:otherDvds=@([pscustomobject]@{Path=''});$script:pointDvds=@()
 $script:nic=[pscustomobject]@{SwitchName=$c.name;DynamicMacAddressEnabled=$false;MacAddress=$c.mac;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On'}
 $script:memory=[pscustomobject]@{DynamicMemoryEnabled=$false;Startup=2GB};$script:processor=[pscustomobject]@{Count=2;ExposeVirtualizationExtensions=$false}
 $script:disks=@{};foreach($file in @($current,$copyDisk,$retiredDisk,$otherDisk,$parentDisk)){$script:disks[$file]=[pscustomobject]@{Attached=($file -eq $current);ParentPath='';VhdType='Dynamic';VhdFormat='VHDX';Size=32GB}}
 $script:images=@();$script:failProvider='';$script:failDisk='';$script:getVmCalls=0;$script:transition=$false;$script:readPaths=[Collections.Generic.List[string]]::new();$script:mutationCalls=0
}
# Provider doubles: do not import Hyper-V or call any real provider cmdlet.
function Get-VM {param($Name,$ErrorAction);if($script:failProvider -eq 'vm'){throw 'synthetic VM provider failure'};$script:getVmCalls++;if($script:transition -and $script:getVmCalls -ge 4){$vm.State='Stopping'};if($Name){return @($script:vms|Where-Object{$_.Name -eq $Name})};return $script:vms}
function Get-VMHardDiskDrive {param($VM,$VMSnapshot,$ErrorAction);if($script:failProvider -eq 'disk-drives'){throw 'synthetic hard disk provider failure'};if($VMSnapshot){return $script:pointDisks};if([string]$VM.Id -eq $platform){return $script:ownDisks};return $script:otherDisks}
function Get-VMDvdDrive {param($VM,$VMSnapshot,$ErrorAction);if($script:failProvider -eq 'dvd'){throw 'synthetic DVD provider failure'};if($VMSnapshot){return $script:pointDvds};if([string]$VM.Id -eq $platform){return $script:ownDvds};return $script:otherDvds}
function Get-VMSnapshot {param($VM,$ErrorAction);if($script:failProvider -eq 'checkpoints'){throw 'synthetic checkpoint provider failure'};if([string]$VM.Id -eq $platform){return $script:ownPoints};return $script:otherPoints}
function Get-VMMemory {param($VM,$ErrorAction);return $script:memory}
function Get-VMProcessor {param($VM,$ErrorAction);return $script:processor}
function Get-VMNetworkAdapter {param($VM,$ErrorAction);return $script:nic}
function Get-VMSwitch {param($Name);return [pscustomobject]@{SwitchType='Private';Notes=$marker}}
function Get-VMNetworkAdapterExtendedAcl {param($VM);foreach($direction in @('Inbound','Outbound')){[pscustomobject]@{Direction=$direction;Action='Deny';Weight=1;LocalIPAddress='ANY';RemoteIPAddress='ANY'}}}
function Get-VHD {param($Path,$ErrorAction);$script:readPaths.Add([string]$Path);if($script:failProvider -eq 'vhd' -or $Path -eq $script:failDisk){throw 'synthetic VHD provider failure'};if(-not $script:disks.ContainsKey([string]$Path)){throw 'Unknown synthetic disk path'};return $script:disks[[string]$Path]}
function Get-CimInstance {param($Namespace,$ClassName,$ErrorAction);if($Namespace -ne 'root/Microsoft/Windows/Storage' -or $ClassName -ne 'MSFT_DiskImage'){throw 'Unexpected provider query'};if($script:failProvider -eq 'mounts'){throw 'synthetic mount provider failure'};return $script:images}
function Stop-VM {$script:mutationCalls++;throw 'Mutation forbidden'}
function Set-VM {$script:mutationCalls++;throw 'Mutation forbidden'}
function Mount-VHD {$script:mutationCalls++;throw 'Mutation forbidden'}
function Dismount-VHD {$script:mutationCalls++;throw 'Mutation forbidden'}
function Check([string]$Name,[scriptblock]$Setup,[bool]$Reject=$true){
 Reset-Fixture;& $Setup
 $result=$null;$failure=$null;try{$result=ReviewSnapshotDeletion|ConvertFrom-Json}catch{$failure=$_}
 if($Reject -and -not $failure){throw ('Unsafe admission: '+$Name)}
 if(-not $Reject){if($failure){throw $failure};if($result.platformId -ne $platform -or $result.snapshotId -ne $id -or $result.unreferenced -ne $true -or $result.cpus -ne 2 -or $result.memoryGiB -ne 2 -or $result.diskGiB -ne 32 -or ($result.PSObject.Properties.Name|Sort-Object) -join ',' -ne 'cpus,diskGiB,memoryGiB,platformId,snapshotId,state,unreferenced'){throw ('Invalid bounded receipt: '+$Name)}}
 if($script:mutationCalls){throw ('Admission performed a mutation: '+$Name)}
 $checks.Add(@{name=$Name;passed=$true})
}
Check 'running-current-disk-attached-independent-copies-detached' {} $false
Check 'stopped-admission-does-not-change-stopped-state' {$vm.State='Off'} $false
Check 'missing-broker-authority' {$c.brokerResourceLimit=$false}
Check 'missing-platform-authority' {$c.expectedPlatformId=''}
Check 'foreign-platform' {$vm.Id=$otherId}
Check 'foreign-marker' {$vm.Notes='foreign'}
Check 'current-disk-replaced' {$script:ownDisks=@([pscustomobject]@{Path=$otherDisk;VMId=$platform})}
Check 'transitional-state' {$vm.State='Saving'}
Check 'state-transition-during-inventory' {$script:transition=$true}
Check 'canonical-id-uppercase-rejected' {$c.snapshotId=$id.ToUpperInvariant()}
Check 'zero-id-rejected' {$c.snapshotId=[guid]::Empty.ToString('D')}
Check 'path-id-rejected' {$c.snapshotId='..\disk.vhdx'}
Check 'own-hyperv-checkpoint-rejected' {$script:ownPoints=@([pscustomobject]@{Id='point'})}
Check 'changed-resource-registration' {$processor.Count=4}
Check 'dynamic-memory-rejected' {$memory.DynamicMemoryEnabled=$true}
Check 'current-disk-differencing-rejected' {$disks[$current].ParentPath=$parentDisk}
Check 'changed-network-policy' {$nic.DhcpGuard='Off'}
Check 'changed-seed-identity' {$script:ownDvds=@([pscustomobject]@{Path=$copySeed})}
Check 'candidate-attached' {$disks[$copyDisk].Attached=$true}
Check 'retired-candidate-attached' {$disks[$retiredDisk].Attached=$true}
Check 'unknown-candidate-attachment-state' {$disks[$copyDisk].Attached=$null}
Check 'candidate-differencing' {$disks[$copyDisk].ParentPath=$parentDisk}
Check 'candidate-wrong-format' {$disks[$copyDisk].VhdFormat='VHD'}
Check 'other-vm-direct-snapshot-disk' {$script:otherDisks=@([pscustomobject]@{Path=$copyDisk;VMId=$otherId})}
Check 'other-vm-retired-snapshot-disk' {$script:otherDisks=@([pscustomobject]@{Path=$retiredDisk;VMId=$otherId})}
Check 'other-vm-differencing-child-of-snapshot' {$disks[$otherDisk].ParentPath=$copyDisk}
Check 'checkpoint-differencing-child-of-snapshot' {$script:otherPoints=@([pscustomobject]@{Id='point'});$script:pointDisks=@([pscustomobject]@{Path=$otherDisk});$disks[$otherDisk].ParentPath=$copyDisk}
Check 'other-vm-seed-reference' {$script:otherDvds=@([pscustomobject]@{Path=$copySeed})}
Check 'checkpoint-retired-seed-reference' {$script:otherPoints=@([pscustomobject]@{Id='point'});$script:pointDvds=@([pscustomobject]@{Path=$retiredSeed})}
Check 'host-mounted-snapshot-iso' {$script:images=@([pscustomobject]@{Attached=$true;ImagePath=$copySeed})}
Check 'host-mounted-retired-disk' {$script:images=@([pscustomobject]@{Attached=$true;ImagePath=$retiredDisk})}
Check 'unknown-mounted-image-state' {$script:images=@([pscustomobject]@{Attached=$null;ImagePath=$retiredDisk})}
Check 'other-vm-current-disk-sharing' {$script:otherDisks=@([pscustomobject]@{Path=$current;VMId=$otherId})}
Check 'other-vm-current-seed-sharing' {$script:otherDvds=@([pscustomobject]@{Path=$seed})}
Check 'parent-cycle-fails-closed' {$disks[$otherDisk].ParentPath=$parentDisk;$disks[$parentDisk].ParentPath=$otherDisk}
Check 'remote-parent-fails-without-network-read' {$disks[$otherDisk].ParentPath='\\invalid.example\never-open\disk.vhdx'}
Check 'empty-harddisk-path' {$script:otherDisks=@([pscustomobject]@{Path='';VMId=$otherId})}
foreach($provider in @('vm','disk-drives','dvd','checkpoints','vhd','mounts')){
 $caseProvider=$provider;Check ('provider-failure-'+$provider) {$script:failProvider=$caseProvider}
}
Check 'dependency-count-bounded' {$script:otherDisks=@(1..1024|ForEach-Object{[pscustomobject]@{Path=$otherDisk;VMId=$otherId}})}
Check 'unrelated-detached-host-image-allowed' {$script:images=@([pscustomobject]@{Attached=$false;ImagePath=$otherDisk})} $false
Check 'checkpoint-with-unrelated-disk-and-empty-dvd-allowed' {$script:otherPoints=@([pscustomobject]@{Id='point'});$script:pointDisks=@([pscustomobject]@{Path=$otherDisk});$script:pointDvds=@([pscustomobject]@{Path=''})} $false
# Ordinary partial deletion only. No actual VHD, registered VM, mounted image
# or checkpoint is created or changed by this fixture.
foreach($file in @($copyDisk,$copySeed,$retiredDisk,$retiredSeed)){[IO.File]::Delete($file)}
Check 'partial-deletion-missing-copy-files-remains-reviewable' {} $false
Check 'missing-copy-does-not-hide-provider-failure' {$script:failProvider='mounts'}
if($script:readPaths -contains '\\invalid.example\never-open\disk.vhdx'){throw 'Remote disk provider was called'}
function Check-Staging([string]$Name,[string]$Operation,[scriptblock]$Setup,[bool]$Reject=$true){
 Reset-Fixture;$script:vm.State='Off';$script:stageFolder=Join-Path $snapshotRoot ($Operation+'-next-'+$id);[void][IO.Directory]::CreateDirectory($stageFolder)
 $script:stageDisk=Join-Path $stageFolder $(if($Operation -eq 'restore'){'disk.next'}else{'disk.vhdx'});$script:stageSeed=Join-Path $stageFolder $(if($Operation -eq 'restore'){'seed.next'}else{'seed.iso'})
 foreach($file in @($stageDisk,$stageSeed)){if(-not [IO.File]::Exists($file)){[IO.File]::WriteAllText($file,'unfinished ordinary copy, not a valid VHDX')}}
 & $Setup;$result=$null;$failure=$null;try{$result=ReviewSnapshotDeletion -StagingOperation $Operation|ConvertFrom-Json}catch{$failure=$_}
 if($Reject -and -not $failure){throw ('Unsafe staging admission: '+$Name)}
 if(-not $Reject){if($failure){throw $failure};if($result.unreferenced -ne $true -or $result.snapshotId -ne $id -or $result.platformId -ne $platform -or $result.state -ne 'Off'){throw ('Staging review receipt changed: '+$Name)}}
 if($script:readPaths -contains $stageDisk -or $script:mutationCalls){throw ('Staging review parsed a partial VHDX or mutated the provider: '+$Name)}
 $checks.Add(@{name=('staging-'+$Operation+'-'+$Name);passed=$true})
}
foreach($operation in @('create','restore')){
 Check-Staging 'partial-copy-allowed-only-with-complete-reference-inventory' $operation {} $false
 Check-Staging 'running-rejected' $operation {$vm.State='Running'}
 Check-Staging 'saving-rejected' $operation {$vm.State='Saving'}
 Check-Staging 'other-vm-direct-reference' $operation {$script:otherDisks=@([pscustomobject]@{Path=$stageDisk;VMId=$otherId})}
 Check-Staging 'checkpoint-direct-reference' $operation {$script:otherPoints=@([pscustomobject]@{Id='point'});$script:pointDisks=@([pscustomobject]@{Path=$stageDisk})}
 Check-Staging 'differencing-parent-reference' $operation {$disks[$otherDisk].ParentPath=$stageDisk}
 Check-Staging 'dvd-reference' $operation {$script:otherDvds=@([pscustomobject]@{Path=$stageSeed})}
 Check-Staging 'checkpoint-dvd-reference' $operation {$script:otherPoints=@([pscustomobject]@{Id='point'});$script:pointDvds=@([pscustomobject]@{Path=$stageSeed})}
 Check-Staging 'host-mounted-disk' $operation {$script:images=@([pscustomobject]@{Attached=$true;ImagePath=$stageDisk})}
 Check-Staging 'host-mounted-seed' $operation {$script:images=@([pscustomobject]@{Attached=$true;ImagePath=$stageSeed})}
 Check-Staging 'unknown-host-mount-state' $operation {$script:images=@([pscustomobject]@{Attached=$null;ImagePath=$stageDisk})}
 Check-Staging 'state-transition' $operation {$script:transition=$true}
 foreach($provider in @('vm','disk-drives','dvd','checkpoints','vhd','mounts')){$caseProvider=$provider;Check-Staging ('provider-failure-'+$provider) $operation {$script:failProvider=$caseProvider}}
 Check-Staging 'remaining-missing-files-allowed' $operation {foreach($file in @($stageDisk,$stageSeed)){[IO.File]::Delete($file)}} $false
 Check-Staging 'missing-files-do-not-hide-provider-failure' $operation {foreach($file in @($stageDisk,$stageSeed)){[IO.File]::Delete($file)};$script:failProvider='mounts'}
}
Reset-Fixture;$invalid=$false;try{ReviewSnapshotDeletion -StagingOperation 'other' > $null}catch{$invalid=$true};if(-not $invalid){throw 'Unrecognized staging operation was accepted'};$checks.Add(@{name='staging-operation-is-fixed';passed=$true})
$checks | ConvertTo-Json -Depth 6 -Compress
