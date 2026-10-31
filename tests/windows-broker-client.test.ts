import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {randomBytes} from 'node:crypto';
import {HyperVBrokerClient,buildBroker,installBroker,startBroker,brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs,fileHash} from '../server/platform/windows/runtime.ts';

async function pipeFixture(connected:(socket:Socket)=>void){
 const client=new HyperVBrokerClient(randomBytes(32).toString('hex')),server=createServer(connected);await new Promise<void>(resolve=>server.listen(client.pipe,resolve));return {client,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

test('A temporarily absent pipe retries only before connecting and submits the request once',{skip:process.platform!=='win32'},async()=>{
 const client=new HyperVBrokerClient(randomBytes(32).toString('hex'));let received=0;
 const server=createServer(socket=>{let body='';socket.on('data',bytes=>{body+=bytes;if(!body.includes('\n'))return;received++;socket.end(JSON.stringify({ok:true,result:'accepted'})+'\n');});});
 const request=client.call('status',{id:'synthetic'},{timeoutMs:3000});void request.catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,150));await new Promise<void>((resolve,reject)=>server.listen(client.pipe,resolve).once('error',reject));
 try{assert.equal(await request,'accepted');assert.equal(received,1);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('A lost reply after connection never replays a mutating request',{skip:process.platform!=='win32'},async()=>{
 let received=0;const f=await pipeFixture(socket=>{socket.once('data',()=>{received++;socket.destroy();});});
 try{await assert.rejects(f.client.call('start',{id:'synthetic'},{timeoutMs:3000}),{code:'BROKER_UNAVAILABLE'});await new Promise(resolve=>setTimeout(resolve,200));assert.equal(received,1);}finally{await f.close();}
});

test('Cancelling during a pre-connect retry stops without waiting for the retry window',{skip:process.platform!=='win32'},async()=>{
 const client=new HyperVBrokerClient(randomBytes(32).toString('hex')),controller=new AbortController();
 const request=client.call('start',{id:'synthetic'},{signal:controller.signal,timeoutMs:3000});void request.catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,120));controller.abort();await assert.rejects(request,{code:'CANCELLED'});
 let connections=0;const server=createServer(socket=>{connections++;socket.destroy();});await new Promise<void>((resolve,reject)=>server.listen(client.pipe,resolve).once('error',reject));
 try{await new Promise(resolve=>setTimeout(resolve,200));assert.equal(connections,0);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('A missing pipe still fails within the original operation timeout',{skip:process.platform!=='win32'},async()=>{
 const client=new HyperVBrokerClient(randomBytes(32).toString('hex')),started=performance.now();
 await assert.rejects(client.call('status',{id:'synthetic'},{timeoutMs:150}),{code:'BROKER_TIMEOUT'});
 assert.ok(performance.now()-started<1500);
});

test('Actual broker startup separates the launch wait from a pending identity handshake without invoking UAC',{skip:process.platform!=='win32'},async()=>{
 const expected=await brokerSourceDigest(),phases:string[]=[],sockets=new Set<Socket>();let launchEntered!:()=>void,releaseLaunch!:()=>void,helloEntered!:()=>void,releaseHello!:()=>void;
 const launched=new Promise<void>(resolve=>launchEntered=resolve),launchGate=new Promise<void>(resolve=>releaseLaunch=resolve),hello=new Promise<void>(resolve=>helloEntered=resolve),helloGate=new Promise<void>(resolve=>releaseHello=resolve);
 const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let input='';socket.on('data',async bytes=>{input+=bytes;if(!input.includes('\n'))return;assert.equal(JSON.parse(input).action,'hello');helloEntered();await helloGate;socket.end(JSON.stringify({ok:true,result:{version:1,ownerPid:process.pid,ownerSid:'S-1-5-21-1-2-3-1001',elevated:true,protectedStorage:true,sourceDigest:expected}})+'\n');});});
 const runner:typeof run=async(file,args)=>{assert.equal(file,powershellPath());const command=Buffer.from(args[args.indexOf('-EncodedCommand')+1],'base64').toString('utf16le'),nonce=command.match(/'--pipe','([a-f0-9]{64})'/)?.[1];assert.ok(nonce);const client=new HyperVBrokerClient(nonce);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(client.pipe,resolve);});launchEntered();await launchGate;return '';};
 let done=false;const pending=startBroker('C:\\Synthetic\\broker.exe',{recoveryOnly:true,onPhase:phase=>phases.push(phase)},runner).finally(()=>{done=true;});let deadline:ReturnType<typeof setTimeout>|undefined;
 try{const timeout=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(Error('Synthetic startup handshake timed out')),10000);});await Promise.race([launched,timeout]);assert.deepEqual(phases,['authorizing']);releaseLaunch();await Promise.race([hello,timeout]);assert.deepEqual(phases,['authorizing','connecting']);assert.equal(done,false);releaseHello();await pending;assert.equal(done,true);}finally{clearTimeout(deadline);releaseLaunch();releaseHello();await pending.catch(()=>{});for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('A failed launch cannot announce that the broker has connected',{skip:process.platform!=='win32'},async()=>{
 const phases:string[]=[];await assert.rejects(startBroker('C:\\Synthetic\\broker.exe',{onPhase:phase=>phases.push(phase)},async()=>{throw Error('Synthetic launch cancelled');}),{message:'Synthetic launch cancelled'});assert.deepEqual(phases,['authorizing']);
});
test('Broker client preserves framing and cannot override its selected operation',{skip:process.platform!=='win32'},async()=>{
 const f=await pipeFixture(socket=>{let body='';socket.on('data',bytes=>{body+=bytes;if(!body.includes('\n'))return;const value=JSON.parse(body.trim());socket.end(JSON.stringify({ok:true,result:{action:value.action,value:value.value}})+'\n');});});
 try{assert.deepEqual(await f.client.call('hello',{action:'shutdown',value:'中文'}),{action:'hello',value:'中文'});}finally{await f.close();}
});
test('Broker client rejects malformed and oversized replies',{skip:process.platform!=='win32'},async()=>{
 for(const data of ['not-json\n','x'.repeat(300000)]){const f=await pipeFixture(socket=>{socket.on('data',()=>socket.end(data));});try{await assert.rejects(f.client.call('hello'));}finally{await f.close();}}
});

test('Only snapshot owner requests and transaction replies use the larger bounded IPC envelope',{skip:process.platform!=='win32'},async()=>{
 const ownerConfiguration='enc:'+Buffer.alloc(300000,7).toString('base64'),f=await pipeFixture(socket=>{socket.on('error',()=>{});let body='';socket.on('data',part=>{body+=part.toString('utf8');if(!body.includes('\n'))return;const request=JSON.parse(body.trim());socket.end(JSON.stringify({ok:true,result:request.action==='snapshot-status'?{ownerConfiguration}:{action:request.action,bytes:Buffer.byteLength(body),length:request.ownerConfiguration?.length}})+'\n');});});
 try{await assert.rejects(f.client.call('hello',{action:'snapshot-create',ownerConfiguration}),{code:'BROKER_REQUEST_TOO_LARGE'});await assert.rejects(f.client.call('snapshot-create',{ownerConfiguration:'x'.repeat(1024*1024)}),{code:'BROKER_REQUEST_TOO_LARGE'});for(const action of ['snapshot-create','snapshot-prepare'] as const){const result=await f.client.call(action,{ownerConfiguration}) as {action:string;length:number};assert.equal(result.action,action);assert.equal(result.length,ownerConfiguration.length);}assert.deepEqual(await f.client.call('snapshot-status'),{ownerConfiguration});}finally{await f.close();}
 const oversizedOrdinary=await pipeFixture(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.end(JSON.stringify({ok:true,result:{ownerConfiguration}})+'\n'));});try{await assert.rejects(oversizedOrdinary.client.call('hello'),/Oversized broker reply/);}finally{await oversizedOrdinary.close();}
});
test('Cancelling a broker request closes its owning pipe rather than leaving work attached',{skip:process.platform!=='win32'},async()=>{
 let received!:()=>void,closed!:()=>void;const ready=new Promise<void>(resolve=>{received=resolve;}),ended=new Promise<void>(resolve=>{closed=resolve;});
 const f=await pipeFixture(socket=>{socket.once('data',received);socket.once('close',closed);});const controller=new AbortController();
 try{const request=f.client.call('doctor',{}, {signal:controller.signal});await ready;controller.abort();await assert.rejects(request,{code:'CANCELLED'});await ended;}finally{await f.close();}
});

test('The exact broker and channel build under Restricted process policy in a quoted Unicode path',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-broker-policy-')),root=path.join(directory,"测试 user's build");await mkdir(root);let compilations=0;
 const restricted:typeof run=(file,args,options)=>{if(file===powershellPath()){compilations++;return run(file,['-ExecutionPolicy','Restricted',...args],options);}return run(file,args,options);};
 try{const artifact=await buildBroker(root,restricted);assert.equal(compilations,2);assert.equal(await fileHash(artifact.broker),artifact.sha256);assert.equal(await fileHash(artifact.channel),artifact.channelSha256);assert.equal(artifact.sourceDigest,await brokerSourceDigest());}
 finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-broker-policy-/);await rm(target,{recursive:true,force:true});}
});

test('The installer launch stays below the Windows command limit under Restricted policy without changing real privileges',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-install-policy-'));let powerShellCalls=0;
 const isolated:typeof run=(file,args,options)=>{
  if(file!==powershellPath())return run(file,args,options);
  powerShellCalls++;if(powerShellCalls<3)return run(file,['-ExecutionPolicy','Restricted',...args],options);
  assert.ok([file,...args].join(' ').length<32767,'The outer launch must not encode the already-encoded elevated payload again');
  const command=Buffer.from(args[args.indexOf('-EncodedCommand')+1],'base64').toString('utf16le');
  const mock=`function Start-Process {
   param($FilePath,$ArgumentList,$WorkingDirectory,$Verb,$WindowStyle,[switch]$Wait,[switch]$PassThru)
   if($Verb -ne 'RunAs' -or $WindowStyle -ne 'Hidden' -or -not $Wait -or -not $PassThru){throw 'Unexpected elevation request'}
   if($ArgumentList[-2] -ne '-EncodedCommand' -or ($FilePath+' '+($ArgumentList -join ' ')).Length -ge 32767){throw 'Elevated command limit exceeded'}
   [pscustomobject]@{ExitCode=0}
  }`;
  // Only this child process has a stricter policy and a fake elevation launch.
  return run(file,['-ExecutionPolicy','Restricted',...powershellArgs(mock+'\n'+command)],options);
 };
 const phases:string[]=[];
 try{await installBroker(directory,isolated,phase=>{phases.push(phase);assert.equal(powerShellCalls,phase==='building'?0:2);});assert.equal(powerShellCalls,3);assert.deepEqual(phases,['building','installing']);}
 finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-install-policy-/);await rm(target,{recursive:true,force:true});}
});
