# User-mode boot media preparation. No WIM mount driver or host BCD invocation.
$ErrorActionPreference = 'Stop'
function Write-ProBootStartup([string]$Directory, [string]$Nonce, [int]$EfiPartition) {
    if ($Nonce -notmatch '^[a-f0-9]{64}$' -or $EfiPartition -lt 1 -or $EfiPartition -gt 8 -or (Test-Path -LiteralPath $Directory)) { throw 'Fresh fixed WinPE startup inputs required' }
    $scripts = Join-Path $Directory 'MuProBoot'
    New-Item -ItemType Directory -Path $scripts | Out-Null
    $command = @'
@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "TARGET="
set /a MATCHES=0
for %%D in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do (
 if exist %%D:\MuLab\private\deployment.json (
  call :match_marker "%%D:\MuLab\private\deployment.json"
  if !errorlevel!==0 (
   set /a MATCHES+=1
   set "TARGET=%%D:"
  )
 )
)
echo Pro boot marker matches: !MATCHES!
if not "!MATCHES!"=="1" exit /b 80
if "!TARGET!"=="S:" exit /b 81
diskpart /s X:\MuProBoot\efi.txt > "!TARGET!\MuLab\public\boot-diskpart.log" 2>&1
if errorlevel 1 exit /b 82
if not exist S:\ exit /b 83
bcdboot "!TARGET!\Windows" /s S: /f UEFI /c /v > "!TARGET!\MuLab\public\boot-repair.log" 2>&1
if errorlevel 1 exit /b 84
echo {"bootRepair":true,"nonce":"@NONCE@"} > "!TARGET!\MuLab\public\boot-repair.json"
wpeutil shutdown
exit /b
:match_marker
set "MARKER="
if not exist "%~1" exit /b 1
for /f "usebackq delims=" %%L in ("%~1") do set "MARKER=%%L"
if "!MARKER:@NONCE@=!"=="!MARKER!" exit /b 1
exit /b 0
'@
    [IO.File]::WriteAllText((Join-Path $scripts 'finish.cmd'), ($command.Replace('@NONCE@', $Nonce) -replace '\r?\n', [Environment]::NewLine), [Text.Encoding]::ASCII)
    [IO.File]::WriteAllLines((Join-Path $scripts 'efi.txt'), @('select disk 0', ('select partition ' + $EfiPartition), 'assign letter=S', 'exit'), [Text.Encoding]::ASCII)
    [IO.File]::WriteAllLines((Join-Path $Directory 'winpeshl.ini'), @('[LaunchApps]', '%SYSTEMROOT%\System32\wpeinit.exe', '%SYSTEMROOT%\System32\cmd.exe, /k X:\MuProBoot\finish.cmd'), [Text.Encoding]::ASCII)
}
function New-ProBootIso([string]$Tree, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { throw 'Fresh derived Pro ISO required' }
    Add-Type -TypeDefinition @'
using System;using System.IO;using System.Runtime.InteropServices;using System.Runtime.InteropServices.ComTypes;
public static class MuProIsoStream {
 public static void Save(object source,string destination){
  var input=(IStream)source;var count=Marshal.AllocCoTaskMem(4);
  try{using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
   var bytes=new byte[65536];for(;;){input.Read(bytes,bytes.Length,count);int size=Marshal.ReadInt32(count);if(size==0)break;if(size<0||size>bytes.Length||output.Position+size>2L*1024*1024*1024)throw new IOException("Pro boot media exceeds its bounded size");output.Write(bytes,0,size);}output.Flush(true);
  }}finally{Marshal.FreeCoTaskMem(count);}
 }
}
'@
    $bootStream = New-Object -ComObject ADODB.Stream
    try {
        $bootStream.Type = 1; $bootStream.Open()
        $bootStream.LoadFromFile((Join-Path $Tree 'efi/microsoft/boot/efisys_noprompt.bin'))
        $options = New-Object -ComObject IMAPI2FS.BootOptions
        $options.Manufacturer = 'MuCodeSandbox'; $options.PlatformId = 0xEF; $options.Emulation = 0
        $options.AssignBootImage($bootStream.psobject.BaseObject)
        $image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
        $image.FreeMediaBlocks = 0x7fffffff
        $image.ISO9660InterchangeLevel = 2
        $image.FileSystemsToCreate = 7; $image.VolumeName = 'MU_PRO_BOOT'; $image.BootImageOptions = $options
        $image.Root.AddTree($Tree, $false)
        [MuProIsoStream]::Save($image.CreateResultImage().ImageStream, $Destination)
    } finally { $bootStream.Close() }
}
