import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile, access } from 'node:fs/promises';
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

export async function fileHash(file:string) {
  const hash=createHash('sha256');for await(const block of createReadStream(file))hash.update(block);return hash.digest('hex');
}
export function powershellPath() {return path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');}
export function powershellArgs(script:string) {return ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];}

export class HyperVRuntime implements VmBackend<WindowsConfig> {
  private transport:ChildProcessWithoutNullStreams|undefined;
  private intentionalDisconnect=false;
  onTransportFailure?:()=>void;
  readonly root:string;
  readonly runner:Runner;
  constructor(root:string,runner:Runner=run) {this.root=root;this.runner=runner;}
  private psScript(action:string) {return `& '${path.join(scripts,'hyperv.ps1').replaceAll("'","''")}' -Action '${action}'`;}
  async powershell(action:string,c?:WindowsConfig,options:RunOptions={}) {
    if(process.platform!=='win32')throw Error('Hyper-V backend requires Windows');
    const p=c?windowsPaths(this.root,c.id):undefined;
    const value=c?{...vmIdentity(c.id),...p,cpus:c.cpus,memoryGiB:c.memoryGiB,diskGiB:c.diskGiB,image:c.image}:undefined;
    return this.runner(powershellPath(),powershellArgs(this.psScript(action)),{...options,input:value?JSON.stringify(value):undefined,timeoutMs:options.timeoutMs??30000});
  }
  async info() {return z.object({available:z.boolean(),issues:z.array(z.string())}).parse(JSON.parse(await this.powershell('doctor')));}
  async fingerprint() {return createHash('sha256').update((await this.powershell('fingerprint')).trim()).digest('hex');}
  async inspectVm(c:WindowsConfig) {return JSON.parse(await this.powershell('inspect',c));}
  private ssh(c:WindowsConfig) {
    const p=windowsPaths(this.root,c.id),n=vmIdentity(c.id);
    return ['-F','none','-T','-i',p.key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
      '-o',`UserKnownHostsFile="${p.knownHosts.replaceAll('\\','/')}"`,'-o',`HostKeyAlias=${n.name}`,'-o','ConnectTimeout=5',
      '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','LogLevel=ERROR',`mu@${n.guest}`];
  }
  async management(c:WindowsConfig,command:string[],options:RunOptions={}) {
    return this.runner(path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh.exe'),
      [...this.ssh(c),command.map(shellQuote).join(' ')],options);
  }
  async create(input:WindowsConfig,options:RunOptions={}) {
    const c=windowsConfigSchema.parse(input),p=windowsPaths(this.root,c.id),n=vmIdentity(c.id);
    const info=await this.info();if(!info.available)throw Error(info.issues.join('; '));
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
    await this.powershell('disk',c,{...options,timeoutMs:300000});
    await this.powershell('create',c,options);
    await writeFile(p.manifest,JSON.stringify({version:1,id:c.id,imageSha256:c.imageSha256,createdAt:new Date().toISOString()}),{flag:'wx'});
  }
  async start(c:WindowsConfig,options:RunOptions={}) {
    await access(windowsPaths(this.root,c.id).manifest);
    try {
      await this.powershell('start',c,options);
      const deadline=Date.now()+180000;
      for(;;) {
        options.signal?.throwIfAborted();
        try {await this.management(c,['true'],{timeoutMs:8000,signal:options.signal});break;}
        catch(error){if(Date.now()>deadline)throw error;await delay(1500,undefined,{signal:options.signal});}
      }
    } catch(error) {await this.stop(c);throw error;}
  }
  async stop(c:WindowsConfig,options:RunOptions={}) {await this.powershell('stop',c,{...options,timeoutMs:30000});}
  async connect(c:WindowsConfig) {
    if(this.transport)throw Error('Transport is already open');
    this.intentionalDisconnect=false;
    const args=this.ssh(c);const destination=args.pop()!;
    args.push('-o','ExitOnForwardFailure=yes','-R',`127.0.0.1:${RELAY_PORT}:${c.proxy.address}:${c.proxy.port}`,destination,
      `exec sudo -n /usr/bin/python3 -c ${shellQuote(PROXY_SESSION)}`);
    const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32/OpenSSH/ssh.exe'),args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.transport=child;
    child.on('exit',()=>{if(!this.intentionalDisconnect)this.onTransportFailure?.();});
    try {await new Promise<void>((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(Error('SSH egress channel did not become ready')),15000);
      const ready=(block:Buffer)=>{output+=block.toString();if(output.length>8192){clearTimeout(timer);reject(Error('Oversized SSH response'));return;}
        if(output.includes('MU_PROXY_SESSION_READY\n')){clearTimeout(timer);child.stdout.off('data',ready);resolve();}};
      child.stdout.on('data',ready);child.stderr.on('data',()=>{});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('SSH egress channel closed'));});
    });}catch(error){await this.disconnect();throw error;}
  }
  async disconnect() {
    this.intentionalDisconnect=true;
    const child=this.transport;this.transport=undefined;if(!child)return;
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
  egressProbeProxy() {
    if(!this.transport||this.transport.exitCode!==null||this.transport.signalCode!==null)throw Error('Egress transport is not running');
    return `socks5h://127.0.0.1:${PROBE_PORT}`;
  }
  async session(c:WindowsConfig,probe?:()=>Promise<{receiver:string;ip:string}[]>) {
    const token=await this.configure(c);
    const driver={inspect:()=>this.inspectGuard(c),probe:probe??(async()=>{
      const result=await measureEgress({management:(_e,command,options)=>this.management(c,command,options),egressProbeProxy:()=>this.egressProbeProxy()},windowsEnvironment(c));
      return result.verification!.receipts.map(r=>({receiver:r.receiver,ip:r.ip}));
    }),activate:()=>this.lease(c,token,'activate'),renew:()=>this.lease(c,token,'renew'),revoke:()=>this.lease(c,token,'revoke'),disconnect:()=>this.disconnect(),stop:()=>this.stop(c)};
    const session=new WindowsNetworkSession(driver,c.expectedIp);
    this.onTransportFailure=()=>{void session.fail().catch(()=>{});};
    return session;
  }
}
