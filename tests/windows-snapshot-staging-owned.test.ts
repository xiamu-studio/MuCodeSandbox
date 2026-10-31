import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';
test('Native producer receipts precede retained copy bytes and by-handle publication keeps complete snapshots',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-owned-snapshot-staging-')),q=(s:string)=>"'"+s.replaceAll("'","''")+"'",files=['tests/fixtures/windows-snapshot-staging-owned.cs','native/windows/OfflineSnapshots.cs','native/windows/SnapshotStaging.cs'],hashes:Record<string,string>={};
 try{
  for(const file of files)hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const expression=files.map(file=>`[IO.File]::ReadAllText(${q(path.resolve(file))})`).join('+[Environment]::NewLine+');
  const code=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Web.Extensions; Add-Type -TypeDefinition (${expression}) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');[Console]::Write([MuOwnedStagingFixture]::Initial(${q(root)}))`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(code),{timeoutMs:30000}));assert.equal(result.complete,true);assert.equal(result.producerReceipts,3);for(const key of ['realNtCreate','realHandleRename','deleteOnCloseCancelledAfterReceipt','publishedCreate','publishedRestore','interruptedCopyRetained'])assert.equal(result[key],true);for(const key of ['actualHyperV','protectedAcl'])assert.equal(result[key],false);
  for(const file of files)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hashes[file]);
  if(process.env.MU_OWNED_STAGING_REPORT)await writeFile(path.resolve(process.env.MU_OWNED_STAGING_REPORT),JSON.stringify({...result,inputHashes:hashes},null,2));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-owned-snapshot-staging-/);await rm(root,{recursive:true,force:true});}
});
test('Owned unpublished copies survive exact producer death and resume from original receipts in a new process',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-owned-staging-process-')),q=(s:string)=>"'"+s.replaceAll("'","''")+"'",files=['tests/fixtures/windows-snapshot-staging-owned.cs','native/windows/OfflineSnapshots.cs','native/windows/SnapshotStaging.cs'];
 const expression=files.map(file=>`[IO.File]::ReadAllText(${q(path.resolve(file))})`).join('+[Environment]::NewLine+'),prefix=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Web.Extensions;Add-Type -TypeDefinition (${expression}) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');`;
 try{for(const boundary of ['staging-begin-durable','staging-file-durable-disk','copy-disk','staging-file-durable-metadata','staging-directory-published','staging-delete-registered','staging-deleted-disk.vhdx','staging-directory-removed','staging-delete-done-durable'])await t.test(boundary,async()=>{
  const {mkdir}=await import('node:fs/promises'),directory=path.join(root,boundary);await mkdir(directory);const code=(mode:string)=>prefix+`[Console]::Write([MuOwnedStagingFixture]::Process(${q(directory)},'${mode}','${boundary}'))`;
  const child=spawn(powershellPath(),powershellArgs(code('pause')),{windowsHide:true,stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);child.stdout.resume();
  try{
   let ready:{pid:number;copyId:string;environmentId:string;boundary:string}|undefined;const until=Date.now()+20000;while(Date.now()<until){assert.equal(child.exitCode,null,stderr);assert.equal(child.signalCode,null,stderr);try{ready=JSON.parse(await readFile(path.join(directory,'ready.json'),'utf8'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(50);}
   assert.ok(ready,'producer did not reach requested boundary');assert.equal(ready.pid,child.pid);assert.equal(ready.boundary,boundary);
   const live=JSON.parse(await run(powershellPath(),powershellArgs(code('live')),{timeoutMs:10000}));assert.equal(live.complete,true);assert.equal(live.producerBusy,true);assert.notEqual(live.pid,child.pid);
   assert.equal(child.kill('SIGKILL'),true);const [exit,signal]=await exited;assert.equal(exit,null);assert.equal(signal,'SIGKILL');const result=JSON.parse(await run(powershellPath(),powershellArgs(code('resume')),{timeoutMs:20000}));
   assert.equal(result.complete,true);assert.notEqual(result.pid,ready.pid);assert.equal(result.copyId,ready.copyId);assert.equal(result.environmentId,ready.environmentId);assert.equal(result.boundary,boundary);assert.equal(result.originalFilesUnchanged,true);assert.equal(result.publishedCopyPreserved,boundary==='staging-directory-published');assert.equal(result.cleanupComplete,boundary!=='staging-directory-published');for(const key of ['actualHyperV','protectedAcl'])assert.equal(result[key],false);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 });}finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-owned-staging-process-/);await rm(root,{recursive:true,force:true});}
});
test('Original-identity staging cleanup is confirmed, resumable and refuses changed or undocumented trees',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-owned-snapshot-cleanup-')),q=(s:string)=>"'"+s.replaceAll("'","''")+"'",files=['tests/fixtures/windows-snapshot-staging-owned.cs','native/windows/OfflineSnapshots.cs','native/windows/SnapshotStaging.cs'],hashes:Record<string,string>={};
 try{
  for(const file of files)hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const expression=files.map(file=>`[IO.File]::ReadAllText(${q(path.resolve(file))})`).join('+[Environment]::NewLine+');
  const code=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Web.Extensions; Add-Type -TypeDefinition (${expression}) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll');[Console]::Write([MuOwnedStagingFixture]::Run(${q(root)}))`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(code),{timeoutMs:60000}));assert.equal(result.complete,true);assert.equal(result.checks.length,30);assert.equal(new Set(result.checks.map((check:{name:string})=>check.name)).size,30);for(const key of ['realFileSystem','realNtCreate','realHandleDelete'])assert.equal(result[key],true);for(const key of ['actualHyperV','protectedAcl'])assert.equal(result[key],false);
  for(const check of result.checks)await t.test(check.name,()=>assert.equal(check.passed,true));
  for(const file of files)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hashes[file]);
  if(process.env.MU_OWNED_CLEANUP_REPORT)await writeFile(path.resolve(process.env.MU_OWNED_CLEANUP_REPORT),JSON.stringify({...result,inputHashes:hashes},null,2));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-owned-snapshot-cleanup-/);await rm(root,{recursive:true,force:true});}
});
test('Production staging actions enforce the independent stop fence and original-copy cleanup protocol',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-staging-bridge-')),q=(s:string)=>"'"+s.replaceAll("'","''")+"'",files=['native/windows/OfflineSnapshots.cs','native/windows/SnapshotStaging.cs','native/windows/SnapshotOperations.cs','tests/fixtures/windows-snapshot-staging-bridge.cs','tests/fixtures/windows-snapshot-staging-bridge.ps1'],hashes:Record<string,string>={};
 try{
  for(const file of files)hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const code=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${q(path.resolve(files[4]))}))) -Directory ${q(root)} -Native ${q(path.resolve('native/windows'))} -Harness ${q(path.resolve(files[3]))}`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(code),{timeoutMs:60000}));assert.equal(result.complete,true);for(const key of ['actualProductionAction','actualProducerAndCleanup','actualKernelFileOperations'])assert.equal(result[key],true);for(const key of ['actualHyperV','protectedAcl'])assert.equal(result[key],false);assert.equal(result.checks.length,13);assert.equal(new Set(result.checks.map((check:{name:string})=>check.name)).size,13);for(const check of result.checks)await t.test(check.name,()=>assert.equal(check.passed,true));
  for(const file of files)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hashes[file]);
  if(process.env.MU_STAGING_BRIDGE_REPORT)await writeFile(path.resolve(process.env.MU_STAGING_BRIDGE_REPORT),JSON.stringify({...result,inputHashes:hashes},null,2));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-staging-bridge-/);await rm(root,{recursive:true,force:true});}
});
