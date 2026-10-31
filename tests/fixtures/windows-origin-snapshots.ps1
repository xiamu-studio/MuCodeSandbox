param([string]$Directory,[string]$Native,[string]$Harness,[string]$Case,[ValidateSet('Run','Resume')][string]$Mode='Run')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
$core=[IO.File]::ReadAllText($Harness)
foreach($name in @('OfflineSnapshots.cs','SnapshotStaging.cs','SnapshotOperations.cs','RestoreOriginOperations.cs','RestoreOriginSnapshots.cs')){$core+=[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $Native $name))}
$temporary=Join-Path $Directory 'snapshot-core.cs'
[IO.File]::WriteAllText($temporary,$core,[Text.UTF8Encoding]::new($false))
Add-Type -Path @($temporary,(Join-Path $Native 'RestoreOriginProof.cs'),(Join-Path $Native 'RestoreOriginStore.cs'),(Join-Path $Native 'RestoreOriginFrames.cs'),(Join-Path $Native 'OriginPreparation.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
if($Mode -eq 'Resume'){[Console]::Write([MuHyperVBroker]::ResumeSnapshotFixture($Directory))}else{[Console]::Write([MuHyperVBroker]::RunSnapshotFixture($Directory,$Case))}
