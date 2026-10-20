import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { windowsConfigSchema, windowsPaths, vmIdentity, RELAY_PORT, PROBE_PORT, type WindowsConfig } from './config.ts';
import { cloudInit, bootstrapScript, installAmd64TunnelScript, configureWindowsGuard, INSPECT_WINDOWS_GUARD, windowsEnvironment } from './guest.ts';
import { WindowsNetworkSession } from './session.ts';
import { measureEgress } from '../../egress.ts';

const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..','scripts/windows');
const inspection=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),leaseActive:z.boolean(),remainingMs:z.number().nonnegative().max(45000)}).strict();
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
  readonly root:string;
  readonly runner:Runner;
  constructor(root:string,runner:Runner=run) {this.root=root;this.runner=runner;}
  private psScript(action:string) {return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); try { & '${path.join(scripts,'hyperv.ps1').replaceAll("'","''")}' -Action '${action}' } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;}
  async powershell(action:string,c?:WindowsConfig,options:RunOptions={}) {
    if(process.platform!=='win32')throw Error('Hyper-V backend requires Windows');
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
  private closeChannel(id:string){const channel=this.channels.get(id);this.channels.delete(id);if(channel){channel.child.stdin.end();channel.child.kill();}}
  async management(c:WindowsConfig,command:string[],options:RunOptions={}) {
    return this.runner(path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh.exe'),
      [...await this.ssh(c),command.map(shellQuote).join(' ')],options);
  }
  async create(input:WindowsConfig,options:RunOptions={}) {
    const c=windowsConfigSchema.parse(input),p=windowsPaths(this.root,c.id),n=vmIdentity(c.id);
    const info=await this.info();if(!info.available)throw Error(info.issues.join('; '));
    await this.channelHelper();await this.powershell('register-channel',c);
    if(await fileHash(c.image)!==c.imageSha256)throw Error('VM image checksum mismatch');
    if((await lstat(c.image)).isSymbolicLink())throw Error('VM image cannot be a symbolic link');
    await mkdir(this.root,{recursive:true});
    if((await lstat(this.root)).isSymbolicLink())throw Error('Data root cannot be a symbolic link');
    await mkdir(p.directory); // Exclusive allocation; an old directory is never reused.
    await this.runner(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe '${p.directory.replaceAll("'","''")}' /inheritance:r /grant:r "*\${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Unable to restrict data directory permissions'}`));
    const keygen=path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh-keygen.exe');
    for(const key of [p.key,p.hostKey])await this.runner(keygen,['-q','-t','ed25519','-N','','-C','mu-windows-preview','-f',key]);
    const files=cloudInit(c,await readFile(p.key+'.pub','utf8'),await readFile(p.hostKey,'utf8'),await readFile(p.hostKey+'.pub','utf8'));
    const seedDirectory=path.join(p.directory,'seed');await mkdir(seedDirectory);
    for(const [name,contents]of Object.entries(files))await writeFile(path.join(seedDirectory,name),contents,{flag:'wx'});
    await writeFile(p.knownHosts,`${n.name} ${(await readFile(p.hostKey+'.pub','utf8')).trim()}\n`,{flag:'wx'});
    await this.runner(powershellPath(),powershellArgs(`& '${path.join(scripts,'seed-iso.ps1').replaceAll("'","''")}' -Source '${seedDirectory.replaceAll("'","''")}' -Destination '${p.seed.replaceAll("'","''")}'`),{timeoutMs:30000});
    await this.powershell('disk',c,{...options,timeoutMs:1200000});
    const created=JSON.parse(await this.powershell('create',c,options));
    const platformId=z.uuid().parse(created.platformId);this.vmIds.set(c.id,platformId);
    await writeFile(p.manifest,JSON.stringify({version:1,id:c.id,platformId,imageSha256:c.imageSha256,purpose:c.imageSha256===CANONICAL_NOCLOUD_PATCH.sourceSha256?'builder':'environment',createdAt:new Date().toISOString()}),{flag:'wx'});
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
  async bootstrap(c:WindowsConfig,archive:string) {
    if(await fileHash(archive)!==AMD64_TUNNEL.sha256)throw Error('Tunnel component checksum mismatch');
    await this.management(c,['bash','-s'],{input:bootstrapScript(c),timeoutMs:600000});
    const guestArchive='/tmp/mu-windows-tunnel.tar.gz';
    await this.management(c,['bash','-c',`umask 077; base64 -d > ${guestArchive}`],{input:(await readFile(archive)).toString('base64'),timeoutMs:60000});
    await this.management(c,['bash','-s'],{input:installAmd64TunnelScript(guestArchive),timeoutMs:60000});
    await this.management(c,['rm','-f',guestArchive]);
  }
  async freezeBase(c:WindowsConfig) {
    if(c.proxy.username||c.proxy.password)throw Error('A reusable lab base must be built without proxy credentials');
    // Only for a fresh builder VM, before any user work. The next clone gets
    // new cloud-init credentials, machine-id and a new per-environment guard.
    await this.management(c,['bash','-s'],{timeoutMs:30000,input:`set -euo pipefail
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
sudo cloud-init clean --logs --machine-id
sudo sync
`});
    await this.disconnect();await this.stop(c);await this.powershell('export-base',c,{timeoutMs:300000});
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
