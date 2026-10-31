import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {mkdtemp,mkdir,writeFile,symlink,link,rm,realpath,utimes} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {FILE_EXCHANGE_PYTHON,GuestExchange,transferPath} from '../server/guest-exchange.ts';import {LimaRuntime} from '../server/runtime.ts';import {environmentSchema} from '../server/validation.ts';import type {Environment} from '../shared/types.ts';

test('Directory navigation is anchored; pagination and revision downloads preserve the chosen file',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-dir-'))),home=path.join(root,'dev');await mkdir(home);
 const code=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home),run=(input:object,preamble='')=>JSON.parse(execFileSync('python3',['-c',preamble+code],{input:JSON.stringify(input),stdio:['pipe','pipe','pipe']}).toString());
 try{
  run({action:'list'});const downloads=path.join(home,'Downloads'),folder=path.join(downloads,'中文 文件夹');await mkdir(folder);await mkdir(path.join(folder,'nested'));
  await writeFile(path.join(downloads,'old.txt'),'old');await utimes(path.join(downloads,'old.txt'),1700000000,1700000000);
  await writeFile(path.join(downloads,'download.crdownload'),'partial');await writeFile(path.join(downloads,'.private'),'hidden');
  const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret'),'secret');await symlink(outside,path.join(downloads,'escape'));await symlink(outside,path.join(folder,'escape'));await link(path.join(outside,'secret'),path.join(folder,'hardlink'));execFileSync('mkfifo',[path.join(folder,'fifo')]);
  let page=run({action:'browse',zone:'downloads',path:''});assert.deepEqual(page.files.map((f:any)=>f.name),['中文 文件夹','old.txt']);assert.equal(page.files[0].kind,'directory');assert.equal(page.files[0].relativePath,'中文 文件夹');
  for(let i=0;i<55;i++){const file=path.join(folder,`entry-${i}.txt`);await writeFile(file,'sample');await utimes(file,1700000000,1700000000);}
  const seen=new Set<string>();let cursor=null;do{page=run({action:'browse',zone:'downloads',path:'中文 文件夹',cursor});assert.equal(page.total,56);for(const entry of page.files){assert.ok(!seen.has(entry.name));seen.add(entry.name);}cursor=page.nextCursor?JSON.parse(page.nextCursor):null;}while(cursor);assert.equal(seen.size,56);
  page=run({action:'browse',zone:'downloads',path:'中文 文件夹'});const file=page.files.find((f:any)=>f.kind==='file');assert.ok(file);assert.equal(Buffer.from(run({action:'download',zone:'downloads',path:'中文 文件夹',name:file.name,revision:file.revision}).data,'base64').toString(),'sample');
  await writeFile(path.join(folder,file.name),'new content');assert.throws(()=>run({action:'download',zone:'downloads',path:'中文 文件夹',name:file.name,revision:file.revision}),/MU_TRANSFER_FILE_CHANGED/);
  // A concurrent write to the opened inode is also rejected after reading.
  const updated=run({action:'browse',zone:'downloads',path:'中文 文件夹'}).files.find((f:any)=>f.name===file.name);
  const mutation=`import os\noriginal=os.fstat\ncount=0\ndef modified(fd):\n global count\n st=original(fd)\n if __import__('stat').S_ISREG(st.st_mode):\n  count+=1\n  if count==2:\n   with open(${JSON.stringify(path.join(folder,file.name))},'a') as f:f.write('changed')\n   st=original(fd)\n return st\nos.fstat=modified\n`;
  assert.throws(()=>run({action:'download',zone:'downloads',path:'中文 文件夹',name:file.name,revision:updated.revision},mutation),/MU_TRANSFER_FILE_CHANGED/);
  for(const rel of ['../outside','/etc','a//b','.','中文 文件夹/../escape','escape','中文 文件夹/escape'])assert.throws(()=>run({action:'browse',zone:'downloads',path:rel}));
  for(const name of ['hardlink','fifo'])assert.throws(()=>run({action:'download',zone:'downloads',path:'中文 文件夹',name}));
  assert.throws(()=>run({action:'browse',zone:'incoming',path:'',cursor:JSON.parse(page.nextCursor)}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Directory API validates path, cursor scope and revision before guest calls; access still checked twice',async()=>{
 const e={...environmentSchema.parse({name:'fixture'}),id:'fixture',instanceName:'fixture',state:'running',updatedAt:'initial'} as Environment;const runtime=new LimaRuntime('/tmp/mu-dir-unused');let calls=0,allowed=true;
 runtime.guest=async()=>{calls++;return '{"files":[],"total":0,"nextCursor":null}';};const exchange=new GuestExchange(runtime,async()=>{if(!allowed)throw Error('revoked');return e;});
 for(const value of ['../a','/a','a//b','a/..','a\\b','a\0b','a/'.repeat(17)])assert.equal(transferPath.safeParse(value).success,false);
 assert.equal(transferPath.parse('工作/文档'),'工作/文档');
 for(const cursor of ['{}','["incoming","",0,"1","a"]','["downloads","elsewhere",0,"1","a"]','["downloads","",0,"1","../a"]'])assert.throws(()=>exchange.listDirectory(e.id,'downloads','',cursor));
 assert.throws(()=>exchange.download(e.id,'downloads','a','../bad'));assert.throws(()=>exchange.download(e.id,'downloads','a','','invalid'));assert.equal(calls,0);
 allowed=false;await assert.rejects(exchange.listDirectory(e.id,'downloads'),/revoked/);assert.equal(calls,0);
 allowed=true;runtime.guest=async()=>{calls++;allowed=false;return '{"files":[],"total":0,"nextCursor":null}';};await assert.rejects(exchange.listDirectory(e.id,'downloads'),/revoked/);assert.equal(calls,1);
 allowed=true;runtime.guest=async()=>{throw Error('MU_TRANSFER_FILE_CHANGED');};await assert.rejects(exchange.download(e.id,'downloads','a','','a'.repeat(64)),{code:'TRANSFER_FILE_CHANGED'});
});
test('Cancelling a directory listing aborts its guest request and releases the exchange lock',async()=>{
 const e={...environmentSchema.parse({name:'fixture'}),id:'fixture',instanceName:'fixture',state:'running',updatedAt:'initial'} as Environment;
 const runtime=new LimaRuntime('/tmp/mu-dir-unused'),controller=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 runtime.guest=async(_e,_command,options)=>{assert.equal(options?.signal,controller.signal);entered();return await new Promise<string>((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true}));};
 const exchange=new GuestExchange(runtime,async()=>e),pending=exchange.listDirectory(e.id,'downloads','',undefined,controller.signal);await started;assert.equal(exchange.busy.has(e.id),true);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(exchange.busy.has(e.id),false);
 runtime.guest=async()=>'{"files":[],"total":0,"nextCursor":null}';assert.deepEqual(await exchange.listDirectory(e.id,'downloads'),{files:[],total:0,nextCursor:null});
});
