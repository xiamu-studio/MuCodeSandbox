import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,readFile,readdir,writeFile,rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createService } from '../server/service.ts';
import { ProxyTransports } from '../server/proxy-transport.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { SING_BOX_ARCHIVE,SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { RESET_BROWSER_PROFILE_SCRIPT } from '../server/browser-reset.ts';
import { seedProtectedTestBase } from './seed-protected-test-base.ts';
import { packetLines } from './packet-capture.ts';

const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-usability-runtime-'));
const artifacts=path.join(root,'test-results',`usability-runtime-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
process.env.MU_LIMA_PATH=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),accountFree:true,paidModelCalls:0,owned,artifacts,stages:[],
  scope:'Current source API and actual protected Linux VM/browser reset, selected interruption recovery, local account-free checks and short Vietnam egress; no paid model, no actual sleep or full-day verification'};
let mode='write';const fixture=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/api/cookie'){
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cookie:req.headers.cookie?.includes('mu-reset=synthetic-a')??false}));return;
  }
  if(mode==='write')res.setHeader('Set-Cookie','mu-reset=synthetic-a; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600');
  const cookie=req.headers.cookie?.includes('mu-reset=synthetic-a')??false;
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><title>Local reset acceptance</title></head><body><h1>Local browser reset</h1><script>
  (async()=>{const writing=${mode==='write'};
    if(writing)localStorage.setItem('mu-reset-owner','old-profile');
    const db=await new Promise((yes,no)=>{const r=indexedDB.open('mu-reset-db',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)});
    if(writing)await new Promise((yes,no)=>{const t=db.transaction('state','readwrite');t.objectStore('state').put('old-profile','owner');t.oncomplete=yes;t.onerror=()=>no(t.error)});
    const stored=await new Promise((yes,no)=>{const r=db.transaction('state').objectStore('state').get('owner');r.onsuccess=()=>yes(r.result??null);r.onerror=()=>no(r.error)});db.close();
    const observedCookie=await(await fetch('/api/cookie')).json();
    window.__MU_RESET_RESULT__={cookie:observedCookie.cookie,localStorage:localStorage.getItem('mu-reset-owner'),indexedDB:stored};
    document.body.append(JSON.stringify(window.__MU_RESET_RESULT__));
  })().catch(e=>window.__MU_RESET_ERROR__=e.message);
  </script></body></html>`);
});await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const service=await createService({rootDir:root,dataDir:owned,port:0}),{manager,guestBrowser}=service,runtime=manager.runtime;
const sources=[...((await readdir(path.join(root,'server'))).filter(f=>f.endsWith('.ts')).map(f=>`server/${f}`)),`scripts/${path.basename(import.meta.filename)}`,'shared/types.ts'];
report.inputs={};await mkdir(path.join(artifacts,'inputs/server'),{recursive:true});await mkdir(path.join(artifacts,'inputs/scripts'),{recursive:true});await mkdir(path.join(artifacts,'inputs/shared'),{recursive:true});
for(const file of sources){const bytes=await readFile(path.join(root,file));report.inputs[file]=hash(bytes);await writeFile(path.join(artifacts,'inputs',file),bytes,{mode:0o600});}
const forwarding=new ProxyTransports(runtime.limaHome);let e:any,capture=false,viewer:WebSocket|undefined;
const originalManagement=runtime.management.bind(runtime);
const persist=async(stage:string)=>{report.progress={stage,at:new Date().toISOString()};await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(stage);};
const finish=async(job:any,expected='succeeded')=>{await manager.tasks.get(job.id)?.promise;const result=manager.store.jobs().find(j=>j.id===job.id)!;assert.equal(result.status,expected,result.message);e=manager.store.get(e.id);return result;};
async function navigate(writing:boolean){
  mode=writing?'write':'read';if(!guestBrowser.running(e.id))await finish(await manager.openBrowser(e.id));
  const entry=guestBrowser.entries.get(e.id)!;const session=[...entry.sessions.values()][0];
  const url=`http://127.0.0.1:${report.fixturePort}/`;
  await entry.tools!.send('Page.navigate',{url},session);
  for(let n=0;n<100;n++){
    const r=await entry.tools!.send('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,result:window.__MU_RESET_RESULT__??null,error:window.__MU_RESET_ERROR__??null})',returnByValue:true},session);
    const v=JSON.parse(r.result.value??'{}');if(v.url===url&&v.error)throw new Error(v.error);
    if(v.url===url&&v.result){
      if(!writing)assert.deepEqual(v.result,{cookie:false,localStorage:null,indexedDB:null});else assert.deepEqual(v.result,{cookie:true,localStorage:'old-profile',indexedDB:'old-profile'});
      const shot=await entry.tools!.send('Page.captureScreenshot',{format:'png'},session);await writeFile(path.join(artifacts,`${report.stages.length}-${writing?'old':'empty'}.png`),Buffer.from(shot.data,'base64'));
      report.stages.push({name:writing?'old local identity':'empty local identity',result:v.result});return;
    }await delay(100);
  }throw new Error('Fixture did not report');
}
async function captureNetwork(){
  await originalManagement(e,['sudo','systemctl','stop','mu-usability-capture.service'],{timeoutMs:15000});capture=false;
  const bytes=Buffer.from((await originalManagement(e,['sudo','base64','-w0','/run/mu-usability.pcap'],{timeoutMs:15000,maxBytes:32*2**20})).trim(),'base64');
  assert.ok(['d4c3b2a1','a1b2c3d4','4d3cb2a1','0a0d0d0a'].includes(bytes.subarray(0,4).toString('hex')),'Capture must retain its complete header');
  const file=path.join(artifacts,'runtime.pcap');await writeFile(file,bytes,{mode:0o600});
  const gateway=(await originalManagement(e,['ip','-4','route','show','default'],{timeoutMs:10000})).match(/default via (\S+)/)![1];
  const packets=await packetLines(file,'ifindex 2 and outbound and (ip or ip6)');
  const unapproved=packets.filter(line=>/\sIP6\s/.test(line)||!(line.includes(`.22 > ${gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)));
  assert.ok(packets.length>0);assert.deepEqual(unapproved,[]);report.capture={file,sha256:hash(bytes),bytes:bytes.length,physicalOut:packets.length,unapproved:0,gateway};
}
try{
  await persist('Seeding an owned protected VM from the stopped local cache');
  report.seed=await seedProtectedTestBase(runtime,'/Users/staff/.mu-browser-monitor-ixibDP');
  const archive=await readFile('/Users/staff/.mu-browser-monitor-ixibDP/tools/sing-box/'+SING_BOX_ARCHIVE);assert.equal(hash(archive),SING_BOX_SHA256);
  await mkdir(path.join(owned,'tools/sing-box'),{recursive:true});await writeFile(path.join(owned,'tools/sing-box',SING_BOX_ARCHIVE),archive);
  const browserCache=path.join(owned,'tools/guest-browser');await mkdir(browserCache,{recursive:true});
  const browserArchive=`/tmp/mu-chromium-${CURRENT_BROWSER_RELEASE.version}-arm64.zip`;assert.equal(hash(await readFile(browserArchive)),CURRENT_BROWSER_RELEASE.sha256);
  await copyFile(browserArchive,path.join(browserCache,`chrome-${CURRENT_BROWSER_RELEASE.version}-linux-arm64.zip`));
  const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  const lineResponse=await fetch(`${service.url}/api/local-proxy/line`,{method:'POST',headers,body:JSON.stringify({name:'🇻🇳 B1037 越南'})});
  assert.equal(lineResponse.status,200);const line=await lineResponse.json() as any;report.line=line;
  e=await manager.create({name:'Usability local account-free acceptance',cpus:2,memoryGiB:2,diskGiB:10,browserUrl:'https://example.com',
    network:{mode:'http',host:'127.0.0.1',port:line.port,username:'',strict:true,transparent:true,noProxy:'localhost,127.0.0.1,::1'},identity:{locale:'en-US',timezone:'Asia/Taipei'}});
  await persist('Starting the real protected VM');
  let job=await manager.lifecycle(e.id,'start');await manager.tasks.get(job.id)?.promise;
  const first=manager.store.jobs().find(j=>j.id===job.id)!;report.firstStart={status:first.status,message:first.message};
  if(first.status!=='succeeded'){e=manager.store.get(e.id);job=await manager.lifecycle(e.id,'start');}
  await finish(job);
  report.configurationBefore=manager.view(e);report.bootId=(await originalManagement(e,['cat','/proc/sys/kernel/random/boot_id'],{timeoutMs:10000})).trim();
  await finish(await manager.openBrowser(e.id));
  await originalManagement(e,['sudo','systemd-run','--quiet','--unit=mu-usability-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-usability.pcap'],{timeoutMs:15000});capture=true;
  const forwarded=await forwarding.open(e.id,e.instanceName,'127.0.0.1',(fixture.address() as {port:number}).port);report.fixturePort=forwarded.port;
  await runtime.guest(e,['bash','-c','printf KEEP_VM_FILES > /home/dev/reset-project-canary.txt; mkdir -p /home/dev/.claude; printf SYNTHETIC_CLI_CONFIG > /home/dev/.claude/reset-canary'],{timeoutMs:10000});
  await persist('Creating an actual old browser login and storage');await navigate(true);
  const ticket=await guestBrowser.issue(e.id);viewer=new WebSocket(`${service.url.replace('http:','ws:')}/guest-browser?ticket=${ticket.ticket}`,{headers:{Origin:service.url}});viewer.on('error',()=>{});
  await new Promise<void>((resolve,reject)=>{viewer!.once('open',resolve);viewer!.once('error',reject);});const viewerClosed=new Promise<void>(resolve=>viewer!.once('close',()=>resolve()));
  await runtime.guest(e,['bash','-c','printf OLD_PASSWORD_AND_EXTENSION_CANARY > /home/dev/.local/share/mucodesandbox/browser/reset-extra-data'],{timeoutMs:10000});
  await persist('Resetting through the authenticated product API');
  const resetResponse=await fetch(`${service.url}/api/environments/${e.id}/browser/reset`,{method:'POST',headers,body:JSON.stringify({confirm:'erase-browser-profile'})});assert.equal(resetResponse.status,202);
  await finish(await resetResponse.json());await Promise.race([viewerClosed,delay(3000).then(()=>{throw new Error('Old viewer remained open');})]);
  assert.equal(guestBrowser.tickets.has(ticket.ticket),false);report.oldViewerRevoked=true;
  assert.equal((await runtime.guest(e,['cat','/home/dev/reset-project-canary.txt'],{timeoutMs:10000})).trim(),'KEEP_VM_FILES');
  assert.equal((await runtime.guest(e,['cat','/home/dev/.claude/reset-canary'],{timeoutMs:10000})).trim(),'SYNTHETIC_CLI_CONFIG');
  await assert.rejects(runtime.guest(e,['test','-e','/home/dev/.local/share/mucodesandbox/browser/reset-extra-data'],{timeoutMs:10000}));
  await navigate(false);assert.equal((await originalManagement(e,['cat','/proc/sys/kernel/random/boot_id'],{timeoutMs:10000})).trim(),report.bootId);report.vmKeptRunning=true;
  await persist('Checking selected exact reset interruption points');
  for(const point of ['intent','detached','published','cleaned']){
    await navigate(true);await manager.closeBrowser(e.id);
    const injected=RESET_BROWSER_PROFILE_SCRIPT.replace('\nwith installation_lock():\n',`\ndef reset_step(name):\n    print('MU_BROWSER_RESET_STAGE ' + name, flush=True)\n    if name == '${point}': os.kill(os.getpid(), 9)\nwith installation_lock():\n`);
    await writeFile(path.join(artifacts,`fault-${point}.sh`),injected,{mode:0o600});
    runtime.management=async(environment,args,options)=>originalManagement(environment,args,{...options,input:options?.input===RESET_BROWSER_PROFILE_SCRIPT?injected:options?.input});
    const failed=await finish(await manager.maintainBrowser(e.id,'reset'),'failed');runtime.management=originalManagement;
    await navigate(false);report.stages.push({name:`interruption ${point}`,failedJob:failed.status,recoveredEmpty:true});
  }
  await persist('Rejecting a linked profile without touching its target');await manager.closeBrowser(e.id);
  await runtime.guest(e,['bash','-c','mkdir -p /home/dev/reset-escape-target; printf MUST_KEEP > /home/dev/reset-escape-target/canary; rm -rf /home/dev/.local/share/mucodesandbox/browser; ln -s /home/dev/reset-escape-target /home/dev/.local/share/mucodesandbox/browser'],{timeoutMs:10000});
  await finish(await manager.maintainBrowser(e.id,'reset'),'failed');assert.equal((await runtime.guest(e,['cat','/home/dev/reset-escape-target/canary'],{timeoutMs:10000})).trim(),'MUST_KEEP');
  await runtime.guest(e,['bash','-c','unlink /home/dev/.local/share/mucodesandbox/browser; mkdir -m 700 /home/dev/.local/share/mucodesandbox/browser'],{timeoutMs:10000});report.symlinkRejected=true;
  await persist('Running the new account-free UI endpoint');
  const checkResponse=await fetch(`${service.url}/api/environments/${e.id}/lab/check`,{method:'POST',headers});assert.equal(checkResponse.status,202);await finish(await checkResponse.json());
  const checks=await(await fetch(`${service.url}/api/lab/checks`,{headers})).json() as any[];report.localCheck=checks.find(r=>r.environmentId===e.id);assert.equal(report.localCheck.state,'passed');assert.equal(report.localCheck.checks.length,6);
  report.guestExit=await manager.testNetwork(e.id);assert.match(report.guestExit.country,/^Viet(?:nam| Nam)$/i);
  await manager.closeBrowser(e.id);await captureNetwork();
  report.configurationAfter=manager.view(manager.store.get(e.id));assert.deepEqual(report.configurationAfter.network,report.configurationBefore.network);
  assert.equal(report.configurationAfter.id,report.configurationBefore.id);assert.equal(report.configurationAfter.diskGiB,report.configurationBefore.diskGiB);
  report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;console.error(report.error);}
finally{
  runtime.management=originalManagement;viewer?.terminate();
  try{report.allLocalChecks=await(await fetch(`${service.url}/api/lab/checks`,{headers:{Authorization:`Bearer ${service.token}`}})).json();}catch{/* Preserve the main failure if the receiver already closed. */}
  if(capture&&e)await captureNetwork().catch(error=>{report.captureError=String(error);report.passed=false;process.exitCode=1;});
  if(e){await manager.closeBrowser(e.id).catch(()=>{});await runtime.stop(e).catch(()=>{});await runtime.remove(e).catch(()=>{});}
  await forwarding.close(e?.id??'none');await service.close();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
  const remaining=await runtime.list().catch(()=>[]);for(const instance of remaining)await runtime.command(['delete','--force',instance.name],{timeoutMs:120000});
  await rm(owned,{recursive:true,force:true});report.testResourcesRemoved=true;report.finishedAt=new Date().toISOString();
  report.inputsUnchanged=true;for(const file of sources)if(hash(await readFile(path.join(root,file)))!==report.inputs[file])report.inputsUnchanged=false;
  if(!report.inputsUnchanged){report.passed=false;process.exitCode=1;report.inputError='Product or harness source changed during live verification';}
  await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  await writeFile(path.join(root,'test-results/usability-runtime.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({passed:report.passed,error:report.error,artifacts,cleaned:report.testResourcesRemoved}));
}
