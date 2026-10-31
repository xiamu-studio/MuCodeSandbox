import {createHash} from 'node:crypto';
import {mkdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {WindowsManager} from './manager.ts';
import type {HyperVRuntime} from './runtime.ts';
import {downloadVerifiedAsset} from './download.ts';
import {WINDOWS_AGENT} from './agent-assets.ts';
import {windowsAgentComponentProgram} from './agent-component.ts';
import type {WindowsAgentStatus} from '../../../shared/windows-agent.ts';

export type WindowsAgentArchive=(options:RunOptions)=>Promise<Uint8Array>;
const receipt=z.object({version:z.literal(1),state:z.enum(['verified','missing','pending','untrusted','busy'])}).strict();
export function parseWindowsAgentReceipt(text:string){const value=receipt.safeParse((()=>{try{return JSON.parse(text);}catch{return null;}})());if(!value.success)throw new AppError('Claude Code 组件回执无法核对，请刷新状态',502,'AGENT_RECEIPT_INVALID');return value.data;}
const messages={verified:'已核验批准的 Linux x64 原生组件。登录状态在专用终端内由你管理。',missing:'尚未安装，可安装本应用批准的 Linux x64 原生版本。',pending:'发现未完成的安装，可继续相同版本；项目和账号资料保留。',untrusted:'组件内容或权限无法核验，原文件已保留；请核对安装记录。',busy:'组件正在安装，请等待任务完成后刷新。',stopped:'环境已停止，本次未检测组件；启动并通过网络防护核验后再检测。',unavailable:'环境尚未就绪，本次未检测组件；请先核对当前环境状态。'};

// The host cache conveys bytes, never authority. The root guest independently
// checks the fixed archive and every file before its exclusive publication.
export async function loadWindowsAgentArchive(root:string,options:RunOptions={}):Promise<Uint8Array>{
 const cache=path.join(root,'agent-components'),file=path.join(cache,WINDOWS_AGENT.sha256+'.tgz');
 for(const directory of [root,cache]){await mkdir(directory,{recursive:true});const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink())throw new AppError('编程工具组件缓存路径无法核对，原文件已保留',409,'AGENT_CACHE_INVALID');}
 try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==WINDOWS_AGENT.bytes)throw new AppError('已有编程工具缓存无法核对，原文件已保留',409,'AGENT_CACHE_INVALID');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await downloadVerifiedAsset(WINDOWS_AGENT,file,{signal:options.signal,maxBytes:WINDOWS_AGENT.bytes});}
 options.signal?.throwIfAborted();const before=await lstat(file),handle=await open(file,'r');
 try{const opened=await handle.stat();if(!opened.isFile()||before.isSymbolicLink()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==WINDOWS_AGENT.bytes)throw new AppError('编程工具缓存身份已变化',409,'AGENT_CACHE_INVALID');const bytes=Buffer.alloc(WINDOWS_AGENT.bytes+1);let length=0;while(length<bytes.length){options.signal?.throwIfAborted();const r=await handle.read(bytes,length,bytes.length-length,length);if(!r.bytesRead)break;length+=r.bytesRead;}const after=await handle.stat(),named=await lstat(file);if(length!==WINDOWS_AGENT.bytes||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||named.isSymbolicLink()||named.ino!==opened.ino||named.dev!==opened.dev||createHash('sha256').update(bytes.subarray(0,length)).digest('hex')!==WINDOWS_AGENT.sha256)throw new AppError('编程工具组件摘要无法核对，原文件已保留',409,'AGENT_CACHE_INVALID');return bytes.subarray(0,length);}finally{await handle.close();}
}

export class WindowsAgent {
 readonly manager:WindowsManager;readonly runtime:Pick<HyperVRuntime,'management'>;readonly enabled:boolean;readonly archive:WindowsAgentArchive;
 constructor(manager:WindowsManager,runtime:Pick<HyperVRuntime,'management'>,archive:WindowsAgentArchive,enabled=false){this.manager=manager;this.runtime=runtime;this.archive=archive;this.enabled=enabled;}
 private value(state:WindowsAgentStatus['state']):WindowsAgentStatus{return {version:1,supported:true,enabled:this.enabled,state,installedVersion:state==='verified'?WINDOWS_AGENT.version:null,availableVersion:WINDOWS_AGENT.version,architecture:'x86_64',runtime:'native',message:messages[state]};}
 private current(id:string,session:unknown,signal?:AbortSignal){signal?.throwIfAborted();if(!session||this.manager.sessions.get(id)!==session||this.manager.sessions.get(id)?.state!=='active'||this.manager.store.get(id).state!=='running')throw new AppError('环境防护会话已变化，请重新检测编程工具',409,'CONFIGURATION_CHANGED');}
 async status(id:string,options:RunOptions={},insideTask=false):Promise<WindowsAgentStatus>{
  const e=this.manager.store.get(id);if(e.state!=='running')return this.value(e.state==='stopped'?'stopped':'unavailable');
  const active=this.manager.active.get(id);if(!insideTask&&active&&this.manager.tasks.get(active)?.action==='install-agent')return this.value('busy');
  const session=this.manager.sessions.get(id);const environment=await this.manager.assertAccess(id,insideTask);this.current(id,session,options.signal);const c=await this.manager.profile(environment);this.current(id,session,options.signal);
  const text=await this.runtime.management(c,['/usr/bin/python3','-I','-c',windowsAgentComponentProgram('inspect')],{...options,timeoutMs:30000,maxBytes:2048});this.current(id,session,options.signal);await this.manager.assertAccess(id,insideTask);this.current(id,session,options.signal);return this.value(parseWindowsAgentReceipt(text).state);
 }
 async install(id:string,confirmation:string,options:RunOptions={}){
  if(!this.enabled)throw new AppError('Claude Code 安装尚未完成 Windows 实机验收，暂未开放',409,'AGENT_UNAVAILABLE');
  const session=this.manager.sessions.get(id),e=await this.manager.assertAccess(id,true);this.current(id,session,options.signal);if(e.name!==confirmation)throw new AppError('请输入完整环境名称以确认安装',400,'AGENT_CONFIRMATION');
  const c=await this.manager.profile(e);this.current(id,session,options.signal);const initial=await this.status(id,options,true);if(initial.state==='verified')return initial;if(initial.state==='untrusted'||initial.state==='busy')throw new AppError(initial.message,409,'AGENT_COMPONENT_UNTRUSTED');
  const bytes=await this.archive(options);this.current(id,session,options.signal);await this.manager.assertAccess(id,true);this.current(id,session,options.signal);
  let text:string;try{text=await this.runtime.management(c,['sudo','-n','/usr/bin/python3','-I','-c',windowsAgentComponentProgram('install')],{...options,inputBytes:bytes,timeoutMs:600000,maxBytes:2048});}catch(error){options.signal?.throwIfAborted();throw new AppError('Claude Code 安装未完成，已保留组件暂存；请刷新状态后继续，项目和账号资料保留',409,'AGENT_INSTALL_PENDING');}
  this.current(id,session,options.signal);if(parseWindowsAgentReceipt(text).state!=='verified')throw new AppError('组件尚未安装完成，请刷新状态后继续',409,'AGENT_INSTALL_PENDING');const verified=await this.status(id,options,true);if(verified.state!=='verified')throw new AppError('安装后的组件尚未通过核验',409,'AGENT_VERIFY_FAILED');this.manager.store.log(id,null,'已核验批准的 Claude Code Linux x64 原生组件；未登录账号或提交内容');return verified;
 }
 async assertLaunch(id:string){if(!this.enabled)throw new AppError('Claude Code 专用终端尚未开放',409,'AGENT_UNAVAILABLE');const status=await this.status(id);if(status.state!=='verified')throw new AppError('请先安装并核验 Claude Code 组件',409,'AGENT_NOT_INSTALLED');}
}
