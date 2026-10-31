import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {WindowsBrowserComponentRecovery,parseWindowsBrowserRepairResult} from '../server/platform/windows/browser-repair-service.ts';
import {WINDOWS_BROWSER_REPAIR_BOOTSTRAP,WINDOWS_BROWSER_REPAIR_STATE_PYTHON,windowsBrowserRepairState} from '../server/platform/windows/browser-repair.ts';
import {WINDOWS_BROWSER_VERSION_SCRIPT} from '../server/platform/windows/browser-installation.ts';
import {WINDOWS_CHROME} from '../server/platform/windows/browser-assets.ts';
import {WINDOWS_BROWSER_CANDIDATE} from '../server/platform/windows/browser-releases.ts';
import {VERIFY_WINDOWS_DESKTOP} from '../server/platform/windows/browser-guest.ts';
import {WINDOWS_BROWSER_SELECTION_INSPECT} from '../server/platform/windows/browser-selection.ts';
import {WINDOWS_BROWSER_REPAIR_OBSERVATION} from '../server/platform/windows/browser-repair-observation.ts';
import {WindowsBrowser} from '../server/platform/windows/browser.ts';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';
import type {WindowsManager} from '../server/platform/windows/manager.ts';
import type {Environment} from '../shared/types.ts';

const repaired={state:'repaired',version:WINDOWS_CHROME.version,retainedPrevious:true,cleanupWarning:false};
const verified={version:1,state:'verified',issue:null,recordedVersion:WINDOWS_CHROME.version};
function fixture(enabled=true,selected:string=WINDOWS_CHROME.version){
 const environment={id:'fixture',name:'本地合成组件恢复',state:'running',browserUrl:'about:blank',identity:{timezone:'UTC',locale:'en-US'},cpus:2} as Environment,session={id:'old',state:'active'},sessions=new Map([[environment.id,session]]),calls:string[]=[],control=new AbortController(),archive=Buffer.from('synthetic archive');
 const requestedVersions:string[]=[],programs:string[]=[],hooks:{at?:(phase:string)=>Promise<void>;reply?:string;fence?:string;version?:string;observation?:string}={};const at=async(phase:string)=>{calls.push(phase);await hooks.at?.(phase);};
 const manager={sessions,store:{get:()=>environment,log:()=>calls.push('log')},assertAccess:async()=>{await at('guard');return environment;},profile:async()=>{await at('profile');return {};}} as unknown as WindowsManager;
 const runtime={management:async(_config:unknown,command:string[],options?:{inputBytes?:Uint8Array;input?:string;signal?:AbortSignal})=>{if(options?.input===WINDOWS_BROWSER_REPAIR_OBSERVATION){await at('observe');return hooks.observation??JSON.stringify({version:1,selectedVersion:selected,pending:null});}if(command.includes(WINDOWS_BROWSER_REPAIR_BOOTSTRAP)){await at('repair');assert.deepEqual(command,['sudo','-n','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_BOOTSTRAP]);assert.ok(options?.signal instanceof AbortSignal);assert.equal(options.signal.aborted,control.signal.aborted);const input=Buffer.from(options!.inputBytes!);programs.push(input.subarray(4,4+input.readUInt32BE()).toString());assert.deepEqual(input.subarray(4+input.readUInt32BE()),archive);assert.ok(input.subarray(4,4+input.readUInt32BE()).toString().includes('TARGET=pathlib.Path("/opt/mucodesandbox/windows/chrome-'+selected+'")'));return hooks.reply??JSON.stringify({...repaired,version:selected});}if(command.includes(WINDOWS_BROWSER_REPAIR_STATE_PYTHON)){await at('fence');return hooks.fence??'none';}assert.ok(command.includes(WINDOWS_BROWSER_VERSION_SCRIPT));await at('version');return hooks.version??JSON.stringify({...verified,selectedVersion:selected,recordedVersion:selected});}};
 const recovery=new WindowsBrowserComponentRecovery(manager,runtime,async()=>at('close'),async(_options,version)=>{requestedVersions.push(version);await at('archive');return archive;},enabled);
 return {environment,session,sessions,calls,control,hooks,manager,runtime,recovery,requestedVersions,programs,repair:()=>recovery.repair(environment.id,environment.name,{signal:control.signal})};
}

test('Component recovery binds close, asset preparation, repair and independent readback to the original protected session',async()=>{
 const f=fixture();assert.deepEqual(await f.repair(),repaired);assert.deepEqual(f.calls,['guard','profile','observe','close','guard','archive','guard','repair','guard','fence','version','guard','log']);assert.equal(f.environment.state,'running');
 const resume=fixture();resume.hooks.reply=JSON.stringify({state:'none'});assert.deepEqual(await resume.recovery.resume('fixture',{signal:resume.control.signal}),{state:'none'});assert.equal(resume.calls.includes('close'),false);assert.equal(resume.calls.at(-1),'log');
});

test('Disabled recovery and changed confirmation cannot close a browser or prepare assets',async()=>{
 const disabled=fixture(false);await assert.rejects(disabled.repair(),{code:'BROWSER_REPAIR_UNAVAILABLE'});assert.deepEqual(disabled.calls,[]);
 const wrong=fixture();await assert.rejects(wrong.recovery.repair('fixture','其他环境'),{code:'BROWSER_REPAIR_CONFIRMATION'});assert.deepEqual(wrong.calls,['guard']);
});
test('A base-component repair cannot report success using a verified different selected version',async()=>{const f=fixture();f.hooks.version=JSON.stringify({version:1,state:'verified',issue:null,selectedVersion:WINDOWS_BROWSER_CANDIDATE.version,recordedVersion:WINDOWS_BROWSER_CANDIDATE.version});await assert.rejects(f.repair(),{code:'BROWSER_REPAIR_VERIFY_FAILED'});assert.equal(f.calls.includes('log'),false);});

test('Selected candidate repair requests only its own approved archive, program and final observation',async()=>{
 const version=WINDOWS_BROWSER_CANDIDATE.version,f=fixture(true,version);assert.deepEqual(await f.repair(),{...repaired,version});assert.deepEqual(f.requestedVersions,[version]);assert.equal(f.programs.length,1);assert.ok(f.programs[0].includes('REPAIR_EXPECT_PENDING=None'));assert.equal(f.calls.at(-1),'log');
 assert.deepEqual(parseWindowsBrowserRepairResult(JSON.stringify({...repaired,version}),true,version),{...repaired,version});assert.throws(()=>parseWindowsBrowserRepairResult(JSON.stringify(repaired),true,version),{code:'BROWSER_REPAIR_RECEIPT_INVALID'});assert.throws(()=>parseWindowsBrowserRepairResult(JSON.stringify({...repaired,version}),true),{code:'BROWSER_REPAIR_RECEIPT_INVALID'});
});

test('Selected repair resume carries only the observed pending epoch into the root mutation',async()=>{
 const version=WINDOWS_BROWSER_CANDIDATE.version,epoch='a'.repeat(32),f=fixture(true,version);f.hooks.observation=JSON.stringify({version:1,selectedVersion:version,pending:{epoch,phase:'prepared'}});assert.deepEqual(await f.recovery.resume('fixture',{signal:f.control.signal}),{...repaired,version});assert.equal(f.calls.includes('close'),false);assert.deepEqual(f.requestedVersions,[version]);assert.ok(f.programs[0].includes('REPAIR_EXPECT_PENDING='+JSON.stringify(epoch)));
});

test('Unknown or incomplete root repair observations cannot close the viewer, request archives or mutate components',async()=>{
 for(const observation of ['{}','[]',JSON.stringify({version:1,selectedVersion:'157.0.0.0',pending:null}),JSON.stringify({version:1,selectedVersion:WINDOWS_BROWSER_CANDIDATE.version,pending:{epoch:'../foreign',phase:'receiving'}}),JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version,pending:null,path:'/foreign'})]){const f=fixture();f.hooks.observation=observation;await assert.rejects(f.repair(),{code:'BROWSER_REPAIR_OBSERVATION'});assert.equal(f.calls.includes('close'),false);assert.equal(f.calls.includes('archive'),false);assert.equal(f.calls.includes('repair'),false);assert.equal(f.calls.includes('log'),false);}
});

test('A selected candidate repair cannot accept an old-version root receipt or final component',async()=>{
 for(const phase of ['reply','version'] as const){const f=fixture(true,WINDOWS_BROWSER_CANDIDATE.version);f.hooks[phase]=JSON.stringify(phase==='reply'?repaired:verified);await assert.rejects(f.repair(),{code:phase==='reply'?'BROWSER_REPAIR_RECEIPT_INVALID':'BROWSER_REPAIR_VERIFY_FAILED'});assert.equal(f.calls.includes('log'),false);assert.deepEqual(f.requestedVersions,[WINDOWS_BROWSER_CANDIDATE.version]);}
});

test('Retirement, cancellation and failed operations cannot continue component repair or advertise success',async()=>{
 let checks=0;
 for(const phase of ['guard','profile','observe','close','archive','repair','fence','version'])for(const kind of ['retire','cancel','fail','configuration']){
  const f=fixture();f.hooks.at=async(current)=>{if(current!==phase)return;if(kind==='retire')f.sessions.set('fixture',{id:'new',state:'active'});else if(kind==='cancel')f.control.abort();else if(kind==='configuration')f.environment.name='Changed configuration';else throw Error('Synthetic '+phase+' failure');};
  await assert.rejects(f.repair());assert.equal(f.calls.includes('log'),false);if(['guard','profile','observe','close','archive'].includes(phase))assert.equal(f.calls.includes('repair'),false);checks++;
 }
 console.log(JSON.stringify({diagnostic:'windows-browser-repair-session',checks,actualCoordinator:true,transportAdapter:true,realVm:false}));
});

test('Unverified publication, remaining intent and malformed receipts cannot report completed recovery',async()=>{
 for(const patch of [{reply:'{}'},{reply:JSON.stringify({state:'none'})},{reply:JSON.stringify({...repaired,path:'/outside'})},{fence:'pending'},{fence:'diagnostic\nnone'},{version:JSON.stringify({version:1,state:'missing',issue:'missing',recordedVersion:null})}]){const f=fixture();Object.assign(f.hooks,patch);await assert.rejects(f.repair());assert.equal(f.calls.includes('log'),false);}
 assert.deepEqual(parseWindowsBrowserRepairResult('MU_WINDOWS_BROWSER_REPAIR archive-ready\n'+JSON.stringify(repaired),true),repaired);
 assert.throws(()=>parseWindowsBrowserRepairResult('unexpected\n'+JSON.stringify(repaired),true));assert.throws(()=>parseWindowsBrowserRepairResult(('MU_WINDOWS_BROWSER_REPAIR archive-ready\n').repeat(33)+JSON.stringify(repaired),true));assert.equal(windowsBrowserRepairState('pending\n'),'pending');assert.throws(()=>windowsBrowserRepairState(''));
});

test('A pending component repair fences ordinary opening before executable validation even while recovery is disabled',async()=>{
 const f=fixture(false),commands:string[][]=[];const browser=new WindowsBrowser(f.manager,{management:async(_config,command)=>{commands.push(command);return 'pending';},serviceStreamFactory:async()=>{throw Error('No real browser stream');}});
 try{await assert.rejects(browser.open('fixture'),{code:'BROWSER_REPAIR_PENDING'});assert.equal(commands.length,1);assert.ok(commands[0].includes(WINDOWS_BROWSER_REPAIR_STATE_PYTHON));assert.equal(browser.running('fixture'),false);}finally{browser.dispose();}
});

test('Enabled opening resumes the original pending transaction before ordinary desktop verification',async()=>{
 const f=fixture(),commands:string[][]=[];let reads=0;const runtime={management:async(config:any,command:string[],options:any)=>{commands.push(command);if(command.includes(WINDOWS_BROWSER_SELECTION_INSPECT))return JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version});if(command.includes(WINDOWS_BROWSER_REPAIR_STATE_PYTHON))return ++reads===1?'pending':'none';if(options?.input===VERIFY_WINDOWS_DESKTOP)throw Error('Fixture stops before display');return f.runtime.management(config,command,options);},serviceStreamFactory:async()=>{throw Error('No real browser stream');}};
 const recovery=new WindowsBrowserComponentRecovery(f.manager,runtime,async()=>{throw Error('Resume must not recursively close its own opening');},async()=>Buffer.from('synthetic archive'),true),browser=new WindowsBrowser(f.manager,runtime,false,recovery);
 try{await assert.rejects(browser.open('fixture',{signal:f.control.signal}),/Fixture stops before display/);assert.ok(commands[0].includes(WINDOWS_BROWSER_REPAIR_STATE_PYTHON));assert.equal(commands[1].at(-1),'-');assert.ok(commands[2].includes(WINDOWS_BROWSER_REPAIR_BOOTSTRAP));assert.equal(reads,2);assert.equal(browser.running('fixture'),false);}finally{browser.dispose();}
});

test('Component recovery HTTP authenticates exact scope, keeps production disabled and tracks a real manager job',{skip:process.platform!=='win32'},async()=>{
 for(const enabled of [false,true]){
  const root=await mkdtemp(path.join(tmpdir(),'mu-windows-repair-api-'));let service:Awaited<ReturnType<typeof createWindowsService>>|undefined;
  try{await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');let state='Off',lease=false,assetReads=0;const writes:string[]=[];const inspect=async()=>({digest:'a'.repeat(64),leaseActive:lease,remainingMs:lease?40000:0});
   const runtime={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state}),stop:async()=>{state='Off';lease=false;},create:async(c:{id:string})=>{const p=windowsPaths(path.join(root,'runtime'),c.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,'{}');},start:async()=>{state='Running';},connect:async()=>{},inspectGuard:inspect,session:async()=>new WindowsNetworkSession({inspect,probe:async()=>[{receiver:'fixture-a',ip:'203.0.113.10'},{receiver:'fixture-b',ip:'203.0.113.10'}],activate:async()=>{lease=true;},renew:async()=>{},revoke:async()=>{lease=false;},disconnect:async()=>{},stop:async()=>{state='Off';lease=false;}},'203.0.113.10'),management:async(_c:unknown,command:string[],options?:{input?:string})=>{if(options?.input===WINDOWS_BROWSER_REPAIR_OBSERVATION)return JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version,pending:null});if(command.includes(WINDOWS_BROWSER_REPAIR_BOOTSTRAP)){writes.push('repair');return JSON.stringify(repaired);}if(command.includes(WINDOWS_BROWSER_REPAIR_STATE_PYTHON))return 'none';assert.ok(command.includes(WINDOWS_BROWSER_VERSION_SCRIPT));return JSON.stringify(verified);},serviceStreamFactory:async()=>{throw Error('No actual browser stream');}};
   service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'runtime'),runtime,enableBrowserRepairPreview:enabled,browserRepairArchive:async()=>{assetReads++;return Buffer.from('synthetic approved archive');},base:{image:path.join(root,'base.vhdx'),imageSha256:'b'.repeat(64)}});
   const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),bootstrap=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]);assert.equal(bootstrap.capabilities.browserRepair,enabled);
   const environment=await service.manager.create({name:'合成组件确认目标',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}}),url=service.url+'/api/environments/'+environment.id+'/browser/component-repair',headers={Cookie:cookie,Authorization:'Bearer '+bootstrap.token,'Content-Type':'application/json'},body=JSON.stringify({confirm:'repair-approved-browser-component',environmentName:environment.name});
   assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body})).status,403);
   for(const input of [{},{confirm:'repair-approved-browser-component'},{confirm:'erase-browser-profile',environmentName:environment.name},{confirm:'repair-approved-browser-component',environmentName:environment.name,path:'/outside'}])assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).status,400);
   if(!enabled){const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,409);assert.equal((await response.json() as {code:string}).code,'BROWSER_REPAIR_UNAVAILABLE');assert.equal(assetReads,0);assert.equal(writes.length,0);assert.equal(service.manager.store.jobs().length,0);continue;}
   await service.manager.wait((await service.manager.action(environment.id,'start')).id);const wrong=await fetch(url,{method:'POST',headers,body:JSON.stringify({confirm:'repair-approved-browser-component',environmentName:'错误环境'})});const wrongJob=await wrong.json() as {id:string};await service.manager.wait(wrongJob.id);assert.equal(service.manager.store.jobs().find(job=>job.id===wrongJob.id)?.status,'failed');assert.equal(writes.length,0);
   const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,202);const accepted=await response.json() as {id:string};await service.manager.wait(accepted.id);assert.equal(service.manager.store.jobs().find(job=>job.id===accepted.id)?.status,'succeeded');assert.equal(assetReads,1);assert.equal(writes.length,1);assert.equal(state,'Running');assert.equal(service.manager.store.get(environment.id).name,environment.name);
  }finally{await service?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
 }
 console.log(JSON.stringify({diagnostic:'windows-browser-repair-api',actualHttp:true,actualDpapi:true,actualSqlite:true,actualManagerJobs:true,guestTransportAdapter:true,realVm:false}));
});
