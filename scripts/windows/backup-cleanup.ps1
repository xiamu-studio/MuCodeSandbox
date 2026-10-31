[CmdletBinding()]
param([string]$ScriptDirectory=$PSScriptRoot,[Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][ValidatePattern('^[0-9]{1,24}$')][string]$OwnerStarted)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -Path (Join-Path $ScriptDirectory '../../native/windows/BackupCleanup.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuBackupCleanup]::ApplyOwnedJson([Console]::In.ReadToEnd(),$OwnerPid,$OwnerStarted))
