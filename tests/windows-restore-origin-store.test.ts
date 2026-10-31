import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
test('Native origin store binds initial publication, lifecycle updates and retirement to original snapshots',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-origin-store-')),q=(value:string)=>"'"+path.resolve(value).replaceAll("'","''")+"'";
 try{const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${q('tests/fixtures/windows-restore-origin-store.ps1')}))) -Source ${q('native/windows/RestoreOriginStore.cs')} -Proof ${q('native/windows/RestoreOriginProof.cs')} -Harness ${q('tests/fixtures/windows-restore-origin-store.cs')} -Directory ${q(root)}`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(command),{timeoutMs:25000}));assert.equal(result.complete,true);assert.equal(result.checks.length,57);assert.ok(result.checks.every((item:{passed:boolean})=>item.passed));assert.equal(result.realHyperV,false);assert.equal(result.trustedAclPublication,false);assert.equal(result.realWindowsFilesystem,true);console.log(JSON.stringify({...result,diagnostic:'restore-origin-store',checks:result.checks.length}));
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-origin-store-/);await rm(root,{recursive:true,force:true});}
});
for(const operation of ['publish','accept','update','retire'] as const)for(const phase of ['frame-invalidated','frame-data','frame-committed'] as const)test(`Native origin table survives real process termination: ${operation}/${phase}`,{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-origin-crash-')),q=(value:string)=>"'"+path.resolve(value).replaceAll("'","''")+"'";
 const command=(mode:string,point='')=>`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${q('tests/fixtures/windows-restore-origin-store.ps1')}))) -Source ${q('native/windows/RestoreOriginStore.cs')} -Proof ${q('native/windows/RestoreOriginProof.cs')} -Harness ${q('tests/fixtures/windows-restore-origin-store.cs')} -Directory ${q(root)} -Mode '${mode}' -Phase '${point}'`;
 let child:ReturnType<typeof spawn>|undefined;
 try{
  await run(powershellPath(),powershellArgs(command(operation==='publish'?'setup-empty':operation==='accept'?'setup-pending':'setup')),{timeoutMs:15000});
  child=spawn(powershellPath(),powershellArgs(command(operation,phase)),{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin!.on('error',()=>{});const running=child,ended=new Promise<void>(resolve=>running.once('close',()=>resolve()));
  await new Promise<void>((resolve,reject)=>{let output='',error='';const timer=setTimeout(()=>reject(Error('Checkpoint timeout: '+error)),15000);running.stdout!.on('data',bytes=>{output+=bytes;if(output.includes('ORIGIN_CHECKPOINT:'+phase)){clearTimeout(timer);resolve();}});running.stderr!.on('data',bytes=>error=(error+bytes).slice(-4096));running.once('error',err=>{clearTimeout(timer);reject(err);});running.once('close',()=>{clearTimeout(timer);reject(Error('Worker exited before checkpoint: '+error));});});
  running.kill('SIGKILL');await ended;
  const recovered=JSON.parse(await run(powershellPath(),powershellArgs(command('recover')),{timeoutMs:15000}));assert.equal(recovered.complete,true);
  assert.equal(recovered.present,operation==='publish'?phase==='frame-committed':operation==='retire'?phase!=='frame-committed':true);
  if(recovered.present)assert.equal(recovered.capacity,operation==='update'&&phase==='frame-committed'?64:32);
  if(operation==='accept')assert.equal(recovered.accepted,phase==='frame-committed');
  await run(powershellPath(),powershellArgs(command(operation)),{timeoutMs:15000});const retried=JSON.parse(await run(powershellPath(),powershellArgs(command('recover')),{timeoutMs:15000}));assert.equal(retried.present,operation!=='retire');if(retried.present){assert.equal(retried.capacity,operation==='update'?64:32);assert.equal(retried.accepted,true);}
  console.log(JSON.stringify({diagnostic:'origin-table-real-kill',operation,phase,killedPid:running.pid,recovered:true,sameIntentRetried:true,realHyperV:false,trustedAclPublication:false}));
 }finally{if(child?.exitCode===null&&child.signalCode===null){const stopped=new Promise<void>(resolve=>child!.once('close',()=>resolve()));child.kill('SIGKILL');await stopped;}assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-origin-crash-/);await rm(root,{recursive:true,force:true});}
});
test('Production broker compiles the origin modules and reports its source identity',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-origin-compile-')),q=(value:string)=>"'"+path.resolve(value).replaceAll("'","''")+"'",digest=await brokerSourceDigest(),target=path.join(root,'broker.exe');
 try{const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${q('scripts/windows/build-broker.ps1')}))) -Destination ${q(target)} -ChannelFile 'hv-channel-1111111111111111.exe' -SourceDigest '${digest}' -ScriptDirectory ${q('scripts/windows')}`;
  await run(powershellPath(),powershellArgs(command),{timeoutMs:25000});const bytes=await readFile(target);assert.equal(bytes.subarray(0,2).toString(),'MZ');for(const name of ['MuRestoreOriginProof','MuRestoreOriginStore','RetireAfterAbsence'])assert.ok(bytes.includes(Buffer.from(name)),name);assert.equal(await brokerSourceDigest(),digest);
  console.log(JSON.stringify({diagnostic:'origin-production-broker-compile',sourceDigest:digest,bytes:bytes.length,executed:false}));
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-origin-compile-/);await rm(root,{recursive:true,force:true});}
});
