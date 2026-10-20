import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {HyperVRuntime,fileHash} from '../server/platform/windows/runtime.ts';
import {PROBE_PORT,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {RunOptions} from '../server/process.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';

// End-to-end HTTP/lifecycle acceptance against a new empty Hyper-V guest.
// Every destination accepted by the upstream fixture is local and synthetic.
async function main(){
 const [image,imageSha256]=process.argv.slice(2);if(!image||!imageSha256)throw Error('Usage: windows-service-lab <protected base> <SHA-256>');
 const root=process.env.MU_WINDOWS_DATA_DIR??path.join(process.env.LOCALAPPDATA!,'MuCodeSandbox-WindowsPreview');
 const directory=path.join(root,'service-lab-'+randomUUID());await mkdir(directory,{recursive:true});
 const fixtures=await localFixtures(path.join(directory,'fixtures'),process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
 class LocalLabRuntime extends HyperVRuntime{
  override async start(c:WindowsConfig,options:RunOptions={}){
   await super.start(c,options);
   for(const file of ['/etc/mucodesandbox/lab-ca.crt','/usr/local/share/ca-certificates/mu-local-fixture.crt'])await this.management(c,['sudo','tee',file],{input:fixtures.certificate});
   await this.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
  }
 }
 const runtime=new LocalLabRuntime(root);
 const curl=(c:WindowsConfig,receiver:string,probe=false)=>runtime.management(c,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--connect-timeout','2','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',probe?`socks5h://127.0.0.1:${PROBE_PORT}`:'','--noproxy',probe?'':'*',`https://${receiver}/`],{timeoutMs:10000});
 const files=['scripts/windows-service-lab.ts','scripts/windows/local-fixtures.ts','scripts/windows/hyperv.ps1','native/windows/HyperVChannel.cs','server/store.ts','server/ui-session.ts','server/platform/windows/service.ts','server/platform/windows/service-lock.ts','server/platform/windows/credentials.ts','server/platform/windows/manager.ts','server/platform/windows/runtime.ts','server/platform/windows/session.ts','server/platform/windows/guest.ts','server/platform/windows/monitor.ts'];
 const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));
 const sourceHashes=Object.fromEntries(await hashes()),results:{name:string;passed:boolean}[]=[];
 const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
 let service:Awaited<ReturnType<typeof createWindowsService>>|undefined,c:WindowsConfig|undefined,complete=false,cleanupConfirmed=false;
 try{
  service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:path.join(directory,'app'),runtimeRoot:root,runtime,base:{image:path.resolve(image),imageSha256},probe:config=>async()=>Promise.all(fixtures.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await curl(config,receiver,true)).ip})))});
  assert.equal((await fetch(service.url)).status,403);
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
  const html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text();
  const token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token;
  const headers={Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  async function api(endpoint:string,body?:unknown,method=body===undefined?'GET':'POST'){
   const response=await fetch(service!.url+'/api'+endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const result=await response.json() as any;assert.ok(response.ok,JSON.stringify(result));return result;
  }
  const input={name:'Synthetic Windows API lab',cpus:1,memoryGiB:2,diskGiB:16,identity:{timezone:'UTC',locale:'en-US'},network:{mode:'http',host:'127.0.0.1',port:fixtures.port,strict:true,transparent:true,egressLock:{expectedIp:LAB_EXIT},dns:fixtures.dns}};
  const environment=await api('/environments',input);c=await service.manager.profile(service.manager.store.get(environment.id));pass('Authorized API creates a Windows-only environment');
  async function action(name:'start'|'stop'|'restart'){
   const job=await api(`/environments/${environment.id}/actions/${name}`,{});const deadline=Date.now()+240000;
   while(service!.manager.active.has(environment.id)){assert.ok(Date.now()<deadline,'Lifecycle job timed out');await delay(500);}
   return service!.manager.store.jobs().find(item=>item.id===job.id)!;
  }
  assert.equal((await action('start')).status,'succeeded');assert.equal(service.manager.store.get(environment.id).state,'running');assert.equal((await runtime.state(c)).state,'Running');
  assert.equal((await api(`/environments/${environment.id}/network/protection`)).integrity,'verified');pass('API startup opens a verified real Hyper-V session');
  assert.equal(JSON.parse(await curl(c,fixtures.receivers[0])).ip,LAB_EXIT);assert.equal(JSON.parse(await curl(c,'receiver.mu.test')).ip,LAB_EXIT);pass('Real guest business TCP and DoH reach only the local fixtures');
  assert.equal((await action('stop')).status,'succeeded');assert.equal((await runtime.state(c)).state,'Off');pass('API stop independently confirms hypervisor Off');
  await api('/environments/'+environment.id,{...input,network:{...input.network,egressLock:{expectedIp:'203.0.113.99'}}},'PUT');
  assert.equal((await action('start')).status,'failed');assert.equal(service.manager.store.get(environment.id).state,'error');assert.equal((await runtime.state(c)).state,'Off');pass('An edited unapproved exit fails startup and is confirmed stopped');
  complete=true;
 }finally{
  try{await service?.close();if(c)assert.equal((await runtime.state(c)).state,'Off');cleanupConfirmed=true;}
  finally{await fixtures.close();const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'real-windows-http-service',results,sourceHashes,sourceChangedDuringTest,cleanupConfirmed,aiWebsitesVisited:0,realAccountTests:0,complete:complete&&cleanupConfirmed&&!sourceChangedDuringTest},null,2));if(sourceChangedDuringTest)throw Error('Acceptance sources changed during the experiment');}
 }
 console.log(JSON.stringify({passed:results.length,complete:complete&&cleanupConfirmed}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Windows service lab failed');process.exitCode=1;});
