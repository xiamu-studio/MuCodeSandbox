[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Refusing to overwrite an existing seed image' }
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$entries = @(Get-ChildItem -LiteralPath $sourcePath -Force)
if ($entries.Count -ne 3 -or @($entries | Where-Object { $_.Name -notin @('user-data','meta-data','network-config') -or $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count) { throw 'Seed must contain exactly three regular NoCloud files' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class MuSeedStream {
  public static void Save(object source, string destination) {
    var stream = (IStream)source;
    var size = Marshal.AllocCoTaskMem(4);
    try {
      using (var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        var bytes = new byte[65536];
        while (true) {
          stream.Read(bytes, bytes.Length, size);
          int count = Marshal.ReadInt32(size);
          if (count == 0) break;
          file.Write(bytes, 0, count);
        }
        file.Flush(true);
      }
    } finally { Marshal.FreeCoTaskMem(size); }
  }
}
'@
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 3 # ISO9660 + Joliet preserves NoCloud filenames.
$image.VolumeName = 'CIDATA'
$image.Root.AddTree($sourcePath, $false)
[MuSeedStream]::Save($image.CreateResultImage().ImageStream, [IO.Path]::GetFullPath($Destination))
