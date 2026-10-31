param([string]$Directory,[string]$Native)
$ErrorActionPreference='Stop'
$resource=[IO.File]::ReadAllText((Join-Path $Native 'Resources.cs'));$growth=[IO.File]::ReadAllText((Join-Path $Native 'DiskGrowth.cs'))
$source='using System;using System.IO;using System.Runtime.InteropServices;public sealed class MuStorageException:IOException{public readonly string Code;public MuStorageException(string code,string message):base(message){Code=code;}}'
$source+=$resource.Substring(0,$resource.IndexOf('public static partial class MuHyperVBroker'))+$growth.Substring(0,$growth.IndexOf('public static partial class MuHyperVBroker'))
Add-Type -TypeDefinition $source
function Reject([scriptblock]$work){$failed=$false;try{&$work}catch{$failed=$true};if(-not $failed){throw 'Unsafe growth was accepted'}}
[MuDiskGrowthPolicy]::Request(32,40);[MuDiskGrowthPolicy]::Request(255,256)
foreach($action in @('allocation','status','stop','inspect','close-channel')){if([MuDiskGrowthPolicy]::CompactionBlocks($true,$action)){throw 'Required recovery observation was blocked'}}
foreach($action in @('disk-compact-status','disk-compact-start','disk-compact-trimmed','disk-compact-run','disk-compact-reconcile','disk-compact-verify-start','disk-compact-review','disk-compact-finish','disk-compact-retry','disk-compact-cancel')){if([MuDiskGrowthPolicy]::CompactionBlocks($true,$action)){throw 'Explicit maintenance action cannot reach its phase validation'}}
foreach($action in @('start','channel','delete','grow-disk','snapshot-export-begin','snapshot-delete','snapshot-staging-cleanup','backup-begin','disk-compact-begin','disk-compact-unknown','unknown','')){if(-not [MuDiskGrowthPolicy]::CompactionBlocks($true,$action)){throw 'Pending compaction admitted a mutation'}}
if([MuDiskGrowthPolicy]::CompactionBlocks($false,'start')){throw 'Ordinary start blocked without a compaction journal'}
foreach($phase in @('preparing','compacting','verifying','trimming','unknown')){foreach($session in @($false,$true)){foreach($pending in @($false,$true)){$allowed=[MuDiskGrowthPolicy]::CompactionChannelAllowed($pending,$phase,$session);if($allowed -ne ($pending -and $session -and $phase -in @('trimming','verifying'))){throw 'Maintenance channel authority changed'}}}}
foreach($pair in @(@(0,40),@(32,31),@(32,257),@([long]::MaxValue,[long]::MaxValue))){Reject {[MuDiskGrowthPolicy]::Request($pair[0],$pair[1])}}
[MuDiskGrowthPolicy]::Filesystem(40,(40GB-128MB),128MB);Reject {[MuDiskGrowthPolicy]::Filesystem(40,32GB,128MB)};Reject {[MuDiskGrowthPolicy]::Filesystem(40,41GB,128MB)}
[MuDiskGrowthPolicy]::Filesystem(40,(40GB-1025MB),1025MB);Reject {[MuDiskGrowthPolicy]::Filesystem(40,(40GB-2GB),1GB)};Reject {[MuDiskGrowthPolicy]::Filesystem(40,39GB,3GB)}
$file=Join-Path $Directory 'disk.vhdx';$alias=Join-Path $Directory 'alias.vhdx';[IO.File]::WriteAllText($file,'synthetic file identity only')
$original=[MuDiskGrowthPolicy]::FileIdentity($file);if($original -cnotmatch '^[a-f0-9]{24}$'){throw 'Missing physical file identity'}
New-Item -ItemType HardLink -Path $alias -Target $file|Out-Null;Reject {[MuDiskGrowthPolicy]::FileIdentity($file)|Out-Null};[IO.File]::Delete($alias)
if([MuDiskGrowthPolicy]::FileIdentity($file) -cne $original -or [IO.File]::ReadAllText($file) -cne 'synthetic file identity only'){throw 'Read-only disk identity checking changed the original file'}
