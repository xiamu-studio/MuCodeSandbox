import {createHash} from 'node:crypto';
import {mkdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import type {WindowsDesktopComponentStatus,WindowsDesktopComponentsStatus} from '../../../shared/windows-desktop-components.ts';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {WindowsManager} from './manager.ts';
import type {HyperVRuntime} from './runtime.ts';
import {downloadVerifiedAsset} from './download.ts';
import {windowsDesktopAsset} from './desktop-assets.ts';
import {windowsDesktopComponentInvocation} from './desktop-component-transport.ts';
import {runWindowsDesktopOwnedComponent} from './desktop-component-task.ts';

export const windowsDesktopComponentId=z.enum(['grok-bot','claude-desktop']);
export type WindowsDesktopArchive=(id:DesktopAppId,options:RunOptions)=>Promise<Uint8Array>;
const receipt=z.object({version:z.literal(1),state:z.enum(['verified','missing','pending','untrusted','busy'])}).strict();
export function parseWindowsDesktopComponentReceipt(text:string){
 const result=receipt.safeParse((()=>{try{return Buffer.byteLength(text)<=2048?JSON.parse(text):null;}catch{return null;}})());
 if(!result.success)throw new AppError('桌面组件回执无法核对，请刷新状态',502,'DESKTOP_COMPONENT_RECEIPT');return result.data;
}
const messages={verified:'固定版本组件已核验；本次未打开客户端。',missing:'尚未安装，可准备本应用批准的固定版本。',pending:'发现未完成的组件准备，可继续相同版本；原文件保留。',untrusted:'组件内容或权限无法核验，请保留原文件并核对记录。',busy:'桌面组件正在准备，请等待任务完成后刷新。',stopped:'环境已停止，本次未检测组件。',unavailable:'环境尚未就绪，请先启动并通过防护核验。'};
interface DesktopStatusRead {session:unknown;promise:Promise<WindowsDesktopComponentsStatus>}

export async function loadWindowsDesktopArchive(root:string,id:DesktopAppId,options:RunOptions={}):Promise<Uint8Array>{
 options.signal?.throwIfAborted();
 const asset=windowsDesktopAsset(id),cache=path.join(root,'desktop-components'),file=path.join(cache,asset.sha256+'.deb');
 for(const directory of [root,cache]){await mkdir(directory,{recursive:true});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new AppError('桌面组件缓存目录无法核对，原文件已保留',409,'DESKTOP_COMPONENT_CACHE');}
 try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==asset.bytes)throw new AppError('已有桌面组件缓存无法核对，原文件已保留',409,'DESKTOP_COMPONENT_CACHE');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await downloadVerifiedAsset(asset,file,{signal:options.signal,maxBytes:asset.bytes});}
 options.signal?.throwIfAborted();const named=await lstat(file),handle=await open(file,'r');
 try{const initial=await handle.stat();if(!initial.isFile()||named.isSymbolicLink()||initial.nlink!==1||initial.ino!==named.ino||initial.dev!==named.dev||initial.size!==asset.bytes)throw new AppError('桌面组件缓存身份已变化',409,'DESKTOP_COMPONENT_CACHE');
  const bytes=Buffer.alloc(asset.bytes+1);let length=0;while(length<bytes.length){options.signal?.throwIfAborted();const read=await handle.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
  const final=await handle.stat(),current=await lstat(file);options.signal?.throwIfAborted();
  if(length!==asset.bytes||final.size!==initial.size||final.nlink!==1||final.mtimeMs!==initial.mtimeMs||final.ctimeMs!==initial.ctimeMs||current.isSymbolicLink()||current.nlink!==1||current.ino!==initial.ino||current.dev!==initial.dev||createHash('sha256').update(bytes.subarray(0,length)).digest('hex')!==asset.sha256)throw new AppError('桌面组件缓存摘要无法核对，原文件已保留',409,'DESKTOP_COMPONENT_CACHE');return bytes.subarray(0,length);
 }finally{await handle.close();}
}

export class WindowsDesktopComponents {
 readonly manager:WindowsManager;readonly runtime:Pick<HyperVRuntime,'management'>;readonly archive:WindowsDesktopArchive;readonly enabled:boolean;
 private readonly statusReads=new Map<string,DesktopStatusRead>();private readonly statusOwners=new Set<DesktopStatusRead>();
 constructor(manager:WindowsManager,runtime:Pick<HyperVRuntime,'management'>,archive:WindowsDesktopArchive,enabled=false){this.manager=manager;this.runtime=runtime;this.archive=archive;this.enabled=enabled;}
 private value(id:DesktopAppId,state:WindowsDesktopComponentStatus['state']):WindowsDesktopComponentStatus{const asset=windowsDesktopAsset(id);return {id,state,installedVersion:state==='verified'?asset.version:null,availableVersion:asset.version,architecture:'amd64',message:messages[state]};}
 private current(id:string,session:unknown,signal?:AbortSignal){signal?.throwIfAborted();if(!session||this.manager.sessions.get(id)!==session||this.manager.sessions.get(id)?.state!=='active'||this.manager.store.get(id).state!=='running')throw new AppError('环境防护会话已变化，请重新检测桌面组件',409,'CONFIGURATION_CHANGED');}
 private async inspect(id:string,application:DesktopAppId,session:unknown,options:RunOptions={},insideTask=false){
  const e=await this.manager.assertAccess(id,insideTask);this.current(id,session,options.signal);const profile=await this.manager.profile(e);this.current(id,session,options.signal);const call=windowsDesktopComponentInvocation(application,'inspect');
  const text=await this.runtime.management(profile,call.command,{...options,input:undefined,inputBytes:call.inputBytes,onOutput:undefined,timeoutMs:60000,maxBytes:2048});this.current(id,session,options.signal);await this.manager.assertAccess(id,insideTask);this.current(id,session,options.signal);return this.value(application,parseWindowsDesktopComponentReceipt(text).state);
 }
 async status(id:string,options:RunOptions={}):Promise<WindowsDesktopComponentsStatus>{
  options.signal?.throwIfAborted();
  const e=this.manager.store.get(id),session=this.manager.sessions.get(id),ids=['grok-bot','claude-desktop'] as const;
  if(e.state!=='running')return {version:1,enabled:this.enabled,apps:ids.map(app=>this.value(app,e.state==='stopped'?'stopped':'unavailable'))};
  const active=this.manager.active.get(id);if(active&&this.manager.tasks.get(active)?.action==='install-desktop')return {version:1,enabled:this.enabled,apps:ids.map(app=>this.value(app,'busy'))};
  const existing=this.statusReads.get(id);if(existing&&existing.session===session)return this.waitStatus(id,existing,options.signal);
  if(this.statusOwners.size>=4)throw new AppError('正在读取其他环境的桌面组件状态，请稍后刷新',429,'DESKTOP_COMPONENT_STATUS_LIMIT');
  const owned={session} as DesktopStatusRead;
  owned.promise=(async()=>{const apps:WindowsDesktopComponentStatus[]=[];for(const app of ids){apps.push(await this.inspect(id,app,session,{...options,signal:undefined}));this.current(id,session);}return {version:1 as const,enabled:this.enabled,apps};})().finally(()=>{this.statusOwners.delete(owned);if(this.statusReads.get(id)===owned)this.statusReads.delete(id);});
  this.statusOwners.add(owned);this.statusReads.set(id,owned);return this.waitStatus(id,owned,options.signal);
 }
 private async waitStatus(id:string,owned:DesktopStatusRead,signal?:AbortSignal){
  let remove=()=>{};const waiting=signal?new Promise<never>((_resolve,reject)=>{const aborted=()=>{try{signal.throwIfAborted();}catch(error){reject(error);}};remove=()=>signal.removeEventListener('abort',aborted);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();}):undefined;
  try{const value=await(waiting?Promise.race([owned.promise,waiting]):owned.promise);this.current(id,owned.session,signal);return value;}finally{remove();}
 }
 async install(id:string,application:DesktopAppId,confirmation:string,options:RunOptions={}){
  if(!this.enabled)throw new AppError('桌面客户端组件准备尚未完成 Windows 实机验收，暂未开放',409,'DESKTOP_COMPONENT_UNAVAILABLE');windowsDesktopComponentId.parse(application);
  const session=this.manager.sessions.get(id),e=await this.manager.assertAccess(id,true);this.current(id,session,options.signal);if(e.name!==confirmation)throw new AppError('请输入完整环境名称以确认组件准备',400,'DESKTOP_COMPONENT_CONFIRMATION');
  const initial=await this.inspect(id,application,session,options,true);if(initial.state==='verified')return initial;if(initial.state==='untrusted'||initial.state==='busy')throw new AppError(initial.message,409,'DESKTOP_COMPONENT_UNTRUSTED');
  const bytes=await this.archive(application,options);this.current(id,session,options.signal);await this.manager.assertAccess(id,true);this.current(id,session,options.signal);const profile=await this.manager.profile(e);this.current(id,session,options.signal);const call=windowsDesktopComponentInvocation(application,'install',bytes);
  let text:string;try{text=await runWindowsDesktopOwnedComponent(this.runtime,profile,application,call,{assertCurrent:()=>this.current(id,session,options.signal),current:()=>this.manager.sessions.get(id)===session&&session?.state==='active'&&this.manager.store.get(id).state==='running',failProtection:reason=>this.manager.failProtection(id,reason)},options);}catch(error){if(error instanceof AppError&&error.code==='DESKTOP_COMPONENT_STOP_UNCONFIRMED')throw error;options.signal?.throwIfAborted();this.current(id,session);throw new AppError('桌面组件准备未完成，已保留暂存；请刷新状态后继续相同版本',409,'DESKTOP_COMPONENT_PENDING');}
  this.current(id,session,options.signal);if(parseWindowsDesktopComponentReceipt(text).state!=='verified')throw new AppError('桌面组件尚未准备完成，请刷新状态',409,'DESKTOP_COMPONENT_PENDING');const verified=await this.inspect(id,application,session,options,true);if(verified.state!=='verified')throw new AppError('准备后的桌面组件未通过核验',409,'DESKTOP_COMPONENT_VERIFY');this.manager.store.log(id,null,'固定版本桌面组件已核验；未打开客户端或登录账号');return verified;
 }
}
