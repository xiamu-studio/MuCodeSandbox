[CmdletBinding()]
param([string]$ScriptDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -Path (Join-Path $ScriptDirectory '../../native/windows/SnapshotOwnerFiles.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuSnapshotOwnerFiles]::ApplyJson([Console]::In.ReadToEnd()))
