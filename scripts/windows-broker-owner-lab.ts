import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile,stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
import {windowsConfigSchema} from '../server/platform/windows/config.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {run} from '../server/process.ts';
import {cleanWindowsEnvironment,startBroker,installedBrokerPath} from '../server/platform/windows/broker.ts';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';

async function main(){
 const root=windowsRuntimeDirectory(),jobs=await Promise.all((await readdir(root)).filter(name=>name.startsWith('broker-lab-')).map(async name=>({name,time:(await stat(path.join(root,name))).mtimeMs})));jobs.sort((a,b)=>b.time-a.time);let prior:string|undefined;
 for(const job of jobs){const candidate=path.join(root,job.name);try{const evidence=JSON.parse(await readFile(path.join(candidate,'results.json'),'utf8'));if(evidence.complete&&evidence.cleanupConfirmed){prior=candidate;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 if(!prior)throw Error('A successful ordinary-user VM lab is required first');
 const db=new DatabaseSync(path.join(prior,'app/state.sqlite'),{readOnly:true}),e=JSON.parse(db.prepare('select config from environments limit 1').get()!.config as string);db.close();const base=JSON.parse(await readFile(path.join(root,'protected-desktop-base.json'),'utf8'));
 const c=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,timezone:e.identity.timezone,proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:e.network.egressLock.expectedIp});
 const directory=path.join(root,'broker-owner-'+randomUUID()),runtimeRoot=path.join(directory,'user-runtime');await mkdir(runtimeRoot,{recursive:true});const file=path.join(directory,'config.json');await writeFile(file,JSON.stringify(c));
 const files=['scripts/windows-broker-owner-lab.ts','scripts/windows/broker-owner-controller.ts','scripts/windows/broker-watchdog-inspect.ps1','native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/ImageCache.cs','native/windows/Resources.cs','native/windows/DiskGrowth.cs','native/windows/BackupRead.cs','native/windows/BackupRestore.cs','native/windows/BackupCursor.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','native/windows/PowerWatch.cs','native/windows/PowerProtection.cs','native/windows/ResourceMetrics.cs','scripts/windows/hyperv.ps1','server/platform/windows/broker.ts','server/platform/windows/runtime.ts'];const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));const sourceHashes=Object.fromEntries(await hashes());
 const owner=fork(path.resolve('scripts/windows/broker-owner-controller.ts'),[runtimeRoot,file,path.join(directory,'fixtures')],{execPath:process.execPath,execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let diagnostic='';owner.stdout!.resume();owner.stderr!.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-8192);});let complete=false,cleanupConfirmed=false;
 try{
  const ready=await new Promise<{active:boolean;platformId:string}>((resolve,reject)=>{
   const finish=(error:Error|undefined,value?:{active:boolean;platformId:string})=>{clearTimeout(timer);owner.off('message',message);owner.off('error',failed);owner.off('exit',exited);error?reject(error):resolve(value!);};
   const message=(value:any)=>{if(value.error)finish(Error(value.error));else if(value.active)finish(undefined,value);},failed=(error:Error)=>finish(error),exited=(code:number|null)=>finish(Error(`Owner controller exited before activation (${code}): ${diagnostic.trim()}`));
   const timer=setTimeout(()=>finish(Error('Owner controller did not activate')),240000);owner.on('message',message);owner.once('error',failed);owner.once('exit',exited);
  });assert.equal(ready.active,true);console.log('PASS Normal owner activates the registered VM');
  const exited=once(owner,'exit');owner.kill('SIGKILL');await exited;
  const report=path.join(directory,'watchdog-'+randomUUID()+'.json'),script=path.resolve('scripts/windows/broker-watchdog-inspect.ps1');
  const command=`$ErrorActionPreference='Stop'; $body="& '${script.replaceAll("'","''")}' -VMId '${ready.platformId}' -EnvironmentId '${c.id}' -Report '${report.replaceAll("'","''")}'"; $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body)); $p=Start-Process -FilePath '${powershellPath().replaceAll("'","''")}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if($p.ExitCode -ne 0){throw 'Independent VM shutdown inspection failed'}`;
  await run(powershellPath(),powershellArgs(command),{env:cleanWindowsEnvironment(),timeoutMs:60000});const result=JSON.parse(await readFile(report,'utf8'));assert.equal(result.offConfirmed,true);console.log('PASS Independent Hyper-V inspection confirms Off after ordinary owner death');complete=true;
 }finally{owner.kill('SIGKILL');try{const cleanup=await startBroker(await installedBrokerPath());try{const runtime=new HyperVRuntime(runtimeRoot,undefined,cleanup);if((await runtime.allocation(c)).registered){await runtime.stop(c);await runtime.remove(c);}cleanupConfirmed=true;}finally{await cleanup.call('shutdown').catch(()=>{});}}finally{const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'broker-owner-death',sourceHashes,sourceChangedDuringTest,cleanupConfirmed,complete:complete&&cleanupConfirmed&&!sourceChangedDuringTest,aiWebsitesVisited:0},null,2));if(sourceChangedDuringTest)throw Error('Owner-death acceptance source changed during test');}}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Owner-death acceptance failed');process.exitCode=1;});
