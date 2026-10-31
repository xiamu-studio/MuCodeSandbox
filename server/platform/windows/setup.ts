import {randomUUID} from 'node:crypto';
import {access,lstat,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {run} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {HyperVRuntime,CANONICAL_IMAGE,CANONICAL_NOCLOUD_PATCH,AMD64_TUNNEL,fileHash} from './runtime.ts';
import {windowsBaseSchema,windowsConfigSchema,type WindowsConfig} from './config.ts';
import {secureWindowsDirectory} from './credentials.ts';
import {downloadVerifiedAsset,type VerifiedAsset} from './download.ts';
import {WINDOWS_CHROME,WINDOWS_DISPLAY} from './browser-assets.ts';
import {desktopDependenciesScript,installDesktopAssets} from './desktop-install.ts';
import {VERIFY_WINDOWS_DESKTOP} from './browser-guest.ts';
import {packageProxy} from './package-proxy.ts';
import type {WindowsBase} from './manager.ts';
import type {WindowsSetupState,WindowsSetupPhase} from '../../../shared/windows-setup.ts';
import {setTimeout as delay} from 'node:timers/promises';

const resourceFailureSchema=z.enum(['RESOURCE_DISK','RESOURCE_MEMORY','RESOURCE_QUOTA','RESOURCE_FENCED','RESOURCE_BUSY','STORAGE_BUSY']);
type ResourceFailure=z.infer<typeof resourceFailureSchema>;
const resourceMessages:Record<ResourceFailure,string>={
 RESOURCE_DISK:'虚拟磁盘所在卷的空间不足，无法满足已有磁盘增长预留和本次准备所需空间。请检查系统设置中的存储信息，释放该卷空间后重试；现有环境数据已保留。',
 RESOURCE_MEMORY:'可用内存不足，无法同时为虚拟机和宿主保留所需内存。请关闭不使用的程序或虚拟机后重试；现有环境数据已保留。',
 RESOURCE_QUOTA:'已达到当前用户的虚拟磁盘容量上限。请检查系统设置中的已登记虚拟容量，处理不再需要的环境后重试；现有环境数据已保留。',
 RESOURCE_FENCED:'本次管理会话已被宿主资源保护关闭。请先解决磁盘空间或内存不足的问题，再退出并重新打开软件核验；现有环境数据已保留。',
 RESOURCE_BUSY:'另一项虚拟机启动操作仍在进行。请等待该操作结束后重试；现有环境数据已保留。',
 STORAGE_BUSY:'另一项镜像操作仍在进行。请等待该操作结束后重试；现有环境数据已保留。',
};
function resourceFailure(error:unknown):ResourceFailure|undefined{if(!(error instanceof AppError))return;const result=resourceFailureSchema.safeParse(error.code);return result.success?result.data:undefined;}
const journalSchema=z.object({version:z.literal(1),builder:windowsConfigSchema.optional(),base:windowsBaseSchema.optional(),status:z.enum(['running','ready','failed','cancelled','interrupted']),phase:z.string(),failureCode:resourceFailureSchema.optional()}).strict();
const cleanMessage=(phase:WindowsSetupPhase)=>phase.startsWith('download')?'组件下载或校验未完成，可重试并继续使用已下载分段。':phase==='checking'?'请先启用 Hyper-V 并安装 Windows OpenSSH 客户端，再重试。':phase==='cleaning'?'临时构建器清理尚未确认，数据已保留。':'Linux 组件准备未完成，可重试；现有环境数据已保留。';

export class WindowsSetup {
 private runtime:HyperVRuntime;private root:string;private options:{base?:WindowsBase;canPrepare:()=>boolean;publish:(base:WindowsBase)=>void};
 private readonly directory:string;private state:WindowsSetupState={status:'needed',phase:'checking',completedBytes:0,totalBytes:0,message:null,canPrepare:true};
 private builder:WindowsConfig|undefined;private prepared:WindowsBase|undefined;private controller:AbortController|undefined;private task:Promise<void>|undefined;private failureCode:ResourceFailure|undefined;
 constructor(runtime:HyperVRuntime,root:string,options:{base?:WindowsBase;canPrepare:()=>boolean;publish:(base:WindowsBase)=>void}){this.runtime=runtime;this.root=root;this.options=options;this.directory=path.join(root,'setup');}
 async initialize(){
  await secureWindowsDirectory(this.directory);
  try{const saved=journalSchema.parse(JSON.parse(await readFile(path.join(this.directory,'state.json'),'utf8')));this.builder=saved.builder;this.prepared=saved.base;if(saved.status==='failed'&&saved.failureCode){this.failureCode=saved.failureCode;this.state={...this.state,status:'failed',message:resourceMessages[saved.failureCode]};}else if(saved.status!=='ready')this.state={...this.state,status:'interrupted',message:'上次准备未完成，重试时会先清理临时构建器。'};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(this.options.base){if(this.options.base.image.startsWith('mu-base:'))await this.runtime.verifySealedBase(this.options.base);else{if((await lstat(this.options.base.image)).isSymbolicLink()||await fileHash(this.options.base.image)!==this.options.base.imageSha256)throw Error('Prepared base changed');}this.failureCode=undefined;this.state={...this.state,status:'ready',phase:'ready',message:null,canPrepare:false};}
 }
 snapshot():WindowsSetupState{return {...this.state,canPrepare:this.state.status!=='ready'&&!this.task&&this.options.canPrepare()};}
 get running(){return !!this.task;}
 start(){if(this.task)throw new AppError('正在准备 Linux 组件',409,'SETUP_BUSY');if(this.state.status==='ready')return this.snapshot();if(!this.options.canPrepare())throw new AppError('请先停止环境；已有基盘引用需要单独修复',409,'SETUP_ENVIRONMENT_BUSY');this.controller=new AbortController();this.failureCode=undefined;this.state={...this.state,status:'running',phase:'checking',message:null,completedBytes:0,totalBytes:0};this.task=this.prepare(this.controller.signal).catch(()=>{this.failureCode=undefined;this.state={...this.state,status:'failed',message:'准备状态无法完整保存，请检查本机磁盘后重试。'};}).finally(()=>{this.task=undefined;this.controller=undefined;});return this.snapshot();}
 cancel(){this.controller?.abort();return this.snapshot();}
 async close(){this.controller?.abort();await this.task;}
 async wait(){await this.task;}
 private async save(){
  const next=path.join(this.directory,'state.'+randomUUID()+'.next');await writeFile(next,JSON.stringify({version:1,builder:this.builder,base:this.prepared,status:this.state.status,phase:this.state.phase,failureCode:this.failureCode}),{flag:'wx'});
  // Windows readers may temporarily deny delete sharing. Keep the previous
  // journal intact; retry only the atomic replacement, never unlink it first.
  for(let attempt=0;;attempt++)try{await rename(next,path.join(this.directory,'state.json'));return;}catch(error){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;await delay(50*2**attempt);}
 }
 private async phase(phase:WindowsSetupPhase){this.state={...this.state,phase,completedBytes:0,totalBytes:0};await this.save();}
 private async download(asset:VerifiedAsset,target:string,maxBytes:number,signal:AbortSignal){await downloadVerifiedAsset(asset,target,{signal,maxBytes,onProgress:(completedBytes,totalBytes)=>{this.state={...this.state,completedBytes,totalBytes};}});}
 private async clean(){if(!this.builder)return;await this.phase('cleaning');await this.runtime.disconnect().catch(()=>{});await this.runtime.discardBaseBuilder(this.builder);this.builder=undefined;await this.save();}
 private async publish(signal:AbortSignal){const base=windowsBaseSchema.parse(this.prepared);await this.runtime.verifySealedBase(base);signal.throwIfAborted();await this.phase('publishing');const pointer=path.join(this.root,'protected-desktop-base.json');try{await access(pointer);throw new AppError('已有基盘引用已保留，请重新启动检查',409,'BASE_ALREADY_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const next=pointer+'.'+randomUUID()+'.next';await writeFile(next,JSON.stringify(base,null,2),{flag:'wx'});signal.throwIfAborted();await rename(next,pointer);this.options.publish(base);this.state={...this.state,status:'ready',phase:'ready',message:null};await this.save();}
 private async prepare(signal:AbortSignal){let proxy:Awaited<ReturnType<typeof packageProxy>>|undefined;let failure:unknown;
  try{
   await this.phase('checking');const doctor=await this.runtime.info();if(!doctor.available)throw Error('Host prerequisites unavailable');for(const name of ['ssh.exe','ssh-keygen.exe'])await access(path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH',name));
   await this.clean();if(this.prepared){signal.throwIfAborted();await this.publish(signal);return;}
   const assets=path.join(this.directory,'assets');await mkdir(assets,{recursive:true});
   await this.phase('download-base');const archive=path.join(assets,'canonical-amd64.vhd.tar.gz');await this.download(CANONICAL_IMAGE,archive,1500*1024*1024,signal);
   await this.phase('extracting');const image=path.join(assets,'canonical-source.vhd');let valid=false;try{if((await lstat(image)).isSymbolicLink())throw Error('Image link rejected');valid=await fileHash(image)===CANONICAL_NOCLOUD_PATCH.sourceSha256;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(!valid){try{await access(image);throw Error('Existing unverified source retained');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const tar=path.join(process.env.SystemRoot??'C:\\Windows','System32/tar.exe'),entries=(await run(tar,['-tf',archive],{signal,timeoutMs:60000,maxBytes:4096})).trim().split(/\r?\n/);if(entries.length!==1||!/^[-a-zA-Z0-9_.]+\.vhd$/.test(entries[0]))throw Error('Unexpected official image archive');const extract=path.join(assets,'extract-'+randomUUID());await mkdir(extract);await run(tar,['-xzf',archive,'-C',extract],{signal,timeoutMs:600000});const source=path.join(extract,entries[0]);if(await fileHash(source)!==CANONICAL_NOCLOUD_PATCH.sourceSha256)throw Error('Official raw image digest mismatch');await rename(source,image);}
   await this.phase('download-tunnel');const tunnel=path.join(assets,'sing-box-linux-amd64.tar.gz');await this.download(AMD64_TUNNEL,tunnel,100*1024*1024,signal);
   await this.phase('download-browser');await this.download(WINDOWS_CHROME,path.join(assets,'chrome.deb'),WINDOWS_CHROME.bytes+1,signal);
   await this.phase('download-display');await this.download(WINDOWS_DISPLAY,path.join(assets,'display.deb'),WINDOWS_DISPLAY.bytes+1,signal);
   proxy=await packageProxy();this.builder=windowsConfigSchema.parse({version:1,id:randomUUID(),image,imageSha256:CANONICAL_NOCLOUD_PATCH.sourceSha256,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:proxy.port},expectedIp:'203.0.113.10'});await this.save();const c=this.builder;
   await this.phase('creating');await this.runtime.create(c,{signal},'base-builder');
   await this.phase('booting');await this.runtime.start(c,{signal});await this.runtime.connectBootstrap(c);
   await this.phase('installing-system');await this.runtime.bootstrap(c,tunnel,{signal});
   await this.phase('installing-desktop');await this.runtime.management(c,['bash','-s'],{signal,input:desktopDependenciesScript('http://127.0.0.1:17401'),timeoutMs:1200000});await installDesktopAssets(this.runtime,c,assets,{signal});
   await this.phase('verifying');await this.runtime.management(c,['bash','-s'],{signal,input:VERIFY_WINDOWS_DESKTOP,timeoutMs:60000});await this.runtime.configure(c);const guard=await this.runtime.inspectGuard(c);if(guard.leaseActive||guard.remainingMs!==0)throw Error('Builder business permit must remain closed');
   await this.phase('sealing');this.prepared=await this.runtime.sealPreparedBase(c,{signal});await this.save();
   await this.clean();signal.throwIfAborted();await this.publish(signal);
  }catch(error){failure=error;const failedPhase=this.state.phase;try{await this.clean();}catch{this.failureCode=undefined;this.state={...this.state,status:'failed',phase:'cleaning',message:cleanMessage('cleaning')};await this.save();return;}this.failureCode=signal.aborted?undefined:resourceFailure(error);this.state={...this.state,status:signal.aborted?'cancelled':'failed',phase:failedPhase,message:signal.aborted?'准备已取消，临时构建器已确认清理。':this.failureCode?resourceMessages[this.failureCode]:cleanMessage(failedPhase)};await this.save();}
  finally{await proxy?.close();if(!failure&&this.state.status!=='ready')throw Error('Preparation did not reach a verified terminal state');}
 }
}
