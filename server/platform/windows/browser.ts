import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
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
import type {WindowsNetworkSession} from './session.ts';
import {verifyWindowsDesktop,startWindowsDisplay,startWindowsChrome,STOP_WINDOWS_DISPLAY,STOP_WINDOWS_DISPLAY_AFTER_CLOSE,STOP_WINDOWS_CHROME} from './browser-guest.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';
import {WindowsDisplayTransport} from './display-transport.ts';
import type {WindowsDisplayLifecycle,WindowsDisplayLease,WindowsPreparedDisplay} from './display-lifecycle.ts';
import {ENSURE_FILE_MANAGER} from '../../guest-file-manager.ts';
import {BrowserStartupTiming} from './browser-timing.ts';
import {windowsBrowserStartupPlan,applyWindowsBrowserStartup,prepareWindowsBrowserHome,type WindowsBrowserStartup} from './browser-startup.ts';
import {RESET_WINDOWS_BROWSER_PROFILE_SCRIPT,RECOVER_WINDOWS_BROWSER_RESET_SCRIPT,INSPECT_WINDOWS_BROWSER_RESET_SCRIPT,windowsBrowserResetState} from './browser-reset.ts';
import {WINDOWS_BROWSER_REPAIR_STATE_PYTHON,windowsBrowserRepairState} from './browser-repair.ts';
import type {WindowsBrowserComponentRecovery} from './browser-repair-service.ts';
import {runWindowsBrowserCheck,WindowsBrowserCheckFailure} from './local-check-browser.ts';
import {WINDOWS_BROWSER_PROFILE_INSPECT,parseWindowsBrowserProfile,assertWindowsBrowserProfile} from './browser-profile.ts';
import {WINDOWS_BROWSER_SELECTION_INSPECT,parseWindowsBrowserSelection,assertWindowsBrowserProduct} from './browser-selection.ts';
import {windowsBrowserReleaseRoot} from './browser-releases.ts';

export type WindowsBrowserRuntime=Pick<HyperVRuntime,'management'|'serviceStreamFactory'>;
interface Entry{environment:Environment;config:WindowsConfig;sessionId:string;selectedVersion:string;password:string;ready:boolean;closed:boolean;streams:Set<Duplex>;tools?:DevTools;vnc?:()=>Duplex;pages:Map<string,string>;configuration:Set<Promise<void>>;failure?:Error;display?:GuestDisplay;protection?:Promise<void>;checkContexts?:Set<string>;checkRunning?:boolean;checkBlocked?:boolean;sharedLease?:WindowsDisplayLease;sharedEntry?:WindowsPreparedDisplay;chromeAttempted?:boolean}
type DisplayTransport=Pick<WindowsDisplayTransport<Entry>,'issue'|'upgrade'|'revoke'|'dispose'|'wss'|'peers'>;

export class WindowsBrowser{
 revokeAudio:((id:string)=>void)|undefined;
 readonly entries=new Map<string,Entry>();readonly transport:DisplayTransport;
 readonly tickets:WindowsDisplayTransport<Entry>['tickets']|WindowsDisplayLifecycle['transport']['tickets'];readonly peers:WindowsDisplayTransport<Entry>['peers'];
 readonly wss:WindowsDisplayTransport<Entry>['wss'];private closing=false;
 private openings=new Map<string,{controller:AbortController;promise?:Promise<void>}>();
 private closeTasks=new Map<string,Promise<void>>();
 private closingEntries=new Map<string,Entry>();
 private stopFailures=new Map<string,{session:WindowsNetworkSession;config:WindowsConfig;entry?:Entry}>();
 readonly manager:WindowsManager;readonly runtime:WindowsBrowserRuntime;readonly resetEnabled:boolean;
 readonly componentRecovery?:WindowsBrowserComponentRecovery;
 readonly sharedDisplay?:WindowsDisplayLifecycle;private unsubscribeDisplay?:()=>void;
 constructor(manager:WindowsManager,runtime:WindowsBrowserRuntime,resetEnabled=false,componentRecovery?:WindowsBrowserComponentRecovery,sharedDisplay?:WindowsDisplayLifecycle){this.manager=manager;this.runtime=runtime;this.resetEnabled=resetEnabled;this.componentRecovery=componentRecovery;this.sharedDisplay=sharedDisplay;const transport=sharedDisplay?.transport??new WindowsDisplayTransport(this.entries,entry=>this.current(entry),id=>this.manager.assertAccess(id));this.transport=transport;this.tickets=transport.tickets;this.peers=transport.peers;this.wss=transport.wss;this.unsubscribeDisplay=sharedDisplay?.subscribeRevoked(id=>{if(this.entries.get(id)?.sharedEntry)this.revoke(id);});}
 private current(entry:Entry){return !this.closing&&!entry.closed&&this.entries.get(entry.environment.id)===entry&&this.manager.sessions.get(entry.environment.id)?.id===entry.sessionId&&this.manager.sessions.get(entry.environment.id)?.state==='active'&&(!entry.sharedEntry||this.sharedDisplay?.readyEntry(entry.environment.id)===entry.sharedEntry);}
 private assertCurrent(entry:Entry){if(!this.current(entry))throw new AppError('浏览器防护会话已撤销',409,'GUARD_FAILED');}
 running(id:string){const entry=this.entries.get(id);return !!entry?.ready&&this.current(entry);}
 info(id:string){const candidate=this.entries.get(id),e=candidate&&this.current(candidate)?candidate:undefined,shared=this.sharedDisplay?.info(id),display=this.sharedDisplay?.readyEntry(id)?.display??e?.display;return {running:shared?.running??!!e,ready:shared?.ready??e?.ready??false,browserRunning:e?.ready??false,width:display?.width??3200,height:display?.height??2000,platform:'Linux' as const,display};}
 private bind(entry:Entry,factory:()=>Duplex){return()=>{this.assertCurrent(entry);const stream=factory();entry.streams.add(stream);stream.once('close',()=>entry.streams.delete(stream));return stream;};}
 async open(id:string,options:RunOptions={},startup:WindowsBrowserStartup='blank'){
  if(this.closing)throw new AppError('浏览器组件正在退出',409,'CLOSING');options.signal?.throwIfAborted();
  if(this.openings.has(id))throw new AppError('浏览器正在准备，请等待当前操作结束',409,'BROWSER_BUSY');
  const opening:{controller:AbortController;promise?:Promise<void>}={controller:new AbortController()},session=this.manager.sessions.get(id);
  this.openings.set(id,opening);
  const signal=options.signal?AbortSignal.any([options.signal,opening.controller.signal]):opening.controller.signal;
  const task=this.openEntry(id,{...options,signal},startup,session,opening).finally(()=>{if(this.openings.get(id)===opening)this.openings.delete(id);});opening.promise=task;return task;
 }
 private async openEntry(id:string,options:RunOptions,startup:WindowsBrowserStartup,session:WindowsNetworkSession|undefined,opening:{controller:AbortController}){
  const timing=new BrowserStartupTiming();
  await this.closeTasks.get(id);
  const assertOpening=()=>{options.signal?.throwIfAborted();if(this.closing||this.openings.get(id)!==opening||!session||this.manager.sessions.get(id)!==session||session.state!=='active'||this.manager.store.get(id).state!=='running')throw new AppError('浏览器防护会话已撤销',409,'GUARD_FAILED');};
  assertOpening();const unresolved=this.stopFailures.get(id);if(unresolved){if(unresolved.session===session)throw new AppError('浏览器停止尚未确认，请先停止环境后重试',409,'BROWSER_STOP_UNCONFIRMED');this.stopFailures.delete(id);}
  const e=await this.manager.assertAccess(id,true,options.signal);assertOpening();
  const previous=this.entries.get(id);
  if(previous){if(this.current(previous)){
   if(!previous.ready)throw new AppError('浏览器正在准备，请等待当前操作结束',409,'BROWSER_BUSY');
   try{const selected=await this.runtime.management(previous.config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_SELECTION_INSPECT],{...options,timeoutMs:20000,maxBytes:2048});assertOpening();this.assertCurrent(previous);if(!previous.ready)throw new AppError('浏览器会话已变化，请重新打开',409,'BROWSER_BUSY');if(parseWindowsBrowserSelection(selected)!==previous.selectedVersion)throw new AppError('浏览器版本选择已变化，请停止后重新打开',409,'BROWSER_SELECTION_CHANGED');return;}
   catch(error){if(!options.signal?.aborted&&this.entries.get(id)===previous&&this.current(previous)){this.detachEntry(id);await this.stopEntry(id,previous,session!);}throw error;}
  }this.detachEntry(id);}
  const startPage=windowsBrowserStartupPlan(e.browserUrl,startup);
  const config=await this.manager.profile(e);assertOpening();timing.mark();
  if(this.entries.has(id))throw new AppError('浏览器会话已变化，请重新打开',409,'BROWSER_BUSY');
  const entry:Entry={environment:e,config,sessionId:session!.id,selectedVersion:WINDOWS_CHROME.version,password:randomBytes(6).toString('base64url'),ready:false,closed:false,streams:new Set(),pages:new Map(),configuration:new Set()};this.entries.set(id,entry);
  let displayAttempted=false;
  const cancel=()=>{if(this.entries.get(id)===entry)this.detachEntry(id);};options.signal?.addEventListener('abort',cancel,{once:true});
  try{
   // Both reads are independent in the normal case. A pending repair may
   // change the selected version, so discard that read and repeat it after
   // recovery. Wait for both reads even on failure before cleaning up.
   const preflight=await Promise.allSettled([
    this.runtime.management(config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_STATE_PYTHON],{...options,timeoutMs:20000,maxBytes:1024}),
    this.runtime.management(config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_SELECTION_INSPECT],{...options,timeoutMs:20000,maxBytes:2048}),
   ]);this.assertCurrent(entry);options.signal?.throwIfAborted();
   if(preflight[0].status==='rejected')throw preflight[0].reason;
   const repairState=windowsBrowserRepairState(preflight[0].value);let selected:string;
   if(repairState==='pending'){
    if(!this.componentRecovery?.enabled)throw new AppError('浏览器组件恢复尚未完成，浏览器保持关闭；请使用支持恢复的版本处理操作记录',409,'BROWSER_REPAIR_PENDING');
    await this.componentRecovery.resume(id,options);this.assertCurrent(entry);options.signal?.throwIfAborted();
    selected=await this.runtime.management(config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_SELECTION_INSPECT],{...options,timeoutMs:20000,maxBytes:2048});this.assertCurrent(entry);options.signal?.throwIfAborted();
   }else{if(preflight[1].status==='rejected')throw preflight[1].reason;selected=preflight[1].value;}
   entry.selectedVersion=parseWindowsBrowserSelection(selected);
   // All operations are read-only. Join all before proceeding even if one
   // fails, so a late inspection cannot outlive cleanup or publish a browser.
   const inspections=await Promise.allSettled([
    this.runtime.management(config,['bash','-s'],{...options,input:verifyWindowsDesktop(entry.selectedVersion),timeoutMs:60000}),
    this.runtime.management(config,['bash','-s'],{...options,input:INSPECT_WINDOWS_BROWSER_RESET_SCRIPT,timeoutMs:20000}),
    this.runtime.management(config,['sudo','-H','-u','dev','--','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_PROFILE_INSPECT],{...options,timeoutMs:20000,maxBytes:2048}),
   ]);this.assertCurrent(entry);options.signal?.throwIfAborted();
   if(inspections[0].status==='rejected')throw inspections[0].reason;
   if(inspections[1].status==='rejected')throw inspections[1].reason;
   const resetState=windowsBrowserResetState(inspections[1].value);
   let profile:string;
   if(resetState==='pending'){
    if(!this.resetEnabled)throw new AppError('浏览器资料重置尚未完成，浏览器保持关闭；请使用支持恢复的版本完成清理',409,'BROWSER_RESET_PENDING');
    await this.manager.assertAccess(id,true,options.signal);this.assertCurrent(entry);await this.runtime.management(config,['bash','-s'],{...options,input:RECOVER_WINDOWS_BROWSER_RESET_SCRIPT,timeoutMs:120000});this.assertCurrent(entry);options.signal?.throwIfAborted();await this.manager.assertAccess(id,true,options.signal);this.assertCurrent(entry);
    const remaining=windowsBrowserResetState(await this.runtime.management(config,['bash','-s'],{...options,input:INSPECT_WINDOWS_BROWSER_RESET_SCRIPT,timeoutMs:20000}));this.assertCurrent(entry);options.signal?.throwIfAborted();if(remaining!=='none')throw new AppError('浏览器资料重置仍有待处理记录，请重新确认重置范围后重试',409,'BROWSER_RESET_PENDING');
    profile=await this.runtime.management(config,['sudo','-H','-u','dev','--','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_PROFILE_INSPECT],{...options,timeoutMs:20000,maxBytes:2048});this.assertCurrent(entry);options.signal?.throwIfAborted();
   }else{if(inspections[2].status==='rejected')throw inspections[2].reason;profile=inspections[2].value;}
   const compatibility=parseWindowsBrowserProfile(profile);assertWindowsBrowserProfile(compatibility);if(compatibility.selectedVersion!==entry.selectedVersion)throw new AppError('浏览器版本选择已变化，请重新打开',409,'BROWSER_SELECTION_CHANGED');
   // The preceding inspections and parsing only read state. Validate once at
   // this boundary, immediately before the first guest mutation. Recovery
   // above retains its own checks on both sides of the reset operation.
   await this.manager.assertAccess(id,true,options.signal);this.assertCurrent(entry);options.signal?.throwIfAborted();timing.mark();
   await this.runtime.management(config,['bash','-s'],{...options,input:ENSURE_FILE_MANAGER,timeoutMs:30000});this.assertCurrent(entry);
   if(this.sharedDisplay){
    entry.sharedLease=await this.sharedDisplay.acquire(id,'browser',options);entry.sharedEntry=this.sharedDisplay.readyEntry(id);
    if(!entry.sharedEntry?.vnc)throw new AppError('显示服务会话已变化',409,'DISPLAY_SESSION_CHANGED');this.assertCurrent(entry);
    entry.password=entry.sharedEntry.password;entry.vnc=this.bind(entry,entry.sharedEntry.vnc);
   }else{
    displayAttempted=true;await this.runtime.management(config,['bash','-s'],{...options,input:startWindowsDisplay(entry.password,e.cpus),timeoutMs:60000});this.assertCurrent(entry);
    entry.vnc=this.bind(entry,await this.runtime.serviceStreamFactory(config,'vnc'));
    await resizeVncDisplayStream(entry.vnc(),entry.password,3200,2000);this.assertCurrent(entry);
   }
   timing.mark();timing.browserPhase();entry.chromeAttempted=true;
   await this.runtime.management(config,['bash','-s'],{...options,input:startWindowsChrome(e,entry.selectedVersion),timeoutMs:60000});this.assertCurrent(entry);
   const connect=this.bind(entry,await this.runtime.serviceStreamFactory(config,'cdp')),deadline=Date.now()+45000;
   for(;;){options.signal?.throwIfAborted();this.assertCurrent(entry);try{entry.tools=await DevTools.openStream(connect);break;}catch(error){if(Date.now()>deadline)throw error;await delay(200,undefined,{signal:options.signal});}}
   const actual=await entry.tools.send('Browser.getVersion');this.assertCurrent(entry);options.signal?.throwIfAborted();assertWindowsBrowserProduct(actual?.product,entry.selectedVersion);
   await this.configure(entry);timing.browserPhase();let failure:unknown;
   for(let attempt=0;attempt<12;attempt++){try{await this.sandbox(entry);failure=undefined;break;}catch(error){if(error instanceof AppError&&['BROWSER_SELECTION_CHANGED','BROWSER_SELECTION_RECEIPT'].includes(error.code??''))throw error;failure=error;options.signal?.throwIfAborted();await delay(250,undefined,{signal:options.signal});}}
   // Nonblank startup checks protection before guest publication/navigation.
   // Home preparation only reads a bundled local asset; blank has no startup
   // operation, so it still requires the guard here.
   if(failure)throw failure;timing.browserPhase();if(startPage.kind==='blank')await this.manager.assertAccess(id,true,options.signal);this.assertCurrent(entry);options.signal?.throwIfAborted();
   await applyWindowsBrowserStartup(startPage,{signal:options.signal,assertCurrent:()=>this.assertCurrent(entry),verifyProtection:()=>timing.homeStep('guard',()=>this.manager.assertAccess(id,true,options.signal)),prepareHome:()=>timing.homeStep('prepare',prepareWindowsBrowserHome),installHome:script=>timing.homeStep('install',()=>this.runtime.management(config,['bash','-s'],{...options,input:script,timeoutMs:30000})),navigate:url=>timing.homeStep('navigate',()=>entry.tools!.send('Page.navigate',{url},this.page(entry).sessionId))});
   this.assertCurrent(entry);options.signal?.throwIfAborted();entry.ready=true;timing.browserPhase();timing.mark();
   const tools=entry.tools;tools.socket.once('close',()=>{if(this.entries.get(id)===entry){this.revoke(id);if(this.sharedDisplay)void this.manager.failProtection(id,'浏览器监测连接意外中断').catch(()=>{});}});
   this.manager.store.log(id,null,`Linux AMD64 Chrome ${entry.selectedVersion} 已通过沙箱检查；${startPage.kind==='blank'?'初始页面为空白':startPage.kind==='home'?'已打开本地浏览器首页':'已按保存的启动页打开'}`);
   try{const message=timing.message(),details=timing.browserDetails(),home=timing.homeDetails();if(message)this.manager.store.log(id,null,message);if(details)this.manager.store.log(id,null,details);if(home)this.manager.store.log(id,null,home);}catch{/* Timing is optional and cannot invalidate an opened browser. */}
  }catch(error){
   const sameSession=this.manager.sessions.get(id)===session&&session!.state==='active';
   if(this.entries.get(id)===entry)this.detachEntry(id);
   // A cancelled old open may finish after its guest/viewer was replaced.
   // Only the original still-active session without a new entry owns cleanup.
   if(entry.sharedLease)await this.stopEntry(id,entry,session!);
   else if(displayAttempted&&sameSession&&!this.entries.has(id))await this.stopDisplay(id,config,session!);
   throw error;
  }finally{options.signal?.removeEventListener('abort',cancel);}
 }
 private async configure(entry:Entry){
  const tools=entry.tools!,autoAttach={autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'browser',exclude:true},{type:'tab',exclude:true},{type:'browser_ui',exclude:true},{}]};
  const forget=(id:string)=>{for(const [target,session] of entry.pages)if(session===id)entry.pages.delete(target);};
  tools.detached=parameters=>forget(parameters.sessionId);
  tools.attached=parameters=>{
   const task=(async()=>{this.assertCurrent(entry);if(entry.checkContexts?.has(parameters.targetInfo.browserContextId)){await tools.send('Target.detachFromTarget',{sessionId:parameters.sessionId});return;}if(parameters.targetInfo.type==='page')entry.pages.set(parameters.targetInfo.targetId,parameters.sessionId);await tools.send('Target.setAutoAttach',autoAttach,parameters.sessionId);await tools.send('Runtime.runIfWaitingForDebugger',{},parameters.sessionId);})().catch(error=>{if(error instanceof DetachedTargetError||!tools.activeSessions.has(parameters.sessionId)){forget(parameters.sessionId);return;}if(!this.current(entry))return;entry.failure=error;void this.manager.failProtection(entry.environment.id,'浏览器子进程配置失败').catch(()=>{});});
   entry.configuration.add(task);void task.finally(()=>entry.configuration.delete(task));
  };
  await tools.send('Target.setAutoAttach',autoAttach);while(entry.configuration.size)await Promise.all([...entry.configuration]);
  const targets=await tools.send('Target.getTargets'),page=targets.targetInfos.find((t:{type:string})=>t.type==='page');if(!page)throw Error('Browser has no blank page');
  if(!entry.pages.has(page.targetId))await tools.send('Target.attachToTarget',{targetId:page.targetId,flatten:true});while(entry.configuration.size)await Promise.all([...entry.configuration]);if(entry.failure)throw entry.failure;
  this.page(entry);
 }
 private page(entry:Entry){const value=[...entry.pages.entries()].find(([,id])=>entry.tools?.activeSessions.has(id));if(!value)throw new AppError('浏览器页面尚未就绪',409,'BROWSER_PAGE_MISSING');return {targetId:value[0],sessionId:value[1]};}
 private async sandbox(entry:Entry){
  this.assertCurrent(entry);const executable=windowsBrowserReleaseRoot(entry.selectedVersion)+'/chrome';
  // Both inspections are read-only. Drain both before reporting any failure
  // so an inspection cannot outlive the caller's cleanup.
  const results=await Promise.allSettled([
   this.runtime.management(entry.config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_SELECTION_INSPECT],{timeoutMs:20000,maxBytes:2048}),
   this.runtime.management(entry.config,['sudo','/usr/bin/python3','-I','-',executable],{input:INSPECT_GUEST_BROWSER_SANDBOX,timeoutMs:10000,maxBytes:1024*1024}),
  ]);this.assertCurrent(entry);
  if(results[0].status==='rejected')throw results[0].reason;
  if(parseWindowsBrowserSelection(results[0].value)!==entry.selectedVersion)throw new AppError('运行中的浏览器版本选择已变化，请停止后重新打开',409,'BROWSER_SELECTION_CHANGED');
  if(results[1].status==='rejected')throw results[1].reason;
  return assertGuestBrowserSandbox(JSON.parse(results[1].value));
 }
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
  this.assertCurrent(entry);
  const actual=JSON.parse(result.result.value),expectedZone=new Intl.DateTimeFormat('en',{timeZone:entry.environment.identity.timezone}).resolvedOptions().timeZone;
  const locale=new Intl.Locale(actual.locale),expectedLocale=new Intl.Locale(entry.environment.identity.locale),localeMatches=locale.language===expectedLocale.language&&(!locale.region||locale.region===expectedLocale.region);
  return {...actual,webRtcPolicy:'disable_non_proxied_udp',matchesConfiguration:actual.timezone===expectedZone&&actual.language===entry.environment.identity.locale&&localeMatches,checkedAt:new Date().toISOString()};
 }
 async localCheck(id:string,options:RunOptions={}){
  const entry=this.entries.get(id);if(!entry?.ready||!entry.tools)throw new AppError('请先打开沙箱浏览器',409,'BROWSER_NOT_RUNNING');this.assertCurrent(entry);
  if(entry.checkBlocked)throw new AppError('上次检测的临时上下文尚未确认关闭，请关闭并重新打开浏览器后再试',409,'BROWSER_CHECK_CLEANUP_UNCONFIRMED');
  if(entry.checkRunning)throw new AppError('无账号检测正在进行',409,'BROWSER_CHECK_BUSY');entry.checkRunning=true;entry.checkContexts??=new Set();
  let tools:DevTools|undefined;
  try{
   await this.manager.assertAccess(id,true);this.assertCurrent(entry);options.signal?.throwIfAborted();
   const connect=this.bind(entry,await this.runtime.serviceStreamFactory(entry.config,'cdp'));this.assertCurrent(entry);
   tools=await DevTools.openStream(connect);this.assertCurrent(entry);
   const privateTools=tools;
   const result=await runWindowsBrowserCheck({send:privateTools.send.bind(privateTools),get event(){return privateTools.event;},set event(value){privateTools.event=value;},close:()=>privateTools.socket.terminate()},entry.environment.identity,{
    signal:options.signal,assertCurrent:()=>this.assertCurrent(entry),contextCreated:context=>{this.assertCurrent(entry);entry.checkContexts!.add(context);},
    verifyDisposed:async context=>{for(let attempt=0;attempt<20;attempt++){this.assertCurrent(entry);const value=await entry.tools!.send('Target.getBrowserContexts');this.assertCurrent(entry);if(Array.isArray(value.browserContextIds)&&!value.browserContextIds.includes(context))return true;await delay(50);}return false;},
   });
   this.assertCurrent(entry);options.signal?.throwIfAborted();entry.checkContexts.clear();return result;
  }catch(error){if(error instanceof WindowsBrowserCheckFailure){if(!error.cleanupVerified)entry.checkBlocked=true;else entry.checkContexts.clear();}throw error;}
  finally{tools?.socket.terminate();entry.checkRunning=false;}
 }
 async navigate(id:string,url:string){
  const entry=this.entries.get(id);if(!entry?.ready)throw new AppError('浏览器未运行',409);await this.manager.assertAccess(id,true);this.assertCurrent(entry);
  const value=new URL(url);if(!['http:','https:'].includes(value.protocol)||value.username||value.password)throw new AppError('只支持不含账号密码的 HTTP 或 HTTPS 地址',400);
  await entry.tools!.send('Page.navigate',{url:value.href},this.page(entry).sessionId);
 }
 async resize(id:string,input:DisplayRequest){
  const requested=displayRequestSchema.parse(input),entry=this.entries.get(id);
  if(this.sharedDisplay)return this.sharedDisplay.resize(id,requested,entry?.ready?async()=>{this.assertCurrent(entry);return this.resizeBrowser(entry,requested);}:undefined);
  if(!entry?.ready||!entry.vnc)throw new AppError('浏览器未运行',409);await this.manager.assertAccess(id,true);return this.resizeBrowser(entry,requested);
 }
 private async resizeBrowser(entry:Entry,requested:DisplayRequest){
  entry.display=await configureGuestDisplay(entry.display,requested,{assertCurrent:()=>this.assertCurrent(entry),applyDpi:async request=>{await this.runtime.management(entry.config,['sudo','-H','-u','dev','--','python3','-c',dpiScript(request)],{timeoutMs:6000});},
   resizePixels:(width,height)=>resizeVncDisplayStream(entry.vnc!(),entry.password,width,height),readNativeScreen:async()=>{const result=await entry.tools!.send('Runtime.evaluate',{expression:'({width:screen.width,height:screen.height})',returnByValue:true},this.page(entry).sessionId);return result.result.value;},
   resizeBrowserWindow:async(width,height)=>{const window=await entry.tools!.send('Browser.getWindowForTarget',{targetId:this.page(entry).targetId});await entry.tools!.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});await entry.tools!.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{left:0,top:0,width,height}});},waitForDensity:()=>delay(80)});
  return entry.display;
 }
 issue(id:string){return this.transport.issue(id);}
 async upgrade(request:IncomingMessage,socket:Duplex,head:Buffer,authorize:(request:IncomingMessage)=>boolean){return this.transport.upgrade(request,socket,head,authorize);}
 private terminateEntry(entry:Entry){try{entry.tools?.socket.terminate();}catch{/* Continue revoking the remaining transports. */}for(const stream of entry.streams){try{stream.destroy();}catch{/* A failed stream cannot keep another transport alive. */}}entry.streams.clear();}
 private detachEntry(id:string,preserveTransport=false){
  const entry=this.entries.get(id);if(entry){entry.closed=true;entry.ready=false;this.entries.delete(id);}
  if(!this.sharedDisplay){this.transport.revoke(id);
   try{this.revokeAudio?.(id);}catch{try{this.manager.store.log(id,null,'音频连接撤销未完成，继续关闭浏览器显示连接','error');}catch{/* Revocation must continue even during store shutdown. */}}
  }
  if(entry&&!preserveTransport)this.terminateEntry(entry);return entry;
 }
 revoke(id:string){this.detachEntry(id);const closing=this.closingEntries.get(id);if(closing)this.terminateEntry(closing);this.openings.get(id)?.controller.abort();}
 private async stopDisplay(id:string,config:WindowsConfig,session:WindowsNetworkSession,graceful=false){
  if(this.manager.sessions.get(id)!==session||session.state!=='active'||this.entries.has(id))return;
  try{await this.runtime.management(config,['bash','-c',graceful?STOP_WINDOWS_DISPLAY_AFTER_CLOSE:STOP_WINDOWS_DISPLAY],{timeoutMs:30000});if(this.stopFailures.get(id)?.session===session)this.stopFailures.delete(id);}
  catch(error){if(this.manager.sessions.get(id)===session)this.stopFailures.set(id,{session,config});const failure=new AppError('浏览器停止尚未确认，请先停止环境后重试',409,'BROWSER_STOP_UNCONFIRMED');failure.cause=error;throw failure;}
 }
 private async stopEntry(id:string,entry:Entry,session:WindowsNetworkSession|undefined){
  if(!this.sharedDisplay){if(session)await this.stopDisplay(id,entry.config,session);return;}
  if(entry.chromeAttempted&&session&&this.manager.sessions.get(id)===session&&session.state==='active'&&!this.entries.has(id)){
   try{await this.runtime.management(entry.config,['bash','-s'],{input:STOP_WINDOWS_CHROME,timeoutMs:30000});if(this.stopFailures.get(id)?.session===session)this.stopFailures.delete(id);}
   catch(error){
    if(this.manager.sessions.get(id)===session)this.stopFailures.set(id,{session,config:entry.config,entry});
    const failure=new AppError('浏览器停止尚未确认，环境已撤销访问',409,'BROWSER_STOP_UNCONFIRMED');failure.cause=error;
    try{await this.manager.failProtection(id,'浏览器停止尚未确认');}catch{/* Keep the original unconfirmed stop as the reported failure. */}throw failure;
   }
  }
  if(entry.sharedLease)await this.sharedDisplay.release(entry.sharedLease);
 }
 close(id:string):Promise<void>{
  const opening=this.openings.get(id);opening?.controller.abort();const previous=this.closeTasks.get(id);if(previous)return previous;
  const task=(async()=>{await opening?.promise?.catch(error=>{if(error instanceof AppError&&['BROWSER_STOP_UNCONFIRMED','DISPLAY_STOP_UNCONFIRMED'].includes(error.code??''))throw error;});await this.closeEntry(id);})().finally(()=>{if(this.closeTasks.get(id)===task)this.closeTasks.delete(id);});this.closeTasks.set(id,task);return task;
 }
 private async closeEntry(id:string){
  const candidate=this.entries.get(id),session=this.manager.sessions.get(id),wasReady=!!candidate?.ready;
  const entry=this.detachEntry(id,true);
  if(!entry){const failed=this.stopFailures.get(id);if(failed){if(failed.session===session){if(failed.entry)await this.stopEntry(id,failed.entry,failed.session);else await this.stopDisplay(id,failed.config,failed.session);}else this.stopFailures.delete(id);}return;}
  this.closingEntries.set(id,entry);
  const sameSession=()=>!!session&&this.manager.sessions.get(id)===session&&session.id===entry.sessionId&&session.state==='active';
  let graceful=false;
  try{
   if(wasReady&&sameSession()&&entry.tools?.socket.readyState===WebSocket.OPEN){
    graceful=true;
    const socket=entry.tools.socket;let timer:ReturnType<typeof setTimeout>|undefined,closed!:()=>void;
    const stopped=new Promise<void>(resolve=>{closed=resolve;socket.once('close',closed);timer=setTimeout(resolve,5000);});
    try{try{void entry.tools.send('Browser.close').catch(()=>closed());}catch{closed();}await stopped;}finally{clearTimeout(timer);socket.removeListener('close',closed);}
   }
  }finally{this.terminateEntry(entry);if(this.closingEntries.get(id)===entry)this.closingEntries.delete(id);}
  if(this.sharedDisplay)await this.stopEntry(id,entry,session!);
  else if(sameSession()&&!this.entries.has(id))await this.stopDisplay(id,entry.config,session!,graceful);
 }
 async reset(id:string,confirmation:string,options:RunOptions={}){
  if(!this.resetEnabled)throw new AppError('浏览器资料重置尚未完成 Windows 实机验收，暂未开放',409,'BROWSER_RESET_UNAVAILABLE');
  options.signal?.throwIfAborted();const session=this.manager.sessions.get(id),environment=await this.manager.assertAccess(id,true);
  const current=()=>{options.signal?.throwIfAborted();if(!session||this.manager.sessions.get(id)!==session||session.state!=='active'||this.manager.store.get(id).state!=='running')throw new AppError('环境已变化，重置结果需要重新核对',409,'CONFIGURATION_CHANGED');};
  current();if(environment.name!==confirmation)throw new AppError('环境名称已变化，请重新确认重置范围',400,'BROWSER_RESET_CONFIRMATION');
  const config=await this.manager.profile(environment);current();await this.close(id);current();await this.manager.assertAccess(id,true);current();
  await this.runtime.management(config,['bash','-s'],{...options,input:RESET_WINDOWS_BROWSER_PROFILE_SCRIPT,timeoutMs:120000});current();await this.manager.assertAccess(id,true);current();
  const remaining=windowsBrowserResetState(await this.runtime.management(config,['bash','-s'],{...options,input:INSPECT_WINDOWS_BROWSER_RESET_SCRIPT,timeoutMs:20000}));current();if(remaining!=='none')throw new AppError('浏览器资料重置尚未完成，请核对操作记录',409,'BROWSER_RESET_PENDING');await this.manager.assertAccess(id,true);current();
  this.manager.store.log(id,null,'浏览器资料重置已完成；虚拟机、项目与线路保留，请手动重新打开浏览器');
 }
 dispose(){if(this.closing)return;this.closing=true;this.unsubscribeDisplay?.();for(const opening of this.openings.values())opening.controller.abort();for(const id of this.entries.keys())this.revoke(id);for(const entry of this.closingEntries.values())this.terminateEntry(entry);if(!this.sharedDisplay)this.transport.dispose();}
}
