import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Native offline snapshot recovery from a separately terminated Windows process',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-offline-snapshot-process-')),quote=(v:string)=>"'"+v.replaceAll("'","''")+"'",checks:unknown[]=[];
 const files=['native/windows/OfflineSnapshots.cs','tests/fixtures/windows-offline-snapshots-harness.cs','tests/fixtures/windows-offline-snapshots-process.ps1'],hashes:Record<string,string>={};
 try{
  const frozen=path.join(root,'inputs');await mkdir(frozen);
  for(const file of files){await copyFile(path.resolve(file),path.join(frozen,path.basename(file)));hashes[file]=createHash('sha256').update(await readFile(path.join(frozen,path.basename(file)))).digest('hex');}
  for(const boundary of ['restore-replaced-disk','restore-committed'])await t.test(boundary,async()=>{
   const directory=path.join(root,boundary);await mkdir(directory);
   const command=(mode:string)=>`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.join(frozen,'windows-offline-snapshots-process.ps1'))}))) -Directory ${quote(directory)} -Source ${quote(path.join(frozen,'OfflineSnapshots.cs'))} -Harness ${quote(path.join(frozen,'windows-offline-snapshots-harness.cs'))} -Mode '${mode}' -Boundary '${boundary}'`;
   const launch=(mode:string)=>{const child=spawn(powershellPath(),powershellArgs(command(mode)),{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',data=>output+=String(data));child.stderr.on('data',data=>error+=String(data));const exited=once(child,'exit');return {child,exited,output:()=>output,error:()=>error};};
   const first=launch('prepare');
   try{
    const until=Date.now()+20000;let ready:{pid:number;id:string;snapshotId:string;boundary:string;operation:string}|undefined;
    while(Date.now()<until){assert.equal(first.child.exitCode,null,first.error());assert.equal(first.child.signalCode,null,first.error());try{ready=JSON.parse(await readFile(path.join(directory,'ready.json'),'utf8'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(50);}
    assert.ok(ready,'bound fixture did not reach a live ready boundary');assert.equal(ready.pid,first.child.pid);assert.equal(ready.boundary,boundary);assert.equal(ready.operation,'snapshot-restore-paused');assert.equal(first.child.exitCode,null);assert.equal(first.child.signalCode,null);
    assert.equal(first.child.kill('SIGKILL'),true);const [oldExit,oldSignal]=await first.exited;assert.equal(oldSignal,'SIGKILL');assert.equal(oldExit,null);
    const second=launch('recover');
    const untilRecovery=setTimeout(()=>second.child.kill('SIGKILL'),20000);
    let result:Record<string,unknown>;
    try{const [code,signal]=await second.exited;assert.equal(signal,null,second.error());assert.equal(code,0,second.error());result=JSON.parse(second.output());}finally{clearTimeout(untilRecovery);}
    assert.notEqual(result.pid,ready.pid);assert.equal(result.pid,second.child.pid);assert.equal(result.id,ready.id);assert.equal(result.snapshotId,ready.snapshotId);assert.equal(result.boundary,boundary);assert.equal(result.complete,true);assert.equal(result.phase,boundary==='restore-committed'?'committed':'rolled-back');assert.equal(result.pairedDiskSeedAndConfigurationSelectionVerified,true);assert.equal(result.oldTransactionAndFilesRetained,true);
    for(const key of ['realHyperVExercised','configurationPersistenceExercised','protectedAclExercised','realDiskFullExercised','productSnapshotFeatureEnabled'])assert.equal(result[key],false,key);
    checks.push({...result,oldPid:ready.pid,newPid:second.child.pid,oldProcessExitObserved:true,oldSignal,passed:true});
   }finally{if(first.child.exitCode===null&&first.child.signalCode===null){first.child.kill('SIGKILL');await first.exited;}}
  });
  assert.equal(checks.length,2);
  for(const file of files)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hashes[file]);
  if(process.env.MU_OFFLINE_SNAPSHOT_PROCESS_REPORT)await writeFile(path.resolve(process.env.MU_OFFLINE_SNAPSHOT_PROCESS_REPORT),JSON.stringify({complete:true,time:new Date().toISOString(),scope:'development core on real Windows files; two actual child process terminations and recovery in new processes; config selection only, no actual product config persistence or Hyper-V/ACL/disk-full/product UI acceptance',actualProcessTerminationExercised:true,inputHashes:hashes,checks},null,2));
 }finally{
  const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(resolved),/^mu-offline-snapshot-process-/);await rm(resolved,{recursive:true,force:true});
 }
});
