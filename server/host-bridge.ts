import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { z } from 'zod';
import { HOST_COMMANDS, type Environment, type BridgeGrant, type HostCommand } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { LimaRuntime } from './runtime.ts';
import { validateMounts, redact } from './validation.ts';
import { AppError, errorMessage } from './errors.ts';
import { shellQuote } from './network-guard.ts';
import { GUEST_BRIDGE_CLIENT, installGuestBridgeConfig } from './bridge-guest.ts';
import type { RunOptions } from './process.ts';
import { run } from './process.ts';
import { PROXY_SESSION } from './proxy-transport.ts';

const relative = z.string().max(2048).refine(s => !s.startsWith('/') && !s.includes('\0') && (s === '' || s.split('/').every(p => p && p !== '.' && p !== '..' && Buffer.byteLength(p) <= 255)), '只允许授权目录中的相对路径');
export const bridgeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('command'), command: z.enum(HOST_COMMANDS) }).strict(),
  z.object({ operation: z.literal('write'), path: relative.min(1), data: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ operation: z.enum(['read','stat','sha256']), path: relative.min(1) }).strict(),
  z.object({ operation: z.literal('list'), path: relative }).strict(),
]);
type Request = z.infer<typeof bridgeRequestSchema>;
const tokenHash = (token:string) => createHash('sha256').update(token).digest('hex');

export class DescriptorBridge {
  child: ChildProcessWithoutNullStreams;
  sequence = 0;
  closed = false;
  closing:Promise<void>|null = null;
  finished:Promise<Error|null>;
  pending = new Map<number, { resolve: (v:unknown)=>void; reject:(e:Error)=>void; timer:NodeJS.Timeout }>();
  constructor(executable:string) {
    this.child=spawn(executable,[],{stdio:['pipe','pipe','pipe'],shell:false,detached:true});
    const lines=createInterface({input:this.child.stdout});
    lines.on('line',line=>{
      try {
        const result=z.object({id:z.number().int(),ok:z.boolean(),result:z.unknown().optional(),error:z.string().optional()}).parse(JSON.parse(line));
        const pending=this.pending.get(result.id);if(!pending)return;
        this.pending.delete(result.id);clearTimeout(pending.timer);
        if(result.ok)pending.resolve(result.result);else pending.reject(new AppError(result.error??'宿主访问被拒绝',403,'BRIDGE_DENIED'));
      } catch { this.rejectAll(new AppError('宿主桥接返回内容无效'));void this.close().catch(()=>{}); }
    });
    this.child.stderr.resume();
    this.child.on('error',error=>this.rejectAll(error));
    this.finished=new Promise(resolve=>this.child.once('close',()=>{
      this.closed=true;this.rejectAll(new AppError('宿主授权已关闭',410,'GRANT_CLOSED'));lines.close();
      const error=this.killGroup('SIGKILL');
      // macOS can reject a group signal during exit. Inspect membership before accepting cleanup.
      if(error)void this.confirmGroupExit().then(()=>resolve(null),failure=>resolve(failure));
      else resolve(null);
    }));
    this.child.stdin.on('error',error=>this.rejectAll(error));
  }
  private rejectAll(error:Error) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear(); }
  private killGroup(signal:NodeJS.Signals) {
    if(this.child.pid)try{process.kill(-this.child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return error as Error;}
    return null;
  }
  private async confirmGroupExit() {
    const end=Date.now()+2000;
    while(true){
      const groups=await run('/bin/ps',['-axo','pgid='],{timeoutMs:1000,maxBytes:1_000_000});
      if(!groups.split('\n').some(group=>Number(group.trim())===this.child.pid))return;
      if(Date.now()>=end)throw new AppError('无法确认宿主命令已停止',500,'BRIDGE_CLEANUP_FAILED');
      await delay(25);
    }
  }
  send(value:object,timeoutMs=10_000) {
    if(this.closed)return Promise.reject(new AppError('宿主授权已关闭',410,'GRANT_CLOSED'));
    const id=++this.sequence;
    return new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new AppError('宿主桥接超时'));void this.close().catch(()=>{});},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...value,id})+'\n');
    });
  }
  close() { return this.closing??=(async()=>{
    const active=!this.closed;
    this.closed=true;this.rejectAll(new AppError('宿主授权已撤销',410,'GRANT_CLOSED'));
    let forceTimer:NodeJS.Timeout|undefined;
    if(active){this.killGroup('SIGTERM');forceTimer=setTimeout(()=>this.killGroup('SIGKILL'),1000);forceTimer.unref();}
    let timeout:NodeJS.Timeout|undefined;
    try{
      const error=await Promise.race([this.finished,new Promise<Error>(resolve=>{
        timeout=setTimeout(()=>resolve(new AppError('无法确认宿主命令已停止',500,'BRIDGE_CLEANUP_FAILED')),4000);
      })]);
      if(error)throw error;
    }finally{clearTimeout(forceTimer);clearTimeout(timeout);}
  })(); }
}
interface Grant { public:BridgeGrant; helper:DescriptorBridge; token:string; transport?:ChildProcessWithoutNullStreams; environment?:Environment; activeRequests:number; commandActive:boolean }
export class HostBridge {
  store:Store;
  runtime:LimaRuntime;
  executable:string;
  grants=new Map<string,Grant>();
  revocations=new Map<string,Promise<void>>();
  hashes=new Map<string,string>();
  server:Server|null=null;
  port=0;
  starting:Promise<void>|null=null;
  timer:NodeJS.Timeout;
  closing=false;
  authorize?: (id:string)=>Promise<unknown>;
  constructor(store:Store,runtime:LimaRuntime,rootDir:string) {
    this.store=store;this.runtime=runtime;this.executable=path.join(rootDir,'native/bin/mu-host-bridge');
    this.timer=setInterval(()=>{for(const g of this.grants.values())if(Date.parse(g.public.expiresAt)<=Date.now())void this.revoke(g.public.id).catch(error=>this.store.log(g.public.environmentId,null,redact(errorMessage(error)),'error'));},1000);this.timer.unref();
  }
  list(environmentId:string) { return [...this.grants.values()].filter(g=>g.public.environmentId===environmentId).map(g=>g.public); }
  private async listen() {
    if(this.server)return;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const server=createServer(async(req,res)=>{
        res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
        const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
        try{
          if(req.headers.origin || ![`127.0.0.1:${this.port}`,`localhost:${this.port}`].includes(req.headers.host??''))throw new AppError('桥接请求来源无效',403);
          if(req.method!=='POST'||req.url!=='/capability')throw new AppError('接口不存在',404);
          const id=this.hashes.get(tokenHash(req.headers.authorization?.replace(/^Bearer /,'')??''));
          const grant=id?this.grants.get(id):undefined;
          if(!grant||Date.parse(grant.public.expiresAt)<=Date.now())throw new AppError('授权无效或已过期',401);
          if(grant.activeRequests>=2)throw new AppError('桥接请求过多',429);
          grant.activeRequests++;
          try{
            const chunks:Buffer[]=[];let size=0;
            for await(const chunk of req){size+=chunk.length;if(size>1_500_000)throw new AppError('超过传输上限',413);chunks.push(chunk);}
            respond(200,{result:await this.perform(grant.public.id,JSON.parse(Buffer.concat(chunks).toString()))});
          }finally{grant.activeRequests--;}
        }catch(error){respond(error instanceof AppError?error.status:error instanceof z.ZodError?400:500,{error:redact(errorMessage(error))});}
      });
      server.requestTimeout=12_000;server.headersTimeout=10_000;
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      this.port=(server.address() as {port:number}).port;this.server=server;
    })().finally(()=>{this.starting=null;});
    return this.starting;
  }
  async create(e:Environment,root:string,writable:boolean,minutes=60,guest=true,options:RunOptions={},commands:HostCommand[]=[]) {
    if(guest)await this.authorize?.(e.id);
    if(this.closing)throw new AppError('宿主桥接正在关闭',409);
    if(process.platform!=='darwin')throw new AppError('当前宿主桥接只支持 macOS',409);
    if(this.list(e.id).length>=8||this.grants.size>=32)throw new AppError('宿主授权数量达到上限',409);
    if(!Number.isInteger(minutes)||minutes<1||minutes>480)throw new AppError('授权时长应为 1 至 480 分钟');
    commands=z.array(z.enum(HOST_COMMANDS)).max(HOST_COMMANDS.length).parse(commands);
    if(new Set(commands).size!==commands.length)throw new AppError('命令授权不能重复');
    if(guest && (e.kind!=='vm'||e.state!=='running'))throw new AppError('请先启动 Linux 环境',409);
    const [mount]=await validateMounts([{id:randomUUID(),hostPath:root,guestPath:'/workspace/bridge-validation',writable:false}],this.store.dataDir);
    try{await access(this.executable);}catch{throw new AppError('宿主桥接组件尚未构建',409);}
    const helper=new DescriptorBridge(this.executable);
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    const grant:Grant={public:{id,environmentId:e.id,root:mount.hostPath,writable,commands,expiresAt:new Date(Date.now()+minutes*60_000).toISOString(),guestReady:false},helper,token,environment:guest?e:undefined,activeRequests:0,commandActive:false};
    try{
      await helper.send({root:mount.hostPath,writable,commands});
      if(options.signal?.aborted)throw new AppError('操作已取消',409,'CANCELLED');
      await this.listen();
      if(this.closing)throw new AppError('宿主桥接正在关闭',409);
      this.grants.set(id,grant);this.hashes.set(tokenHash(token),id);
      if(guest)await this.connectGuest(grant,e,options);
      if(options.signal?.aborted)throw new AppError('操作已取消',409,'CANCELLED');
      this.store.log(e.id,null,`宿主目录授权：${mount.hostPath}；${writable?'读写':'只读'}；命令 ${commands.join(',')||'无'}；到期 ${grant.public.expiresAt}`);
      return grant.public;
    }catch(error){if(this.grants.has(id))await this.revoke(id);else await helper.close();throw error;}
  }
  async perform(id:string,input:unknown) {
    const request:Request=bridgeRequestSchema.parse(input),grant=this.grants.get(id);
    if(!grant||Date.parse(grant.public.expiresAt)<=Date.now())throw new AppError('授权已撤销或过期',410);
    if(grant.environment)await this.authorize?.(grant.public.environmentId);
    if(this.grants.get(id)!==grant||Date.parse(grant.public.expiresAt)<=Date.now())throw new AppError('授权已撤销或过期',410);
    if(grant.commandActive)throw new AppError('此授权的命令正在执行',409);
    if(request.operation==='command'&&!grant.public.commands.includes(request.command))throw new AppError('未授权此宿主命令',403);
    if(request.operation==='write'&&!grant.public.writable)throw new AppError('未授权写入',403);
    const operation=request.operation==='command'?`command ${request.command}`:`${request.operation} ${request.path}`;
    grant.commandActive=request.operation==='command';
    this.store.log(grant.public.environmentId,null,`宿主桥接请求：${operation}`);
    try{const result=await grant.helper.send(request,request.operation==='command'?8000:10_000);
      if(this.grants.get(id)!==grant||Date.parse(grant.public.expiresAt)<=Date.now())throw new AppError('授权已撤销或过期',410);
      this.store.log(grant.public.environmentId,null,`宿主桥接完成：${operation}`);return result;}
    catch(error){if(request.operation==='command')await this.revoke(id);this.store.log(grant.public.environmentId,null,`宿主桥接拒绝：${operation}；${redact(errorMessage(error))}`,'error');throw error;}
    finally{grant.commandActive=false;}
  }
  private socket(id:string){return `/run/mucodesandbox/bridge/${id}.sock`;}
  private async connectGuest(g:Grant,e:Environment,options:RunOptions) {
    await this.runtime.management(e,['bash','-s'],{...options,input:`set -eu\nsudo install -d -m 0771 -o root -g mu /run/mucodesandbox/bridge\nprintf '%s' ${shellQuote(GUEST_BRIDGE_CLIENT)} | sudo tee /usr/local/bin/mu-host >/dev/null\nsudo chmod 0755 /usr/local/bin/mu-host\n`,timeoutMs:15_000});
    const transport=spawn('/usr/bin/ssh',['-F',path.join(this.runtime.limaHome,e.instanceName,'ssh.config'),'-S','none','-T','-o','ExitOnForwardFailure=yes','-o','StreamLocalBindMask=0077','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-R',`${this.socket(g.public.id)}:127.0.0.1:${this.port}`,`lima-${e.instanceName}`,`exec sudo -n /usr/bin/python3 -c ${shellQuote(PROXY_SESSION)}`],{stdio:['pipe','pipe','pipe'],shell:false});
    g.transport=transport;transport.stdin.on('error',()=>{});transport.stderr.resume();
    let transportError:Error|undefined;
    transport.once('error',error=>{transportError=error;void this.revoke(g.public.id);});
    transport.once('close',()=>{if(this.grants.has(g.public.id))void this.revoke(g.public.id);});
    // Require the guest ownership watcher before publishing a usable file grant.
    await new Promise<void>((resolve,reject)=>{
      let output='';
      const timer=setTimeout(()=>done(new AppError('宿主桥接所有权监测启动超时',504,'BRIDGE_OWNER_TIMEOUT')),15_000);
      const inspect=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-8192);if(output.includes('MU_PROXY_SESSION_READY'))done();};
      const failed=()=>done(new AppError('宿主桥接通道未建立',500,'BRIDGE_TRANSPORT_FAILED'));
      const aborted=()=>done(new AppError('操作已取消',409,'CANCELLED'));
      function done(error?:Error){clearTimeout(timer);transport.stdout.off('data',inspect);transport.off('error',failed);transport.off('close',failed);options.signal?.removeEventListener('abort',aborted);error?reject(error):resolve();}
      transport.stdout.on('data',inspect);transport.once('error',failed);transport.once('close',failed);options.signal?.addEventListener('abort',aborted,{once:true});
      if(options.signal?.aborted)aborted();
    });
    transport.stdout.resume();
    await this.runtime.management(e,['bash','-s'],{...options,input:`set -eu\nfor n in $(seq 1 100); do test -S ${shellQuote(this.socket(g.public.id))} && break; sleep 0.05; done\ntest -S ${shellQuote(this.socket(g.public.id))}\nsudo chown dev:dev ${shellQuote(this.socket(g.public.id))}\nsudo chmod 0600 ${shellQuote(this.socket(g.public.id))}\n${installGuestBridgeConfig(g.public.id,{socket:this.socket(g.public.id),host:`127.0.0.1:${this.port}`,token:g.token})}`,timeoutMs:15_000});
    if(transportError||transport.exitCode!==null||!this.grants.has(g.public.id))throw transportError??new AppError('宿主桥接通道未建立',500);
    g.public.guestReady=true;
  }
  revoke(id:string) {
    const current=this.revocations.get(id);if(current)return current;
    const pending=this.revokeNow(id).finally(()=>this.revocations.delete(id));this.revocations.set(id,pending);return pending;
  }
  private async revokeNow(id:string) {
    const grant=this.grants.get(id);if(!grant)return;
    this.grants.delete(id);this.hashes.delete(tokenHash(grant.token));
    const transport=grant.transport;
    if(transport&&transport.exitCode===null){const closed=new Promise<void>(resolve=>transport.once('close',()=>resolve()));transport.kill('SIGTERM');const timer=setTimeout(()=>transport.kill('SIGKILL'),1000);timer.unref();await closed;clearTimeout(timer);}
    await grant.helper.close();
    if(grant.environment)await this.runtime.management(grant.environment,['sudo','rm','-f',this.socket(id),`/home/dev/.config/mucodesandbox/bridge-${id}.json`],{timeoutMs:5000}).catch(()=>{});
    this.store.log(grant.public.environmentId,null,`宿主授权已撤销：${id}`);
  }
  async revokeEnvironment(id:string){for(const grant of this.list(id))await this.revoke(grant.id);}
  async close(){
    this.closing=true;clearInterval(this.timer);await this.starting;
    const results=await Promise.allSettled([...this.grants.keys()].map(id=>this.revoke(id)).concat([...this.revocations.values()]));
    if(this.server){this.server.closeAllConnections();await new Promise<void>(resolve=>this.server!.close(()=>resolve()));this.server=null;}
    const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'宿主桥接清理失败');
  }
}
