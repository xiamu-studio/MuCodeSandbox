import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WindowsDisplayLifecycle,type WindowsDisplayManagerPort} from '../server/platform/windows/display-lifecycle.ts';
import {WindowsFileDisplay,windowsFileDisplayStopProgram,type WindowsFileDisplayDriver} from '../server/platform/windows/file-display.ts';
import type {Environment} from '../shared/types.ts';
import type {WindowsConfig} from '../server/platform/windows/config.ts';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWindowsService,type WindowsServiceOptions} from '../server/platform/windows/service.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';
import {GuestExchange,FILE_EXCHANGE_PYTHON} from '../server/guest-exchange.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'File viewer checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(){
 const id=randomUUID(),environment={id,state:'running'} as Environment,sessions=new Map([[id,{id:'original-session',state:'active' as 'active'|'failed'}]]),events:string[]=[],units:string[]=[];
 const hooks:{prepare?:()=>Promise<void>;open?:()=>Promise<void>;stop?:()=>Promise<void>;access?:()=>Promise<void>}={};
 const manager:WindowsDisplayManagerPort&{failProtection(id:string,reason:string):Promise<void>}={sessions,store:{get:()=>environment},assertAccess:async()=>{await hooks.access?.();return environment;},profile:async()=>({} as WindowsConfig),failProtection:async()=>{events.push('quarantine');sessions.delete(id);display.revoke(id);views.revoke(id);}};
 const display=new WindowsDisplayLifecycle(manager,{verify:async()=>{},start:async()=>{events.push('display-start');},channel:async()=>()=>new PassThrough(),resize:async stream=>{stream.destroy();},check:async()=>{},stop:async()=>{events.push('display-stop');}});
 const driver:WindowsFileDisplayDriver={prepare:async(_entry,options)=>{events.push('prepare');await hooks.prepare?.();options.assertCurrent();},open:async(_id,input,unit,options)=>{events.push('file-open');units.push(unit);await hooks.open?.();options.assertCurrent();return {ok:true,path:'/home/dev/Downloads'+(input.path?'/'+input.path:'')};},stop:async(_entry,unit)=>{events.push('file-stop');units.push(unit);await hooks.stop?.();}};
 const views=new WindowsFileDisplay(manager,display,driver);return {id,environment,sessions,events,units,hooks,manager,display,views,dispose:()=>{views.dispose();display.dispose();}};
}

test('Independent file view starts without Chrome and closes its own unit before the last display lease',async()=>{
 const f=fixture();try{
  const view=await f.views.open(f.id,{zone:'downloads'});assert.equal(view.path,'/home/dev/Downloads');assert.equal(f.views.info(f.id).ready,true);assert.deepEqual(f.display.info(f.id).owners,['files']);
  assert.match(f.units[0],/^mucodesandbox-file-manager-[0-9a-f-]{36}$/);await f.views.close(f.id,view.viewId);
  assert.equal(f.units[0],f.units[1]);assert.ok(f.events.indexOf('file-stop')<f.events.indexOf('display-stop'));assert.equal(f.display.info(f.id).ready,false);
 }finally{f.dispose();}
});
test('Closing files retains a browser owner, authenticated viewer streams and display tickets',async()=>{
 const f=fixture();try{
  const browser=await f.display.acquire(f.id,'browser'),entry=f.display.readyEntry(f.id)!,stream=entry.vnc!(),ticket=f.display.transport.issue(f.id).ticket;
  const view=await f.views.open(f.id,{zone:'incoming',path:'合成资料'});await f.views.close(f.id,view.viewId);
  assert.equal(stream.destroyed,false);assert.equal(f.display.transport.tickets.has(ticket),true);assert.deepEqual(f.display.info(f.id).owners,['browser']);assert.equal(f.events.includes('display-stop'),false);
  await f.display.release(browser);assert.equal(stream.destroyed,true);
 }finally{f.dispose();}
});
test('Replacement file open waits for its previous unit stop and an old close capability cannot cancel the replacement',async()=>{
 const f=fixture(),gate=deferred();try{
  const first=await f.views.open(f.id,{zone:'downloads'});f.hooks.stop=()=>gate.promise;
  const second=f.views.open(f.id,{zone:'downloads',path:'next'});await until(()=>f.events.includes('file-stop'));
  assert.equal(f.events.filter(e=>e==='file-open').length,1);const oldClose=f.views.close(f.id,first.viewId);gate.resolve();await oldClose;const next=await second;
  assert.notEqual(next.viewId,first.viewId);assert.equal(f.views.info(f.id).ready,true);const count=f.events.filter(e=>e==='file-stop').length;
  await f.views.close(f.id,first.viewId);assert.equal(f.events.filter(e=>e==='file-stop').length,count);assert.equal(f.views.info(f.id).viewId,next.viewId);
 }finally{gate.resolve();f.dispose();}
});
test('Cancelling file preparation waits for cleanup and does not run a file manager afterward',async()=>{
 const f=fixture(),gate=deferred(),cancel=new AbortController();try{
  f.hooks.prepare=()=>gate.promise;const opening=f.views.open(f.id,{zone:'downloads'},{signal:cancel.signal}).catch(error=>error);await until(()=>f.events.includes('prepare'));
  cancel.abort();gate.resolve();assert.equal((await opening as Error).name,'AbortError');assert.equal(f.events.includes('file-open'),false);assert.equal(f.events.includes('file-stop'),false);assert.equal(f.events.filter(e=>e==='display-stop').length,1);
 }finally{gate.resolve();f.dispose();}
});
test('Partial file launch failure stops only its recorded unit and retains an unrelated browser owner',async()=>{
 const f=fixture();try{
  await f.display.acquire(f.id,'browser');f.hooks.open=async()=>{throw Error('Synthetic launch acknowledgement lost');};
  await assert.rejects(f.views.open(f.id,{zone:'downloads'}),/Synthetic launch acknowledgement lost/);assert.equal(f.units.length,2);assert.equal(f.units[0],f.units[1]);assert.deepEqual(f.display.info(f.id).owners,['browser']);
 }finally{f.dispose();}
});
test('Unconfirmed file stop quarantines the current environment and every concurrent close sees failure',async()=>{
 const f=fixture(),gate=deferred();try{
  const view=await f.views.open(f.id,{zone:'downloads'});f.hooks.stop=async()=>{await gate.promise;throw Error('Synthetic stop acknowledgement lost');};
  const first=f.views.close(f.id,view.viewId).catch(error=>error),second=f.views.close(f.id,view.viewId).catch(error=>error);await until(()=>f.events.includes('file-stop'));gate.resolve();
  for(const error of await Promise.all([first,second]))assert.equal(error.code,'FILE_DISPLAY_STOP_UNCONFIRMED');assert.equal(f.events.filter(e=>e==='file-stop').length,1);assert.equal(f.sessions.size,0);assert.equal(f.display.info(f.id).ready,false);
 }finally{gate.resolve();f.dispose();}
});
test('A same-text replacement session never receives old file stop commands or stale launch completion',async()=>{
 const f=fixture(),gate=deferred();try{
  f.hooks.open=()=>gate.promise;const opening=f.views.open(f.id,{zone:'downloads'}).catch(error=>error);await until(()=>f.events.includes('file-open'));
  f.sessions.set(f.id,{id:'original-session',state:'active'});const replacement=await f.display.acquire(f.id,'browser');gate.resolve();assert.equal((await opening as Error).name,'AbortError');
  assert.equal(f.events.includes('file-stop'),false);assert.equal(f.events.includes('quarantine'),false);assert.deepEqual(f.display.info(f.id).owners,['browser']);await f.display.release(replacement);
 }finally{gate.resolve();f.dispose();}
});
test('Invalid requests, forged close tokens and duplicate pending openings cannot acquire unintended authority',async()=>{
 const f=fixture(),gate=deferred();try{
  assert.throws(()=>f.views.open(f.id,{zone:'downloads',path:'../foreign'}));assert.throws(()=>f.views.open(f.id,{zone:'downloads',hostPath:'C:/private'}));assert.equal(f.events.length,0);
  f.hooks.prepare=()=>gate.promise;const opening=f.views.open(f.id,{zone:'downloads'});await until(()=>f.events.includes('prepare'));
  assert.throws(()=>f.views.open(f.id,{zone:'downloads'}),{code:'FILE_DISPLAY_BUSY'});await f.views.close(f.id,randomUUID());gate.resolve();const view=await opening;assert.equal(f.views.info(f.id).ready,true);await f.views.close(f.id,view.viewId);
 }finally{gate.resolve();f.dispose();}
});
test('Closing a known preparing view waits for its original operation before cleanup',async()=>{
 const f=fixture(),gate=deferred();try{
  f.hooks.prepare=()=>gate.promise;const opening=f.views.open(f.id,{zone:'downloads'}).catch(error=>error);await until(()=>f.events.includes('prepare'));
  const closing=f.views.close(f.id,f.views.info(f.id).viewId!);gate.resolve();await closing;assert.ok(await opening instanceof Error);assert.equal(f.events.includes('file-open'),false);assert.equal(f.display.info(f.id).ready,false);
 }finally{gate.resolve();f.dispose();}
});
test('Disposal prevents a late file launch and cannot become a new open operation',async()=>{
 const f=fixture(),gate=deferred();try{
  f.hooks.prepare=()=>gate.promise;const opening=f.views.open(f.id,{zone:'downloads'}).catch(error=>error);await until(()=>f.events.includes('prepare'));f.dispose();gate.resolve();assert.ok(await opening instanceof Error);assert.equal(f.events.includes('file-open'),false);assert.throws(()=>f.views.open(f.id,{zone:'downloads'}),{code:'CLOSING'});
 }finally{gate.resolve();f.dispose();}
});

const run=promisify(execFile),unit='mucodesandbox-file-manager-'+randomUUID();
const props=(change:Record<string,string>={})=>Object.entries({LoadState:'loaded',ActiveState:'inactive',MainPID:'0',User:'dev',Group:'dev',BindsTo:'mucodesandbox-display.service',...change}).map(([key,value])=>key+'='+value).join('\n')+'\n';
const wrapper=`import json,subprocess,sys
from unittest.mock import patch
p=json.loads(sys.argv[1]);calls=[];index=0
def invoke(command,**options):
 global index
 calls.append(command)
 assert command[0]=='systemctl' and command[2]==p['unit']
 assert options['stdin']==subprocess.DEVNULL and options['stderr']==subprocess.DEVNULL
 if command[1]=='show':
  assert options['timeout']==5 and options['stdout']==subprocess.PIPE
  assert command[3:]==['--no-pager']+['--property='+key for key in ['LoadState','ActiveState','MainPID','User','Group','BindsTo']]
  value=p['before'] if index==0 else p['after'];index+=1
  return subprocess.CompletedProcess(command,p.get('code',0),value.encode('ascii'))
 assert command==['systemctl','stop',p['unit']] and options['check'] and options['timeout']==20
 if p.get('stopFail'):raise subprocess.CalledProcessError(1,command)
 return subprocess.CompletedProcess(command,0)
with patch('subprocess.run',invoke):exec(compile(p['program'],'file-stop-production','exec'),{})
assert len(calls)==p['calls']
`;
for(const [name,change,accepted] of [
 ['owned unit',{before:props({ActiveState:'active',MainPID:'123'})},true],
 ['already stopped',{},true],
 ['collected unit',{before:props({LoadState:'not-found',User:'',Group:'',BindsTo:''}),after:props({LoadState:'not-found',User:'',Group:'',BindsTo:''}),code:1,calls:2},true],
 ['wrong user',{before:props({User:'root'})},false],
 ['wrong group',{before:props({Group:'root'})},false],
 ['unbound service',{before:props({BindsTo:''})},false],
 ['missing property',{before:'LoadState=loaded\n'},false],
 ['duplicate property',{before:props()+'MainPID=0\n'},false],
 ['unknown property',{before:props()+'Private=do-not-echo\n'},false],
 ['still active',{after:props({ActiveState:'active'})},false],
 ['remaining PID',{after:props({MainPID:'123'})},false],
 ['missing but active',{before:props({LoadState:'not-found',ActiveState:'active'})},false],
 ['stop command failed',{stopFail:true},false],
 ['inspection failed',{code:1},false],
] as const)test('File stop program with explicit systemctl adapters: '+name,async()=>{
 const payload=Object.assign({unit,program:windowsFileDisplayStopProgram(unit),before:props(),after:props(),calls:3},change);
 const task=run(process.platform==='win32'?'python':'python3',['-I','-c',wrapper,JSON.stringify(payload)],{timeout:10000,maxBuffer:8192,windowsHide:true});
 if(!accepted){await assert.rejects(task);return;}assert.deepEqual(JSON.parse((await task).stdout),{version:1,state:'stopped'});
});
test('File stop code never accepts an arbitrary service name or shell input',()=>{for(const name of ['sshd.service',unit+'.service;id','mucodesandbox-file-manager-../foreign','$(id)'])assert.throws(()=>windowsFileDisplayStopProgram(name),{code:'FILE_DISPLAY_INVALID'});});

test('Shared folder launcher captures its validated unit before awaiting the folder path',async()=>{
 const original='mucodesandbox-file-manager-'+randomUUID(),commands:string[][]=[];let reads=0;
 const exchange={operation:async(_id:string,work:(e:Environment)=>unknown)=>work({} as Environment),files:async()=>({path:'/home/dev/Downloads'}),runtime:{management:async(_e:Environment,args:string[])=>{commands.push(args);return '';}}};
 const ownership={get unit(){reads++;return reads===1?original:'sshd.service';}};
 await GuestExchange.prototype.openFolder.call(exchange as never,'synthetic',{zone:'downloads'},ownership);
 assert.equal(reads,1);assert.ok(commands[1].includes('--unit='+original));assert.ok(!commands.some(command=>command.join(' ').includes('sshd')));
});

test('Actual shared service opens and closes an owned guest folder without Chrome, checks HTTP authority and cancels disconnected launch',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-file-display-service-'));let service:Awaited<ReturnType<typeof createWindowsService>>|undefined,lease=false,displayStops=0,hold=false,entered=false,stopChecks=0;const units:string[]=[],commands:string[][]=[];
 const inspect=async()=>({digest:'a'.repeat(64),leaseActive:lease,remainingMs:lease?40000:0}),guard={inspect,probe:async()=>[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}],activate:async()=>{lease=true;},renew:async()=>{},revoke:async()=>{lease=false;},disconnect:async()=>{},stop:async()=>{lease=false;}};
 const runtime:NonNullable<WindowsServiceOptions['runtime']>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:'Off'}),stop:guard.stop,create:async()=>{},start:async()=>{},connect:async()=>{},session:async()=>new WindowsNetworkSession(guard,'203.0.113.10'),inspectGuard:inspect,serviceStreamFactory:async()=>()=>new PassThrough(),
  management:async(_config,args,options={})=>{commands.push(args);const transient=args.find(arg=>arg.startsWith('--unit='));if(transient){units.push(transient.slice(7));if(hold){entered=true;await new Promise<void>((_resolve,reject)=>{if(options.signal?.aborted)reject(options.signal.reason);else options.signal?.addEventListener('abort',()=>reject(options.signal!.reason),{once:true});});}}if(args.at(-1)?.includes("keys=['LoadState'")){stopChecks++;assert.ok(units.some(unit=>args.at(-1)!.includes(JSON.stringify(unit))));assert.deepEqual(args.slice(0,6),['sudo','-n','/usr/bin/python3','-I','-c',args.at(-1)]);return '{"version":1,"state":"stopped"}';}return '';},
  guest:async(_config,_args,options={})=>{const [program,input]=options.input!.split('\n');assert.equal(JSON.parse(program),FILE_EXCHANGE_PYTHON);assert.deepEqual(JSON.parse(input),{action:'folder',zone:'downloads',path:'资料'});return '{"path":"/home/dev/Downloads/资料"}';}};
 try{
  await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'vms'),runtime,enableSharedDisplayPreview:true,displayDriver:{verify:async()=>{},start:async()=>{},channel:async()=>()=>new PassThrough(),resize:async stream=>{stream.destroy();},check:async()=>{},stop:async()=>{displayStops++;}}});
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),boot=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]),headers={Cookie:cookie,Authorization:'Bearer '+boot.token,'Content-Type':'application/json'};assert.equal(boot.capabilities.independentFileView,true);
  const e=await service.manager.create({name:'Independent file API fixture',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});service.manager.store.state(e.id,'running');const network=new WindowsNetworkSession(guard,'203.0.113.10');await network.open();service.manager.sessions.set(e.id,network);
  const base=service.url+'/api/environments/'+e.id,body=JSON.stringify({zone:'downloads',path:'资料'}),send=()=>fetch(base+'/transfer-folder/open',{method:'POST',headers,body});
  assert.equal((await fetch(base+'/transfer-folder/open',{method:'POST',body})).status,401);assert.equal((await fetch(base+'/transfer-folder/open',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body})).status,403);
  assert.equal((await fetch(base+'/transfer-folder/open',{method:'POST',headers,body:'{"zone":"downloads","hostPath":"C:/private"}'})).status,400);assert.equal(units.length,0);
  const browserLease=await service.display!.acquire(e.id,'browser'),response=await send();assert.equal(response.status,200);const opened=await response.json();assert.equal(opened.path,'/home/dev/Downloads/资料');assert.match(opened.viewId,/^[0-9a-f-]{36}$/);assert.equal(service.browser!.entries.size,0);assert.equal(units.length,1);
  for(const property of ['--property=User=dev','--property=Group=dev','--property=BindsTo=mucodesandbox-display.service'])assert.ok(commands.find(command=>command.includes('--unit='+units[0]))!.includes(property));
  assert.equal((await fetch(base+'/transfer-folder/close',{method:'POST',headers,body:JSON.stringify({viewId:randomUUID()})})).status,200);assert.equal(stopChecks,0);
  assert.equal((await fetch(base+'/transfer-folder/close',{method:'POST',headers,body:JSON.stringify({viewId:opened.viewId})})).status,200);assert.equal(stopChecks,1);assert.equal(displayStops,0);assert.deepEqual(service.display!.info(e.id).owners,['browser']);
  hold=true;const cancel=new AbortController(),opening=fetch(base+'/transfer-folder/open',{method:'POST',headers,body,signal:cancel.signal});await until(()=>entered);cancel.abort();await assert.rejects(opening);
  await until(()=>stopChecks===2&&!service!.exchange!.busy.has(e.id));assert.equal(service.fileViews!.info(e.id).ready,false);assert.deepEqual(service.display!.info(e.id).owners,['browser']);await service.display!.release(browserLease);assert.equal(displayStops,1);
 }finally{await service?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
