import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import {windowsDesktopComponentId} from './desktop-components.ts';
import {windowsDesktopClientSpec,parseWindowsDesktopClientInspection,type WindowsDesktopClientSpec} from './desktop-client-guest.ts';
import {createWindowsDesktopClientGuestDriver,parseWindowsDesktopClientControl,parseWindowsDesktopClientFocus} from './desktop-client-task.ts';
import type {WindowsDisplayLifecycle,WindowsDisplayManagerPort,WindowsPreparedDisplay,WindowsDisplayLease} from './display-lifecycle.ts';
import type {WindowsDisplayScope} from './display-transport.ts';
import type {DisplayRequest} from '../../../shared/guest-display.ts';
import type {WindowsDesktopClientState} from '../../../shared/windows-desktop-clients.ts';

type Manager=WindowsDisplayManagerPort&{failProtection(id:string,reason:string):Promise<void>};
type Session=NonNullable<ReturnType<Manager['sessions']['get']>>;
export type WindowsDesktopClientDriver=ReturnType<typeof createWindowsDesktopClientGuestDriver>;
export interface WindowsDesktopClientView {application:DesktopAppId;viewId:string;ready:true}
interface Client {
 id:string;application:DesktopAppId;viewId:string;session:Session;controller:AbortController;ready:boolean;closed:boolean;
 scope?:WindowsDisplayScope;
 focus?:Promise<{focused:boolean}>;
 entry?:WindowsPreparedDisplay;lease?:WindowsDisplayLease;acquiring?:Promise<WindowsDisplayLease>;spec?:WindowsDesktopClientSpec;bootId?:string;reserveAttempted:boolean;rootClosed:boolean;
 cleanup?:Promise<void>;cancellation?:Promise<void>;inspection?:Promise<void>;releasing?:Promise<void>;failure?:AppError;quarantined?:boolean;removeAbort?:()=>void;
}
type Timing={startupTimeoutMs?:number;pollMs?:number;wait?:(ms:number,signal?:AbortSignal)=>Promise<void>;now?:()=>number};

// Each opaque view owns precisely one display lease and original network
// session object. A stopped, old or serialized view cannot close a replacement.
export class WindowsDesktopClients {
 readonly manager:Manager;readonly display:WindowsDisplayLifecycle;readonly driver:WindowsDesktopClientDriver;
 private records=new Map<string,Client>();private openings=new Map<string,{record:Client;promise:Promise<WindowsDesktopClientView>}>();
 private focusQueues=new Map<string,Promise<{focused:boolean}>>();
 private disposed=false;private unsubscribe:()=>void;private timeout:number;private poll:number;private wait:(ms:number,signal?:AbortSignal)=>Promise<void>;private now:()=>number;
 constructor(manager:Manager,display:WindowsDisplayLifecycle,driver:WindowsDesktopClientDriver,timing:Timing={}){
  this.manager=manager;this.display=display;this.driver=driver;this.timeout=timing.startupTimeoutMs??15000;this.poll=timing.pollMs??150;this.wait=timing.wait??((ms,signal)=>delay(ms,undefined,{signal}));this.now=timing.now??(()=>performance.now());
  if(!Number.isFinite(this.timeout)||this.timeout<1||this.timeout>30000||!Number.isFinite(this.poll)||this.poll<1||this.poll>1000)throw new AppError('客户端启动等待参数无效',400,'DESKTOP_CLIENT_OPTIONS');
  this.unsubscribe=display.subscribeRevoked(id=>{for(const record of this.records.values())if(record.id===id&&!record.cleanup){record.ready=false;void this.cleanup(record).catch(()=>{});}});
 }
 private key(id:string,app:DesktopAppId){return id+':'+app;}
 private same(record:Client){try{return this.manager.sessions.get(record.id)===record.session&&record.session.state==='active'&&this.manager.store.get(record.id).state==='running';}catch{return false;}}
 private current(record:Client,signal?:AbortSignal){signal?.throwIfAborted();if(this.disposed||record.closed||record.cleanup||!this.same(record)||this.records.get(this.key(record.id,record.application))!==record||record.entry&&this.display.readyEntry(record.id)!==record.entry)throw new AppError('客户端环境会话已变化',409,'DESKTOP_CLIENT_CHANGED');}
 private async access(record:Client,signal?:AbortSignal){this.current(record,signal);await this.manager.assertAccess(record.id);this.current(record,signal);}
 private async quarantine(record:Client,cause:unknown){
  record.ready=false;const failure=record.failure??new AppError('客户端关闭尚未确认，环境访问已撤销',409,'DESKTOP_CLIENT_STOP_UNCONFIRMED');record.failure=failure;failure.cause=cause;
  if(record.scope)this.display.transport.revokeScope(record.scope);
  if(this.same(record)&&!record.quarantined){record.quarantined=true;try{await this.manager.failProtection(record.id,'桌面客户端进程停止尚未确认');}catch{/* Keep the original stop failure and block reuse. */}}
  return failure;
 }
 private cancelRoot(record:Client):Promise<void>{
  if(record.cancellation)return record.cancellation;
  return record.cancellation=Promise.resolve().then(async()=>{
   if(this.disposed||!record.reserveAttempted||!record.spec||!record.entry||!this.same(record))return;
   const value=parseWindowsDesktopClientControl(JSON.stringify(await this.driver.cancel(record.entry.config,record.spec,record.bootId)),record.spec,'cancelled',record.bootId);
   if(!this.same(record))return;record.bootId??=value.bootId;record.rootClosed=true;
  });
 }
 private releaseLease(record:Client){return record.releasing??=(record.lease?this.display.release(record.lease):Promise.resolve());}
 private cleanup(record:Client):Promise<void>{
  if(record.cleanup)return record.cleanup;record.ready=false;if(record.scope)this.display.transport.revokeScope(record.scope);
  record.cleanup=Promise.resolve().then(async()=>{
   record.removeAbort?.();record.removeAbort=undefined;record.controller.abort();if(!this.disposed&&this.same(record)&&record.reserveAttempted)await this.cancelRoot(record);
   if(record.acquiring&&!record.lease){try{record.lease=await record.acquiring;}catch(error){if(error instanceof AppError&&error.code==='DISPLAY_STOP_UNCONFIRMED')throw error;}}
   if(record.lease)await this.releaseLease(record);
   record.closed=true;const key=this.key(record.id,record.application);if(this.records.get(key)===record)this.records.delete(key);if(this.openings.get(key)?.record===record)this.openings.delete(key);
  }).catch(async error=>{throw await this.quarantine(record,error);});
  return record.cleanup;
 }
 start(id:string,application:DesktopAppId,options:RunOptions={}):Promise<WindowsDesktopClientView>{
  windowsDesktopComponentId.parse(application);options.signal?.throwIfAborted();if(this.disposed)throw new AppError('客户端管理器正在退出',409,'CLOSING');
  const key=this.key(id,application),previous=this.records.get(key);
  if(previous){if(previous.failure)throw previous.failure;if(previous.ready&&!previous.cleanup){return this.assertRecord(previous,options.signal).then(()=>{this.current(previous,options.signal);if(!previous.ready)throw new AppError('客户端已关闭，请重新打开',409,'DESKTOP_CLIENT_NOT_READY');return {application,viewId:previous.viewId,ready:true as const};});}throw new AppError('客户端正在启动或关闭，请等待当前操作完成',409,'DESKTOP_CLIENT_BUSY');}
  const session=this.manager.sessions.get(id);if(!session||session.state!=='active')throw new AppError('请先启动并核验环境',409,'DESKTOP_CLIENT_CHANGED');
  const record:Client={id,application,viewId:randomUUID(),session,controller:new AbortController(),ready:false,closed:false,reserveAttempted:false,rootClosed:false};this.records.set(key,record);
  record.scope=Object.freeze({current:()=>{try{this.current(record);return record.ready;}catch{return false;}}});
  const signal=options.signal?AbortSignal.any([options.signal,record.controller.signal]):record.controller.signal;
  const aborted=()=>{void this.cleanup(record).catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
  const promise=Promise.resolve().then(async()=>{
   await this.access(record,signal);const environment=structuredClone(this.manager.store.get(id));record.spec=windowsDesktopClientSpec(environment,application,record.viewId);
   record.acquiring=this.display.acquire(id,application,{...options,signal,onOutput:undefined});record.lease=await record.acquiring;
   if(record.cleanup||record.closed||signal.aborted||this.disposed){try{await this.releaseLease(record);}catch(error){throw await this.quarantine(record,error);}this.current(record,signal);}
   record.entry=this.display.readyEntry(id);this.current(record,signal);if(!record.entry)throw new AppError('共享桌面尚未准备',409,'DISPLAY_NOT_READY');
   await this.access(record,signal);await this.display.assertProtection(id);this.current(record,signal);record.reserveAttempted=true;
   const reserved=parseWindowsDesktopClientControl(JSON.stringify(await this.driver.reserve(record.entry.config,record.spec,{...options,signal,onOutput:undefined})),record.spec,'reserved',record.bootId);this.current(record,signal);record.bootId=reserved.bootId;
   if(reserved.phase==='cancelled')throw new AppError('客户端启动已取消',409,'DESKTOP_CLIENT_CANCELLED');
   const launched=parseWindowsDesktopClientControl(JSON.stringify(await this.driver.launch(record.entry.config,record.spec,record.bootId,{...options,signal,onOutput:undefined})),record.spec,'started',record.bootId);this.current(record,signal);
   if(launched.phase==='cancelled')throw new AppError('客户端启动已取消',409,'DESKTOP_CLIENT_CANCELLED');
   const started=this.now();
   for(;;){
    const status=parseWindowsDesktopClientInspection(JSON.stringify(await this.driver.inspect(record.entry.config,record.spec,record.bootId,{...options,signal,onOutput:undefined})),record.spec);this.current(record,signal);
    const elapsed=this.now()-started;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>this.timeout)throw new AppError('客户端渲染保护等待超时，启动已撤回',409,'DESKTOP_CLIENT_NOT_READY');
    if(status.state==='running'){await this.display.assertProtection(id);await this.access(record,signal);record.ready=true;return {application,viewId:record.viewId,ready:true as const};}
    if(status.state!=='starting'||elapsed>=this.timeout)throw new AppError('客户端渲染保护尚未就绪，启动已撤回',409,'DESKTOP_CLIENT_NOT_READY');
    await this.wait(this.poll,signal);this.current(record,signal);
   }
  }).catch(async error=>{try{await this.cleanup(record);}catch(stopError){throw stopError;}throw error;}).finally(()=>{if(record.ready)record.removeAbort=()=>signal.removeEventListener('abort',aborted);else signal.removeEventListener('abort',aborted);if(this.openings.get(key)?.record===record)this.openings.delete(key);});
  this.openings.set(key,{record,promise});return promise;
 }
 private async assertRecord(record:Client,signal?:AbortSignal){
  this.current(record,signal);if(!record.ready||!record.entry||!record.spec||!record.bootId)throw new AppError('客户端尚未就绪',409,'DESKTOP_CLIENT_NOT_READY');
  if(record.inspection){await record.inspection;if(!record.closed)this.current(record,signal);return;}
  const work=Promise.resolve().then(async()=>{
   await this.access(record,record.controller.signal);const result=parseWindowsDesktopClientInspection(JSON.stringify(await this.driver.inspect(record.entry!.config,record.spec!,record.bootId!,{signal:record.controller.signal,onOutput:undefined})),record.spec!);this.current(record,record.controller.signal);
   if(result.state==='stopped'){await this.cleanup(record);return;}
   if(result.state!=='running')throw new AppError('客户端渲染保护未通过',409,'DESKTOP_CLIENT_PROTECTION');
  }).catch(async error=>{if(record.failure)throw record.failure;if(record.cleanup||record.closed||this.disposed||!this.same(record))return;record.ready=false;if(record.scope)this.display.transport.revokeScope(record.scope);const failure=new AppError('桌面客户端进程保护无法确认',409,'DESKTOP_CLIENT_PROTECTION');record.failure=failure;failure.cause=error;try{await this.manager.failProtection(record.id,'桌面客户端进程保护无法确认');}catch{/* Keep the failure latched and retry quarantine on the manager's next tick. */}throw failure;}).finally(()=>{if(record.inspection===work)record.inspection=undefined;});record.inspection=work;await work;
 }
 async assertProtection(id:string){for(const record of [...this.records.values()])if(record.id===id){if(record.failure&&this.same(record))throw record.failure;if(record.ready&&!record.cleanup)await this.assertRecord(record);}}
 async stop(id:string,application:DesktopAppId,viewId:string){
  windowsDesktopComponentId.parse(application);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(viewId))throw new AppError('客户端关闭凭据无效',400,'DESKTOP_CLIENT_VIEW');const record=this.records.get(this.key(id,application));if(!record||record.viewId!==viewId)return {closed:true as const};const original=this.same(record);
  if(record.failure&&record.cleanup){const previous=record.cleanup;await previous.catch(()=>{});if(record.cleanup===previous&&record.failure){record.cleanup=undefined;record.cancellation=undefined;record.releasing=undefined;record.failure=undefined;record.quarantined=false;}}
  await this.cleanup(record);if(record.reserveAttempted&&!record.rootClosed&&(!original||!this.same(record)))throw new AppError('原客户端会话已变化，未向新会话发送关闭操作',409,'DESKTOP_CLIENT_CHANGED');return {closed:true as const};
 }
 info(id:string){return [...this.records.values()].filter(record=>record.id===id).map(record=>({application:record.application,viewId:record.viewId,ready:record.ready&&!record.cleanup&&this.same(record)&&this.display.readyEntry(id)===record.entry}));}
 states(id:string):WindowsDesktopClientState[]{return (['grok-bot','claude-desktop'] as const).map(app=>{const record=this.records.get(this.key(id,app));if(!record)return {id:app,state:'idle',viewId:null,rendererProtected:null};if(!this.same(record))return {id:app,state:'unavailable',viewId:null,rendererProtected:null};const ready=record.ready&&!record.cleanup&&this.display.readyEntry(id)===record.entry;return {id:app,state:record.failure?'failed':record.cleanup?'stopping':ready?'running':'starting',viewId:record.viewId,rendererProtected:ready?true:null};});}
 private async view(id:string,application:DesktopAppId,viewId:string){windowsDesktopComponentId.parse(application);const record=this.records.get(this.key(id,application));if(!record||record.viewId!==viewId)throw new AppError('客户端画面已变化，请刷新状态',409,'DESKTOP_CLIENT_VIEW_CHANGED');await this.assertRecord(record);this.current(record);if(!record.ready)throw new AppError('客户端画面尚未就绪',409,'DESKTOP_CLIENT_NOT_READY');return record;}
 async viewTicket(id:string,application:DesktopAppId,viewId:string){const record=await this.view(id,application,viewId);return this.display.transport.issue(id,record.scope);}
 async viewState(id:string,application:DesktopAppId,viewId:string){const record=await this.view(id,application,viewId);return {ready:true as const,display:record.entry!.display};}
 async focusView(id:string,application:DesktopAppId,viewId:string){
  const record=await this.view(id,application,viewId);if(record.focus)return record.focus;
  const previous=this.focusQueues.get(id);
  const operation=(previous??Promise.resolve()).catch(()=>{}).then(async()=>{
   this.current(record,record.controller.signal);await this.assertRecord(record,record.controller.signal);this.current(record,record.controller.signal);
   const result=parseWindowsDesktopClientFocus(JSON.stringify(await this.driver.focus(record.entry!.config,record.spec!,record.bootId!,{signal:record.controller.signal,onOutput:undefined})),record.spec!,record.bootId!);
   this.current(record,record.controller.signal);await this.assertRecord(record,record.controller.signal);this.current(record,record.controller.signal);return {focused:result.focused};
  }).finally(()=>{if(record.focus===operation)record.focus=undefined;if(this.focusQueues.get(id)===operation)this.focusQueues.delete(id);});
  record.focus=operation;this.focusQueues.set(id,operation);return operation;
 }
 async resizeView(id:string,application:DesktopAppId,viewId:string,input:DisplayRequest){const record=await this.view(id,application,viewId);return this.display.resize(id,input,undefined,{signal:record.controller.signal});}
 revoke(id:string){for(const record of this.records.values())if(record.id===id){record.ready=false;if(record.scope)this.display.transport.revokeScope(record.scope);record.controller.abort();if(!this.same(record)&&record.failure){record.cleanup=undefined;record.cancellation=undefined;record.releasing=undefined;record.failure=undefined;}void this.cleanup(record).catch(()=>{});}}
 dispose(){if(this.disposed)return;this.disposed=true;this.unsubscribe();for(const record of this.records.values()){record.ready=false;if(record.scope)this.display.transport.revokeScope(record.scope);record.removeAbort?.();record.removeAbort=undefined;record.controller.abort();}this.records.clear();this.openings.clear();}
}
