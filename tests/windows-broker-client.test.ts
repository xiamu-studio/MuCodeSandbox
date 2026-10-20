import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {randomBytes} from 'node:crypto';
import {HyperVBrokerClient} from '../server/platform/windows/broker.ts';

async function pipeFixture(connected:(socket:Socket)=>void){
 const client=new HyperVBrokerClient(randomBytes(32).toString('hex')),server=createServer(connected);await new Promise<void>(resolve=>server.listen(client.pipe,resolve));return {client,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
test('Broker client preserves framing and cannot override its selected operation',{skip:process.platform!=='win32'},async()=>{
 const f=await pipeFixture(socket=>{let body='';socket.on('data',bytes=>{body+=bytes;if(!body.includes('\n'))return;const value=JSON.parse(body.trim());socket.end(JSON.stringify({ok:true,result:{action:value.action,value:value.value}})+'\n');});});
 try{assert.deepEqual(await f.client.call('hello',{action:'shutdown',value:'中文'}),{action:'hello',value:'中文'});}finally{await f.close();}
});
test('Broker client rejects malformed and oversized replies',{skip:process.platform!=='win32'},async()=>{
 for(const data of ['not-json\n','x'.repeat(300000)]){const f=await pipeFixture(socket=>{socket.on('data',()=>socket.end(data));});try{await assert.rejects(f.client.call('hello'));}finally{await f.close();}}
});
test('Cancelling a broker request closes its owning pipe rather than leaving work attached',{skip:process.platform!=='win32'},async()=>{
 let received!:()=>void,closed!:()=>void;const ready=new Promise<void>(resolve=>{received=resolve;}),ended=new Promise<void>(resolve=>{closed=resolve;});
 const f=await pipeFixture(socket=>{socket.once('data',received);socket.once('close',closed);});const controller=new AbortController();
 try{const request=f.client.call('doctor',{}, {signal:controller.signal});await ready;controller.abort();await assert.rejects(request,{code:'CANCELLED'});await ended;}finally{await f.close();}
});
