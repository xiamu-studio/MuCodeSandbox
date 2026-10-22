import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import type {HyperVBrokerClient,BrokerAction} from '../server/platform/windows/broker.ts';
import {openProtectedBackupRead} from '../server/platform/windows/backup-reader.ts';
import {run} from '../server/process.ts';
import {powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
const id='12345678-1234-4234-8234-123456789012',session='87654321-4321-4321-8321-210987654321';
function fixture(change?:(value:Record<string,unknown>)=>unknown){
 const data=Buffer.alloc(65539);for(let i=0;i<data.length;i++)data[i]=i%251;const actions:{action:BrokerAction;request:Record<string,unknown>}[]=[];
 const info={id,session,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),chunkBytes:32768,platformId:session,imageSha256:'a'.repeat(64),cpus:2,memoryGiB:4,diskGiB:32,diskIdentifier:id,state:'Off'};
 const client={call:async(action:BrokerAction,request:Record<string,unknown>={})=>{actions.push({action,request});if(action==='backup-begin')return info;if(action==='backup-close')return {closed:true};assert.equal(action,'backup-read');assert.equal(request.session,session);const offset=Number(request.offset),end=Math.min(offset+32768,data.length),value={data:data.subarray(offset,end).toString('base64'),nextOffset:end,done:end===data.length};return change?change(value):value;}} as HyperVBrokerClient;
 return {client,data,actions,info};
}
test('Protected backup consumes exact native chunks once, clears yielded buffers and releases its read lease',async()=>{
 const f=fixture(),reader=await openProtectedBackupRead(f.client,id),chunks:Buffer[]=[],references:Buffer[]=[];
 for await(const chunk of reader.read()){chunks.push(Buffer.from(chunk));references.push(chunk);}
 assert.deepEqual(Buffer.concat(chunks),f.data);assert.ok(references.every(value=>value.every(byte=>byte===0)));
 assert.deepEqual(f.actions.filter(value=>value.action==='backup-read').map(value=>value.request.offset),[0,32768,65536]);assert.equal(f.actions.filter(value=>value.action==='backup-close').length,1);await reader.close();await assert.rejects(async()=>{for await(const _ of reader.read()){}},{code:'BACKUP_EXPIRED'});
});
test('Protected backup validates length, offset, canonical base64 and final markers before yielding a block',async t=>{
 for(const [name,change] of Object.entries({short:(value:any)=>({...value,data:'AA=='}),offset:(value:any)=>({...value,nextOffset:1}),final:(value:any)=>({...value,done:true}),base64:(value:any)=>({...value,data:value.data+'\n'}),fields:(value:any)=>({...value,path:'C:/arbitrary'})}))await t.test(name,async()=>{
  const f=fixture(change),reader=await openProtectedBackupRead(f.client,id);let yielded=false;await assert.rejects(async()=>{for await(const _ of reader.read())yielded=true;});assert.equal(yielded,false);assert.equal(f.actions.at(-1)?.action,'backup-close');
 });
});
test('Stopping iteration or cancellation releases the native lease and never requests later disk offsets',async()=>{
 for(const cancel of [false,true]){
  const f=fixture(),abort=new AbortController(),reader=await openProtectedBackupRead(f.client,id,{signal:abort.signal});
  if(cancel){abort.abort();await assert.rejects(async()=>{for await(const _ of reader.read()){}},{name:'AbortError'});assert.equal(f.actions.some(value=>value.action==='backup-read'),false);}
  else{for await(const _ of reader.read())break;assert.equal(f.actions.filter(value=>value.action==='backup-read').length,1);}
  assert.equal(f.actions.at(-1)?.action,'backup-close');
 }
});
test('A malformed native backup receipt with a valid lease is closed before metadata rejection',async()=>{
 const f=fixture();f.info.bytes=0;await assert.rejects(openProtectedBackupRead(f.client,id));assert.deepEqual(f.actions.map(value=>value.action),['backup-begin','backup-close']);
});
test('Protected binary backup handles Windows pipe framing, early EOF, early return and invalid pipe names',{skip:process.platform!=='win32'},async t=>{
 for(const mode of ['complete','short','cancel','name'] as const)await t.test(mode,async()=>{
  const f=fixture(),pipeName='MuCodeSandbox-Backup-'+randomUUID().replaceAll('-','');let released=false;
  const server=createServer(socket=>{socket.once('error',()=>{});socket.once('data',hello=>{assert.equal(hello.toString(),'.');const bytes=mode==='short'?f.data.subarray(0,100):f.data;socket.write(bytes.subarray(0,32768));if(bytes.length>32768)socket.write(bytes.subarray(32768));if(mode==='short')socket.end();});});await new Promise<void>(resolve=>server.listen('\\\\.\\pipe\\'+pipeName,resolve));
  const call=f.client.call.bind(f.client);f.client.call=async(action,parameters,options)=>{if(action==='backup-stream')return {pipeName:mode==='name'?'C:/arbitrary':pipeName};if(action==='backup-close')released=true;return call(action,parameters,options);};
  try{const reader=await openProtectedBackupRead(f.client,id),chunks:Buffer[]=[];const consume=async()=>{for await(const bytes of reader.stream()){chunks.push(Buffer.from(bytes));if(mode==='cancel')break;}};
   if(mode==='short'||mode==='name')await assert.rejects(consume());else await consume();if(mode==='complete')assert.deepEqual(Buffer.concat(chunks),f.data);if(mode==='name')assert.equal(chunks.length,0);assert.equal(released,true);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
test('The native backup cursor keeps a real Windows file immutable, enforces sequential bounded reads and releases its handle',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-backup-cursor-'));
 try{await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText('${path.resolve('tests/fixtures/windows-backup-cursor.ps1').replaceAll("'","''")}'))) -Source '${path.resolve('native/windows/BackupCursor.cs').replaceAll("'","''")}' -Directory '${directory.replaceAll("'","''")}'`),{timeoutMs:20000});}
 finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-backup-cursor-/);await rm(target,{recursive:true,force:true});}
});
