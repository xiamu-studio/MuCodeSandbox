[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('doctor','register-channel','disk','export-base','seal-base','create','start','stop','status','inspect','fingerprint','recover-allocation','delete-allocation','allocation-absence','cache-dependencies','resource-inventory','review-allocation','review-snapshot-delete','review-snapshot-staging','disk-growth-facts','grow-disk','compact-disk','compact-disk-submit','compact-disk-job','backup-import-verify','snapshot-verify','snapshot-apply')][string]$Action)
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
  $queries = [ordered]@{
    adapters = { Get-NetAdapter | Where-Object { $_.Name -notlike 'vEthernet (mu-win-*' } | Sort-Object InterfaceGuid | Select-Object InterfaceGuid,Status,LinkSpeed }.ToString()
    routes = { Get-NetRoute -AddressFamily IPv4,IPv6 | Where-Object { $_.InterfaceAlias -notlike 'vEthernet (mu-win-*' } | Sort-Object DestinationPrefix,InterfaceIndex,NextHop,RouteMetric | Select-Object DestinationPrefix,NextHop,InterfaceIndex,RouteMetric }.ToString()
    dns = { Get-DnsClientServerAddress | Where-Object { $_.InterfaceAlias -notlike 'vEthernet (mu-win-*' } | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses }.ToString()
  }
  $pool = [RunspaceFactory]::CreateRunspacePool(1,3)
  $pending = @()
  try {
    $pool.Open()
    foreach($name in $queries.Keys){
      $worker = [PowerShell]::Create()
      $pending += @{ name=$name; worker=$worker; handle=$null }
      $worker.RunspacePool = $pool
      [void]$worker.AddScript("`$ErrorActionPreference='Stop';" + $queries[$name])
      $pending[-1].handle = $worker.BeginInvoke()
    }
    $snapshot = [ordered]@{}; $queryFailed = $false
    # Drain every independent read even on failure; never publish a partial snapshot.
    foreach($item in $pending){
      try { $snapshot[$item.name] = @($item.worker.EndInvoke($item.handle)); if($item.worker.HadErrors){ $queryFailed=$true } }
      catch { $queryFailed=$true }
    }
    if($queryFailed){ throw 'Network fingerprint queries failed' }
    [pscustomobject]$snapshot | ConvertTo-Json -Depth 6 -Compress
  } finally {
    foreach($item in $pending){ $item.worker.Dispose() }
    $pool.Dispose()
  }
  exit 0
}
if (-not $isAdmin) { throw 'Administrator PowerShell is required for this preview' }
Import-Module Hyper-V
$inputText = [Console]::In.ReadToEnd()
$c = $inputText | ConvertFrom-Json
if($Action -eq 'resource-inventory'){
 $root=[IO.Path]::GetFullPath([string]$c.resourceRoot).TrimEnd('\');$users=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MuCodeSandbox-HyperVBroker-v1/users'))
 $sid=[IO.Path]::GetFileName($root);if([IO.Path]::GetDirectoryName($root) -ne $users -or ([Security.Principal.SecurityIdentifier]::new($sid)).Value -ne $sid){throw 'Fixed protected resource root required'}
 $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__RESOURCE_METRICS_BASE64__'))
 Add-Type -TypeDefinition ('using System;using System.IO;using System.Text;using System.Runtime.InteropServices;'+[Environment]::NewLine+$source)
 $volume=[MuResourceMetrics]::Volume($root);$paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 [long]$assignedMemory=0
 foreach($vm in @(Get-VM -ErrorAction Stop)){if($assignedMemory -gt [long]::MaxValue-[long]$vm.MemoryAssigned){throw 'Assigned memory total overflow'};$assignedMemory+=[long]$vm.MemoryAssigned;foreach($drive in @(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)){if($drive.Path){[void]$paths.Add([string]$drive.Path)}}}
 foreach($user in @(Get-ChildItem -LiteralPath $users -Directory -ErrorAction Stop)){
  if($user.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Protected user storage reparse point rejected'}
  $vms=Join-Path $user.FullName 'vms';if(-not (Test-Path -LiteralPath $vms)){continue}
  if((Get-Item -LiteralPath $vms).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Protected disk directory reparse point rejected'}
  foreach($allocation in @(Get-ChildItem -LiteralPath $vms -Directory)){
   if($allocation.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Protected disk allocation reparse point rejected'}
   $disk=Join-Path $allocation.FullName 'disk.vhdx';if(Test-Path -LiteralPath $disk){[void]$paths.Add($disk)}
  }
 }
 if($paths.Count -gt 2048){throw 'Disk reservation inventory exceeds its fixed bound'}
 [long]$growth=0;[int]$count=0
 foreach($path in $paths){
  $full=[IO.Path]::GetFullPath($path)
  # Remote volumes do not consume this local volume. Never open a remote path.
  if($full -notmatch '^[a-zA-Z]:\\' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -eq 'Network'){continue}
  $cursor=[IO.Path]::GetPathRoot($full)
  foreach($part in $full.Substring($cursor.Length).Split('\')){$cursor=Join-Path $cursor $part;if([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint){throw 'Local disk reservation reparse point rejected'}}
  if([MuResourceMetrics]::Volume($full) -ne $volume){continue}
  $disk=Get-VHD -Path $full -ErrorAction Stop;$allocated=[MuResourceMetrics]::AllocatedBytes($full);$extra=[Math]::Max([long]0,([MuResourceMetrics]::DiskFootprint([long]$disk.Size)-$allocated))
  if($growth -gt [long]::MaxValue-$extra){throw 'Disk reservation total overflow'};$growth+=$extra;$count++
 }
 @{reservedGrowthBytes=$growth;disks=$count;assignedMemoryBytes=$assignedMemory} | ConvertTo-Json -Compress;exit 0
}
if($Action -eq 'cache-dependencies'){
 $root=[IO.Path]::GetFullPath([string]$c.cacheRoot).TrimEnd('\');$users=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MuCodeSandbox-HyperVBroker-v1/users'))
 $sid=[IO.Path]::GetFileName($root)
 if([IO.Path]::GetDirectoryName($root) -ne $users -or ([Security.Principal.SecurityIdentifier]::new($sid)).Value -ne $sid){throw 'Fixed protected cache root required'}
 $images=Join-Path $root 'images';$paths=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in @(Get-ChildItem -LiteralPath $images -File)){$paths[[IO.Path]::GetFullPath($entry.FullName)]=$entry.Name}
 $referenced=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 function Assert-LocalDiskPath([string]$value){
  $full=[IO.Path]::GetFullPath($value)
  if($full -notmatch '^[a-zA-Z]:\\' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -eq 'Network'){throw 'Remote disk dependency cannot be inspected without network access'}
  $cursor=[IO.Path]::GetPathRoot($full)
  foreach($part in $full.Substring($cursor.Length).Split('\')){$cursor=Join-Path $cursor $part;if([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint){throw 'Disk dependency reparse point rejected'}}
  return $full
 }
 $drives=@()
 foreach($vm in @(Get-VM -ErrorAction Stop)){
  $drives+=@(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
  foreach($snapshot in @(Get-VMSnapshot -VM $vm -ErrorAction Stop)){$drives+=@(Get-VMHardDiskDrive -VMSnapshot $snapshot -ErrorAction Stop)}
  if($drives.Count -gt 1024){throw 'Disk dependency inventory exceeds its fixed bound'}
 }
 foreach($drive in $drives){
  $path=[string]$drive.Path;$depth=0
  while($path){
   if(++$depth -gt 32){throw 'Disk dependency chain exceeds its fixed bound'}
   $full=Assert-LocalDiskPath $path;if(-not $seen.Add($full)){break}
   if($paths.ContainsKey($full)){[void]$referenced.Add($paths[$full])}
   $disk=Get-VHD -Path $full -ErrorAction Stop;$path=[string]$disk.ParentPath
  }
 }
 foreach($image in @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_DiskImage -ErrorAction Stop)){
  if($image.Attached -and $image.ImagePath){$full=[IO.Path]::GetFullPath([string]$image.ImagePath);if($paths.ContainsKey($full)){[void]$referenced.Add($paths[$full])}}
 }
 # Return only names in this user's cache. Other VM names, paths and data never
 # cross the privileged boundary and no dependency is changed or mounted.
 @{referenced=@($referenced | Sort-Object)} | ConvertTo-Json -Compress
 exit 0
}
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
function ReviewAllocation {
    # Read-only admission for an explicit recovery session. No missing or changed
    # resource is repaired here and a running guest is never stopped implicitly.
    $v=AllocationVM
    if(-not $v -or $v.State -ne 'Off' -or $v.Generation -ne 1 -or [string]$v.CheckpointType -ne 'Disabled' -or [string]$v.AutomaticStopAction -ne 'TurnOff'){throw 'Only an intact stopped preview VM can be adopted'}
    InspectVM | Out-Null
    if(@(Get-VMSnapshot -VM $v -ErrorAction Stop).Count){throw 'Snapshot recovery requires a separate reviewed migration'}
    $memory=Get-VMMemory -VM $v -ErrorAction Stop;$processor=Get-VMProcessor -VM $v -ErrorAction Stop
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($memory.DynamicMemoryEnabled -or $memory.Startup % 1GB -or $disk.Size % 1GB -or $disk.ParentPath -or [string]$disk.VhdType -eq 'Differencing' -or $processor.ExposeVirtualizationExtensions){throw 'Recovery VM resource boundary changed'}
    $nic=@(Get-VMNetworkAdapter -VM $v -ErrorAction Stop)[0]
    if($nic.DynamicMacAddressEnabled -or $nic.MacAddress -ne $c.mac -or [string]$nic.MacAddressSpoofing -ne 'Off' -or [string]$nic.DhcpGuard -ne 'On' -or [string]$nic.RouterGuard -ne 'On'){throw 'Recovery VM adapter policy changed'}
    $dvd=@(Get-VMDvdDrive -VM $v -ErrorAction Stop)
    if($dvd.Count -ne 1 -or [IO.Path]::GetFullPath([string]$dvd[0].Path) -ne [IO.Path]::GetFullPath($c.seed)){throw 'Recovery VM seed identity changed'}
    $references=@(Get-VM -ErrorAction Stop | Get-VMHardDiskDrive -ErrorAction Stop | Where-Object{$_.Path -and [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($c.disk)})
    if($references.Count -ne 1 -or [string]$references[0].VMId -ne [string]$v.Id){throw 'Recovery disk is shared with another VM'}
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$drives=@()
    foreach($other in @(Get-VM -ErrorAction Stop)){
      foreach($drive in @(Get-VMHardDiskDrive -VM $other -ErrorAction Stop)){$drives+=@{path=[string]$drive.Path;owner=[string]$other.Id;snapshot=$false}}
      foreach($snapshot in @(Get-VMSnapshot -VM $other -ErrorAction Stop)){foreach($drive in @(Get-VMHardDiskDrive -VMSnapshot $snapshot -ErrorAction Stop)){$drives+=@{path=[string]$drive.Path;owner=[string]$other.Id;snapshot=$true}}}
      if($drives.Count -gt 1024){throw 'Recovery dependency inventory exceeds its fixed bound'}
    }
    foreach($drive in $drives){$path=$drive.path;$depth=0;while($path){
      if(++$depth -gt 32){throw 'Recovery parent chain exceeds its fixed bound'};$full=[IO.Path]::GetFullPath($path)
      if($full -notmatch '^[a-zA-Z]:\\' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -eq 'Network'){throw 'Remote recovery dependencies cannot be inspected'}
      $cursor=[IO.Path]::GetPathRoot($full);foreach($part in $full.Substring($cursor.Length).Split('\')){$cursor=Join-Path $cursor $part;if([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint){throw 'Recovery dependency reparse point rejected'}}
      if($full -eq [IO.Path]::GetFullPath($c.disk) -and ($depth -ne 1 -or $drive.owner -ne [string]$v.Id -or $drive.snapshot)){throw 'Another disk or snapshot depends on the recovery disk'}
      if(-not $paths.Add($full)){break};$parent=Get-VHD -Path $full -ErrorAction Stop;$path=[string]$parent.ParentPath
    }}
    @{platformId=[string]$v.Id;cpus=[int]$processor.Count;memoryGiB=[int]($memory.Startup/1GB);diskGiB=[int]($disk.Size/1GB)} | ConvertTo-Json -Compress
  }
function SnapshotDependencyPath([string]$value,[bool]$allowMissing=$false){
    if([string]::IsNullOrWhiteSpace($value)){throw 'Empty snapshot dependency path'}
    $full=[IO.Path]::GetFullPath($value)
    if($full -notmatch '^[a-zA-Z]:\\' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full)).DriveType -eq 'Network'){throw 'Remote snapshot dependencies cannot be inspected'}
    $cursor=[IO.Path]::GetPathRoot($full)
    foreach($part in $full.Substring($cursor.Length).Split('\')){
      $cursor=Join-Path $cursor $part
      try{$attributes=[IO.File]::GetAttributes($cursor)}
      catch [IO.FileNotFoundException]{if($allowMissing){return $full};throw}
      catch [IO.DirectoryNotFoundException]{if($allowMissing){return $full};throw}
      if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Snapshot dependency reparse point rejected'}
    }
    return $full
}
function ReviewSnapshotDeletion {
    param([string]$StagingOperation='')
    # Admission only: never stop, mount, detach or repair a dependency. This is
    # deliberately separate from stopped disk/configuration adoption. The live
    # deletion coordinator must also hold its own authority and cancellation
    # fence; this receipt alone is not permission to delete files.
    if(-not $c.brokerResourceLimit){throw 'Snapshot deletion requires the protected broker'}
    $snapshotId=[string]$c.snapshotId;$parsed=[guid]::Empty
    if($StagingOperation -and $StagingOperation -cnotin @('create','restore')){throw 'Fixed staging operation required'}
    if(-not [guid]::TryParseExact($snapshotId,'D',[ref]$parsed) -or $parsed -eq [guid]::Empty -or $parsed.ToString('D') -cne $snapshotId){throw 'Canonical snapshot deletion identity required'}
    if(-not $c.expectedPlatformId){throw 'Protected platform identity required'}
    $v=AllocationVM
    if(-not $v -or [string]$v.State -notin @('Off','Running') -or $v.Generation -ne 1 -or [string]$v.CheckpointType -ne 'Disabled' -or [string]$v.AutomaticStopAction -ne 'TurnOff'){throw 'Only an intact stopped or running preview VM can delete a snapshot'}
    if($StagingOperation -and [string]$v.State -ne 'Off'){throw 'Staging cleanup requires a stopped VM'}
    InspectVM | Out-Null
    if(@(Get-VMSnapshot -VM $v -ErrorAction Stop).Count){throw 'Hyper-V checkpoints require separate review'}
    $memory=Get-VMMemory -VM $v -ErrorAction Stop;$processor=Get-VMProcessor -VM $v -ErrorAction Stop
    $current=SnapshotDependencyPath ([string]$c.disk);$seed=SnapshotDependencyPath ([string]$c.seed)
    $disk=Get-VHD -Path $current -ErrorAction Stop
    if($memory.DynamicMemoryEnabled -or $memory.Startup % 1GB -or $disk.Size % 1GB -or $disk.ParentPath -or [string]$disk.VhdType -ne 'Dynamic' -or [string]$disk.VhdFormat -ne 'VHDX' -or $processor.ExposeVirtualizationExtensions){throw 'Snapshot deletion resource boundary changed'}
    if([long]$processor.Count -ne [long]$c.cpus -or [long]$memory.Startup -ne [long]$c.memoryGiB*1GB -or [long]$disk.Size -ne [long]$c.diskGiB*1GB){throw 'Snapshot deletion resources differ from protected registration'}
    $nic=@(Get-VMNetworkAdapter -VM $v -ErrorAction Stop)[0]
    if($nic.DynamicMacAddressEnabled -or $nic.MacAddress -ne $c.mac -or [string]$nic.MacAddressSpoofing -ne 'Off' -or [string]$nic.DhcpGuard -ne 'On' -or [string]$nic.RouterGuard -ne 'On'){throw 'Snapshot deletion adapter policy changed'}
    $dvd=@(Get-VMDvdDrive -VM $v -ErrorAction Stop)
    if($dvd.Count -ne 1 -or (SnapshotDependencyPath ([string]$dvd[0].Path)) -ne $seed){throw 'Snapshot deletion current seed changed'}
    $root=Join-Path ([string]$c.directory) 'snapshots'
    # Both names are fixed by the durable deletion protocol. Partial retries
    # can have neither copy left; provider errors still fail closed below.
    $candidates=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $candidateNames=if($StagingOperation){@($StagingOperation+'-next-'+$snapshotId)}else{@($snapshotId,('delete-active-'+$snapshotId))}
    $candidateFiles=if($StagingOperation -eq 'restore'){@('disk.next','seed.next')}else{@('disk.vhdx','seed.iso')}
    foreach($name in $candidateNames){
      foreach($file in $candidateFiles){
        $candidate=SnapshotDependencyPath (Join-Path (Join-Path $root $name) $file) $true
        if($candidate -eq $current -or $candidate -eq $seed){throw 'Snapshot deletion aliases current storage'}
        [void]$candidates.Add($candidate)
        # File.Exists hides access failures. GetAttributes distinguishes only
        # ordinary absence, including a partially completed prior deletion.
        $exists=$true;try{$attributes=[IO.File]::GetAttributes($candidate)}catch [IO.FileNotFoundException]{$exists=$false}catch [IO.DirectoryNotFoundException]{$exists=$false}
        if($exists){
          if($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)){throw 'Snapshot deletion candidate must be an ordinary file'}
          if(-not $StagingOperation -and $file -eq 'disk.vhdx'){$copy=Get-VHD -Path $candidate -ErrorAction Stop;if($copy.Attached -isnot [bool] -or $copy.Attached -or $copy.ParentPath -or [string]$copy.VhdType -ne 'Dynamic' -or [string]$copy.VhdFormat -ne 'VHDX'){throw 'Snapshot deletion disk is attached or not an independent full copy'}}
        }
      }
    }
    $all=@(Get-VM -ErrorAction Stop);if($all.Count -gt 1024){throw 'Snapshot VM inventory exceeds its fixed bound'}
    $drives=[Collections.Generic.List[object]]::new();$snapshots=0
    foreach($other in $all){
      foreach($drive in @(Get-VMHardDiskDrive -VM $other -ErrorAction Stop)){$drives.Add(@{path=[string]$drive.Path;owner=[string]$other.Id;checkpoint=$false;iso=$false})}
      foreach($drive in @(Get-VMDvdDrive -VM $other -ErrorAction Stop)){$drives.Add(@{path=[string]$drive.Path;owner=[string]$other.Id;checkpoint=$false;iso=$true})}
      $points=@(Get-VMSnapshot -VM $other -ErrorAction Stop);$snapshots+=$points.Count;if($snapshots -gt 1024){throw 'Snapshot checkpoint inventory exceeds its fixed bound'}
      foreach($point in $points){
        foreach($drive in @(Get-VMHardDiskDrive -VMSnapshot $point -ErrorAction Stop)){$drives.Add(@{path=[string]$drive.Path;owner=[string]$other.Id;checkpoint=$true;iso=$false})}
        foreach($drive in @(Get-VMDvdDrive -VMSnapshot $point -ErrorAction Stop)){$drives.Add(@{path=[string]$drive.Path;owner=[string]$other.Id;checkpoint=$true;iso=$true})}
      }
      if($drives.Count -gt 1024){throw 'Snapshot dependency inventory exceeds its fixed bound'}
    }
    $ownDisks=0;$ownSeeds=0
    foreach($drive in $drives){
      if(-not $drive.path){if($drive.iso){continue};throw 'Empty VM disk dependency'}
      $path=$drive.path;$depth=0;$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      while($path){
        if(++$depth -gt 32){throw 'Snapshot dependency parent chain exceeds its fixed bound'}
        $full=SnapshotDependencyPath $path
        if(-not $seen.Add($full)){throw 'Snapshot dependency parent cycle rejected'}
        if($candidates.Contains($full)){throw 'A VM or checkpoint references the snapshot deletion copy'}
        if($full -eq $current){if($depth -ne 1 -or $drive.owner -ne [string]$v.Id -or $drive.checkpoint -or $drive.iso){throw 'Current disk has another dependency'};$ownDisks++}
        if($full -eq $seed){if($depth -ne 1 -or $drive.owner -ne [string]$v.Id -or $drive.checkpoint -or -not $drive.iso){throw 'Current seed has another dependency'};$ownSeeds++}
        if($drive.iso){break}
        $parent=Get-VHD -Path $full -ErrorAction Stop;$path=[string]$parent.ParentPath
      }
    }
    if($ownDisks -ne 1 -or $ownSeeds -ne 1){throw 'Current storage dependency inventory changed'}
    $images=@(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_DiskImage -ErrorAction Stop)
    if($images.Count -gt 2048){throw 'Mounted image inventory exceeds its fixed bound'}
    foreach($image in $images){if($image.Attached -isnot [bool]){throw 'Mounted image attachment state is unknown'};if($image.Attached){$full=SnapshotDependencyPath ([string]$image.ImagePath);if($candidates.Contains($full)){throw 'The host has mounted the snapshot deletion copy'}}}
    # Catch identity/state changes during inventory; never turn a transition
    # into an affirmative receipt, and never repair it in an admission check.
    $after=AllocationVM
    if(-not $after -or [string]$after.Id -ne [string]$v.Id -or [string]$after.State -notin @('Off','Running')){throw 'Snapshot deletion allocation changed during review'}
    if($StagingOperation -and [string]$after.State -ne 'Off'){throw 'Staging cleanup stop state changed during review'}
    @{platformId=[string]$v.Id;snapshotId=$snapshotId;state=[string]$after.State;cpus=[int]$processor.Count;memoryGiB=[int]($memory.Startup/1GB);diskGiB=[int]($disk.Size/1GB);unreferenced=$true} | ConvertTo-Json -Compress
}
switch ($Action) {
  'review-snapshot-delete' { ReviewSnapshotDeletion }
  'review-snapshot-staging' { if([string]$c.stagingOperation -cnotin @('create','restore')){throw 'Fixed staging operation required'};ReviewSnapshotDeletion -StagingOperation ([string]$c.stagingOperation) }
  'snapshot-verify' {
    if(-not $c.brokerResourceLimit){throw 'Snapshots require the protected broker'}
    ReviewAllocation | Out-Null
    $expectedRoot=[IO.Path]::GetFullPath((Join-Path $c.directory 'snapshots')).TrimEnd('\')+'\'
    $snapshotFile=[IO.Path]::GetFullPath([string]$c.snapshotDisk)
    if(-not $snapshotFile.StartsWith($expectedRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($snapshotFile) -ne 'disk.vhdx' -or ([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($snapshotFile))) -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'Fixed snapshot disk required'}
    $disk=Get-VHD -Path $snapshotFile -ErrorAction Stop
    if($disk.Attached -or $disk.ParentPath -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.Size -ne ([long]$c.snapshotDiskGiB*1GB)){throw 'Snapshot disk layout differs from its protected resource record'}
    @{verified=$true;state='Off'} | ConvertTo-Json -Compress
  }
  'snapshot-apply' {
    if(-not $c.brokerResourceLimit){throw 'Snapshots require the protected broker'}
    $review=ReviewAllocation | ConvertFrom-Json
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.Attached -or $disk.ParentPath -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.Size -ne ([long]$c.diskGiB*1GB)){throw 'Restored snapshot capacity or disk layout changed'}
    $vm=OwnedVM
    Set-VMProcessor -VM $vm -Count $c.cpus -ExposeVirtualizationExtensions $false
    Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ([long]$c.memoryGiB*1GB)
    $actual=ReviewAllocation | ConvertFrom-Json
    if($actual.cpus -ne $c.cpus -or $actual.memoryGiB -ne $c.memoryGiB -or $actual.diskGiB -ne $c.diskGiB){throw 'Snapshot resources were not applied exactly'}
    $actual | ConvertTo-Json -Compress
  }
  'backup-import-verify' {
    if(-not $c.brokerResourceLimit){throw 'Backup restore requires the protected broker'}
    $v=AllocationVM
    if($v){
      if($v.State -ne 'Off'){throw 'A restore cannot use a running VM'}
      # A resumed or newly created VM must still match the reviewed backup.
      # Reuse read-only topology, policy, seed and dependency validation; do not
      # silently repair an existing allocation to make it pass.
      $review=ReviewAllocation | ConvertFrom-Json
      if($review.cpus -ne $c.cpus -or $review.memoryGiB -ne $c.memoryGiB -or $review.diskGiB -ne $c.diskGiB){throw 'Restored VM resources differ from the reviewed backup'}
    }
    foreach($path in @($c.disk,$c.seed)){if((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Restore input reparse point rejected'}}
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.Attached -or $disk.ParentPath -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.Size -ne ([long]$c.diskGiB*1GB)){throw 'Restored disk must be a detached standalone dynamic VHDX with the exact reviewed capacity'}
    @{verified=$true;state='Off';diskGiB=[int]$c.diskGiB}|ConvertTo-Json -Compress
  }
  'disk-growth-facts' {
    $review=ReviewAllocation | ConvertFrom-Json
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.Attached -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.ParentPath){throw 'Disk growth requires a detached standalone dynamic VHDX'}
    @{platformId=$review.platformId;diskGiB=$review.diskGiB;diskIdentifier=([guid]$disk.DiskIdentifier).ToString('D');bytes=[long]$disk.Size} | ConvertTo-Json -Compress
  }
  'grow-disk' {
    $review=ReviewAllocation | ConvertFrom-Json
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.Attached -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.ParentPath -or ([guid]$disk.DiskIdentifier).ToString('D') -ne [string]$c.growthDiskIdentifier){throw 'Disk growth input identity changed'}
    [long]$target=[long]$c.diskGiB*1GB
    if(($c.diskGiB -isnot [int] -and $c.diskGiB -isnot [long]) -or $c.diskGiB -lt 16 -or $c.diskGiB -gt 256 -or $disk.Size -gt $target){throw 'Disk shrinking and unknown capacities are forbidden'}
    if($disk.Size -lt $target){Resize-VHD -Path $c.disk -SizeBytes $target -ErrorAction Stop}
    $actual=Get-VHD -Path $c.disk -ErrorAction Stop
    if($actual.Size -ne $target -or ([guid]$actual.DiskIdentifier).ToString('D') -ne [string]$c.growthDiskIdentifier -or (OwnedVM).State -ne 'Off'){throw 'Disk growth completion is unconfirmed'}
    @{platformId=$review.platformId;diskGiB=[int]$c.diskGiB;diskIdentifier=([guid]$actual.DiskIdentifier).ToString('D');bytes=[long]$actual.Size} | ConvertTo-Json -Compress
  }
  'compact-disk-submit' {
    # Experimental primitive: callers must persist their own submission fence
    # before invoking this and preserve it if the returned job is lost.
    if(-not $c.brokerResourceLimit -or -not $c.expectedPlatformId){throw 'Protected disk maintenance authority required'}
    $diskId=[guid]::Empty
    if(-not [guid]::TryParseExact([string]$c.compactDiskIdentifier,'D',[ref]$diskId) -or $diskId -eq [guid]::Empty -or $diskId.ToString('D') -cne [string]$c.compactDiskIdentifier){throw 'Canonical compact disk identity required'}
    if(($c.diskGiB -isnot [int] -and $c.diskGiB -isnot [long]) -or $c.diskGiB -lt 16 -or $c.diskGiB -gt 256){throw 'Unexpected disk capacity'}
    $review=ReviewAllocation | ConvertFrom-Json
    if([string]$review.platformId -ne [string]$c.expectedPlatformId -or $review.diskGiB -ne $c.diskGiB){throw 'Compaction VM identity or capacity changed'}
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.Attached -or $disk.ParentPath -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.Size -ne ([long]$c.diskGiB*1GB) -or ([guid]$disk.DiskIdentifier) -ne $diskId){throw 'Compaction input identity changed'}
      if($c.compactOperationId){
        $operation=[guid]::Empty
        if(-not [guid]::TryParseExact([string]$c.compactOperationId,'D',[ref]$operation) -or $operation -eq [guid]::Empty -or $operation.ToString('D') -cne [string]$c.compactOperationId){throw 'Canonical compaction operation identity required'}
        $directory=Join-Path $env:USERPROFILE 'compaction-receipts'
        if(-not (Test-Path -LiteralPath $directory -PathType Container) -or ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Protected compaction receipt directory unavailable'}
        $final=Join-Path $directory ($operation.ToString('D')+'.json');$next=$final+'.next'
        if((Test-Path -LiteralPath $final) -or (Test-Path -LiteralPath $next)){throw 'Compaction receipt already exists'}
      }
    $service=@(Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_ImageManagementService -ErrorAction Stop)
    if($service.Count -ne 1 -or $service[0].Name -ne 'vhdsvc'){throw 'Image management service identity unavailable'}
    $result=Invoke-CimMethod -InputObject $service[0] -MethodName CompactVirtualHardDisk -Arguments @{Path=[string]$c.disk;Mode=[uint16]3} -ErrorAction Stop
    if($null -eq $result.ReturnValue){throw 'Compaction submission result is unconfirmed'}
      if([int]$result.ReturnValue -eq 0){$receipt=@{submitted='completed';jobId=$null}}
    else{
      $jobId=[guid]::Empty
      if([int]$result.ReturnValue -ne 4096 -or -not $result.Job -or $result.Job.CimClass.CimClassName -ne 'Msvm_StorageJob' -or -not [guid]::TryParseExact([string]$result.Job.InstanceID,'D',[ref]$jobId) -or $jobId -eq [guid]::Empty){throw 'Compaction submission result is unconfirmed'}
        $receipt=@{submitted='started';jobId=$jobId.ToString('D')}
    }
      # The protected broker may supply a journal-bound nonce. Publish the
      # exact provider receipt before replying, so a broker restart can inspect
      # it without guessing a job or re-submitting. A crash before publication
      # remains unconfirmed and must keep the existing fence.
      if($c.compactOperationId){
        $body=@{operationId=$operation.ToString('D');platformId=[string]$c.expectedPlatformId;diskIdentifier=$diskId.ToString('D');submitted=$receipt.submitted;jobId=$receipt.jobId}|ConvertTo-Json -Compress
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes($body)
        $file=[IO.FileStream]::new($next,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
        [IO.File]::Move($next,$final)
      }
      $receipt | ConvertTo-Json -Compress
  }
  'compact-disk-job' {
    # Observation only; no timeout, disappearance or non-successful state is
    # evidence that the operation ended or that it may be repeated.
    if(-not $c.brokerResourceLimit -or -not $c.expectedPlatformId){throw 'Protected disk maintenance authority required'}
    $jobId=[guid]::Empty
    if(-not [guid]::TryParseExact([string]$c.compactJobId,'D',[ref]$jobId) -or $jobId -eq [guid]::Empty -or $jobId.ToString('D') -cne [string]$c.compactJobId){throw 'Canonical compaction job identity required'}
    $jobs=@(Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_StorageJob -Filter ("InstanceID='"+$jobId.ToString('D')+"'") -ErrorAction Stop)
    if($jobs.Count -ne 1 -or ([guid]$jobs[0].InstanceID) -ne $jobId){throw 'Compaction job not uniquely available'}
    if($null -eq $jobs[0].JobState -or $null -eq $jobs[0].ErrorCode -or $null -eq $jobs[0].JobCompletionStatusCode -or $null -eq $jobs[0].JobType -or [int]$jobs[0].JobType -ne 3){throw 'Compaction job status is incomplete or has the wrong type'}
    @{jobId=$jobId.ToString('D');state=[int]$jobs[0].JobState;errorCode=[int]$jobs[0].ErrorCode;completionCode=[long]$jobs[0].JobCompletionStatusCode} | ConvertTo-Json -Compress
  }
  'compact-disk' {
    # Internal primitive only. The protected broker must hold a durable
    # compaction journal and its VM/operation gates before invoking this.
    if(-not $c.brokerResourceLimit -or -not $c.expectedPlatformId){throw 'Protected disk maintenance authority required'}
    $diskId=[guid]::Empty
    if(-not [guid]::TryParseExact([string]$c.compactDiskIdentifier,'D',[ref]$diskId) -or $diskId -eq [guid]::Empty -or $diskId.ToString('D') -cne [string]$c.compactDiskIdentifier){throw 'Canonical compact disk identity required'}
    if(($c.diskGiB -isnot [int] -and $c.diskGiB -isnot [long]) -or $c.diskGiB -lt 16 -or $c.diskGiB -gt 256){throw 'Unexpected disk capacity'}
    $review=ReviewAllocation | ConvertFrom-Json
    if([string]$review.platformId -ne [string]$c.expectedPlatformId -or $review.diskGiB -ne $c.diskGiB){throw 'Compaction VM identity or capacity changed'}
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.Attached -or $disk.ParentPath -or [string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or $disk.Size -ne ([long]$c.diskGiB*1GB) -or ([guid]$disk.DiskIdentifier) -ne $diskId){throw 'Compaction input identity changed'}
    Optimize-VHD -Path $c.disk -Mode Pretrimmed -ErrorAction Stop
    $actual=Get-VHD -Path $c.disk -ErrorAction Stop
    if($actual.Attached -or $actual.ParentPath -or [string]$actual.VhdFormat -ne 'VHDX' -or [string]$actual.VhdType -ne 'Dynamic' -or $actual.Size -ne ([long]$c.diskGiB*1GB) -or ([guid]$actual.DiskIdentifier) -ne $diskId){throw 'Compaction completion identity changed'}
    $after=ReviewAllocation | ConvertFrom-Json
    if([string]$after.platformId -ne [string]$review.platformId -or $after.diskGiB -ne $review.diskGiB){throw 'Compaction completion VM review changed'}
    @{platformId=$after.platformId;diskGiB=[int]$c.diskGiB;diskIdentifier=$diskId.ToString('D');bytes=[long]$actual.Size} | ConvertTo-Json -Compress
  }
  'review-allocation' { ReviewAllocation }
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
  'seal-base' {
    $v=StopAllocation
    if(-not $v){throw 'Base builder is missing'}
    InspectVM | Out-Null
    $disk=Get-VHD -Path $c.disk -ErrorAction Stop
    if($disk.ParentPath -or $disk.Size -ne 32GB -or $disk.VhdFormat -ne 'VHDX'){throw 'Expected a self-contained 32 GiB base builder'}
    [pscustomobject]@{state='Off';verified=$true} | ConvertTo-Json -Compress
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
