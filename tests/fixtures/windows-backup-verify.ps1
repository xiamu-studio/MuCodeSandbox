param([string]$Directory,[string]$Source)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Production Hyper-V script did not parse'}
foreach($name in @('OwnedVM','InspectVM','AllocationVM','ReviewAllocation')){
 $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 if(-not $definition){throw "Missing production function $name"}
 . ([ScriptBlock]::Create($definition.Extent.Text))
}
$switch=$ast.Find({param($node) $node -is [Management.Automation.Language.SwitchStatementAst]},$true)
$clauses=@($switch.Clauses | Where-Object {$_.Item1.Value -eq 'backup-import-verify'})
if($clauses.Count -ne 1){throw 'Expected exactly one production backup verification clause'}
$text=$clauses[0].Item2.Extent.Text
$verify=[ScriptBlock]::Create($text.Substring(1,$text.Length-2))

# Synthetic provider only: the production functions and action execute unchanged.
# Actual Hyper-V modules are never imported and no mutation cmdlet is supplied.
function Get-VM { [CmdletBinding()]param([string]$Name) if($script:providerFailed){throw 'Synthetic provider failure'};if($script:present){$script:vm} }
function Get-VMSwitch { [CmdletBinding()]param([string]$Name) [pscustomobject]@{Name=$c.name;SwitchType='Private';Notes=$marker} }
function Get-VMHardDiskDrive { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$VM,$VMSnapshot) process { [pscustomobject]@{Path=$c.disk;VMId=$script:vm.Id};if($script:foreignReference){[pscustomobject]@{Path=$c.disk;VMId='11111111-1111-4111-8111-111111111111'}} } }
function Get-VMNetworkAdapter { [CmdletBinding()]param($VM) $script:nic }
function Get-VMNetworkAdapterExtendedAcl { [CmdletBinding()]param($VM) foreach($direction in @('Inbound','Outbound')){[pscustomobject]@{Direction=$direction;Action='Deny';Weight=1;LocalIPAddress='ANY';RemoteIPAddress='ANY'}} }
function Get-VMSnapshot { [CmdletBinding()]param($VM) if($script:snapshot){[pscustomobject]@{Id='synthetic-checkpoint'}} }
function Get-VMMemory { [CmdletBinding()]param($VM) $script:memory }
function Get-VMProcessor { [CmdletBinding()]param($VM) $script:processor }
function Get-VMDvdDrive { [CmdletBinding()]param($VM) [pscustomobject]@{Path=$script:dvd} }
function Get-VHD { [CmdletBinding()]param([string]$Path) if($Path -ne $c.disk){throw 'Unexpected disk inspection'};$script:disk }

$directoryPath=[IO.Path]::GetFullPath($Directory)
$null=[IO.Directory]::CreateDirectory($directoryPath)
$c=[pscustomobject]@{name='mu-win-12345678123442348234123456789012';directory=$directoryPath;disk=(Join-Path $directoryPath 'disk.vhdx');seed=(Join-Path $directoryPath 'seed.iso');cpus=2;memoryGiB=4;diskGiB=16;mac='00155D123456';brokerResourceLimit=$true;allowPartialAllocation=$false;expectedPlatformId='87654321-4321-4321-8321-210987654321'}
$marker='MuCodeSandbox Windows preview '+$c.name
[IO.File]::WriteAllText($c.disk,'synthetic disk - not VHDX')
[IO.File]::WriteAllText($c.seed,'synthetic seed - not ISO')
$cases=@('absent','matching','cpu','memory','generation','checkpoint-policy','automatic-stop','nested-virtualization','dynamic-memory','seed','mac-spoofing','dynamic-mac','disk-reference','snapshot','provider-failure')
$results=@()
foreach($case in $cases){
 $script:present=$case -ne 'absent';$script:providerFailed=$case -eq 'provider-failure';$script:foreignReference=$case -eq 'disk-reference';$script:snapshot=$case -eq 'snapshot'
 $script:vm=[pscustomobject]@{Name=$c.name;Notes=$marker;Id=$c.expectedPlatformId;Path=$c.directory;State='Off';Generation=1;CheckpointType='Disabled';AutomaticStartAction='Nothing';AutomaticStopAction='TurnOff'}
 $script:nic=[pscustomobject]@{SwitchName=$c.name;DynamicMacAddressEnabled=$false;MacAddress=$c.mac;MacAddressSpoofing='Off';DhcpGuard='On';RouterGuard='On'}
 $script:memory=[pscustomobject]@{DynamicMemoryEnabled=$false;Startup=4GB}
 $script:processor=[pscustomobject]@{Count=2;ExposeVirtualizationExtensions=$false}
 $script:disk=[pscustomobject]@{Size=16GB;Attached=$false;ParentPath='';VhdFormat='VHDX';VhdType='Dynamic'}
 $script:dvd=$c.seed
 switch($case){
  'cpu' {$script:processor.Count=3}
  'memory' {$script:memory.Startup=6GB}
  'generation' {$script:vm.Generation=2}
  'checkpoint-policy' {$script:vm.CheckpointType='Production'}
  'automatic-stop' {$script:vm.AutomaticStopAction='Save'}
  'nested-virtualization' {$script:processor.ExposeVirtualizationExtensions=$true}
  'dynamic-memory' {$script:memory.DynamicMemoryEnabled=$true}
  'seed' {$script:dvd=Join-Path $directoryPath 'foreign.iso'}
  'mac-spoofing' {$script:nic.MacAddressSpoofing='On'}
  'dynamic-mac' {$script:nic.DynamicMacAddressEnabled=$true}
 }
 $rejected=$false;$reason=''
 try{$result=& $verify | ConvertFrom-Json;if(-not $result.verified){throw 'Verification returned no receipt'}}catch{$rejected=$true;$reason=$_.Exception.Message}
 $expected=$case -notin @('absent','matching')
 $results+=@{case=$case;rejected=$rejected;expectedRejected=$expected;reason=$reason}
}
$failed=@($results | Where-Object {$_.rejected -ne $_.expectedRejected})
if($failed.Count){throw ('Restore verification accepted or rejected the wrong provider facts: '+($failed|ConvertTo-Json -Compress))}
@{checks=$results.Count;cases=$results;realHyperVExercised=$false;mutations=0}|ConvertTo-Json -Depth 5 -Compress
