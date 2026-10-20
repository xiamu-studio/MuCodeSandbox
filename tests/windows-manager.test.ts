import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {Store} from '../server/store.ts';import {WindowsManager,type WindowsBackend} from '../server/platform/windows/manager.ts';
import {WindowsNetworkSession} from '../server/platform/windows/session.ts';import {windowsPaths} from '../server/platform/windows/config.ts';
const input=()=>({name:'Windows fixture',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,username:'',password:'fixture-secret',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-win-manager-'));const store=new Store(path.join(root,'app'),Buffer.alloc(32,5));
 const states=new Map<string,{state:string;active:boolean;digest:string}>();let badProbe=false;
 const state=(id:string)=>{let s=states.get(id);if(!s){s={state:'Off',active:false,digest:'a'.repeat(64)};states.set(id,s);}return s;};
 const backend:WindowsBackend={info:async()=>({available:true,issues:[]}),create:async c=>{const p=windowsPaths(root,c.id);await mkdir(p.directory,{recursive:true});await writeFile(p.manifest,JSON.stringify({id:c.id}));},start:async c=>{state(c.id).state='Running';},stop:async c=>{state(c.id).state='Off';state(c.id).active=false;},state:async c=>({state:state(c.id).state}),
 inspectGuard:async c=>({digest:state(c.id).digest,leaseActive:state(c.id).active,remainingMs:state(c.id).active?45000:0}),
 connect:async c=>{assert.equal(state(c.id).active,false);},
 session:async c=>{const s=state(c.id);s.active=false;return new WindowsNetworkSession({inspect:async()=>({digest:s.digest,leaseActive:s.active,remainingMs:s.active?45000:0}),probe:async()=>[{receiver:'a',ip:'203.0.113.10'},{receiver:'b',ip:badProbe?'203.0.113.11':'203.0.113.10'}],activate:async()=>{s.active=true;},renew:async()=>{},revoke:async()=>{s.active=false;},disconnect:async()=>{},stop:async()=>{s.state='Off';s.active=false;}},c.expectedIp);}};
 const manager=new WindowsManager(store,backend,{runtimeRoot:root,base:{image:path.join(root,'base.vhdx'),imageSha256:'a'.repeat(64)}});
 return {manager,store,state,bad:()=>{badProbe=true;},close:async()=>{await manager.close();await rm(root,{recursive:true,force:true});}};
}
test('Windows lifecycle reaches running only after closed-start and exit approval',async()=>{const f=await fixture();try{const e=await f.manager.create(input());assert.equal(e.network.password,undefined);const job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);assert.equal(f.store.get(e.id).state,'running');assert.equal((await f.manager.protection(e.id)).integrity,'verified');const stopped=await f.manager.action(e.id,'stop');await f.manager.wait(stopped.id);assert.equal(f.store.get(e.id).state,'stopped');assert.equal(f.state(e.id).state,'Off');}finally{await f.close();}});
test('A conflicting receiver fails the job and confirms stop instead of advertising running',async()=>{const f=await fixture();try{f.bad();const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);assert.equal(f.store.get(e.id).state,'error');assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.jobs().find(j=>j.id===job.id)?.status,'failed');}finally{await f.close();}});
test('Access checks quarantine changed integrity; startup recovery stops leftover VMs',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);f.state(e.id).digest='b'.repeat(64);await assert.rejects(f.manager.assertAccess(e.id));assert.equal(f.state(e.id).state,'Off');f.state(e.id).state='Running';await f.manager.recover();assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'stopped');}finally{await f.close();}});
test('Windows profile edits preserve omitted credentials and reject unprotected modes',async()=>{const f=await fixture();try{await assert.rejects(f.manager.create({...input(),network:{mode:'direct'}}));const e=await f.manager.create(input()),edited=input();delete (edited.network as {password?:string}).password;await f.manager.update(e.id,edited);assert.equal(f.store.get(e.id).network.password,'fixture-secret');assert.equal((await f.manager.snapshot()).environments[0].network.password,undefined);}finally{await f.close();}});

test('Unreachable guard inspection immediately quarantines the VM',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);f.manager.runtime.inspectGuard=async()=>{throw Error('unreachable');};await assert.rejects(f.manager.assertAccess(e.id),{code:'GUARD_FAILED'});assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'error');}finally{await f.close();}});

test('Host monitoring failure stops active VMs and prevents another start',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);await f.manager.hostUnavailable('fixture host event');assert.equal(f.state(e.id).state,'Off');await assert.rejects(f.manager.action(e.id,'start'),{code:'HOST_NETWORK_CHANGED'});assert.equal((await f.manager.snapshot()).system.hostNetwork?.state,'failed');}finally{await f.close();}});

test('An unconfirmed stopped VM cannot have its network profile edited',async()=>{const f=await fixture();try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);const stop=await f.manager.action(e.id,'stop');await f.manager.wait(stop.id);f.state(e.id).state='Running';await assert.rejects(f.manager.update(e.id,input()),{code:'STOP_UNCONFIRMED'});}finally{await f.close();}});

test('Shutdown drains an in-flight monitor before closing the store',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 try{const e=await f.manager.create(input()),job=await f.manager.action(e.id,'start');await f.manager.wait(job.id);
  const inspect=f.manager.runtime.inspectGuard;const session=f.manager.sessions.get(e.id)!;session.driver.inspect=async()=>{await gate;return inspect(await f.manager.profile(f.store.get(e.id)));};
  const monitoring=f.manager.monitor();let closed=false;const closing=f.manager.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);release();await monitoring;await closing;assert.equal(closed,true);
 }finally{release();await f.close();}
});

test('A long browser job keeps renewing protection and sandbox failure still quarantines it',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 try{const e=await f.manager.create(input()),start=await f.manager.action(e.id,'start');await f.manager.wait(start.id);let renewals=0;f.manager.sessions.get(e.id)!.driver.renew=async()=>{renewals++;};
  const job=await f.manager.submit(e.id,'open-browser',async()=>gate);await f.manager.monitor();assert.equal(renewals,1);assert.equal(f.state(e.id).state,'Running');
  f.manager.inspectAdditionalProtection=async()=>{throw Error('Browser sandbox changed');};await f.manager.monitor();assert.equal(f.state(e.id).state,'Off');assert.equal(f.store.get(e.id).state,'error');release();await f.manager.wait(job.id);
 }finally{release();await f.close();}
});
