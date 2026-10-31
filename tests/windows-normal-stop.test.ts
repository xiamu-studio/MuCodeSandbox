import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WindowsNetworkSession,type GuardDriver} from '../server/platform/windows/session.ts';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {PREPARE_WINDOWS_NORMAL_STOP} from '../server/platform/windows/normal-stop.ts';
import {run} from '../server/process.ts';
import {runWindowsSsh} from '../server/platform/windows/ssh-process.ts';
function gate<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
function fixture(){const events:string[]=[];let active=false;const driver:GuardDriver={inspect:async()=>({digest:'a'.repeat(64),leaseActive:active,remainingMs:active?45000:0}),probe:async()=>[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}],activate:async()=>{active=true;},renew:async()=>{events.push('renew');},disconnect:async()=>{events.push('disconnect');},revoke:async()=>{events.push('revoke');active=false;},stop:async()=>{events.push('stop');}};return {events,driver,session:new WindowsNetworkSession(driver,'203.0.113.10')};}
test('Normal stop confirms both independent egress closures before application preparation and force-off',async()=>{
 const f=fixture(),disconnected=gate(),revoked=gate(),prepared=gate(),entered=gate();await f.session.open();
 f.driver.disconnect=async()=>{f.events.push('disconnect');await disconnected.promise;};f.driver.revoke=async()=>{f.events.push('revoke');await revoked.promise;};
 const closing=f.session.stopNormally(async()=>{f.events.push('prepare');entered.resolve();await prepared.promise;});
 assert.equal(f.session.state,'failed');assert.deepEqual(f.session.verifiedReceipts,[]);await Promise.resolve();await Promise.resolve();assert.equal(f.events.includes('prepare'),false);
 disconnected.resolve();await Promise.resolve();assert.equal(f.events.includes('prepare'),false);revoked.resolve();await entered.promise;assert.equal(f.events.includes('stop'),false);prepared.resolve();await closing;
 assert.ok(f.events.indexOf('prepare')>f.events.indexOf('revoke'));assert.ok(f.events.indexOf('stop')>f.events.indexOf('prepare'));
});
for(const failure of ['disconnect','revoke','prepare'] as const)test('Normal '+failure+' failure still confirms independent force-off',async()=>{
 const f=fixture();await f.session.open();if(failure!=='prepare')f.driver[failure]=()=>{f.events.push(failure);throw Error('Synthetic synchronous cleanup failure');};
 await f.session.stopNormally(async()=>{f.events.push('prepare');if(failure==='prepare')throw Error('Synthetic close failure');});
 assert.equal(f.events.includes('stop'),true);assert.equal(f.events.includes('prepare'),failure==='prepare');assert.ok(f.events.includes('disconnect')&&f.events.includes('revoke'));assert.ok(f.session.cleanupWarnings.length>0);
});
for(const held of ['disconnect','revoke','prepare'] as const)test('Normal stop deadline cannot be held by '+held,async()=>{
 const f=fixture(),never=new Promise<void>(()=>{});await f.session.open();if(held!=='prepare')f.driver[held]=async()=>{await never;};
 // The ordinary gate may be stuck, but the independent stop must start at the
 // deadline. fail() also awaits cleanup receipts, so release those separately.
 const stopped=gate();f.driver.stop=async()=>{f.events.push('stop');stopped.resolve();};let calls=0;
 if(held!=='prepare')f.driver[held]=async()=>{if(++calls===1)await never;};
 await f.session.stopNormally(async()=>{f.events.push('prepare');if(held==='prepare')await never;},30);
 await stopped.promise;assert.equal(f.events.includes('stop'),true);assert.equal(f.events.includes('prepare'),held==='prepare');
});
test('Explicit protection failure interrupts browser preparation without waiting for it',async()=>{
 const f=fixture(),entered=gate();await f.session.open();let signal:AbortSignal|undefined;
 const closing=f.session.stopNormally(async value=>{signal=value;entered.resolve();await new Promise<void>(()=>{});});await entered.promise;
 const failing=f.session.fail();assert.equal(signal!.aborted,true);assert.equal(f.events.includes('stop'),true);await failing;await closing;
});
test('A retired probe cannot renew or turn intentional disconnect into a second fault',async()=>{
 const f=fixture(),probe=gate<{receiver:string;ip:string}[]>(),prepared=gate(),entered=gate();await f.session.open();f.driver.probe=()=>probe.promise;
 const inspecting=f.session.tick();await Promise.resolve();await Promise.resolve();
 let faults=0;f.session.onFailure=()=>faults++;const closing=f.session.stopNormally(async()=>{entered.resolve();await prepared.promise;});await entered.promise;probe.resolve([{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}]);await inspecting;
 assert.equal(faults,0);assert.equal(f.events.includes('renew'),false);assert.equal(f.events.includes('stop'),false);prepared.resolve();await closing;
});

test('A probe finishing after normal stop completed cannot create a false protection incident',async()=>{
 const f=fixture(),probe=gate<{receiver:string;ip:string}[]>(),entered=gate();await f.session.open();
 let faults=0;f.session.onFailure=()=>faults++;f.driver.probe=()=>{entered.resolve();return probe.promise;};
 const inspecting=f.session.tick().then(()=>null,error=>error);await entered.promise;
 await f.session.stopNormally(async()=>{});
 probe.resolve([{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}]);
 assert.equal(await inspecting,null);assert.equal(faults,0);assert.equal(f.events.includes('renew'),false);
});

test('Normal stop cancels an in-flight probe rather than waiting for its command timeout',async()=>{
 const f=fixture(),entered=gate(),release=gate<{receiver:string;ip:string}[]>();await f.session.open();
 let probeSignal:AbortSignal|undefined,cancelled=0,faults=0;f.session.onFailure=()=>faults++;
 f.driver.probe=signal=>{probeSignal=signal;entered.resolve();return new Promise((resolve,reject)=>{
  release.promise.then(resolve);signal?.addEventListener('abort',()=>{cancelled++;reject(Error('Synthetic probe cancelled'));},{once:true});
 });};
 const inspecting=f.session.tick().then(()=>null,error=>error);await entered.promise;
 try{
  await f.session.stopNormally(async()=>{});
  assert.ok(probeSignal?.aborted);assert.equal(cancelled,1);assert.equal(await inspecting,null);
  assert.equal(faults,0);assert.equal(f.events.includes('renew'),false);
 }finally{release.resolve([{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}]);await inspecting;await f.session.fail();}
});

test('Normal session stop closes three real disposable probe processes',{timeout:8000},async()=>{
 const f=fixture(),entered=gate();await f.session.open();let ready=0,workers:Promise<string>[]=[];
 f.driver.probe=signal=>{
  workers=Array.from({length:3},()=>runWindowsSsh(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000);"],{signal,timeoutMs:5000,onOutput:text=>{if(text==='ready'&&++ready===3)entered.resolve();}}));
  return Promise.all(workers).then(()=>[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:'203.0.113.10'}]);
 };
 const inspecting=f.session.tick().then(()=>null,error=>error);await entered.promise;
 await f.session.stopNormally(async()=>{});assert.equal(await inspecting,null);
 const outcomes=await Promise.allSettled(workers);assert.equal(outcomes.length,3);
 for(const result of outcomes){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason.code,'CANCELLED');}
 assert.equal(f.events.includes('renew'),false);
});

for(const stage of ['inspect','renew'] as const)test(`Normal stop cancels in-flight guard ${stage} without cancelling teardown`,async()=>{
 const f=fixture(),entered=gate();await f.session.open();let operationSignal:AbortSignal|undefined;
 const hold=(signal?:AbortSignal)=>new Promise<never>((_resolve,reject)=>{operationSignal=signal;entered.resolve();signal?.addEventListener('abort',()=>reject(Error('Synthetic operation cancelled')),{once:true});});
 if(stage==='inspect')f.driver.inspect=hold;else f.driver.renew=hold;
 let faults=0;f.session.onFailure=()=>faults++;
 const inspecting=f.session.tick().then(()=>null,error=>error);await entered.promise;await f.session.stopNormally(async()=>{});
 assert.ok(operationSignal?.aborted);assert.equal(await inspecting,null);assert.equal(faults,0);
 assert.ok(f.events.includes('disconnect')&&f.events.includes('revoke')&&f.events.includes('stop'));
});
test('Failed sessions never attempt application preparation, and failed force-off stays an error',async()=>{
 const f=fixture();await f.session.open();f.driver.stop=async()=>{throw Error('Unconfirmed off');};await assert.rejects(f.session.fail());
 await assert.rejects(f.session.stopNormally(async()=>{assert.fail('No preparation after protection failure');}));
});
test('Normal guest helper closes only current browser-unit windows and refuses changed identities',async()=>{
 const result=JSON.parse(await run('python',['-I','tests/fixtures/windows-normal-stop.py'],{input:PREPARE_WINDOWS_NORMAL_STOP,timeoutMs:5000}));
 assert.equal(result.productionHelper,true);assert.equal(result.realGuest,false);assert.equal(result.checks.length,8);assert.ok(result.checks.every((value:{passed:boolean})=>value.passed));
});
test('Runtime normal-stop command keeps a bounded isolated environment and rejects invalid or cancelled acknowledgements',async()=>{
 const controller=new AbortController();let calls=0,reply='{"version":1,"browser":"closed"}';
 const runtime={management:async(_config:unknown,command:string[],options:{signal:AbortSignal;timeoutMs:number;maxBytes:number})=>{calls++;assert.deepEqual(command.slice(0,8),['sudo','-n','-H','-u','dev','--','env','-i']);assert.equal(command.at(-1),PREPARE_WINDOWS_NORMAL_STOP);assert.equal(options.signal,controller.signal);assert.equal(options.timeoutMs,4500);assert.equal(options.maxBytes,1024);return reply;}} as unknown as HyperVRuntime;
 await HyperVRuntime.prototype.prepareNormalStop.call(runtime,{} as never,{signal:controller.signal});reply='{"version":1,"browser":"closed","unexpected":"private"}';await assert.rejects(HyperVRuntime.prototype.prepareNormalStop.call(runtime,{} as never,{signal:controller.signal}));
 controller.abort();await assert.rejects(HyperVRuntime.prototype.prepareNormalStop.call(runtime,{} as never,{signal:controller.signal}));assert.equal(calls,2);
});
