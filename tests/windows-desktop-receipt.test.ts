import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GuestDesktop} from '../server/guest-desktop.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import {parseRunningDesktopStatus} from '../server/desktop-receipt.ts';
import {Manager} from '../server/manager.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

function environment():Environment{return {...environmentSchema.parse({name:'Desktop receipt fixture',network:{mode:'socks5',host:'127.0.0.1',port:7897,strict:true,transparent:true}}),id:randomUUID(),instanceName:'mu-desktop-receipt-fixture',state:'running',browserRunning:false,lastError:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
function receipt(){return {supported:true,apps:(['grok-bot','claude-desktop'] as const).map(id=>({id,installed:false,installedVersion:null as string|null,running:false,pid:0,profile:'/home/dev/.local/share/mucodesandbox/desktop-clients/'+id,rendererProtected:null as boolean|null,issue:''})),displaySharedWithBrowser:true,accountTested:false};}
function harness(){const runtime=new LimaRuntime('unused-desktop-receipt-fixture'),desktop=new GuestDesktop(runtime),e=environment();let value:unknown=receipt();runtime.management=async()=>JSON.stringify(value);desktop.tracked.add(e.id);return {desktop,e,set:(next:unknown)=>{value=next;}};}

test('Incomplete desktop status cannot silently retire protection monitoring',async()=>{
 const h=harness();h.set({...receipt(),apps:[]});
 await assert.rejects(h.desktop.assertProtected(h.e),{code:'DESKTOP_RECEIPT_INVALID'});
 assert.equal(h.desktop.tracked.has(h.e.id),true);
});

test('Desktop inspection rejects malformed identities, paths and contradictory process claims',async t=>{
 const cases:{name:string;change:(v:ReturnType<typeof receipt>)=>void}[]=[
  {name:'missing client',change:v=>{v.apps.pop();}},
  {name:'duplicate client',change:v=>{v.apps[1]={...v.apps[0]};}},
  {name:'foreign profile',change:v=>{v.apps[0].profile='/home/dev/other-client';}},
  {name:'running without installation',change:v=>{v.apps[0].running=true;v.apps[0].pid=42;v.apps[0].rendererProtected=true;}},
  {name:'live pid while stopped',change:v=>{v.apps[0].pid=42;}},
  {name:'installed without version',change:v=>{v.apps[0].installed=true;}},
  {name:'protected stopped process',change:v=>{v.apps[0].rendererProtected=true;}},
  {name:'unknown receipt field',change:v=>{Object.assign(v,{trusted:true});}},
  {name:'unknown client field',change:v=>{Object.assign(v.apps[0],{trusted:true});}},
 ];
 for(const c of cases)await t.test(c.name,async()=>{const h=harness(),value=receipt();c.change(value);h.set(value);await assert.rejects(h.desktop.status(h.e),{code:'DESKTOP_RECEIPT_INVALID'});assert.equal(h.desktop.tracked.has(h.e.id),true);});
});

test('Complete desktop receipts preserve active protection and recognize a normal close',async()=>{
 const h=harness(),value=receipt();Object.assign(value.apps[0],{installed:true,installedVersion:'0.68.1',running:true,pid:42,rendererProtected:true});h.set(value);
 await h.desktop.assertProtected(h.e);assert.equal(h.desktop.tracked.has(h.e.id),true);
 value.apps[0].rendererProtected=false;await assert.rejects(h.desktop.assertProtected(h.e),{code:'DESKTOP_SANDBOX_FAILED'});assert.equal(h.desktop.tracked.has(h.e.id),true);
 Object.assign(value.apps[0],{running:false,pid:0,rendererProtected:null});await h.desktop.assertProtected(h.e);assert.equal(h.desktop.tracked.has(h.e.id),false);
});

test('Stopped environments do not issue a desktop guest command',async()=>{
 const h=harness();h.e.state='stopped';h.set({unexpected:true});
 const value=await h.desktop.status(h.e);assert.deepEqual(value.apps,[]);assert.equal(value.supported,true);
});

test('Desktop receipt decode failures stay bounded and never echo untrusted details',()=>{
 for(const text of ['null','[]','{','{"secret":"MU_SYNTHETIC_PRIVATE_VALUE"}',JSON.stringify({padding:'x'.repeat(16385)})]){
  assert.throws(()=>parseRunningDesktopStatus(text),(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='DESKTOP_RECEIPT_INVALID'&&!error.message.includes('MU_SYNTHETIC_PRIVATE_VALUE')&&error.message.length<100);
 }
});

test('Desktop receipt failure reaches the real manager revocation and stop path without lease renewal',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-receipt-manager-')),runtime=new LimaRuntime(root);
 let stopped=0,revoked=0,renewed=0;
 runtime.diskMaintenancePending=async()=>false;runtime.sharedMountMaintenancePending=async()=>false;
 runtime.networkProtection=async()=>({active:true} as Awaited<ReturnType<LimaRuntime['networkProtection']>>);
 runtime.management=async()=>JSON.stringify({...receipt(),apps:[]});
 runtime.stop=async()=>{stopped++;};runtime.renewLease=async()=>{renewed++;};runtime.revokeLease=async()=>{};
 const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
 const manager=new Manager(root,browser,runtime);clearInterval(manager.protectionTimer);
 try{
  const e=environment();manager.store.save(e);manager.desktop.tracked.add(e.id);manager.onQuarantine=async()=>{revoked++;};
  await manager.monitorProtection();
  assert.equal(stopped,1);assert.ok(revoked>=1);assert.equal(renewed,0);
  assert.equal(manager.store.get(e.id).state,'error');assert.match(manager.store.get(e.id).lastError??'',/状态回执无法核对/);
  assert.equal(manager.desktop.tracked.has(e.id),true);
 }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});
