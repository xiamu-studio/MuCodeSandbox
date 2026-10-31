param([string]$Directory,[string]$Source,[string]$Harness,[ValidateSet('Run','Resume','Kill')][string]$Mode='Run',[string]$Case)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
$native=Split-Path $Source
$core=[IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path (Split-Path $Harness) 'windows-origin-initialization.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText($Source)+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $native 'ProtectedLedger.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $native 'RestoreOriginOperations.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $native 'RestoreOriginInitialization.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $native 'DiskGrowth.cs'))
$temporary=Join-Path $Directory 'restore-core.cs'
[IO.File]::WriteAllText($temporary,$core,[Text.UTF8Encoding]::new($false))
Add-Type -Path @($temporary,(Join-Path $native 'OriginPreparation.cs'),(Join-Path $native 'RestoreOriginProof.cs'),(Join-Path $native 'RestoreOriginStore.cs'),(Join-Path $native 'RestoreOriginFrames.cs')) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
if($Case.StartsWith('init-') -or $Mode -ne 'Run'){[Console]::Write([MuHyperVBroker]::RunInitializationFixture($Directory,$Case,$Mode))}else{[Console]::Write([MuHyperVBroker]::RunFixture($Directory,$Case))}
