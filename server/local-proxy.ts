import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect } from 'node:net';
import YAML from 'yaml';
import { z } from 'zod';
import { AppError } from './errors.ts';
import { run } from './process.ts';

const configPath=path.join(homedir(),'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml');
const corePath='/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
const otherCorePath='/Library/Application Support/clash-verge-service/cores/verge-mihomo';
const ownerScript=`const {spawn}=require('node:child_process');const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore','ignore','pipe']});child.stderr.pipe(process.stderr);let ending=false;const stop=()=>{if(ending)return;ending=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1000).unref();};process.stdin.resume();process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??0));`;
const selectionSchema=z.object({name:z.string().min(1).max(160),port:z.number().int().min(1024).max(65535)}).strict();
export async function portOpen(port:number) {
  return new Promise<boolean>(resolve=>{
    const socket=connect({host:'127.0.0.1',port});
    const finish=(open:boolean)=>{socket.destroy();resolve(open);};
    socket.setTimeout(300);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
  });
}

export class LocalProxy {
  private child?:ChildProcessWithoutNullStreams;
  private selected?:{name:string;port:number};
  private starting?:Promise<{name:string;port:number}>;
  private directory:string;
  constructor(dataDir:string){this.directory=path.join(dataDir,'local-proxy-line');}
  private async config(){
    const c=YAML.parse(await readFile(configPath,'utf8'));
    if(!Array.isArray(c.proxies))throw new AppError('本机 Clash 配置没有可用的独立节点',409);
    return c;
  }
  async info(){
    let c:any;try{c=await this.config();}catch{return {available:false,nodes:[],ports:[],line:null};}
    const ports=[c['mixed-port'],c.port,c['socks-port']].filter((p:unknown)=>Number.isInteger(p)&&Number(p)>0);
    const ready=await Promise.all(ports.map(async(port:number)=>({port,ready:await portOpen(port)})));
    const line=this.selected?{...this.selected,running:!!this.child&&this.child.exitCode===null&&this.child.signalCode===null&&await portOpen(this.selected.port)}:null;
    return {available:true,nodes:c.proxies.filter((p:any)=>typeof p.name==='string').map((p:any)=>({name:p.name,type:p.type})),ports:ready,line};
  }
  async restore(){
    try{
      const selected=selectionSchema.parse(JSON.parse(await readFile(path.join(this.directory,'selection.json'),'utf8')));
      await this.start(selected.name,selected.port);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return {error:'独立本机线路未能恢复，请在网络向导重新检查'};}
    return {};
  }
  start(name:string,port=24897){
    if(this.starting)return Promise.reject(new AppError('正在准备独立线路，请稍后重试',409));
    const selected=selectionSchema.parse({name,port});
    const task=this.startNow(selected).finally(()=>{if(this.starting===task)this.starting=undefined;});
    this.starting=task;return task;
  }
  private async startNow(selected:{name:string;port:number}){
    if(this.selected?.name===selected.name&&this.selected.port===selected.port&&this.child&&this.child.exitCode===null)return selected;
    const c=await this.config();const proxy=c.proxies.find((p:any)=>p.name===selected.name);
    if(!proxy||!['vmess','vless','ss','trojan','socks5','http'].includes(proxy.type)||proxy['dialer-proxy'])throw new AppError('此节点不能单独启动，请选择独立节点',409);
    if(await portOpen(selected.port)&&!(this.child&&this.child.exitCode===null&&this.selected?.port===selected.port))throw new AppError('独立线路端口已被占用，请先处理现有线路',409);
    let executable=corePath;try{await access(executable);}catch{executable=otherCorePath;await access(executable);}
    await this.close();
    if(await portOpen(selected.port))throw new AppError('独立线路端口已被占用',409);
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const config=YAML.stringify({'mixed-port':selected.port,'bind-address':'127.0.0.1','allow-lan':false,ipv6:false,mode:'rule','log-level':'silent',
      'find-process-mode':'off',tun:{enable:false},dns:{enable:false},proxies:[proxy],rules:[`MATCH,${selected.name}`],profile:{'store-selected':false,'store-fake-ip':false}});
    const file=path.join(this.directory,'config.yaml');
    await writeFile(file,config,{mode:0o600});
    // Validate the restricted configuration with the already-installed vendor core.
    try{await run(executable,['-t','-d',this.directory,'-f',file],{timeoutMs:8000,maxBytes:8192});}
    catch{await rm(file,{force:true});throw new AppError('独立线路配置未通过本机组件检查',409);}
    const child=spawn(process.execPath,['-e',ownerScript,executable,'-d',this.directory,'-f',file],{
      stdio:['pipe','pipe','pipe'],shell:false,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    this.child=child;child.stdin.on('error',()=>{});child.stdout.resume();child.stderr.resume();
    child.on('error',()=>{});
    try{
      for(let n=0;n<60;n++){
        if(child.exitCode!==null||child.signalCode!==null)throw new Error('line exited');
        if(await portOpen(selected.port)){
          this.selected=selected;await writeFile(path.join(this.directory,'selection.json'),JSON.stringify(selected),{mode:0o600});return selected;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('line timeout');
    }catch{await this.close();throw new AppError('独立本机线路启动失败，未修改 Clash 全局节点',409);}
  }
  async close(){
    const child=this.child;this.child=undefined;
    if(child&&child.exitCode===null&&child.signalCode===null){
      const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.stdin.end();
      const timer=setTimeout(()=>child.kill('SIGTERM'),1500);await closed;clearTimeout(timer);
    }
  }
}
