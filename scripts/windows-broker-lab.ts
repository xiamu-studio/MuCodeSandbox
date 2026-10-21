import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,open} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {HyperVRuntime,fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {startBroker,installedBrokerPath,cleanWindowsEnvironment} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {PROBE_PORT,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {RunOptions} from '../server/process.ts';
import {run} from '../server/process.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';

async function main(){
 if(process.platform!=='win32')throw Error('Windows required');
 const elevated=await run(powershellPath(),powershellArgs("[Console]::Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"),{env:cleanWindowsEnvironment(),timeoutMs:10000});assert.equal(elevated.trim(),'False','The application test must run without elevation');
 const sourceRoot=windowsRuntimeDirectory(),directory=path.join(sourceRoot,'broker-lab-'+randomUUID()),runtimeRoot=path.join(directory,'user-runtime');await mkdir(runtimeRoot,{recursive:true});
 const base=JSON.parse(await readFile(path.join(sourceRoot,'protected-desktop-base.json'),'utf8'));
 const files=['scripts/windows-broker-lab.ts','native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/ImageCache.cs','native/windows/HyperVChannel.cs','native/windows/RuntimeMetadataCleanup.cs','scripts/windows/hyperv.ps1','scripts/windows/build-broker.ps1','scripts/windows/build-channel.ps1','scripts/windows/install-broker.ps1','scripts/windows/clean-runtime-metadata.ps1','server/platform/windows/broker.ts','server/platform/windows/runtime.ts','server/platform/windows/service.ts','server/platform/windows/manager.ts'];const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));const sourceHashes=Object.fromEntries(await hashes());
 const fixture=await localFixtures(path.join(directory,'fixtures'),process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');let broker:Awaited<ReturnType<typeof startBroker>>;
 try{broker=await startBroker(await installedBrokerPath());}catch(error){await fixture.close();throw error;}const hello=await broker.hello();
 class BrokerLabRuntime extends HyperVRuntime{
  override async start(c:WindowsConfig,options:RunOptions={}){await super.start(c,options);await this.management(c,['sudo','tee','/etc/mucodesandbox/lab-ca.crt'],{input:fixture.certificate});await this.management(c,['sudo','tee','/usr/local/share/ca-certificates/mu-local-fixture.crt'],{input:fixture.certificate});await this.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});}
 }
 const runtime=new BrokerLabRuntime(runtimeRoot,undefined,broker),results:{name:string;passed:boolean}[]=[];let service:Awaited<ReturnType<typeof createWindowsService>>|undefined,c:WindowsConfig|undefined,complete=false,cleanupConfirmed=false;
 const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
 const curl=(config:WindowsConfig,receiver:string,probe=false)=>runtime.management(config,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',probe?`socks5h://127.0.0.1:${PROBE_PORT}`:'','--noproxy',probe?'':'*',`https://${receiver}/`],{timeoutMs:10000});
 try{
  service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:path.join(directory,'app'),runtimeRoot,base,runtime,probe:config=>async()=>Promise.all(fixture.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await curl(config,receiver,true)).ip})))});pass('The ordinary application reaches Hyper-V only through its bound privileged agent');
  const e=await service.manager.create({name:'普通用户权限代理验收',cpus:2,memoryGiB:4,diskGiB:32,network:{mode:'http',host:'127.0.0.1',port:fixture.port,strict:true,transparent:true,egressLock:{expectedIp:LAB_EXIT},dns:fixture.dns}});c=await service.manager.profile(service.manager.store.get(e.id));
  const start=await service.manager.action(e.id,'start');await service.manager.wait(start.id);const job=service.manager.store.jobs().find(value=>value.id===start.id)!;assert.equal(job.status,'succeeded',job.message);assert.equal((await runtime.state(c)).state,'Running');pass('A non-elevated controller creates and starts a real isolated VM');
  const protectedDisk=path.join(process.env.ProgramData!,'MuCodeSandbox-HyperVBroker-v1','users',hello.ownerSid,'vms',e.id,'disk.vhdx');await assert.rejects(open(protectedDisk,'r'),error=>['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''));pass('The application cannot open the broker-owned virtual disk');
  const deniedId=randomUUID();try{await assert.rejects(broker.call('disk',{id:deniedId,image:protectedDisk,imageSha256:'0'.repeat(64),cpus:1,memoryGiB:2,diskGiB:32}),{code:'DENIED'});}finally{const allocation=await broker.call('allocation',{id:deniedId}) as {registered:boolean};if(allocation.registered)await broker.call('delete',{id:deniedId});}pass('The agent cannot read a protected source file on behalf of its ordinary caller');
  assert.equal((await service.manager.protection(e.id)).integrity,'verified');assert.equal(JSON.parse(await curl(c,'receiver.mu.test')).ip,LAB_EXIT);pass('Guest DNS, business TCP and the expiring permit work without elevating the application');
  assert.equal((await runtime.guest(c,['id','-u'])).trim(),'2001');pass('Guest developer tasks retain their unprivileged Linux identity');
  const stop=await service.manager.action(e.id,'stop');await service.manager.wait(stop.id);assert.equal((await runtime.state(c)).state,'Off');pass('A normal application stop independently confirms hypervisor Off');complete=true;
 }finally{
  try{await service?.close();if(c){assert.equal((await runtime.state(c)).state,'Off');await runtime.remove(c);assert.deepEqual(await broker.call('allocation',{id:c.id}),{registered:false});}cleanupConfirmed=true;}finally{await broker.call('shutdown').catch(()=>{});await fixture.close();const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'unprivileged-controller-with-privileged-agent',applicationElevated:false,brokerSourceDigest:hello.sourceDigest,sourceHashes,sourceChangedDuringTest,cleanupConfirmed,results,aiWebsitesVisited:0,complete:complete&&cleanupConfirmed&&!sourceChangedDuringTest},null,2));if(sourceChangedDuringTest)throw Error('Broker acceptance source changed during the experiment');}
 }
 console.log(JSON.stringify({passed:results.length,complete:complete&&cleanupConfirmed}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Broker acceptance failed');process.exitCode=1;});
