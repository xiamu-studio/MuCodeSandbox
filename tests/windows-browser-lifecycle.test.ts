import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {WebSocket} from 'ws';
import {WindowsBrowser,type WindowsBrowserRuntime} from '../server/platform/windows/browser.ts';
import type {WindowsManager} from '../server/platform/windows/manager.ts';
import type {Environment} from '../shared/types.ts';
import {STOP_WINDOWS_DISPLAY,STOP_WINDOWS_DISPLAY_AFTER_CLOSE,STOP_WINDOWS_CHROME} from '../server/platform/windows/browser-guest.ts';
const isDisplayStop=(command:string[])=>command.includes(STOP_WINDOWS_DISPLAY)||command.includes(STOP_WINDOWS_DISPLAY_AFTER_CLOSE);
import {WindowsDisplayLifecycle} from '../server/platform/windows/display-lifecycle.ts';
import {WINDOWS_BROWSER_REPAIR_STATE_PYTHON} from '../server/platform/windows/browser-repair.ts';
import {WINDOWS_BROWSER_PROFILE_INSPECT} from '../server/platform/windows/browser-profile.ts';
import {WINDOWS_CHROME} from '../server/platform/windows/browser-assets.ts';
import {WINDOWS_BROWSER_SELECTION_INSPECT} from '../server/platform/windows/browser-selection.ts';
import {INSPECT_WINDOWS_BROWSER_RESET_SCRIPT,RECOVER_WINDOWS_BROWSER_RESET_SCRIPT} from '../server/platform/windows/browser-reset.ts';
import {INSPECT_GUEST_BROWSER_SANDBOX} from '../server/guest-browser-sandbox.ts';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function until(check:()=>boolean){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,'Fixture did not reach its checkpoint');await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(shared=false,recovery?:{enabled:boolean;resume:()=>Promise<void>},resetEnabled=false){
 const environment={id:'lifecycle',name:'合成生命周期',state:'running',browserUrl:'about:blank',cpus:2,identity:{timezone:'UTC',locale:'en-US'}} as Environment,session={id:'old',state:'active'},sessions=new Map([[environment.id,session]]),events:string[]=[],guest:{command:string[];input?:string;signal?:AbortSignal}[]=[];
 const hooks:{authorize?:(signal?:AbortSignal)=>Promise<void>;profile?:()=>Promise<void>;profileCheck?:()=>Promise<string>;repairCheck?:()=>Promise<string>;selectionCheck?:()=>Promise<string>;management?:(command:string[],input?:string)=>Promise<string>}={};
 const manager={sessions,store:{get:()=>environment,log:()=>{}},assertAccess:async(_id:string,_allowBusy?:boolean,signal?:AbortSignal)=>{events.push('authorize');await hooks.authorize?.(signal);return environment;},profile:async()=>{events.push('profile');await hooks.profile?.();return {};}} as unknown as WindowsManager;
 const runtime={management:async(_config,command,options)=>{if(command.includes(WINDOWS_BROWSER_REPAIR_STATE_PYTHON)){events.push('repair-check');return hooks.repairCheck?hooks.repairCheck():'none';}if(command.includes(WINDOWS_BROWSER_SELECTION_INSPECT)){events.push('selection-check');return hooks.selectionCheck?hooks.selectionCheck():JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version});}if(command.includes(WINDOWS_BROWSER_PROFILE_INSPECT)){events.push('profile-check');assert.deepEqual(command.slice(0,7),['sudo','-H','-u','dev','--','/usr/bin/python3','-I']);return hooks.profileCheck?hooks.profileCheck():JSON.stringify({version:1,state:'absent',selectedVersion:WINDOWS_CHROME.version,recordedVersion:null,issue:null});}guest.push({command,input:options?.input,signal:options?.signal});events.push(isDisplayStop(command)?'guest-stop':'guest-command');return hooks.management?hooks.management(command,options?.input):'';},serviceStreamFactory:async()=>{throw Error('No actual guest stream');}} as WindowsBrowserRuntime;
 const display=shared?new WindowsDisplayLifecycle(manager,{verify:async()=>{},start:async()=>{events.push('shared-start');},channel:async()=>()=>new PassThrough(),resize:async stream=>{stream.destroy();},check:async()=>{},stop:async()=>{events.push('shared-stop');}}):undefined;
 const browser=new WindowsBrowser(manager,runtime,resetEnabled,recovery as never,display);
 manager.failProtection=async()=>{events.push('quarantine');sessions.delete(environment.id);display?.revoke(environment.id);browser.revoke(environment.id);};
 function entry(sessionId=session.id){const socket=Object.assign(new EventEmitter(),{readyState:WebSocket.OPEN as number,terminate(){events.push('transport-stop');socket.readyState=WebSocket.CLOSED;socket.emit('close');}}),stream=new PassThrough();stream.once('close',()=>events.push('stream-close'));const tools={socket,send:async(method:string)=>{events.push(method);if(method==='Browser.close'){socket.readyState=WebSocket.CLOSED;socket.emit('close');}return {};}};return {environment,config:{} as never,sessionId,selectedVersion:WINDOWS_CHROME.version,password:'fixture8',ready:true,closed:false,streams:new Set([stream]),pages:new Map<string,string>(),configuration:new Set<Promise<void>>(),tools:tools as never,fixtureTools:tools};}
 return {environment,session,sessions,events,guest,hooks,browser,display,entry,dispose:()=>{browser.dispose();display?.dispose();}};
}

test('Running browser version and sandbox checks overlap and drain before reporting a selection failure',async()=>{
 const f=fixture(),selection=deferred<string>(),inspection=deferred<string>();let settled=false;
 try{
  f.browser.entries.set(f.environment.id,f.entry());
  f.hooks.selectionCheck=()=>selection.promise;
  f.hooks.management=async(command,input)=>{assert.equal(input,INSPECT_GUEST_BROWSER_SANDBOX);assert.deepEqual(command.slice(0,4),['sudo','/usr/bin/python3','-I','-']);f.events.push('sandbox-inspection');return inspection.promise;};
  const pending=f.browser.assertProtection(f.environment.id).catch(error=>error).finally(()=>{settled=true;});
  await until(()=>f.events.includes('selection-check')&&f.events.includes('sandbox-inspection'));
  selection.resolve('invalid');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);
  inspection.resolve('{}');assert.equal((await pending as {code:string}).code,'BROWSER_SELECTION_RECEIPT');
 }finally{selection.resolve('');inspection.resolve('{}');f.dispose();}
});
test('Repair state and selection reads overlap and both finish before continuation',async()=>{
 const f=fixture(),repair=deferred<string>(),selection=deferred<string>();let settled=false;
 try{f.hooks.repairCheck=()=>repair.promise;f.hooks.selectionCheck=()=>selection.promise;
  const opening=f.browser.open(f.environment.id).catch(error=>error).finally(()=>{settled=true;});
  await until(()=>f.events.includes('repair-check')&&f.events.includes('selection-check'));
  repair.resolve('invalid');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);assert.equal(f.guest.length,0);
  selection.resolve(JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version}));assert.equal((await opening as {code:string}).code,'BROWSER_REPAIR_STATE_INVALID');assert.equal(f.guest.length,0);
 }finally{repair.resolve('');selection.resolve('');f.dispose();}
});
test('Pending repair discards the old selection read and rereads after recovery',async()=>{
 let resumed=false,reads=0;const f=fixture(false,{enabled:true,resume:async()=>{resumed=true;}});
 try{f.hooks.repairCheck=async()=>'pending';f.hooks.selectionCheck=async()=>{reads++;if(reads===1)throw Error('Stale selection during repair');assert.equal(resumed,true);return JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version});};f.hooks.management=async()=>{throw Error('Fixture post-repair boundary');};
  await assert.rejects(f.browser.open(f.environment.id),/Fixture post-repair boundary/);assert.equal(reads,2);assert.equal(resumed,true);
 }finally{f.dispose();}
});

test('Read-only component, reset and profile checks overlap but all finish before continuation',async()=>{
 const f=fixture(),component=deferred<void>(),reset=deferred<void>(),profile=deferred<string>();
 try{
  f.hooks.profileCheck=()=>profile.promise;
  f.hooks.management=async(_command,input)=>{
   if(input?.includes('MU_COMPONENTS')){f.events.push('component-inspection');await component.promise;throw Error('Synthetic component failure');}
   if(input?.includes('MU_WINDOWS_BROWSER_RESET_STATE')){f.events.push('reset-inspection');await reset.promise;return 'none';}
   throw Error('Unexpected later guest operation');
  };
  let settled=false;const opening=f.browser.open(f.environment.id).catch(error=>error).finally(()=>{settled=true;});
  await until(()=>f.events.includes('component-inspection')&&f.events.includes('reset-inspection')&&f.events.includes('profile-check'));
  component.resolve();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);
  reset.resolve();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);
  profile.resolve(JSON.stringify({version:1,state:'absent',selectedVersion:WINDOWS_CHROME.version,recordedVersion:null,issue:null}));assert.match((await opening as Error).message,/Synthetic component failure/);
  assert.equal(f.browser.running(f.environment.id),false);
 }finally{component.resolve();reset.resolve();profile.resolve('');f.dispose();}
});
for(const phase of ['initial','before-mutation'])test('Closing browser aborts its pending '+phase+' authorization without launching guest services',async()=>{
 const f=fixture();let entered=false,checks=0;
 try{
  f.hooks.management=async(_command,input)=>{if(input===INSPECT_WINDOWS_BROWSER_RESET_SCRIPT)return 'none';if(input?.includes('MU_COMPONENTS'))return '';throw Error('Guest mutation must not run');};
  f.hooks.authorize=async signal=>{if(++checks!==(phase==='initial'?1:2))return;assert.ok(signal);entered=true;await new Promise<void>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
  const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>entered);await f.browser.close(f.environment.id);
  assert.ok(await opening instanceof Error);assert.equal(f.browser.entries.size,0);assert.equal(f.sessions.get(f.environment.id),f.session);assert.equal(f.events.includes('quarantine'),false);
  assert.equal(f.guest.some(value=>value.input!==INSPECT_WINDOWS_BROWSER_RESET_SCRIPT&&!value.input?.includes('MU_COMPONENTS')),false);
 }finally{f.dispose();}
});

for(const denied of [false,true])test('Read-only browser admission '+(denied?'refuses mutation on denied protection':'reaches its first mutation after one final guard'),async()=>{
 const f=fixture();let checks=0;
 try{
  f.hooks.management=async(_command,input)=>{if(input===INSPECT_WINDOWS_BROWSER_RESET_SCRIPT)return 'none';if(input?.includes('MU_COMPONENTS'))return '';assert.equal(denied,false);assert.equal(checks,2);throw Error('Fixture first mutation boundary');};
  f.hooks.authorize=async()=>{if(++checks===2){assert.ok(f.events.includes('profile-check'));if(denied)throw Error('Synthetic revoked protection');}};
  await assert.rejects(f.browser.open(f.environment.id),denied?/Synthetic revoked protection/:/Fixture first mutation boundary/);
  assert.equal(checks,2);assert.equal(f.browser.entries.size,0);assert.equal(f.guest.length,denied?2:3);
 }finally{f.dispose();}
});

test('Pending profile reset discards the pre-reset profile read and checks again',async()=>{
 const f=fixture(false,undefined,true);let resets=0,profiles=0,recovered=false;
 try{
  f.hooks.profileCheck=async()=>{profiles++;if(profiles===1)throw Error('Profile changing during reset');assert.equal(recovered,true);return JSON.stringify({version:1,state:'absent',selectedVersion:WINDOWS_CHROME.version,recordedVersion:null,issue:null});};
  f.hooks.management=async(_command,input)=>{if(input===INSPECT_WINDOWS_BROWSER_RESET_SCRIPT)return ++resets===1?'pending':'none';if(input===RECOVER_WINDOWS_BROWSER_RESET_SCRIPT){assert.equal(f.events.at(-2),'authorize');recovered=true;return '';}if(input?.includes('MU_COMPONENTS'))return '';assert.equal(f.events.at(-2),'authorize');throw Error('Fixture after profile admission');};
  await assert.rejects(f.browser.open(f.environment.id),/Fixture after profile admission/);assert.equal(profiles,2);assert.equal(resets,2);assert.equal(recovered,true);assert.equal(f.events.filter(value=>value==='authorize').length,4);
 }finally{f.dispose();}
});

test('Shared browser close flushes Chrome and confirms only its unit stopped while files retain their display',async()=>{
 const f=fixture(true);try{
  const files=await f.display!.acquire(f.environment.id,'files'),browserLease=await f.display!.acquire(f.environment.id,'browser'),sharedEntry=f.display!.readyEntry(f.environment.id)!;
  const entry={...f.entry(),sharedEntry,sharedLease:browserLease,chromeAttempted:true};f.browser.entries.set(f.environment.id,entry);
  const stream=sharedEntry.vnc!(),ticket=f.display!.transport.issue(f.environment.id).ticket;let audioRevocations=0;f.browser.revokeAudio=()=>audioRevocations++;
  await f.browser.close(f.environment.id);assert.ok(f.events.includes('Browser.close'));assert.equal(f.guest.length,1);assert.equal(f.guest[0].input,STOP_WINDOWS_CHROME);
  assert.equal(f.events.includes('shared-stop'),false);assert.equal(stream.destroyed,false);assert.equal(f.browser.tickets.has(ticket),true);assert.equal(audioRevocations,0);
  assert.deepEqual(f.display!.info(f.environment.id).owners,['files']);assert.equal(f.browser.info(f.environment.id).ready,true);assert.equal(f.browser.info(f.environment.id).browserRunning,false);
  f.browser.dispose();assert.equal(stream.destroyed,false);assert.equal(f.browser.tickets.has(ticket),true);await f.display!.release(files);assert.equal(stream.destroyed,true);
 }finally{f.dispose();}
});

test('Shared Chrome startup failure releases only its lease without starting or resizing a second display',async()=>{
 const f=fixture(true);try{
  const files=await f.display!.acquire(f.environment.id,'files'),stream=f.display!.readyEntry(f.environment.id)!.vnc!();
  f.hooks.management=async(_command,input)=>input?.includes('MU_WINDOWS_BROWSER_RESET_STATE')?'none':'';
  await assert.rejects(f.browser.open(f.environment.id),/No actual guest stream/);
  assert.equal(f.events.filter(event=>event==='shared-start').length,1);assert.equal(f.events.includes('shared-stop'),false);assert.equal(stream.destroyed,false);
  assert.equal(f.guest.some(value=>value.input?.includes('Description=MuCodeSandbox Windows guest display')),false);
  assert.equal(f.guest.filter(value=>value.input===STOP_WINDOWS_CHROME).length,1);assert.deepEqual(f.display!.info(f.environment.id).owners,['files']);
  await f.display!.release(files);
 }finally{f.dispose();}
});

for(const cancelled of [false,true])test('Shared display failed preparation preserves an unconfirmed stop through browser '+(cancelled?'cancellation':'opening'),async()=>{
 const f=fixture(true),gate=deferred<void>();try{
  f.hooks.management=async(_command,input)=>input?.includes('MU_WINDOWS_BROWSER_RESET_STATE')?'none':'';
  f.display!.driver.start=async()=>{f.events.push('shared-start');await gate.promise;throw Error('Synthetic failed display start');};
  f.display!.driver.stop=async()=>{throw Error('Synthetic unconfirmed display stop');};
  const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('shared-start'));
  const closing=cancelled?f.browser.close(f.environment.id).catch(error=>error):undefined;gate.resolve();
  assert.equal((await opening as {code:string}).code,'DISPLAY_STOP_UNCONFIRMED');if(closing)assert.equal((await closing as {code:string}).code,'DISPLAY_STOP_UNCONFIRMED');
  assert.equal(f.display!.info(f.environment.id).stopUnconfirmed,true);assert.equal(f.browser.running(f.environment.id),false);
  assert.equal(f.guest.some(value=>value.input===STOP_WINDOWS_CHROME),false);
 }finally{gate.resolve();f.dispose();}
});

test('Unconfirmed shared Chrome stop quarantines the environment instead of leaving an unmonitored browser beside files',async()=>{
 const f=fixture(true);try{
  await f.display!.acquire(f.environment.id,'files');const sharedLease=await f.display!.acquire(f.environment.id,'browser'),sharedEntry=f.display!.readyEntry(f.environment.id)!;
  f.browser.entries.set(f.environment.id,{...f.entry(),sharedLease,sharedEntry,chromeAttempted:true});
  f.hooks.management=async(_command,input)=>{assert.equal(input,STOP_WINDOWS_CHROME);throw Error('Synthetic missing stop acknowledgement');};
  await assert.rejects(f.browser.close(f.environment.id),{code:'BROWSER_STOP_UNCONFIRMED'});assert.equal(f.events.includes('quarantine'),true);
  assert.equal(f.sessions.size,0);assert.equal(f.display!.info(f.environment.id).ready,false);assert.equal(f.browser.running(f.environment.id),false);
 }finally{f.dispose();}
});

test('A replaced shared session never receives old Chrome stop commands or loses its new display',async()=>{
 const f=fixture(true),gate=deferred<void>();try{
  const sharedLease=await f.display!.acquire(f.environment.id,'browser'),sharedEntry=f.display!.readyEntry(f.environment.id)!;
  const entry={...f.entry(),sharedLease,sharedEntry,chromeAttempted:true};entry.fixtureTools.send=async()=>{await gate.promise;entry.fixtureTools.socket.readyState=WebSocket.CLOSED;entry.fixtureTools.socket.emit('close');return {};};f.browser.entries.set(f.environment.id,entry);
  const closing=f.browser.close(f.environment.id);await until(()=>f.browser.entries.size===0);f.sessions.set(f.environment.id,{id:'old',state:'active'});
  await f.display!.acquire(f.environment.id,'files');gate.resolve();await closing;assert.equal(f.guest.length,0);assert.deepEqual(f.display!.info(f.environment.id).owners,['files']);
 }finally{gate.resolve();f.dispose();}
});
test('Normal Windows close requests profile flush before terminating transport and display',async()=>{const f=fixture();try{f.browser.entries.set(f.environment.id,f.entry());await f.browser.close(f.environment.id);assert.ok(f.events.indexOf('Browser.close')>=0);assert.ok(f.events.indexOf('Browser.close')<f.events.indexOf('transport-stop'));assert.ok(f.events.indexOf('transport-stop')<f.events.indexOf('guest-stop'));assert.equal(f.guest[0].command[2],STOP_WINDOWS_DISPLAY_AFTER_CLOSE);assert.equal(f.browser.running(f.environment.id),false);}finally{f.dispose();}});
for(const kind of ['malformed','cancelled','replaced'])test('A late selected-version read cannot start a browser after '+kind,async()=>{
 const f=fixture(),gate=deferred<string>(),control=new AbortController();try{f.hooks.selectionCheck=()=>gate.promise;const opening=f.browser.open(f.environment.id,{signal:control.signal}).catch(error=>error);await until(()=>f.events.includes('selection-check'));if(kind==='cancelled')control.abort();if(kind==='replaced')f.sessions.set(f.environment.id,{id:'replacement',state:'active'});gate.resolve(kind==='malformed'?'invalid private diagnostic':JSON.stringify({version:1,selectedVersion:WINDOWS_CHROME.version}));const error=await opening;assert.ok(error instanceof Error);if(kind==='malformed')assert.equal((error as Error&{code?:string}).code,'BROWSER_SELECTION_RECEIPT');if(kind==='replaced')assert.equal((error as Error&{code?:string}).code,'GUARD_FAILED');assert.equal(f.guest.length,0);assert.equal(f.browser.entries.size,0);}finally{gate.resolve('');f.dispose();}
});

for(const scenario of ['newer','untrusted','malformed','cancelled','replaced'])test('Profile admission cannot start display or Chrome after '+scenario,async()=>{
 const f=fixture(),gate=deferred<string>();try{
  f.hooks.management=async(_command,input)=>input?.includes('MU_WINDOWS_BROWSER_RESET_STATE')?'none':'';
  f.hooks.profileCheck=()=>gate.promise;const control=new AbortController(),opening=f.browser.open(f.environment.id,{signal:control.signal}).catch(error=>error);
  await until(()=>f.events.includes('profile-check'));
  if(scenario==='cancelled')control.abort();if(scenario==='replaced')f.sessions.set(f.environment.id,{id:'replacement',state:'active'});
  gate.resolve(scenario==='malformed'?'private invalid diagnostic':JSON.stringify({version:1,state:scenario==='untrusted'?'untrusted':'newer',selectedVersion:WINDOWS_CHROME.version,recordedVersion:scenario==='untrusted'?null:'156.0.0.0',issue:scenario==='untrusted'?'changed':null}));
  const result=await opening;assert.ok(result instanceof Error);if(!['cancelled','replaced'].includes(scenario))assert.equal((result as {code?:string}).code,{newer:'BROWSER_PROFILE_NEWER',untrusted:'BROWSER_PROFILE_UNTRUSTED',malformed:'BROWSER_PROFILE_RECEIPT'}[scenario]);
  assert.equal(f.guest.some(value=>value.input?.includes('Description=MuCodeSandbox Windows guest display')),false);assert.equal(f.guest.some(value=>value.input?.includes('MU_PREFS')),false);assert.equal(f.guest.some(value=>isDisplayStop(value.command)),false);assert.equal(f.browser.entries.size,0);assert.equal(f.browser.running(f.environment.id),false);
 }finally{gate.resolve('');f.dispose();}
});
test('A close during pending profile preparation prevents any later guest startup command',async()=>{const f=fixture(),gate=deferred<void>();try{f.hooks.profile=()=>gate.promise;const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('profile'));const closing=f.browser.close(f.environment.id);gate.resolve();await closing;assert.ok(await opening instanceof Error);assert.equal(f.guest.length,0);}finally{gate.resolve();f.dispose();}});
test('A late profile result cannot replace a newer guest browser entry',async()=>{const f=fixture(),gate=deferred<void>();try{f.hooks.profile=()=>gate.promise;const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('profile'));f.sessions.set(f.environment.id,{id:'new',state:'active'});const replacement=f.entry('new');f.browser.entries.set(f.environment.id,replacement);gate.resolve();assert.ok(await opening instanceof Error);assert.equal(f.browser.entries.get(f.environment.id),replacement);assert.equal(f.guest.length,0);}finally{gate.resolve();f.dispose();}});
test('An open waits for both profile flush and the previous guest-stop result',async()=>{
 const f=fixture(),ack=deferred<void>(),stopped=deferred<void>();try{const entry=f.entry();entry.fixtureTools.send=async method=>{f.events.push(method);await ack.promise;entry.fixtureTools.socket.readyState=WebSocket.CLOSED;entry.fixtureTools.socket.emit('close');return {};};f.browser.entries.set(f.environment.id,entry);f.hooks.management=async command=>{if(isDisplayStop(command)){await stopped.promise;return '';}throw Error('Fixture startup boundary');};const closing=f.browser.close(f.environment.id),opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('Browser.close'));assert.equal(f.events.includes('authorize'),false);assert.equal(f.guest.length,0);ack.resolve();await until(()=>f.events.includes('guest-stop'));assert.equal(f.events.includes('authorize'),false);stopped.resolve();await closing;assert.match((await opening as Error).message,/Fixture startup boundary/);assert.ok(f.events.indexOf('authorize')>f.events.indexOf('guest-stop'));}finally{ack.resolve();stopped.resolve();f.dispose();}
});
test('Concurrent closes share one guest stop and report its actual failure',async()=>{const f=fixture(),stop=deferred<void>();try{f.browser.entries.set(f.environment.id,f.entry());f.hooks.management=async()=>{await stop.promise;throw Error('Stop unconfirmed');};const first=f.browser.close(f.environment.id),second=f.browser.close(f.environment.id);assert.equal(first,second);const result=first.catch(error=>error);await until(()=>f.events.includes('guest-stop'));stop.resolve();assert.equal((await result as {code:string}).code,'BROWSER_STOP_UNCONFIRMED');assert.equal(f.guest.length,1);assert.equal(f.browser.running(f.environment.id),false);}finally{stop.resolve();f.dispose();}});
test('An open cannot bypass a failed preceding close',async()=>{const f=fixture(),stop=deferred<void>();try{f.browser.entries.set(f.environment.id,f.entry());f.hooks.management=async()=>{await stop.promise;throw Error('Stop unconfirmed');};const closing=f.browser.close(f.environment.id).catch(error=>error),opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('guest-stop'));stop.resolve();assert.equal((await closing as {code:string}).code,'BROWSER_STOP_UNCONFIRMED');assert.equal((await opening as {code:string}).code,'BROWSER_STOP_UNCONFIRMED');assert.equal(f.events.includes('authorize'),false);assert.equal(f.guest.length,1);}finally{stop.resolve();f.dispose();}});
test('A close for an old session never stops the current guest or a replacement entry',async()=>{const f=fixture(),ack=deferred<void>();try{const old=f.entry();old.fixtureTools.send=async method=>{f.events.push(method);await ack.promise;old.fixtureTools.socket.readyState=WebSocket.CLOSED;old.fixtureTools.socket.emit('close');return {};};f.browser.entries.set(f.environment.id,old);const closing=f.browser.close(f.environment.id);await until(()=>f.events.includes('Browser.close'));f.sessions.set(f.environment.id,{id:'new',state:'active'});const replacement=f.entry('new');f.browser.entries.set(f.environment.id,replacement);ack.resolve();await closing;assert.equal(f.guest.length,0);assert.equal(f.browser.entries.get(f.environment.id),replacement);assert.equal(f.browser.running(f.environment.id),true);}finally{ack.resolve();f.dispose();}});
test('A waiting open is bound to its original session even if the guest restarts during close',async()=>{const f=fixture(),ack=deferred<void>();try{const old=f.entry();old.fixtureTools.send=async method=>{f.events.push(method);await ack.promise;old.fixtureTools.socket.readyState=WebSocket.CLOSED;old.fixtureTools.socket.emit('close');return {};};f.browser.entries.set(f.environment.id,old);const closing=f.browser.close(f.environment.id),opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('Browser.close'));f.sessions.set(f.environment.id,{id:'new',state:'active'});ack.resolve();await closing;assert.equal((await opening as {code:string}).code,'GUARD_FAILED');assert.equal(f.guest.length,0);}finally{ack.resolve();f.dispose();}});
test('Duplicate preparation submits once and revocation cancels it before any guest command',async()=>{const f=fixture(),gate=deferred<void>();try{f.hooks.profile=()=>gate.promise;const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('profile'));await assert.rejects(f.browser.open(f.environment.id),{code:'BROWSER_BUSY'});f.browser.revoke(f.environment.id);gate.resolve();assert.ok(await opening instanceof Error);assert.equal(f.events.filter(value=>value==='profile').length,1);assert.equal(f.guest.length,0);}finally{gate.resolve();f.dispose();}});
test('External cancellation during preparation is propagated and releases the open admission',async()=>{const f=fixture(),gate=deferred<void>(),cancel=new AbortController();try{f.hooks.profile=()=>gate.promise;const opening=f.browser.open(f.environment.id,{signal:cancel.signal}).catch(error=>error);await until(()=>f.events.includes('profile'));cancel.abort();gate.resolve();assert.ok(await opening instanceof Error);assert.equal(f.guest.length,0);f.hooks.profile=undefined;f.hooks.management=async()=>{throw Error('Fixture command boundary');};await assert.rejects(f.browser.open(f.environment.id),/Fixture command boundary/);}finally{gate.resolve();f.dispose();}});
test('Disposal during preparation cannot create a viewer or guest command after shutdown',async()=>{const f=fixture(),gate=deferred<void>();try{f.hooks.profile=()=>gate.promise;const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.events.includes('profile'));f.browser.dispose();gate.resolve();assert.ok(await opening instanceof Error);assert.equal(f.guest.length,0);assert.equal(f.browser.entries.size,0);await assert.rejects(f.browser.open(f.environment.id),{code:'CLOSING'});}finally{gate.resolve();f.dispose();}});
test('Stale ready entries are not reported as running and cannot bypass authorization',async()=>{const f=fixture();try{f.browser.entries.set(f.environment.id,f.entry());f.sessions.set(f.environment.id,{id:'new',state:'active'});assert.equal(f.browser.running(f.environment.id),false);assert.equal(f.browser.info(f.environment.id).ready,false);f.hooks.authorize=async()=>{throw Error('Denied guard');};await assert.rejects(f.browser.open(f.environment.id),/Denied guard/);assert.equal(f.guest.length,0);}finally{f.dispose();}});
test('Quarantine immediately revokes tickets and transports even when audio cleanup throws',()=>{const f=fixture();try{const entry=f.entry();f.browser.entries.set(f.environment.id,entry);f.browser.tickets.set('fixture',{id:f.environment.id,sessionId:f.session.id,expires:Date.now()+1000});f.browser.revokeAudio=()=>{throw Error('Synthetic audio cleanup failure');};assert.doesNotThrow(()=>f.browser.revoke(f.environment.id));assert.equal(entry.closed,true);assert.equal(entry.fixtureTools.socket.readyState,WebSocket.CLOSED);assert.equal(f.browser.tickets.size,0);assert.equal(f.browser.entries.size,0);assert.equal(f.events.includes('Browser.close'),false);assert.equal(f.guest.length,0);}finally{f.browser.revokeAudio=undefined;f.dispose();}});
test('Quarantine interrupts an in-progress graceful flush without waiting for its timeout',async()=>{const f=fixture();try{const entry=f.entry();entry.fixtureTools.send=async method=>{f.events.push(method);return {};};f.browser.entries.set(f.environment.id,entry);const closing=f.browser.close(f.environment.id);await until(()=>f.events.includes('Browser.close'));f.browser.revoke(f.environment.id);await closing;assert.equal(entry.fixtureTools.socket.readyState,WebSocket.CLOSED);assert.equal(f.browser.entries.size,0);}finally{f.dispose();}});
test('A silent Chrome close reply has a bounded fallback to terminating the display',async()=>{const f=fixture();try{const entry=f.entry();entry.fixtureTools.send=async method=>{f.events.push(method);return {};};f.browser.entries.set(f.environment.id,entry);const started=Date.now();await f.browser.close(f.environment.id);assert.ok(Date.now()-started>=4500);assert.equal(f.guest.filter(value=>isDisplayStop(value.command)).length,1);assert.equal(entry.fixtureTools.socket.listenerCount('close'),0);assert.equal(f.browser.running(f.environment.id),false);}finally{f.dispose();}});
test('A failed display stop stays explicit until an authorized close retry confirms it',async()=>{const f=fixture();try{f.browser.entries.set(f.environment.id,f.entry());f.hooks.management=async()=>{throw Error('Synthetic lost stop reply');};await assert.rejects(f.browser.close(f.environment.id),{code:'BROWSER_STOP_UNCONFIRMED'});const commands=f.guest.length;await assert.rejects(f.browser.open(f.environment.id),{code:'BROWSER_STOP_UNCONFIRMED'});assert.equal(f.guest.length,commands);f.hooks.management=async()=>'';await f.browser.close(f.environment.id);assert.equal(f.guest.length,commands+1);f.hooks.management=async()=>{throw Error('Fixture command boundary');};await assert.rejects(f.browser.open(f.environment.id),/Fixture command boundary/);}finally{f.dispose();}});
test('An unconfirmed stop from an old session is never retried against a restarted guest',async()=>{const f=fixture();try{f.browser.entries.set(f.environment.id,f.entry());f.hooks.management=async()=>{throw Error('Stop reply lost');};await assert.rejects(f.browser.close(f.environment.id),{code:'BROWSER_STOP_UNCONFIRMED'});f.sessions.set(f.environment.id,{id:'new',state:'active'});const commands=f.guest.length;await f.browser.close(f.environment.id);assert.equal(f.guest.length,commands);}finally{f.dispose();}});
test('Cancellation after display startup cannot report closed if its independent stop remains unconfirmed',async()=>{const f=fixture(),gate=deferred<void>();try{f.hooks.management=async(command,input)=>{if(isDisplayStop(command))throw Error('Stop not confirmed');if(input?.includes('MU_WINDOWS_BROWSER_RESET_STATE'))return 'none';if(input?.includes('Description=MuCodeSandbox Windows guest display'))await gate.promise;return '';};const opening=f.browser.open(f.environment.id).catch(error=>error);await until(()=>f.guest.some(value=>value.input?.includes('Description=MuCodeSandbox Windows guest display')));const closing=f.browser.close(f.environment.id).catch(error=>error);assert.equal(f.guest.find(value=>value.input?.includes('Description=MuCodeSandbox Windows guest display'))?.signal?.aborted,true);gate.resolve();assert.equal((await opening as {code:string}).code,'BROWSER_STOP_UNCONFIRMED');assert.equal((await closing as {code:string}).code,'BROWSER_STOP_UNCONFIRMED');assert.equal(f.guest.filter(value=>isDisplayStop(value.command)).length,1);}finally{gate.resolve();f.dispose();}});
