import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import type {IWindowsPtyForkOptions} from 'node-pty';
import {WebSocket,WebSocketServer} from 'ws';
import {AppError} from '../../errors.ts';
import type {WindowsManager} from './manager.ts';
import type {HyperVRuntime} from './runtime.ts';
import {spawnWindowsTerminal,type TerminalPty} from './terminal-process.ts';

interface Ticket{environmentId:string;sessionId:string;expires:number;cols:number;rows:number;command:'shell'|'claude'}
interface Entry{child:TerminalPty;ws:WebSocket}
export type WindowsTerminalRuntime=Pick<HyperVRuntime,'terminalLaunch'>;
export type PtyFactory=(file:string,args:string[],options:IWindowsPtyForkOptions)=>TerminalPty;
const bounded=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.floor(value)));

export class WindowsTerminalServer{
 readonly wss=new WebSocketServer({noServer:true,maxPayload:65536});
 readonly tickets=new Map<string,Ticket>();readonly children=new Map<string,Set<Entry>>();
 private pending=new Map<string,number>();private closing=false;
 readonly manager:WindowsManager;readonly runtime:WindowsTerminalRuntime;private factory?:PtyFactory;
 authorizeClaude:((id:string)=>Promise<void>)|undefined;
 constructor(manager:WindowsManager,runtime:WindowsTerminalRuntime,factory?:PtyFactory){this.manager=manager;this.runtime=runtime;this.factory=factory;}
 private current(t:Ticket,existing=false){return !this.closing&&!(existing?this.manager.terminalStreamBusy(t.environmentId):this.manager.guestOperationBusy(t.environmentId))&&this.manager.sessions.get(t.environmentId)?.id===t.sessionId&&this.manager.sessions.get(t.environmentId)?.state==='active'&&this.manager.store.get(t.environmentId).state==='running';}
 issue(id:string,cols=100,rows=28,command:'shell'|'claude'='shell'){
  if(command!=='shell'&&command!=='claude'||command==='claude'&&!this.authorizeClaude)throw new AppError('此终端命令尚未开放',409,'TERMINAL_COMMAND');
  const session=this.manager.sessions.get(id);if(!session||!this.current({environmentId:id,sessionId:session.id,expires:0,cols,rows,command}))throw new AppError('请先通过环境防护核验',409,'GUARD_FAILED');
  for(const [key,ticket] of this.tickets)if(ticket.expires<Date.now())this.tickets.delete(key);
  if(this.tickets.size>=32)throw new AppError('等待连接的终端过多',429,'TERMINAL_LIMIT');
  const key=randomBytes(24).toString('base64url');this.tickets.set(key,{environmentId:id,sessionId:session.id,expires:Date.now()+15000,cols:bounded(cols,20,300),rows:bounded(rows,5,100),command});return key;
 }
 async upgrade(request:IncomingMessage,socket:Duplex,head:Buffer,authorize:(request:IncomingMessage)=>boolean){
  const url=new URL(request.url??'/','http://127.0.0.1'),keys=url.searchParams.getAll('ticket'),key=keys[0]??'',ticket=this.tickets.get(key);this.tickets.delete(key);
  if(url.pathname!=='/terminal'||keys.length!==1||!ticket||ticket.expires<Date.now()||!authorize(request)||!this.current(ticket)){socket.destroy();return;}
  const id=ticket.environmentId,pending=this.pending.get(id)??0,totalPending=[...this.pending.values()].reduce((a,b)=>a+b,0);
  if((this.children.get(id)?.size??0)+pending>=4||this.wss.clients.size+totalPending>=16){socket.destroy();return;}
  this.pending.set(id,pending+1);
  try{
   await this.manager.assertAccess(id);
   if(ticket.command==='claude'){if(!this.authorizeClaude)throw new AppError('专用终端未开放',409,'TERMINAL_COMMAND');await this.authorizeClaude(id);}
   const launch=await this.runtime.terminalLaunch(await this.manager.profile(this.manager.store.get(id)),ticket.command);
   const factory=this.factory??spawnWindowsTerminal;
   if(socket.destroyed||!this.current(ticket)){socket.destroy();return;}
   this.wss.handleUpgrade(request,socket,head,ws=>{
    const send=(type:string,data:unknown)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type,data}));};
    let child:TerminalPty;try{child=factory(launch.file,launch.args,{cwd:launch.cwd,env:launch.env,name:'xterm-256color',cols:ticket.cols,rows:ticket.rows,useConpty:true,useConptyDll:true});}
    catch{send('error','Windows 终端组件不可用，请检查安装后重试');ws.close();return;}
    const entries=this.children.get(id)??new Set<Entry>(),entry={child,ws};entries.add(entry);this.children.set(id,entries);
    const valid=()=>{if(this.current(ticket,true))return true;ws.terminate();return false;};
    const data=child.onData(value=>{if(!valid())return;if(ws.bufferedAmount>2*1024*1024){ws.close(1008,'Terminal consumer is too slow');return;}send('data',value);});
    const exit=child.onExit(({exitCode})=>{entries.delete(entry);if(!entries.size&&this.children.get(id)===entries)this.children.delete(id);data.dispose();exit.dispose();send('exit',exitCode);ws.close();});
    ws.on('message',bytes=>{
     if(!valid())return;
     try{const message=JSON.parse(bytes.toString());
      if(message.type==='input'&&typeof message.data==='string'&&Buffer.byteLength(message.data)<=49152)child.write(message.data);
      else if(message.type==='resize'&&Number.isFinite(message.cols)&&Number.isFinite(message.rows))child.resize(bounded(message.cols,20,300),bounded(message.rows,5,100));
      else ws.close(1008,'Invalid terminal message');
     }catch{ws.close(1008,'Invalid terminal message');}
    });
    ws.once('close',()=>{try{child.kill();}catch{}entries.delete(entry);if(!entries.size&&this.children.get(id)===entries)this.children.delete(id);});
    send('connected',this.manager.store.get(id).name);this.manager.store.log(id,null,ticket.command==='claude'?'已连接 Claude Code 专用终端（Linux dev 用户）':'已连接 Windows Linux 终端（dev 用户）');
   });
  }catch{socket.destroy();}
  finally{const count=(this.pending.get(id)??1)-1;if(count)this.pending.set(id,count);else this.pending.delete(id);}
 }
 closeEnvironment(id:string){for(const [key,ticket] of this.tickets)if(ticket.environmentId===id)this.tickets.delete(key);for(const entry of this.children.get(id)??[]){entry.ws.terminate();try{entry.child.kill();}catch{}}this.children.delete(id);}
 close(){this.closing=true;this.tickets.clear();for(const id of this.children.keys())this.closeEnvironment(id);for(const ws of this.wss.clients)ws.terminate();this.wss.close();}
}
