import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import type {WindowsConfig} from '../server/platform/windows/config.ts';
import {WindowsDisplayLifecycle,type WindowsDisplayManagerPort} from '../server/platform/windows/display-lifecycle.ts';
import {WindowsDesktopClients,type WindowsDesktopClientDriver} from '../server/platform/windows/desktop-clients.ts';
import type {WindowsDesktopClientSpec} from '../server/platform/windows/desktop-client-guest.ts';
const boot='12345678-1234-4234-8234-123456789abc';
function gate(){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});return {wait,release};}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'Client lifecycle checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(){
 const id=randomUUID(),environment={...environmentSchema.parse({name:'客户端生命周期合成验收',network:{mode:'http',host:'127.0.0.1',port:7897,strict:true,transparent:true}}),id,instanceName:'mu-client-synthetic',state:'running',browserRunning:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastError:null} as Environment;
 const session={id:'same-session-text',state:'active' as 'active'|'failed'},sessions=new Map([[id,session]]),events:string[]=[],roots=new Map<string,{cancelled:boolean;running:boolean}>();let failures=0,clock=0;
 const hooks:{focus?:(spec:WindowsDesktopClientSpec,signal?:AbortSignal)=>Promise<boolean>;reserve?:(spec:WindowsDesktopClientSpec)=>Promise<void>;launch?:(spec:WindowsDesktopClientSpec)=>Promise<void>;cancel?:(spec:WindowsDesktopClientSpec)=>Promise<void>;inspect?:(spec:WindowsDesktopClientSpec)=>Promise<unknown>;access?:()=>Promise<void>;displayStop?:()=>Promise<void>;failProtection?:()=>Promise<void>}={};
 let clients:WindowsDesktopClients;
 const manager:WindowsDisplayManagerPort&{failProtection(id:string,reason:string):Promise<void>}={sessions,store:{get:()=>environment},assertAccess:async()=>{await hooks.access?.();return environment;},profile:async()=>({id} as WindowsConfig),failProtection:async()=>{failures++;await hooks.failProtection?.();sessions.delete(id);environment.state='error';clients.revoke(id);display.revoke(id);}};
 const display=new WindowsDisplayLifecycle(manager,{verify:async()=>{},start:async()=>{events.push('display-start');},channel:async()=>()=>new PassThrough(),resize:async stream=>{stream.destroy();},check:async()=>{},stop:async()=>{events.push('display-stop');await hooks.displayStop?.();}});
 const control=(spec:WindowsDesktopClientSpec,phase:'reserved'|'started'|'cancelled')=>({version:1 as const,application:spec.application,token:spec.token,unit:spec.unit,bootId:boot,phase});
 const root=(spec:WindowsDesktopClientSpec)=>{let value=roots.get(spec.token);if(!value){value={cancelled:false,running:false};roots.set(spec.token,value);}return value;};
 const driver:WindowsDesktopClientDriver={focus:async(_c,spec,bootId,options={})=>{events.push('focus:'+spec.token);const focused=await hooks.focus?.(spec,options.signal);return {version:1,application:spec.application,token:spec.token,unit:spec.unit,bootId,focused:focused??true};},reserve:async(_config,spec)=>{events.push('reserve:'+spec.token);await hooks.reserve?.(spec);return control(spec,root(spec).cancelled?'cancelled':'reserved');},launch:async(_config,spec)=>{events.push('launch:'+spec.token);await hooks.launch?.(spec);const value=root(spec);if(!value.cancelled)value.running=true;return control(spec,value.cancelled?'cancelled':'started');},cancel:async(_config,spec)=>{events.push('cancel:'+spec.token);await hooks.cancel?.(spec);Object.assign(root(spec),{cancelled:true,running:false});return control(spec,'cancelled');},inspect:async(_config,spec)=>{events.push('inspect:'+spec.token);if(hooks.inspect)return await hooks.inspect(spec) as never;const running=root(spec).running;return {version:1,application:spec.application,token:spec.token,unit:spec.unit,state:running?'running':'stopped',pid:running?2222:0,renderers:running?1:0,rendererProtected:running?true:null};}};
 clients=new WindowsDesktopClients(manager,display,driver,{startupTimeoutMs:100,pollMs:10,now:()=>clock,wait:async()=>{clock+=10;}});
 return {id,environment,sessions,session,hooks,events,roots,manager,display,driver,clients,failures:()=>failures,advance:(ms:number)=>{clock+=ms;},dispose:()=>{clients.dispose();display.dispose();}};
}

test('Window focus joins duplicate views, serializes applications on one display and preserves an explicit false',async()=>{
 const f=fixture(),held=gate();try{
  const a=await f.clients.start(f.id,'grok-bot'),b=await f.clients.start(f.id,'claude-desktop');
  f.hooks.focus=async spec=>{if(spec.application==='grok-bot')await held.wait;return spec.application==='grok-bot';};
  const first=f.clients.focusView(f.id,'grok-bot',a.viewId);await until(()=>f.events.includes('focus:'+a.viewId));
  const duplicate=f.clients.focusView(f.id,'grok-bot',a.viewId),second=f.clients.focusView(f.id,'claude-desktop',b.viewId);await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.events.filter(v=>v.startsWith('focus:')).length,1);held.release();assert.deepEqual(await first,{focused:true});assert.deepEqual(await duplicate,{focused:true});assert.deepEqual(await second,{focused:false});
  assert.deepEqual(f.events.filter(v=>v.startsWith('focus:')),['focus:'+a.viewId,'focus:'+b.viewId]);assert.equal(f.failures(),0);assert.ok(f.clients.info(f.id).every(v=>v.ready));
 }finally{held.release();f.dispose();}
});

test('A stale focus token or delayed focus reply cannot acknowledge a replacement client',async()=>{
 const f=fixture(),held=gate();try{
  const a=await f.clients.start(f.id,'grok-bot');await assert.rejects(f.clients.focusView(f.id,'grok-bot',randomUUID()),{code:'DESKTOP_CLIENT_VIEW_CHANGED'});assert.equal(f.events.some(v=>v.startsWith('focus:')),false);
  let signal:AbortSignal|undefined;f.hooks.focus=async(_spec,value)=>{signal=value;await held.wait;return true;};const late=f.clients.focusView(f.id,'grok-bot',a.viewId).catch(error=>error);await until(()=>!!signal);
  await f.clients.stop(f.id,'grok-bot',a.viewId);assert.equal(signal!.aborted,true);const replacement=await f.clients.start(f.id,'grok-bot');held.release();assert.ok(await late instanceof Error);assert.equal(f.clients.info(f.id)[0].viewId,replacement.viewId);
  f.hooks.focus=undefined;assert.deepEqual(await f.clients.focusView(f.id,'grok-bot',replacement.viewId),{focused:true});assert.equal(f.failures(),0);
 }finally{held.release();f.dispose();}
});

test('Closing a queued focus target refuses it before guest focus dispatch and keeps another client alive',async()=>{
 const f=fixture(),held=gate();try{
  const a=await f.clients.start(f.id,'grok-bot'),b=await f.clients.start(f.id,'claude-desktop');f.hooks.focus=async()=>{await held.wait;return true;};
  const first=f.clients.focusView(f.id,'grok-bot',a.viewId);await until(()=>f.events.includes('focus:'+a.viewId));const queued=f.clients.focusView(f.id,'claude-desktop',b.viewId).catch(error=>error);await new Promise(resolve=>setTimeout(resolve,20));
  await f.clients.stop(f.id,'claude-desktop',b.viewId);held.release();assert.deepEqual(await first,{focused:true});assert.ok(await queued instanceof Error);assert.equal(f.events.includes('focus:'+b.viewId),false);assert.equal(f.clients.info(f.id)[0].viewId,a.viewId);assert.equal(f.failures(),0);
 }finally{held.release();f.dispose();}
});

test('Two clients own independent leases; browser close and stale client close cannot stop the remaining client',async()=>{
 const f=fixture();try{
  const browser=await f.display.acquire(f.id,'browser'),a=await f.clients.start(f.id,'grok-bot'),b=await f.clients.start(f.id,'claude-desktop');assert.equal(f.events.filter(e=>e==='display-start').length,1);
  await f.display.release(browser);assert.equal(f.events.includes('display-stop'),false);assert.ok(f.clients.info(f.id).every(v=>v.ready));
  const again=await f.clients.start(f.id,'grok-bot');assert.equal(again.viewId,a.viewId);assert.equal(f.events.filter(e=>e.startsWith('launch:')).length,2);
  await f.clients.stop(f.id,'grok-bot',a.viewId);assert.equal(f.clients.info(f.id).find(v=>v.application==='claude-desktop')?.ready,true);assert.equal(f.events.includes('display-stop'),false);
  const replacement=await f.clients.start(f.id,'grok-bot');await f.clients.stop(f.id,'grok-bot',a.viewId);assert.equal(f.clients.info(f.id).find(v=>v.application==='grok-bot')?.viewId,replacement.viewId);
  await f.clients.stop(f.id,'claude-desktop',b.viewId);await f.clients.stop(f.id,'grok-bot',replacement.viewId);assert.equal(f.events.filter(e=>e==='display-stop').length,1);assert.equal(f.failures(),0);
 }finally{f.dispose();}
});
test('Startup stays unavailable until a protected renderer exists, with a bounded readiness wait',async()=>{
 const f=fixture();let reads=0;try{
  f.hooks.inspect=async spec=>{reads++;assert.equal(f.clients.info(f.id)[0].ready,false);return {version:1,application:spec.application,token:spec.token,unit:spec.unit,state:reads===1?'starting':'running',pid:2222,renderers:reads===1?0:1,rendererProtected:reads!==1};};
  await f.clients.start(f.id,'grok-bot');assert.equal(reads,2);assert.equal(f.clients.info(f.id)[0].ready,true);
 }finally{f.dispose();}
});
test('Missing renderers time out, cancel the exact root token and release the display without claiming success',async()=>{
 const f=fixture();try{
  f.hooks.inspect=async spec=>({version:1,application:spec.application,token:spec.token,unit:spec.unit,state:'starting',pid:2222,renderers:0,rendererProtected:false});
  await assert.rejects(f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_NOT_READY'});assert.equal(f.clients.info(f.id).length,0);assert.equal(f.events.filter(e=>e.startsWith('cancel:')).length,1);assert.equal(f.events.filter(e=>e==='display-stop').length,1);assert.equal(f.failures(),0);
 }finally{f.dispose();}
});
test('Cancellation fences a delayed reservation before releasing its lease; late replies cannot retire a replacement',async()=>{
 const f=fixture(),held=gate();try{
  f.hooks.reserve=async()=>held.wait;const old=f.clients.start(f.id,'grok-bot').catch(error=>error);await until(()=>f.events.some(e=>e.startsWith('reserve:')));const oldId=f.clients.info(f.id)[0].viewId;
  await f.clients.stop(f.id,'grok-bot',oldId);assert.equal(f.roots.get(oldId)?.cancelled,true);assert.equal(f.clients.info(f.id).length,0);
  f.hooks.reserve=undefined;const replacement=await f.clients.start(f.id,'grok-bot');held.release();assert.ok(await old instanceof Error);assert.equal(f.clients.info(f.id)[0].viewId,replacement.viewId);assert.equal(f.clients.info(f.id)[0].ready,true);assert.equal(f.roots.get(replacement.viewId)?.cancelled,false);
 }finally{held.release();f.dispose();}
});
test('A delayed launch cannot cross a confirmed cancellation fence',async()=>{
 const f=fixture(),held=gate();try{
  f.hooks.launch=async()=>held.wait;const opening=f.clients.start(f.id,'grok-bot').catch(error=>error);await until(()=>f.events.some(e=>e.startsWith('launch:')));const token=f.clients.info(f.id)[0].viewId;await f.clients.stop(f.id,'grok-bot',token);held.release();assert.ok(await opening instanceof Error);assert.equal(f.roots.get(token)?.running,false);assert.equal(f.clients.info(f.id).length,0);
 }finally{held.release();f.dispose();}
});
test('Malformed startup receipts are rejected and cleaned without an automatic retry',async()=>{
 const f=fixture();try{f.hooks.inspect=async()=>({});await assert.rejects(f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_RECEIPT'});assert.equal(f.events.filter(e=>e.startsWith('cancel:')).length,1);assert.equal(f.clients.info(f.id).length,0);}finally{f.dispose();}
});
test('Stop failure withdraws access and blocks reopen; an explicit verified close can retry when quarantine itself failed',async()=>{
 const f=fixture();try{
  const view=await f.clients.start(f.id,'grok-bot');f.hooks.cancel=async()=>{throw Error('Synthetic stop missing');};f.hooks.failProtection=async()=>{throw Error('Synthetic quarantine failure');};
  await assert.rejects(f.clients.stop(f.id,'grok-bot',view.viewId),{code:'DESKTOP_CLIENT_STOP_UNCONFIRMED'});assert.equal(f.failures(),1);assert.equal(f.clients.info(f.id)[0].ready,false);assert.throws(()=>f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_STOP_UNCONFIRMED'});
  f.hooks.cancel=undefined;await f.clients.stop(f.id,'grok-bot',view.viewId);assert.equal(f.clients.info(f.id).length,0);assert.equal(f.failures(),1);
 }finally{f.dispose();}
});
test('A display stop failure also blocks reuse until its original lease stop is verified',async()=>{
 const f=fixture();try{
  const view=await f.clients.start(f.id,'grok-bot');f.hooks.displayStop=async()=>{throw Error('Synthetic display survived');};f.hooks.failProtection=async()=>{throw Error('Synthetic quarantine failure');};await assert.rejects(f.clients.stop(f.id,'grok-bot',view.viewId),{code:'DESKTOP_CLIENT_STOP_UNCONFIRMED'});assert.equal(f.failures(),1);f.hooks.displayStop=undefined;await f.clients.stop(f.id,'grok-bot',view.viewId);assert.equal(f.clients.info(f.id).length,0);
 }finally{f.dispose();}
});
test('Replacing the original session object with identical text prevents old cleanup RPCs and old readiness publication',async()=>{
 const f=fixture(),held=gate();try{
  f.hooks.reserve=async()=>held.wait;const old=f.clients.start(f.id,'grok-bot').catch(error=>error);await until(()=>f.events.some(e=>e.startsWith('reserve:')));f.sessions.set(f.id,{...f.session});f.clients.revoke(f.id);f.display.revoke(f.id);await until(()=>f.clients.info(f.id).length===0);assert.equal(f.events.some(e=>e.startsWith('cancel:')),false);
  f.hooks.reserve=undefined;const next=await f.clients.start(f.id,'grok-bot');held.release();assert.ok(await old instanceof Error);assert.equal(f.clients.info(f.id)[0].viewId,next.viewId);assert.equal(f.failures(),0);
 }finally{held.release();f.dispose();}
});
test('Renderer protection loss is latched and requests quarantine instead of retiring monitoring',async()=>{
 const f=fixture();try{await f.clients.start(f.id,'grok-bot');f.hooks.inspect=async spec=>({version:1,application:spec.application,token:spec.token,unit:spec.unit,state:'running',pid:2222,renderers:1,rendererProtected:false});f.hooks.failProtection=async()=>{throw Error('Synthetic independent stop retry needed');};await assert.rejects(f.clients.assertProtection(f.id),{code:'DESKTOP_CLIENT_PROTECTION'});assert.equal(f.failures(),1);await assert.rejects(f.clients.assertProtection(f.id),{code:'DESKTOP_CLIENT_PROTECTION'});assert.throws(()=>f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_PROTECTION'});}finally{f.dispose();}
});
test('A confirmed natural exit releases ownership once and concurrent inspections do not quarantine a normal close',async()=>{
 const f=fixture();try{const view=await f.clients.start(f.id,'grok-bot');f.roots.get(view.viewId)!.running=false;const before=f.events.filter(e=>e.startsWith('inspect:')).length;await Promise.all([f.clients.assertProtection(f.id),f.clients.assertProtection(f.id)]);assert.equal(f.events.filter(e=>e.startsWith('inspect:')).length,before+1);assert.equal(f.clients.info(f.id).length,0);assert.equal(f.failures(),0);}finally{f.dispose();}
});
test('Idempotent start never returns an old ready view after its client naturally exited',async()=>{
 const f=fixture();try{const view=await f.clients.start(f.id,'grok-bot');f.roots.get(view.viewId)!.running=false;await assert.rejects(f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_CHANGED'});assert.equal(f.clients.info(f.id).length,0);assert.equal(f.failures(),0);}finally{f.dispose();}
});
test('An intentional close concurrent with a monitoring reply does not become a protection incident',async()=>{
 const f=fixture(),held=gate();try{const view=await f.clients.start(f.id,'grok-bot');let began=false;f.hooks.inspect=async spec=>{began=true;await held.wait;return {version:1,application:spec.application,token:spec.token,unit:spec.unit,state:'stopped',pid:0,renderers:0,rendererProtected:null};};const monitoring=f.clients.assertProtection(f.id);await until(()=>began);await f.clients.stop(f.id,'grok-bot',view.viewId);held.release();await monitoring;assert.equal(f.failures(),0);}finally{held.release();f.dispose();}
});
test('A late failed inspection cannot quarantine a replacement session or remove its client',async()=>{
 const f=fixture(),held=gate();try{await f.clients.start(f.id,'grok-bot');let began=false;f.hooks.inspect=async()=>{began=true;await held.wait;throw Error('Synthetic old broken receipt');};const old=f.clients.assertProtection(f.id);await until(()=>began);f.sessions.set(f.id,{...f.session});f.clients.revoke(f.id);f.display.revoke(f.id);await until(()=>f.clients.info(f.id).length===0);f.hooks.inspect=undefined;const next=await f.clients.start(f.id,'grok-bot');held.release();await old;assert.equal(f.failures(),0);assert.equal(f.clients.info(f.id)[0].viewId,next.viewId);}finally{held.release();f.dispose();}
});
test('Pre-cancelled starts, invalid close capabilities and disposed owners issue no guest startup',async()=>{
 const f=fixture();try{const abort=new AbortController();abort.abort();assert.throws(()=>f.clients.start(f.id,'grok-bot',{signal:abort.signal}),{name:'AbortError'});await assert.rejects(f.clients.stop(f.id,'grok-bot','not-a-view'),{code:'DESKTOP_CLIENT_VIEW'});f.clients.dispose();assert.throws(()=>f.clients.start(f.id,'grok-bot'),{code:'CLOSING'});assert.equal(f.events.length,0);}finally{f.dispose();}
});
test('Disposal does not publish a late opening or issue cleanup to a later service session',async()=>{
 const f=fixture(),held=gate();try{f.hooks.reserve=async()=>held.wait;const opening=f.clients.start(f.id,'grok-bot').catch(error=>error);await until(()=>f.events.some(e=>e.startsWith('reserve:')));f.dispose();held.release();assert.ok(await opening instanceof Error);assert.equal(f.events.some(e=>e.startsWith('cancel:')),false);assert.equal(f.clients.info(f.id).length,0);}finally{held.release();f.dispose();}
});
test('Close waits for an in-transit display lease so a replacement cannot inherit and lose the old capability',async()=>{
 const f=fixture(),held=gate();let opening:Promise<unknown>|undefined,stopping:Promise<unknown>|undefined;
 try{
  const acquire=f.display.acquire.bind(f.display);let acquired=false;f.display.acquire=async(...args)=>{const lease=await acquire(...args);acquired=true;await held.wait;return lease;};
  opening=f.clients.start(f.id,'grok-bot').catch(error=>error);await until(()=>acquired);let stopped=false;stopping=f.clients.stop(f.id,'grok-bot',f.clients.info(f.id)[0].viewId).then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false,'Close retired an in-transit lease before it could be released');
  assert.throws(()=>f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_BUSY'});held.release();await stopping;assert.ok(await opening instanceof Error);assert.equal(f.display.readyEntry(f.id),undefined);assert.equal(f.events.filter(e=>e==='display-stop').length,1);
 }finally{held.release();await opening;await stopping;f.dispose();}
});
test('Revoking a ready old session retires local ownership without cleanup RPCs against its replacement',async()=>{
 const f=fixture();try{const old=await f.clients.start(f.id,'grok-bot');f.sessions.set(f.id,{...f.session});f.clients.revoke(f.id);f.display.revoke(f.id);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.clients.info(f.id).length,0);assert.equal(f.events.some(e=>e.startsWith('cancel:')),false);const next=await f.clients.start(f.id,'grok-bot');assert.notEqual(next.viewId,old.viewId);}finally{f.dispose();}
});
test('Cancellation at the final ready boundary still fences the creator task and closes its client',async()=>{
 const f=fixture(),abort=new AbortController();try{const view=await f.clients.start(f.id,'grok-bot',{signal:abort.signal});abort.abort();await until(()=>f.clients.info(f.id).length===0);assert.equal(f.roots.get(view.viewId)?.cancelled,true);assert.equal(f.events.filter(e=>e==='display-stop').length,1);}finally{f.dispose();}
});
test('Even a late running receipt cannot exceed the readiness deadline',async()=>{
 const f=fixture();try{f.hooks.inspect=async spec=>{f.advance(101);return {version:1,application:spec.application,token:spec.token,unit:spec.unit,state:'running',pid:2222,renderers:1,rendererProtected:true};};await assert.rejects(f.clients.start(f.id,'grok-bot'),{code:'DESKTOP_CLIENT_NOT_READY'});assert.equal(f.clients.info(f.id).length,0);assert.equal(f.events.filter(e=>e.startsWith('cancel:')).length,1);}finally{f.dispose();}
});
test('Cancelling an idempotent caller cannot cancel the shared protection inspection used by monitoring',async()=>{
 const f=fixture(),held=gate(),abort=new AbortController();try{
  await f.clients.start(f.id,'grok-bot');const before=f.events.filter(e=>e.startsWith('inspect:')).length;let began=false;f.hooks.access=async()=>{began=true;await held.wait;};const caller=f.clients.start(f.id,'grok-bot',{signal:abort.signal}).catch(error=>error);await until(()=>began);const monitoring=f.clients.assertProtection(f.id);abort.abort();held.release();await monitoring;assert.ok(await caller instanceof Error);assert.equal(f.events.filter(e=>e.startsWith('inspect:')).length,before+1);assert.equal(f.failures(),0);
 }finally{held.release();f.dispose();}
});
