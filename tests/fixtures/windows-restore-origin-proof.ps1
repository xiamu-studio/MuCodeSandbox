param([string]$Source,[string]$Harness)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)+[Environment]::NewLine+[IO.File]::ReadAllText($Harness)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuOriginProofFixture]::Run())
