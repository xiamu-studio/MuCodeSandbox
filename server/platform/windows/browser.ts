import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket,WebSocketServer} from 'ws';
import type {Environment,BrowserInspection} from '../../../shared/types.ts';
import {displayRequestSchema,type DisplayRequest,type GuestDisplay} from '../../../shared/guest-display.ts';
import {DevTools,DetachedTargetError} from '../../guest-browser.ts';
import {INSPECT_GUEST_BROWSER_SANDBOX,assertGuestBrowserSandbox} from '../../guest-browser-sandbox.ts';
import {dpiScript} from '../../guest-display.ts';
import {configureGuestDisplay} from '../../guest-display-session.ts';
import {resizeVncDisplayStream} from '../../vnc-display.ts';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsConfig} from './config.ts';
import type {WindowsManager} from './manager.ts';
import {VERIFY_WINDOWS_DESKTOP,startWindowsDisplay,startWindowsChrome,STOP_WINDOWS_DISPLAY} from './browser-guest.ts';
import {WINDOWS_CHROME_EXECUTABLE,WINDOWS_CHROME} from './browser-assets.ts';
import {ENSURE_FILE_MANAGER} from '../../guest-file-manager.ts';

export type WindowsBrowserRuntime=Pick<HyperVRuntime,'management'|'serviceStreamFactory'>;
interface Entry{environment:Environment;config:WindowsConfig;sessionId:string;password:string;ready:boolean;closed:boolean;streams:Set<Duplex>;tools?:DevTools;vnc?:()=>Duplex;pages:Map<string,string>;configuration:Set<Promise<void>>;failure?:Error;display?:GuestDisplay;protection?:Promise<void>}
interface Ticket{id:string;sessionId:string;expires:number}

export class WindowsBrowser{
 revokeAudio:((id:string)=>void)|undefined;
 readonly entries=new Map<string,Entry>();readonly tickets=new Map<string,Ticket>();readonly peers=new Map<string,Set<WebSocket>>();
 readonly wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});private pending=new Map<string,number>();private closing=false;
 readonly manager:WindowsManager;readonly runtime:WindowsBrowserRuntime;
 constructor(manager:WindowsManager,runtime:WindowsBrowserRuntime){this.manager=manager;this.runtime=runtime;}
 private current(entry:Entry){return !this.closing&&!entry.closed&&this.entries.get(entry.environment.id)===entry&&this.manager.sessions.get(entry.environment.id)?.id===entry.sessionId&&this.manager.sessions.get(entry.environment.id)?.state==='active';}
 private assertCurrent(entry:Entry){if(!this.current(entry))throw new AppError('浏览器防护会话已撤销',409,'GUARD_FAILED');}
 running(id:string){return this.entries.get(id)?.ready??false;}
 info(id:string){const e=this.entries.get(id);return {running:!!e,ready:e?.ready??false,browserRunning:e?.ready??false,width:e?.display?.width??3200,height:e?.display?.height??2000,platform:'Linux' as const,display:e?.display};}
 private bind(entry:Entry,factory:()=>Duplex){return()=>{this.assertCurrent(entry);const stream=factory();entry.streams.add(stream);stream.once('close',()=>entry.streams.delete(stream));return stream;};}
 async open(id:string,options:RunOptions={}){
  if(this.running(id))return;const e=await this.manager.assertAccess(id,true),session=this.manager.sessions.get(id)!;
  const config=await this.manager.profile(e),entry:Entry={environment:e,config,sessionId:session.id,password:randomBytes(6).toString('base64url'),ready:false,closed:false,streams:new Set(),pages:new Map(),configuration:new Set()};this.entries.set(id,entry);
  const cancel=()=>{if(this.entries.get(id)===entry)this.revoke(id);};options.signal?.addEventListener('abort',cancel,{once:true});
  try{
   await this.runtime.management(config,['bash','-s'],{...options,input:VERIFY_WINDOWS_DESKTOP,timeoutMs:60000});this.assertCurrent(entry);
   await this.runtime.management(config,['bash','-s'],{...options,input:ENSURE_FILE_MANAGER,timeoutMs:30000});this.assertCurrent(entry);
   await this.runtime.management(config,['bash','-s'],{...options,input:startWindowsDisplay(entry.password,e.cpus),timeoutMs:60000});this.assertCurrent(entry);
   entry.vnc=this.bind(entry,await this.runtime.serviceStreamFactory(config,'vnc'));
   await resizeVncDisplayStream(entry.vnc(),entry.password,3200,2000);this.assertCurrent(entry);
   await this.runtime.management(config,['bash','-s'],{...options,input:startWindowsChrome(e),timeoutMs:60000});this.assertCurrent(entry);
   const connect=this.bind(entry,await this.runtime.serviceStreamFactory(config,'cdp')),deadline=Date.now()+45000;
   for(;;){options.signal?.throwIfAborted();this.assertCurrent(entry);try{entry.tools=await DevTools.openStream(connect);break;}catch(error){if(Date.now()>deadline)throw error;await delay(200,undefined,{signal:options.signal});}}
   await this.configure(entry);let failure:unknown;
   for(let attempt=0;attempt<12;attempt++){try{await this.sandbox(entry);failure=undefined;break;}catch(error){failure=error;options.signal?.throwIfAborted();await delay(250,undefined,{signal:options.signal});}}
   if(failure)throw failure;await this.manager.assertAccess(id,true);this.assertCurrent(entry);options.signal?.throwIfAborted();entry.ready=true;
   const tools=entry.tools;tools.socket.once('close',()=>{if(this.entries.get(id)===entry)this.revoke(id);});
   this.manager.store.log(id,null,`Linux AMD64 Chrome ${WINDOWS_CHROME.version} 已通过沙箱检查；初始页面为空白`);
  }catch(error){this.revoke(id);await this.runtime.management(config,['bash','-c',STOP_WINDOWS_DISPLAY],{timeoutMs:20000}).catch(()=>{});throw error;}finally{options.signal?.removeEventListener('abort',cancel);}
 }
 private async configure(entry:Entry){
  const tools=entry.tools!,autoAttach={autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'browser',exclude:true},{type:'tab',exclude:true},{type:'browser_ui',exclude:true},{}]};
  const forget=(id:string)=>{for(const [target,session] of entry.pages)if(session===id)entry.pages.delete(target);};
  tools.detached=parameters=>forget(parameters.sessionId);
  tools.attached=parameters=>{
   const task=(async()=>{this.assertCurrent(entry);if(parameters.targetInfo.type==='page')entry.pages.set(parameters.targetInfo.targetId,parameters.sessionId);await tools.send('Target.setAutoAttach',autoAttach,parameters.sessionId);await tools.send('Runtime.runIfWaitingForDebugger',{},parameters.sessionId);})().catch(error=>{if(error instanceof DetachedTargetError||!tools.activeSessions.has(parameters.sessionId)){forget(parameters.sessionId);return;}if(!this.current(entry))return;entry.failure=error;void this.manager.failProtection(entry.environment.id,'浏览器子进程配置失败').catch(()=>{});});
   entry.configuration.add(task);void task.finally(()=>entry.configuration.delete(task));
  };
  await tools.send('Target.setAutoAttach',autoAttach);while(entry.configuration.size)await Promise.all([...entry.configuration]);
  const targets=await tools.send('Target.getTargets'),page=targets.targetInfos.find((t:{type:string})=>t.type==='page');if(!page)throw Error('Browser has no blank page');
  if(!entry.pages.has(page.targetId))await tools.send('Target.attachToTarget',{targetId:page.targetId,flatten:true});while(entry.configuration.size)await Promise.all([...entry.configuration]);if(entry.failure)throw entry.failure;
  this.page(entry);
 }
 private page(entry:Entry){const value=[...entry.pages.entries()].find(([,id])=>entry.tools?.activeSessions.has(id));if(!value)throw new AppError('浏览器页面尚未就绪',409,'BROWSER_PAGE_MISSING');return {targetId:value[0],sessionId:value[1]};}
 private async sandbox(entry:Entry){this.assertCurrent(entry);const result=await this.runtime.management(entry.config,['sudo','python3','-',WINDOWS_CHROME_EXECUTABLE],{input:INSPECT_GUEST_BROWSER_SANDBOX,timeoutMs:10000,maxBytes:1024*1024});return assertGuestBrowserSandbox(JSON.parse(result));}
 async assertProtection(id:string){
  const entry=this.entries.get(id);if(!entry?.ready)return;if(entry.protection)return entry.protection;
  const inspection=this.sandbox(entry).then(()=>{
   if(this.entries.get(id)!==entry||!entry.ready||entry.closed)return;this.assertCurrent(entry);
  },error=>{if(this.entries.get(id)!==entry||!entry.ready||entry.closed)return;throw error;}).finally(()=>{if(entry.protection===inspection)entry.protection=undefined;});
  entry.protection=inspection;return inspection;
 }
 async inspect(id:string):Promise<BrowserInspection>{
  const entry=this.entries.get(id);if(!entry?.ready)throw new AppError('浏览器未运行',409);this.assertCurrent(entry);
  const result=await entry.tools!.send('Runtime.evaluate',{expression:'JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],platform:navigator.platform,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory??null,screenWidth:screen.width,screenHeight:screen.height})',returnByValue:true},this.page(entry).sessionId);
  const actual=JSON.parse(result.result.value),expectedZone=new Intl.DateTimeFormat('en',{timeZone:entry.environment.identity.timezone}).resolvedOptions().timeZone;
  const locale=new Intl.Locale(actual.locale),expectedLocale=new Intl.Locale(entry.environment.identity.locale),localeMatches=locale.language===expectedLocale.language&&(!locale.region||locale.region===expectedLocale.region);
  return {...actual,webRtcPolicy:'disable_non_proxied_udp',matchesConfiguration:actual.timezone===expectedZone&&actual.language===entry.environment.identity.locale&&localeMatches,checkedAt:new Date().toISOString()};
 }
 async navigate(id:string,url:string){
  const entry=this.entries.get(id);if(!entry?.ready)throw new AppError('浏览器未运行',409);await this.manager.assertAccess(id,true);this.assertCurrent(entry);
  const value=new URL(url);if(!['http:','https:'].includes(value.protocol)||value.username||value.password)throw new AppError('只支持不含账号密码的 HTTP 或 HTTPS 地址',400);
  await entry.tools!.send('Page.navigate',{url:value.href},this.page(entry).sessionId);
 }
 async resize(id:string,input:DisplayRequest){
  const requested=displayRequestSchema.parse(input),entry=this.entries.get(id);if(!entry?.ready||!entry.vnc)throw new AppError('浏览器未运行',409);await this.manager.assertAccess(id,true);
  entry.display=await configureGuestDisplay(entry.display,requested,{assertCurrent:()=>this.assertCurrent(entry),applyDpi:async request=>{await this.runtime.management(entry.config,['sudo','-H','-u','dev','--','python3','-c',dpiScript(request)],{timeoutMs:6000});},
   resizePixels:(width,height)=>resizeVncDisplayStream(entry.vnc!(),entry.password,width,height),readNativeScreen:async()=>{const result=await entry.tools!.send('Runtime.evaluate',{expression:'({width:screen.width,height:screen.height})',returnByValue:true},this.page(entry).sessionId);return result.result.value;},
   resizeBrowserWindow:async(width,height)=>{const window=await entry.tools!.send('Browser.getWindowForTarget',{targetId:this.page(entry).targetId});await entry.tools!.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});await entry.tools!.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{left:0,top:0,width,height}});},waitForDensity:()=>delay(80)});
  return entry.display;
 }
 issue(id:string){
  const entry=this.entries.get(id);if(!entry?.ready)throw new AppError('浏览器未运行',409);this.assertCurrent(entry);
  for(const [key,ticket] of this.tickets)if(ticket.expires<Date.now())this.tickets.delete(key);if(this.tickets.size>=32)throw new AppError('等待连接的画面过多',429);
  const ticket=randomBytes(24).toString('base64url');this.tickets.set(ticket,{id,sessionId:entry.sessionId,expires:Date.now()+15000});return {ticket,password:entry.password};
 }
 async upgrade(request:IncomingMessage,socket:Duplex,head:Buffer,authorize:(request:IncomingMessage)=>boolean){
  const url=new URL(request.url??'/','http://127.0.0.1'),keys=url.searchParams.getAll('ticket'),key=keys[0]??'',ticket=this.tickets.get(key);this.tickets.delete(key);const entry=ticket?this.entries.get(ticket.id):undefined;
  if(url.pathname!=='/guest-browser'||keys.length!==1||!ticket||ticket.expires<Date.now()||!entry?.ready||entry.sessionId!==ticket.sessionId||!authorize(request)||!this.current(entry)){socket.destroy();return;}
  const pending=this.pending.get(ticket.id)??0;if((this.peers.get(ticket.id)?.size??0)+pending>=4||this.wss.clients.size+[...this.pending.values()].reduce((a,b)=>a+b,0)>=16){socket.destroy();return;}
  this.pending.set(ticket.id,pending+1);
  try{
   await this.manager.assertAccess(ticket.id);if(socket.destroyed||!entry.ready||!this.current(entry)){socket.destroy();return;}
   this.wss.handleUpgrade(request,socket,head,ws=>{
    const peers=this.peers.get(ticket.id)??new Set<WebSocket>();peers.add(ws);this.peers.set(ticket.id,peers);let stream:Duplex;try{stream=entry.vnc!();}catch{peers.delete(ws);ws.terminate();return;}
    stream.on('data',data=>{if(!this.current(entry)||ws.bufferedAmount>8*1024*1024){ws.terminate();return;}if(ws.readyState===WebSocket.OPEN)ws.send(data,{binary:true});});
    ws.on('message',(data,binary)=>{if(!binary||!this.current(entry)||stream.writableLength>2*1024*1024){ws.terminate();return;}stream.write(data as Buffer);});
    stream.on('error',()=>ws.terminate());stream.once('close',()=>ws.terminate());ws.once('error',()=>stream.destroy());ws.once('close',()=>{stream.destroy();peers.delete(ws);if(!peers.size&&this.peers.get(ticket.id)===peers)this.peers.delete(ticket.id);});
   });
  }catch{socket.destroy();}finally{const count=(this.pending.get(ticket.id)??1)-1;if(count)this.pending.set(ticket.id,count);else this.pending.delete(ticket.id);}
 }
 revoke(id:string){
  this.revokeAudio?.(id);
  for(const [key,ticket] of this.tickets)if(ticket.id===id)this.tickets.delete(key);for(const peer of this.peers.get(id)??[])peer.terminate();this.peers.delete(id);
  const entry=this.entries.get(id);if(!entry)return;entry.closed=true;entry.ready=false;this.entries.delete(id);entry.tools?.socket.terminate();for(const stream of entry.streams)stream.destroy();entry.streams.clear();
 }
 async close(id:string){const entry=this.entries.get(id);this.revoke(id);if(entry)await this.runtime.management(entry.config,['bash','-c',STOP_WINDOWS_DISPLAY],{timeoutMs:30000});}
 dispose(){this.closing=true;for(const id of this.entries.keys())this.revoke(id);this.tickets.clear();for(const peer of this.wss.clients)peer.terminate();this.wss.close();}
}
