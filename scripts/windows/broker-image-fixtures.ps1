#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference='Stop'
$full=[IO.Path]::GetFullPath($Directory)
if($full -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFileName($full) -notmatch '^broker-image-fixtures-[a-f0-9-]{36}$' -or [IO.Directory]::Exists($full)){throw 'Expected a fresh local image fixture directory'}
for($parent=[IO.Directory]::GetParent($full);$parent;$parent=$parent.Parent){if(([IO.File]::GetAttributes($parent.FullName) -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixture parent must not be a reparse point'}}
[IO.Directory]::CreateDirectory($full) | Out-Null
# Empty synthetic disks only. No VM, user disk or mounted volume is involved.
New-VHD -Path (Join-Path $full 'oversized.vhdx') -Dynamic -SizeBytes 64GB | Out-Null
New-VHD -Path (Join-Path $full 'parent.vhdx') -Dynamic -SizeBytes 8GB | Out-Null
New-VHD -Path (Join-Path $full 'differencing.vhdx') -Differencing -ParentPath (Join-Path $full 'parent.vhdx') | Out-Null
$large=Get-VHD -Path (Join-Path $full 'oversized.vhdx')
$child=Get-VHD -Path (Join-Path $full 'differencing.vhdx')
if($large.Size -ne 64GB -or $large.VhdType -ne 'Dynamic' -or $child.VhdType -ne 'Differencing' -or -not $child.ParentPath){throw 'Image fixture metadata was not confirmed'}
[IO.File]::WriteAllText((Join-Path $full 'metadata.json'),(@{largeBytes=$large.Size;childType=[string]$child.VhdType;childHasParent=[bool]$child.ParentPath} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
