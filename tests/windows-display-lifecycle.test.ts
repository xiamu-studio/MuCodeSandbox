import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import type {Socket} from 'node:net';
import {WebSocket} from 'ws';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import type {WindowsConfig} from '../server/platform/windows/config.ts';
import {WindowsDisplayLifecycle,type WindowsDisplayDriver,type WindowsDisplayManagerPort,type WindowsDisplayLease} from '../server/platform/windows/display-lifecycle.ts';
import {createWindowsDisplayDriver,VERIFY_WINDOWS_DISPLAY_COMPONENTS,windowsDisplayReadyProgram,windowsDisplayServiceProgram,parseWindowsDisplayReady} from '../server/platform/windows/display-guest.ts';
import {windowsDisplayLauncher,startWindowsDisplay} from '../server/platform/windows/browser-guest.ts';
import {WindowsGuestAudio,windowsDisplayAudioSource} from '../server/platform/windows/audio.ts';
import {displayPixels,DEFAULT_FIXED_DISPLAY,type GuestDisplay} from '../shared/guest-display.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'Lifecycle checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(){
 const id=randomUUID(),env:Environment={...environmentSchema.parse({name:'Display owner fixture',network:{mode:'http',host:'127.0.0.1',port:7897,strict:true,transparent:true}}),id,instanceName:'mu-display-owner-fixture',state:'running',browserRunning:false,lastError:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 const sessions=new Map([[id,{id:'fixture-session',state:'active' as 'active'|'failed'}]]),events:string[]=[],signals:AbortSignal[]=[],streams:PassThrough[]=[];
 const hooks:{access?:()=>Promise<void>;profile?:()=>Promise<void>;verify?:()=>Promise<void>;start?:()=>Promise<void>;resize?:()=>Promise<void>;check?:()=>Promise<void>;stop?:()=>Promise<void>}={};
 const manager:WindowsDisplayManagerPort={sessions,store:{get:()=>env},assertAccess:async()=>{events.push('access');await hooks.access?.();return env;},profile:async()=>{events.push('profile');await hooks.profile?.();return {} as WindowsConfig;}};
 const driver:WindowsDisplayDriver={verify:async()=>{events.push('verify');await hooks.verify?.();},start:async(_entry,options)=>{events.push('start');signals.push(options.signal!);await hooks.start?.();},channel:async()=>{events.push('channel');return()=>{const stream=new PassThrough();streams.push(stream);return stream;};},resize:async stream=>{events.push('resize');await hooks.resize?.();stream.destroy();},check:async()=>{events.push('check');await hooks.check?.();},stop:async()=>{events.push('stop');await hooks.stop?.();}};
 const display=new WindowsDisplayLifecycle(manager,driver);return {id,env,sessions,events,signals,streams,hooks,manager,display,dispose:()=>display.dispose()};
}

function audioFixture(f:ReturnType<typeof fixture>){
 let launches=0;const audio=new WindowsGuestAudio(f.manager as never,windowsDisplayAudioSource(f.display),{audioLaunch:async()=>{launches++;return {file:process.execPath,args:['-e',"process.stdin.resume();setInterval(()=>process.stdout.write(Buffer.alloc(3840,18)),20)"],env:{...process.env},cwd:process.cwd()};}});
 return {audio,launches:()=>launches};
}

function nativeResult():GuestDisplay{return {...displayPixels(DEFAULT_FIXED_DISPLAY),browserScaleFactor:0,densitySource:'xsettings',nativeScaleFactor:2,matched:true};}
test('Shared display resize serializes browser and native mutations and stores only the current original receipt',async()=>{
 const f=fixture(),gate=deferred();try{
  await f.display.acquire(f.id,'files');const entry=f.display.readyEntry(f.id)!,seen:string[]=[];
  f.display.driver.configure=async value=>{assert.equal(value,entry);seen.push('native');return nativeResult();};
  const browser=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY,async value=>{assert.equal(value,entry);seen.push('browser');await gate.promise;return {...nativeResult(),browserScaleFactor:2,densitySource:undefined};});
  await until(()=>seen.includes('browser'));const native=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(seen,['browser']);
  gate.resolve();assert.equal((await browser).browserScaleFactor,2);assert.equal((await native).densitySource,'xsettings');assert.deepEqual(seen,['browser','native']);assert.equal(entry.display?.browserScaleFactor,0);
 }finally{gate.resolve();f.dispose();}
});
test('Queued shared resize rejects cancellation and stale same-text sessions without calling the guest again',async()=>{
 for(const kind of ['cancel','replacement'] as const){const f=fixture(),gate=deferred(),cancel=new AbortController();let calls=0;try{
  await f.display.acquire(f.id,'files');f.display.driver.configure=async()=>{calls++;await gate.promise;return nativeResult();};
  const first=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY).catch(error=>error);await until(()=>calls===1);
  const queued=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY,undefined,{signal:cancel.signal}).catch(error=>error);
  if(kind==='cancel')cancel.abort();else f.sessions.set(f.id,{id:'fixture-session',state:'active'});gate.resolve();
  if(kind==='replacement')assert.equal((await first as {code:string}).code,'DISPLAY_SESSION_CHANGED');else assert.equal((await first as GuestDisplay).matched,true);
  assert.ok(await queued instanceof Error);assert.equal(calls,1);assert.equal(f.display.readyEntry(f.id)?.display?.matched,kind==='cancel'?true:undefined);
 }finally{gate.resolve();f.dispose();}}
});
test('Display mutation queue is bounded and a failed mutation does not poison the next authorized operation',async()=>{
 const f=fixture(),gate=deferred();let calls=0;try{
  await f.display.acquire(f.id,'files');f.display.driver.configure=async()=>{calls++;if(calls===1){await gate.promise;throw Error('Synthetic failed resize');}return nativeResult();};
  const first=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY).catch(error=>error);await until(()=>calls===1);
  const waiting=Array.from({length:3},()=>f.display.resize(f.id,DEFAULT_FIXED_DISPLAY));await assert.rejects(f.display.resize(f.id,DEFAULT_FIXED_DISPLAY),{code:'DISPLAY_BUSY'});
  gate.resolve();assert.match((await first as Error).message,/Synthetic failed resize/);for(const result of await Promise.all(waiting))assert.equal(result.matched,true);assert.equal(calls,4);
 }finally{gate.resolve();f.dispose();}
});
test('Display revocation during a mutation cancels its authority and never stores a late success',async()=>{
 const f=fixture(),gate=deferred();let entered=false;try{
  await f.display.acquire(f.id,'files');const entry=f.display.readyEntry(f.id)!;
  f.display.driver.configure=async(_entry,_request,options)=>{entered=true;await gate.promise;options.assertCurrent();return nativeResult();};
  const pending=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY).catch(error=>error);await until(()=>entered);f.display.revoke(f.id);gate.resolve();assert.ok(await pending instanceof Error);assert.equal(entry.display,undefined);
 }finally{gate.resolve();f.dispose();}
});

test('Replacement display startup waits for a retired mutation to finish before creating a new service',async()=>{
 const f=fixture(),gate=deferred();let entered=false;try{
  await f.display.acquire(f.id,'files');f.display.driver.configure=async()=>{entered=true;await gate.promise;return nativeResult();};
  const mutation=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY).catch(error=>error);await until(()=>entered);f.display.revoke(f.id);
  const next=f.display.acquire(f.id,'files');await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.events.filter(e=>e==='start').length,1);
  gate.resolve();assert.ok(await mutation instanceof Error);await next;assert.equal(f.events.filter(e=>e==='start').length,2);assert.equal(f.display.readyEntry(f.id)?.display,undefined);
 }finally{gate.resolve();f.dispose();}
});

test('Last display owner waits for an in-flight mutation before issuing its independent stop',async()=>{
 const f=fixture(),gate=deferred();let entered=false;try{
  const owner=await f.display.acquire(f.id,'files');f.display.driver.configure=async()=>{entered=true;await gate.promise;return nativeResult();};
  const mutation=f.display.resize(f.id,DEFAULT_FIXED_DISPLAY).catch(error=>error);await until(()=>entered);const stopped=f.display.release(owner);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.events.includes('stop'),false);gate.resolve();assert.ok(await mutation instanceof Error);await stopped;assert.equal(f.events.filter(e=>e==='stop').length,1);
 }finally{gate.resolve();f.dispose();}
});

test('Display audio exposes only the original prepared entry and rejects an identical-text replacement session',async()=>{
 const f=fixture(),source=windowsDisplayAudioSource(f.display);try{
  assert.equal(source.entries.get(f.id),undefined);await f.display.acquire(f.id,'files');const entry=f.display.entries.get(f.id)!;
  assert.equal(source.entries.get(f.id),entry);assert.equal(source.entries.get(f.id),source.entries.get(f.id));
  f.sessions.set(f.id,{id:entry.sessionId,state:'active'});assert.equal(source.entries.get(f.id),undefined);
 }finally{f.dispose();}
});

test('Display revocation notifies every subscriber despite a throwing legacy callback or consumer',async()=>{
 const f=fixture(),seen:string[]=[];try{
  await f.display.acquire(f.id,'files');f.display.onRevoked=()=>{throw Error('Legacy cleanup failed');};
  f.display.subscribeRevoked(()=>{seen.push('first');throw Error('Consumer cleanup failed');});
  const remove=f.display.subscribeRevoked(()=>seen.push('removed'));remove();f.display.subscribeRevoked(()=>seen.push('last'));
  f.display.revoke(f.id);assert.deepEqual(seen,['first','last']);f.display.revoke(f.id);assert.deepEqual(seen,['first','last']);
  f.display.dispose();assert.throws(()=>f.display.subscribeRevoked(()=>{}),{code:'CLOSING'});
 }finally{f.dispose();}
});

test('Desktop-only audio tickets survive browser-owner release and are synchronously revoked before the last display stop',async()=>{
 const f=fixture(),a=audioFixture(f);try{
  await assert.rejects(a.audio.issue(f.id),{code:'BROWSER_NOT_READY'});assert.equal(a.launches(),0);
  const client=await f.display.acquire(f.id,'grok-bot'),ticket=await a.audio.issue(f.id),browser=await f.display.acquire(f.id,'browser');
  await f.display.release(browser);assert.equal(a.audio.host.tickets.has(ticket.ticket),true);assert.equal(f.events.includes('stop'),false);
  f.hooks.stop=async()=>{assert.equal(a.audio.host.tickets.size,0);assert.equal(a.audio.host.peers.size,0);};
  await f.display.release(client);assert.equal(a.audio.host.tickets.size,0);assert.equal(f.events.filter(e=>e==='stop').length,1);
 }finally{await a.audio.dispose();f.dispose();}
});

test('Audio cannot publish a launch prepared for a retired display with the same network id text',async()=>{
 const f=fixture(),gate=deferred();let entered=false;
 const audio=new WindowsGuestAudio(f.manager as never,windowsDisplayAudioSource(f.display),{audioLaunch:async()=>{entered=true;await gate.promise;return {file:process.execPath,args:[],env:{},cwd:process.cwd()};}});
 try{
  await f.display.acquire(f.id,'files');const pending=audio.issue(f.id);await until(()=>entered);
  f.sessions.set(f.id,{id:'fixture-session',state:'active'});await f.display.acquire(f.id,'files');gate.resolve();
  await assert.rejects(pending,{code:'AUDIO_SESSION_CHANGED'});assert.equal(audio.host.tickets.size,0);assert.equal(f.display.info(f.id).ready,true);
 }finally{gate.resolve();await audio.dispose();f.dispose();}
});

test('Failed shared-display protection immediately burns pending audio tickets',async()=>{
 const f=fixture(),a=audioFixture(f);try{
  await f.display.acquire(f.id,'files');await a.audio.issue(f.id);assert.equal(a.audio.host.tickets.size,1);
  f.hooks.check=async()=>{throw Error('Synthetic display identity failure');};await assert.rejects(f.display.assertProtection(f.id),/Synthetic display identity failure/);
  assert.equal(a.audio.host.tickets.size,0);assert.equal(f.display.readyEntry(f.id),undefined);
 }finally{await a.audio.dispose();f.dispose();}
});

test('Actual audio WebSocket and disposable capture survive browser release and stop with the final display owner',async()=>{
 const f=fixture(),a=audioFixture(f),server=createServer(),sockets=new Set<Socket>();let client:WebSocket|undefined,captureStopped=false,packets=0;
 const capture=a.audio.host.options.capture;a.audio.host.options.capture=session=>{const actual=capture(session);return {stream:actual.stream,stop:async()=>{await actual.stop();captureStopped=true;}};};
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.on('upgrade',(request,socket,head)=>{void a.audio.host.upgrade(request,socket,head,()=>true);});
 try{
  const owner=await f.display.acquire(f.id,'files'),browser=await f.display.acquire(f.id,'browser'),ticket=await a.audio.issue(f.id);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  client=new WebSocket(`ws://127.0.0.1:${address.port}/guest-audio?ticket=${ticket.ticket}`);client.on('message',(_data,binary)=>{if(binary)packets++;});
  await new Promise<void>((resolve,reject)=>{client!.once('open',resolve);client!.once('error',reject);});await until(()=>packets>=2);
  await f.display.release(browser);const before=packets;await until(()=>packets>before);assert.equal(client.readyState,WebSocket.OPEN);assert.equal(captureStopped,false);
  f.hooks.stop=async()=>{assert.equal(a.audio.host.peers.size,0);assert.equal(a.audio.host.cleanup.size,0);};
  await f.display.release(owner);await until(()=>client!.readyState===WebSocket.CLOSED);await Promise.all(a.audio.host.stopping);assert.equal(captureStopped,true);
 }finally{client?.terminate();await a.audio.dispose();f.dispose();for(const socket of sockets)socket.destroy();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Independent display has no browser owner until requested and only its final owner stops the service',async()=>{
 const f=fixture();try{const client=await f.display.acquire(f.id,'grok-bot'),entry=f.display.entries.get(f.id)!,stream=entry.vnc!(),browser=await f.display.acquire(f.id,'browser');assert.equal(f.events.filter(v=>v==='start').length,1);assert.equal(f.display.info(f.id).browserRunning,false);assert.deepEqual(f.display.info(f.id).owners,['grok-bot','browser']);const ticket=f.display.transport.issue(f.id).ticket;await f.display.release(browser);assert.equal(f.events.includes('stop'),false);assert.equal(stream.destroyed,false);assert.equal(f.display.transport.tickets.has(ticket),true);assert.equal(f.display.info(f.id).ready,true);await f.display.release(client);assert.equal(f.events.filter(v=>v==='stop').length,1);assert.equal(stream.destroyed,true);assert.equal(f.display.transport.tickets.size,0);assert.equal(f.display.info(f.id).ready,false);}finally{f.dispose();}
});

test('Display lease identity is unforgeable and an already released owner is idempotent',async()=>{
 const f=fixture();try{const lease=await f.display.acquire(f.id,'browser');assert.equal(await f.display.acquire(f.id,'browser'),lease);await assert.rejects(f.display.release({...lease}),{code:'DISPLAY_LEASE_INVALID'});assert.equal(f.display.info(f.id).ready,true);await f.display.release(lease);await f.display.release(lease);assert.equal(f.events.filter(v=>v==='stop').length,1);}finally{f.dispose();}
});

test('Different pending owners share display preparation and cancelling one does not cancel the other',async()=>{
 const f=fixture(),gate=deferred(),cancel=new AbortController();try{f.hooks.start=()=>gate.promise;const first=f.display.acquire(f.id,'browser',{signal:cancel.signal}).catch(error=>error),second=f.display.acquire(f.id,'grok-bot');await until(()=>f.events.includes('start'));cancel.abort();assert.equal((await first as Error).name,'AbortError');assert.equal(f.signals[0].aborted,false);gate.resolve();const lease=await second;assert.deepEqual(f.display.info(f.id).owners,['grok-bot']);assert.equal(f.events.filter(v=>v==='start').length,1);assert.equal(f.events.includes('stop'),false);await f.display.release(lease);}finally{gate.resolve();f.dispose();}
});

test('Duplicate pending owner is refused while the original operation retains authority',async()=>{
 const f=fixture(),gate=deferred();try{f.hooks.start=()=>gate.promise;const first=f.display.acquire(f.id,'browser');await until(()=>f.events.includes('start'));await assert.rejects(f.display.acquire(f.id,'browser'),{code:'DISPLAY_BUSY'});gate.resolve();await f.display.release(await first);assert.equal(f.events.filter(v=>v==='start').length,1);}finally{gate.resolve();f.dispose();}
});

test('Cancelling the final owner during profile preparation cannot start a display later',async()=>{
 const f=fixture(),gate=deferred(),cancel=new AbortController();try{f.hooks.profile=()=>gate.promise;const first=f.display.acquire(f.id,'browser',{signal:cancel.signal}).catch(error=>error);await until(()=>f.events.includes('profile'));cancel.abort();gate.resolve();assert.equal((await first as Error).name,'AbortError');assert.equal(f.events.includes('start'),false);assert.equal(f.events.includes('stop'),false);assert.equal(f.display.entries.size,0);}finally{gate.resolve();f.dispose();}
});

test('Final owner cancellation after startup waits for stop and never ignores an unconfirmed stop',async()=>{
 const f=fixture(),gate=deferred(),cancel=new AbortController();try{f.hooks.start=()=>gate.promise;f.hooks.stop=async()=>{throw Error('Synthetic stop reply lost');};const first=f.display.acquire(f.id,'browser',{signal:cancel.signal}).catch(error=>error);await until(()=>f.events.includes('start'));cancel.abort();assert.equal(f.signals[0].aborted,true);gate.resolve();assert.equal((await first as {code:string}).code,'DISPLAY_STOP_UNCONFIRMED');assert.equal(f.display.info(f.id).stopUnconfirmed,true);const starts=f.events.filter(v=>v==='start').length;await assert.rejects(f.display.acquire(f.id,'browser'),{code:'DISPLAY_STOP_UNCONFIRMED'});assert.equal(f.events.filter(v=>v==='start').length,starts);f.hooks.start=undefined;f.hooks.stop=undefined;await f.display.close(f.id);assert.equal(f.display.info(f.id).stopUnconfirmed,false);await f.display.release(await f.display.acquire(f.id,'browser'));}finally{gate.resolve();f.dispose();}
});

test('Concurrent final releases and close all await the same failing stop',async()=>{
 const f=fixture(),gate=deferred();try{const lease=await f.display.acquire(f.id,'browser');f.hooks.stop=async()=>{await gate.promise;throw Error('Synthetic unconfirmed stop');};const first=f.display.release(lease).catch(error=>error);await until(()=>f.events.includes('stop'));const second=f.display.release(lease).catch(error=>error),third=f.display.close(f.id).catch(error=>error);gate.resolve();for(const result of await Promise.all([first,second,third]))assert.equal(result.code,'DISPLAY_STOP_UNCONFIRMED');assert.equal(f.events.filter(v=>v==='stop').length,1);}finally{gate.resolve();f.dispose();}
});

test('A retired session with identical text cannot publish a late prepared display',async()=>{
 const f=fixture(),gate=deferred();try{f.hooks.profile=()=>gate.promise;const first=f.display.acquire(f.id,'browser').catch(error=>error);await until(()=>f.events.includes('profile'));f.sessions.set(f.id,{id:'fixture-session',state:'active'});gate.resolve();assert.equal((await first as {code:string}).code,'DISPLAY_SESSION_CHANGED');assert.equal(f.events.includes('start'),false);assert.equal(f.events.includes('stop'),false);}finally{gate.resolve();f.dispose();}
});

test('An old release never retires the replacement display after a session change',async()=>{
 const f=fixture();try{const old=await f.display.acquire(f.id,'browser');f.sessions.set(f.id,{id:'new-session',state:'active'});const replacement=await f.display.acquire(f.id,'grok-bot');await f.display.release(old);assert.deepEqual(f.display.info(f.id).owners,['grok-bot']);assert.equal(f.display.info(f.id).ready,true);assert.equal(f.events.includes('stop'),false);await f.display.release(replacement);assert.equal(f.events.filter(v=>v==='stop').length,1);}finally{f.dispose();}
});

test('A new session waits for an old stop but does not adopt its failed acknowledgement',async()=>{
 const f=fixture(),gate=deferred();try{const old=await f.display.acquire(f.id,'browser');f.hooks.stop=async()=>{await gate.promise;throw Error('Old stop failure');};const closing=f.display.release(old).catch(error=>error);await until(()=>f.events.includes('stop'));f.sessions.set(f.id,{id:'new-session',state:'active'});const next=f.display.acquire(f.id,'grok-bot');gate.resolve();assert.equal((await closing as {code:string}).code,'DISPLAY_STOP_UNCONFIRMED');const replacement=await next;assert.equal(f.display.info(f.id).ready,true);assert.equal(f.display.info(f.id).stopUnconfirmed,false);await f.display.release(old);assert.equal(f.events.filter(v=>v==='stop').length,1);f.hooks.stop=undefined;await f.display.release(replacement);}finally{gate.resolve();f.dispose();}
});

test('Protection rechecks deduplicate and reject a late result after display revocation',async()=>{
 const f=fixture(),gate=deferred();try{await f.display.acquire(f.id,'browser');const before=f.events.filter(v=>v==='check').length;f.hooks.check=()=>gate.promise;const first=f.display.assertProtection(f.id).catch(error=>error),second=f.display.assertProtection(f.id).catch(error=>error);await until(()=>f.events.filter(v=>v==='check').length===before+1);f.display.revoke(f.id);gate.resolve();assert.ok(await first instanceof Error);assert.ok(await second instanceof Error);assert.equal(f.display.entries.size,0);assert.equal(f.display.info(f.id).ready,false);}finally{gate.resolve();f.dispose();}
});

test('Throwing audio cleanup cannot retain viewers or suppress the final stop',async()=>{
 const f=fixture();try{const lease=await f.display.acquire(f.id,'browser'),stream=f.display.entries.get(f.id)!.vnc!();f.display.onRevoked=()=>{throw Error('Synthetic audio cleanup failure');};await f.display.release(lease);assert.equal(stream.destroyed,true);assert.equal(f.events.filter(v=>v==='stop').length,1);assert.equal(f.display.entries.size,0);}finally{f.dispose();}
});

test('Ready display admission still checks access and revokes old viewers on a real guard failure',async()=>{
 const f=fixture();try{await f.display.acquire(f.id,'browser');const stream=f.display.entries.get(f.id)!.vnc!();f.hooks.access=async()=>{throw Error('Synthetic failed guard');};await assert.rejects(f.display.acquire(f.id,'grok-bot'),/Synthetic failed guard/);assert.equal(stream.destroyed,true);assert.equal(f.display.info(f.id).ready,false);assert.equal(f.display.entries.size,0);}finally{f.dispose();}
});

test('Cancelling a new ready-display owner does not retire the existing owner',async()=>{
 const f=fixture(),gate=deferred(),cancel=new AbortController();try{const browser=await f.display.acquire(f.id,'browser'),stream=f.display.entries.get(f.id)!.vnc!();f.hooks.access=()=>gate.promise;const pending=f.display.acquire(f.id,'grok-bot',{signal:cancel.signal}).catch(error=>error);await until(()=>f.display.info(f.id).owners.includes('grok-bot'));cancel.abort();assert.equal((await pending as Error).name,'AbortError');assert.equal(stream.destroyed,false);assert.deepEqual(f.display.info(f.id).owners,['browser']);gate.resolve();f.hooks.access=undefined;await f.display.release(browser);}finally{gate.resolve();f.dispose();}
});

test('Display service verification failure revokes active viewers before returning the error',async()=>{
 const f=fixture();try{await f.display.acquire(f.id,'browser');const stream=f.display.entries.get(f.id)!.vnc!();f.hooks.check=async()=>{throw Error('Synthetic display identity change');};await assert.rejects(f.display.assertProtection(f.id),/Synthetic display identity change/);assert.equal(stream.destroyed,true);assert.equal(f.display.info(f.id).ready,false);}finally{f.dispose();}
});

test('A direct current display protection failure invokes independent quarantine once, outside periodic monitoring',async()=>{
 const f=fixture();let quarantines=0;try{
  f.manager.failProtection=async()=>{quarantines++;f.sessions.delete(f.id);};await f.display.acquire(f.id,'files');
  f.hooks.check=async()=>{throw Error('Synthetic direct display inspection failure');};
  const first=f.display.assertProtection(f.id),second=f.display.assertProtection(f.id);await assert.rejects(first,/Synthetic direct display inspection failure/);await assert.rejects(second,/Synthetic direct display inspection failure/);
  assert.equal(quarantines,1);assert.equal(f.sessions.size,0);assert.equal(f.display.readyEntry(f.id),undefined);
 }finally{f.dispose();}
});
test('A late display inspection from an identical-text replaced session never quarantines the new session',async()=>{
 const f=fixture(),gate=deferred();let entered=false,quarantines=0;try{
  f.manager.failProtection=async()=>{quarantines++;};await f.display.acquire(f.id,'files');f.hooks.check=async()=>{entered=true;await gate.promise;};
  const inspection=f.display.assertProtection(f.id).catch(error=>error);await until(()=>entered);const replacement={id:'fixture-session',state:'active' as const};f.sessions.set(f.id,replacement);gate.resolve();
  assert.equal((await inspection as {code:string}).code,'DISPLAY_SESSION_CHANGED');assert.equal(quarantines,0);assert.equal(f.sessions.get(f.id),replacement);
 }finally{gate.resolve();f.dispose();}
});

test('An actual local display viewer survives browser-owner release and closes with the final client owner',async()=>{
 const f=fixture(),server=createServer(),sockets=new Set<Socket>();let client:WebSocket|undefined;
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.on('upgrade',(request,socket,head)=>{void f.display.transport.upgrade(request,socket,head,req=>req.headers['x-display-fixture']==='yes').catch(()=>socket.destroy());});
 try{
  const browser=await f.display.acquire(f.id,'browser'),desktop=await f.display.acquire(f.id,'grok-bot');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  client=new WebSocket('ws://127.0.0.1:'+address.port+'/guest-browser?ticket='+f.display.transport.issue(f.id).ticket,{headers:{'x-display-fixture':'yes'}});await new Promise<void>((resolve,reject)=>{client!.once('open',()=>resolve());client!.once('error',reject);});
  const roundtrip=async(value:number)=>{const message=new Promise<Buffer>(resolve=>client!.once('message',data=>resolve(Buffer.from(data as Buffer))));client!.send(Buffer.from([value]));assert.deepEqual(await message,Buffer.from([value]));};
  await roundtrip(23);await f.display.release(browser);assert.equal(f.events.includes('stop'),false);await roundtrip(29);const closed=new Promise<void>(resolve=>client!.once('close',()=>resolve()));await f.display.release(desktop);await closed;assert.equal(f.events.filter(v=>v==='stop').length,1);
 }finally{client?.terminate();f.dispose();for(const socket of sockets)socket.destroy();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Disposal blocks late profile work and no display-only path can report a running browser',async()=>{
 const f=fixture(),gate=deferred();try{f.hooks.profile=()=>gate.promise;const opening=f.display.acquire(f.id,'browser').catch(error=>error);await until(()=>f.events.includes('profile'));f.dispose();gate.resolve();assert.ok(await opening instanceof Error);assert.equal(f.events.includes('start'),false);assert.equal(f.display.info(f.id).browserRunning,false);await assert.rejects(f.display.acquire(f.id,'browser'),{code:'CLOSING'});}finally{gate.resolve();f.dispose();}
});

test('Display acquisition validates owners and stopped sessions before issuing guest work',async()=>{
 const f=fixture();try{await assert.rejects(f.display.acquire(f.id,'foreign' as 'browser'),{code:'DISPLAY_OWNER_INVALID'});f.env.state='stopped';await assert.rejects(f.display.acquire(f.id,'browser'),{code:'DISPLAY_SESSION_CHANGED'});assert.deepEqual(f.events,[]);}finally{f.dispose();}
});

test('Production display-only driver verifies fixed service bytes and never launches Chrome or reads browser profiles',async()=>{
 const commands:{args:string[];input?:string}[]=[],runtime={management:async(_config:WindowsConfig,args:string[],options?:{input?:string})=>{commands.push({args,input:options?.input});return JSON.stringify({version:1,state:'verified'});},serviceStreamFactory:async()=>()=>new PassThrough()},driver=createWindowsDisplayDriver(runtime as never),entry={environment:{cpus:2} as Environment,config:{} as WindowsConfig,sessionId:'fixture',password:'fixture8',ready:false,closed:false,streams:new Set<PassThrough>()};
 await driver.verify(entry,{});await driver.start(entry,{});await driver.channel(entry,{});await driver.check(entry,{});await driver.stop(entry);
 const text=commands.map(v=>v.input??v.args.join(' ')).join('\n');assert.ok(text.includes('Description=MuCodeSandbox Windows guest display'));assert.equal(text.includes('systemctl start mucodesandbox-browser.service'),false);assert.equal(text.includes('/home/dev/.local/share/mucodesandbox/browser'),false);assert.equal(text.includes('MU_PREFS'),false);assert.ok(text.includes('property=MainPID'));assert.ok(text.includes('property=ActiveState'));assert.ok(VERIFY_WINDOWS_DISPLAY_COMPONENTS.includes('bin/Xvnc'));assert.equal(VERIFY_WINDOWS_DISPLAY_COMPONENTS.includes('chrome-sandbox'),false);
 parseWindowsDisplayReady('{"version":1,"state":"verified"}');for(const value of ['invalid','{}','{"version":1,"state":"verified","pid":3}'])assert.throws(()=>parseWindowsDisplayReady(value),{code:'DISPLAY_RECEIPT_INVALID'});
 const root=await mkdtemp(path.join(tmpdir(),'mu-display-program-'));try{const script=path.join(root,'program.py');await writeFile(script,windowsDisplayReadyProgram(2)+'\n'+VERIFY_WINDOWS_DISPLAY_COMPONENTS.split("<<'MU_DISPLAY_COMPONENTS'\n")[1].split('\nMU_DISPLAY_COMPONENTS')[0]);await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I','-c',"import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf8'),'display-program','exec')",script],{windowsHide:true,timeout:10000});}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-display-program-/);await rm(root,{recursive:true,force:true});}
 assert.ok(windowsDisplayLauncher('fixture8',2).includes(' -interface 127.0.0.1 '));assert.equal(startWindowsDisplay('fixture8',2).includes('systemctl start mucodesandbox-browser.service'),false);
});

test('Production display service checker rejects changed files, identities and stale process facts',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-display-service-check-'));
 try{const script=path.join(root,'service.py'),unit=path.join(root,'unit.txt'),launcher=path.join(root,'launcher.txt'),cases=path.join(root,'cases');await import('node:fs/promises').then(f=>f.mkdir(cases));await writeFile(script,windowsDisplayServiceProgram(2)+'\nprint(json.dumps(dict(version=1,state="verified")))\n');await writeFile(unit,startWindowsDisplay('fixture8',2,true).split("<<'MU_UNIT'\n")[1].split('\nMU_UNIT')[0]+'\n');await writeFile(launcher,windowsDisplayLauncher('fixture8',2,true));
  const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-display-service.py'),script,cases,unit,launcher],{windowsHide:true,timeout:20000,maxBuffer:1048576})).stdout);assert.equal(result.complete,true);assert.equal(result.checks.length,20);assert.equal(result.readOnlyFileBytesPreserved,true);assert.equal(result.executedClient,false);assert.equal(result.actualLinux,false);console.log(JSON.stringify({diagnostic:'windows-display-service',...result}));
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-display-service-check-/);await rm(root,{recursive:true,force:true});}
});

test('A desktop-only display can stop before any Chrome unit has ever existed',async()=>{
 const runtime={management:async(_config:WindowsConfig,_args:string[],options?:{input?:string})=>{if(options?.input?.includes('mucodesandbox-browser.service'))throw Error('Synthetic Chrome unit does not exist');return '';},serviceStreamFactory:async()=>()=>new PassThrough()},driver=createWindowsDisplayDriver(runtime as never);
 await driver.stop({environment:{cpus:2} as Environment,config:{} as WindowsConfig,sessionId:'fixture',password:'fixture8',ready:true,closed:false,streams:new Set()});
});
