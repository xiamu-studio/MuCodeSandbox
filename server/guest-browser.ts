import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { connect } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { BrowserHost } from './browser.ts';
import type { Environment, BrowserInspection, BrowserVersionStatus } from '../shared/types.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';
import { AppError } from './errors.ts';
import { guestBrowserStartUrl } from './browser-startpage.ts';
import { ensureGuestBrowser, startGuestBrowser, stopGuestBrowser, inspectGuestBrowserSandbox } from './guest-browser-runtime.ts';
import { browserReleaseFromRecipe, compareBrowserVersions, CURRENT_BROWSER_RELEASE, type BrowserRelease } from './browser-releases.ts';
import { beginBrowserUpgradeScript, commitBrowserUpgradeScript, BROWSER_UPGRADE_STATUS_SCRIPT, RECOVER_BROWSER_UPGRADE_SCRIPT } from './browser-profile-transaction.ts';
import { RESET_BROWSER_PROFILE_SCRIPT, RECOVER_BROWSER_RESET_SCRIPT } from './browser-reset.ts';
import { MOCK_CREDENTIAL } from './mock-messages.ts';
import { displayRequestSchema, type DisplayRequest, type GuestDisplay } from '../shared/guest-display.ts';
import { resizeVncDisplay } from './vnc-display.ts';
import { dpiScript } from './guest-display.ts';
import { configureGuestDisplay } from './guest-display-session.ts';
import { startGuestDisplay, stopGuestDisplay } from './guest-display-runtime.ts';
import { focusGuestWindow } from './guest-window.ts';
import type {GuestWindowTarget} from './guest-window.ts';
import {parseGuestLink} from './guest-links.ts';
import { displayPixels } from '../shared/guest-display.ts';

export class DetachedTargetError extends Error {}

export class DevTools {
  socket: WebSocket;
  sequence = 0;
  pending = new Map<number, { resolve:(value:any)=>void; reject:(error:Error)=>void; timer:NodeJS.Timeout }>();
  attached?: (params:any)=>void;
  detached?: (params:any)=>void;
  activeSessions=new Set<string>();
  constructor(socket:WebSocket) {
    this.socket=socket;
    socket.on('message', data=>{
      try {
        const message=JSON.parse(data.toString());
        if(message.id){const item=this.pending.get(message.id);if(!item)return;this.pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(message.error.message==='Session with given id not found.'?new DetachedTargetError(message.error.message):new Error(message.error.message));else item.resolve(message.result);}
        else if(message.method==='Target.attachedToTarget'){this.activeSessions.add(message.params.sessionId);this.attached?.(message.params);}
        else if(message.method==='Target.detachedFromTarget'){this.activeSessions.delete(message.params.sessionId);this.detached?.(message.params);}
      } catch { socket.close(); }
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('虚拟机浏览器连接已关闭'));}this.pending.clear();});
  }
  static async open(socketPath:string) {
    const version=await new Promise<{webSocketDebuggerUrl:string}>((resolve,reject)=>{
      const req=httpRequest({socketPath,path:'/json/version',headers:{Host:'localhost:9222'},timeout:10_000},res=>{
        let data='';res.on('data',chunk=>{data+=chunk;if(data.length>65536)req.destroy(new Error('Invalid DevTools response'));});
        res.on('end',()=>{try{resolve(JSON.parse(data));}catch(error){reject(error);}});
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('DevTools timeout')));req.end();
    });
    const endpoint=new URL(version.webSocketDebuggerUrl);
    if(endpoint.hostname!=='localhost'&&endpoint.hostname!=='127.0.0.1')throw new Error('Invalid DevTools endpoint');
    const socket=new WebSocket(`ws://localhost:9222${endpoint.pathname}`,{createConnection:()=>connect(socketPath),maxPayload:2*1024*1024});
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    return new DevTools(socket);
  }
  send(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>{
    if(this.socket.readyState!==WebSocket.OPEN)return Promise.reject(new Error('浏览器连接已关闭'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`浏览器操作超时：${method}`));},15_000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  }
  close(){this.socket.close();}
}

interface Entry { translationTarget?:string; translationBusy?:boolean; environment:Environment; release:BrowserRelease; password:string; transport:ChildProcess; directory:string; vnc:string; cdp:string; tools?:DevTools; ready:boolean; browserReady?:boolean; sessions:Map<string,string>; configuration:Set<Promise<void>>; failure?:Error; protection?:Promise<void>; display?:GuestDisplay; displayOperation?:Promise<GuestDisplay> }
interface Ticket { id:string; expires:number }

export class GuestBrowserHost implements BrowserHost {
  native:boolean;
  runtime:LimaRuntime;
  fallback:BrowserHost;
  entries=new Map<string,Entry>();
  tickets=new Map<string,Ticket>();
  wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
  peers=new Map<string,Set<WebSocket>>();
  closing=new Map<string,Promise<void>>();
  onOpen?: (e:Environment)=>Promise<void>;
  prepareLinks?: (e:Environment,options:RunOptions)=>Promise<void>;
  onClose?: (id:string)=>Promise<void>;
  revokeAudio?: (id:string)=>void;
  authorize?: (e:Environment, allowBusy:boolean)=>Promise<unknown>;
  constructor(runtime:LimaRuntime,fallback:BrowserHost){this.runtime=runtime;this.fallback=fallback;this.native=fallback.native;}
  available(){return this.fallback.available();}
  running(id:string){return !!this.entries.get(id)?.browserReady||this.fallback.running(id);}
  async assertProtection(id:string){
    const entry=this.entries.get(id);
    if(!entry?.ready)return;
    if(entry.protection)return entry.protection;
    const check=entry.browserReady
      ? inspectGuestBrowserSandbox(this.runtime,entry.environment,{},entry.release.version)
      : this.runtime.management(entry.environment,['systemctl','is-active','--quiet','mucodesandbox-display.service'],{timeoutMs:8000});
    const inspection=check.then(()=>{},error=>{
      // An inspection of a closing session must not quarantine its replacement.
      if(this.entries.get(id)!==entry||!entry.ready)return;
      throw error;
    }).finally(()=>{if(entry.protection===inspection)entry.protection=undefined;});
    entry.protection=inspection;
    return inspection;
  }
  info(id:string){const e=this.entries.get(id);return {running:!!e,ready:e?.ready??false,width:e?.display?.width??(e?2560:1280),height:e?.display?.height??(e?1600:800),platform:'Linux',display:e?.display,browserRunning:e?.browserReady??false};}
  async resize(id:string,input:DisplayRequest):Promise<GuestDisplay> {
    const requested=displayRequestSchema.parse(input),entry=this.entries.get(id);
    if(!entry?.ready)throw new AppError('请先连接沙箱显示服务',409);
    const previous=entry.displayOperation;
    const operation=(async()=>{
      if(previous)await previous.catch(()=>{});
      if(this.entries.get(id)!==entry||!entry.ready)throw new AppError('浏览器连接已关闭',409);
      await this.authorize?.(entry.environment,false);
      const assertCurrent=()=>{if(this.entries.get(id)!==entry||!entry.ready)throw new AppError('浏览器连接已关闭',409);};
      if(!entry.tools){
        const pixels=displayPixels(requested);
        assertCurrent();
        await this.runtime.management(entry.environment,['sudo','-H','-u','dev','--','python3','-c',dpiScript(requested)],{timeoutMs:6000});
        assertCurrent();
        const actual=await resizeVncDisplay(entry.vnc,entry.password,pixels.width,pixels.height);
        assertCurrent();
        entry.display={...pixels,...actual,mode:requested.mode??'adaptive',browserScaleFactor:requested.scaleFactor,
          screenWidth:actual.width/requested.scaleFactor,screenHeight:actual.height/requested.scaleFactor,
          matched:actual.width===pixels.width&&actual.height===pixels.height};
        return entry.display;
      }
      const target=()=>{
        const value=[...entry.sessions.entries()].find(([,session])=>entry.tools!.activeSessions.has(session));
        if(!value)throw new AppError('浏览器窗口已关闭',409);
        return value;
      };
      entry.display=await configureGuestDisplay(entry.display,requested,{
        assertCurrent,
        applyDpi:async request=>{await this.runtime.management(entry.environment,['sudo','-H','-u','dev','--','python3','-c',dpiScript(request)],{timeoutMs:6000});},
        resizePixels:(width,height)=>resizeVncDisplay(entry.vnc,entry.password,width,height),
        readNativeScreen:async()=>{
          // Native screen geometry is unaffected by page zoom; no emulated values.
          const sample=await entry.tools!.send('Runtime.evaluate',{expression:'JSON.stringify({width:screen.width,height:screen.height})',returnByValue:true},target()[1]);
          const geometry=JSON.parse(sample.result?.value??'{}');
          return {width:Number(geometry.width),height:Number(geometry.height)};
        },
        resizeBrowserWindow:async(width,height)=>{
          const window=await entry.tools!.send('Browser.getWindowForTarget',{targetId:target()[0]});
          assertCurrent();
          await entry.tools!.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});
          assertCurrent();
          await entry.tools!.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{left:0,top:0,width,height}});
        },
        waitForDensity:()=>new Promise(resolve=>setTimeout(resolve,80)),
      });
      return entry.display;
    })();
    entry.displayOperation=operation;
    try{return await operation;}finally{if(entry.displayOperation===operation)entry.displayOperation=undefined;}
  }
  async ensureDisplay(e:Environment,options:RunOptions={}){
    if(e.kind!=='vm')throw new AppError('独立桌面显示只支持 Linux 环境',409);
    await this.closing.get(e.id);
    await this.authorize?.(e,true);
    if(this.entries.get(e.id)?.ready)return;
    if(e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    if(e.network.strict&&(!e.network.transparent||!(await this.runtime.networkProtection(e)).active))throw new AppError('请先启用并确认透明网络防护',409,'GUARD_FAILED');
    const password=randomBytes(6).toString('base64url');
    const directory=await mkdtemp('/tmp/mu-view-');
    const vnc=path.join(directory,'vnc.sock'),cdp=path.join(directory,'cdp.sock');
    try{
      await this.prepareLinks?.(e,options);
      await startGuestDisplay(this.runtime,e,password,options);
      await this.authorize?.(e,true);
      if(e.network.strict&&!(await this.runtime.networkProtection(e)).active)throw new AppError('显示组件启动后网络防护检查失败',409,'GUARD_FAILED');
      const transport=spawn('/usr/bin/ssh',['-F',path.join(this.runtime.limaHome,e.instanceName,'ssh.config'),'-S','none','-N','-T','-o','ExitOnForwardFailure=yes','-o','StreamLocalBindMask=0077','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-L',`${vnc}:127.0.0.1:5900`,'-L',`${cdp}:127.0.0.1:9222`,`lima-${e.instanceName}`],{stdio:['ignore','pipe','pipe'],shell:false});
      const entry:Entry={environment:e,release:CURRENT_BROWSER_RELEASE,password,transport,directory,vnc,cdp,ready:false,browserReady:false,sessions:new Map(),configuration:new Set()};
      this.entries.set(e.id,entry);
      transport.stdout?.resume();
      let transportError='';transport.stderr!.on('data',chunk=>{transportError=(transportError+chunk.toString()).slice(-2000);});transport.on('error',error=>{entry.failure=error;});
      transport.on('exit',()=>{if(this.entries.get(e.id)===entry)void this.close(e.id).catch(()=>{});});
      for(let attempt=0;attempt<100;attempt++){
        options.signal?.throwIfAborted();
        if(entry.failure||transport.exitCode!==null)throw entry.failure??new Error(transportError||'SSH 显示连接失败');
        try{await access(vnc);break;}catch{if(attempt===99)throw new AppError('显示连接启动超时',504);await new Promise(resolve=>setTimeout(resolve,100));}
      }
      await this.authorize?.(e,true);
      if(this.entries.get(e.id)!==entry)throw new AppError('显示访问已撤销',409,'QUARANTINED');
      entry.ready=true;
    }catch(error){
      await this.close(e.id).catch(()=>{});
      await stopGuestDisplay(this.runtime,e).catch(()=>{});
      await rm(directory,{recursive:true,force:true});
      throw error;
    }
  }
  async open(e:Environment,options:RunOptions={},showWindow=true){
    await this.openVersion(e, options, undefined, showWindow);
  }
  private async openVersion(e:Environment,options:RunOptions={},candidate?:BrowserRelease,showViewer=true,initialUrl?:string){
    if(e.kind!=='vm'){await this.fallback.open(e);return;}
    await this.closing.get(e.id);
    await this.authorize?.(e,true);
    if(this.entries.get(e.id)?.browserReady){await this.focus(e,'browser');if(showViewer)await this.onOpen?.(e);return;}
    if(e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    if(e.network.strict&&(!e.network.transparent||!(await this.runtime.networkProtection(e)).active))throw new AppError('请先启用并确认透明网络防护',409,'GUARD_FAILED');
    if(!candidate){
      await this.runtime.management(e,['bash','-s'],{...options,input:RECOVER_BROWSER_RESET_SCRIPT,timeoutMs:60_000});
      await this.runtime.management(e,['bash','-s'],{...options,input:RECOVER_BROWSER_UPGRADE_SCRIPT,timeoutMs:60_000});
    }
    const release=await ensureGuestBrowser(this.runtime,e,options,candidate?.version);
    if(e.network.strict&&!(await this.runtime.networkProtection(e)).active)throw new AppError('浏览器组件安装后网络防护检查失败，请重启环境修复后再试',409,'GUARD_FAILED');
    await this.authorize?.(e,true);
    await this.ensureDisplay(e,options);
    const entry=this.entries.get(e.id)!;
    entry.release=release;entry.failure=undefined;
    try{
      await startGuestBrowser(this.runtime,e,entry.password,options,release.version);
      for(let i=0;i<100;i++){
        options.signal?.throwIfAborted();
        if(this.entries.get(e.id)!==entry||entry.failure||entry.transport.exitCode!==null)throw entry.failure??new Error('显示连接已关闭');
        try{entry.tools=await DevTools.open(entry.cdp);break;}catch{await new Promise(resolve=>setTimeout(resolve,200));}
      }
      if(!entry.tools)throw new Error('虚拟机浏览器启动超时');
      const tools=entry.tools;
      tools.socket.once('close',()=>{if(this.entries.get(e.id)===entry&&entry.tools===tools)void this.closeApplication(e.id).catch(()=>{});});
      await this.configure(entry,candidate?'about:blank':initialUrl??guestBrowserStartUrl(e.browserUrl));
      if(entry.failure)throw entry.failure;
      await this.authorize?.(e,true);
      if(this.entries.get(e.id)!==entry)throw new AppError('浏览器访问已撤销',409,'QUARANTINED');
      if(!candidate){entry.browserReady=true;entry.display=undefined;await this.focus(e,'browser');if(showViewer)await this.onOpen?.(e);}
    }catch(error){await this.closeApplication(e.id).catch(()=>{});throw error;}
  }
  async focus(e:Environment,target:GuestWindowTarget){
    if(!this.entries.get(e.id)?.ready)return false;
    await this.authorize?.(e,true);
    return focusGuestWindow(this.runtime,e,target);
  }
  async showGuestApplication(e:Environment,target:'browser'|'desktop',application?:string){
    await this.fallback.showGuestApplication?.(e,target,application);
  }
  async openLink(e:Environment,url:string,options:RunOptions={}){
    const parsed=parseGuestLink(url);if(parsed.application)throw new AppError('浏览器只接受网页链接',400);
    const wasRunning=this.running(e.id);
    await this.openVersion(e,options,undefined,false,parsed.url);
    const entry=this.entries.get(e.id);if(!entry?.tools||!entry.browserReady)throw new AppError('受管浏览器尚未就绪',409);
    await this.authorize?.(e,true);
    if(wasRunning){const target=await entry.tools.send('Target.createTarget',{url:parsed.url});await entry.tools.send('Target.activateTarget',{targetId:target.targetId});}
    await this.focus(e,'browser');
    await this.showGuestApplication(e,'browser');
  }
  async openTranslation(e:Environment,text:string){
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    const entry=this.entries.get(e.id);
    if(!entry?.tools||!entry.browserReady)throw new AppError('请先在“浏览器”页打开沙箱浏览器，再使用翻译小窗。',409);
    if(entry.translationBusy)throw new AppError('翻译小窗正在打开，请稍候',409);
    entry.translationBusy=true;
    let created:string|undefined;
    try{
      await this.authorize?.(e,false);
      if(this.entries.get(e.id)!==entry||!entry.browserReady)throw new AppError('沙箱浏览器已关闭',409);
      const url=new URL('https://translate.google.com/');
      url.searchParams.set('sl','auto');url.searchParams.set('tl','en');url.searchParams.set('op','translate');
      if(text)url.searchParams.set('text',text);
      const result=await entry.tools.send('Target.createTarget',{url:url.href,newWindow:true,width:900,height:680,left:60,top:60});
      created=result.targetId;
      await this.authorize?.(e,false);
      if(this.entries.get(e.id)!==entry||!entry.browserReady)throw new AppError('沙箱浏览器已关闭',409);
      if(entry.translationTarget)await entry.tools.send('Target.closeTarget',{targetId:entry.translationTarget}).catch(()=>{});
      entry.translationTarget=created;
      await entry.tools.send('Target.activateTarget',{targetId:created});
      return {opened:true};
    }catch(error){if(created)await entry.tools.send('Target.closeTarget',{targetId:created}).catch(()=>{});throw error;}
    finally{entry.translationBusy=false;}
  }
  private async configure(entry:Entry,url:string){
    const tools=entry.tools!;
    const autoAttach={autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'browser',exclude:true},{type:'tab',exclude:true},{type:'browser_ui',exclude:true},{}]};
    const forget=(session:string)=>{for(const[target,value]of entry.sessions)if(value===session)entry.sessions.delete(target);};
    tools.detached=params=>forget(params.sessionId);
    const configure=async(params:any)=>{
      const session=params.sessionId as string;const type=params.targetInfo.type;
      if(type==='page'){
        entry.sessions.set(params.targetInfo.targetId,session);
      }
      // Native TZ / LANG and Chromium preferences apply before scripts in every context.
      // Per-page locale overrides collide while a new window shares its opener's renderer.
      await tools.send('Target.setAutoAttach',autoAttach,session);
      await tools.send('Runtime.runIfWaitingForDebugger',{},session);
    };
    tools.attached=params=>{
      const task=configure(params).catch(error=>{
        // Navigation can destroy a Worker while its debugger setup is still pending.
        if(error instanceof DetachedTargetError||!tools.activeSessions.has(params.sessionId)){forget(params.sessionId);return;}
        if(entry.tools!==tools)return;
        entry.failure=error;if(this.entries.get(entry.environment.id)===entry)void this.close(entry.environment.id).catch(()=>{});
      });
      entry.configuration.add(task);void task.finally(()=>entry.configuration.delete(task));
    };
    await tools.send('Target.setAutoAttach',autoAttach);
    while(entry.configuration.size)await Promise.all([...entry.configuration]);
    const targets=await tools.send('Target.getTargets');
    const page=targets.targetInfos.find((t:any)=>t.type==='page');
    if(!page)throw new Error('虚拟机浏览器没有页面');
    if(!entry.sessions.has(page.targetId))await tools.send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
    // Targets can attach during discovery, and navigation can replace a session during setup.
    while(entry.configuration.size)await Promise.all([...entry.configuration]);
    if(entry.failure)throw entry.failure;
    const session=entry.sessions.get(page.targetId);
    if(!session||!tools.activeSessions.has(session))throw new Error('虚拟机浏览器页面尚未就绪');
    await tools.send('Page.navigate',{url},session);
  }
  async versionStatus(e:Environment):Promise<BrowserVersionStatus>{
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    const state=JSON.parse(await this.runtime.management(e,['bash','-s'],{input:BROWSER_UPGRADE_STATUS_SCRIPT,timeoutMs:15_000}));
    if(typeof state.pending!=='boolean'||state.recipe!==null&&typeof state.recipe!=='string')throw new AppError('浏览器版本记录无效',409);
    const installed=state.recipe===null?null:browserReleaseFromRecipe(state.recipe);
    return {installedVersion:installed?.version??null,availableVersion:CURRENT_BROWSER_RELEASE.version,
      updateAvailable:installed!==null&&compareBrowserVersions(installed.version,CURRENT_BROWSER_RELEASE.version)<0,recoveryRequired:state.pending,
      installedChannel:installed?.channel??null,availableChannel:CURRENT_BROWSER_RELEASE.channel,
      requiresFreshProfile:installed!==null&&compareBrowserVersions(installed.version,CURRENT_BROWSER_RELEASE.version)>0};
  }
  async recover(e:Environment,options:RunOptions={}){
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    await this.authorize?.(e,true);await this.close(e.id);
    await this.runtime.management(e,['bash','-s'],{...options,input:RECOVER_BROWSER_RESET_SCRIPT,timeoutMs:60_000});
    await this.runtime.management(e,['bash','-s'],{...options,input:RECOVER_BROWSER_UPGRADE_SCRIPT,timeoutMs:60_000});
  }
  async reset(e:Environment,options:RunOptions={}){
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    await this.authorize?.(e,true);
    await this.close(e.id);
    await this.runtime.management(e,['bash','-s'],{...options,input:RESET_BROWSER_PROFILE_SCRIPT,timeoutMs:120_000});
    await this.authorize?.(e,true);
  }
  async localCheck(e:Environment,url:string,options:RunOptions={}) {
    const target=new URL(url);
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.pathname!=='/')throw new AppError('检测仅允许本地接收端',409);
    await this.openVersion({...e,browserUrl:url},options,undefined,false);
    const entry=this.entries.get(e.id);
    if(!entry?.tools||!entry.ready)throw new AppError('沙箱浏览器尚未就绪',409);
    const session=[...entry.sessions.values()][0];
    await entry.tools.send('Page.navigate',{url},session);
    let probe:any;
    for(let n=0;n<50;n++){
      options.signal?.throwIfAborted();
      if(this.entries.get(e.id)!==entry||entry.failure)throw new AppError('检测浏览器访问已撤销',409);
      const observed=await entry.tools.send('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,result:window.__MU_PROBE__??null,error:window.__MU_PROBE_ERROR__??null})',returnByValue:true},session);
      const result=JSON.parse(observed.result.value??'{}');
      if(result.url===target.href&&result.error)throw new Error(result.error);
      if(result.url===target.href&&result.result){probe=result.result;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!probe)throw new AppError('本地页面检测超时',504);
    const simulated=await entry.tools.send('Runtime.evaluate',{expression:`(async()=>{
      const base=${JSON.stringify(target.href)};
      if(location.origin!==new URL(base).origin)throw new Error('Local test navigation changed');
      await fetch(new URL('/api/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'synthetic-a'})});
      const login=await(await fetch(new URL('/api/session',base))).json();
      const response=await fetch(new URL('/v1/messages',base),{method:'POST',headers:{'Content-Type':'application/json','x-api-key':${JSON.stringify(MOCK_CREDENTIAL)}},body:JSON.stringify({model:'mu-mock',max_tokens:128,stream:true,messages:[{role:'user',content:'Hello local test'}]})});
      if(!response.ok)throw new Error('Synthetic gateway rejected the request');
      const stream=await response.text();
      return {account:login.account,streamFinished:stream.includes('message_stop')};
    })()`,awaitPromise:true,returnByValue:true},session);
    if(simulated.exceptionDetails)throw new Error('本地模拟任务失败');
    await this.authorize?.(e,true);
    return {probe,simulated:simulated.result.value,identity:await this.inspect(e.id)};
  }
  async update(e:Environment,options:RunOptions={}){
    // Refuse before closing a working user session. A profile checkpoint is not
    // permission for an older binary to read a newer profile.
    const initial=await this.versionStatus(e);
    if(initial.requiresFreshProfile)throw new AppError('正式稳定版低于当前测试版。请新建空白环境使用正式版，现有资料继续保留；不能直接降级打开旧资料。',409,'BROWSER_FRESH_PROFILE_REQUIRED');
    await this.authorize?.(e,true);await this.close(e.id);
    await this.recover(e,options);
    const status=await this.versionStatus(e);
    if(!status.installedVersion)throw new AppError('请先安装并打开一次浏览器',409);
    if(!status.updateAvailable)throw new AppError('浏览器已是当前批准版本',409,'BROWSER_ALREADY_CURRENT');
    const before=await this.runtime.networkProtection(e);
    if(e.network.strict&&(!before.active||before.integrity!=='verified'))throw new AppError('升级前网络防护未通过核验',409,'GUARD_FAILED');
    try{
      options.onOutput?.('Saving a private checkpoint of the closed browser profile.\n');
      await this.runtime.management(e,['bash','-s'],{...options,input:beginBrowserUpgradeScript(CURRENT_BROWSER_RELEASE),timeoutMs:120_000});
      await this.openVersion(e,options,CURRENT_BROWSER_RELEASE);
      const entry=this.entries.get(e.id);
      if(!entry?.tools||entry.failure)throw entry?.failure??new Error('浏览器候选连接已关闭');
      options.onOutput?.('Checking the candidate before publishing website or viewer access.\n');
      const product=await entry.tools.send('Browser.getVersion');
      if(product.product.split('/').at(-1)!==CURRENT_BROWSER_RELEASE.version)throw new Error('浏览器候选版本不一致');
      const identity=await this.inspect(e.id);
      if(!identity.matchesConfiguration||!/^Linux/.test(identity.platform)||!/Linux/.test(identity.userAgent))throw new Error('浏览器候选环境特征不一致');
      const session=[...entry.sessions.values()][0];if(!session)throw new Error('浏览器候选页面未就绪');
      const rendering=await entry.tools.send('Runtime.evaluate',{expression:`(async()=>{const c=document.createElement('canvas');c.width=64;c.height=64;document.body.append(c);const x=c.getContext('2d');x.fillStyle='#27a36f';x.fillRect(0,0,64,64);const p=[...x.getImageData(0,0,1,1).data];const worker=new Worker(URL.createObjectURL(new Blob(['postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,platform:navigator.platform})'],{type:'text/javascript'})));const identity=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{worker.terminate();reject(Error('Worker identity timeout'));},3000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data);};worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(Error('Worker identity failed'));};});return {pixels:p,worker:identity};})()`,awaitPromise:true,returnByValue:true},session);
      const rendered=rendering.result.value;
      if(rendering.exceptionDetails||JSON.stringify(rendered?.pixels)!=='[39,163,111,255]'||rendered.worker.language!==identity.language||rendered.worker.timezone!==identity.timezone||rendered.worker.platform!==identity.platform)throw new Error('浏览器候选绘图或 Worker 特征检查失败');
      await inspectGuestBrowserSandbox(this.runtime,e,options,CURRENT_BROWSER_RELEASE.version);
      const after=await this.runtime.networkProtection(e);
      if(e.network.strict&&(!after.active||after.integrity!=='verified'||after.firewallHash!==before.firewallHash||after.tunnelConfigHash!==before.tunnelConfigHash))throw new AppError('浏览器升级后网络防护发生变化',409,'GUARD_FAILED');
      options.signal?.throwIfAborted();await this.authorize?.(e,true);
      if(this.entries.get(e.id)!==entry||entry.failure)throw new AppError('浏览器候选已撤销',409,'QUARANTINED');
      await this.runtime.management(e,['bash','-s'],{...options,input:commitBrowserUpgradeScript(CURRENT_BROWSER_RELEASE),timeoutMs:30_000});
      await entry.tools.send('Page.navigate',{url:e.browserUrl},session);
      entry.browserReady=true;entry.display=undefined;await this.onOpen?.(e);
      options.onOutput?.(`Approved browser ${CURRENT_BROWSER_RELEASE.version} adopted; compatible profile checkpoint released.\n`);
    }catch(error){
      await this.close(e.id);
      try{await this.runtime.management(e,['bash','-s'],{input:RECOVER_BROWSER_UPGRADE_SCRIPT,timeoutMs:60_000});}
      catch(recoveryError){const failure=new AppError('浏览器升级失败，资料恢复尚未完成；请先恢复再打开浏览器',500,'BROWSER_UPGRADE_RECOVERY_FAILED');failure.cause=new AggregateError([error,recoveryError]);throw failure;}
      throw error;
    }
  }
  issue(id:string){
    const entry=this.entries.get(id);if(!entry?.ready)throw new AppError('虚拟机浏览器尚未就绪',409);
    for(const[key,ticket]of this.tickets)if(ticket.expires<Date.now())this.tickets.delete(key);
    if(this.tickets.size>=32||(this.peers.get(id)?.size??0)>=4)throw new AppError('浏览器连接数量达到上限',429);
    const ticket=randomBytes(24).toString('hex');this.tickets.set(ticket,{id,expires:Date.now()+15_000});return {ticket,password:entry.password};
  }
  async upgrade(req:IncomingMessage,socket:Duplex,head:Buffer,allowed:(req:IncomingMessage)=>boolean){
    const url=new URL(req.url??'/','http://127.0.0.1');const key=url.searchParams.get('ticket')??'';const ticket=this.tickets.get(key);this.tickets.delete(key);
    const entry=ticket?this.entries.get(ticket.id):undefined;
    if(url.pathname!=='/guest-browser'||!ticket||ticket.expires<Date.now()||!entry?.ready||!allowed(req)||(this.peers.get(ticket.id)?.size??0)>=4){socket.destroy();return;}
    if(entry.environment.network.strict&&!(await this.runtime.networkProtection(entry.environment)).active){socket.destroy();return;}
    try { await this.authorize?.(entry.environment,true); } catch { socket.destroy();return; }
    if(this.entries.get(ticket.id)!==entry||!entry.ready||(this.peers.get(ticket.id)?.size??0)>=4){socket.destroy();return;}
    this.wss.handleUpgrade(req,socket,head,ws=>{
      const set=this.peers.get(ticket.id)??new Set<WebSocket>();set.add(ws);this.peers.set(ticket.id,set);
      const remote=connect(entry.vnc);
      remote.on('data',data=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>8*1024*1024){ws.close(1008,'Slow viewer');return;}ws.send(data,{binary:true});});
      ws.on('message',(data,binary)=>{if(!binary||remote.writableLength>2*1024*1024){ws.close(1008,'Invalid viewer input');return;}remote.write(data as Buffer);});
      remote.on('error',()=>ws.close());remote.on('close',()=>ws.close());ws.on('error',()=>remote.destroy());
      ws.once('close',()=>{remote.destroy();set.delete(ws);if(!set.size&&this.peers.get(ticket.id)===set)this.peers.delete(ticket.id);});
    });
  }
  async inspect(id:string):Promise<BrowserInspection>{
    const entry=this.entries.get(id);if(!entry)return this.fallback.inspect?this.fallback.inspect(id):Promise.reject(new AppError('浏览器未运行',409));
    const tools=entry.tools;if(!tools)throw new AppError('浏览器未运行；当前仅为桌面显示',409);const targets=await tools.send('Target.getTargets');const page=targets.targetInfos.find((t:any)=>t.type==='page');const session=page&&entry.sessions.get(page.targetId);if(!session)throw new AppError('浏览器页面尚未就绪',409);
    const response=await tools.send('Runtime.evaluate',{expression:`JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],platform:navigator.platform,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory??null,screenWidth:screen.width,screenHeight:screen.height})`,returnByValue:true},session);
    const actual=JSON.parse(response.result.value);
    const expectedZone=new Intl.DateTimeFormat('en-US',{timeZone:entry.environment.identity.timezone}).resolvedOptions().timeZone;
    const locale=new Intl.Locale(actual.locale),expectedLocale=new Intl.Locale(entry.environment.identity.locale);
    const localeMatches=locale.language===expectedLocale.language&&(!locale.region||locale.region===expectedLocale.region);
    return {...actual,webRtcPolicy:'disable_non_proxied_udp',matchesConfiguration:actual.timezone===expectedZone&&actual.language===entry.environment.identity.locale&&localeMatches,checkedAt:new Date().toISOString()};
  }
  async closeApplication(id:string){
    const entry=this.entries.get(id);
    if(!entry){await this.fallback.close(id);await this.onClose?.(id);return;}
    const tools=entry.tools;
    entry.browserReady=false;entry.tools=undefined;
    entry.sessions.clear();
    // Do not let a queued Chrome setup error close an unrelated desktop client.
    if(tools){tools.attached=undefined;tools.detached=undefined;}
    let graceful=false;
    if(tools?.socket.readyState===WebSocket.OPEN){
      graceful=true;
      const closed=new Promise<void>(resolve=>{const timer=setTimeout(resolve,5000);tools.socket.once('close',()=>{clearTimeout(timer);resolve();});});
      await tools.send('Browser.close').catch(()=>{});await closed;
    }
    tools?.close();
    await stopGuestBrowser(this.runtime,entry.environment,graceful);
    await this.onClose?.(id);
  }
  close(id:string,stopGuest=true):Promise<void>{
    const closing=this.closing.get(id);if(closing)return closing;
    const task=this.closeEntry(id,stopGuest).finally(()=>{if(this.closing.get(id)===task)this.closing.delete(id);});
    this.closing.set(id,task);return task;
  }
  private async closeEntry(id:string,stopGuest:boolean){
    this.revokeAudio?.(id);
    for(const[key,ticket]of this.tickets)if(ticket.id===id)this.tickets.delete(key);
    for(const peer of this.peers.get(id)??[])peer.close();this.peers.delete(id);
    const entry=this.entries.get(id);if(!entry){await this.fallback.close(id);await this.onClose?.(id);return;}
    this.entries.delete(id);entry.ready=false;
    await entry.displayOperation?.catch(()=>{});
    let attemptedGracefulExit=false;
    if(stopGuest&&entry.tools?.socket.readyState===WebSocket.OPEN){
      attemptedGracefulExit=true;
      const socket=entry.tools.socket;
      const closed=new Promise<void>(resolve=>{const timer=setTimeout(resolve,5000);socket.once('close',()=>{clearTimeout(timer);resolve();});});
      await entry.tools.send('Browser.close').catch(()=>{});
      await closed;
    }
    entry.tools?.close();entry.transport.kill('SIGTERM');
    await new Promise<void>(resolve=>{if(entry.transport.exitCode!==null){resolve();return;}const timer=setTimeout(()=>{entry.transport.kill('SIGKILL');resolve();},3000);entry.transport.once('exit',()=>{clearTimeout(timer);resolve();});});
    if(stopGuest){await stopGuestBrowser(this.runtime,entry.environment,attemptedGracefulExit).catch(()=>{});await stopGuestDisplay(this.runtime,entry.environment).catch(()=>{});}
    await rm(entry.directory,{recursive:true,force:true});await this.onClose?.(id);
  }
  async clear(id:string){await this.close(id);await this.fallback.clear(id);}
  async dispose(){for(const id of [...this.entries.keys()])await this.close(id);await Promise.allSettled([...this.closing.values()]);this.tickets.clear();for(const peer of this.wss.clients)peer.terminate();this.wss.close();await this.fallback.dispose();}
}
