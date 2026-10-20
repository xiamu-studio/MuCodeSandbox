import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {run,type Runner} from '../../process.ts';
import {Store} from '../../store.ts';
import {powershellPath,powershellArgs} from './runtime.ts';

const entropy=Buffer.from('MuCodeSandbox Windows credentials v1').toString('base64');
export async function protectCurrentUser(bytes:Buffer,operation:'protect'|'unprotect',runner:Runner=run){
 if(process.platform!=='win32')throw Error('Windows DPAPI is required');
 const method=operation==='protect'?'Protect':'Unprotect';
 const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $value=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Convert]::FromBase64String('${entropy}'); $result=[Security.Cryptography.ProtectedData]::${method}($value,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
 const output=await runner(powershellPath(),powershellArgs(script),{input:bytes.toString('base64'),timeoutMs:10000,maxBytes:65536});
 if(!/^[a-zA-Z0-9+/=]+$/.test(output.trim()))throw Error('Invalid DPAPI response');return Buffer.from(output.trim(),'base64');
}
export async function secureWindowsDirectory(directory:string,runner:Runner=run){
 await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw Error('Windows data root cannot be a reparse point');
 const script=`$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($sid)
$inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach($value in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $identity=New-Object Security.Principal.SecurityIdentifier($value)
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl('${directory.replaceAll("'","''")}',$acl)`;
 await runner(powershellPath(),powershellArgs(script),{timeoutMs:10000});
}
export async function openWindowsStore(directory:string,runner:Runner=run){
 await secureWindowsDirectory(directory,runner);const file=path.join(directory,'credentials.dpapi');let key:Buffer;
 try{key=await protectCurrentUser(await readFile(file),'unprotect',runner);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  key=randomBytes(32);const next=file+'.'+randomUUID()+'.next';
  try{await writeFile(next,await protectCurrentUser(key,'protect',runner),{flag:'wx'});await rename(next,file);}finally{await rm(next,{force:true});}
 }
 if(key.length!==32)throw Error('Windows credential key is invalid');
 try{return new Store(directory,key);}finally{key.fill(0);}
}
