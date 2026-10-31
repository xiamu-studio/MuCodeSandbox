param([string]$Directory,[string]$Source,[string]$Harness)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Harness)+[Environment]::NewLine+[IO.File]::ReadAllText($Source)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuOfflineSnapshotFixture]::Run($Directory))
