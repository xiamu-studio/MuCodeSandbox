import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import {lookup} from 'node:dns/promises';
import {isIPv4} from 'node:net';
import {cpus,totalmem,freemem,hostname} from 'node:os';
import path from 'node:path';
import type {Environment,Job,Snapshot,NetworkProtection} from '../../../shared/types.ts';
import {VERSION} from '../../../shared/version.ts';
import {Store} from '../../store.ts';
import {environmentSchema,redact} from '../../validation.ts';
import {AppError,errorMessage} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import {HyperVRuntime} from './runtime.ts';
import {windowsConfigSchema,windowsPaths,vmIdentity,type WindowsConfig} from './config.ts';
import type {WindowsNetworkSession} from './session.ts';

export interface WindowsBase {image:string;imageSha256:string}
export type WindowsBackend=Pick<HyperVRuntime,'info'|'create'|'start'|'stop'|'state'|'session'|'connect'|'inspectGuard'>;
export interface WindowsManagerOptions {runtimeRoot:string;base?:WindowsBase;probe?:(config:WindowsConfig)=>()=>Promise<{receiver:string;ip:string}[]>}

// Windows owns its lifecycle and storage integration. The shipping Mac
// Manager and service continue to use their existing constructors unchanged.
export class WindowsManager {
 readonly store:Store;readonly runtime:WindowsBackend;readonly options:WindowsManagerOptions;
 readonly active=new Map<string,string>();readonly sessions=new Map<string,WindowsNetworkSession>();
 readonly profiles=new Map<string,WindowsConfig>();readonly tasks=new Map<string,{controller:AbortController;promise:Promise<void>}>();
 private timer:ReturnType<typeof setInterval>;private monitorTask:Promise<void>|undefined;private closeTask:Promise<void>|undefined;private closing=false;private hostIssue:string|null=null;
 constructor(store:Store,runtime:WindowsBackend,options:WindowsManagerOptions){
  this.store=store;this.runtime=runtime;this.options=options;
  this.timer=setInterval(()=>{void this.monitor();},8000);this.timer.unref();
 }
 private view(e:Environment){return this.store.public({...e,browserRunning:false});}
 private validate(input:unknown){
  const e=environmentSchema.parse(input);
  if(e.kind!=='vm'||!e.network.strict||!e.network.transparent||!e.network.egressLock||!['http','https','socks5'].includes(e.network.mode))throw new AppError('Windows 环境需要启用严格透明代理并批准出口 IPv4',400,'WINDOWS_STRICT_REQUIRED');
  if(e.mounts.length||e.ports.length)throw new AppError('Windows 持续共享和端口映射仍在适配；请先使用手动传输',409,'FEATURE_UNAVAILABLE');
  if(e.network.tls?.certificate)throw new AppError('Windows 自定义代理 CA 仍在适配，请使用受信任证书',409,'FEATURE_UNAVAILABLE');
  if(e.cpus>Math.min(16,cpus().length)||e.memoryGiB<2||e.memoryGiB>Math.min(32,Math.floor(totalmem()/2**30*.8))||e.diskGiB<16)throw new AppError('请使用可用的 CPU、至少 2 GiB 内存和至少 16 GiB 磁盘',400,'RESOURCE_LIMIT');
  return e;
 }
 async create(input:unknown){
  const parsed=this.validate(input),id=randomUUID(),now=new Date().toISOString();
  const e:Environment={...parsed,id,instanceName:vmIdentity(id).name,state:'not_created',browserRunning:false,lastError:null,createdAt:now,updatedAt:now};
  this.store.save(e);this.store.log(id,null,`已创建 Windows Linux 环境「${e.name}」`);return this.view(e);
 }
 async update(id:string,input:unknown){
  if(this.active.has(id)||this.sessions.has(id))throw new AppError('请先停止环境',409,'ENVIRONMENT_BUSY');
  const old=this.store.get(id),parsed=this.validate(input);
  if(old.state!=='not_created'&&(await this.runtime.state(await this.profile(old,false))).state!=='Off')throw new AppError('无法确认环境已停止，请先处理停机错误',409,'STOP_UNCONFIRMED');
  if(old.state!=='not_created'&&(old.cpus!==parsed.cpus||old.memoryGiB!==parsed.memoryGiB||old.diskGiB!==parsed.diskGiB))throw new AppError('已创建环境的资源调整仍在适配',409,'FEATURE_UNAVAILABLE');
  const e={...old,...parsed,network:{...parsed.network,password:parsed.network.password===undefined?old.network.password:parsed.network.password}};
  this.store.save(e);this.profiles.delete(id);return this.view(e);
 }
 async profile(e:Environment,resolve=true){
  const cached=this.profiles.get(e.id);if(cached)return cached;
  const address=isIPv4(e.network.host)?e.network.host:resolve?(await lookup(e.network.host,{family:4})).address:'127.0.0.1';
  const c=windowsConfigSchema.parse({version:1,id:e.id,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,timezone:e.identity.timezone,
   image:this.options.base?.image??path.join(this.options.runtimeRoot,'unprepared.vhdx'),imageSha256:this.options.base?.imageSha256??'0'.repeat(64),
   proxy:{mode:e.network.mode,address,port:e.network.port,username:e.network.username,password:e.network.password??'',serverName:e.network.tls?.serverName},expectedIp:e.network.egressLock?.expectedIp,dns:e.network.dns});
  if(resolve)this.profiles.set(e.id,c);return c;
 }
 async recover(){
  for(const e of this.store.list()){
   try{await access(windowsPaths(this.options.runtimeRoot,e.id).manifest);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){if(e.state!=='not_created')this.store.state(e.id,'error','运行清单缺失，需检查未完成的创建任务');continue;}throw error;}
   const c=await this.profile(e,false);
   try{const state=await this.runtime.state(c);if(state.state!=='Off')await this.runtime.stop(c);this.store.state(e.id,'stopped');}
   catch(error){this.store.state(e.id,'error','恢复时无法确认环境停机：'+redact(errorMessage(error)));}
  }
 }
 async snapshot():Promise<Snapshot>{
  const info=await this.runtime.info();
  return {environments:this.store.list().map(e=>this.view(e)),jobs:this.store.jobs(),system:{platform:'win32',arch:process.arch,hostname:hostname(),cpus:cpus().length,memoryGiB:Math.round(totalmem()/2**30),freeMemoryGiB:Math.round(freemem()/2**30),dataDir:this.store.dataDir,version:VERSION,
   runtime:{available:info.available&&!!this.options.base,path:info.available?'Hyper-V':null,version:'Windows Hyper-V',error:info.issues.join('；')||(!this.options.base?'请先准备空白受保护基盘':null)},browser:{available:false,engine:'Linux 客体浏览器（适配中）',native:false},hostNetwork:{state:this.hostIssue?'failed':'ready',issue:this.hostIssue}}};
 }
 async action(id:string,action:'start'|'stop'|'restart'){
  if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');if(action!=='stop'&&this.hostIssue)throw new AppError(this.hostIssue+'；请退出并重新打开 Windows 预览',409,'HOST_NETWORK_CHANGED');if(this.active.has(id))throw new AppError('环境正在执行其他操作',409,'ENVIRONMENT_BUSY');
  const e=this.store.get(id),job=this.store.newJob(id,action),controller=new AbortController();this.active.set(id,job.id);
  const promise=this.lifecycle(e,action,controller.signal).then(()=>{this.store.finishJob(job.id,'succeeded','操作完成');},error=>{
   this.store.state(id,'error',redact(errorMessage(error)));this.store.finishJob(job.id,controller.signal.aborted?'cancelled':'failed',errorMessage(error));
  }).finally(()=>{this.active.delete(id);this.tasks.delete(job.id);});
  this.tasks.set(job.id,{controller,promise});return job;
 }
 private async lifecycle(e:Environment,action:'start'|'stop'|'restart',signal:AbortSignal){
  const c=await this.profile(e,action!=='stop');
  if(action==='stop'||action==='restart'){
   const existing=this.sessions.get(e.id);this.sessions.delete(e.id);if(existing)await existing.fail();else await this.runtime.stop(c);this.store.state(e.id,'stopped');
  }
  if(action==='stop')return;
  if(!this.options.base)throw new AppError('请先准备空白受保护基盘',409,'BASE_MISSING');
  if(!(await this.runtime.info()).available)throw new AppError('Hyper-V 或管理员运行组件尚不可用',409,'RUNTIME_MISSING');
  const options:RunOptions={signal};
  try{
   let exists=true;try{await access(windowsPaths(this.options.runtimeRoot,e.id).manifest);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error;}
   this.store.state(e.id,exists?'starting':'creating');
   if(!exists)await this.runtime.create(c,options);signal.throwIfAborted();await this.runtime.start(c,options);signal.throwIfAborted();
   const session=await this.runtime.session(c,this.options.probe?.(c));this.sessions.set(e.id,session);await this.runtime.connect(c);signal.throwIfAborted();await session.open();signal.throwIfAborted();
   this.store.state(e.id,'running');this.store.log(e.id,null,'网络规则、出口和限时联网许可已通过核验');
  }catch(error){
   const session=this.sessions.get(e.id);this.sessions.delete(e.id);try{if(session)await session.fail();else await this.runtime.stop(c);}catch(stopError){throw new AggregateError([error,stopError],'启动失败且停机未确认');}throw error;
  }
 }
 async assertAccess(id:string){
  const e=this.store.get(id),session=this.sessions.get(id);if(e.state!=='running'||this.active.has(id)||session?.state!=='active')throw new AppError('环境防护尚未通过或已失效',409,'GUARD_FAILED');
  try{const guard=await this.runtime.inspectGuard(await this.profile(e));if(this.sessions.get(id)!==session||session.state!=='active'||!guard.leaseActive||guard.remainingMs<=0||guard.digest!==session.guardDigest)throw Error('联网许可或防护完整性已失效');}
  catch{await this.quarantine(id,'联网许可或防护完整性无法确认');throw new AppError('联网许可或防护完整性无法确认',409,'GUARD_FAILED');}return e;
 }
 async protection(id:string):Promise<NetworkProtection>{
  const e=this.store.get(id),session=this.sessions.get(id);if(!session||e.state!=='running')return {prepared:false,bootArmed:false,active:false,policy:'transparent',firewallActive:false,transparentReady:false,transparentActive:false,proxyEndpoints:[],blockedPackets:0,checkedAt:new Date().toISOString(),integrity:'inactive'};
  await this.assertAccess(id);const guard=await this.runtime.inspectGuard(await this.profile(e));return {prepared:true,bootArmed:true,active:session.state==='active'&&guard.leaseActive,policy:'transparent',firewallActive:true,transparentReady:true,transparentActive:true,proxyEndpoints:[`${e.network.host}:${e.network.port}`],blockedPackets:0,checkedAt:new Date().toISOString(),integrity:'verified',leasePrepared:true,leaseActive:guard.leaseActive,leaseRemainingMs:guard.remainingMs};
 }
 private async quarantine(id:string,issue:string){
  const session=this.sessions.get(id);this.sessions.delete(id);try{if(session)await session.fail();else await this.runtime.stop(await this.profile(this.store.get(id),false));this.store.state(id,'error',issue+'；环境已确认关闭');}
  catch(error){this.store.state(id,'error',issue+'；停机未确认：'+redact(errorMessage(error)));}
 }
 monitor(){
  if(this.monitorTask)return this.monitorTask;if(this.closing)return Promise.resolve();
  return this.monitorTask=Promise.all([...this.sessions].map(async([id,session])=>{if(this.active.has(id))return;try{await session.tick();}catch(error){if(this.sessions.get(id)===session)await this.quarantine(id,redact(errorMessage(error)));}})).then(()=>{}).finally(()=>{this.monitorTask=undefined;});
 }
 async hostUnavailable(reason:string){this.hostIssue=reason;for(const task of this.tasks.values())task.controller.abort();await Promise.all(this.store.list().filter(e=>['running','starting','creating'].includes(e.state)).map(e=>this.quarantine(e.id,reason)));}
 cancel(jobId:string){this.tasks.get(jobId)?.controller.abort();}
 async wait(jobId:string){await this.tasks.get(jobId)?.promise;}
 close(){return this.closeTask??=(async()=>{this.closing=true;clearInterval(this.timer);for(const task of this.tasks.values())task.controller.abort();await Promise.allSettled([...this.tasks.values()].map(t=>t.promise));await this.hostUnavailable('应用已退出');await this.monitorTask;this.store.close();this.store.key.fill(0);})();}
}
