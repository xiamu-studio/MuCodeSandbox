import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Manager} from '../server/manager.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {GuestBrowserHost} from '../server/guest-browser.ts';
import {guestDisplayLaunchScript,ENSURE_DISPLAY_COMPONENTS} from '../server/guest-display-runtime.ts';
import {CURRENT_BROWSER_RELEASE} from '../server/browser-releases.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';

const fallback={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
function environment():Environment{return {...environmentSchema.parse({name:'Display separation',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}}),id:randomUUID(),instanceName:'mu-display-separation',state:'running',lastError:null,browserRunning:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}

test('Desktop startup requests only the display and still checks access and client renderer protection',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-display-manager-')),events:string[]=[];
  const runtime=new LimaRuntime(root);
  runtime.info=async()=>({available:false,path:null,version:null,error:null});
  const browser={...fallback,open:async()=>{throw new Error('Desktop must never start Chrome');},ensureDisplay:async()=>{events.push('display');}};
  const manager=new Manager(root,browser,runtime);clearInterval(manager.protectionTimer);
  manager.assertAccess=async()=>{events.push('access');return undefined;};
  manager.desktop.start=async()=>{events.push('client');};
  manager.desktop.status=async()=>({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'0.68.1',running:true,pid:100,profile:'fixture',rendererProtected:true}]});
  try{
    const e=environment();manager.store.save(e);
    const job=await manager.desktopAction(e.id,'grok-bot','start');await manager.tasks.get(job.id)?.promise;
    assert.equal(manager.store.jobs().find(j=>j.id===job.id)?.status,'succeeded');
    assert.deepEqual(events,['access','display','access','client','access']);
    assert.ok(manager.desktop.tracked.has(e.id));
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

test('Desktop startup waits through an initial renderer replacement before reporting ready',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-renderer-start-'));
  const runtime=new LimaRuntime(root),manager=new Manager(root,fallback,runtime);
  clearInterval(manager.protectionTimer);
  const e=environment();let calls=0,finished=false;
  const samples=[true,false,true,true,false,true,true,true,true];
  manager.desktop.start=async()=>{};
  manager.desktop.finishStart=()=>{finished=true;};
  manager.desktop.status=async()=>{
    assert.equal(manager.desktop.tracked.has(e.id),false,'Do not publish readiness during renderer handover');
    const protectedRenderer=samples[calls++];
    return {supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'fixture',running:true,pid:100,profile:'fixture',rendererProtected:protectedRenderer,issue:protectedRenderer?'':'no-renderer'}]};
  };
  try{
    await manager.launchDesktop(e,'grok-bot');
    assert.equal(calls,9);assert.ok(finished);assert.ok(manager.desktop.tracked.has(e.id));
    manager.desktop.status=async()=>({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'fixture',running:true,pid:100,profile:'fixture',rendererProtected:false,issue:'pid=101 tid=102 seccomp'}]});
    await assert.rejects(manager.desktop.assertProtected(e),/grok-bot：pid=101 tid=102 seccomp/,'Post-start failures still reject access immediately and explain the failing check');
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

test('Display launcher has loopback authenticated graphics and audio but no browser or browser profile',()=>{
  const source=guestDisplayLaunchScript('abcdefgh');
  const launcher=source.slice(source.indexOf('#!/bin/bash'),source.indexOf("| sudo tee /usr/local/libexec/mu-guest-display"));
  assert.match(launcher,/turbovnc-3\.3\.1\/bin\/Xvnc :99/);assert.match(launcher,/-interface 127.0.0.1/);assert.match(launcher,/-securitytypes vnc/);
  assert.match(launcher,/-noclipboardrecv -noclipboardsend -noprimarysync/);assert.match(launcher,/sha256sum --check --status/);assert.match(launcher,/module-null-sink/);
  assert.ok(!launcher.includes('chrome')&&!launcher.includes('chromium')&&!launcher.includes('user-data-dir')&&!launcher.includes('9222'));
  assert.ok(!ENSURE_DISPLAY_COMPONENTS.includes('chromium')&&!ENSURE_DISPLAY_COMPONENTS.includes('chrome'));
  assert.throws(()=>guestDisplayLaunchScript('bad-password-with-$()'));
  assert.throws(()=>guestDisplayLaunchScript('abcdefgh',0));assert.throws(()=>guestDisplayLaunchScript('abcdefgh',5));
});

test('A desktop-only display is not reported as a running browser and browser close preserves display transport and tickets',async()=>{
  const events:string[]=[],runtime=new LimaRuntime('/unused');
  runtime.management=async(_e,_args,options)=>{events.push(options?.input??'');return '';};
  const host=new GuestBrowserHost(runtime,fallback),e=environment();
  const socket=new EventEmitter() as any;socket.readyState=1;
  const tools={socket,send:async(method:string)=>{events.push(method);socket.emit('close');},close:()=>events.push('CDP-close')};
  const entry:any={environment:e,release:CURRENT_BROWSER_RELEASE,password:'abcdefgh',transport:{kill:()=>{throw new Error('Browser close must not kill display transport');}},directory:'/unused',vnc:'/unused',cdp:'/unused',ready:true,browserReady:false,sessions:new Map(),configuration:new Set()};
  host.entries.set(e.id,entry);
  try{
    assert.equal(host.running(e.id),false);assert.equal(host.info(e.id).ready,true);
    const ticket=host.issue(e.id).ticket;
    entry.tools=tools;entry.browserReady=true;assert.equal(host.running(e.id),true);
    await host.closeApplication(e.id);
    assert.equal(host.running(e.id),false);assert.equal(host.entries.get(e.id),entry);assert.equal(entry.ready,true);
    assert.ok(host.tickets.has(ticket));assert.equal(entry.tools,undefined);
    assert.ok(events.includes('Browser.close'));
    assert.ok(events.some(e=>e.includes('stop mucodesandbox-browser.service')));
    assert.ok(!events.some(e=>e.includes('stop mucodesandbox-display.service')||e.includes('rm -rf')));
  }finally{host.entries.clear();await host.dispose();}
});
