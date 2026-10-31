param([Parameter(Mandatory)][string]$CasePath,[switch]$ApprovedNewTestVolume,[switch]$Dismount)
# Explicitly approved creation of one new, bounded, disposable filesystem only.
# Never accepts a disk number, physical disk path, existing VHD or target volume.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$caseFile=[IO.Path]::GetFullPath($CasePath);$c=Get-Content -LiteralPath $caseFile -Raw -Encoding UTF8|ConvertFrom-Json
$parent='F:\Projects\MuCodeSandbox\.mu-data\windows-runtime'
$directory=[IO.Path]::GetFullPath([string]$c.directory)
if([IO.Path]::GetDirectoryName($directory) -ne $parent -or [IO.Path]::GetFileName($directory) -notmatch '^space-test-[a-f0-9-]{36}$' -or $caseFile -ne (Join-Path $directory 'volume-plan.json')){throw 'Fixed new test directory required'}
$diskPath=Join-Path $directory 'bounded-space-test.vhdx';$size=3GB
if([string]$c.diskPath -ne $diskPath -or [long]$c.maximumBytes -ne $size -or [string]$c.driveLetter -ne 'R' -or [string]$c.nonce -notmatch '^[a-f0-9-]{36}$'){throw 'Pinned bounded volume plan required'}
$cursor=$directory;while($cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Test directory ancestor reparse point rejected'};$cursor=[IO.Path]::GetDirectoryName($cursor)}
$receipt=Join-Path $directory 'volume-receipt.json';$created=Join-Path $directory 'created-image.json'
if(-not $Dismount -and -not $ApprovedNewTestVolume){throw 'Explicit authorization is required to create and format this new test volume'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'This new-volume operation requires an elevated operator'}
Import-Module Hyper-V
function Save-Json([string]$file,$value){[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))}
function File-Backed($disk){return [int]$disk.CimInstanceProperties['BusType'].Value -eq 15}
function Pinned-Image {
 $saved=Get-Content -LiteralPath $created -Raw -Encoding UTF8|ConvertFrom-Json
 if($saved.nonce -ne $c.nonce -or $saved.path -ne $diskPath -or ((Get-Item -LiteralPath $diskPath).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Created test image identity changed'}
 $image=Get-VHD -Path $diskPath
 if($image.Path -ne $diskPath -or [long]$image.Size -ne $size -or [string]$image.VhdFormat -ne 'VHDX' -or [string]$image.VhdType -ne 'Dynamic' -or [string]$image.DiskIdentifier -ne [string]$saved.identifier){throw 'Bounded test image no longer matches its creation receipt'}
 return $image
}
if($Dismount){
 $image=Pinned-Image
 if($image.Attached){Dismount-VHD -Path $diskPath}
 if((Pinned-Image).Attached){throw 'Test image detach was not confirmed'}
 Save-Json (Join-Path $directory 'volume-detached.json') @{complete=$true;time=[DateTime]::UtcNow.ToString('o');nonce=$c.nonce;path=$diskPath;imagePreserved=$true}
 exit 0
}
if(Test-Path -LiteralPath $diskPath){throw 'An existing image is never recreated or formatted'}
if(Test-Path -LiteralPath $created){throw 'Existing creation receipt is preserved'}
if([IO.DriveInfo]::new('F:\').AvailableFreeSpace -lt 8GB){throw 'Insufficient host margin for the bounded new image'}
if((Get-PSDrive -PSProvider FileSystem|Where-Object Name -eq 'R') -or @(Get-Partition|Where-Object DriveLetter -eq 'R').Count -or (Test-Path -LiteralPath 'R:\')){throw 'R is already in use; no existing drive is reassigned'}
$image=New-VHD -Path $diskPath -SizeBytes $size -Dynamic
Save-Json $created @{nonce=$c.nonce;path=$diskPath;identifier=[string]$image.DiskIdentifier;size=[long]$image.Size;time=[DateTime]::UtcNow.ToString('o')}
$mounted=Mount-VHD -Path $diskPath -Passthru;$image=Pinned-Image;$number=[int]$image.DiskNumber
if(-not $image.Attached -or $number -lt 1 -or $number -ne [int]$mounted.DiskNumber){throw 'New image attachment is not confirmed'}
$disk=Get-Disk -Number $number
if(-not (File-Backed $disk) -or [long]$disk.Size -ne $size -or [string]$disk.PartitionStyle -ne 'RAW' -or @(Get-Partition -DiskNumber $number -ErrorAction SilentlyContinue).Count){throw 'Only the newly created empty file-backed disk may be initialized'}
Initialize-Disk -Number $number -PartitionStyle GPT
$partition=New-Partition -DiskNumber $number -UseMaximumSize -DriveLetter R
# Revalidate the new image and exact fresh partition immediately before format.
$again=Pinned-Image;$partition=Get-Partition -DiskNumber $number -PartitionNumber $partition.PartitionNumber
if([int]$again.DiskNumber -ne $number -or [int]$partition.DiskNumber -ne $number -or [string]$partition.DriveLetter -ne 'R' -or [long]$partition.Size -gt $size -or -not (File-Backed (Get-Disk -Number $number))){throw 'New test partition identity changed before format'}
$existing=Get-Volume -Partition $partition
if($existing.FileSystemType -and [string]$existing.FileSystemType -ne 'Unknown'){throw 'An existing formatted filesystem is never reformatted'}
$label='MuSpace-'+([string]$c.nonce).Replace('-','').Substring(0,16)
$volume=Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel $label -Confirm:$false -Force
$volume=Get-Volume -DriveLetter R
if($volume.FileSystemLabel -ne $label -or [string]$volume.FileSystemType -ne 'NTFS' -or [long]$volume.Size -gt $size -or [long]$volume.Size -lt 2GB){throw 'New bounded filesystem was not confirmed'}
$testDirectory=Join-Path 'R:\' ('MuCodeSandbox-'+$c.nonce);New-Item -Path $testDirectory -ItemType Directory|Out-Null
$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){$rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}
Set-Acl -LiteralPath $testDirectory -AclObject $acl
[IO.File]::WriteAllText((Join-Path $testDirectory 'test-volume-nonce.txt'),[string]$c.nonce,[Text.UTF8Encoding]::new($false))
Save-Json $receipt @{complete=$true;time=[DateTime]::UtcNow.ToString('o');nonce=$c.nonce;diskPath=$diskPath;diskIdentifier=[string]$image.DiskIdentifier;diskNumber=$number;maximumBytes=$size;driveLetter='R';volumeUniqueId=[string]$volume.UniqueId;volumeSize=[long]$volume.Size;label=$label;testDirectory=$testDirectory;physicalDiskFormatted=$false}
