function Invoke-ProUpgradePhase($Session,[string]$Phase,$Guard,[string]$ProNonce,[string]$ScriptDirectory){
 $meta=$Guard.ReadCommand('upgrade-inputs.json')|ConvertFrom-Json
 if($meta.format -ne 1 -or $meta.proNonce -ne $ProNonce -or $meta.caseId -notmatch '^[a-f0-9]{32}$' -or $meta.userName -cne ('MuUpg_'+$meta.caseId.Substring(0,8))){throw 'Bound independent upgrade profile required'}
 if($Phase -eq 'upgrade-profile'){
  foreach($name in @('pro-upgrade-profile.ps1','ProUpgradeStation.cs')){$source=Join-Path $ScriptDirectory $name;$Guard.PinInputFile($source);$target='C:\MuLab\approved\upgrade-'+$meta.caseId+'-'+$name;Copy-Item -LiteralPath $source -Destination $target -ToSession $Session}
  $hashes=@{profile=(Get-FileHash (Join-Path $ScriptDirectory 'pro-upgrade-profile.ps1')).Hash.ToLowerInvariant();station=(Get-FileHash (Join-Path $ScriptDirectory 'ProUpgradeStation.cs')).Hash.ToLowerInvariant()}
  return Invoke-Command -Session $Session -ArgumentList $meta,$hashes -ScriptBlock {
   param($meta,$hashes)
   $ErrorActionPreference='Stop';$caseId=$meta.caseId;$directory='C:\MuLab\public\upgrade-'+$caseId;$file='C:\MuLab\approved\upgrade-'+$caseId+'-config.json'
   if(@(Get-VM).Count -or (Get-LocalUser -Name $meta.userName -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $directory) -or (Test-Path -LiteralPath $file)){throw 'Existing account/profile preserved; initialization never resets passwords'}
   $source='C:\MuLab\approved\upgrade-'+$caseId+'-ProUpgradeStation.cs';$script='C:\MuLab\approved\upgrade-'+$caseId+'-profile.ps1';[IO.File]::Copy(('C:\MuLab\approved\upgrade-'+$caseId+'-pro-upgrade-profile.ps1'),$script,$false)
   if((Get-FileHash $source).Hash.ToLowerInvariant() -ne $hashes.station -or (Get-FileHash $script).Hash.ToLowerInvariant() -ne $hashes.profile){throw 'Profile sources changed'}
   $password='MuUpg!'+[guid]::NewGuid().ToString('N')+'a7Z';$user=New-LocalUser -Name $meta.userName -Password (ConvertTo-SecureString $password -AsPlainText -Force) -PasswordNeverExpires -Description ('MuUpgrade '+$caseId);Add-LocalGroupMember -SID 'S-1-5-32-545' -Member ('MU-PRO-LAB\'+$meta.userName)
   $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));foreach($sid in @($user.SID,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};[IO.Directory]::CreateDirectory($directory,$acl)|Out-Null
   $parent='C:\MuLab\public';$parentAcl=Get-Acl -LiteralPath $parent;$oldSddl=$parentAcl.Sddl;$parentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID,([Security.AccessControl.FileSystemRights]::ListDirectory -bor [Security.AccessControl.FileSystemRights]::ReadAttributes),[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $parent -AclObject $parentAcl
   $config=@{caseId=$caseId;proNonce=$meta.proNonce;userName=$meta.userName;userSid=$user.SID.Value;directory=$directory;profileScript=$script;profileScriptSha256=$hashes.profile;fixtureParentAcl=@{directory=$parent;oldSddl=$oldSddl;newSddl=(Get-Acl $parent).Sddl;rights=129;inherits=$false}};[IO.File]::WriteAllText($file,($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText(('C:\MuLab\private\upgrade-'+$caseId+'-credentials.json'),(@{caseId=$caseId;userName=$meta.userName;userSid=$user.SID.Value;password=$password}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
   $exe='C:\MuLab\approved\upgrade-'+$caseId+'-profile-station.exe';Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $exe -OutputType ConsoleApplication
   $child=Start-Process -FilePath $exe -ArgumentList @($caseId,'profile') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory 'profile-station-out.log') -RedirectStandardError (Join-Path $directory 'profile-station-error.log') -PassThru;$null=$child.Handle;if(-not $child.WaitForExit(135000)){throw 'Profile helper remains live; preserve it'}
   if($child.ExitCode -ne 0){throw 'Profile verification failed; inspect retained logs'};$result=[IO.File]::ReadAllText((Join-Path $directory 'profile-result.json'))|ConvertFrom-Json;if(-not $result.complete -or $result.userSid -ne $user.SID.Value){throw 'Independent profile receipt differs'};return $result
  }
 }
 if($Phase -eq 'upgrade-stage'){. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $ScriptDirectory 'pro-upgrade-stage.ps1'))));return Invoke-ProUpgradeStage $Session $meta $Guard}
 if($Phase -eq 'upgrade-audit'){. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $ScriptDirectory 'pro-upgrade-audit.ps1'))));return Invoke-ProUpgradeAudit $Session $meta.caseId}
 if($Phase -eq 'upgrade-repair-fixture'){. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $ScriptDirectory 'pro-upgrade-repair-fixture.ps1'))));return Repair-ProUpgradeFixture $Session $meta.caseId}
 if($Phase -eq 'upgrade-permissions'){
  return Invoke-Command -Session $Session -ArgumentList $meta.caseId -ScriptBlock {
   param($caseId)
   $config=[IO.File]::ReadAllText(('C:\MuLab\approved\upgrade-'+$caseId+'-config.json'))|ConvertFrom-Json;$secret=[IO.File]::ReadAllText(('C:\MuLab\private\upgrade-'+$caseId+'-credentials.json'))|ConvertFrom-Json;$state=[IO.File]::ReadAllText((Join-Path $config.directory 'state.json'))|ConvertFrom-Json
   if($secret.userSid -ne $config.userSid -or $secret.caseId -ne $caseId -or (Get-LocalUser $config.userName).SID.Value -ne $config.userSid){throw 'Independent permission probe binding changed'}
   Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Security.Principal;using Microsoft.Win32.SafeHandles;
public static class MuUpgradePermissions {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool LogonUser(string user,string domain,string password,int type,int provider,out IntPtr token);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 public static int[] Probe(string user,string password,string[] paths){IntPtr token;if(!LogonUser(user,"MU-PRO-LAB",password,2,0,out token))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());try{using(var identity=new WindowsIdentity(token))using(var context=identity.Impersonate()){int[] result=new int[paths.Length];for(int i=0;i<paths.Length;i++)using(var handle=CreateFile(paths[i],0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero))result[i]=handle.IsInvalid?Marshal.GetLastWin32Error():0;return result;}}finally{CloseHandle(token);}}
}
'@
   $paths=@('C:\','C:\MuLab','C:\MuLab\public',$config.directory,(Join-Path $config.directory 'runtime'),(Join-Path $config.directory ('runtime/mu-win-'+$state.environmentId.Replace('-',''))));$codes=[MuUpgradePermissions]::Probe($config.userName,$secret.password,[string[]]$paths);$rows=@();for($i=0;$i -lt $paths.Count;$i++){$acl=Get-Acl -LiteralPath $paths[$i];$rows+=@{path=$paths[$i];pinError=$codes[$i];owner=$acl.Owner;access=@($acl.Access|Select-Object IdentityReference,FileSystemRights,InheritanceFlags,IsInherited)}};return @{complete=$true;readOnly=$true;paths=$rows}
  }
 }
 if($Phase -eq 'upgrade-inspect'){
  return Invoke-Command -Session $Session -ArgumentList $meta.caseId -ScriptBlock {
   param($caseId)
   $config=[IO.File]::ReadAllText(('C:\MuLab\approved\upgrade-'+$caseId+'-config.json'))|ConvertFrom-Json;$logs=@()
   $all=@(Get-CimInstance Win32_Process);$ids=@($all|Where-Object{$_.ExecutablePath -and ($_.ExecutablePath -eq $config.launcher -or ($_.ExecutablePath -eq $config.node -and $_.CommandLine -like ('*'+$caseId+'*')))}|ForEach-Object{[int]$_.ProcessId});do{$added=@($all|Where-Object{[int]$_.ParentProcessId -in $ids -and [int]$_.ProcessId -notin $ids}|ForEach-Object{[int]$_.ProcessId});$ids+=@($added)}while($added.Count)
   foreach($file in @(@(Get-ChildItem -LiteralPath $config.directory -Filter '*.log' -File)+@(Get-ChildItem -LiteralPath 'C:\MuLab\private' -Filter ('upgrade-'+$caseId+'-*-broker-*.log') -File))){$stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{if($stream.Length -gt 8000){$stream.Position=$stream.Length-8000};$reader=[IO.StreamReader]::new($stream);$logs+=@{name=$file.Name;tail=$reader.ReadToEnd()}}finally{$stream.Dispose()}}
   return @{complete=$true;reports=@(Get-ChildItem -LiteralPath $config.directory -Filter '*-result.json' -File|ForEach-Object{[IO.File]::ReadAllText($_.FullName)|ConvertFrom-Json});progress=@(Get-ChildItem -LiteralPath $config.directory -Filter '*-progress.json' -File|ForEach-Object{[IO.File]::ReadAllText($_.FullName)|ConvertFrom-Json});logs=$logs;actors=@($all|Where-Object{[int]$_.ProcessId -in $ids -or ($_.ExecutablePath -and ($_.ExecutablePath.StartsWith($config.directory,[StringComparison]::OrdinalIgnoreCase) -or ($config.tools -and $_.ExecutablePath.StartsWith($config.tools,[StringComparison]::OrdinalIgnoreCase)) -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1\bin\hv-broker-*.exe'))}|Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine);nested=@(Get-VM|ForEach-Object{@{id=[string]$_.Id;state=[string]$_.State}})}
  }
 }
 . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $ScriptDirectory 'pro-upgrade-runner.ps1'))))
 return Invoke-ProUpgradeRun $Session $meta.caseId $Phase.Substring(8)
}
