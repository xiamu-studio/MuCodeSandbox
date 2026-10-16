import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.ts';
import { GuestBrowserHost } from '../server/guest-browser.ts';
import { LocalChecks } from '../server/local-check.ts';
import { Manager } from '../server/manager.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { Environment } from '../shared/types.ts';
import type { LimaRuntime } from '../server/runtime.ts';
import { RESET_BROWSER_PROFILE_SCRIPT } from '../server/browser-reset.ts';

const fallback:BrowserHost={native:false,available:async()=>false,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};

test('Browser reset rejects missing confirmation, missing authentication and foreign origins before data access',async()=>{
  const owned=await mkdtemp(path.join(homedir(),'.mu-reset-api-'));
  const service=await createService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:owned,port:0,browser:fallback});
  const e=await service.manager.create({name:'Synthetic reset API'});service.manager.store.state(e.id,'running');
  let calls=0;service.manager.assertAccess=async()=>undefined;service.manager.browser.reset=async()=>{calls++;};
  const url=`${service.url}/api/environments/${e.id}/browser/reset`;
  const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'erase-browser-profile'})})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://foreign.test'},body:JSON.stringify({confirm:'erase-browser-profile'})})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,400);
    assert.equal(calls,0);
    const allowed=await fetch(url,{method:'POST',headers,body:JSON.stringify({confirm:'erase-browser-profile'})});assert.equal(allowed.status,202);
    const job=await allowed.json();await service.manager.tasks.get(job.id)?.promise;assert.equal(calls,1);
    assert.equal(service.manager.store.jobs().find(j=>j.id===job.id)?.status,'succeeded');
    const snapshot=await(await fetch(`${service.url}/api/snapshot`,{headers})).json();
    assert.equal(snapshot.system.application.channel,'source-preview');assert.ok(!JSON.stringify(snapshot).includes(service.token));
  }finally{await service.close();await rm(owned,{recursive:true,force:true});}
});

test('Reset revokes only the selected viewer tickets before issuing its fixed guest operation',async()=>{
  const runtime={management:async(e:Environment,_args:string[],options:any)=>{
    assert.equal(e.id,'reset-a');assert.equal(options.input,RESET_BROWSER_PROFILE_SCRIPT);
    assert.equal(host.tickets.has('old-selected'),false);assert.equal(host.tickets.has('other-environment'),true);
    return '';
  }} as unknown as LimaRuntime;
  const host=new GuestBrowserHost(runtime,fallback);
  host.tickets.set('old-selected',{id:'reset-a',expires:Date.now()+1000});host.tickets.set('other-environment',{id:'reset-b',expires:Date.now()+1000});
  let authorization=0;host.authorize=async()=>{authorization++;};
  try{await host.reset({id:'reset-a',kind:'vm',state:'running'} as Environment);assert.equal(authorization,2);}
  finally{await host.dispose();}
});

test('Reset cannot issue guest deletion when access authorization fails',async()=>{
  let guestAccess=false;
  const host=new GuestBrowserHost({management:async()=>{guestAccess=true;return '';}} as unknown as LimaRuntime,fallback);
  host.authorize=async()=>{throw new Error('permission revoked');};
  try{await assert.rejects(host.reset({id:'reset-a',kind:'vm',state:'running'} as Environment),/permission revoked/);assert.equal(guestAccess,false);}
  finally{await host.dispose();}
});

test('Background local checks do not publish or focus a viewer while their environment job is busy',async()=>{
  const host=new GuestBrowserHost({} as LimaRuntime,fallback);host.focus=async()=>true;let published=0;
  host.onOpen=async()=>{published++;};host.entries.set('background',{ready:true,browserReady:true} as any);
  const e={id:'background',kind:'vm',state:'running'} as Environment;
  try{
    await (host as any).openVersion(e,{},undefined,false);assert.equal(published,0);
    await host.open(e,{},false);assert.equal(published,0);
    await host.open(e);assert.equal(published,1);
    host.authorize=async()=>{throw new Error('revoked');};
    await assert.rejects(host.open(e,{},false),/revoked/);assert.equal(published,1);
  }finally{host.entries.clear();await host.dispose();}
});

test('Browser display mode accepts only a boolean and retains authenticated request checks',async()=>{
  const owned=await mkdtemp(path.join(homedir(),'.mu-browser-mode-api-'));
  const service=await createService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:owned,port:0,browser:fallback});
  const e=await service.manager.create({name:'Display fixture'});const calls:boolean[]=[];
  service.manager.openBrowser=async(_id,showWindow=true)=>{calls.push(showWindow);return {id:'fixture'} as any;};
  const url=`${service.url}/api/environments/${e.id}/browser/open`,headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({showWindow:'false'})})).status,400);
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"showWindow":false}'})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"showWindow":false}'})).status,202);
    assert.equal((await fetch(url,{method:'POST',headers})).status,202);
    assert.deepEqual(calls,[false,true]);
  }finally{await service.close();await rm(owned,{recursive:true,force:true});}
});

test('Account-free checks refuse stopped, direct and host browser environments without opening a receiver',async()=>{
  const owned=await mkdtemp(path.join(homedir(),'.mu-local-check-unit-'));const manager=new Manager(owned,fallback);
  const host=new GuestBrowserHost(manager.runtime,fallback),checks=new LocalChecks(manager,host);
  try{
    const vm=await manager.create({name:'Unconfigured'});
    assert.throws(()=>checks.start(vm.id),{code:'LAB_PROTECTED_VM_REQUIRED'});
    manager.store.state(vm.id,'running');assert.throws(()=>checks.start(vm.id),{code:'LAB_PROTECTED_VM_REQUIRED'});
    const browser=await manager.create({name:'Host',kind:'browser'});manager.store.state(browser.id,'running');
    assert.throws(()=>checks.start(browser.id),{code:'LAB_PROTECTED_VM_REQUIRED'});
    assert.equal(checks.reports.size,0);assert.equal(manager.tasks.size,0);
  }finally{await host.dispose();await manager.close();await rm(owned,{recursive:true,force:true});}
});
