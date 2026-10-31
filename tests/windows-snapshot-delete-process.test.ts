import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Snapshot deletion survives an actual bound child-process exit without changing live disks',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-delete-process-')),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'",checks:unknown[]=[],inputHashes:Record<string,string>={};
 const inputs=['native/windows/OfflineSnapshots.cs','tests/fixtures/windows-snapshot-delete-harness.cs','tests/fixtures/windows-snapshot-delete-process.ps1'];
 try{
  const frozen=path.join(root,'inputs');await mkdir(frozen);for(const file of inputs){const target=path.join(frozen,path.basename(file));await copyFile(file,target);inputHashes[file]=createHash('sha256').update(await readFile(target)).digest('hex');}
  for(const boundary of ['delete-intent-published','delete-removed-disk','delete-completed'])await t.test(boundary,async()=>{
   const directory=path.join(root,boundary);await mkdir(directory);
   const launch=(mode:'prepare'|'recover')=>{
    const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(path.join(frozen,path.basename(inputs[2])))}))) -Directory ${quote(directory)} -Source ${quote(path.join(frozen,path.basename(inputs[0])))} -Harness ${quote(path.join(frozen,path.basename(inputs[1])))} -Mode '${mode}' -Boundary '${boundary}'`;
    const child=spawn(powershellPath(),powershellArgs(command),{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',data=>output+=String(data));child.stderr.on('data',data=>error+=String(data));return {child,exited:once(child,'exit'),output:()=>output,error:()=>error};
   };
   const first=launch('prepare');try{
    const until=Date.now()+20000;let ready:{pid:number;id:string;snapshotId:string;boundary:string;operation:string}|undefined;
    while(Date.now()<until){assert.equal(first.child.exitCode,null,first.error());assert.equal(first.child.signalCode,null,first.error());try{ready=JSON.parse(await readFile(path.join(directory,'ready.json'),'utf8'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(40);}
    assert.ok(ready,'Bound fixture did not reach a live ready boundary');assert.equal(ready.pid,first.child.pid);assert.equal(ready.boundary,boundary);assert.equal(ready.operation,'snapshot-delete-paused');
    // A separately compiled controller is rejected while the original owner of
    // operation.lock is still alive. Only then terminate this exact child PID.
    const concurrent=launch('recover'),concurrentDeadline=setTimeout(()=>concurrent.child.kill('SIGKILL'),20000);
    try{const [code,signal]=await concurrent.exited;assert.equal(signal,null,concurrent.error());assert.notEqual(code,0);assert.match(concurrent.error(),/IOException|being used|另一个进程|另一进程|正由/);}finally{clearTimeout(concurrentDeadline);}
    assert.equal(first.child.exitCode,null);assert.equal(first.child.signalCode,null);assert.equal(first.child.kill('SIGKILL'),true);const [oldCode,oldSignal]=await first.exited;assert.equal(oldCode,null);assert.equal(oldSignal,'SIGKILL');
    const next=launch('recover'),deadline=setTimeout(()=>next.child.kill('SIGKILL'),20000);let result:Record<string,unknown>;
    try{const [code,signal]=await next.exited;assert.equal(signal,null,next.error());assert.equal(code,0,next.error());result=JSON.parse(next.output());}finally{clearTimeout(deadline);}
    assert.equal(result.pid,next.child.pid);assert.notEqual(result.pid,ready.pid);assert.equal(result.id,ready.id);assert.equal(result.snapshotId,ready.snapshotId);assert.equal(result.boundary,boundary);assert.equal(result.complete,true);assert.equal(result.alreadyDeleted,boundary==='delete-completed');
    for(const key of ['liveDiskAndSeedUnchanged','exactSnapshotCopyRemoved','durableReceiptRetained'])assert.equal(result[key],true,key);
    for(const key of ['realHyperVExercised','protectedAclExercised','realDiskFullExercised','productSnapshotFeatureEnabled'])assert.equal(result[key],false,key);
    checks.push({...result,oldPid:ready.pid,oldProcessExitObserved:true,concurrentLiveControllerRejected:true,passed:true});
   }finally{if(first.child.exitCode===null&&first.child.signalCode===null){first.child.kill('SIGKILL');await first.exited;}}
  });
  assert.equal(checks.length,3);for(const file of inputs)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),inputHashes[file]);
  if(process.env.MU_SNAPSHOT_DELETE_PROCESS_REPORT)await writeFile(path.resolve(process.env.MU_SNAPSHOT_DELETE_PROCESS_REPORT),JSON.stringify({complete:true,at:new Date().toISOString(),actualProcessTerminationExercised:true,inputHashes,checks,scope:'real temporary Windows files and three actual bound child process terminations; no broker, VM, protected allocation ACL or desktop acceptance'},null,2));
 }finally{
  const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(resolved),/^mu-snapshot-delete-process-/);await rm(resolved,{recursive:true,force:true});
 }
});
