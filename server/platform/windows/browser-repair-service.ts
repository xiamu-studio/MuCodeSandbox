import {createHash} from 'node:crypto';
import {lstat,mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {WindowsManager} from './manager.ts';
import type {HyperVRuntime} from './runtime.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';
import {approvedWindowsBrowserRelease} from './browser-releases.ts';
import {WINDOWS_BROWSER_REPAIR_OBSERVATION,parseWindowsBrowserRepairObservation} from './browser-repair-observation.ts';
import {downloadVerifiedAsset} from './download.ts';
import {WINDOWS_BROWSER_VERSION_SCRIPT,parseWindowsBrowserVersion} from './browser-installation.ts';
import {WINDOWS_BROWSER_REPAIR_STATE_PYTHON,windowsBrowserRepairState,WINDOWS_BROWSER_REPAIR_BOOTSTRAP,windowsBrowserRepairInput} from './browser-repair.ts';

export type WindowsBrowserRepairArchive=(options:RunOptions,version:string)=>Promise<Uint8Array>;
const stages=new Set(['active-published','archive-ready','candidate-prepared','new-component-published','publication-durable','receipt-published']);
export function parseWindowsBrowserRepairResult(source:string,begin:boolean,version:string=WINDOWS_CHROME.version){
 approvedWindowsBrowserRelease(version);const resultSchema=z.object({state:z.literal('repaired'),version:z.literal(version),retainedPrevious:z.boolean(),cleanupWarning:z.boolean()}).strict();
 const lines=source.trim().split(/\r?\n/);if(lines.length>32)throw new AppError('组件恢复回执超出边界',502,'BROWSER_REPAIR_RECEIPT_INVALID');
 for(const line of lines.slice(0,-1))if(!line.startsWith('MU_WINDOWS_BROWSER_REPAIR ')||!stages.has(line.slice(26)))throw new AppError('组件恢复回执无法核对',502,'BROWSER_REPAIR_RECEIPT_INVALID');
 let raw:unknown;try{raw=JSON.parse(lines.at(-1)!);}catch{throw new AppError('组件恢复回执无法核对',502,'BROWSER_REPAIR_RECEIPT_INVALID');}
 if(!begin&&z.object({state:z.literal('none')}).strict().safeParse(raw).success)return {state:'none' as const};
 const parsed=resultSchema.safeParse(raw);if(!parsed.success)throw new AppError('组件恢复回执无法核对',502,'BROWSER_REPAIR_RECEIPT_INVALID');return parsed.data;
}

// Reuse the setup cache. Never replace an existing unknown file. Both the host
// read and the root guest independently verify the fixed approved archive.
export async function loadWindowsBrowserRepairArchive(runtimeRoot:string,options:RunOptions={},version:string=WINDOWS_CHROME.version):Promise<Uint8Array>{
 const release=approvedWindowsBrowserRelease(version),setup=path.join(runtimeRoot,'setup'),assets=path.join(setup,'assets'),file=path.join(assets,version===WINDOWS_CHROME.version?'chrome.deb':'chrome-'+version+'.deb');
 options.signal?.throwIfAborted();
 for(const directory of [runtimeRoot,setup,assets]){await mkdir(directory,{recursive:true});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new AppError('组件缓存路径无法核对，原文件已保留',409,'BROWSER_REPAIR_CACHE_INVALID');}
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==release.bytes)throw new AppError('已有浏览器组件缓存无法核对，原文件已保留',409,'BROWSER_REPAIR_CACHE_INVALID');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await downloadVerifiedAsset(release,file,{signal:options.signal,maxBytes:release.bytes});}
 options.signal?.throwIfAborted();const before=await lstat(file),handle=await open(file,'r');
 try{
  const opened=await handle.stat();if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!opened.isFile()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==release.bytes)throw new AppError('浏览器组件缓存身份变化，原文件已保留',409,'BROWSER_REPAIR_CACHE_INVALID');
  const buffer=Buffer.alloc(release.bytes+1);let length=0;
  while(length<buffer.length){options.signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
  const after=await handle.stat(),named=await lstat(file);
  if(length!==release.bytes||after.nlink!==1||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||!named.isFile()||named.nlink!==1||named.size!==opened.size||named.isSymbolicLink()||named.ino!==opened.ino||named.dev!==opened.dev||named.mtimeMs!==after.mtimeMs||named.ctimeMs!==after.ctimeMs||createHash('sha256').update(buffer.subarray(0,length)).digest('hex')!==release.sha256)throw new AppError('浏览器组件缓存校验失败，原文件已保留',409,'BROWSER_REPAIR_CACHE_INVALID');
  return buffer.subarray(0,length);
 }finally{await handle.close();}
}

export class WindowsBrowserComponentRecovery{
 readonly manager:Pick<WindowsManager,'sessions'|'assertAccess'|'profile'|'store'>;readonly runtime:Pick<HyperVRuntime,'management'>;readonly closeBrowser:(id:string)=>Promise<void>;readonly archive:WindowsBrowserRepairArchive;readonly enabled:boolean;
 constructor(manager:Pick<WindowsManager,'sessions'|'assertAccess'|'profile'|'store'>,runtime:Pick<HyperVRuntime,'management'>,closeBrowser:(id:string)=>Promise<void>,archive:WindowsBrowserRepairArchive,enabled=false){this.manager=manager;this.runtime=runtime;this.closeBrowser=closeBrowser;this.archive=archive;this.enabled=enabled;}
 private async run(id:string,begin:boolean,confirmation:string|undefined,options:RunOptions){
  if(!this.enabled)throw new AppError('浏览器组件恢复尚未完成 Windows 实机验收，暂未开放',409,'BROWSER_REPAIR_UNAVAILABLE');
  options.signal?.throwIfAborted();const session=this.manager.sessions.get(id),environment=await this.manager.assertAccess(id,true),digest=createHash('sha256').update(JSON.stringify(environment)).digest('hex');
  const current=()=>{options.signal?.throwIfAborted();if(!session||this.manager.sessions.get(id)!==session||session.state!=='active'||this.manager.store.get(id).state!=='running'||createHash('sha256').update(JSON.stringify(this.manager.store.get(id))).digest('hex')!==digest)throw new AppError('环境已变化，请重新核对组件恢复状态',409,'CONFIGURATION_CHANGED');};
  current();if(begin&&environment.name!==confirmation)throw new AppError('环境名称已变化，请重新确认组件恢复范围',400,'BROWSER_REPAIR_CONFIRMATION');
  const config=await this.manager.profile(environment);current();
  const observed=parseWindowsBrowserRepairObservation(await this.runtime.management(config,['sudo','-n','/usr/bin/python3','-I','-'],{...options,input:WINDOWS_BROWSER_REPAIR_OBSERVATION,timeoutMs:20000,maxBytes:8192}));current();const selected=observed.selectedVersion;
  if(begin){await this.closeBrowser(id);current();}
  await this.manager.assertAccess(id,true);current();const archive=await this.archive(options,selected);current();await this.manager.assertAccess(id,true);current();
  const reply=await this.runtime.management(config,['sudo','-n','/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_BOOTSTRAP],{...options,inputBytes:windowsBrowserRepairInput(archive,begin,selected,observed.pending?.epoch??null),timeoutMs:300000,maxBytes:16384});current();
  const result=parseWindowsBrowserRepairResult(reply,begin,selected);await this.manager.assertAccess(id,true);current();
  const remaining=windowsBrowserRepairState(await this.runtime.management(config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_REPAIR_STATE_PYTHON],{...options,timeoutMs:20000,maxBytes:1024}));current();if(remaining!=='none')throw new AppError('浏览器组件恢复仍未完成，请保持浏览器关闭并检查操作记录',409,'BROWSER_REPAIR_PENDING');
  const installed=parseWindowsBrowserVersion(await this.runtime.management(config,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_VERSION_SCRIPT],{...options,timeoutMs:20000,maxBytes:8192}));current();await this.manager.assertAccess(id,true);current();if(installed.installationState!=='verified'||installed.installedVersion!==selected||installed.selectedVersion!==selected)throw new AppError('恢复后的浏览器组件未通过核验，请保持浏览器关闭',409,'BROWSER_REPAIR_VERIFY_FAILED');
  this.manager.store.log(id,null,result.state==='repaired'&&result.cleanupWarning?'浏览器组件已恢复；旧组件与待核对缓存保留。浏览器资料、项目和线路保留。':'浏览器组件恢复核验完成；浏览器资料、项目和线路保留。');return result;
 }
 repair(id:string,confirmation:string,options:RunOptions={}){return this.run(id,true,confirmation,options);}
 resume(id:string,options:RunOptions={}){return this.run(id,false,undefined,options);}
}
