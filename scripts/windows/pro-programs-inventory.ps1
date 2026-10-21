# Read-only Windows Shell inventory, as used by Programs and Features.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df'
$entry = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:::{7B81BE6A-CE2B-4676-A29E-EB907A5126C5}')
if ($null -eq $folder) { throw 'Programs and Features shell folder unavailable' }
$items = @($folder.Items())
$matches = @(foreach ($item in $items) {
    if ($item.Name -like 'MuCodeSandbox Windows Preview*') {
        @{ name = [string]$item.Name; path = [string]$item.Path }
    }
})
$result = @{
    format = 1
    userSid = $identity.User.Value
    elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    registryPresent = [bool]$entry
    displayName = [string]$entry.DisplayName
    displayVersion = [string]$entry.DisplayVersion
    uninstallString = [string]$entry.UninstallString
    shellCount = $items.Count
    shellMatches = $matches
}
[Console]::Write(($result | ConvertTo-Json -Depth 5 -Compress))
