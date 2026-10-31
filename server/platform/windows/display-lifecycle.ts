import {randomBytes} from 'node:crypto';
import type {Duplex} from 'node:stream';
import type {Environment} from '../../../shared/types.ts';
import type {RunOptions} from '../../process.ts';
import {displayRequestSchema,type DisplayRequest,type GuestDisplay} from '../../../shared/guest-display.ts';
import {AppError} from '../../errors.ts';
import type {WindowsConfig} from './config.ts';
import type {WindowsNetworkSession} from './session.ts';
import {WindowsDisplayTransport} from './display-transport.ts';

export type WindowsDisplayOwner='browser'|'grok-bot'|'claude-desktop'|'files';
export interface WindowsDisplayLease {readonly environmentId:string;readonly owner:WindowsDisplayOwner}
interface Session {readonly id:string;state:WindowsNetworkSession['state']}
export interface WindowsDisplayManagerPort {
 sessions:ReadonlyMap<string,Session>;store:{get(id:string):Environment};
 assertAccess(id:string,allowBusy?:boolean):Promise<Environment>;profile(environment:Environment):Promise<WindowsConfig>;
 failProtection?(id:string,reason:string):Promise<void>;
}
export interface WindowsDisplayEntry {environment:Environment;config?:WindowsConfig;sessionId:string;password:string;ready:boolean;closed:boolean;streams:Set<Duplex>;vnc?:()=>Duplex;protection?:Promise<void>;display?:GuestDisplay}
export type WindowsPreparedDisplay=WindowsDisplayEntry&{config:WindowsConfig};
export type WindowsDisplayMutationOptions=RunOptions&{assertCurrent():void};
export interface WindowsDisplayDriver {
 verify(entry:WindowsPreparedDisplay,options:RunOptions):Promise<void>;start(entry:WindowsPreparedDisplay,options:RunOptions):Promise<void>;
 channel(entry:WindowsPreparedDisplay,options:RunOptions):Promise<()=>Duplex>;resize(stream:Duplex,password:string):Promise<void>;
 check(entry:WindowsPreparedDisplay,options:RunOptions):Promise<void>;stop(entry:WindowsPreparedDisplay):Promise<void>;
 configure?(entry:WindowsPreparedDisplay,input:DisplayRequest,options:WindowsDisplayMutationOptions):Promise<GuestDisplay>;
}
interface Opening{entry:WindowsDisplayEntry;controller:AbortController;promise:Promise<void>}

// Leases are object capabilities: a stale or serialized lease cannot release a
// replacement display. No client/browser is launched by this owner manager.
export class WindowsDisplayLifecycle {
 readonly entries=new Map<string,WindowsDisplayEntry>();readonly transport:WindowsDisplayTransport<WindowsDisplayEntry>;
 readonly manager:WindowsDisplayManagerPort;readonly driver:WindowsDisplayDriver;
 onRevoked:((id:string)=>void)|undefined;
 private revokedListeners=new Set<(id:string)=>void>();
 private originals=new WeakMap<WindowsDisplayEntry,Session>();private owners=new WeakMap<WindowsDisplayEntry,Map<WindowsDisplayOwner,WindowsDisplayLease>>();
 private leases=new WeakMap<WindowsDisplayLease,WindowsDisplayEntry>();private controllers=new WeakMap<WindowsDisplayEntry,AbortController>();
 private openings=new Map<string,Opening>();private stops=new Map<string,{entry:WindowsDisplayEntry;promise:Promise<void>}>();
 private failures=new Map<string,WindowsDisplayEntry>();private disposed=false;
 private mutations=new WeakMap<WindowsDisplayEntry,{pending:number;tail:Promise<unknown>}>();
 private retiredMutations=new Map<string,Set<Promise<unknown>>>();
 constructor(manager:WindowsDisplayManagerPort,driver:WindowsDisplayDriver){this.manager=manager;this.driver=driver;this.transport=new WindowsDisplayTransport(this.entries,entry=>this.current(entry),id=>manager.assertAccess(id));}
 private sameSession(entry:WindowsDisplayEntry){const session=this.originals.get(entry);return !!session&&this.manager.sessions.get(entry.environment.id)===session&&session.state==='active';}
 private current(entry:WindowsDisplayEntry){try{return !this.disposed&&!entry.closed&&this.entries.get(entry.environment.id)===entry&&this.sameSession(entry)&&this.manager.store.get(entry.environment.id).state==='running';}catch{return false;}}
 private assertCurrent(entry:WindowsDisplayEntry,signal?:AbortSignal){signal?.throwIfAborted();if(!this.current(entry))throw new AppError('显示服务会话已变化',409,'DISPLAY_SESSION_CHANGED');}
 private async access(entry:WindowsDisplayEntry,signal?:AbortSignal){let environment:Environment;try{environment=await this.manager.assertAccess(entry.environment.id,true);}catch(error){if(this.entries.get(entry.environment.id)===entry)this.revoke(entry.environment.id);throw error;}this.assertCurrent(entry,signal);return environment;}
 private prepared(entry:WindowsDisplayEntry):WindowsPreparedDisplay{if(!entry.config)throw new AppError('显示服务尚未准备',409,'DISPLAY_NOT_READY');return entry as WindowsPreparedDisplay;}
 // Consumers must retain the original entry: audio tickets bind to object
 // identity, including when a replacement network session reuses an id.
 readyEntry(id:string):WindowsPreparedDisplay|undefined{const entry=this.entries.get(id);return entry?.ready&&entry.config&&this.current(entry)?this.prepared(entry):undefined;}
 subscribeRevoked(listener:(id:string)=>void){if(this.disposed)throw new AppError('显示服务正在退出',409,'CLOSING');this.revokedListeners.add(listener);return()=>{this.revokedListeners.delete(listener);};}
 private detach(entry:WindowsDisplayEntry){
  const id=entry.environment.id,owned=this.entries.get(id)===entry;entry.closed=true;entry.ready=false;this.owners.get(entry)?.clear();this.controllers.get(entry)?.abort();
  const mutation=this.mutations.get(entry);if(mutation?.pending){const pending=this.retiredMutations.get(id)??new Set<Promise<unknown>>();pending.add(mutation.tail);this.retiredMutations.set(id,pending);void mutation.tail.catch(()=>{}).finally(()=>{pending.delete(mutation.tail);if(!pending.size&&this.retiredMutations.get(id)===pending)this.retiredMutations.delete(id);});}
  if(owned){this.entries.delete(id);this.transport.revoke(id);for(const listener of [this.onRevoked,...this.revokedListeners])try{listener?.(id);}catch{/* Every consumer must be revoked even if another cleanup failed. */}}
  for(const stream of entry.streams){try{stream.destroy();}catch{/* Revoke every remaining stream. */}}entry.streams.clear();
 }
 private stop(entry:WindowsDisplayEntry):Promise<void>{
  const id=entry.environment.id,existing=this.stops.get(id);if(existing?.entry===entry)return existing.promise;
  this.detach(entry);
  const promise=Promise.resolve().then(async()=>{
   await this.mutations.get(entry)?.tail.catch(()=>{});
   if(!entry.config||!this.sameSession(entry)||this.entries.has(id))return;
   try{await this.driver.stop(this.prepared(entry));if(this.failures.get(id)===entry)this.failures.delete(id);}
   catch(error){if(this.sameSession(entry)&&!this.entries.has(id))this.failures.set(id,entry);const failure=new AppError('显示服务停止尚未确认，请停止环境或重试关闭',409,'DISPLAY_STOP_UNCONFIRMED');failure.cause=error;throw failure;}
  }).finally(()=>{if(this.stops.get(id)?.entry===entry)this.stops.delete(id);});
  this.stops.set(id,{entry,promise});return promise;
 }
 private async prepare(task:Opening,options:RunOptions){
  const entry=task.entry,id=entry.environment.id,signal=task.controller.signal,runOptions={...options,signal,onOutput:undefined};let attempted=false;
  try{
   this.assertCurrent(entry,signal);const environment=await this.access(entry,signal);
   entry.config=await this.manager.profile(environment);this.assertCurrent(entry,signal);const prepared=this.prepared(entry);
   await this.driver.verify(prepared,runOptions);this.assertCurrent(entry,signal);await this.access(entry,signal);
   attempted=true;await this.driver.start(prepared,runOptions);this.assertCurrent(entry,signal);
   const factory=await this.driver.channel(prepared,runOptions);this.assertCurrent(entry,signal);
   entry.vnc=()=>{this.assertCurrent(entry);const stream=factory();entry.streams.add(stream);stream.once('close',()=>entry.streams.delete(stream));return stream;};
   await this.driver.resize(entry.vnc(),entry.password);this.assertCurrent(entry,signal);
   await this.driver.check(prepared,runOptions);this.assertCurrent(entry,signal);await this.access(entry,signal);entry.ready=true;
  }catch(error){
   this.detach(entry);
   if(attempted)try{await this.stop(entry);}catch(stopError){if(stopError instanceof Error)stopError.cause=new AggregateError([error,stopError.cause??stopError],'Display preparation and stop failed');throw stopError;}
   throw error;
  }finally{if(this.openings.get(id)===task)this.openings.delete(id);}
 }
 private cancel(entry:WindowsDisplayEntry,lease:WindowsDisplayLease){
  const owners=this.owners.get(entry);if(owners?.get(lease.owner)!==lease)return;
  owners.delete(lease.owner);if(owners.size)return;
  const task=this.openings.get(entry.environment.id);
  if(task?.entry===entry&&!entry.ready){this.detach(entry);return task.promise;}
  return this.stop(entry);
 }
 async acquire(id:string,owner:WindowsDisplayOwner,options:RunOptions={}):Promise<WindowsDisplayLease>{
  options.signal?.throwIfAborted();if(this.disposed)throw new AppError('显示服务正在退出',409,'CLOSING');
  if(!['browser','grok-bot','claude-desktop','files'].includes(owner))throw new AppError('显示使用者无效',400,'DISPLAY_OWNER_INVALID');
  const session=this.manager.sessions.get(id);if(!session||session.state!=='active'||this.manager.store.get(id).state!=='running')throw new AppError('请先启动并核验环境',409,'DISPLAY_SESSION_CHANGED');
  const waiting=this.stops.get(id);if(waiting)try{await waiting.promise;}catch(error){if(this.originals.get(waiting.entry)===session)throw error;}
  const retired=this.retiredMutations.get(id);if(retired)await Promise.allSettled([...retired]);
  const oldTask=this.openings.get(id);if(oldTask&&(oldTask.entry.closed||this.originals.get(oldTask.entry)!==session)){
   oldTask.controller.abort();await oldTask.promise.catch(error=>{if(error instanceof AppError&&error.code==='DISPLAY_STOP_UNCONFIRMED'&&this.originals.get(oldTask.entry)===session)throw error;});
  }
  options.signal?.throwIfAborted();if(this.disposed||this.manager.sessions.get(id)!==session||session.state!=='active')throw new AppError('显示服务会话已变化',409,'DISPLAY_SESSION_CHANGED');
  const failure=this.failures.get(id);if(failure){if(this.originals.get(failure)===session)throw new AppError('上次显示服务停止尚未确认',409,'DISPLAY_STOP_UNCONFIRMED');this.failures.delete(id);}
  let entry=this.entries.get(id),task=this.openings.get(id);
  if(entry&&!this.current(entry)){this.detach(entry);entry=undefined;}
  if(!entry){
   entry={environment:this.manager.store.get(id),sessionId:session.id,password:randomBytes(6).toString('base64url'),ready:false,closed:false,streams:new Set()};
   this.entries.set(id,entry);this.originals.set(entry,session);this.owners.set(entry,new Map());const controller=new AbortController();this.controllers.set(entry,controller);
   task={entry,controller,promise:Promise.resolve()};const active=task;task.promise=Promise.resolve().then(()=>this.prepare(active,options));task.promise.catch(()=>{});this.openings.set(id,task);
  }
  const owners=this.owners.get(entry)!,existing=owners.get(owner);
  if(existing){if(entry.ready){await this.access(entry,options.signal);await this.assertProtection(id);this.assertCurrent(entry,options.signal);return existing;}throw new AppError('此显示使用者正在准备',409,'DISPLAY_BUSY');}
  const lease=Object.freeze({environmentId:id,owner});owners.set(owner,lease);this.leases.set(lease,entry);
  let cleanup:Promise<void>|undefined,abort!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>{cleanup=this.cancel(entry!,lease);cleanup?.catch(()=>{});reject(options.signal?.reason??new Error('Display acquisition cancelled'));};options.signal?.addEventListener('abort',abort,{once:true});});
  const admission=task?.promise??Promise.resolve().then(async()=>{await this.access(entry!,options.signal);await this.assertProtection(id);this.assertCurrent(entry!,options.signal);});
  try{if(options.signal?.aborted)abort();await Promise.race([admission,cancelled]);options.signal?.throwIfAborted();this.assertCurrent(entry);if(!entry.ready||owners.get(owner)!==lease)throw new AppError('显示服务尚未准备',409,'DISPLAY_NOT_READY');return lease;}
  catch(error){cleanup??=this.cancel(entry,lease);await cleanup?.catch(stopError=>{if(stopError instanceof AppError&&stopError.code==='DISPLAY_STOP_UNCONFIRMED')throw stopError;});throw error;}
  finally{options.signal?.removeEventListener('abort',abort);}
 }
 async release(lease:WindowsDisplayLease){
  const entry=this.leases.get(lease);if(!entry)throw new AppError('显示使用凭据无法核对',409,'DISPLAY_LEASE_INVALID');
  const owners=this.owners.get(entry),id=entry.environment.id;
  if(this.entries.get(id)!==entry){const pending=this.stops.get(id);if(pending?.entry===entry)await pending.promise;else if(!this.entries.has(id)&&this.failures.get(id)===entry&&this.sameSession(entry))await this.stop(entry);return;}
  if(owners?.get(lease.owner)!==lease)return;owners.delete(lease.owner);if(!owners.size)await this.stop(entry);
 }
 async close(id:string){
  const pending=this.stops.get(id);if(pending){await pending.promise;return;}
  const task=this.openings.get(id);if(task){this.revoke(id);try{await task.promise;}catch(error){if(error instanceof AppError&&error.code==='DISPLAY_STOP_UNCONFIRMED')throw error;}return;}
  const entry=this.entries.get(id)??this.failures.get(id);if(entry)await this.stop(entry);
 }
 async assertProtection(id:string){
  const entry=this.entries.get(id);if(!entry?.ready)return;if(entry.protection)return entry.protection;
  const signal=this.controllers.get(entry)!.signal;
  const check=Promise.resolve().then(async()=>{this.assertCurrent(entry,signal);await this.driver.check(this.prepared(entry),{signal,onOutput:undefined});this.assertCurrent(entry,signal);}).catch(async error=>{
   if(this.entries.get(id)===entry){const original=this.sameSession(entry);this.revoke(id);if(original)try{await this.manager.failProtection?.(id,'显示服务身份核验失败');}catch{/* Preserve the inspection failure after attempting independent quarantine. */}}
   throw error;
  }).finally(()=>{if(entry.protection===check)entry.protection=undefined;});entry.protection=check;return check;
 }
 async resize(id:string,input:DisplayRequest,configure?:((entry:WindowsPreparedDisplay,options:WindowsDisplayMutationOptions)=>Promise<GuestDisplay>),options:RunOptions={}){
  const request=displayRequestSchema.parse(input),entry=this.readyEntry(id);if(!entry)throw new AppError('显示画面尚未连接',409,'DISPLAY_NOT_READY');
  const state=this.mutations.get(entry)??{pending:0,tail:Promise.resolve()};if(state.pending>=4)throw new AppError('显示设置正在处理中，请稍后重试',409,'DISPLAY_BUSY');
  const work=configure??(this.driver.configure?((value:WindowsPreparedDisplay,run:WindowsDisplayMutationOptions)=>this.driver.configure!(value,request,run)):undefined);
  if(!work)throw new AppError('独立显示缩放尚未就绪',409,'DISPLAY_RESIZE_UNAVAILABLE');
  state.pending++;const previous=state.tail;this.mutations.set(entry,state);
  const signal=options.signal?AbortSignal.any([options.signal,this.controllers.get(entry)!.signal]):this.controllers.get(entry)!.signal;
  const task=previous.catch(()=>{}).then(async()=>{
   this.assertCurrent(entry,signal);await this.access(entry,signal);await this.assertProtection(id);this.assertCurrent(entry,signal);
   const result=await work(entry,{...options,signal,onOutput:undefined,assertCurrent:()=>this.assertCurrent(entry,signal)});this.assertCurrent(entry,signal);
   entry.display=result;return result;
  }).finally(()=>{state.pending--;});state.tail=task;return task;
 }
 info(id:string){const candidate=this.entries.get(id),entry=candidate&&this.current(candidate)?candidate:undefined;return {running:!!entry?.ready,ready:!!entry?.ready,browserRunning:false as const,owners:entry?[...this.owners.get(entry)!.keys()]:[],stopUnconfirmed:!!this.failures.get(id)&&this.sameSession(this.failures.get(id)!)};}
 revoke(id:string){this.openings.get(id)?.controller.abort();const entry=this.entries.get(id);if(entry)this.detach(entry);else this.transport.revoke(id);}
 dispose(){if(this.disposed)return;this.disposed=true;for(const task of this.openings.values())task.controller.abort();for(const entry of this.entries.values())this.detach(entry);this.revokedListeners.clear();this.transport.dispose();}
}
