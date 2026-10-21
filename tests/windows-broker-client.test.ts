import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {randomBytes} from 'node:crypto';
import {HyperVBrokerClient,buildBroker,installBroker,brokerSourceDigest} from '../server/platform/windows/broker.ts';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs,fileHash} from '../server/platform/windows/runtime.ts';

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
 try{await installBroker(directory,isolated);assert.equal(powerShellCalls,3);}
 finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-install-policy-/);await rm(target,{recursive:true,force:true});}
});
