import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,symlink,link,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {FILE_EXCHANGE_PYTHON,GuestExchange} from '../server/guest-exchange.ts';import {TRANSFER_MAX_BYTES} from '../shared/guest-exchange.ts';import {environmentSchema} from '../server/validation.ts';import {LimaRuntime} from '../server/runtime.ts';import type {Environment} from '../shared/types.ts';import {AppError} from '../server/errors.ts';import {createService} from '../server/service.ts';
const fixture=():Environment=>({...environmentSchema.parse({name:'Large transfer fixture'}),id:randomUUID(),instanceName:'fixture',state:'running',browserRunning:false,lastError:null,createdAt:'fixture',updatedAt:'fixture'});
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

test('Raw binary upload accepts 39 and exactly 150 MiB, lands in Downloads and keeps byte identity',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-large-'))),home=path.join(root,'guest');await mkdir(home);const program=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home);
 try{assert.equal(TRANSFER_MAX_BYTES,150*1024*1024);
  for(const mib of [39,150]){const bytes=Buffer.alloc(mib*1024*1024,0xa7);const header=Buffer.from(JSON.stringify({action:'upload-binary',name:`sample-${mib}.bin`,bytes:bytes.length})+'\n');const saved=JSON.parse(execFileSync('python3',['-c',program],{input:Buffer.concat([header,bytes]),maxBuffer:10000}).toString());assert.equal(saved.zone,'downloads');assert.equal(saved.bytes,bytes.length);assert.equal(digest(await readFile(saved.path)),digest(bytes));}
  const listing=JSON.parse(execFileSync('python3',['-c',program],{input:JSON.stringify({action:'browse',zone:'downloads'})}).toString());assert.equal(listing.files.length,2);assert.ok(listing.files.some((v:any)=>v.bytes===TRANSFER_MAX_BYTES));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Truncated, extra and oversized raw uploads never publish an incomplete visible file',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-large-fault-'))),home=path.join(root,'guest');await mkdir(home);const program=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home);
 try{for(const [size,body] of [[8,Buffer.from('short')],[2,Buffer.from('extra')],[TRANSFER_MAX_BYTES+1,Buffer.alloc(0)]] as const){assert.throws(()=>execFileSync('python3',['-c',program],{input:Buffer.concat([Buffer.from(JSON.stringify({action:'upload-binary',name:'partial.bin',bytes:size})+'\n'),body]),stdio:['pipe','pipe','pipe']}));}
  const listed=JSON.parse(execFileSync('python3',['-c',program],{input:JSON.stringify({action:'list'})}).toString());assert.deepEqual(listed,[]);const staging=path.join(home,'Downloads/.mucodesandbox-upload-staging');assert.deepEqual(await readdir(staging),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Move to Downloads is atomic, does not overwrite, and rejects stale revisions, links and traversal',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-move-'))),home=path.join(root,'guest');await mkdir(home);const program=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home),execute=(input:object)=>JSON.parse(execFileSync('python3',['-c',program],{input:JSON.stringify(input),stdio:['pipe','pipe','pipe']}).toString());
 try{const data=Buffer.from('original file bytes');const source=execute({action:'upload',name:'资料.txt',data:data.toString('base64')});execute({action:'upload',zone:'downloads',name:'资料.txt',data:Buffer.from('keep existing').toString('base64')});const row=execute({action:'browse',zone:'incoming'}).files[0];
  assert.throws(()=>execute({action:'move',zone:'incoming',name:source.name,revision:'0'.repeat(64)}));assert.deepEqual(await readFile(source.path),data);
  const saved=execute({action:'move',zone:'incoming',name:source.name,revision:row.revision});assert.equal(saved.name,'1-资料.txt');assert.equal(saved.zone,'downloads');assert.deepEqual(await readFile(saved.path),data);await assert.rejects(readFile(source.path));assert.equal(await readFile(path.join(home,'Downloads/资料.txt'),'utf8'),'keep existing');
  const outside=path.join(root,'private');await writeFile(outside,'keep');await symlink(outside,path.join(home,'Transfers/Incoming/symlink'));await link(outside,path.join(home,'Transfers/Incoming/hardlink'));for(const name of ['symlink','hardlink','../private'])assert.throws(()=>execute({action:'move',zone:'incoming',name}));assert.equal(await readFile(outside,'utf8'),'keep');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Binary transfer stays on guarded guest task, observes cancellation and rechecks authorization',async()=>{
 const e=fixture(),runtime=new LimaRuntime('/tmp/mu-no-live-runtime');let allowed=true,calls=0;
 runtime.guest=async(_e,args,options)=>{calls++;assert.equal(args[0],'python3');assert.ok(args.join(' ').length<160);assert.equal(options?.input,undefined);assert.ok(options?.inputBytes);assert.equal(options?.timeoutMs,120000);assert.equal(options?.onOutput,undefined);allowed=false;return JSON.stringify({name:'example.bin',path:'/home/dev/Downloads/example.bin',zone:'downloads',bytes:3});};
 const exchange=new GuestExchange(runtime,async()=>{if(!allowed)throw new AppError('guard revoked',409);return e;});await assert.rejects(exchange.upload(e.id,'example.bin',Buffer.from('abc')),/guard revoked/);assert.equal(calls,1);
 await assert.rejects(exchange.upload(e.id,'blocked.bin',Buffer.from('abc')));assert.equal(calls,1);allowed=true;const signal=AbortSignal.abort();runtime.guest=async(_e,_args,options)=>{assert.equal(options?.signal,signal);options!.signal!.throwIfAborted();return '';};await assert.rejects(exchange.upload(e.id,'cancelled.bin',Buffer.from('abc'),signal));
});
test('Folder opening is restricted to transfer roots or exact preconfigured project IDs',async()=>{
 const e=fixture(),mount={id:randomUUID(),hostPath:'/fixture/shared',guestPath:'/workspace/project',writable:false};e.mounts=[mount];const runtime=new LimaRuntime('/tmp/mu-no-live-runtime'),launches:string[][]=[];
 runtime.guest=async()=>JSON.stringify({path:'/home/dev/Downloads'});runtime.management=async(_e,args,options)=>{if(options?.input)return '{"issues":[]}';if(args.includes('systemd-run'))launches.push(args);return '';};const exchange=new GuestExchange(runtime,async()=>e);
 assert.deepEqual(await exchange.projects(e.id),[{id:mount.id,guestPath:mount.guestPath,writable:false}]);await assert.rejects(exchange.openFolder(e.id,{projectId:randomUUID()}));await assert.rejects(exchange.openFolder(e.id,{zone:'incoming',path:'../../etc'}));assert.equal(launches.length,0);
 await exchange.openFolder(e.id,{zone:'downloads'});await exchange.openFolder(e.id,{projectId:mount.id});assert.equal(launches.length,2);for(const args of launches){assert.ok(args.includes('--property=User=dev'));assert.ok(args.includes('/usr/local/bin/mu-proxy-run'));assert.ok(args.includes('--property=BindsTo=mucodesandbox-display.service'));assert.ok(args.includes('/usr/bin/dbus-run-session'));}assert.equal(launches[1].at(-1),'/workspace/project');assert.equal(e.mounts[0].writable,false);
});
test('New folder/move/project routes require auth, strict schemas and the original guard',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-large-api-'));const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};const service=await createService({dataDir:root,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});const e=fixture();e.state='stopped';service.manager.store.save(e);
 try{const base=service.url+'/api/environments/'+e.id,headers={Authorization:'Bearer '+service.token,'Content-Type':'application/json'};for(const endpoint of ['/transfer-projects','/transfer-folder/open','/transfer-move']){const read=endpoint==='/transfer-projects';assert.equal((await fetch(base+endpoint,{method:read?'GET':'POST',...(read?{}:{headers:{'Content-Type':'application/json'},body:'{}'})})).status,401);}
  assert.equal((await fetch(base+'/transfer-folder/open',{method:'POST',headers,body:'{"zone":"downloads","path":"../../etc"}'})).status,400);assert.equal((await fetch(base+'/transfer-folder/open',{method:'POST',headers,body:'{"zone":"downloads","hostPath":"/Users/private"}'})).status,400);assert.equal((await fetch(base+'/transfer-projects',{headers})).status,409);assert.equal((await fetch(base+'/transfer-move',{method:'POST',headers,body:'{"zone":"incoming","name":"ok.txt"}'})).status,409);assert.equal((await fetch(base+'/transfer-folder/open',{method:'POST',headers,body:'{"zone":"downloads"}'})).status,409);
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
test('HTTP upload limits oversized requests, serializes body readers and releases a disconnected reader',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-body-limit-')),browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};const service=await createService({dataDir:root,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});const e=fixture();service.manager.store.save(e);let guards=0,guestCalls=0;
 service.manager.assertAccess=async()=>{guards++;return undefined;};service.manager.runtime.guest=async()=>{guestCalls++;return JSON.stringify({name:'small.bin',path:'/home/dev/Downloads/small.bin',zone:'downloads',bytes:1});};
 const url=service.url+'/api/environments/'+e.id+'/transfer-files?name=small.bin',headers={Authorization:'Bearer '+service.token,'Content-Type':'application/octet-stream'};let stalled:ReturnType<typeof httpRequest>|undefined;
 try{
  const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:{...headers,'Content-Length':String(TRANSFER_MAX_BYTES+1)}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});assert.equal(status,413);assert.equal(guestCalls,0);
  stalled=httpRequest(url,{method:'POST',headers:{...headers,'Content-Length':'1000000'}});stalled.on('error',()=>{});stalled.write('x');
  const before=guards;for(let i=0;i<20&&guards===before;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await fetch(url,{method:'POST',headers,body:'x'})).status,409);assert.equal(guestCalls,0);stalled.destroy();await new Promise(r=>setTimeout(r,50));
  const result=await fetch(url,{method:'POST',headers,body:'x'});assert.equal(result.status,200);assert.equal((await result.json()).zone,'downloads');assert.equal(guestCalls,1);
 }finally{stalled?.destroy();await service.close();await rm(root,{recursive:true,force:true});}
});
