import path from 'node:path';
import {z} from 'zod';
import {run} from '../../process.ts';
import {createWindowsService} from './service.ts';
import {HyperVRuntime,powershellPath,powershellArgs} from './runtime.ts';
import {windowsRuntimeDirectory,windowsAppDirectory} from './paths.ts';
import {secureWindowsDirectory} from './credentials.ts';
import {installedBrokerPath,startBroker,installBroker,cleanWindowsEnvironment} from './broker.ts';
import type {WindowsConfig} from './config.ts';
import {watchWindowsDesktopOwner} from './desktop-owner.ts';

let started=false,initializing=true,closing:Promise<void>|undefined,service:Awaited<ReturnType<typeof createWindowsService>>|undefined,broker:Awaited<ReturnType<typeof startBroker>>|undefined,runtime:HyperVRuntime|undefined,profiles:WindowsConfig[]|undefined;
let ownerWatch:{stop:()=>void}|undefined;
const send=(value:object)=>{if(process.connected)process.send?.({version:1,...value});};
async function exitWithMessage(value:object,code:number){ownerWatch?.stop();if(process.connected)await new Promise<void>(resolve=>process.send?.({version:1,...value},()=>resolve()));if(process.connected)process.disconnect();process.exit(code);}
async function shutdown(orphan=false){
 if(closing)return closing;
 if(initializing){await exitWithMessage({type:'stopped'},0);return;}
 closing=(async()=>{
  send({type:'status',phase:'stopping'});
  profiles??=service?await Promise.all(service.manager.store.list().map(e=>service!.manager.profile(e,false))):[];
  if(orphan){
   for(const task of service?.manager.tasks.values()??[])task.controller.abort();
   await runtime?.disconnect().catch(()=>{});
   // Owner loss is a security shutdown. Do not wait for renderer sockets or
   // guest synchronization before issuing independent hypervisor force-off.
   await Promise.all(profiles.map(async c=>{try{await broker!.call('stop',{id:c.id},{timeoutMs:30000});}catch{}}));
   // No desktop remains to acknowledge a graceful close. Release the owner
   // immediately so the protected broker also performs its independent sweep.
   ownerWatch?.stop();process.exit(0);
  }
  await service?.close();service=undefined;
  const failed:unknown[]=[];
  for(const c of profiles){try{if((await runtime!.allocation(c)).registered)await runtime!.stop(c);}catch(error){failed.push(error);}}
  if(failed.length)throw Error(`尚未确认 ${failed.length} 个环境停止，请重试`);
  await broker?.call('shutdown').catch(()=>{});await exitWithMessage({type:'stopped'},0);
 })().catch(error=>{closing=undefined;send({type:'stop-error',message:error instanceof Error?error.message:'无法确认环境停止'});if(orphan){ownerWatch?.stop();process.exit(1);}});
 return closing;
}
const ownerLost=()=>{const deadline=setTimeout(()=>process.exit(1),10000);deadline.unref();void shutdown(true);};
process.once('disconnect',ownerLost);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void shutdown(true);});
process.on('message',raw=>{void(async()=>{
 const value=z.discriminatedUnion('type',[z.object({version:z.literal(1),type:z.literal('start'),rootDir:z.string().refine(path.isAbsolute)}).strict(),z.object({version:z.literal(1),type:z.literal('shutdown')}).strict()]).parse(raw);
 if(value.type==='shutdown'){await shutdown();return;}if(started)return;started=true;
 try{
  if(process.platform!=='win32')throw Error('Windows 桌面入口只能在 Windows 上运行');
  ownerWatch=await watchWindowsDesktopOwner(process.ppid,ownerLost);
  const elevated=await run(powershellPath(),powershellArgs("[Console]::Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"),{env:cleanWindowsEnvironment(),timeoutMs:10000});if(elevated.trim()!=='False')throw Error('请以普通用户身份启动 Windows 桌面程序');
  const root=windowsRuntimeDirectory();await secureWindowsDirectory(root);process.chdir(root);await secureWindowsDirectory(windowsAppDirectory());send({type:'status',phase:'checking'});
  let executable:string;
  try{executable=await installedBrokerPath();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&(error as {code?:string}).code!=='BROKER_UPDATE_REQUIRED')throw error;send({type:'status',phase:'installing'});await installBroker(root);executable=await installedBrokerPath();}
  send({type:'status',phase:'authorizing'});broker=await startBroker(executable);runtime=new HyperVRuntime(root,undefined,broker);service=await createWindowsService({rootDir:value.rootDir,runtimeRoot:root,runtime});initializing=false;send({type:'ready',url:service.launchUrl(),pid:process.pid});
 }catch(error){initializing=false;await service?.close().catch(()=>{});await broker?.call('shutdown').catch(()=>{});await exitWithMessage({type:'error',message:error instanceof Error?error.message:'Windows 服务初始化失败'},1);}
 })().catch(()=>{send({type:'error',message:'无效的桌面管理请求'});process.exit(1);});});
if(!process.connected)throw Error('Windows desktop worker requires its owning IPC channel');
