import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,lstat,readdir,rm,unlink} from 'node:fs/promises';
import {removeWindowsBackupWork,type BackupCleanupRemoval,type BackupCleanupIdentity,type BackupCleanupEntry} from '../server/platform/windows/backup-cleanup-native.ts';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-cleanup-native-')),directory=path.join(root,'backup-work-'+randomUUID());await mkdir(directory);
 const identity=async(file:string,relative:string):Promise<BackupCleanupIdentity>=>{const info=await lstat(file,{bigint:true});return {path:relative,dev:String(info.dev),ino:String(info.ino),birthtimeNs:String(info.birthtimeNs)};};
 const capture=async()=>{
  const ancestors:BackupCleanupIdentity[]=[];for(let current=root;;){ancestors.push(await identity(current,current));const parent=path.dirname(current);if(parent===current)break;current=parent;}
  const entries:BackupCleanupEntry[]=[];async function visit(file:string,relative:string){const info=await lstat(file,{bigint:true}),id=await identity(file,relative);if(info.isDirectory()){entries.push({...id,kind:'directory'});for(const name of await readdir(file))await visit(path.join(file,name),relative?relative+'/'+name:name);}else entries.push({...id,kind:'file',bytes:String(info.size),mtimeNs:String(info.mtimeNs),sha256:createHash('sha256').update(await readFile(file)).digest('hex')});}await visit(directory,'');
  return {root,directory,ancestors,entries} satisfies BackupCleanupRemoval;
 };
 return {root,directory,capture,close:async()=>{const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-cleanup-native-/);await rm(target,{recursive:true,force:true});}};
}
async function hooked(input:BackupCleanupRemoval,hook:string){
 const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows/BackupCleanup.cs'))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$hook=[Action[string]]{param($point)${hook}};[Console]::Write([MuBackupCleanup]::ApplyJson([Console]::In.ReadToEnd(),$hook))`;
 return run(powershellPath(),powershellArgs(script),{input:JSON.stringify(input),timeoutMs:20000});
}

test('Ordinary backup ancestor handles prevent a folder rename before any descendant is opened',{skip:process.platform!=='win32',timeout:30000},async()=>{
 for(const [source,type]of [['BackupCleanup.cs','MuBackupCleanup'],['BackupOutput.cs','MuBackupOutput']]){const f=await fixture();try{
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows',source))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$p=[Console]::In.ReadToEnd();$method=[${type}].GetMethod('Pin',[Reflection.BindingFlags]'NonPublic,Static');$handle=$method.Invoke($null,@($p,$true,$false));$moved=$false;try{try{[IO.Directory]::Move($p,$p+'-probe');$moved=$true}finally{if($moved){[IO.Directory]::Move($p+'-probe',$p)}}}catch [IO.IOException]{}finally{$handle.Dispose()};[Console]::Write($moved.ToString())`;
  const moved=(await run(powershellPath(),powershellArgs(script),{input:f.root,timeoutMs:10000})).trim();assert.equal(moved,'False',source+' must deny namespace replacement while its ancestor handle is held');
 }finally{await f.close();}}
});
test('Native backup cleanup deletes only the original sealed entries and can continue after known entries are already absent',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{await writeFile(path.join(f.directory,'disk.vhdx'),'synthetic disk');await writeFile(path.join(f.directory,'management-check'),'synthetic key');const receipt=await f.capture();await unlink(path.join(f.directory,'management-check'));await removeWindowsBackupWork(receipt);await assert.rejects(lstat(f.directory),{code:'ENOENT'});await removeWindowsBackupWork(receipt);}finally{await f.close();}
});
test('Native backup cleanup rejects unknown additions, producer byte changes and replaced original identities before removing any file',{skip:process.platform!=='win32',timeout:60000},async()=>{
 for(const mode of ['unknown','content','identity','ancestor'] as const){const f=await fixture();try{
  const disk=path.join(f.directory,'disk.vhdx');await writeFile(disk,'original synthetic disk');const receipt=await f.capture();
  if(mode==='unknown')await writeFile(path.join(f.directory,'unrelated.txt'),'keep unrelated');
  if(mode==='content')await writeFile(disk,'changed synthetic disk');
  if(mode==='identity'){await unlink(disk);await writeFile(disk,'original synthetic disk');}
  if(mode==='ancestor')receipt.ancestors[0].ino=String(BigInt(receipt.ancestors[0].ino)+1n);
  await assert.rejects(removeWindowsBackupWork(receipt),{code:'BACKUP_CLEANUP_PENDING'});assert.ok((await lstat(disk)).isFile());if(mode==='unknown')assert.equal(await readFile(path.join(f.directory,'unrelated.txt'),'utf8'),'keep unrelated');
 }finally{await f.close();}}
});
test('Native backup cleanup pins checked directories and files, preserves additions made after verification and resumes its original receipt',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const f=await fixture();try{
  const disk=path.join(f.directory,'disk.vhdx');await writeFile(disk,'private synthetic disk');const receipt=await f.capture(),unknown=path.join(f.directory,'preserve.txt');
  const hook=`if($point -eq 'verified'){$renameBlocked=$false;try{[IO.Directory]::Move(${quote(f.directory)},${quote(f.directory+'-replacement')})}catch{$renameBlocked=$true};if(!$renameBlocked){throw 'Directory was not pinned'};$writeBlocked=$false;try{[IO.File]::WriteAllText(${quote(disk)},'external replacement')}catch{$writeBlocked=$true};if(!$writeBlocked){throw 'File was not pinned'};[IO.File]::WriteAllText(${quote(unknown)},'foreign addition stays')}`;
  await assert.rejects(hooked(receipt,hook));assert.equal(await readFile(unknown,'utf8'),'foreign addition stays');await assert.rejects(lstat(disk),{code:'ENOENT'});assert.ok((await lstat(f.directory)).isDirectory());
  await assert.rejects(removeWindowsBackupWork(receipt),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(unknown,'utf8'),'foreign addition stays');await unlink(unknown);await removeWindowsBackupWork(receipt);await assert.rejects(lstat(f.directory),{code:'ENOENT'});
 }finally{await f.close();}
});
test('Native backup cleanup can retry a receipt after the deleting helper is interrupted between leaf removals',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.directory,'disk.vhdx'),'first synthetic leaf');await writeFile(path.join(f.directory,'management-check'),'second synthetic leaf');const receipt=await f.capture();
  await assert.rejects(hooked(receipt,"if($point -eq 'deleted-disk.vhdx'){throw 'Synthetic helper interruption after one leaf'}"));await assert.rejects(lstat(path.join(f.directory,'disk.vhdx')),{code:'ENOENT'});assert.equal(await readFile(path.join(f.directory,'management-check'),'utf8'),'second synthetic leaf');await removeWindowsBackupWork(receipt);await assert.rejects(lstat(f.directory),{code:'ENOENT'});
 }finally{await f.close();}
});

test('Native backup cleanup preserves unknown NTFS named data streams on an original file or directory',{skip:process.platform!=='win32',timeout:30000},async()=>{
 for(const kind of ['file','directory']){const f=await fixture();try{
  const disk=path.join(f.directory,'disk.vhdx');await writeFile(disk,'synthetic default stream');const extra=(kind==='file'?disk:f.directory)+':foreign';await writeFile(extra,'synthetic unrelated named stream');const receipt=await f.capture();
  await assert.rejects(removeWindowsBackupWork(receipt),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(extra,'utf8'),'synthetic unrelated named stream');assert.equal(await readFile(disk,'utf8'),'synthetic default stream');await unlink(extra);await removeWindowsBackupWork(receipt);await assert.rejects(lstat(f.directory),{code:'ENOENT'});
 }finally{await f.close();}}
});

test('An ordinary cleanup helper stops when its actual Node controller dies before deletion and a new controller can retry',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture();let driver:ReturnType<typeof spawn>|undefined;
 try{
  const disk=path.join(f.directory,'disk.vhdx'),ready=path.join(f.root,'helper-ready.json');await writeFile(disk,'synthetic controller-death disk');const receipt=await f.capture(),program=path.join(f.root,'driver.mjs'),configuration=path.join(f.root,'driver.json');
  const script=`$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows/BackupCleanup.cs'))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$hook=[Action[string]]{param($point)if($point -eq 'verified'){[IO.File]::WriteAllText(${quote(ready)},('{"pid":'+$PID+'}'));[Threading.Thread]::Sleep(60000)}};[Console]::Write([MuBackupCleanup]::ApplyOwnedJson([Console]::In.ReadToEnd(),__OWNER__,([Diagnostics.Process]::GetProcessById(__OWNER__).StartTime.ToUniversalTime().Ticks.ToString()),$hook))`;
  await writeFile(program,`import {readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';const p=JSON.parse(await readFile(process.argv[2],'utf8'));const c=p.script.replaceAll('__OWNER__',String(process.pid));const child=spawn(p.executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(c,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.end(p.input);child.once('close',code=>process.exit(code??1));`);
  await writeFile(configuration,JSON.stringify({executable:powershellPath(),script,input:JSON.stringify(receipt)}));
  driver=spawn(process.execPath,[program,configuration],{stdio:['ignore','pipe','pipe'],windowsHide:true});let details='';driver.stderr!.on('data',data=>{details=(details+data).slice(-4096);});driver.stdout!.resume();const ended=new Promise<void>((resolve,reject)=>{driver!.once('close',()=>resolve());driver!.once('error',reject);});
  const deadline=Date.now()+12000;let helperPid:number|undefined;while(Date.now()<deadline){try{helperPid=JSON.parse(await readFile(ready,'utf8')).pid;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(driver.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(helperPid,'Synthetic helper must reach its pinned pre-delete boundary: '+details);
  driver.kill();await ended;
  const check=()=>{try{process.kill(helperPid!,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
  const stoppedBy=Date.now()+5000;while(check()&&Date.now()<stoppedBy)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(check(),false,'The pinned original controller handle must stop the orphan helper');assert.equal(await readFile(disk,'utf8'),'synthetic controller-death disk');await removeWindowsBackupWork(receipt);await assert.rejects(lstat(f.directory),{code:'ENOENT'});
 }finally{driver?.kill();await f.close();}
});
