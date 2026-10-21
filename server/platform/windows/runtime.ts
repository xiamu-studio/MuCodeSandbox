import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {Duplex} from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile, access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { run, type Runner, type RunOptions } from '../../process.ts';
import { shellQuote } from '../../network-guard.ts';
import { LEASE_HELPER_PATH } from '../../guest-lease.ts';
import { PROXY_SESSION } from '../../proxy-transport.ts';
import type { VmBackend } from '../contract.ts';
import { windowsConfigSchema, windowsPaths, vmIdentity, RELAY_PORT, PROBE_PORT, isSealedBase, windowsBaseSchema, type WindowsConfig } from './config.ts';
import { cloudInit, bootstrapScript, installAmd64TunnelScript, configureWindowsGuard, INSPECT_WINDOWS_GUARD, windowsEnvironment } from './guest.ts';
import { WindowsNetworkSession } from './session.ts';
import { measureEgress } from '../../egress.ts';
import {AppError} from '../../errors.ts';
import {GUEST_TASK_RUN,GUEST_TASK_CANCEL} from '../../guest-task.ts';
import type {HyperVBrokerClient,BrokerAction} from './broker.ts';

const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..','scripts/windows');
const inspection=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),leaseActive:z.boolean(),remainingMs:z.number().nonnegative().max(45000)}).strict();
const allocationSchema=z.discriminatedUnion('registered',[z.object({registered:z.literal(false)}).strict(),z.object({registered:z.literal(true),stage:z.string(),everReady:z.boolean(),platformId:z.uuid().nullable(),imageSha256:z.string().regex(/^[a-f0-9]{64}$/),cpus:z.number().int(),memoryGiB:z.number().int(),diskGiB:z.number().int()}).strict()]);
const recoverySchema=z.object({name:z.string(),state:z.literal('Off'),present:z.boolean(),platformId:z.uuid().nullable(),ready:z.boolean()}).strict();
export const AMD64_TUNNEL={version:'1.14.3',sha256:'e2bdf179c15a3652955dc44867e33ca0965c9c9b91b34267dcc5a5d639a5feee',
  url:'https://github.com/SagerNet/sing-box/releases/download/v1.14.3/sing-box-1.14.3-linux-amd64.tar.gz'};
export const CANONICAL_IMAGE={sha256:'cde3ca6a5aabe89702456cc5af69e2336600ce13c18898aba27e7212e3474e3f',
  url:'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'};
// The pinned archive's fixed VHD has an Azure-only cloud-init selector. This
// equal-length recipe was located through the ext4 inode for the named file,
// not by a global byte search. It applies only to a new private import copy.
export const CANONICAL_NOCLOUD_PATCH={
  sourceSha256:'c74a7d3b3476ffb2715bfcaf9c216e9dd1d6c7e01bc6d0380b1744518dfae15c',
  file:'/etc/cloud/cloud.cfg.d/90_dpkg.cfg',offset:2495315968,
  before:Buffer.from('# to update this file, run dpkg-reconfigure cloud-init\ndatasource_list: [ Azure ]\n').toString('base64'),
  after:Buffer.from('# to update this file, run dpkg-reconfigure cloud-init\ndatasource_list: [NoCloud]\n').toString('base64'),
};

export async function fileHash(file:string) {
  const hash=createHash('sha256');for await(const block of createReadStream(file))hash.update(block);return hash.digest('hex');
}
export function powershellPath() {return path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');}
export function powershellArgs(script:string) {
  // Configure the protocol before any module autoload: first-use progress is
  // otherwise serialized as CLIXML on stderr and corrupts JSON responses.
  const protocol="$ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n";
  return ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(protocol+script,'utf16le').toString('base64')];
}

export class HyperVRuntime implements VmBackend<WindowsConfig> {
  private transports=new Map<string,ChildProcessWithoutNullStreams>();
  private intentionalDisconnect=new Set<string>();
  private transportFailures=new Map<string,()=>void>();
  private vmIds=new Map<string,string>();
  private channels=new Map<string,{child:ChildProcessWithoutNullStreams;port:number}>();
  private serviceStreams=new Map<string,Set<Duplex>>();
  private baseBuilders=new Set<string>();
  readonly root:string;
  readonly runner:Runner;
  readonly broker:HyperVBrokerClient|undefined;
  constructor(root:string,runner:Runner=run,broker?:HyperVBrokerClient) {this.root=root;this.runner=runner;this.broker=broker;}
  get deletionAvailable(){return !!this.broker;}
  async allocation(c:WindowsConfig){if(!this.broker)throw new AppError('此入口未启用权限代理恢复',409,'FEATURE_UNAVAILABLE');return allocationSchema.parse(await this.broker.call('allocation',{id:c.id}));}
  private async metadataMarker(c:WindowsConfig){
    try{const file=path.join(windowsPaths(this.root,c.id).directory,'allocation.json');if(!(await lstat(file)).isFile())return false;return z.object({version:z.literal(1),id:z.literal(c.id),backend:z.literal('hyperv-broker')}).strict().parse(JSON.parse(await readFile(file,'utf8')))!==undefined;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  private async cleanMetadata(c:WindowsConfig,reset:boolean,checkOnly=false){
    const script=`& '${path.join(scripts,'clean-runtime-metadata.ps1').replaceAll("'","''")}'`;
    await this.runner(powershellPath(),powershellArgs(script),{input:JSON.stringify({root:path.resolve(this.root),id:c.id,reset,checkOnly}),timeoutMs:30000});
  }
  private async confirmUnregisteredAbsence(c:WindowsConfig){
    const request:Record<string,unknown>={id:c.id};
    try{const manifest=JSON.parse(await readFile(windowsPaths(this.root,c.id).manifest,'utf8'));if(manifest.id!==c.id)throw new AppError('运行清单身份不一致，已保留文件',409,'RECOVERY_IDENTITY_MISMATCH');request.platformId=z.uuid().parse(manifest.platformId);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const result=z.object({absent:z.boolean()}).strict().parse(await this.broker!.call('absence',request));if(!result.absent)throw new AppError('发现未由当前代理登记的资源，已保留文件，请先处理旧环境',409,'UNREGISTERED_RESOURCES');
  }
  private async publishManifest(c:WindowsConfig,platformId:string){
    const p=windowsPaths(this.root,c.id);
    for(const file of [p.key,p.hostKey,p.knownHosts]){const entry=await lstat(file);if(!entry.isFile()||entry.isSymbolicLink())throw new AppError('管理文件不完整，已保留虚拟磁盘',409,'RECOVERY_FILES_MISSING');}
    const manifest={version:1,id:c.id,platformId,imageSha256:c.imageSha256,purpose:c.imageSha256===CANONICAL_NOCLOUD_PATCH.sourceSha256?'builder':'environment',createdAt:new Date().toISOString()};
    try{const existing=JSON.parse(await readFile(p.manifest,'utf8'));if(existing.id!==c.id||existing.platformId!==platformId)throw new AppError('运行清单与已登记虚拟机不一致',409,'RECOVERY_IDENTITY_MISMATCH');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await writeFile(p.manifest,JSON.stringify(manifest),{flag:'wx'});}
    this.vmIds.set(c.id,platformId);
  }
  async recoverCreation(c:WindowsConfig){
    if(!this.broker)return false;const allocated=await this.allocation(c);if(!allocated.registered)return false;
    const recovered=recoverySchema.parse(await this.broker.call('recover',{id:c.id},{timeoutMs:45000}));
    if(!recovered.present||!recovered.ready)return false;
    await this.publishManifest({...c,imageSha256:allocated.imageSha256},recovered.platformId!);return true;
  }
  async remove(c:WindowsConfig){
    if(!this.broker)throw new AppError('请在普通用户权限代理入口删除环境',409,'FEATURE_UNAVAILABLE');
    await this.disconnect(c.id);this.closeChannel(c.id);
    await this.cleanMetadata(c,false,true);
    const allocated=await this.allocation(c);
    if(allocated.registered){
      const marker=path.join(windowsPaths(this.root,c.id).directory,'allocation.json');try{await writeFile(marker,JSON.stringify({version:1,id:c.id,backend:'hyperv-broker'}),{flag:'wx'});}catch(error){if(!['ENOENT','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
      const result=z.object({deleted:z.literal(true),vmAbsent:z.literal(true),switchAbsent:z.literal(true),storageAbsent:z.literal(true)}).strict().parse(await this.broker.call('delete',{id:c.id},{timeoutMs:120000}));if(!result.deleted)throw Error('Removal was not confirmed');
    }else{
      await this.confirmUnregisteredAbsence(c);
    }
    await this.cleanMetadata(c,false);this.vmIds.delete(c.id);this.transportFailures.delete(c.id);
  }
  private psScript(action:string) {return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); try { & '${path.join(scripts,'hyperv.ps1').replaceAll("'","''")}' -Action '${action}' } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;}
  async powershell(action:string,c?:WindowsConfig,options:RunOptions={}) {
    if(process.platform!=='win32')throw Error('Hyper-V backend requires Windows');
    if(this.broker){
      if(action==='register-channel')return '';
      if(action==='export-base')throw new AppError('基盘构建和导出仍使用独立管理员构建入口',409,'BROKER_EXPORT_UNAVAILABLE');
      const request:Record<string,unknown>=c?{id:c.id}:{};
      if(action==='disk'&&c)Object.assign(request,{image:isSealedBase(c.image)?c.image:path.resolve(c.image),imageSha256:c.imageSha256,cpus:c.cpus,memoryGiB:c.memoryGiB,diskGiB:c.diskGiB});
      if(action==='create'&&c)Object.assign(request,{seed:windowsPaths(this.root,c.id).seed,seedSha256:await fileHash(windowsPaths(this.root,c.id).seed)});
      return String(await this.broker.call(action==='disk'&&c&&this.baseBuilders.has(c.id)?'begin-base':action as BrokerAction,request,{...options,timeoutMs:options.timeoutMs??45000}));
    }
    const p=c?windowsPaths(this.root,c.id):undefined;
    const value=c?{...vmIdentity(c.id),...p,cpus:c.cpus,memoryGiB:c.memoryGiB,diskGiB:c.diskGiB,image:c.image,
      imagePatch:c.imageSha256===CANONICAL_NOCLOUD_PATCH.sourceSha256?CANONICAL_NOCLOUD_PATCH:null}:undefined;
    return this.runner(powershellPath(),powershellArgs(this.psScript(action)),{...options,input:value?JSON.stringify(value):undefined,timeoutMs:options.timeoutMs??30000});
  }
  async info() {return z.object({available:z.boolean(),issues:z.array(z.string())}).parse(JSON.parse(await this.powershell('doctor')));}
  async fingerprint() {return createHash('sha256').update((await this.powershell('fingerprint')).trim()).digest('hex');}
  async inspectVm(c:WindowsConfig) {const value=JSON.parse(await this.powershell('inspect',c));this.vmIds.set(c.id,z.uuid().parse(value.platformId));return value;}
  async state(c:WindowsConfig){return JSON.parse(await this.powershell('status',c));}
  async channelHelper() {
    const source=path.resolve(scripts,'../../native/windows/HyperVChannel.cs');
    const hash=createHash('sha256').update(await readFile(source)).digest('hex').slice(0,16);
    const directory=path.join(this.root,'tools');await mkdir(directory,{recursive:true});
    const target=path.join(directory,`hv-channel-${hash}.exe`);
    try{await access(target);}catch{
      const staging=target+'.'+randomUUID()+'.exe';
      try{
        await this.runner(powershellPath(),powershellArgs(`& '${path.join(scripts,'build-channel.ps1').replaceAll("'","''")}' -Destination '${staging.replaceAll("'","''")}'`),{timeoutMs:30000});
        await this.runner(staging,['--self-test'],{timeoutMs:5000});
        try{await rename(staging,target);}catch(error){await access(target);await this.runner(target,['--self-test'],{timeoutMs:5000});}
      }finally{await rm(staging,{force:true});}
    }
    return target;
  }
  private async ssh(c:WindowsConfig) {
    const p=windowsPaths(this.root,c.id),n=vmIdentity(c.id);
    const platformId=this.vmIds.get(c.id)??z.object({id:z.literal(c.id),platformId:z.uuid()}).passthrough().parse(JSON.parse(await readFile(p.manifest,'utf8'))).platformId;
    const port=await this.channelPort(c.id,platformId);
    return ['-F','none','-T','-p',String(port),'-i',p.key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
      '-o',`UserKnownHostsFile="${p.knownHosts.replaceAll('\\','/')}"`,'-o',`HostKeyAlias=${n.name}`,'-o','ConnectTimeout=5',
      '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','LogLevel=ERROR','mu@127.0.0.1'];
  }
  private async channelPort(id:string,platformId:string) {
    if(this.broker)return z.object({port:z.number().int().min(1).max(65535)}).strict().parse(await this.broker.call('channel',{id})).port;
    const existing=this.channels.get(id);if(existing&&existing.child.exitCode===null&&!existing.child.killed)return existing.port;
    const helper=await this.channelHelper();const child=spawn(helper,['--listen',platformId,String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let details='';child.stderr.on('data',b=>{details=(details+b).slice(-2048);});
    try{
      const port=await new Promise<number>((resolve,reject)=>{let line='';const timer=setTimeout(()=>reject(Error('Hyper-V loopback channel did not start')),10000);
        child.stdout.on('data',b=>{line+=b;if(line.length>4096){clearTimeout(timer);reject(Error('Oversized channel status'));return;}if(!line.includes('\n'))return;
          try{const data=z.object({port:z.number().int().min(1).max(65535)}).strict().parse(JSON.parse(line.split('\n')[0]));clearTimeout(timer);resolve(data.port);}catch(error){clearTimeout(timer);reject(error);}});
        child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Hyper-V loopback channel closed: '+details));});
      });
      this.channels.set(id,{child,port});return port;
    }catch(error){child.kill();throw error;}
  }
  private closeChannel(id:string){for(const stream of this.serviceStreams.get(id)??[])stream.destroy();this.serviceStreams.delete(id);if(this.broker)void this.broker.call('close-channel',{id}).catch(()=>{});const channel=this.channels.get(id);this.channels.delete(id);if(channel){channel.child.stdin.end();channel.child.kill();}}
  async serviceStreamFactory(c:WindowsConfig,service:'vnc'|'cdp'){
    const target=service==='vnc'?5900:service==='cdp'?9222:0;if(!target)throw Error('Unknown guest service');
    const args=await this.ssh(c),destination=args.pop()!,file=path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh.exe');
    return ()=>{
      const total=[...this.serviceStreams.values()].reduce((n,set)=>n+set.size,0),set=this.serviceStreams.get(c.id)??new Set<Duplex>();
      if(total>=32||set.size>=8)throw Error('Guest service connection limit reached');
      const child=spawn(file,[...args,'-o','ClearAllForwardings=yes','-o','IdentityAgent=none','-W',`127.0.0.1:${target}`,destination],{stdio:['pipe','pipe','pipe'],windowsHide:true});
      const stream=Duplex.from({writable:child.stdin,readable:child.stdout});set.add(stream);this.serviceStreams.set(c.id,set);child.stderr.resume();
      let force:ReturnType<typeof setTimeout>|undefined;
      child.once('error',()=>stream.destroy(Error('Guest service transport could not start')));child.once('close',()=>{clearTimeout(force);stream.destroy();});stream.on('error',()=>{});
      stream.once('close',()=>{set.delete(stream);if(!set.size&&this.serviceStreams.get(c.id)===set)this.serviceStreams.delete(c.id);if(child.exitCode===null&&child.signalCode===null){child.kill();force=setTimeout(()=>child.kill('SIGKILL'),2000);force.unref();}});
      return stream;
    };
  }
  async management(c:WindowsConfig,command:string[],options:RunOptions={}) {
    return this.runner(path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh.exe'),
      [...await this.ssh(c),command.map(shellQuote).join(' ')],options);
  }
  private developer(c:WindowsConfig,command:string[]){
    return ['sudo','-n','-H','-u','dev','--','env','-i','HOME=/home/dev','USER=dev','LOGNAME=dev','SHELL=/bin/bash',
      'PATH=/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin','TERM=xterm-256color','LANG=C.UTF-8','LC_ALL=C.UTF-8',`TZ=${c.timezone}`,
      '/usr/local/bin/mu-proxy-run','bash','-c','cd /workspace && exec "$@"','--',...command];
  }
  async guest(c:WindowsConfig,command:string[],options:RunOptions={}){
    options.signal?.throwIfAborted();const token=randomUUID(),timeoutMs=options.timeoutMs??30000;
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>86400000)throw new AppError('开发任务超时时间无效',400);
    let cancellation:Promise<string>|undefined;
    const cancel=()=>{cancellation??=this.management(c,this.developer(c,['python3','-c',GUEST_TASK_CANCEL,token]),{timeoutMs:8000});void cancellation.catch(()=>{});};
    options.signal?.addEventListener('abort',cancel,{once:true});
    try{return await this.management(c,this.developer(c,['python3','-c',GUEST_TASK_RUN,token,String(timeoutMs),...command]),options);}
    catch(error){if(error instanceof AppError&&['TIMEOUT','CANCELLED'].includes(error.code))cancel();throw error;}
    finally{options.signal?.removeEventListener('abort',cancel);if(cancellation)await cancellation;}
  }
  async terminalLaunch(c:WindowsConfig){
    const args=(await this.ssh(c)).filter(arg=>arg!=='-T');
    // Disable the SSH escape interpreter: input must never open a host shell,
    // change forwarding or start a host command through ~! / ~C escapes.
    args.unshift('-tt','-a','-x','-o','EscapeChar=none','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','IdentityAgent=none');
    args.push(this.developer(c,['bash','-l']).map(shellQuote).join(' '));
    const systemRoot=process.env.SystemRoot??'C:\\Windows';
    const env:Record<string,string>={SystemRoot:systemRoot,PATH:path.join(systemRoot,'System32'),TERM:'xterm-256color'};
    for(const key of ['SystemDrive','TEMP','TMP','USERPROFILE','LOCALAPPDATA','PROGRAMDATA'])if(process.env[key])env[key]=process.env[key]!;
    return {file:path.join(systemRoot,'System32/OpenSSH/ssh.exe'),args,env,cwd:this.root};
  }
  async create(input:WindowsConfig,options:RunOptions={},purpose:'environment'|'base-builder'='environment') {
    const c=windowsConfigSchema.parse(input),p=windowsPaths(this.root,c.id),n=vmIdentity(c.id);
    if(purpose==='base-builder'){if(!this.broker||c.imageSha256!==CANONICAL_NOCLOUD_PATCH.sourceSha256||c.cpus!==2||c.memoryGiB!==4||c.diskGiB!==32)throw Error('Only the fixed official source can create a base builder');this.baseBuilders.add(c.id);}
    let retry=false;
    if(this.broker){
      const allocated=await this.allocation(c);
      if(allocated.registered){
        if(await this.recoverCreation(c))return;
        if(allocated.everReady)throw new AppError('已有环境的虚拟机或防护状态异常，已保留原磁盘',409,'EXISTING_GUEST_RETAINED');
        if(allocated.imageSha256!==c.imageSha256||allocated.cpus!==c.cpus||allocated.memoryGiB!==c.memoryGiB||allocated.diskGiB!==c.diskGiB)throw new AppError('未完成创建的资源配置已变化，已保留原文件',409,'RECOVERY_CONFIG_CHANGED');
        const prepared=await this.broker.call('prepare',{id:c.id,image:isSealedBase(c.image)?c.image:path.resolve(c.image)},{...options,timeoutMs:1200000}) as {ready:boolean};
        if(prepared.ready){if(await this.recoverCreation(c))return;throw Error('Recovered allocation is incomplete');}retry=true;
      }
      try{await access(p.directory);if(!allocated.registered&&!await this.metadataMarker(c))throw new AppError('已有运行目录没有权限代理创建标记，已保留文件',409,'RECOVERY_FILES_RETAINED');await this.cleanMetadata(c,true);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    const info=await this.info();if(!info.available)throw Error(info.issues.join('; '));
    if(!this.broker)await this.channelHelper();await this.powershell('register-channel',c);
    if(isSealedBase(c.image)){if(!this.broker)throw Error('Protected base references require the privileged broker');await this.verifySealedBase(c);}
    else{if(await fileHash(c.image)!==c.imageSha256)throw Error('VM image checksum mismatch');if((await lstat(c.image)).isSymbolicLink())throw Error('VM image cannot be a symbolic link');}
    await mkdir(this.root,{recursive:true});
    if((await lstat(this.root)).isSymbolicLink())throw Error('Data root cannot be a symbolic link');
    if(this.broker)await mkdir(p.directory,{recursive:true});else await mkdir(p.directory);
    await this.runner(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe '${p.directory.replaceAll("'","''")}' /inheritance:r /grant:r "*\${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Unable to restrict data directory permissions'}`));
    if(this.broker)await writeFile(path.join(p.directory,'allocation.json'),JSON.stringify({version:1,id:c.id,backend:'hyperv-broker'}),{flag:'wx'});
    const keygen=path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh-keygen.exe');
    for(const key of [p.key,p.hostKey])await this.runner(keygen,['-q','-t','ed25519','-N','','-C','mu-windows-preview','-f',key]);
    const files=cloudInit(c,await readFile(p.key+'.pub','utf8'),await readFile(p.hostKey,'utf8'),await readFile(p.hostKey+'.pub','utf8'));
    const seedDirectory=path.join(p.directory,'seed');await mkdir(seedDirectory);
    for(const [name,contents]of Object.entries(files))await writeFile(path.join(seedDirectory,name),contents,{flag:'wx'});
    await writeFile(p.knownHosts,`${n.name} ${(await readFile(p.hostKey+'.pub','utf8')).trim()}\n`,{flag:'wx'});
    await this.runner(powershellPath(),powershellArgs(`& '${path.join(scripts,'seed-iso.ps1').replaceAll("'","''")}' -Source '${seedDirectory.replaceAll("'","''")}' -Destination '${p.seed.replaceAll("'","''")}'`),{timeoutMs:30000});
    if(!retry)await this.powershell('disk',c,{...options,timeoutMs:1200000});
    const created=JSON.parse(await this.powershell('create',c,options));
    const platformId=z.uuid().parse(created.platformId);this.vmIds.set(c.id,platformId);
    await this.publishManifest(c,platformId);
  }
  async start(c:WindowsConfig,options:RunOptions={}) {
    await access(windowsPaths(this.root,c.id).manifest);
    try {
      const started=JSON.parse(await this.powershell('start',c,options));this.vmIds.set(c.id,z.uuid().parse(started.platformId));
      // First boot may expand the vendor filesystem. Management readiness has
      // a separate bounded wait; business traffic remains closed throughout.
      const deadline=Date.now()+(options.timeoutMs??600000);
      for(;;) {
        options.signal?.throwIfAborted();
        try {await this.management(c,['true'],{timeoutMs:8000,signal:options.signal});break;}
        catch(error){if(Date.now()>deadline)throw error;await delay(1500,undefined,{signal:options.signal});}
      }
    } catch(error) {await this.stop(c);throw error;}
  }
  async stop(c:WindowsConfig,options:RunOptions={}) {
    // A stuck SSH child must never prevent the independent hypervisor stop.
    try{await this.disconnect(c.id);}catch{/* Hyper-V state is checked below. */}
    try{
      if(this.broker&&!(await this.allocation(c)).registered){
        await this.confirmUnregisteredAbsence(c);return;
      }
      let running=false;try{running=(await this.state(c)).state==='Running';}catch{/* Still attempt the independent stop. */}
      // Egress is already removed. Bound filesystem synchronization prevents
      // routine stops from dropping just-written files; it cannot block a
      // security shutdown indefinitely or depend on a cancelled job signal.
      if(running)try{await this.management(c,['sudo','-n','sync'],{timeoutMs:5000});}catch{/* Force-off remains mandatory. */}
      const result=JSON.parse(await this.powershell('stop',c,{...options,signal:undefined,timeoutMs:30000}));if(result.state!=='Off')throw Error('VM shutdown was not confirmed');
    }
    finally{this.closeChannel(c.id);this.transportFailures.delete(c.id);}
  }
  async connect(c:WindowsConfig) {
    const guard=await this.inspectGuard(c);
    if(guard.leaseActive||guard.remainingMs!==0)throw Error('Egress transport requires a verified closed guest guard');
    await this.openTransport(c);
  }
  async connectBootstrap(c:WindowsConfig) {
    const manifest=JSON.parse(await readFile(windowsPaths(this.root,c.id).manifest,'utf8'));
    if(c.imageSha256!==CANONICAL_NOCLOUD_PATCH.sourceSha256||manifest.id!==c.id||manifest.imageSha256!==c.imageSha256)throw Error('Bootstrap transport is restricted to the pinned empty builder image');
    await this.openTransport(c);
  }
  private async openTransport(c:WindowsConfig) {
    if(this.transports.has(c.id))throw Error('Environment transport is already open');
    this.intentionalDisconnect.delete(c.id);
    const args=await this.ssh(c);const destination=args.pop()!;
    args.push('-o','ExitOnForwardFailure=yes','-R',`127.0.0.1:${RELAY_PORT}:${c.proxy.address}:${c.proxy.port}`,destination,
      `exec sudo -n /usr/bin/python3 -c ${shellQuote(PROXY_SESSION)}`);
    const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh.exe'),args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.transports.set(c.id,child);
    child.on('exit',()=>{if(!this.intentionalDisconnect.has(c.id))this.transportFailures.get(c.id)?.();});
    try {await new Promise<void>((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(Error('SSH egress channel did not become ready')),15000);
      const ready=(block:Buffer)=>{output+=block.toString();if(output.length>8192){clearTimeout(timer);reject(Error('Oversized SSH response'));return;}
        if(output.includes('MU_PROXY_SESSION_READY\n')){clearTimeout(timer);child.stdout.off('data',ready);resolve();}};
      child.stdout.on('data',ready);child.stderr.on('data',()=>{});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('SSH egress channel closed'));});
    });}catch(error){await this.disconnect(c.id);throw error;}
  }
  async disconnect(id?:string) {
    if(!id){await Promise.all([...this.transports.keys()].map(value=>this.disconnect(value)));return;}
    this.intentionalDisconnect.add(id);
    const child=this.transports.get(id);this.transports.delete(id);if(!child)return;
    child.stdin.end();child.kill();
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('SSH egress channel did not terminate'));},5000);
      child.once('close',()=>{clearTimeout(timer);resolve();});
    });
  }
  async bootstrap(c:WindowsConfig,archive:string,options:RunOptions={}) {
    if(await fileHash(archive)!==AMD64_TUNNEL.sha256)throw Error('Tunnel component checksum mismatch');
    await this.management(c,['bash','-s'],{...options,input:bootstrapScript(c),timeoutMs:600000});
    const guestArchive='/tmp/mu-windows-tunnel.tar.gz';
    await this.management(c,['bash','-c',`umask 077; base64 -d > ${guestArchive}`],{...options,input:(await readFile(archive)).toString('base64'),timeoutMs:60000});
    await this.management(c,['bash','-s'],{...options,input:installAmd64TunnelScript(guestArchive),timeoutMs:60000});
    await this.management(c,['rm','-f',guestArchive]);
  }
  async discardBaseBuilder(c:WindowsConfig){
    if(!this.broker||c.imageSha256!==CANONICAL_NOCLOUD_PATCH.sourceSha256)throw Error('Official base builder required');
    if((await this.allocation(c)).registered){const receipt=z.object({deleted:z.literal(true),vmAbsent:z.literal(true),switchAbsent:z.literal(true),storageAbsent:z.literal(true)}).strict().parse(await this.broker.call('discard-base-builder',{id:c.id},{timeoutMs:45000}));if(!receipt.deleted)throw Error('Builder cleanup not confirmed');}
    await this.confirmUnregisteredAbsence(c);try{await access(windowsPaths(this.root,c.id).directory);await this.cleanMetadata(c,false);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}this.baseBuilders.delete(c.id);this.vmIds.delete(c.id);
  }
  async verifySealedBase(base:{image:string;imageSha256:string}){windowsBaseSchema.parse({image:base.image,imageSha256:base.imageSha256});if(!this.broker||!isSealedBase(base.image))throw Error('Sealed base reference required');const value=await this.broker.call('base-status',{imageSha256:base.imageSha256});const receipt=z.object({ready:z.literal(true),image:z.literal(base.image),imageSha256:z.literal(base.imageSha256)}).strict().parse(value);return {image:receipt.image,imageSha256:receipt.imageSha256};}
  async sealPreparedBase(c:WindowsConfig,options:RunOptions={}){
    if(!this.broker||!this.baseBuilders.has(c.id)||c.imageSha256!==CANONICAL_NOCLOUD_PATCH.sourceSha256)throw Error('Only this newly created official builder can be sealed');
    await this.scrubBase(c,options);await this.disconnect();await this.stop(c);
    const receipt=z.object({ready:z.literal(true),image:z.string(),imageSha256:z.string()}).strict().parse(await this.broker.call('seal-base',{id:c.id},{...options,timeoutMs:1200000}));return windowsBaseSchema.parse({image:receipt.image,imageSha256:receipt.imageSha256});
  }
  private async scrubBase(c:WindowsConfig,options:RunOptions={}) {
    if(c.proxy.username||c.proxy.password)throw Error('A reusable lab base must be built without proxy credentials');
    // Only for a fresh builder VM, before any user work. The next clone gets
    // new cloud-init credentials, machine-id and a new per-environment guard.
    await this.management(c,['bash','-s'],{...options,timeoutMs:30000,input:`set -euo pipefail
sudo systemctl disable --now mucodesandbox-tunnel.service || true
sudo tee /etc/mucodesandbox/network.nft >/dev/null <<'MU_CLOSED'
add table inet mu_egress
delete table inet mu_egress
table inet mu_egress {
 chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; tcp sport 22 accept; }
 chain forward { type filter hook forward priority 0; policy drop; }
}
MU_CLOSED
sudo tee /etc/mucodesandbox/lease.nft >/dev/null <<'MU_LEASE_CLOSED'
add table inet mu_lease
delete table inet mu_lease
table inet mu_lease {
 chain output { type filter hook output priority -10; policy drop; oifname "lo" accept; tcp sport 22 accept; }
 chain input { type filter hook input priority -10; policy drop; iifname "lo" accept; tcp dport 22 accept; }
}
MU_LEASE_CLOSED
sudo rm -f /etc/mucodesandbox/tunnel.json /etc/mucodesandbox/tunnel.json.next /etc/mucodesandbox/environment /etc/mucodesandbox/proxy-endpoints.json
sudo rm -f /home/mu/.ssh/authorized_keys /etc/ssh/ssh_host_*key /etc/ssh/ssh_host_*key.pub
sudo rm -f /root/.bash_history /home/mu/.bash_history /home/dev/.bash_history
sudo cloud-init clean --logs --machine-id --seed
sudo sync
`});
  }
  async freezeBase(c:WindowsConfig) {
    await this.scrubBase(c);await this.disconnect();await this.stop(c);await this.powershell('export-base',c,{timeoutMs:300000});
    const file=path.join(windowsPaths(this.root,c.id).directory,'protected-base.vhdx');
    return {file,sha256:await fileHash(file)};
  }
  async configure(c:WindowsConfig) {
    const guard=configureWindowsGuard(c);
    await this.management(c,['bash','-s'],{input:guard.script,timeoutMs:60000});
    return guard.session;
  }
  async inspectGuard(c:WindowsConfig) {
    await this.inspectVm(c);
    return inspection.parse(JSON.parse((await this.management(c,['bash','-s'],{input:INSPECT_WINDOWS_GUARD,timeoutMs:15000})).trim()));
  }
  async lease(c:WindowsConfig,token:string,action:'activate'|'renew'|'revoke') {
    await this.management(c,['sudo','-n',LEASE_HELPER_PATH,action,token],{timeoutMs:8000});
  }
  egressProbeProxy(id:string) {
    const transport=this.transports.get(id);
    if(!transport||transport.exitCode!==null||transport.signalCode!==null)throw Error('Egress transport is not running');
    return `socks5h://127.0.0.1:${PROBE_PORT}`;
  }
  async session(c:WindowsConfig,probe?:()=>Promise<{receiver:string;ip:string}[]>) {
    const token=await this.configure(c);
    const driver={inspect:()=>this.inspectGuard(c),probe:probe??(async()=>{
      const result=await measureEgress({management:(_e,command,options)=>this.management(c,command,options),egressProbeProxy:()=>this.egressProbeProxy(c.id)},windowsEnvironment(c));
      return result.verification!.receipts.map(r=>({receiver:r.receiver,ip:r.ip}));
    }),activate:()=>this.lease(c,token,'activate'),renew:()=>this.lease(c,token,'renew'),revoke:()=>this.lease(c,token,'revoke'),disconnect:()=>this.disconnect(c.id),stop:()=>this.stop(c)};
    const session=new WindowsNetworkSession(driver,c.expectedIp);
    this.transportFailures.set(c.id,()=>{void session.fail().catch(()=>{});});
    return session;
  }
}
