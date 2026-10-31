import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,link,symlink,unlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';
import {windowsSnapshotOwnerFileNames,type WindowsSnapshotOwnerFile} from '../server/platform/windows/snapshot-owner.ts';
import {replayWindowsSnapshotOwnerFiles} from '../server/platform/windows/snapshot-owner-files.ts';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

const windows={skip:process.platform!=='win32'},hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const version=(n:number):WindowsSnapshotOwnerFile[]=>windowsSnapshotOwnerFileNames.map(name=>({name,bytes:Buffer.from(`synthetic owner ${n}: ${name} 中文\n`)}));
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-files-')),id=randomUUID(),transaction=randomUUID(),old=version(1),desired=version(2);await secureWindowsDirectory(root);const directory=windowsPaths(root,id).directory;
 return {root,id,transaction,old,desired,directory,apply:(files=desired,previous=old,checkOnly=false)=>replayWindowsSnapshotOwnerFiles(root,id,transaction,files,previous,{checkOnly}),close:async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-snapshot-files-/);assert.equal((await lstat(root)).isSymbolicLink(),false);for(const file of [...old,...desired])file.bytes.fill(0);await rm(root,{recursive:true,force:true});}};
}
async function retained(directory:string):Promise<Buffer[]>{const out:Buffer[]=[];for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())out.push(...await retained(file));else if(entry.name.endsWith('.previous'))out.push(await readFile(file));}return out;}

test('Ordinary replay publishes all eight fixed files, retains old bytes and verifies idempotently on real private Windows files',windows,async()=>{
 const f=await fixture();try{
  const first=await f.apply(f.old,[]);assert.equal(first.retainedBackups,0);for(const file of f.old)assert.deepEqual(await readFile(path.join(f.directory,file.name)),file.bytes);
  const second=await f.apply();assert.equal(second.retainedBackups,8);const backups=await retained(path.join(f.root,'snapshot-owner-history'));assert.deepEqual(backups.map(hash).sort(),f.old.map(v=>hash(v.bytes)).sort());
  for(const file of f.desired)assert.deepEqual(await readFile(path.join(f.directory,file.name)),file.bytes);
  assert.equal((await f.apply()).retainedBackups,0);assert.equal((await f.apply(f.desired,f.old,true)).verified,true);assert.equal((await retained(path.join(f.root,'snapshot-owner-history'))).length,8);
 }finally{await f.close();}
});

test('Unknown later contents, hard links and ancestor junctions are retained before any replay target changes',windows,async()=>{
 const f=await fixture();try{
  await f.apply(f.old,[]);const last=path.join(f.directory,'allocation.json'),unknown=Buffer.from('unrecognized synthetic owner file');await writeFile(last,unknown);await assert.rejects(f.apply(),{code:'SNAPSHOT_FILES'});assert.deepEqual(await readFile(path.join(f.directory,'management')),f.old[0].bytes);assert.deepEqual(await readFile(last),unknown);await writeFile(last,f.old[7].bytes);
  const external=path.join(f.root,'external-synthetic');await writeFile(external,f.old[0].bytes);const target=path.join(f.directory,'management');await unlink(target);await link(external,target);await assert.rejects(f.apply(),{code:'SNAPSHOT_FILES'});assert.deepEqual(await readFile(external),f.old[0].bytes);await unlink(target);await writeFile(target,f.old[0].bytes);
  const alias=path.join(f.root,'alias');await symlink(f.root,alias,'junction');try{await assert.rejects(replayWindowsSnapshotOwnerFiles(alias,f.id,f.transaction,f.desired,f.old),{code:'SNAPSHOT_FILES'});}finally{await unlink(alias);}
  for(const file of f.old)assert.deepEqual(await readFile(path.join(f.directory,file.name)),file.bytes);
 }finally{await f.close();}
});

test('A mid-replay interruption leaves paired allowed versions recoverable and retains the original file history',windows,async()=>{
 const f=await fixture();try{
  await f.apply(f.old,[]);
  const files=f.desired.map(file=>({name:file.name,base64:file.bytes.toString('base64'),sha256:hash(file.bytes),allowed:[hash(file.bytes),hash(f.old.find(v=>v.name===file.name)!.bytes)]}));
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows/SnapshotOwnerFiles.cs'))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$hook=[Action[string]]{param($point)if($point -eq 'replayed-management'){throw 'Synthetic interrupted ordinary metadata replay'}};[Console]::Write([MuSnapshotOwnerFiles]::ApplyJson([Console]::In.ReadToEnd(),$hook))`;
  await assert.rejects(run(powershellPath(),powershellArgs(script),{input:JSON.stringify({root:f.root,id:f.id,transactionId:f.transaction,files,checkOnly:false}),timeoutMs:30000}));
  assert.deepEqual(await readFile(path.join(f.directory,'management')),f.desired[0].bytes);assert.deepEqual(await readFile(path.join(f.directory,'allocation.json')),f.old[7].bytes);
  await f.apply(f.old,f.desired);for(const file of f.old)assert.deepEqual(await readFile(path.join(f.directory,file.name)),file.bytes);
  const history=await retained(path.join(f.root,'snapshot-owner-history'));assert.ok(history.some(bytes=>bytes.equals(f.old[0].bytes)));assert.ok(history.some(bytes=>bytes.equals(f.desired[0].bytes)));
 }finally{await f.close();}
});

test('Replay refuses nonprivate file ACLs and check-only never creates an absent environment directory',windows,async()=>{
 const f=await fixture();try{
  await assert.rejects(f.apply(f.desired,f.old,true),{code:'SNAPSHOT_FILES'});await assert.rejects(lstat(f.directory),{code:'ENOENT'});await f.apply(f.old,[]);
  const target=path.join(f.directory,'management');
  await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$p=${quote(target)};$acl=[IO.File]::GetAccessControl($p);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));[IO.File]::SetAccessControl($p,$acl)`),{timeoutMs:10000});
  await assert.rejects(f.apply(),{code:'SNAPSHOT_FILES'});assert.deepEqual(await readFile(target),f.old[0].bytes);assert.deepEqual(await readFile(path.join(f.directory,'allocation.json')),f.old[7].bytes);
 }finally{await f.close();}
});

test('A live helper in another Windows process excludes all replay until its actual exit, then its partial version can roll back',windows,async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,exited:Promise<unknown[]>|undefined;
 try{
  await f.apply(f.old,[]);const readyFile=path.join(f.root,'process-ready.json');
  const files=f.desired.map(file=>({name:file.name,base64:file.bytes.toString('base64'),sha256:hash(file.bytes),allowed:[hash(file.bytes),hash(f.old.find(v=>v.name===file.name)!.bytes)]}));
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Web.Extensions;Add-Type -Path ${quote(path.resolve('native/windows/SnapshotOwnerFiles.cs'))} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');$hook=[Action[string]]{param($point)if($point -eq 'replayed-management'){[IO.File]::WriteAllText(${quote(readyFile)},('{"pid":'+$PID+',"boundary":"replayed-management"}'));[Threading.Thread]::Sleep(60000);throw 'Synthetic helper pause timed out'}};[Console]::Write([MuSnapshotOwnerFiles]::ApplyJson([Console]::In.ReadToEnd(),$hook))`;
  child=spawn(powershellPath(),powershellArgs(script),{windowsHide:true,stdio:['pipe','pipe','pipe']});exited=once(child,'exit');let error='';child.stderr!.on('data',bytes=>error+=String(bytes));child.stdout!.resume();child.stdin!.end(JSON.stringify({root:f.root,id:f.id,transactionId:f.transaction,files,checkOnly:false}));
  let ready:{pid:number;boundary:string}|undefined;const deadline=Date.now()+20000;
  while(Date.now()<deadline){assert.equal(child.exitCode,null,error);assert.equal(child.signalCode,null,error);try{ready=JSON.parse(await readFile(readyFile,'utf8'));break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await delay(50);}
  assert.ok(ready,'Replay helper did not reach the bound interruption');assert.equal(ready.pid,child.pid);assert.equal(ready.boundary,'replayed-management');
  await assert.rejects(f.apply(f.old,f.desired),{code:'SNAPSHOT_FILES'});assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.deepEqual(await readFile(path.join(f.directory,'management')),f.desired[0].bytes);assert.deepEqual(await readFile(path.join(f.directory,'allocation.json')),f.old[7].bytes);
  assert.equal(child.kill('SIGKILL'),true);const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL');
  await f.apply(f.old,f.desired);for(const file of f.old)assert.deepEqual(await readFile(path.join(f.directory,file.name)),file.bytes);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}await f.close();}
});
