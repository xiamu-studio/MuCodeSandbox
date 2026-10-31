import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {WindowsSnapshots} from '../server/platform/windows/snapshots.ts';

test('Unpublished native copies are observable and refuse additional copying without deleting retained data',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-staging-')),q=(s:string)=>"'"+s.replaceAll("'","''")+"'",inputs=['native/windows/OfflineSnapshots.cs','tests/fixtures/windows-snapshot-staging.cs'],hashes:Record<string,string>={};
 try{
  for(const file of inputs)hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const code=`Add-Type -AssemblyName System.Web.Extensions; Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(path.resolve(inputs[1]))})+[Environment]::NewLine+[IO.File]::ReadAllText(${q(path.resolve(inputs[0]))})) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll'); [Console]::Write([MuSnapshotStagingFixture]::Run(${q(root)}))`;
  const result=JSON.parse(await run(powershellPath(),powershellArgs(code),{timeoutMs:90000}));
  assert.equal(result.complete,true);assert.equal(result.realFileSystem,true);for(const key of ['actualHyperV','protectedAcl','deletedRetainedCopies'])assert.equal(result[key],false);assert.equal(result.checks.length,12);
  for(const check of result.checks)await t.test(check.name,()=>assert.equal(check.passed,true));
  for(const file of inputs)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hashes[file]);
  if(process.env.MU_STAGING_REPORT)await writeFile(path.resolve(process.env.MU_STAGING_REPORT),JSON.stringify({...result,inputHashes:hashes,at:new Date().toISOString()},null,2));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-snapshot-staging-/);await rm(root,{recursive:true,force:true});}
});

test('Staging client accepts only bounded names and operations from the fixed environment request',async()=>{
 const id=randomUUID(),record={name:'create-next-'+randomUUID(),operation:'create'},calls:unknown[]=[];
 const client=(receipt:unknown)=>new WindowsSnapshots({call:async(action,parameters)=>{calls.push({action,parameters});return receipt;}});
 const good={entries:[record],truncated:false};assert.deepEqual(await client(good).staging(id),good);assert.deepEqual(calls,[{action:'snapshot-staging',parameters:{id}}]);
 for(const bad of [
  {...good,path:'F:/other'}, {...good,ownerConfiguration:'private'}, {...good,truncated:true},
  {entries:[record,record],truncated:false}, {entries:[record,{...record,name:record.name.toUpperCase()}],truncated:false},
  {entries:[{...record,operation:'restore'}],truncated:false}, {entries:[{...record,name:'create-next-../outside'}],truncated:false},
  {entries:[{...record,name:'create-next-\n'}],truncated:false}, {entries:Array.from({length:33},()=>({...record,name:'create-next-'+randomUUID()})),truncated:true},
 ])await assert.rejects(client(bad).staging(id));
 const before=calls.length;await assert.rejects(client(good).staging('../other'));assert.equal(calls.length,before);
 const bounded={entries:Array.from({length:32},()=>({...record,name:'create-next-'+randomUUID()})),truncated:true};assert.deepEqual(await client(bounded).staging(id),bounded);
});

test('A separate process sees unpublished copies after the original copier is terminated',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-staging-process-')),q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
 try{for(const operation of ['create','restore'])await t.test(operation,async()=>{
  const {mkdir}=await import('node:fs/promises'),directory=path.join(root,operation);await mkdir(directory);
  const prelude=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Web.Extensions; Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(path.resolve('tests/fixtures/windows-snapshot-staging.cs'))})+[Environment]::NewLine+[IO.File]::ReadAllText(${q(path.resolve('native/windows/OfflineSnapshots.cs'))})) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll'); `;
  const child=spawn(powershellPath(),powershellArgs(prelude+`[MuSnapshotStagingFixture]::Process(${q(directory)},'pause','${operation}')`),{windowsHide:true,stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');let error='';child.stderr.on('data',bytes=>error+=bytes);child.stdout.resume();
  try{
   const until=Date.now()+20000;let ready:{pid:number;operation:string;boundary:string}|undefined;
   while(Date.now()<until){assert.equal(child.exitCode,null,error);assert.equal(child.signalCode,null,error);try{ready=JSON.parse(await readFile(path.join(directory,'ready.json'),'utf8'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(50);}
   assert.ok(ready,'copy did not reach a bounded ready point');assert.equal(ready.pid,child.pid);assert.equal(ready.operation,operation);assert.equal(ready.boundary,'copy-disk');assert.equal(child.kill('SIGKILL'),true);const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL');
   const result=JSON.parse(await run(powershellPath(),powershellArgs(prelude+`[Console]::Write([MuSnapshotStagingFixture]::Process(${q(directory)},'inspect','${operation}'))`),{timeoutMs:20000}));
   assert.notEqual(result.pid,ready.pid);assert.equal(result.complete,true);assert.equal(result.operation,operation);assert.equal(result.retainedEntries,1);assert.equal(result.extraReservations,0);for(const key of ['originalFilesUnchanged','retainedFilesUnchanged'])assert.equal(result[key],true);for(const key of ['actualHyperV','protectedAcl'])assert.equal(result[key],false);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 });}finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-snapshot-staging-process-/);await rm(root,{recursive:true,force:true});}
});
