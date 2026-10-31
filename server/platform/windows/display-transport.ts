import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {WebSocket,WebSocketServer} from 'ws';
import {AppError} from '../../errors.ts';

export interface WindowsDisplayConnection {
 environment:{id:string};sessionId:string;password:string;ready:boolean;closed:boolean;vnc?:()=>Duplex;
}
export interface WindowsDisplayScope {current():boolean}
export interface WindowsDisplayTicket{id:string;sessionId:string;expires:number;scope?:WindowsDisplayScope}

// One authenticated display channel can serve browser and desktop views.
// This class starts no guest program and never grants network authority.
export class WindowsDisplayTransport<E extends WindowsDisplayConnection>{
 readonly tickets=new Map<string,WindowsDisplayTicket>();
 readonly peers=new Map<string,Set<WebSocket>>();
 readonly wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
 private pending=new Map<string,number>();private revocations=new WeakMap<E,object>();private closed=false;
 private scopedPeers=new Map<WindowsDisplayScope,Set<WebSocket>>();
 private revokedScopes=new WeakSet<WindowsDisplayScope>();
 readonly entries:ReadonlyMap<string,E>;private current:(entry:E)=>boolean;private access:(id:string)=>Promise<unknown>;
 constructor(entries:ReadonlyMap<string,E>,current:(entry:E)=>boolean,access:(id:string)=>Promise<unknown>){this.entries=entries;this.current=current;this.access=access;}
 private live(entry:E){return !this.closed&&entry.ready&&!entry.closed&&this.entries.get(entry.environment.id)===entry&&this.current(entry);}
 issue(id:string,scope?:WindowsDisplayScope){
  const entry=this.entries.get(id);if(!entry||!this.live(entry))throw new AppError('浏览器未运行',409);
  if(scope&&(this.revokedScopes.has(scope)||!scope.current()))throw new AppError('画面使用凭据已失效',409,'DISPLAY_SCOPE_CHANGED');
  for(const [key,ticket] of this.tickets)if(ticket.expires<Date.now())this.tickets.delete(key);
  if(this.tickets.size>=32)throw new AppError('等待连接的画面过多',429);
  const ticket=randomBytes(24).toString('base64url');this.tickets.set(ticket,{id,sessionId:entry.sessionId,expires:Date.now()+15000,...(scope?{scope}:{})});return {ticket,password:entry.password};
 }
 async upgrade(request:IncomingMessage,socket:Duplex,head:Buffer,authorize:(request:IncomingMessage)=>boolean){
  const url=new URL(request.url??'/','http://127.0.0.1'),keys=url.searchParams.getAll('ticket'),key=keys[0]??'',ticket=this.tickets.get(key);this.tickets.delete(key);
  const entry=ticket?this.entries.get(ticket.id):undefined;
  if(url.pathname!=='/guest-browser'||url.searchParams.size!==1||keys.length!==1||!ticket||ticket.expires<Date.now()||!entry||entry.sessionId!==ticket.sessionId||!this.live(entry)||!authorize(request)){socket.destroy();return;}
  const revision=this.revocations.get(entry),live=()=>this.live(entry)&&this.revocations.get(entry)===revision&&(!ticket.scope||!this.revokedScopes.has(ticket.scope)&&ticket.scope.current());
  const pending=this.pending.get(ticket.id)??0;
  if((this.peers.get(ticket.id)?.size??0)+pending>=4||this.wss.clients.size+[...this.pending.values()].reduce((a,b)=>a+b,0)>=16){socket.destroy();return;}
  this.pending.set(ticket.id,pending+1);
  try{
   await this.access(ticket.id);if(socket.destroyed||ticket.expires<Date.now()||!live()||!authorize(request)){socket.destroy();return;}
   this.wss.handleUpgrade(request,socket,head,ws=>{
    if(ticket.expires<Date.now()||!live()||!authorize(request)){ws.terminate();return;}
    const peers=this.peers.get(ticket.id)??new Set<WebSocket>();peers.add(ws);this.peers.set(ticket.id,peers);
    const scoped=ticket.scope?(this.scopedPeers.get(ticket.scope)??new Set<WebSocket>()):undefined;if(scoped){scoped.add(ws);this.scopedPeers.set(ticket.scope!,scoped);}
    const unScope=()=>{scoped?.delete(ws);if(scoped&&!scoped.size&&this.scopedPeers.get(ticket.scope!)===scoped)this.scopedPeers.delete(ticket.scope!);};
    let stream:Duplex;
    try{if(!entry.vnc)throw Error('Display channel unavailable');stream=entry.vnc();}
    catch{unScope();peers.delete(ws);if(!peers.size&&this.peers.get(ticket.id)===peers)this.peers.delete(ticket.id);ws.terminate();return;}
    stream.on('data',data=>{if(!live()||ws.bufferedAmount>8*1024*1024){ws.terminate();return;}if(ws.readyState===WebSocket.OPEN)ws.send(data,{binary:true});});
    ws.on('message',(data,binary)=>{if(!binary||!live()||stream.writableLength>2*1024*1024){ws.terminate();return;}stream.write(data as Buffer);});
    stream.on('error',()=>ws.terminate());stream.once('close',()=>ws.terminate());ws.once('error',()=>stream.destroy());
    ws.once('close',()=>{unScope();stream.destroy();peers.delete(ws);if(!peers.size&&this.peers.get(ticket.id)===peers)this.peers.delete(ticket.id);});
   });
  }catch{socket.destroy();}
  finally{const count=(this.pending.get(ticket.id)??1)-1;if(count)this.pending.set(ticket.id,count);else this.pending.delete(ticket.id);}
 }
 revokeScope(scope:WindowsDisplayScope){this.revokedScopes.add(scope);for(const [key,ticket] of this.tickets)if(ticket.scope===scope)this.tickets.delete(key);const peers=this.scopedPeers.get(scope);this.scopedPeers.delete(scope);for(const peer of peers??[])try{peer.terminate();}catch{/* Revoke every peer belonging to this view. */}}
 revoke(id:string){
  const entry=this.entries.get(id);if(entry)this.revocations.set(entry,{});
  for(const [key,ticket] of this.tickets)if(ticket.id===id)this.tickets.delete(key);
  const peers=this.peers.get(id);this.peers.delete(id);
  for(const peer of peers??[]){try{peer.terminate();}catch{/* Revoke every remaining peer. */}}
 }
 dispose(){if(this.closed)return;this.closed=true;this.tickets.clear();for(const peer of this.wss.clients)peer.terminate();this.peers.clear();this.scopedPeers.clear();this.wss.close();}
}
