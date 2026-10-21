import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,open} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {startBroker,installedBrokerPath,brokerSourceDigest,cleanWindowsEnvironment} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {run} from '../server/process.ts';

async function main(){
 const root=windowsRuntimeDirectory(),directory=path.join(root,'broker-security-'+randomUUID());await mkdir(directory,{recursive:true});const executable=await installedBrokerPath(),client=await startBroker(executable),results:{name:string;passed:boolean}[]=[];
 const files=['scripts/windows-broker-security-lab.ts','scripts/windows/broker-foreign-client.ts','scripts/windows/broker-image-fixtures.ps1','native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/ImageCache.cs','native/windows/Resources.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','native/windows/ResourceMetrics.cs','scripts/windows/hyperv.ps1','scripts/windows/install-broker.ps1','server/platform/windows/broker.ts'];const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));const sourceHashes=Object.fromEntries(await hashes());
 const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};let complete=false;
 try{
  const hello=await client.hello();assert.equal(hello.ownerPid,process.pid);assert.equal(hello.sourceDigest,await brokerSourceDigest());pass('The loaded privileged executable matches the tested source recipe and ordinary owner PID');
  await assert.rejects(client.call('doctor',{command:'whoami'}),{code:'INVALID_REQUEST'});await assert.rejects(client.call('doctor',{script:'arbitrary'}),{code:'INVALID_REQUEST'});pass('Command and script text are not accepted as privileged requests');
  await assert.rejects(client.call('start',{id:randomUUID()}),{code:'DENIED'});await assert.rejects(client.call('start',{id:'*'}),{code:'INVALID_REQUEST'});pass('Unknown and wildcard VM identities cannot be controlled');
  const allocation={id:randomUUID(),image:'C:\\invalid.vhdx',imageSha256:'0'.repeat(64),cpus:1,memoryGiB:2,diskGiB:32};
  await assert.rejects(client.call('disk',{...allocation,directory:'C:\\Windows'}),{code:'INVALID_REQUEST'});await assert.rejects(client.call('disk',{...allocation,cpus:0}),{code:'INVALID_REQUEST'});await assert.rejects(client.call('disk',{...allocation,memoryGiB:10000}),{code:'INVALID_REQUEST'});pass('Caller-chosen privileged output paths and out-of-range resources are rejected');
  await assert.rejects(open(executable,'r+'),error=>['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''));pass('The ordinary application cannot rewrite the installed privileged executable');
  const child=fork(path.resolve('scripts/windows/broker-foreign-client.ts'),[client.pipe.split('MuCodeSandbox-Broker-')[1]],{execPath:process.execPath,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  try{const [message]=await once(child,'message');assert.equal((message as {denied?:boolean}).denied,true);pass('Another process under the same user cannot impersonate the bound application');}finally{child.kill('SIGKILL');}
  const fixtures=path.join(directory,'broker-image-fixtures-'+randomUUID()),script=path.resolve('scripts/windows/broker-image-fixtures.ps1');
  const body=`& '${script.replaceAll("'","''")}' -Directory '${fixtures.replaceAll("'","''")}'`,encoded=Buffer.from(body,'utf16le').toString('base64');
  await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '${powershellPath().replaceAll("'","''")}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if($p.ExitCode -ne 0){throw 'Image fixture creation failed'}`),{env:cleanWindowsEnvironment(),timeoutMs:60000});
  const metadata=JSON.parse(await readFile(path.join(fixtures,'metadata.json'),'utf8'));assert.equal(metadata.largeBytes,64*2**30);assert.equal(metadata.childType,'Differencing');assert.equal(metadata.childHasParent,true);
  for(const name of ['oversized','differencing']){const image=path.join(fixtures,name+'.vhdx'),id=randomUUID();try{await assert.rejects(client.call('disk',{id,image,imageSha256:await fileHash(image),cpus:1,memoryGiB:2,diskGiB:32},{timeoutMs:60000}),{code:'BROKER_FAILED'});pass(name==='oversized'?'A valid disk larger than the requested virtual capacity is rejected':'A valid differencing disk cannot make the agent follow its parent disk');}finally{const allocation=await client.call('allocation',{id}) as {registered:boolean};if(allocation.registered)await client.call('delete',{id});}}
  complete=true;
 }finally{await client.call('shutdown').catch(()=>{});const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'privilege-broker-negative-boundaries',sourceHashes,sourceChangedDuringTest,results,complete:complete&&!sourceChangedDuringTest,aiWebsitesVisited:0},null,2));if(sourceChangedDuringTest)throw Error('Security acceptance source changed during test');}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Broker security acceptance failed');process.exitCode=1;});
