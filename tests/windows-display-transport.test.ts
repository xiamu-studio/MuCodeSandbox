import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PassThrough} from 'node:stream';
import type {Socket} from 'node:net';
import {WebSocket} from 'ws';
import {WindowsDisplayTransport,type WindowsDisplayConnection} from '../server/platform/windows/display-transport.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
async function until(check:()=>boolean){const deadline=Date.now()+4000;while(!check()){assert.ok(Date.now()<deadline,'Display fixture checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(){
 const entries=new Map<string,WindowsDisplayConnection>(),sessions=new Map<string,string>(),streams:PassThrough[]=[],sockets=new Set<Socket>();let accesses=0,failFactory=false,authorized=true,access=async()=>{};
 const transport=new WindowsDisplayTransport(entries,entry=>sessions.get(entry.environment.id)===entry.sessionId,async()=>{accesses++;await access();});
 function entry(id='display'){const value:WindowsDisplayConnection={environment:{id},sessionId:'session-'+id,password:'fixture8',ready:true,closed:false,vnc:()=>{if(failFactory)throw Error('Synthetic VNC channel failure');const stream=new PassThrough();streams.push(stream);return stream;}};entries.set(id,value);sessions.set(id,value.sessionId);return value;}
 entry();const server=createServer();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.on('upgrade',(req,socket,head)=>{void transport.upgrade(req,socket,head,request=>authorized&&request.headers['x-display-fixture']==='yes').catch(()=>socket.destroy());});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const port=address.port;
 function connect(query:string,authorized=true,pathname='/guest-browser'){const ws=new WebSocket('ws://127.0.0.1:'+port+pathname+'?'+query,{headers:authorized?{'x-display-fixture':'yes'}:{}});const opened=new Promise<boolean>(resolve=>{ws.once('open',()=>resolve(true));ws.once('error',()=>resolve(false));});return {ws,opened};}
 async function close(){transport.dispose();for(const stream of streams)stream.destroy();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 return {entries,sessions,streams,transport,entry,connect,close,get accesses(){return accesses;},setAccess:(value:()=>Promise<void>)=>{access=value;},failFactory:()=>{failFactory=true;},revokeAuthorization:()=>{authorized=false;}};
}

test('Scoped view revocation closes only its peers and invalidates unused and captured tickets',async()=>{
 const f=await fixture();try{const scope=Object.freeze({current:()=>true}),other=Object.freeze({current:()=>true});const a=f.connect('ticket='+f.transport.issue('display',scope).ticket),b=f.connect('ticket='+f.transport.issue('display',other).ticket);assert.equal(await a.opened,true);assert.equal(await b.opened,true);const unused=f.transport.issue('display',scope);const closed=new Promise<void>(resolve=>a.ws.once('close',()=>resolve()));f.transport.revokeScope(scope);await closed;assert.throws(()=>f.transport.issue('display',scope),{code:'DISPLAY_SCOPE_CHANGED'});assert.equal(await f.connect('ticket='+unused.ticket).opened,false);const reply=new Promise<Buffer>(resolve=>b.ws.once('message',data=>resolve(Buffer.from(data as Buffer))));b.ws.send(Buffer.from([31,33]));assert.deepEqual(await reply,Buffer.from([31,33]));assert.equal(f.entries.get('display')?.ready,true);}finally{await f.close();}
});
test('Scoped revocation while guard admission waits cannot attach a consumed old ticket',async()=>{
 const f=await fixture(),gate=deferred();try{const scope=Object.freeze({current:()=>true});f.setAccess(()=>gate.promise);const client=f.connect('ticket='+f.transport.issue('display',scope).ticket);await until(()=>f.accesses===1);f.transport.revokeScope(scope);gate.resolve();assert.equal(await client.opened,false);assert.equal(f.streams.length,0);}finally{gate.resolve();await f.close();}
});
test('A view becoming stale is rechecked even when its display entry remains current',async()=>{
 const f=await fixture(),gate=deferred();let current=true;try{const scope=Object.freeze({current:()=>current});f.setAccess(()=>gate.promise);const client=f.connect('ticket='+f.transport.issue('display',scope).ticket);await until(()=>f.accesses===1);current=false;gate.resolve();assert.equal(await client.opened,false);assert.equal(f.streams.length,0);}finally{gate.resolve();await f.close();}
});

test('Actual local display WebSocket uses one session ticket, binary stream and one guard admission',async()=>{
 const f=await fixture();try{
  const {ticket,password}=f.transport.issue('display');assert.equal(password,'fixture8');const client=f.connect('ticket='+ticket);assert.equal(await client.opened,true);
  const message=new Promise<Buffer>(resolve=>client.ws.once('message',(data,binary)=>{assert.equal(binary,true);resolve(Buffer.from(data as Buffer));}));client.ws.send(Buffer.from([1,3,5,7]));assert.deepEqual(await message,Buffer.from([1,3,5,7]));
  assert.equal(await f.connect('ticket='+ticket).opened,false);assert.equal(f.accesses,1);assert.equal(f.streams.length,1);
 }finally{await f.close();}
});

test('Display upgrade rejects expired, duplicate, extra, wrong-path and unauthorized tickets before opening guest channels',async t=>{
 for(const scenario of ['expired','duplicate','extra','path','authorization','replacement'])await t.test(scenario,async()=>{
  const f=await fixture();try{const {ticket}=f.transport.issue('display');let query='ticket='+ticket;
   if(scenario==='expired')f.transport.tickets.get(ticket)!.expires=Date.now()-1;
   if(scenario==='duplicate')query+='&ticket='+ticket;if(scenario==='extra')query+='&foreign=1';if(scenario==='replacement')f.sessions.set('display','new-session');
   assert.equal(await f.connect(query,scenario!=='authorization',scenario==='path'?'/foreign':'/guest-browser').opened,false);assert.equal(f.accesses,0);assert.equal(f.streams.length,0);assert.equal(f.transport.tickets.has(ticket),false);
  }finally{await f.close();}
 });
});

test('Display revocation during guard admission invalidates an already consumed ticket without needing entry mutation',async()=>{
 const f=await fixture(),gate=deferred();try{f.setAccess(()=>gate.promise);const client=f.connect('ticket='+f.transport.issue('display').ticket);await until(()=>f.accesses===1);f.transport.revoke('display');gate.resolve();assert.equal(await client.opened,false);assert.equal(f.streams.length,0);assert.equal(f.transport.peers.size,0);}finally{gate.resolve();await f.close();}
});

test('A late display guard cannot attach to a replacement entry with the same session text',async()=>{
 const f=await fixture(),gate=deferred();try{f.setAccess(()=>gate.promise);const client=f.connect('ticket='+f.transport.issue('display').ticket);await until(()=>f.accesses===1);f.entry();gate.resolve();assert.equal(await client.opened,false);assert.equal(f.streams.length,0);}finally{gate.resolve();await f.close();}
});

test('Display ticket expiry is rechecked after a slow guard admission',async()=>{
 const f=await fixture(),gate=deferred();try{f.setAccess(()=>gate.promise);const {ticket}=f.transport.issue('display'),issued=f.transport.tickets.get(ticket)!;const client=f.connect('ticket='+ticket);await until(()=>f.accesses===1);issued.expires=Date.now()-1;gate.resolve();assert.equal(await client.opened,false);assert.equal(f.streams.length,0);}finally{gate.resolve();await f.close();}
});

test('Display authorization is rechecked after guard admission while ticket TTL is not a viewer lifetime',async()=>{
 const f=await fixture(),gate=deferred();try{f.setAccess(()=>gate.promise);const client=f.connect('ticket='+f.transport.issue('display').ticket);await until(()=>f.accesses===1);f.revokeAuthorization();gate.resolve();assert.equal(await client.opened,false);assert.equal(f.streams.length,0);}finally{gate.resolve();await f.close();}
 const live=await fixture();try{const {ticket}=live.transport.issue('display'),issued=live.transport.tickets.get(ticket)!,client=live.connect('ticket='+ticket);assert.equal(await client.opened,true);issued.expires=Date.now()-1;const message=new Promise<Buffer>(resolve=>client.ws.once('message',data=>resolve(Buffer.from(data as Buffer))));client.ws.send(Buffer.from([17,19]));assert.deepEqual(await message,Buffer.from([17,19]));}finally{await live.close();}
});

test('Pending display upgrades count toward the four-viewer limit',async()=>{
 const f=await fixture(),gate=deferred();try{f.setAccess(()=>gate.promise);const clients=Array.from({length:4},()=>f.connect('ticket='+f.transport.issue('display').ticket));await until(()=>f.accesses===4);assert.equal(await f.connect('ticket='+f.transport.issue('display').ticket).opened,false);assert.equal(f.accesses,4);gate.resolve();assert.deepEqual(await Promise.all(clients.map(c=>c.opened)),[true,true,true,true]);assert.equal(f.streams.length,4);}finally{gate.resolve();await f.close();}
});

test('Display connections enforce the global sixteen-viewer limit and reclaim a closed slot',async()=>{
 const f=await fixture();try{
  const clients:ReturnType<typeof f.connect>[]=[];
  for(let group=0;group<4;group++){const id='group-'+group;f.entry(id);for(let n=0;n<4;n++){const client=f.connect('ticket='+f.transport.issue(id).ticket);assert.equal(await client.opened,true);clients.push(client);}}
  f.entry('overflow');assert.equal(await f.connect('ticket='+f.transport.issue('overflow').ticket).opened,false);assert.equal(f.accesses,16);assert.equal(f.streams.length,16);
  clients[0].ws.terminate();await until(()=>f.transport.wss.clients.size===15);assert.equal(await f.connect('ticket='+f.transport.issue('overflow').ticket).opened,true);assert.equal(f.streams.length,17);
 }finally{await f.close();}
});

test('Display tickets stay bounded, and stopped or stale owners cannot issue one',async()=>{
 const f=await fixture();try{for(let n=0;n<32;n++)f.transport.issue('display');assert.throws(()=>f.transport.issue('display'),{status:429});for(const ticket of f.transport.tickets.values())ticket.expires=Date.now()-1;assert.ok(f.transport.issue('display').ticket);f.entries.get('display')!.ready=false;assert.throws(()=>f.transport.issue('display'));f.entries.get('display')!.ready=true;f.sessions.set('display','retired');assert.throws(()=>f.transport.issue('display'));}finally{await f.close();}
});

test('Display text frames are rejected, and revocation closes every active viewer',async()=>{
 const f=await fixture();try{const client=f.connect('ticket='+f.transport.issue('display').ticket);assert.equal(await client.opened,true);const closed=new Promise<void>(resolve=>client.ws.once('close',()=>resolve()));client.ws.send('not binary VNC');await closed;await until(()=>f.streams[0].destroyed);const second=f.connect('ticket='+f.transport.issue('display').ticket);assert.equal(await second.opened,true);const secondClosed=new Promise<void>(resolve=>second.ws.once('close',()=>resolve()));f.transport.revoke('display');await secondClosed;assert.equal(f.transport.peers.size,0);assert.equal(f.transport.tickets.size,0);}finally{await f.close();}
});

test('Display channel creation failure retires its empty peer group and disposal prevents pending admission',async()=>{
 const f=await fixture(),gate=deferred();try{f.failFactory();const client=f.connect('ticket='+f.transport.issue('display').ticket);await client.opened;await until(()=>f.transport.peers.size===0);assert.equal(f.streams.length,0);f.setAccess(()=>gate.promise);const late=f.connect('ticket='+f.transport.issue('display').ticket);await until(()=>f.accesses===2);f.transport.dispose();gate.resolve();assert.equal(await late.opened,false);assert.throws(()=>f.transport.issue('display'));}finally{gate.resolve();await f.close();}
});
