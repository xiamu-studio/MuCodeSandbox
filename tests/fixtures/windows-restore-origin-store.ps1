param([string]$Source,[string]$Proof,[string]$Harness,[string]$Directory,[string]$Mode='unit',[string]$Phase='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -Path @($Proof,$Source,(Join-Path (Split-Path $Source) 'RestoreOriginFrames.cs'),(Join-Path (Split-Path $Source) 'OriginPreparation.cs'),$Harness) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
try{if($Mode -eq 'unit'){[Console]::Write([MuOriginStoreFixture]::Run($Directory))}else{[Console]::Write([MuOriginStoreFixture]::Worker($Directory,$Mode,$Phase))}}catch{[Console]::Error.WriteLine($_.Exception.ToString());exit 1}
