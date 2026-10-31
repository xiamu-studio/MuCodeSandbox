import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {watchWindowsDesktopOwner} from '../server/platform/windows/desktop-owner.ts';
const require=createRequire(import.meta.url),{launchOrigin,allowedRequest,workerEnvironment,statusDocument,startupStatus}=require('../desktop/windows/policy.cjs'),{createController}=require('../desktop/windows/controller.cjs');
const token='A'.repeat(43),launch=`http://127.0.0.1:12345/?launch=${token}`;
const {createStartupHealth}=require('../desktop/windows/startup-health.cjs');

function healthFixture(write?: (value:unknown)=>void,windowState?:()=>unknown){
 const records:any[]=[],timers=new Map<number,()=>void>();let tick=0,next=0;
 const health=createStartupHealth({write:write??((value:unknown)=>records.push(value)),windowState,clock:()=>tick,schedule:(callback:()=>void)=>{const id=++next;timers.set(id,callback);return id;},cancel:(id:number)=>timers.delete(id)});
 const frame={url:'http://127.0.0.1:12345/'},web={mainFrame:frame},window={isDestroyed:()=>false,webContents:web},event={sender:web,senderFrame:frame};
 return {health,records,timers,event,window,advance(){tick+=15000;for(const callback of [...timers.values()])callback();timers.clear();}};
}

test('Startup diagnostics distinguish missing DOM content from page load and cancel old navigation timers',()=>{
 const f=healthFixture();const status=f.health.begin('status');f.health.note('dom-ready');f.health.note('load-finished');assert.equal(f.timers.size,0);
 const workspace=f.health.begin('workspace');f.health.loadFailed(status,{errno:-3,message:'secret launch URL'});
 assert.equal(f.records.at(-1).event,'navigation-superseded');assert.equal(f.records.at(-1).requestNavigation,status);
 f.advance();assert.equal(f.records.at(-1).event,'ui-content-pending');assert.equal(f.records.at(-1).navigation,workspace);
 f.health.begin('workspace');assert.equal(f.timers.size,1);f.health.begin('status');assert.equal(f.timers.size,0);
});

test('Only the current local main frame may acknowledge startup DOM content and it is recorded once',()=>{
 const f=healthFixture();assert.equal(f.health.rendered(f.event,f.window,'http://127.0.0.1:12345'),false);f.health.begin('workspace');
 for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{url:f.event.senderFrame.url}}])assert.equal(f.health.rendered(event,f.window,'http://127.0.0.1:12345'),false);
 for(const url of ['https://example.test/','http://127.0.0.1:12345/api/snapshot']){f.event.senderFrame.url=url;assert.equal(f.health.rendered(f.event,f.window,'http://127.0.0.1:12345'),false);}
 f.event.senderFrame.url='http://127.0.0.1:12345/';assert.equal(f.health.rendered(f.event,f.window,'http://127.0.0.1:12345'),true);assert.equal(f.timers.size,1);
 assert.equal(f.health.rendered(f.event,f.window,'http://127.0.0.1:12345'),false);assert.equal(f.records.filter(r=>r.event==='ui-dom-content').length,1);
});

test('Blank-startup followup records bounded native window facts without trusting text or positions',()=>{
 const f=healthFixture(undefined,()=>({visible:true,focused:false,minimized:false,loadingMainFrame:false,backgroundThrottling:true,contentWidth:1280,contentHeight:900,x:321,y:654,title:'SECRET',url:'https://private.test/',pixels:'PRIVATE'}));
 f.health.begin('workspace');assert.equal(f.health.rendered(f.event,f.window,'http://127.0.0.1:12345'),true);f.advance();
 const record=f.records.at(-1);assert.equal(record.event,'window-state');assert.equal(record.trigger,'dom-followup');assert.equal(record.visible,true);assert.equal(record.focused,false);assert.equal(record.contentWidth,1280);assert.equal(record.contentHeight,900);assert.equal(record.backgroundThrottling,true);
 assert.doesNotMatch(JSON.stringify(f.records),/SECRET|PRIVATE|private\.test|"x":|"y":|pixels|title|url/);
});

test('Navigation and disposal cancel blank-startup followup; native state errors cannot obstruct diagnostics',()=>{
 const f=healthFixture(undefined,()=>{throw Error('Native window already closed');});f.health.begin('workspace');assert.equal(f.health.rendered(f.event,f.window,'http://127.0.0.1:12345'),true);
 f.health.begin('status');f.advance();assert.equal(f.records.filter(r=>r.trigger==='dom-followup').length,0);
 f.health.begin('workspace');f.health.rendered(f.event,f.window,'http://127.0.0.1:12345');f.health.dispose();assert.equal(f.timers.size,0);
 const invalid=healthFixture(undefined,()=>({visible:1,contentWidth:Infinity,contentHeight:-1}));invalid.health.note('window-state',{trigger:'SECRET'});
 assert.deepEqual(Object.keys(invalid.records[0]).sort(),['elapsedMs','event','kind','navigation','version']);
});

test('Startup diagnostics retain categories and numeric results without page text, URLs or credentials',()=>{
 const f=healthFixture(),secret='https://private.test/?launch=SECRET_BEARER&text=PERSONAL';f.health.begin('workspace');
 for(const message of ['ReferenceError '+secret,'Content Security Policy '+secret,'Failed to fetch dynamically imported module '+secret])f.health.note('renderer-console',{category:f.health.consoleCategory(message),message,url:secret});
 f.health.note('renderer-gone',{reason:'crashed',code:134,details:secret});f.health.loadFailed(1,{errno:-105,message:secret});
 f.health.note('worker-phase',{phase:'authorizing'});f.health.note('unknown',{url:secret});
 const serialized=JSON.stringify(f.records);assert.doesNotMatch(serialized,/SECRET|PERSONAL|private\.test/);assert.deepEqual(f.records.filter(r=>r.event==='renderer-console').map(r=>r.category),['ReferenceError','csp','module-load']);
 assert.equal(f.records.at(-1).phase,'authorizing');assert.ok(f.records.some(r=>r.code===134&&r.reason==='crashed'));
});

test('Disk failure cannot obstruct startup diagnostics and each launch has a strict event budget',()=>{
 const broken=healthFixture(()=>{throw Error('Synthetic disk full');});assert.doesNotThrow(()=>{broken.health.begin('workspace');broken.advance();broken.health.rendered(broken.event,broken.window,'http://127.0.0.1:12345');});
 const f=healthFixture();for(let n=0;n<1000;n++)f.health.note('unresponsive');assert.equal(f.records.length,256);f.health.dispose();assert.equal(f.timers.size,0);
});

test('Desktop window authority stays on validated worker IPC and is rejected in recovery mode',async t=>{
 for(const scenario of ['normal','invalid-key','recovery'] as const)await t.test(scenario,async()=>{const root=await mkdtemp(path.join(tmpdir(),'mu-host-window-key-')),entry=path.join(root,'worker.cjs'),key=scenario==='invalid-key'?'invalid':'a'.repeat(64);await writeFile(entry,`process.on('message',value=>{if(value.type==='start')process.send({version:1,type:'ready',pid:process.pid,url:${JSON.stringify(launch)},hostLabWindowKey:${JSON.stringify(key)}});if(value.type==='shutdown')process.send({version:1,type:'stopped'},()=>process.exit(0));});`);const controller=createController({entry,node:process.execPath,rootDir:root,mode:scenario==='recovery'?'recovery':'normal'});
  try{if(scenario==='normal')assert.equal((await controller.ready).hostLabWindowKey,key);else await assert.rejects(controller.ready,/authority/);}finally{await controller.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-host-window-key-/);await rm(root,{recursive:true,force:true});}
 });
});

function fullscreenFixture(){
 let focused=true,normal=true,epoch=0,active=true,fullscreen=false,gate:undefined|(()=>Promise<void>),url='http://127.0.0.1:23456/';
 const changes:boolean[]=[],notifications:boolean[]=[],frame={url,isDestroyed:()=>false},web={mainFrame:frame,isDestroyed:()=>false,getURL:()=>url,async executeJavaScriptInIsolatedWorld(world:number,_scripts:unknown,gesture:boolean){assert.equal(world,1001);assert.equal(gesture,false);await gate?.();return active;}};
 const window=Object.assign(new EventEmitter(),{webContents:web,isDestroyed:()=>false,isFocused:()=>focused,isFullScreen:()=>fullscreen,setFullScreen(value:boolean){fullscreen=value;changes.push(value);window.emit(value?'enter-full-screen':'leave-full-screen');}}),event={sender:web,senderFrame:frame};
 const controller=require('../desktop/windows/viewer-fullscreen.cjs').createViewerFullscreenController({getState:()=>({window,origin:'http://127.0.0.1:23456',normal,epoch}),notify:(sender:unknown,value:boolean)=>{assert.equal(sender,web);notifications.push(value);}});
 window.on('leave-full-screen',()=>controller.nativeLeft());
 return{window,event,controller,changes,notifications,get fullscreen(){return fullscreen;},set fullscreen(value:boolean){fullscreen=value;},set active(value:boolean){active=value;},set focused(value:boolean){focused=value;},set normal(value:boolean){normal=value;},set epoch(value:number){epoch=value;},set gate(value:(()=>Promise<void>)|undefined){gate=value;},set url(value:string){url=value;frame.url=value;}};
}
test('Viewer fullscreen needs a focused normal main frame and real activation before native entry',async()=>{
 const f=fullscreenFixture();for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{url:f.event.senderFrame.url}}])await assert.rejects(f.controller.handle(event,true));
 f.focused=false;await assert.rejects(f.controller.handle(f.event,true));f.focused=true;f.normal=false;await assert.rejects(f.controller.handle(f.event,true));f.normal=true;f.url='http://127.0.0.1:23456/foreign';await assert.rejects(f.controller.handle(f.event,true));f.url='http://127.0.0.1:23456/';f.active=false;await assert.rejects(f.controller.handle(f.event,true));assert.deepEqual(f.changes,[]);
 f.active=true;assert.equal(await f.controller.handle(f.event,true),true);assert.deepEqual(f.changes,[true]);assert.deepEqual(f.notifications,[true]);f.focused=false;assert.equal(await f.controller.handle(f.event,false),false);assert.deepEqual(f.changes,[true,false]);
});
test('Viewer fullscreen rejects arbitrary payloads and restores an already fullscreen host window',async()=>{
 const f=fullscreenFixture();for(const payload of [null,1,'true',{},[]])await assert.rejects(f.controller.handle(f.event,payload));assert.deepEqual(f.changes,[]);
 f.fullscreen=true;await f.controller.handle(f.event,true);await f.controller.handle(f.event,false);assert.equal(f.fullscreen,true);assert.deepEqual(f.changes,[]);assert.deepEqual(f.notifications,[true,false]);
});
test('A mode or navigation change revokes pending native fullscreen activation',async()=>{
 const f=fullscreenFixture();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve);f.gate=()=>{enter();return new Promise<void>(resolve=>release=resolve);};
 const pending=f.controller.handle(f.event,true);await entered;await assert.rejects(f.controller.handle(f.event,true));f.epoch=1;f.controller.reset();release();await assert.rejects(pending);assert.deepEqual(f.changes,[]);
});
test('Unmount cleanup cancels fullscreen before an activation check finishes',async()=>{
 const f=fullscreenFixture();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve);f.gate=()=>{enter();return new Promise<void>(resolve=>release=resolve);};
 const pending=f.controller.handle(f.event,true);await entered;await f.controller.handle(f.event,false);release();await assert.rejects(pending);assert.deepEqual(f.changes,[]);
});
test('Leaving native fullscreen clears viewer ownership without reopening the window',async()=>{
 const f=fullscreenFixture();f.fullscreen=true;await f.controller.handle(f.event,true);f.window.setFullScreen(false);assert.equal(f.fullscreen,false);assert.deepEqual(f.notifications,[true,false]);f.controller.reset();assert.deepEqual(f.changes,[false]);
});
test('Reset restores native fullscreen after the viewer loses its current mode',async()=>{
 const f=fullscreenFixture();await f.controller.handle(f.event,true);f.normal=false;f.controller.reset();assert.deepEqual(f.changes,[true,false]);assert.deepEqual(f.notifications,[true,false]);
});
test('Windows desktop accepts only its exact loopback service and confines renderer requests',()=>{
 const origin=launchOrigin(launch);assert.equal(origin,'http://127.0.0.1:12345');for(const value of [launch.replace('127.0.0.1','localhost'),launch.replace('127.0.0.1','127.0.0.1.evil'),launch.replace('http:','https:'),launch+'&other=1',launch.replace('/?','/api?')])assert.throws(()=>launchOrigin(value));
 assert.equal(allowedRequest(origin,origin+'/api/snapshot'),true);assert.equal(allowedRequest(origin,'ws://127.0.0.1:12345/terminal'),true);assert.equal(allowedRequest(origin,'blob:'+origin+'/download'),true);for(const value of ['file:///C:/Windows/win.ini','https://example.test','http://127.0.0.1:12346/','data:text/html,external'])assert.equal(allowedRequest(origin,value),false);assert.equal(allowedRequest(origin,origin+'/api/snapshot',true),false);assert.equal(allowedRequest(origin,origin+'/',true),true);
});
test('Desktop workers do not inherit Node injection, Electron runtime or proxy environment variables',()=>{
 const env=workerEnvironment({SystemRoot:'C:\\Windows',NODE_OPTIONS:'--require=outside',ELECTRON_RUN_AS_NODE:'1',HTTP_PROXY:'http://secret.invalid',PATHEXT:'.MAL',USERPROFILE:'C:\\Users\\fixture'},{NODE_OPTIONS:'outside',MU_WINDOWS_APP_DIR:'C:\\fixture\\app'});assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(env.HTTP_PROXY,undefined);assert.equal(env.PATHEXT,'.COM;.EXE;.BAT;.CMD');assert.equal(env.MU_WINDOWS_APP_DIR,'C:\\fixture\\app');
});
test('Desktop status messages escape markup and permit no remote scripts',()=>{const html=statusDocument('<img src=x>','<script>alert(1)</script>');assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<script>'));assert.ok(html.includes("default-src 'none'"));});

test('Startup states distinguish authorization from verified service loading and reject unknown phases',()=>{
 for(const mode of ['normal','recovery']){assert.match(startupStatus(mode,'authorizing').detail,/如 Windows 显示/);assert.match(startupStatus(mode,'connecting').detail,/启动请求已返回/);assert.match(startupStatus(mode,'initializing').detail,/管理组件已核验/);assert.doesNotMatch(startupStatus(mode,'initializing').detail,/管理员确认/);}
 for(const phase of ['unknown','__proto__','constructor','<script>'])assert.equal(startupStatus('normal',phase),null);
});

test('Startup progress stops at ready and cannot replace the workspace with a late authorization screen',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-startup-phases-')),entry=path.join(root,'worker.cjs');await writeFile(entry,`process.on('message',value=>{if(value.type==='start'){for(const phase of ['checking','building','installing','authorizing','connecting','initializing','unknown','__proto__'])process.send({version:1,type:'status',phase});process.send({version:1,type:'ready',pid:process.pid,url:${JSON.stringify(launch)}});setTimeout(()=>{process.send({version:1,type:'status',phase:'authorizing'});process.send({version:1,type:'mode-request',mode:'normal'});},30);}if(value.type==='shutdown')process.send({version:1,type:'stopped'},()=>process.exit(0));});`);
 const controller=createController({node:process.execPath,entry,rootDir:root,mode:'recovery'}),phases:string[]=[];controller.events.on('status',(phase:string)=>phases.push(phase));let late!:()=>void;const delivered=new Promise<void>(resolve=>late=resolve);controller.events.on('mode-request',()=>late());
 try{await controller.ready;await delivered;assert.deepEqual(phases,['checking','building','installing','authorizing','connecting','initializing']);await controller.close();await controller.exited;}finally{controller.terminate();await controller.exited;assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
async function fixture(mode:string){
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-desktop-')),entry=path.join(root,'worker.cjs');await writeFile(entry,`let attempts=0;process.on('message',message=>{if(message.type==='start')process.send({version:1,type:'ready',pid:process.pid,url:${JSON.stringify(mode==='bad-url'?'https://example.test/':launch)}});if(message.type==='shutdown'){attempts++;if(${JSON.stringify(mode)}==='no-receipt')process.exit(0);else if(${JSON.stringify(mode)}==='retry'&&attempts===1)process.send({version:1,type:'stop-error',message:'Synthetic unconfirmed stop'});else process.send({version:1,type:'stopped'},()=>{process.disconnect();process.exit(0)});}});`);
 const controller=createController({node:process.execPath,entry,rootDir:root});return{controller,cleanup:async()=>{controller.terminate();await controller.exited;assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};
}
test('Desktop shutdown waits for the worker receipt and actual process exit',async()=>{const f=await fixture('normal');try{const ready=await f.controller.ready;assert.equal(ready.origin,'http://127.0.0.1:12345');await f.controller.close();await f.controller.exited;}finally{await f.cleanup();}});
test('An exited worker without a stop receipt never becomes confirmed shutdown',async()=>{const f=await fixture('no-receipt');try{await f.controller.ready;await assert.rejects(f.controller.close());await assert.rejects(f.controller.close());}finally{await f.cleanup();}});
test('Unconfirmed stops can be retried without starting another worker',async()=>{const f=await fixture('retry');try{const ready=await f.controller.ready;await assert.rejects(f.controller.close());await f.controller.close();assert.equal(f.controller.pid,ready.pid);}finally{await f.cleanup();}});
test('A worker cannot redirect the desktop to a nonlocal launch URL',async()=>{const f=await fixture('bad-url');try{await assert.rejects(f.controller.ready);}finally{await f.cleanup();}});

for(const failure of ['missing-executable','missing-directory'] as const)test('A worker spawn failure settles termination and permits cleanup: '+failure,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-spawn-')),entry=path.join(root,'worker.cjs');await writeFile(entry,'throw Error("Unreachable synthetic worker");');
 const controller=createController({node:failure==='missing-executable'?path.join(root,'missing-node.exe'):process.execPath,entry,rootDir:failure==='missing-directory'?path.join(root,'missing'):root});
 const failures:Error[]=[],exits:unknown[]=[];controller.events.on('failure',(error:Error)=>failures.push(error));controller.events.on('exit',(value:unknown)=>exits.push(value));
 const bounded=async(promise:Promise<unknown>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Spawn failure left termination pending')),1500);})]);}finally{clearTimeout(timer);}};
 try{
  await assert.rejects(controller.ready);assert.equal(controller.pid,undefined);await bounded(controller.exited);
  await bounded(controller.close());await bounded(controller.close());assert.equal(failures.length,1);assert.equal(exits.length,1);
 }finally{controller.terminate();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-windows-spawn-/);await rm(root,{recursive:true,force:true});}
});

test('Worker exit and stream closure publish exactly one terminal event',async()=>{
 const f=await fixture('normal'),exits:unknown[]=[];f.controller.events.on('exit',(value:unknown)=>exits.push(value));
 try{await f.controller.ready;await f.controller.close();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(exits.length,1);}
 finally{await f.cleanup();}
});
test('Only an explicitly selected recovery worker may request a return to normal mode',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-mode-')),entry=path.join(root,'worker.cjs');await writeFile(entry,`process.on('message',message=>{if(message.type==='start'){process.send({version:1,type:'mode-request',mode:'normal'});process.send({version:1,type:'ready',pid:process.pid,url:${JSON.stringify(launch)}});}if(message.type==='shutdown')process.send({version:1,type:'stopped'},()=>process.exit(0));});`);
 try{for(const mode of ['normal','recovery']){const controller=createController({node:process.execPath,entry,rootDir:root,mode});const requests:string[]=[];controller.events.on('mode-request',(value:string)=>requests.push(value));try{await controller.ready;assert.deepEqual(requests,mode==='recovery'?['normal']:[]);await controller.close();}finally{controller.terminate();await controller.exited;}}}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('The OS owner watcher notices a killed owner independently of inherited IPC handles',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-owner-')),entry=path.join(root,'owner.cjs');await writeFile(entry,'setInterval(()=>{},1000)');const owner=fork(entry,[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});let watch:Awaited<ReturnType<typeof watchWindowsDesktopOwner>>|undefined;
 try{let resolveExit!:()=>void;const exited=new Promise<void>(resolve=>{resolveExit=resolve;});watch=await watchWindowsDesktopOwner(owner.pid!,resolveExit);owner.kill('SIGKILL');await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('OS desktop ownership was not revoked')),5000))]);}finally{watch?.stop();owner.kill('SIGKILL');assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
