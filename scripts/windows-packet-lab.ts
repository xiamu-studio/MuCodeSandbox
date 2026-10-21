import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,access} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {run} from '../server/process.ts';
import {HyperVRuntime,fileHash,powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
import {startBroker,installedBrokerPath,cleanWindowsEnvironment} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {windowsConfigSchema,vmIdentity,type WindowsConfig} from '../server/platform/windows/config.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';
import {readPcapng,readPcap,ethernet} from './windows/pcap.ts';
import {validateSyntheticFrame} from './windows/packet-validation.ts';
import type {WindowsNetworkSession} from '../server/platform/windows/session.ts';

async function jsonFile(file:string){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return undefined;throw error;}}
async function waitJson(file:string,timeout=90000){const until=Date.now()+timeout;for(;;){const value=await jsonFile(file);if(value)return value;assert.ok(Date.now()<until,'Diagnostic result did not arrive: '+path.basename(file));await delay(100);}}
class PacketObserver{
 sequence=0;pid=0;
 readonly directory:string;readonly nonce:string;
 constructor(directory:string,nonce:string){this.directory=directory;this.nonce=nonce;}
 async start(profile:object){const file=path.join(this.directory,'profile.json');await writeFile(file,JSON.stringify(profile),{flag:'wx'});const body=`& '${path.resolve('scripts/windows/packet-observer.ps1').replaceAll("'","''")}' -LabProfilePath '${file.replaceAll("'","''")}'`,encoded=Buffer.from(body,'utf16le').toString('base64');
  this.pid=Number((await run(powershellPath(),powershellArgs(`$p=Start-Process -FilePath '${powershellPath().replaceAll("'","''")}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -PassThru;[Console]::Write($p.Id)`),{env:cleanWindowsEnvironment(),timeoutMs:30000})).trim());assert.ok(Number.isInteger(this.pid)&&this.pid>0);
  const until=Date.now()+90000;for(;;){const error=await jsonFile(path.join(this.directory,'error.json'));if(error)throw Error(error.error);const ready=await jsonFile(path.join(this.directory,'ready.json'));if(ready){assert.equal(ready.pid,this.pid);return ready;}if(await jsonFile(path.join(this.directory,'finished.json')))throw Error('Packet observer stopped before capture');assert.ok(Date.now()<until,'Packet observer did not initialize');await delay(100);}
 }
 async call(action:'snapshot'|'control-open'|'control-close'|'finish'){
  const sequence=++this.sequence,target=path.join(this.directory,`command-${sequence}.json`),next=target+'.next';await writeFile(next,JSON.stringify({nonce:this.nonce,action}),{flag:'wx'});await rename(next,target);const reply=await waitJson(path.join(this.directory,`reply-${sequence}.json`));assert.equal(reply.ok,true,reply.error);return reply;
 }
 async finish(){if(!this.pid)return;let result=await jsonFile(path.join(this.directory,'finished.json'));if(!result){await this.call('finish');result=await waitJson(path.join(this.directory,'finished.json'));}assert.equal(result.restored,true,JSON.stringify(result.cleanupErrors));
  const until=Date.now()+30000;while((await run(powershellPath(),powershellArgs(`[Console]::Write([bool](Get-Process -Id ${this.pid} -ErrorAction SilentlyContinue))`),{env:cleanWindowsEnvironment(),timeoutMs:10000})).trim()==='True'){assert.ok(Date.now()<until,'Packet observer has not exited');await delay(100);}return result;
 }
}
async function main(){
 if(process.platform!=='win32')throw Error('Windows packet lab requires Windows');
 const root=windowsRuntimeDirectory(),subjectId=randomUUID(),directory=path.join(root,'packet-lab-'+subjectId),runtimeRoot=path.join(directory,'user-runtime'),nonce=randomBytes(32).toString('hex'),createdAt=new Date().toISOString();await secureWindowsDirectory(directory);await mkdir(runtimeRoot);
 const base=JSON.parse(await readFile(path.join(root,'protected-base.json'),'utf8'));
 const files=['scripts/windows-packet-lab.ts','scripts/windows-verify-packet-evidence.ts','scripts/windows/packet-observer.ps1','scripts/windows/packet-guest.py','scripts/windows/pcap.ts','scripts/windows/packet-validation.ts','native/windows/PacketLabGuard.cs','native/windows/HyperVBroker.cs','native/windows/ProtectedLedger.cs','native/windows/ImageCache.cs','native/windows/Resources.cs','native/windows/Recovery.cs','native/windows/RecoveryPermissions.cs','native/windows/ResourceMetrics.cs','scripts/windows/hyperv.ps1','server/platform/windows/runtime.ts','server/platform/windows/broker.ts','server/platform/windows/guest.ts','server/platform/windows/session.ts','server/network-guard.ts','server/guest-lease.ts','server/transparent-network.ts'];const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));const sourceHashes=Object.fromEntries(await hashes());
 const fixture=await localFixtures(path.join(directory,'fixtures'),process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');let broker:Awaited<ReturnType<typeof startBroker>>;try{broker=await startBroker(await installedBrokerPath());}catch(error){await fixture.close();throw error;}
 const runtime=new HyperVRuntime(runtimeRoot,undefined,broker),observer=new PacketObserver(directory,nonce),configs=[subjectId,randomUUID()].map(id=>windowsConfigSchema.parse({version:1,id,...base,cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:fixture.port},expectedIp:LAB_EXIT,dns:fixture.dns}));const hostBefore=await runtime.fingerprint();
 const [subject,sink]=configs,allocated:WindowsConfig[]=[],results:{name:string;passed:boolean}[]=[];const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
 let session:WindowsNetworkSession|undefined,timer:ReturnType<typeof setInterval>|undefined,pending=Promise.resolve(),backgroundError:unknown,complete=false,cleanupConfirmed=false,hostNetworkUnchanged:boolean|null=null,unit='',initial:any,ready:any;
 const script=await readFile('scripts/windows/packet-guest.py','utf8');
 const managementReady=async(c:WindowsConfig)=>{const until=Date.now()+240000;for(;;){try{await runtime.management(c,['true'],{timeoutMs:8000});return;}catch(error){if(Date.now()>until)throw error;await delay(1000);}}};
 const stats=()=>runtime.management(sink,['sudo','cat','/run/mu-packet-stats.json'],{timeoutMs:10000}).then(text=>JSON.parse(text));
 const tag=(phase:string,label:string,repeat:number)=>`MU_PKT|${nonce}|${phase}|${label}|${repeat}|`;
 const inject=async(phase:string)=>{const sent=JSON.parse(await runtime.management(subject,['sudo','python3','/run/mu-packet-guest.py','send','--source-mac',ready.subjectMac,'--destination-mac',ready.sinkMac,'--source-ip',vmIdentity(subject.id).guest,'--nonce',nonce,'--phase',phase]));assert.equal(sent.frames,21);await delay(300);return sent.labels as string[];};
 const blocked=async(phase:string,labels:string[])=>{const value=await stats();assert.equal(value.overflow,false);assert.equal(value.socketDrops,0);for(const label of labels.filter(label=>label!=='l2-link'))for(let repeat=0;repeat<3;repeat++)assert.equal(value.tags[tag(phase,label,repeat)]??0,0,phase+' '+label+' escaped to sink');return value;};
 try{
  for(const c of configs){allocated.push(c);await runtime.create(c);}const platforms=await Promise.all(configs.map(c=>runtime.state(c)));
  ready=await observer.start({version:1,nonce,createdAt,ownerPid:process.pid,subjectId:subject.id,subjectPlatformId:platforms[0].platformId,sinkId:sink.id,sinkPlatformId:platforms[1].platformId});assert.equal(ready.noHostAdapter,true);pass('Host capture is scoped to one exclusive VM MAC on an uplink-free Private switch');
  await managementReady(sink);await runtime.management(sink,['sudo','tee','/run/mu-packet-guest.py'],{input:script});unit='mu-packet-'+subjectId.replaceAll('-','');await runtime.management(sink,['sudo','systemd-run','--unit='+unit,'--property=RuntimeMaxSec=600','--','/usr/bin/python3','/run/mu-packet-guest.py','receive','--source-mac',ready.subjectMac]);
  const until=Date.now()+10000;for(;;){try{await stats();break;}catch{assert.ok(Date.now()<until,'Raw receiver did not start');await delay(100);}}
  const sourceStartAt=new Date().toISOString();assert.ok(Date.parse(ready.captureStartedAt)<Date.parse(sourceStartAt));await runtime.start(subject);initial=await stats();assert.equal(initial.ipv4,0);assert.equal(initial.ipv6,0);await writeFile(path.join(directory,'startup.json'),JSON.stringify({captureStartedAt:ready.captureStartedAt,sourceStartAt,initial},null,2));pass('An independent receiver and host trace are armed before the subject boots; startup delivers no IPv4/IPv6');
  await runtime.management(subject,['sudo','tee','/run/mu-packet-guest.py'],{input:script});const labels=await inject('startup');await blocked('startup',labels);pass('Unapproved startup raw IPv4/IPv6 TCP, UDP and ICMP bypass attempts do not reach the receiver');
  await writeFile(path.join(directory,'startup-counters.json'),JSON.stringify(await observer.call('snapshot'),null,2));
  for(const file of ['/etc/mucodesandbox/packet-lab-ca.crt','/usr/local/share/ca-certificates/mu-local-fixture.crt'])await runtime.management(subject,['sudo','tee',file],{input:fixture.certificate});await runtime.management(subject,['sudo','update-ca-certificates'],{timeoutMs:30000});
  const curl=(host:string,probe=false)=>runtime.management(subject,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--cacert','/etc/mucodesandbox/packet-lab-ca.crt','--proxy',probe?'socks5h://127.0.0.1:17402':'','--noproxy',probe?'':'*',`https://${host}/`],{timeoutMs:10000});
  session=await runtime.session(subject,async()=>Promise.all(fixture.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await curl(receiver,true)).ip}))));await runtime.connect(subject);await session.open();timer=setInterval(()=>{pending=pending.then(()=>session!.tick()).catch(error=>{backgroundError=error;});},8000);
  assert.equal(JSON.parse(await curl('receiver.mu.test')).ip,LAB_EXIT);pass('Normal developer HTTPS and controlled DoH work through the approved local tunnel during observation');
  await inject('approved');await blocked('approved',labels);assert.equal(backgroundError,undefined);pass('An active business permit does not open an Ethernet bypass around the host IP ACLs');
  clearInterval(timer);await pending;await session.driver.disconnect();await session.driver.revoke();assert.equal((await runtime.inspectGuard(subject)).leaseActive,false);
  await observer.call('control-open');await inject('control');const controlUntil=Date.now()+5000;let control:any;for(;;){control=await stats();if(labels.every(label=>[0,1,2].every(repeat=>(control.tags[tag('control',label,repeat)]??0)===1)))break;assert.ok(Date.now()<controlUntil,'Positive packet control did not reach the independent receiver');await delay(100);}assert.equal(control.socketDrops,0);pass('A bounded synthetic control with the source ACL removed reaches the receiver for every protocol');
  await observer.call('control-close');await inject('restored');await blocked('restored',labels);pass('Restoring the source ACL blocks the same raw frames again without changing any host adapter');
  await writeFile(path.join(directory,'final-counters.json'),JSON.stringify(await observer.call('snapshot'),null,2));await runtime.management(sink,['sudo','systemctl','stop',unit]);assert.equal((await stats()).socketDrops,0);const pcap=Buffer.from((await runtime.management(sink,['sudo','base64','-w0','/run/mu-packet-receiver.pcap'],{maxBytes:24*1024*1024})).trim(),'base64');await writeFile(path.join(directory,'sink.pcap'),pcap);
  await observer.finish();const sinkFrames=readPcap(pcap),flow=readPcapng(await readFile(path.join(directory,'trace-artifacts/flow.pcapng'))),drops=readPcapng(await readFile(path.join(directory,'trace-artifacts/drop.pcapng')));assert.ok(flow.length>0&&drops.length>0);
  for(const phase of ['startup','approved','restored'])for(const label of labels.filter(value=>value!=='l2-link'))for(let repeat=0;repeat<3;repeat++){const mark=Buffer.from(tag(phase,label,repeat));assert.ok(drops.some(frame=>frame.data.includes(mark)),'Host drop capture missing '+phase+' '+label);assert.equal(sinkFrames.some(frame=>frame.data.includes(mark)),false);}
  for(const label of labels)for(let repeat=0;repeat<3;repeat++){const mark=Buffer.from(tag('control',label,repeat));assert.ok(sinkFrames.some(frame=>frame.data.includes(mark)));assert.ok(flow.some(frame=>frame.data.includes(mark)));}pass('Independent pcap records and host drop-only pcapng correlate every individually tagged synthetic case with zero capture loss');
  for(const frame of [...flow,...drops]){const addresses=ethernet(frame);assert.ok(addresses.source===ready.subjectMac.toLowerCase()||addresses.destination===ready.subjectMac.toLowerCase(),'Capture includes another MAC');}pass('Every captured Ethernet frame matches the single diagnostic VM MAC filter');
  let checksums=0;for(const frame of [...flow,...drops,...sinkFrames]){const index=frame.data.indexOf(`MU_PKT|${nonce}|`);if(index<0)continue;validateSyntheticFrame(frame,frame.data.subarray(index).toString('ascii').split('|')[3]);checksums++;}assert.ok(checksums>=21);pass('A separate decoder verifies the actual IPv4, TCP, UDP and ICMP checksums and IPv6 pseudoheaders');
  await writeFile(path.join(directory,'evidence-summary.json'),JSON.stringify({sinkPackets:sinkFrames.length,hostFlowSnapshots:flow.length,hostDropSnapshots:drops.length,initial,control,labels},null,2));complete=true;
 }finally{
  clearInterval(timer);await pending;try{await observer.finish();}finally{try{await session?.fail();for(const c of allocated)await runtime.remove(c);hostNetworkUnchanged=(await runtime.fingerprint())===hostBefore;assert.equal(hostNetworkUnchanged,true,'Host network fingerprint changed during packet acceptance');cleanupConfirmed=true;}finally{await broker.call('shutdown').catch(()=>{});await fixture.close();const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'independent-host-and-peer-packet-evidence',sourceHashes,sourceChangedDuringTest,cleanupConfirmed,hostNetworkFingerprintUnchanged:hostNetworkUnchanged,results,complete:complete&&cleanupConfirmed&&!sourceChangedDuringTest,aiWebsitesVisited:0},null,2));if(sourceChangedDuringTest)throw Error('Packet acceptance source changed during the experiment');}}
 }
 console.log(JSON.stringify({passed:results.length,complete:complete&&cleanupConfirmed}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Packet evidence failed');process.exitCode=1;});
