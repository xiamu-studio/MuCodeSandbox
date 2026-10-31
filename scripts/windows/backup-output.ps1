[CmdletBinding()]
param([string]$ScriptDirectory=$PSScriptRoot,[Parameter(Mandatory=$true)][ValidateSet('publish','check-published','cleanup')][string]$Mode,[Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][ValidatePattern('^[0-9]{1,24}$')][string]$OwnerStarted)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -Path (Join-Path $ScriptDirectory '../../native/windows/BackupOutput.cs') -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
[Console]::Write([MuBackupOutput]::ApplyOwnedJson([Console]::In.ReadToEnd(),$Mode,$OwnerPid,$OwnerStarted))
