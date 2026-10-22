param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ('using System;using System.IO;using System.Diagnostics;'+[IO.File]::ReadAllText($Source))
function Check([bool]$value,[string]$message){if(-not $value){throw $message}}
function Reject([scriptblock]$work,[type]$expected){$rejected=$false;try{& $work}catch{if(-not $expected.IsInstanceOfType($_.Exception.GetBaseException())){throw};$rejected=$true};Check $rejected 'Unsafe backup cursor request was accepted'}
$data=[byte[]]::new(65539);for($i=0;$i -lt $data.Length;$i++){$data[$i]=[byte]($i%251)}
$file=Join-Path $Directory disk.bin;[IO.File]::WriteAllBytes($file,$data)
$stream=[IO.FileStream]::new($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$cursor=[MuBackupReadCursor]::new($stream,[Action]{})
try{
 Reject {[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read).Dispose()} ([IO.IOException])
 Reject {[IO.File]::Delete($file)} ([IO.IOException])
 Reject {$cursor.Read(-1)|Out-Null} ([ArgumentException]);Reject {$cursor.Read(32768)|Out-Null} ([ArgumentException])
 $a=$cursor.Read(0);Check ($a.Length -eq 32768 -and $cursor.Offset -eq 32768) 'First chunk boundary changed'
 Reject {$cursor.Read(0)|Out-Null} ([ArgumentException]);$b=$cursor.Read(32768);$c=$cursor.Read(65536)
 Check ($b.Length -eq 32768 -and $c.Length -eq 3 -and $cursor.Offset -eq $data.Length) 'Final chunk boundary changed'
 $actual=[byte[]]($a+$b+$c);Check ([Convert]::ToBase64String($actual) -ceq [Convert]::ToBase64String($data)) 'Cursor bytes differ'
 Reject {$cursor.Read($data.Length)|Out-Null} ([ArgumentException])
}finally{$cursor.Dispose()}
Check (-not $stream.CanRead -and $cursor.Expired) 'Close did not release source authority';$cursor.Dispose();Reject {$cursor.Read(0)|Out-Null} ([IO.IOException])
$writer=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None);$writer.Dispose();[IO.File]::Delete($file)
$memory=[IO.MemoryStream]::new();$memory.Write($data,0,$data.Length);$memory.Position=0;$cursor=[MuBackupReadCursor]::new($memory,[Action]{})
try{$memory.SetLength($data.Length+1);Reject {$cursor.Read(0)|Out-Null} ([ArgumentException])}finally{$cursor.Dispose()}
$memory=[IO.MemoryStream]::new($data);$script:guardCalls=0;$cursor=[MuBackupReadCursor]::new($memory,[Action]{$script:guardCalls++;if($script:guardCalls -eq 2){throw [OperationCanceledException]::new('Synthetic power revocation')}})
try{Reject {$cursor.Read(0)|Out-Null} ([OperationCanceledException]);Check ($cursor.Offset -eq 0) 'Revoked data advanced the published cursor'}finally{$cursor.Dispose()}
$empty=[IO.MemoryStream]::new();try{Reject {[MuBackupReadCursor]::new($empty,[Action]{})|Out-Null} ([ArgumentException])}finally{$empty.Dispose()}
[Console]::Write('Pinned backup cursor checks passed')
