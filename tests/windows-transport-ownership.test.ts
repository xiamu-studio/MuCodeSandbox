import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {windowsConfigSchema,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {GuardInspection} from '../server/platform/windows/session.ts';
import {WindowsTransportDiagnostics} from '../server/platform/windows/transport-diagnostics.ts';

// Exercise the production runtime and network-session ownership. Only the OS
// process, SSH preparation and VM/guard effects are explicit adapters.
class ForwardingChild extends EventEmitter {
 stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();
 exitCode:number|null=null;signalCode:NodeJS.Signals|null=null;kills:(NodeJS.Signals|number|undefined)[]=[];
 kill(signal?:NodeJS.Signals|number){this.kills.push(signal);return true;}
 finish(){if(this.exitCode!==null)return;this.exitCode=1;this.emit('exit',1,null);this.emit('close',1,null);}
}
class Runtime extends HyperVRuntime {
 children:ForwardingChild[]=[];active=false;stops=0;revokes=0;autoReady=true;
 protected override forwardingProcess(_args:string[]){const child=new ForwardingChild();this.children.push(child);if(this.autoReady)queueMicrotask(()=>child.stdout.write('MU_PROXY_SESSION_READY\n'));return child as unknown as ChildProcessWithoutNullStreams;}
 override async configure(_c:WindowsConfig){return randomUUID();}
 override async inspectGuard(_c:WindowsConfig):Promise<GuardInspection>{return {digest:'a'.repeat(64),leaseActive:this.active,remainingMs:this.active?45000:0};}
 override async lease(_c:WindowsConfig,_token:string,action:'activate'|'renew'|'revoke'){if(action==='revoke'){this.active=false;this.revokes++;}else this.active=true;}
 override async stop(_c:WindowsConfig){this.stops++;}
}
const config=()=>windowsConfigSchema.parse({version:1,id:'12345678-1234-4234-8234-123456789012',image:'C:/SyntheticOnly/base.vhdx',imageSha256:'a'.repeat(64),proxy:{mode:'http',address:'127.0.0.1',port:12345},expectedIp:'203.0.113.10'});
function fixture(){
 const runtime=new Runtime('C:/SyntheticOnly/transport'),c=config();
 mock.method(runtime as unknown as {ssh(c:WindowsConfig):Promise<string[]>},'ssh',async()=>['synthetic-destination']);
 const start=async()=>{const session=await runtime.session(c,async()=>[{receiver:'a',ip:c.expectedIp},{receiver:'b',ip:c.expectedIp}]);await runtime.connect(c);await session.open();return session;};
 const close=async()=>{for(const child of runtime.children)child.finish();await runtime.disconnect(c.id);};
 return {runtime,c,start,close};
}
test('The current owned forwarding child exit still revokes and independently stops its session',async()=>{
 const f=fixture();try{const session=await f.start();assert.equal(session.state,'active');f.runtime.children[0].finish();await session.fail();assert.equal(session.state,'failed');assert.equal(f.runtime.revokes,1);assert.equal(f.runtime.stops,1);}finally{await f.close();}
});
test('The existing forwarding stdout retains guest categories after readiness without controlling admission',async()=>{
 const f=fixture();try{
  const session=await f.start(),child=f.runtime.children[0];
  child.stdout.write('MU_GUEST_PROXY:FOL');child.stdout.write('LOWING\nMU_GUEST_PROXY:RESET\n');
  let value=session.driver.transportDiagnostics!()!;assert.equal(value.guestProxy?.state,'following');assert.equal(value.guestProxy?.failures.RESET,1);assert.equal(value.failures.TRANSPORT_RESET,undefined);assert.equal(session.state,'active');
  child.stdout.write('MU_GUEST_PROXY:UNAVAILABLE\nPRIVATE_ADDRESS_TOKEN\n');assert.equal(session.state,'active');value=session.driver.transportDiagnostics!()!;assert.equal(value.guestProxy?.state,'unavailable');assert.equal(JSON.stringify(value).includes('PRIVATE'),false);
  const closing=f.runtime.disconnect(f.c.id);child.stdout.write('MU_GUEST_PROXY:TLS\n');child.finish();await closing;
  assert.equal(session.driver.transportDiagnostics!()!.guestProxy?.failures.TLS,undefined,'intentional close freezes guest evidence too');
 }finally{await f.close();}
});
test('A process error after readiness immediately retires its owning session even without an exit event',async()=>{
 const f=fixture();try{
  const session=await f.start(),child=f.runtime.children[0];
  assert.doesNotThrow(()=>child.emit('error',new Error('synthetic process failure')));
  assert.equal(session.state,'failed');assert.equal(f.runtime.revokes,1);assert.equal(f.runtime.stops,1);
  assert.equal(session.driver.transportDiagnostics?.()?.failures.PROCESS_ERROR,1);
  child.finish();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.runtime.stops,1);assert.equal(f.runtime.revokes,1);
 }finally{await f.close();}
});
test('A forwarding stdin error cannot escape and interrupt the fail-closed shutdown',async()=>{
 const f=fixture();try{
  const session=await f.start(),child=f.runtime.children[0];
  assert.doesNotThrow(()=>child.stdin.emit('error',Object.assign(new Error('synthetic broken pipe'),{code:'EPIPE'})));
  assert.equal(session.state,'failed','the pipe error alone must retire the session before child exit');
  assert.equal(f.runtime.revokes,1);assert.equal(f.runtime.stops,1);
  assert.equal(session.driver.transportDiagnostics?.()?.failures.CONTROL_PIPE_ERROR,1,'the owned control-pipe failure must remain diagnosable after teardown');
  child.finish();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(session.state,'failed');assert.equal(f.runtime.revokes,1);assert.equal(f.runtime.stops,1);
 }finally{await f.close();}
});
test('A diagnostic exception cannot prevent a control-pipe error from stopping the session',async t=>{
 const f=fixture();try{
  const session=await f.start(),child=f.runtime.children[0];
  t.mock.method(WindowsTransportDiagnostics.prototype,'controlPipeError',()=>{throw Error('synthetic diagnostic failure');});
  assert.doesNotThrow(()=>child.stdin.emit('error',Object.assign(new Error('synthetic pipe failure'),{code:'EPIPE'})));
  assert.equal(session.state,'failed');assert.equal(f.runtime.revokes,1);assert.equal(f.runtime.stops,1);child.finish();await new Promise<void>(resolve=>setImmediate(resolve));
 }finally{await f.close();}
});
test('A diagnostic exception cannot prevent a process error from stopping the session',async t=>{
 const f=fixture();try{
  const session=await f.start(),child=f.runtime.children[0];
  t.mock.method(WindowsTransportDiagnostics.prototype,'processError',()=>{throw Error('synthetic diagnostic failure');});
  child.emit('error',new Error('synthetic process failure'));
  assert.equal(session.state,'failed');assert.equal(f.runtime.revokes,1);assert.equal(f.runtime.stops,1);
  child.finish();await new Promise<void>(resolve=>setImmediate(resolve));
 }finally{await f.close();}
});
test('An error from the control pipe during intentional disconnect does not trigger protection',async()=>{
 const f=fixture();try{
  const session=await f.start(),child=f.runtime.children[0];
  const closing=f.runtime.disconnect(f.c.id);
  assert.doesNotThrow(()=>child.stdin.emit('error',Object.assign(new Error('synthetic close'),{code:'EPIPE'})));
  assert.doesNotThrow(()=>child.emit('error',new Error('synthetic process close')));
  child.finish();await closing;
  assert.equal(session.state,'active');assert.equal(f.runtime.revokes,0);assert.equal(f.runtime.stops,0);
 }finally{await f.close();}
});
test('A control pipe error before readiness fails the startup and retires its session',async()=>{
 const f=fixture();try{
  f.runtime.autoReady=false;
  const session=await f.runtime.session(f.c,async()=>[{receiver:'a',ip:f.c.expectedIp},{receiver:'b',ip:f.c.expectedIp}]);
  const connecting=f.runtime.connect(f.c);
  await new Promise<void>(resolve=>setImmediate(resolve));
  const child=f.runtime.children[0];assert.ok(child);
  child.stdin.emit('error',Object.assign(new Error('synthetic startup pipe error'),{code:'EPIPE'}));
  assert.equal(session.state,'failed');assert.equal(f.runtime.stops,1);
  child.finish();await assert.rejects(connecting,/SSH egress channel closed/);
  await assert.rejects(session.open(),/Session cannot be reopened/);
 }finally{await f.close();}
});
test('A process error before readiness rejects startup and retires its session',async()=>{
 const f=fixture();try{
  f.runtime.autoReady=false;
  const session=await f.runtime.session(f.c,async()=>[{receiver:'a',ip:f.c.expectedIp},{receiver:'b',ip:f.c.expectedIp}]);
  const connecting=f.runtime.connect(f.c);
  await new Promise<void>(resolve=>setImmediate(resolve));
  const child=f.runtime.children[0];assert.ok(child);
  child.emit('error',new Error('synthetic startup failure'));
  assert.equal(session.state,'failed');assert.equal(f.runtime.stops,1);
  child.finish();await assert.rejects(connecting,/synthetic startup failure/);
  await assert.rejects(session.open(),/Session cannot be reopened/);
 }finally{await f.close();}
});
test('A retired SSH child that outlives the disconnect deadline cannot stop a replacement session',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
 try{
  const previous=await f.start(),old=f.runtime.children[0];const retiring=previous.fail();t.mock.timers.tick(5000);await retiring;
  assert.equal(previous.state,'failed');assert.equal(f.runtime.stops,1);assert.ok(old.kills.includes('SIGKILL'));assert.equal(old.exitCode,null,'old OS child has not reported exit');
  const replacement=await f.start();assert.equal(replacement.state,'active');const stops=f.runtime.stops,revokes=f.runtime.revokes;
  old.stdin.emit('error',Object.assign(new Error('late synthetic broken pipe'),{code:'EPIPE'}));
  old.emit('error',new Error('late synthetic process failure'));
  old.finish();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(replacement.state,'active','late retired exit must not fail the new session');assert.equal(f.runtime.stops,stops);assert.equal(f.runtime.revokes,revokes);assert.equal(f.runtime.active,true);
  f.runtime.children[1].finish();await replacement.fail();assert.equal(replacement.state,'failed');assert.equal(f.runtime.stops,stops+1);assert.equal(f.runtime.revokes,revokes+1);
 }finally{await f.close();t.mock.timers.tick(5000);t.mock.timers.reset();}
});
