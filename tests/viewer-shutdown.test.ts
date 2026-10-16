import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';
import { createService } from '../server/service.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';

test('Service shutdown closes an active viewer before awaiting the HTTP server, even without a close handshake', {timeout:5000}, async()=>{
  const directory=await mkdtemp(path.join(homedir(),'.mu-viewer-shutdown-'));
  const service=await createService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:directory,port:0});
  const sockets=new Set<Socket>();
  const rfb=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.write('RFB 003.008\n');});
  const vnc=path.join(directory,'vnc.sock');await new Promise<void>(resolve=>rfb.listen(vnc,resolve));
  service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
  service.manager.runtime.management=async()=>'';
  service.manager.assertAccess=async()=>undefined;
  let client:WebSocket|undefined,closed=false;
  try{
    const environment=await service.manager.create({name:'Viewer shutdown'});service.manager.store.state(environment.id,'running');
    const transport=new EventEmitter() as any;transport.exitCode=null;transport.kill=()=>{transport.exitCode=0;transport.emit('exit');return true;};
    service.guestBrowser.entries.set(environment.id,{environment:service.manager.store.get(environment.id),release:CURRENT_BROWSER_RELEASE,
      password:'abcdefgh',transport,directory:path.join(directory,'viewer'),vnc,cdp:'',ready:true,sessions:new Map(),configuration:new Set()});
    const {ticket}=service.guestBrowser.issue(environment.id);
    client=new WebSocket(`${service.url.replace('http:','ws:')}/guest-browser?ticket=${ticket}`,{origin:service.url});client.on('error',()=>{});
    await new Promise<void>((resolve,reject)=>{client!.once('open',resolve);client!.once('error',reject);});
    assert.equal(service.guestBrowser.wss.clients.size,1);
    // Emulate a viewer that no longer reads and cannot answer the close handshake.
    (client as any)._socket.pause();
    const closing=service.close();assert.equal(service.close(),closing);
    await closing;closed=true;
    assert.equal(service.guestBrowser.entries.size,0);assert.equal(service.guestBrowser.tickets.size,0);
    await assert.rejects(fetch(`${service.url}/api/snapshot`));
    assert.equal(transport.exitCode,0);
  }finally{
    client?.terminate();for(const socket of sockets)socket.destroy();
    if(!closed){for(const peer of service.guestBrowser.wss.clients)peer.terminate();await service.close();}
    await new Promise<void>(resolve=>rfb.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
  }
});
