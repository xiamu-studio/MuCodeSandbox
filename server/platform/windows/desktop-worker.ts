import path from 'node:path';
import {z} from 'zod';
import {run} from '../../process.ts';
import {createWindowsService} from './service.ts';
import {HyperVRuntime,powershellPath,powershellArgs} from './runtime.ts';
import {windowsRuntimeDirectory,windowsAppDirectory} from './paths.ts';
import {secureWindowsDirectory} from './credentials.ts';
import {installedBrokerPath,startBroker,installBroker,cleanWindowsEnvironment} from './broker.ts';
import {watchWindowsDesktopOwner} from './desktop-owner.ts';
import {createWindowsRecoveryService} from './recovery-service.ts';
import {beginWindowsBrokerShutdown,confirmWindowsBrokerShutdown} from './desktop-shutdown.ts';

let started=false,initializing=true,closing:Promise<void>|undefined,service:Awaited<ReturnType<typeof createWindowsService>>|undefined,broker:Awaited<ReturnType<typeof startBroker>>|undefined,runtime:HyperVRuntime|undefined;
let ownerWatch:{stop:()=>void}|undefined;
let recoveryService:Awaited<ReturnType<typeof createWindowsRecoveryService>>|undefined;
const send=(value:object)=>{if(process.connected)process.send?.({version:1,...value});};
async function exitWithMessage(value:object,code:number){ownerWatch?.stop();if(process.connected)await new Promise<void>(resolve=>process.send?.({version:1,...value},()=>resolve()));if(process.connected)process.disconnect();process.exit(code);}
async function shutdown(orphan=false){
 if(closing)return closing;
 if(initializing){await exitWithMessage({type:'stopped'},0);return;}
 closing=(async()=>{
  send({type:'status',phase:'stopping'});
  if(orphan){
   for(const task of service?.manager.tasks.values()??[])task.controller.abort();
   await runtime?.disconnect().catch(()=>{});
   // Owner loss is a security shutdown. Do not wait for renderer sockets or
   // guest synchronization before issuing independent hypervisor force-off.
   await broker?.call('shutdown-status',{}, {timeoutMs:5000}).catch(()=>{});
   // No desktop remains to acknowledge a graceful close. Release the owner
   // immediately so the protected broker also performs its independent sweep.
   ownerWatch?.stop();process.exit(0);
  }
  const initialStatus=runtime&&broker?await beginWindowsBrokerShutdown(broker):undefined;
  await recoveryService?.close();recoveryService=undefined;await service?.close();service=undefined;
  if(runtime&&broker)await confirmWindowsBrokerShutdown(broker,{initialStatus});
  await broker?.call('shutdown').catch(()=>{});await exitWithMessage({type:'stopped'},0);
 })().catch(error=>{closing=undefined;send({type:'stop-error',message:error instanceof Error?error.message:'无法确认环境停止'});if(orphan){ownerWatch?.stop();process.exit(1);}});
 return closing;
}
const ownerLost=()=>{const deadline=setTimeout(()=>process.exit(1),10000);deadline.unref();void shutdown(true);};
process.once('disconnect',ownerLost);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void shutdown(true);});
process.on('message',raw=>{void(async()=>{
 const value=z.discriminatedUnion('type',[z.object({version:z.literal(1),type:z.literal('start'),rootDir:z.string().refine(path.isAbsolute),mode:z.enum(['normal','recovery']).default('normal')}).strict(),z.object({version:z.literal(1),type:z.literal('shutdown')}).strict()]).parse(raw);
 if(value.type==='shutdown'){await shutdown();return;}if(started)return;started=true;
 try{
  if(process.platform!=='win32')throw Error('Windows 桌面入口只能在 Windows 上运行');
  ownerWatch=await watchWindowsDesktopOwner(process.ppid,ownerLost);
  const elevated=await run(powershellPath(),powershellArgs("[Console]::Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"),{env:cleanWindowsEnvironment(),timeoutMs:10000});if(elevated.trim()!=='False')throw Error('请以普通用户身份启动 Windows 桌面程序');
  const root=windowsRuntimeDirectory();await secureWindowsDirectory(root);process.chdir(root);await secureWindowsDirectory(windowsAppDirectory());send({type:'status',phase:'checking'});
  let executable:string;
  try{executable=await installedBrokerPath();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&(error as {code?:string}).code!=='BROKER_UPDATE_REQUIRED')throw error;await installBroker(root,run,phase=>send({type:'status',phase}));send({type:'status',phase:'checking'});executable=await installedBrokerPath();}
  const onPhase=(phase:'authorizing'|'connecting')=>send({type:'status',phase});
  if(value.mode==='recovery'){
   broker=await startBroker(executable,{recoveryOnly:true,onPhase});send({type:'status',phase:'initializing'});recoveryService=await createWindowsRecoveryService({rootDir:value.rootDir,runtimeRoot:root,broker,returnToNormal:()=>send({type:'mode-request',mode:'normal'})});initializing=false;send({type:'ready',url:recoveryService.launchUrl(),pid:process.pid});
  }else{
   broker=await startBroker(executable,{detectHost:true,onPhase});send({type:'status',phase:'initializing'});runtime=new HyperVRuntime(root,undefined,broker);service=await createWindowsService({rootDir:value.rootDir,runtimeRoot:root,runtime,enableDiskCompactionPreview:true,enableLocalCheckPreview:true,enableAgentPreview:true});initializing=false;send({type:'ready',url:service.launchUrl(),pid:process.pid,hostLabWindowKey:service.hostLabWindowKey});
  }
 }catch(error){initializing=false;await recoveryService?.close().catch(()=>{});await service?.close().catch(()=>{});await broker?.call('shutdown').catch(()=>{});await exitWithMessage({type:'error',message:error instanceof Error?error.message:'Windows 服务初始化失败'},1);}
 })().catch(()=>{send({type:'error',message:'无效的桌面管理请求'});process.exit(1);});});
if(!process.connected)throw Error('Windows desktop worker requires its owning IPC channel');
