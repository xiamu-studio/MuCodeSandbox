import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,unlink,rename,link,symlink} from 'node:fs/promises';
import {operateWindowsBackupOutput,type BackupOutputOperation,type BackupOutputIdentity} from '../server/platform/windows/backup-output-native.ts';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const windows={skip:process.platform!=='win32',timeout:30000};
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-output-native-')),temporary=path.join(root,'.mucwin-partial-'+randomUUID()),target=path.join(root,'合成加密备份.mucwin'),bytes=Buffer.from('synthetic ciphertext only');await writeFile(temporary,bytes,{flag:'wx'});
 const identity=async(file:string):Promise<BackupOutputIdentity>=>{const info=await lstat(file,{bigint:true});return{path:file,dev:String(info.dev),ino:String(info.ino),birthtimeNs:String(info.birthtimeNs)};};
 const stat=await lstat(temporary,{bigint:true}),ancestors:BackupOutputIdentity[]=[];for(let cursor=root;;cursor=path.dirname(cursor)){ancestors.push(await identity(cursor));if(path.dirname(cursor)===cursor)break;}
 const receipt:BackupOutputOperation={temporary,target,ancestors,entry:{...await identity(temporary),bytes:String(stat.size),mtimeNs:String(stat.mtimeNs),sha256:createHash('sha256').update(bytes).digest('hex')}};
 return{root,temporary,target,bytes,receipt,close:async()=>{const selected=path.resolve(root);assert.equal(path.dirname(selected),path.resolve(tmpdir()));assert.match(path.basename(selected),/^mu-output-native-/);await rm(selected,{recursive:true,force:true});}};
}
async function hooked(input:BackupOutputOperation,mode:'publish'|'cleanup'|'check-published',hook:string){
 const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows/BackupOutput.cs'))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$hook=[Action[string]]{param($point)${hook}};[Console]::Write([MuBackupOutput]::ApplyJson([Console]::In.ReadToEnd(),${quote(mode)},$hook))`;
 return run(powershellPath(),powershellArgs(script),{input:JSON.stringify(input),timeoutMs:20000});
}
async function readLock(file:string){
 const script=`$ErrorActionPreference='Stop';$handle=[IO.File]::Open(${quote(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$handle.Dispose()}`;
 const child=spawn(powershellPath(),powershellArgs(script),{stdio:['pipe','pipe','pipe'],windowsHide:true});let details='';child.stderr.on('data',b=>details+=b);const ended=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 const guard=setTimeout(()=>child.kill(),20000);guard.unref();child.once('close',()=>clearTimeout(guard));
 await new Promise<void>((resolve,reject)=>{let text='';const ready=setTimeout(()=>reject(Error('Synthetic output lock did not initialize: '+details)),10000);child.stdout.on('data',b=>{text+=b;if(text.includes('LOCKED')){clearTimeout(ready);resolve();}});child.once('error',e=>{clearTimeout(ready);reject(e);});child.once('close',()=>{clearTimeout(ready);reject(Error('Synthetic output lock closed early: '+details));});});
 return async()=>{if(child.exitCode===null&&child.signalCode===null)child.stdin.end('\n');await ended;};
}

test('Native output publishes the original file atomically without a second hard link and cleanup never removes the target',windows,async()=>{
 const f=await fixture();try{
  assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'check-published'),{published:false});await operateWindowsBackupOutput(f.receipt,'publish');const info=await lstat(f.target,{bigint:true});assert.equal(info.ino,BigInt(f.receipt.entry.ino));assert.equal(info.nlink,1n);assert.deepEqual(await readFile(f.target),f.bytes);await assert.rejects(lstat(f.temporary),{code:'ENOENT'});
  assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'check-published'),{published:true});assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'publish'),{published:true});await operateWindowsBackupOutput(f.receipt,'cleanup');assert.deepEqual(await readFile(f.target),f.bytes);
 }finally{await f.close();}
});
test('Native output refuses both an already existing target and a target created at the pinned publication boundary',{...windows,timeout:45000},async()=>{
 for(const race of [false,true]){const f=await fixture();try{
  const sentinel='foreign existing target';if(!race)await writeFile(f.target,sentinel,{flag:'wx'});
  if(race){const result=JSON.parse(await hooked(f.receipt,'publish',`if($point -eq 'verified'){[IO.File]::WriteAllText(${quote(f.target)},${quote(sentinel)})}`));assert.deepEqual(result,{published:false,conflict:true});}
  else await assert.rejects(operateWindowsBackupOutput(f.receipt,'publish'),{code:'BACKUP_EXISTS'});
  assert.equal(await readFile(f.target,'utf8'),sentinel);assert.deepEqual(await readFile(f.temporary),f.bytes);assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'check-published'),{published:false});await operateWindowsBackupOutput(f.receipt,'cleanup');assert.equal(await readFile(f.target,'utf8'),sentinel);
 }finally{await f.close();}}
});
test('A real Windows sharing lock fails before publication and the same original receipt can publish after release',windows,async()=>{
 const f=await fixture();let release:(()=>Promise<void>)|undefined;try{release=await readLock(f.temporary);await assert.rejects(operateWindowsBackupOutput(f.receipt,'publish'),{code:'BACKUP_OUTPUT_PENDING'});await assert.rejects(lstat(f.target),{code:'ENOENT'});assert.deepEqual(await readFile(f.temporary),f.bytes);await release();await operateWindowsBackupOutput(f.receipt,'publish');assert.equal((await lstat(f.target)).nlink,1);}finally{await release?.();await f.close();}
});
test('Native output retains modified, replaced, linked, ADS-bearing and redirected temporary files',{...windows,timeout:60000},async()=>{
 for(const mode of ['modified','replaced','hardlink','ads','ancestor','junction']){const f=await fixture();try{
  if(mode==='modified')await writeFile(f.temporary,'foreign modified ciphertext');
  if(mode==='replaced'){await rename(f.temporary,path.join(f.root,'original'));await writeFile(f.temporary,f.bytes);}
  if(mode==='hardlink')await link(f.temporary,path.join(f.root,'alias'));
  if(mode==='ads')await writeFile(f.temporary+':foreign','retain unknown stream');
  if(mode==='ancestor')f.receipt.ancestors[0].ino=String(BigInt(f.receipt.ancestors[0].ino)+1n);
  if(mode==='junction'){await rename(f.temporary,path.join(f.root,'original'));const outside=path.join(f.root,'outside');await mkdir(outside);await symlink(outside,f.temporary,'junction');}
  await assert.rejects(operateWindowsBackupOutput(f.receipt,'publish'),{code:'BACKUP_OUTPUT_PENDING'});await assert.rejects(operateWindowsBackupOutput(f.receipt,'cleanup'),{code:'BACKUP_OUTPUT_PENDING'});await assert.rejects(lstat(f.target),{code:'ENOENT'});assert.ok(await lstat(f.temporary));if(mode==='ads')assert.equal(await readFile(f.temporary+':foreign','utf8'),'retain unknown stream');
 }finally{await f.close();}}
});
test('Native output pins ancestors and the producer file while preserving unrelated parent ADS',windows,async()=>{
 const f=await fixture();try{
  await writeFile(f.root+':parent-stream','unrelated parent stream retained');
  const hook=`if($point -eq 'verified'){$directoryBlocked=$false;try{[IO.Directory]::Move(${quote(f.root)},${quote(f.root+'-moved')})}catch{$directoryBlocked=$true};if(!$directoryBlocked){throw 'Ancestor was not pinned'};$writeBlocked=$false;try{[IO.File]::WriteAllText(${quote(f.temporary)},'unknown overwrite')}catch{$writeBlocked=$true};if(!$writeBlocked){throw 'File was not pinned'}}`;
  assert.deepEqual(JSON.parse(await hooked(f.receipt,'publish',hook)),{published:true});assert.deepEqual(await readFile(f.target),f.bytes);assert.equal((await lstat(f.target)).nlink,1);assert.equal(await readFile(f.root+':parent-stream','utf8'),'unrelated parent stream retained');
 }finally{await f.close();}
});
test('Native output reconciles a lost reply after rename using original identity and never adopts an unrelated target',windows,async()=>{
 const f=await fixture();let release:(()=>Promise<void>)|undefined;try{
  await assert.rejects(hooked(f.receipt,'publish',"if($point -eq 'published'){throw 'Synthetic reply lost after atomic commit'}"));await assert.rejects(lstat(f.temporary),{code:'ENOENT'});release=await readLock(f.target);assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'check-published'),{published:true});await release();await rename(f.target,path.join(f.root,'actual-published'));await writeFile(f.target,f.bytes);assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'check-published'),{published:false});await operateWindowsBackupOutput(f.receipt,'cleanup');assert.deepEqual(await readFile(f.target),f.bytes);
 }finally{await release?.();await f.close();}
});
test('Native output cancellation before entry preserves the original temporary file and target absence',windows,async()=>{
 const f=await fixture();try{const controller=new AbortController();controller.abort();await assert.rejects(operateWindowsBackupOutput(f.receipt,'publish',controller.signal),{name:'AbortError'});assert.deepEqual(await readFile(f.temporary),f.bytes);await assert.rejects(lstat(f.target),{code:'ENOENT'});await operateWindowsBackupOutput(f.receipt,'cleanup');await assert.rejects(lstat(f.temporary),{code:'ENOENT'});}finally{await f.close();}
});

test('Read-only publication checks never accept linked or ADS-bearing targets, and cleanup leaves those targets intact',{...windows,timeout:45000},async()=>{
 for(const mode of ['target-ads','target-link','different-parent','extra-field']){const f=await fixture();try{
  if(mode.startsWith('target-')){
   await operateWindowsBackupOutput(f.receipt,'publish');if(mode==='target-ads')await writeFile(f.target+':foreign','preserve target stream');else await link(f.target,path.join(f.root,'foreign-alias'));
   assert.deepEqual(await operateWindowsBackupOutput(f.receipt,'check-published'),{published:false});await operateWindowsBackupOutput(f.receipt,'cleanup');assert.deepEqual(await readFile(f.target),f.bytes);if(mode==='target-ads')assert.equal(await readFile(f.target+':foreign','utf8'),'preserve target stream');
  }else{
   if(mode==='different-parent'){await mkdir(path.join(f.root,'other'));f.receipt.target=path.join(f.root,'other','target.mucwin');}
   if(mode==='extra-field')Object.assign(f.receipt.entry,{untrusted:true});
   await assert.rejects(operateWindowsBackupOutput(f.receipt,'publish'),{code:'BACKUP_OUTPUT_PENDING'});await assert.rejects(lstat(f.receipt.target),{code:'ENOENT'});assert.deepEqual(await readFile(f.temporary),f.bytes);
  }
 }finally{await f.close();}}
});

test('Native output rejects DOS device names and their extensions before publication',{...windows,timeout:60000},async()=>{
 const f=await fixture();try{
  for(const reserved of ['CON','PRN','AUX','NUL','CONIN$','CONOUT$','COM1','LPT9','COM¹','LPT²','COM³']){
   const input={...f.receipt,target:path.join(f.root,reserved+'.mucwin')};await assert.rejects(operateWindowsBackupOutput(input,'publish'),{code:'BACKUP_OUTPUT_PENDING'});assert.deepEqual(await readFile(f.temporary),f.bytes);
  }
  await operateWindowsBackupOutput(f.receipt,'publish');assert.deepEqual(await readFile(f.target),f.bytes);
 }finally{await f.close();}
});

test('Native output helper stops when its exact Node controller exits before publication',windows,async()=>{
 const f=await fixture();let driver:ReturnType<typeof spawn>|undefined;
 try{
  const ready=path.join(f.root,'helper-ready.json'),program=path.join(f.root,'driver.mjs'),configuration=path.join(f.root,'driver.json');
  const script=`$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows/BackupOutput.cs'))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$hook=[Action[string]]{param($point)if($point -eq 'verified'){[IO.File]::WriteAllText(${quote(ready)},('{"pid":'+$PID+'}'));[Threading.Thread]::Sleep(60000)}};[Console]::Write([MuBackupOutput]::ApplyOwnedJson([Console]::In.ReadToEnd(),'publish',__OWNER__,([Diagnostics.Process]::GetProcessById(__OWNER__).StartTime.ToUniversalTime().Ticks.ToString()),$hook))`;
  await writeFile(program,`import {readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';const p=JSON.parse(await readFile(process.argv[2],'utf8'));const child=spawn(p.executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(p.script.replaceAll('__OWNER__',String(process.pid)),'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.end(p.input);child.once('close',code=>process.exit(code??1));`);await writeFile(configuration,JSON.stringify({executable:powershellPath(),script,input:JSON.stringify(f.receipt)}));
  driver=spawn(process.execPath,[program,configuration],{stdio:['ignore','pipe','pipe'],windowsHide:true});let details='';driver.stderr!.on('data',b=>details=(details+b).slice(-4096));driver.stdout!.resume();const ended=new Promise<void>((resolve,reject)=>{driver!.once('close',()=>resolve());driver!.once('error',reject);});let helperPid:number|undefined;const until=Date.now()+12000;
  while(Date.now()<until){try{helperPid=JSON.parse(await readFile(ready,'utf8')).pid;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(driver.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(helperPid,'Helper did not reach verified boundary: '+details);
  // Bind a real Windows process handle before ending the controller. A PID
  // liveness probe can report exit before all kernel-owned file handles have
  // finished closing. WaitForExit observes this exact process, not a reused PID.
  let pinnedResolve!:()=>void,pinnedReject!:(error:unknown)=>void,observation='';const pinned=new Promise<void>((resolve,reject)=>{pinnedResolve=resolve;pinnedReject=reject;});
  const exitScript=`$ErrorActionPreference='Stop';$observed=[Diagnostics.Process]::GetProcessById(${helperPid});try{$null=$observed.Handle;[Console]::WriteLine('PINNED');[Console]::Out.Flush();if(-not $observed.WaitForExit(5000)){throw 'Exact output helper did not exit'};[Console]::WriteLine('EXITED')}finally{$observed.Dispose()}`;
  const helperExit=run(powershellPath(),powershellArgs(exitScript),{timeoutMs:10000,onOutput:text=>{observation+=text;if(observation.includes('PINNED'))pinnedResolve();}}).then(output=>{assert.match(output,/EXITED/);},error=>{pinnedReject(error);throw error;});void helperExit.catch(()=>{});await pinned;driver.kill();await ended;await helperExit;
  assert.deepEqual(await readFile(f.temporary),f.bytes);await assert.rejects(lstat(f.target),{code:'ENOENT'});await operateWindowsBackupOutput(f.receipt,'publish');assert.deepEqual(await readFile(f.target),f.bytes);
 }finally{driver?.kill();await f.close();}
});
