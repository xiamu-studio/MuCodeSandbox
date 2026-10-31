import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {z} from 'zod';
import type {HyperVBrokerClient,BrokerAction} from '../server/platform/windows/broker.ts';
import {openProtectedBackupRead,protectedBackupReadSchema,type WindowsBackupReleaseIssue} from '../server/platform/windows/backup-reader.ts';
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

for(const mode of ['read','stream','seed','cancel-read','cancel-stream','cancel-seed'] as const)test('A primary '+mode+' failure survives a second release failure and a throwing observer until explicit release retry',async()=>{
 const f=fixture(),call=f.client.call.bind(f.client),controller=new AbortController(),operation=mode.replace('cancel-','') as 'read'|'stream'|'seed',cancel=mode.startsWith('cancel-'),cause={operation:mode},primary=Object.assign(new Error('Synthetic original '+mode+' failure',{cause}),{code:cancel?'CANCELLED':'SYNTHETIC_'+operation.toUpperCase()+'_FAILED'}),releaseError=Object.assign(new Error('Synthetic secondary lease release failure',{cause:{release:'secondary'}}),{code:'SYNTHETIC_LEASE_RELEASE_FAILED'}),observerError=new Error('Synthetic observer failure'),issues:WindowsBackupReleaseIssue[]=[];
 primary.name=cancel?'AbortError':'SyntheticProtectedReadError';releaseError.name='SyntheticLeaseReleaseError';let closeCalls=0,operationCalls=0,yielded=0;
 const seed=Buffer.alloc(49152,72);Object.assign(f.info,{seed:{bytes:seed.length,sha256:createHash('sha256').update(seed).digest('hex')}});
 f.client.call=async(action,args={},options)=>{
  if(action==='backup-close'){closeCalls++;assert.equal(args.id,id);assert.equal(args.session,session);if(closeCalls===1)throw releaseError;return call(action,args,options);}
  if(action===({read:'backup-read',stream:'backup-stream',seed:'backup-seed'} as const)[operation]){
   operationCalls++;if(!cancel)throw primary;controller.abort(primary);
   if(operation==='stream')return {pipeName:'MuCodeSandbox-Backup-'+randomUUID().replaceAll('-','')};
   if(operation==='seed')return {data:seed.subarray(0,32768).toString('base64'),nextOffset:32768,done:false};
  }
  return call(action,args,options);
 };
 const reader=await openProtectedBackupRead(f.client,id,{signal:controller.signal,onReleaseIssue:issue=>{issues.push({...issue});throw observerError;}});
 let observed:unknown;try{if(operation==='seed')await reader.readSeed();else for await(const _ of reader[operation]())yielded++;}catch(error){observed=error;}
 assert.equal(observed,primary);assert.equal((observed as Error).name,cancel?'AbortError':'SyntheticProtectedReadError');assert.equal((observed as {code:string}).code,cancel?'CANCELLED':'SYNTHETIC_'+operation.toUpperCase()+'_FAILED');assert.equal((observed as Error).cause,cause);assert.equal(yielded,0);assert.equal(operationCalls,1);assert.equal(closeCalls,1);assert.equal(controller.signal.aborted,cancel);
 assert.deepEqual(issues.map(issue=>[issue.environmentId,issue.pending]),[[id,true]]);assert.match(issues[0].message,/释放尚未确认/);assert.equal(issues[0].message.includes(releaseError.message),false);
 await assert.rejects(async()=>{for await(const _ of reader.read()){}},{code:'BACKUP_EXPIRED'});await assert.rejects(async()=>{for await(const _ of reader.stream()){}},{code:'BACKUP_EXPIRED'});assert.equal(closeCalls,1);
 await reader.close();assert.equal(closeCalls,2);assert.deepEqual(issues.map(issue=>[issue.environmentId,issue.pending]),[[id,true],[id,false]]);assert.match(issues[1].message,/确认释放/);await reader.close();assert.equal(closeCalls,2);assert.equal(issues.length,2);
});

test('A standalone close preserves its own release failure despite a throwing observer and confirms an explicit retry',async()=>{
 const f=fixture(),call=f.client.call.bind(f.client),cause={release:'standalone'},primary=Object.assign(new Error('Synthetic standalone release failure',{cause}),{code:'SYNTHETIC_STANDALONE_RELEASE_FAILED'}),issues:WindowsBackupReleaseIssue[]=[];primary.name='SyntheticStandaloneReleaseError';let attempts=0;
 f.client.call=async(action,args={},options)=>{if(action==='backup-close'&&++attempts===1)throw primary;return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id,{onReleaseIssue:issue=>{issues.push({...issue});throw Error('Synthetic standalone observer failure');}});
 let observed:unknown;try{await reader.close();}catch(error){observed=error;}
 assert.equal(observed,primary);assert.equal(primary.name,'SyntheticStandaloneReleaseError');assert.equal(primary.code,'SYNTHETIC_STANDALONE_RELEASE_FAILED');assert.equal(primary.cause,cause);assert.deepEqual(issues.map(issue=>issue.pending),[true]);
 await reader.close();assert.equal(attempts,2);assert.deepEqual(issues.map(issue=>[issue.environmentId,issue.pending]),[[id,true],[id,false]]);
});

for(const malformed of ['schema','identity'] as const)test('A malformed '+malformed+' receipt reports failed valid-lease cleanup without replacing its metadata rejection',async()=>{
 const f=fixture(),call=f.client.call.bind(f.client),secondary=Object.assign(new Error('Synthetic rejected-lease close failure',{cause:{close:'rejected-metadata'}}),{code:'SYNTHETIC_REJECTED_LEASE_RELEASE'}),issues:WindowsBackupReleaseIssue[]=[];let attempts=0;
 if(malformed==='schema')f.info.bytes=0;else f.info.id=randomUUID();
 const expected=protectedBackupReadSchema.safeParse(f.info);
 f.client.call=async(action,args={},options)=>{if(action==='backup-close'){attempts++;assert.equal(args.id,id);assert.equal(args.session,session);throw secondary;}return call(action,args,options);};
 let observed:unknown;try{await openProtectedBackupRead(f.client,id,{onReleaseIssue:issue=>{issues.push({...issue});throw Error('Synthetic rejected-lease observer failure');}});}catch(error){observed=error;}
 assert.notEqual(observed,secondary);assert.equal(attempts,1);assert.deepEqual(issues.map(issue=>[issue.environmentId,issue.pending]),[[id,true]]);assert.match(issues[0].message,/释放尚未确认/);assert.equal(issues[0].message.includes(secondary.message),false);
 if(malformed==='schema'){assert.equal(expected.success,false);assert.ok(observed instanceof z.ZodError);assert.equal(observed.name,'ZodError');assert.deepEqual(observed.issues,expected.error!.issues);assert.equal('code' in observed?observed.code:undefined,undefined);assert.equal(observed.cause,undefined);}
 else{assert.equal(expected.success,true);assert.ok(observed instanceof Error);assert.equal((observed as Error&{code:string}).code,'BACKUP_IDENTITY_CHANGED');assert.equal(observed.message,'备份对象身份不一致');assert.equal(observed.cause,undefined);}
 assert.deepEqual(f.actions.map(value=>value.action),['backup-begin']);
});

test('An unconfirmed native close remains retryable while all read entry points stay closed',async()=>{
 for(const invalidReply of [false,true]){
  const f=fixture(),call=f.client.call.bind(f.client);let attempts=0;
  f.client.call=async(action,args,options)=>{if(action==='backup-close'&&++attempts===1){if(invalidReply)return {closed:false};throw Error('Synthetic lost close connection');}return call(action,args,options);};
  const reader=await openProtectedBackupRead(f.client,id);
  await assert.rejects(reader.close());
  await assert.rejects(async()=>{for await(const _ of reader.read()){}},{code:'BACKUP_EXPIRED'});
  await assert.rejects(async()=>{for await(const _ of reader.stream()){}},{code:'BACKUP_EXPIRED'});
  await reader.close();assert.equal(attempts,2);await reader.close();assert.equal(attempts,2);
 }
});

test('Concurrent native close callers await one confirmed release instead of returning early',async()=>{
 const f=fixture(),call=f.client.call.bind(f.client);let release!:()=>void,started!:()=>void;
 const entered=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);let calls=0,finished=0;
 f.client.call=async(action,args,options)=>{if(action==='backup-close'){calls++;started();await gate;}return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id),first=reader.close().then(()=>finished++);
 await entered;const second=reader.close().then(()=>finished++);await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(finished,0);assert.equal(calls,1);}finally{release();await Promise.all([first,second]);}
 assert.equal(finished,2);assert.equal(calls,1);
});

test('A disk reply arriving after cancellation or explicit close never yields bytes or requests another offset',async()=>{
 for(const cancel of [false,true]){
  const f=fixture(),abort=new AbortController(),call=f.client.call.bind(f.client);let release!:()=>void,started!:()=>void;
  const entered=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
  f.client.call=async(action,args,options)=>{if(action==='backup-read'){started();await gate;}return call(action,args,options);};
  const reader=await openProtectedBackupRead(f.client,id,{signal:abort.signal});let yielded=0;
  const consumed=(async()=>{for await(const _ of reader.read())yielded++;})();const result=consumed.catch(error=>error);
  await entered;if(cancel)abort.abort();else await reader.close();release();const error=await result;
  assert.ok(error instanceof Error);assert.equal(cancel?error.name:(error as {code?:string}).code,cancel?'AbortError':'BACKUP_EXPIRED');
  assert.equal(yielded,0);assert.equal(f.actions.filter(value=>value.action==='backup-read').length,1);
 }
});

test('An original seed reply arriving after explicit close cannot publish identity material',async()=>{
 const f=fixture(),seed=Buffer.alloc(49152,72);Object.assign(f.info,{seed:{bytes:seed.length,sha256:createHash('sha256').update(seed).digest('hex')}});
 const call=f.client.call.bind(f.client);let release!:()=>void,started!:()=>void,reads=0;
 const entered=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
 f.client.call=async(action,args={},options)=>{if(action==='backup-seed'){reads++;started();await gate;const offset=Number(args.offset),end=Math.min(offset+32768,seed.length);return {data:seed.subarray(offset,end).toString('base64'),nextOffset:end,done:end===seed.length};}return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id),result=reader.readSeed().catch(error=>error);
 await entered;await reader.close();release();const error=await result;if(Buffer.isBuffer(error))error.fill(0);
 assert.ok(error instanceof Error);assert.equal((error as {code?:string}).code,'BACKUP_EXPIRED');assert.equal(reads,1);
});

test('A binary pipe receipt arriving after local close cannot open a replacement transport',async()=>{
 const f=fixture(),call=f.client.call.bind(f.client);let release!:()=>void,started!:()=>void;
 const entered=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
 f.client.call=async(action,args,options)=>{if(action==='backup-stream'){started();await gate;return {pipeName:'MuCodeSandbox-Backup-'+randomUUID().replaceAll('-','')};}return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id);let yielded=0;
 const result=(async()=>{for await(const _ of reader.stream())yielded++;})().catch(error=>error);
 await entered;await reader.close();release();assert.equal((await result as {code:string}).code,'BACKUP_EXPIRED');assert.equal(yielded,0);
 assert.equal(f.actions.filter(value=>value.action==='backup-close').length,1);
});

test('Closing an idle Windows binary pipe revokes local delivery before native release acknowledges',{skip:process.platform!=='win32'},async()=>{
 const f=fixture(),call=f.client.call.bind(f.client),pipeName='MuCodeSandbox-Backup-'+randomUUID().replaceAll('-','');
 let peer:import('node:net').Socket|undefined,release!:()=>void,greeted!:()=>void,closeCalls=0,yielded=0;
 const greeting=new Promise<void>(resolve=>greeted=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const server=createServer(socket=>{peer=socket;socket.on('error',()=>{});socket.once('data',()=>greeted());});
 await new Promise<void>(resolve=>server.listen('\\\\.\\pipe\\'+pipeName,resolve));
 f.client.call=async(action,args,options)=>{if(action==='backup-stream')return {pipeName};if(action==='backup-close'){closeCalls++;await gate;}return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id),result=(async()=>{for await(const _ of reader.stream())yielded++;})().catch(error=>error);
 let closing:Promise<void>|undefined;
 try{
  await greeting;closing=reader.close();
  await new Promise<void>((resolve,reject)=>{if(peer!.destroyed){resolve();return;}const timeout=setTimeout(()=>reject(Error('Local pipe remained live while native release was pending')),2000);peer!.once('close',()=>{clearTimeout(timeout);resolve();});});
  assert.equal(yielded,0);assert.equal(closeCalls,1);release();await closing;
  assert.equal((await result as {code:string}).code,'BACKUP_EXPIRED');assert.equal(closeCalls,1);
 }finally{release();peer?.destroy();await closing?.catch(()=>{});await result;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('Protected seed reads verify every offset and the final digest without consuming or releasing the disk cursor',async()=>{
 const f=fixture(),seed=Buffer.alloc(49152,72);Object.assign(f.info,{seed:{bytes:seed.length,sha256:createHash('sha256').update(seed).digest('hex')}});const call=f.client.call.bind(f.client);
 f.client.call=async(action,args={},options)=>{if(action==='backup-seed'){const offset=Number(args.offset),end=Math.min(offset+32768,seed.length);return {data:seed.subarray(offset,end).toString('base64'),nextOffset:end,done:end===seed.length};}return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id),result=await reader.readSeed();assert.deepEqual(result,seed);result.fill(0);assert.equal(f.actions.some(value=>value.action==='backup-close'),false);await assert.rejects(reader.readSeed(),{code:'BACKUP_SEED_UNAVAILABLE'});let count=0;for await(const bytes of reader.read())count+=bytes.length;assert.equal(count,f.data.length);assert.equal(f.actions.at(-1)?.action,'backup-close');
});
test('An altered protected seed closes its read lease and cannot become archive identity',async()=>{
 const f=fixture(),seed=Buffer.alloc(49152,72);Object.assign(f.info,{seed:{bytes:seed.length,sha256:'0'.repeat(64)}});const call=f.client.call.bind(f.client);
 f.client.call=async(action,args={},options)=>{if(action==='backup-seed'){const offset=Number(args.offset),end=Math.min(offset+32768,seed.length);return {data:seed.subarray(offset,end).toString('base64'),nextOffset:end,done:end===seed.length};}return call(action,args,options);};
 const reader=await openProtectedBackupRead(f.client,id);await assert.rejects(reader.readSeed(),{code:'BACKUP_STREAM_INVALID'});assert.equal(f.actions.at(-1)?.action,'backup-close');
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
