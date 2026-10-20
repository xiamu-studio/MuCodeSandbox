[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('doctor','register-channel','disk','export-base','create','start','stop','status','inspect','fingerprint','recover-allocation','delete-allocation','allocation-absence')][string]$Action)
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
  if ($c.expectedPlatformId -and [string]$v.Id -ne [string]$c.expectedPlatformId) { throw 'Owned VM platform identity changed' }
  return $v
}
function InspectVM {
  $v = OwnedVM
  $nics = @(Get-VMNetworkAdapter -VM $v)
  $switch = Get-VMSwitch -Name $c.name
  if ($switch.SwitchType -ne 'Private' -or $switch.Notes -ne $marker -or $nics.Count -ne 1 -or $nics[0].SwitchName -ne $c.name) { throw 'VM network topology changed' }
  if ($v.AutomaticStartAction -ne 'Nothing') { throw 'Automatic VM start is forbidden' }
  $acl = @(Get-VMNetworkAdapterExtendedAcl -VM $v)
  # Each direction must have an all-IP deny and the only TCP allow must be SSH
  # between this VM and its management peer. Check actual installed ACL values.
  foreach ($direction in @('Inbound','Outbound')) {
    $rules = @($acl | Where-Object { [string]$_.Direction -eq $direction })
    $deny = @($rules | Where-Object { [string]$_.Action -eq 'Deny' -and $_.Weight -eq 1 -and [string]$_.LocalIPAddress -eq 'ANY' -and [string]$_.RemoteIPAddress -eq 'ANY' })
    if ($rules.Count -ne 1 -or $deny.Count -ne 1) { throw 'Hyper-V port ACL does not match the approved policy' }
  }
  [pscustomobject]@{ name=$v.Name; platformId=[string]$v.Id; state=[string]$v.State; isolated=$true; aclVerified=$true; automaticStart=$false } | ConvertTo-Json -Compress
}
function AllocationVM {
  if(-not $c.brokerResourceLimit){throw 'Allocation recovery requires the protected broker'}
  # Query the provider successfully before interpreting an empty result. A
  # provider/RPC/permission error must never become evidence of VM absence.
  $all=@(Get-VM -ErrorAction Stop)
  $matches=@($all | Where-Object {$_.Name -eq $c.name})
  if($matches.Count -gt 1){throw 'Allocation VM name is ambiguous'}
  $v=if($matches.Count){$matches[0]}else{$null}
  if(-not $v){
    if($c.expectedPlatformId -and @($all | Where-Object {[string]$_.Id -eq [string]$c.expectedPlatformId}).Count){throw 'Registered VM was renamed'}
    return $null
  }
  if($c.expectedPlatformId -and [string]$v.Id -ne [string]$c.expectedPlatformId){throw 'Allocation VM identity changed'}
  if($v.Notes -ne $marker -and -not ($c.allowPartialAllocation -and -not $v.Notes)){throw 'Allocation ownership changed'}
  $directory=[IO.Path]::GetFullPath($c.directory).TrimEnd('\')
  $actual=[IO.Path]::GetFullPath($v.Path).TrimEnd('\')
  if($actual -ne $directory -and -not $actual.StartsWith($directory+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Allocation storage changed'}
  $disks=@(Get-VMHardDiskDrive -VM $v)
  if($disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne [IO.Path]::GetFullPath($c.disk)){throw 'Allocation disk changed'}
  return $v
}
function StopAllocation {
  $v=AllocationVM
  if($v -and $v.State -ne 'Off'){Stop-VM -VM $v -TurnOff -Force;$v=AllocationVM}
  if($v -and $v.State -ne 'Off'){throw 'Allocation shutdown was not confirmed'}
  return $v
}
switch ($Action) {
  'allocation-absence' {
    if(-not $c.brokerResourceLimit){throw 'Allocation absence checks require the protected broker'}
    $matches=@(Get-VM -ErrorAction Stop | Where-Object {$_.Name -eq $c.name -or ($c.expectedPlatformId -and [string]$_.Id -eq [string]$c.expectedPlatformId)})
    $switches=@(Get-VMSwitch -ErrorAction Stop | Where-Object {$_.Name -eq $c.name})
    [pscustomobject]@{absent=($matches.Count -eq 0 -and $switches.Count -eq 0)} | ConvertTo-Json -Compress
  }
  'recover-allocation' {
    $v=StopAllocation
    $ready=$false
    if($v){try{InspectVM | Out-Null;$ready=$true}catch{}}
    [pscustomobject]@{name=$c.name;state='Off';present=[bool]$v;platformId=$(if($v){[string]$v.Id}else{$null});ready=$ready} | ConvertTo-Json -Compress
  }
  'delete-allocation' {
    $v=StopAllocation
    if($v){Remove-VM -VM $v -Force}
    if(AllocationVM){throw 'VM removal was not confirmed'}
    $switches=@(Get-VMSwitch -ErrorAction Stop | Where-Object {$_.Name -eq $c.name})
    if($switches.Count -gt 1){throw 'Allocation switch name is ambiguous'}
    $s=if($switches.Count){$switches[0]}else{$null}
    if($s){
      if($s.SwitchType -ne 'Private' -or $s.Notes -ne $marker){throw 'Allocation switch ownership changed'}
      $attached=@(Get-VM -ErrorAction Stop | Get-VMNetworkAdapter -ErrorAction Stop | Where-Object { $_.SwitchId -eq $s.Id })
      if($attached.Count){throw 'Allocation switch is used by another VM'}
      Remove-VMSwitch -VMSwitch $s -Force
    }
    if(@(Get-VMSwitch -ErrorAction Stop | Where-Object {$_.Name -eq $c.name}).Count){throw 'Switch removal was not confirmed'}
    [pscustomobject]@{name=$c.name;state='Off';vmAbsent=$true;switchAbsent=$true} | ConvertTo-Json -Compress
  }
  'register-channel' {
    $servicePath='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\00009e4a-facb-11e6-bd58-64006a7986d3'
    $friendly='MuCodeSandbox host-initiated guest SSH'
    if(Test-Path -LiteralPath $servicePath) {
      if((Get-ItemProperty -LiteralPath $servicePath).ElementName -ne $friendly){throw 'Hyper-V channel ID belongs to another application'}
    } else {New-Item -Path $servicePath | Out-Null;New-ItemProperty -LiteralPath $servicePath -Name ElementName -Value $friendly -PropertyType String | Out-Null}
  }
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
    if ($c.brokerResourceLimit) {
      # A caller-readable differencing disk must not grant the elevated import
      # access to a parent disk that the caller cannot read. The broker supplies
      # this policy; no caller-selected output or policy fields reach this script.
      $sourceDisk = Get-VHD -Path $source.FullName
      if ($sourceDisk.VhdType -eq 'Differencing' -or $sourceDisk.ParentPath) { throw 'Broker imports require a standalone image without a parent disk' }
      if ($sourceDisk.Size -gt ([int64]$c.diskGiB*1GB)) { throw 'Source virtual capacity exceeds the allocated disk size' }
    }
    $inputDisk=$source.FullName
    $materialized=$null
    if(($source.Attributes -band [IO.FileAttributes]::SparseFile) -or $c.imagePatch) {
      # Canonical's tar preserves holes in its fixed VHD. Hyper-V refuses an
      # NTFS sparse input. Materialize only a new private copy; never alter the
      # caller's source image, compression, encryption, or filesystem settings.
      $materialized=Join-Path $c.directory ('import-source'+$source.Extension)
      $reader=[IO.File]::Open($source.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      try {
        $writer=[IO.File]::Open($materialized,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$reader.CopyTo($writer,1048576);$writer.Flush($true)}finally{$writer.Dispose()}
      }finally{$reader.Dispose()}
      if((Get-Item -LiteralPath $materialized).Attributes -band ([IO.FileAttributes]::SparseFile -bor [IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::Encrypted)) {throw 'Private import copy is not compatible with Hyper-V'}
      $inputDisk=$materialized
    }
    if($c.imagePatch) {
      $before=[Convert]::FromBase64String($c.imagePatch.before)
      $after=[Convert]::FromBase64String($c.imagePatch.after)
      if($before.Length -ne $after.Length -or -not $materialized){throw 'Invalid fixed-length local initialization recipe'}
      $patchFile=[IO.File]::Open($materialized,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      try {
        $patchFile.Position=[int64]$c.imagePatch.offset
        $actual=New-Object byte[] $before.Length
        if($patchFile.Read($actual,0,$actual.Length) -ne $actual.Length -or [Convert]::ToBase64String($actual) -ne $c.imagePatch.before){throw 'Pinned cloud-init recipe preimage did not match'}
        $patchFile.Position=[int64]$c.imagePatch.offset
        $patchFile.Write($after,0,$after.Length);$patchFile.Flush($true)
      }finally{$patchFile.Dispose()}
    }
    try {Convert-VHD -Path $inputDisk -DestinationPath $c.disk -VHDType Dynamic}
    finally{if($materialized -and (Test-Path -LiteralPath $materialized)){Remove-Item -LiteralPath $materialized}}
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
    $s = New-VMSwitch -Name $c.name -SwitchType Private -Notes $marker
    try {
      # Canonical Azure VHD uses BIOS boot. It is imported into a Generation 1
      # VM; no secure-boot setting is disabled on the host or another VM.
      $v = New-VM -Name $c.name -Generation 1 -MemoryStartupBytes ([int64]$c.memoryGiB*1GB) -VHDPath $c.disk -Path $c.directory
      Set-VM -VM $v -Notes $marker -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Disabled
      Set-VMProcessor -VM $v -Count $c.cpus -ExposeVirtualizationExtensions $false
      Set-VMMemory -VM $v -DynamicMemoryEnabled $false
      Set-VMComPort -VM $v -Number 1 -Path ('\\.\pipe\'+$c.name+'-serial')
      Get-VMNetworkAdapter -VM $v | Connect-VMNetworkAdapter -SwitchName $c.name
      Get-VMNetworkAdapter -VM $v | Set-VMNetworkAdapter -StaticMacAddress $c.mac -MacAddressSpoofing Off -DhcpGuard On -RouterGuard On
      foreach ($direction in @('Inbound','Outbound')) {
        Add-VMNetworkAdapterExtendedAcl -VM $v -Action Deny -Direction $direction -LocalIPAddress ANY -RemoteIPAddress ANY -Weight 1
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
  'status' { $v=OwnedVM; [pscustomobject]@{name=$v.Name;platformId=[string]$v.Id;state=[string]$v.State} | ConvertTo-Json -Compress }
  'stop' {
    $v=OwnedVM;if($v.State -ne 'Off'){Stop-VM -VM $v -TurnOff -Force};$v=OwnedVM
    if($v.State -ne 'Off'){throw 'Owned VM shutdown was not confirmed'}
    [pscustomobject]@{name=$v.Name;platformId=[string]$v.Id;state=[string]$v.State} | ConvertTo-Json -Compress
  }
}
