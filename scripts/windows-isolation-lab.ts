import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork,type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {HyperVRuntime,fileHash} from '../server/platform/windows/runtime.ts';
import {windowsConfigSchema,PROBE_PORT,windowsPaths,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';

async function main(){
 const [image,imageSha256]=process.argv.slice(2);if(!image||!imageSha256)throw Error('Usage: windows-isolation-lab <protected base> <SHA-256>');
 const root=process.env.MU_WINDOWS_DATA_DIR??path.join(process.env.LOCALAPPDATA!,'MuCodeSandbox-WindowsPreview');
 const directory=path.join(root,`isolation-${randomUUID()}`);await mkdir(directory,{recursive:true});
 const runtime=new HyperVRuntime(root),openssl=process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
 const aFixture=await localFixtures(path.join(directory,'a'),openssl),bFixture=await localFixtures(path.join(directory,'b'),openssl,'203.0.113.20');
 const configs=[aFixture,bFixture].map((f,index)=>windowsConfigSchema.parse({version:1,id:randomUUID(),image:path.resolve(image),imageSha256,proxy:{mode:'http',address:'127.0.0.1',port:f.port},dns:f.dns,expectedIp:index===0?LAB_EXIT:'203.0.113.20'}));
 const results:{name:string;passed:boolean}[]=[],created:WindowsConfig[]=[];let child:ChildProcess|undefined;
 const sessions=new Map<string,WindowsNetworkSession>(),timers=new Map<string,ReturnType<typeof setInterval>>(),pending=new Map<string,Promise<void>>(),backgroundErrors:string[]=[];let succeeded=false,cleanupConfirmed=false,sourceStable=true;
 const codeFiles=['scripts/windows-isolation-lab.ts','scripts/windows/controller-fixture.ts','scripts/windows/local-fixtures.ts','scripts/windows/hyperv.ps1','native/windows/HyperVChannel.cs','server/platform/windows/runtime.ts','server/platform/windows/guest.ts','server/platform/windows/session.ts','server/platform/windows/channel.ts'];
 const sourceHashes=Object.fromEntries(await Promise.all(codeFiles.map(async file=>[file,await fileHash(file)])));
 const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
 const curl=(c:WindowsConfig,host='203.0.113.10',probe=false)=>runtime.management(c,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','3','--connect-timeout','2','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',probe?`socks5h://127.0.0.1:${PROBE_PORT}`:'','--noproxy',probe?'':'*',`https://${host}/`],{timeoutMs:10000});
 const prepare=async(c:WindowsConfig,f:typeof aFixture)=>{
  await runtime.create(c);created.push(c);await runtime.start(c);
  for(const file of ['/etc/mucodesandbox/lab-ca.crt','/usr/local/share/ca-certificates/mu-local-fixture.crt'])await runtime.management(c,['sudo','tee',file],{input:f.certificate});
  await runtime.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
 };
 const activate=async(c:WindowsConfig,f:typeof aFixture)=>{
  await runtime.start(c);const session=await runtime.session(c,async()=>Promise.all(f.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await curl(c,receiver,true)).ip}))));await runtime.connect(c);await session.open();sessions.set(c.id,session);
  timers.set(c.id,setInterval(()=>{const task=session.tick().catch(e=>{backgroundErrors.push(String(e));});pending.set(c.id,task);},8000));
 };
 try{
  const a=configs[0],b=configs[1];await prepare(a,aFixture);await runtime.stop(a);
  const file=path.join(directory,'controller-config.json');await writeFile(file,JSON.stringify(a));
  child=fork(fileURLToPath(new URL('./windows/controller-fixture.ts',import.meta.url)),[root,file],{execPath:process.execPath,stdio:['ignore','pipe','pipe','ipc']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Controller fixture did not activate')),240000);child!.on('message',(message:any)=>{if(message.error){clearTimeout(timer);reject(Error(message.error));}if(message.active){clearTimeout(timer);resolve();}});child!.once('error',reject);child!.once('exit',code=>{clearTimeout(timer);if(code)reject(Error('Controller exited before activation'));});});
  assert.equal(JSON.parse(await curl(a)).ip,LAB_EXIT);pass('Independent controller activates the real protected VM');
  child.kill('SIGKILL');await new Promise<void>(resolve=>{if(child!.exitCode!==null||child!.signalCode!==null)resolve();else child!.once('exit',()=>resolve());});
  const deadline=Date.now()+10000;for(;;){const listeners=await runtime.management(a,['sudo','ss','-H','-lnt','sport = :17401']);if(!listeners.trim())break;assert.ok(Date.now()<deadline,'Guest egress listener survived controller death');await delay(200);}
  assert.equal((await runtime.inspectGuard(a)).leaseActive,true);await assert.rejects(curl(a));pass('Controller death removes host egress before the guest permit expires');
  await delay(46000);assert.equal((await runtime.inspectGuard(a)).leaseActive,false);pass('Dead controller cannot renew the kernel business permit');await runtime.stop(a);
  await activate(a,aFixture);await prepare(b,bFixture);await runtime.stop(b);await activate(b,bFixture);
  assert.equal(JSON.parse(await curl(a)).ip,LAB_EXIT);assert.equal(JSON.parse(await curl(b)).ip,'203.0.113.20');pass('One runtime maintains two independent proxy and permit sessions');
  await runtime.management(a,['sudo','-n','-H','-u','dev','--','sh','-c','printf isolated-a > /workspace/isolation-marker']);
  await assert.rejects(runtime.management(b,['test','-e','/workspace/isolation-marker']));pass('A file written in one guest is absent from the other guest');
  const aKey=await readFile(windowsPaths(root,a.id).hostKey+'.pub','utf8'),bKey=await readFile(windowsPaths(root,b.id).hostKey+'.pub','utf8');assert.notEqual(aKey,bKey);assert.notEqual((await runtime.state(a)).platformId,(await runtime.state(b)).platformId);pass('Guest identities and Hyper-V VM identities are independent');
  clearInterval(timers.get(a.id));await pending.get(a.id);aFixture.interrupt();await assert.rejects(sessions.get(a.id)!.tick());assert.equal((await runtime.state(a)).state,'Off');
  await sessions.get(b.id)!.tick();assert.equal(JSON.parse(await curl(b)).ip,'203.0.113.20');assert.equal((await runtime.state(b)).state,'Running');pass('Failure and shutdown of A do not stop or reroute B');
  assert.equal(backgroundErrors.length,0);succeeded=true;
 }finally{
  for(const timer of timers.values())clearInterval(timer);child?.kill('SIGKILL');await Promise.allSettled(pending.values());
  await Promise.allSettled([...sessions.values()].map(s=>s.fail()));const stopped=await Promise.allSettled(created.map(c=>runtime.stop(c)));cleanupConfirmed=stopped.every(value=>value.status==='fulfilled');
  await aFixture.close();await bFixture.close();const currentHashes=Object.fromEntries(await Promise.all(codeFiles.map(async file=>[file,await fileHash(file)])));sourceStable=JSON.stringify(sourceHashes)===JSON.stringify(currentHashes);
  await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'controller-death-and-two-guests',results,backgroundErrors,sourceHashes,sourceChangedDuringTest:!sourceStable,cleanupConfirmed,aiWebsitesVisited:0,realAccountTests:0,complete:succeeded&&sourceStable&&cleanupConfirmed&&results.length===7},null,2));
 }
 if(!cleanupConfirmed)throw Error('Owned test VM shutdown was not fully confirmed');
 if(!sourceStable)throw Error('Acceptance source changed during the isolation experiment');
 console.log(JSON.stringify({passed:results.length,complete:results.length===7,aiWebsitesVisited:0}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
