import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {setTimeout as delay} from 'node:timers/promises';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {HyperVRuntime,fileHash} from '../server/platform/windows/runtime.ts';
import {PROBE_PORT,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {RunOptions} from '../server/process.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {startBroker,installedBrokerPath} from '../server/platform/windows/broker.ts';

// End-to-end HTTP/lifecycle acceptance against a new empty Hyper-V guest.
// Every destination accepted by the upstream fixture is local and synthetic.
async function main(){
 const [image,imageSha256]=process.argv.slice(2);if(!image||!imageSha256)throw Error('Usage: windows-service-lab <protected base> <SHA-256>');
 const root=windowsRuntimeDirectory();
 const directory=path.join(root,'service-lab-'+randomUUID());await mkdir(directory,{recursive:true});
 const fixtures=await localFixtures(path.join(directory,'fixtures'),process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
 class LocalLabRuntime extends HyperVRuntime{
  override async start(c:WindowsConfig,options:RunOptions={}){
   await super.start(c,options);
   for(const file of ['/etc/mucodesandbox/lab-ca.crt','/usr/local/share/ca-certificates/mu-local-fixture.crt'])await this.management(c,['sudo','tee',file],{input:fixtures.certificate});
   await this.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
  }
 }
 let broker:Awaited<ReturnType<typeof startBroker>>|undefined;
 try{if(process.argv.includes('--broker'))broker=await startBroker(await installedBrokerPath());}catch(error){await fixtures.close();throw error;}
 const runtime=new LocalLabRuntime(root,undefined,broker);
 const curl=(c:WindowsConfig,receiver:string,probe=false)=>runtime.management(c,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--connect-timeout','2','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',probe?`socks5h://127.0.0.1:${PROBE_PORT}`:'','--noproxy',probe?'':'*',`https://${receiver}/`],{timeoutMs:10000});
 const files=['scripts/windows-service-lab.ts','scripts/windows/local-fixtures.ts','scripts/windows/hyperv.ps1','native/windows/HyperVChannel.cs','server/store.ts','server/ui-session.ts','server/guest-exchange.ts','server/guest-task.ts','server/platform/windows/terminal.ts','server/platform/windows/terminal-process.ts','server/platform/windows/terminal-worker.ts','server/platform/windows/service.ts','server/platform/windows/service-lock.ts','server/platform/windows/credentials.ts','server/platform/windows/manager.ts','server/platform/windows/runtime.ts','server/platform/windows/session.ts','server/platform/windows/guest.ts','server/platform/windows/monitor.ts'];
 if(broker)files.push('native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/ImageCache.cs','native/windows/Resources.cs','native/windows/DiskGrowth.cs','native/windows/BackupRead.cs','native/windows/BackupCursor.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','native/windows/PowerWatch.cs','native/windows/PowerProtection.cs','native/windows/ResourceMetrics.cs','scripts/windows/build-broker.ps1','scripts/windows/install-broker.ps1','server/platform/windows/broker.ts');
 const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));
 const sourceHashes=Object.fromEntries(await hashes()),results:{name:string;passed:boolean}[]=[];
 const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
 let service:Awaited<ReturnType<typeof createWindowsService>>|undefined,c:WindowsConfig|undefined,terminal:WebSocket|undefined,complete=false,cleanupConfirmed=false;
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
  const input={name:'Synthetic Windows API lab',cpus:1,memoryGiB:2,diskGiB:broker?32:16,identity:{timezone:'UTC',locale:'en-US'},network:{mode:'http',host:'127.0.0.1',port:fixtures.port,strict:true,transparent:true,egressLock:{expectedIp:LAB_EXIT},dns:fixtures.dns}};
  const environment=await api('/environments',input);c=await service.manager.profile(service.manager.store.get(environment.id));pass('Authorized API creates a Windows-only environment');
  async function action(name:'start'|'stop'|'restart'){
   const job=await api(`/environments/${environment.id}/actions/${name}`,{});const deadline=Date.now()+240000;
   while(service!.manager.active.has(environment.id)){assert.ok(Date.now()<deadline,'Lifecycle job timed out');await delay(500);}
   return service!.manager.store.jobs().find(item=>item.id===job.id)!;
  }
  assert.equal((await action('start')).status,'succeeded');assert.equal(service.manager.store.get(environment.id).state,'running');assert.equal((await runtime.state(c)).state,'Running');
  assert.equal((await api(`/environments/${environment.id}/network/protection`)).integrity,'verified');pass('API startup opens a verified real Hyper-V session');
  assert.equal(JSON.parse(await curl(c,fixtures.receivers[0])).ip,LAB_EXIT);assert.equal(JSON.parse(await curl(c,'receiver.mu.test')).ip,LAB_EXIT);pass('Real guest business TCP and DoH reach only the local fixtures');
  const ticket=await api(`/environments/${environment.id}/terminal-ticket`,{command:'shell',cols:80,rows:24});
  terminal=new WebSocket(service.url.replace('http:','ws:')+'/terminal?ticket='+ticket.ticket,{headers:{Origin:service.url,Cookie:cookie}});
  let output='';terminal.on('message',bytes=>{const message=JSON.parse(bytes.toString());if(message.type==='data'){
   output+=message.data;
   if(message.data.includes('\x1b[c'))terminal!.send(JSON.stringify({type:'input',data:'\x1b[?1;2c'}));
   if(message.data.includes('\x1b[6n'))terminal!.send(JSON.stringify({type:'input',data:'\x1b[1;1R'}));
  }});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Terminal did not open')),20000);terminal!.once('open',()=>{clearTimeout(timer);resolve();});terminal!.once('error',reject);});
  terminal.send(JSON.stringify({type:'resize',cols:112,rows:37}));await delay(500);
  terminal.send(JSON.stringify({type:'input',data:`stty -echo; printf 'MU_UID=%s\\n' "$(id -u)"; printf 'MU_SIZE='; stty size; printf 'MU_UTF8=中文终端\\n'; sudo -n true >/dev/null 2>&1; printf 'MU_SUDO=%s\\n' "$?"\r`}));
  const terminalDeadline=Date.now()+30000;while(!output.includes('MU_UID=2001')||!output.includes('MU_SIZE=37 112')||!output.includes('MU_UTF8=中文终端')||!output.match(/MU_SUDO=[1-9]/)){assert.ok(Date.now()<terminalDeadline,'Terminal identity, UTF-8 or resize was not confirmed: '+JSON.stringify(output.slice(-3000)));await delay(100);}
  pass('Real ConPTY SSH terminal uses dev without sudo, preserves Chinese and resizes the guest PTY');
  const name='中文验收.bin',payload=Buffer.from('MuCodeSandbox Windows\0中文\n'.repeat(2048));
  const uploaded=await fetch(service.url+`/api/environments/${environment.id}/transfer-files?name=${encodeURIComponent(name)}`,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:payload});assert.equal(uploaded.status,200);assert.equal((await uploaded.json() as any).bytes,payload.length);
  const listing=await api(`/environments/${environment.id}/transfer-files?directory=1&zone=downloads&path=`),file=listing.files.find((item:any)=>item.name===name);assert.ok(file?.revision);
  const download=await fetch(service.url+`/api/environments/${environment.id}/transfer-download`,{method:'POST',headers,body:JSON.stringify({zone:'downloads',name,revision:file.revision})});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),payload);pass('HTTP upload, safe listing and download preserve binary bytes and Chinese filenames');
  await runtime.guest(c,['python3','-c',"import pathlib,os; p=pathlib.Path('/home/dev/Downloads'); (p/'子目录').mkdir(); (p/'子目录'/'nested.txt').write_text('nested'); (p/'mu-link.txt').symlink_to('/etc/passwd'); (p/'changed.txt').write_text('before')"]);
  const nested=await api(`/environments/${environment.id}/transfer-files?directory=1&zone=downloads&path=${encodeURIComponent('子目录')}`);assert.equal(nested.files[0].name,'nested.txt');
  const escaped=await fetch(service.url+`/api/environments/${environment.id}/transfer-download`,{method:'POST',headers,body:JSON.stringify({zone:'downloads',name:'mu-link.txt'})});assert.equal(escaped.status,409);
  const before=await api(`/environments/${environment.id}/transfer-files?directory=1&zone=downloads&path=`),changed=before.files.find((item:any)=>item.name==='changed.txt');
  await runtime.guest(c,['python3','-c',"import pathlib; (pathlib.Path('/home/dev/Downloads')/'changed.txt').write_text('after')"]);
  const stale=await fetch(service.url+`/api/environments/${environment.id}/transfer-download`,{method:'POST',headers,body:JSON.stringify({zone:'downloads',name:'changed.txt',revision:changed.revision})});assert.equal(stale.status,409);assert.equal((await stale.json() as any).code,'TRANSFER_FILE_CHANGED');
  await runtime.guest(c,['python3','-c',"import pathlib,os; p=pathlib.Path('/home/dev/Downloads'); os.link(p/'changed.txt',p/'mu-hardlink.txt')"]);
  const safe=await api(`/environments/${environment.id}/transfer-files?directory=1&zone=downloads&path=`);assert.ok(!safe.files.some((item:any)=>['mu-link.txt','changed.txt','mu-hardlink.txt'].includes(item.name)));pass('Guest directory traversal works while symlinks, hardlinks and changed files are rejected');
  const cancel=new AbortController(),task=runtime.guest(c,['python3','-c',"import pathlib,time;pathlib.Path('/tmp/mu-task-started').touch();time.sleep(30);pathlib.Path('/tmp/mu-task-finished').touch()"],{signal:cancel.signal,timeoutMs:40000}).then(()=>false,()=>true);
  const taskDeadline=Date.now()+10000;for(;;){try{await runtime.management(c,['test','-e','/tmp/mu-task-started']);break;}catch{assert.ok(Date.now()<taskDeadline);await delay(100);}}
  cancel.abort();assert.equal(await task,true);await delay(1000);await assert.rejects(runtime.management(c,['test','-e','/tmp/mu-task-finished']));
  const pending=await runtime.management(c,['pgrep','-f','[t]ime.sleep\\(30\\)']).then(()=>true,()=>false);assert.equal(pending,false);pass('Cancelled guest commands terminate their remote process group');
  const terminalClosed=new Promise<void>(resolve=>terminal!.once('close',()=>resolve()));
  assert.equal((await action('stop')).status,'succeeded');await terminalClosed;assert.equal((await runtime.state(c)).state,'Off');assert.equal(service.terminal?.children.size,0);pass('API stop closes terminal access and independently confirms hypervisor Off');
  await api('/environments/'+environment.id,{...input,network:{...input.network,egressLock:{expectedIp:'203.0.113.99'}}},'PUT');
  assert.equal((await action('start')).status,'failed');assert.equal(service.manager.store.get(environment.id).state,'error');assert.equal((await runtime.state(c)).state,'Off');pass('An edited unapproved exit fails startup and is confirmed stopped');
  complete=true;
 }finally{
  terminal?.terminate();
  try{await service?.close();if(c)assert.equal((await runtime.state(c)).state,'Off');cleanupConfirmed=true;}
  finally{await broker?.call('shutdown').catch(()=>{});await fixtures.close();const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'real-windows-http-service',privilegeSeparated:!!broker,results,sourceHashes,sourceChangedDuringTest,cleanupConfirmed,aiWebsitesVisited:0,realAccountTests:0,complete:complete&&cleanupConfirmed&&!sourceChangedDuringTest},null,2));if(sourceChangedDuringTest)throw Error('Acceptance sources changed during the experiment');}
 }
 console.log(JSON.stringify({passed:results.length,complete:complete&&cleanupConfirmed}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Windows service lab failed');process.exitCode=1;});
