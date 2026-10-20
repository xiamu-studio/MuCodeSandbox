import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConnection,type AddressInfo} from 'node:net';
import {Duplex} from 'node:stream';
import {WebSocketServer} from 'ws';
import {DevTools} from '../server/guest-browser.ts';

test('Windows CDP HTTP and WebSocket both use the supplied stream without a host debug listener',async()=>{
 let connections=0;const server=createServer((req,res)=>{assert.equal(req.url,'/json/version');assert.equal(req.headers.host,'localhost:9222');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({webSocketDebuggerUrl:'ws://localhost:9222/devtools/browser/stream-test'}));});
 const wss=new WebSocketServer({server});wss.on('connection',socket=>socket.on('message',data=>{const value=JSON.parse(data.toString());socket.send(JSON.stringify({id:value.id,result:{product:'Fixture'}}));}));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));let tools:DevTools|undefined;
 try{
  const port=(server.address() as AddressInfo).port;
  tools=await DevTools.openStream(()=>{connections++;const socket=createConnection(port,'127.0.0.1');return Duplex.from({readable:socket,writable:socket});});
  assert.equal((await tools.send('Browser.getVersion')).product,'Fixture');assert.equal(connections,2);
 }finally{tools?.socket.terminate();for(const socket of wss.clients)socket.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Guest CDP metadata cannot redirect the host to another debug endpoint',async()=>{
 for(const endpoint of ['ws://example.invalid:9222/devtools/browser/test','ws://localhost:9999/devtools/browser/test','file:///devtools/browser/test']){
  let connections=0;const server=createServer((_req,res)=>res.end(JSON.stringify({webSocketDebuggerUrl:endpoint})));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(DevTools.openStream(()=>{connections++;const socket=createConnection((server.address() as AddressInfo).port,'127.0.0.1');return Duplex.from({readable:socket,writable:socket});}),/Invalid DevTools endpoint/);assert.equal(connections,1);}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});

test('A guest service EOF before HTTP headers rejects cleanly without a second unhandled error',async()=>{
 const server=createServer();server.on('connection',socket=>socket.end());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await assert.rejects(DevTools.openStream(()=>{const socket=createConnection((server.address() as AddressInfo).port,'127.0.0.1');return Duplex.from({readable:socket,writable:socket});}));await new Promise(resolve=>setTimeout(resolve,30));}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
