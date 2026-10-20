#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# Deliberately never reboot automatically. Save work and reboot separately.
$result = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart
[pscustomobject]@{ Feature = 'Microsoft-Hyper-V-All'; RestartNeeded = $result.RestartNeeded; AutomaticRestart = $false } | ConvertTo-Json -Compress
