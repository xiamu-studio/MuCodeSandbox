# Invoked before the old uninstaller or extraction. Inputs are environment data,
# never executable text; unknown metadata is preserved rather than guessed.
$ErrorActionPreference='Stop'
function Version-Parts([string]$value){
 $match=[regex]::Match($value,'^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-preview\.([1-9]\d{0,4}))?$')
 if(-not $match.Success){throw 'Unrecognized Windows release'}
 $parts=@([int]$match.Groups[1].Value,[int]$match.Groups[2].Value,[int]$match.Groups[3].Value);if(@($parts|Where-Object{$_ -gt 65535}).Count){throw 'Windows release is out of bounds'}
 $revision=65535;if($match.Groups[4].Success){$revision=[int]$match.Groups[4].Value;if($revision -gt 65534){throw 'Windows preview release is out of bounds'}};return @($parts)+@($revision)
}
function Compare-Version([string]$left,[string]$right){$a=Version-Parts $left;$b=Version-Parts $right;for($index=0;$index -lt 4;$index++){if($a[$index] -lt $b[$index]){return -1};if($a[$index] -gt $b[$index]){return 1}};return 0}
function Local-Root([string]$value){
 if([string]::IsNullOrWhiteSpace($value)){throw 'Installation directory is missing'};$full=[IO.Path]::GetFullPath($value).TrimEnd('\');if($full -notmatch '^[a-zA-Z]:\\' -or $full.Length -le 3){throw 'A local application directory is required'}
 $cursor=[IO.Path]::GetPathRoot($full);foreach($part in $full.Substring($cursor.Length).Split('\')){$cursor=Join-Path $cursor $part;if(Test-Path -LiteralPath $cursor){if([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint){throw 'Installation reparse point rejected'}}};return $full
}
function Json-File([string]$file){$item=Get-Item -LiteralPath $file;if($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -lt 1 -or $item.Length -gt 65536){throw 'Application release file changed'};return [IO.File]::ReadAllText($file)|ConvertFrom-Json}
try{
 $incoming=[string]$env:MU_WINDOWS_INSTALL_VERSION;$null=Version-Parts $incoming;$selected=Local-Root $env:MU_WINDOWS_INSTALL_ROOT
 $registered=$null;$registeredVersion=[string]$env:MU_WINDOWS_REGISTERED_VERSION
 if([string]::IsNullOrWhiteSpace($env:MU_WINDOWS_REGISTERED_ROOT) -ne [string]::IsNullOrWhiteSpace($registeredVersion)){throw 'Registered installation identity is incomplete'}
 if(-not [string]::IsNullOrWhiteSpace($env:MU_WINDOWS_REGISTERED_ROOT)){$registered=Local-Root $env:MU_WINDOWS_REGISTERED_ROOT;if($registeredVersion){$null=Version-Parts $registeredVersion;if((Compare-Version $incoming $registeredVersion) -lt 0){exit 4}}}
 $roots=@($selected);if($registered -and $registered -ne $selected){$roots+=@($registered)}
 foreach($root in $roots){
  if(-not (Test-Path -LiteralPath $root)){continue};$entries=@(Get-ChildItem -LiteralPath $root -Force);if(-not $entries.Count){continue}
  $null=Local-Root (Join-Path $root resources);$null=Local-Root (Join-Path $root 'resources/app')
  $manifest=Json-File (Join-Path $root 'resources/windows-runtime-manifest.json');$package=Json-File (Join-Path $root 'resources/app/package.json')
  if($manifest.format -ne 1 -or $manifest.channel -ne 'unsigned-windows-preview' -or $package.name -ne 'mucodesandbox-windows-preview' -or -not (Test-Path -LiteralPath (Join-Path $root 'MuCodeSandbox Windows Preview.exe') -PathType Leaf)){throw 'Unrecognized application installation'}
  $installed=[string]$package.version;$null=Version-Parts $installed
  if($manifest.release){$fileVersion=(Version-Parts $installed)-join '.';$runtimeRelease=Json-File (Join-Path $root 'resources/app/dist-server/windows-release.json');if($manifest.release.version -ne $installed -or $manifest.release.fileVersion -ne $fileVersion -or $runtimeRelease.format -ne 1 -or $runtimeRelease.version -ne $installed -or $runtimeRelease.fileVersion -ne $fileVersion){throw 'Release records disagree'}}
  if($registered -eq $root -and $registeredVersion -and $registeredVersion -ne $installed){throw 'Registered release disagrees with installed release'}
  if((Compare-Version $incoming $installed) -lt 0){exit 4}
 }
 exit 0
}catch{[Console]::Error.WriteLine('Unable to verify the Windows Preview release; existing files were preserved');exit 5}
