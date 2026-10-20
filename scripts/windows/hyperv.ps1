[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('doctor','disk','export-base','create','start','stop','inspect','fingerprint')][string]$Action)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Action -eq 'doctor') {
  $module = [bool](Get-Module -ListAvailable Hyper-V)
  $service = Get-Service -Name vmms -ErrorAction SilentlyContinue
  $issues = @()
  if (-not $module) { $issues += 'Hyper-V management module is not installed; enable Hyper-V and reboot' }
  if (-not $service -or $service.Status -ne 'Running') { $issues += 'Hyper-V virtual machine management service is not running' }
  if (-not $isAdmin) { $issues += 'The preview requires an administrator PowerShell; production privilege separation is pending' }
  [pscustomobject]@{ available = $issues.Count -eq 0; issues = @($issues) } | ConvertTo-Json -Compress
  exit 0
}
if ($Action -eq 'fingerprint') {
  # No addresses are logged; the caller retains only a digest of this snapshot.
  $adapters = @(Get-NetAdapter | Where-Object { $_.Name -notlike 'vEthernet (mu-win-*' } | Sort-Object InterfaceGuid | Select-Object InterfaceGuid,Status,LinkSpeed)
  $routes = @(Get-NetRoute -AddressFamily IPv4,IPv6 | Where-Object { $_.InterfaceAlias -notlike 'vEthernet (mu-win-*' } | Sort-Object DestinationPrefix,InterfaceIndex,NextHop | Select-Object DestinationPrefix,NextHop,InterfaceIndex,RouteMetric)
  $dns = @(Get-DnsClientServerAddress | Where-Object { $_.InterfaceAlias -notlike 'vEthernet (mu-win-*' } | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses)
  [pscustomobject]@{ adapters=$adapters; routes=$routes; dns=$dns } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
if (-not $isAdmin) { throw 'Administrator PowerShell is required for this preview' }
Import-Module Hyper-V
$inputText = [Console]::In.ReadToEnd()
$c = $inputText | ConvertFrom-Json
if ($c.name -notmatch '^mu-win-[0-9a-f]{32}$' -or $c.host -notmatch '^172\.29\.\d{1,3}\.\d{1,3}$' -or $c.guest -notmatch '^172\.29\.\d{1,3}\.\d{1,3}$') { throw 'Invalid owned VM identity' }
$marker = 'MuCodeSandbox Windows preview ' + $c.name
function OwnedVM {
  $v = Get-VM -Name $c.name -ErrorAction Stop
  if ($v.Notes -ne $marker) { throw 'Refusing to operate on a VM not owned by this preview' }
  return $v
}
function InspectVM {
  $v = OwnedVM
  $nics = @(Get-VMNetworkAdapter -VM $v)
  $switch = Get-VMSwitch -Name $c.name
  if ($switch.SwitchType -ne 'Internal' -or $switch.Notes -ne $marker -or $nics.Count -ne 1 -or $nics[0].SwitchName -ne $c.name) { throw 'VM network topology changed' }
  if ($v.AutomaticStartAction -ne 'Nothing') { throw 'Automatic VM start is forbidden' }
  $acl = @(Get-VMNetworkAdapterExtendedAcl -VM $v)
  # Each direction must have an all-IP deny and the only TCP allow must be SSH
  # between this VM and its management peer. Check actual installed ACL values.
  foreach ($direction in @('Inbound','Outbound')) {
    $rules = @($acl | Where-Object { [string]$_.Direction -eq $direction })
    $deny = @($rules | Where-Object { [string]$_.Action -eq 'Deny' -and $_.Weight -eq 1 -and [string]$_.LocalIPAddress -eq 'ANY' -and [string]$_.RemoteIPAddress -eq 'ANY' })
    $allow = @($rules | Where-Object { [string]$_.Action -eq 'Allow' -and $_.Weight -eq 100 -and [string]$_.LocalIPAddress -eq $c.guest -and [string]$_.RemoteIPAddress -eq $c.host -and [string]$_.LocalPort -eq '22' -and [string]$_.Protocol -in @('TCP','6') })
    if ($rules.Count -ne 2 -or $deny.Count -ne 1 -or $allow.Count -ne 1) { throw 'Hyper-V port ACL does not match the approved policy' }
  }
  [pscustomobject]@{ name=$v.Name; state=[string]$v.State; isolated=$true; aclVerified=$true; automaticStart=$false } | ConvertTo-Json -Compress
}
switch ($Action) {
  'export-base' {
    $v = OwnedVM
    if ($v.State -ne 'Off') { throw 'Builder VM must be off before exporting its disk' }
    $target = Join-Path $c.directory 'protected-base.vhdx'
    if (Test-Path -LiteralPath $target) { throw 'Protected base export already exists' }
    Copy-Item -LiteralPath $c.disk -Destination $target
  }
  'disk' {
    if (Test-Path -LiteralPath $c.disk) { throw 'Refusing to overwrite an existing disk' }
    $source = Get-Item -LiteralPath $c.image
    if ($source.Extension -notin @('.vhd','.vhdx') -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a regular VHD or VHDX image' }
    Convert-VHD -Path $source.FullName -DestinationPath $c.disk -VHDType Dynamic
    $disk = Get-VHD -Path $c.disk
    if ($disk.Size -lt ([int64]$c.diskGiB*1GB)) { Resize-VHD -Path $c.disk -SizeBytes ([int64]$c.diskGiB*1GB) }
  }
  'create' {
    if (Get-VM -Name $c.name -ErrorAction SilentlyContinue) { throw 'VM already exists; inspect it instead of overwriting it' }
    if (Get-VMSwitch -Name $c.name -ErrorAction SilentlyContinue) { throw 'Switch already exists; refusing to reuse it' }
    foreach ($file in @($c.disk,$c.seed)) {
      $item = Get-Item -LiteralPath $file
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'VM inputs must not be reparse points' }
    }
    # Address conflicts fail closed. No NAT, ICS, physical bridge or default
    # switch is created, and no existing virtual switch is modified.
    if (Get-NetIPAddress -IPAddress $c.host,$c.guest -ErrorAction SilentlyContinue) { throw 'Management address already in use' }
    $s = New-VMSwitch -Name $c.name -SwitchType Internal -Notes $marker
    try {
      $adapter = Get-NetAdapter -Name ('vEthernet ('+$c.name+')')
      Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -Dhcp Disabled -Forwarding Disabled
      Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv6 -Forwarding Disabled -RouterDiscovery Disabled
      New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $c.host -PrefixLength 30 | Out-Null
      # Canonical Azure VHD uses BIOS boot. It is imported into a Generation 1
      # VM; no secure-boot setting is disabled on the host or another VM.
      $v = New-VM -Name $c.name -Generation 1 -MemoryStartupBytes ([int64]$c.memoryGiB*1GB) -VHDPath $c.disk -Path $c.directory
      Set-VM -VM $v -Notes $marker -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled
      Set-VMProcessor -VM $v -Count $c.cpus -ExposeVirtualizationExtensions $false
      Set-VMMemory -VM $v -DynamicMemoryEnabled $false
      Get-VMNetworkAdapter -VM $v | Connect-VMNetworkAdapter -SwitchName $c.name
      Get-VMNetworkAdapter -VM $v | Set-VMNetworkAdapter -StaticMacAddress $c.mac -MacAddressSpoofing Off -DhcpGuard On -RouterGuard On
      foreach ($direction in @('Inbound','Outbound')) {
        Add-VMNetworkAdapterExtendedAcl -VM $v -Action Deny -Direction $direction -LocalIPAddress ANY -RemoteIPAddress ANY -Weight 1
        Add-VMNetworkAdapterExtendedAcl -VM $v -Action Allow -Direction $direction -LocalIPAddress $c.guest -RemoteIPAddress $c.host -LocalPort 22 -Protocol TCP -Weight 100
      }
      Get-VMDvdDrive -VM $v | Set-VMDvdDrive -Path $c.seed
      InspectVM
    } catch {
      # Preserve failed resources for inspection; never leave a partial VM live.
      $failed = Get-VM -Name $c.name -ErrorAction SilentlyContinue
      if ($failed -and $failed.State -ne 'Off') { Stop-VM -VM $failed -TurnOff -Force }
      throw
    }
  }
  'inspect' { InspectVM }
  'start' { InspectVM | Out-Null; Start-VM -VM (OwnedVM) | Out-Null; InspectVM }
  'stop' { $v=OwnedVM; if ($v.State -ne 'Off') { Stop-VM -VM $v -TurnOff -Force }; InspectVM }
}
