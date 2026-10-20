import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,symlink,link,rm,realpath,readdir,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FILE_EXCHANGE_PYTHON,GuestExchange,transferName,clipboardText} from '../server/guest-exchange.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {environmentSchema} from '../server/validation.ts';
import {createService} from '../server/service.ts';
import {AppError} from '../server/errors.ts';
import type {Environment} from '../shared/types.ts';
const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
function env():Environment{return {...environmentSchema.parse({name:'Transfer fixture'}),id:randomUUID(),instanceName:'mu-exchange-test',state:'running',browserRunning:false,lastError:null,createdAt:'fixture',updatedAt:'fixture'};}

test('Transfer rejects paths, control characters and oversized UTF8 text',()=>{
 for(const n of ['../token','/etc/passwd','a\\b','..','nul\0','line\n'])assert.throws(()=>transferName.parse(n));
 assert.equal(transferName.parse('测试资料.txt'),'测试资料.txt');assert.throws(()=>clipboardText.parse('🙂'.repeat(18000)));assert.throws(()=>clipboardText.parse('x\0y'));
});
test('Actual Python transfer roundtrip preserves bytes, avoids overwrite and excludes escaping or special files',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-exchange-')));const home=path.join(root,'guest');await mkdir(home);
 const code=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home);
 const execute=(input:object)=>JSON.parse(execFileSync('python3',['-c',code],{input:JSON.stringify(input),stdio:['pipe','pipe','pipe']}).toString());
 try{
  const body=Buffer.from([0,1,255,0,65]);const first=execute({action:'upload',name:'演示.bin',data:body.toString('base64')});
  const second=execute({action:'upload',name:'演示.bin',data:Buffer.from('different').toString('base64')});assert.notEqual(first.name,second.name);assert.deepEqual(await readFile(first.path),body);
  const returned=execute({action:'download',zone:'incoming',name:first.name});assert.deepEqual(Buffer.from(returned.data,'base64'),body);
  for(const filename of ['a'.repeat(176)+'.txt','文'.repeat(58)+'ab.txt','a.'+'z'.repeat(178)]){
   const names=new Set<string>();
   for(let i=0;i<12;i++){
    const saved=execute({action:'upload',name:filename,data:body.toString('base64')});
    assert.equal(transferName.parse(saved.name),saved.name);assert.ok(!names.has(saved.name));names.add(saved.name);
    if(filename.endsWith('.txt'))assert.ok(saved.name.endsWith('.txt'));
    assert.deepEqual(Buffer.from(execute({action:'download',zone:'incoming',name:saved.name}).data,'base64'),body);
   }
   const listed=new Set(execute({action:'list'}).map((f:any)=>f.name));assert.ok([...names].every(n=>listed.has(n)));
  }
  const outside=path.join(root,'outside');await writeFile(outside,'MU_FAKE_PRIVATE_MARKER');
  const outgoing=path.join(home,'Transfers/Outgoing');execute({action:'list'});
  await symlink(outside,path.join(outgoing,'symlink'));await link(outside,path.join(outgoing,'hardlink'));execFileSync('mkfifo',[path.join(outgoing,'fifo')]);
  for(const name of ['symlink','hardlink','fifo','../../outside'])assert.throws(()=>execute({action:'download',zone:'outgoing',name}));
  assert.ok(execute({action:'list'}).every((f:any)=>!['symlink','hardlink','fifo'].includes(f.name)));assert.equal(await readFile(outside,'utf8'),'MU_FAKE_PRIVATE_MARKER');
  await rm(outgoing,{recursive:true});await symlink(root,outgoing);assert.throws(()=>execute({action:'download',zone:'outgoing',name:'outside'}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Interrupted uploads never publish incomplete filenames or overwrite existing files',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-exchange-interrupted-'))),home=path.join(root,'guest');await mkdir(home);
 const code=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home),incoming=path.join(home,'Transfers/Incoming');
 const execute=(input:object,preamble='')=>JSON.parse(execFileSync('python3',['-c',preamble+code],{input:JSON.stringify(input),stdio:['pipe','pipe','pipe']}).toString());
 const upload={action:'upload',name:'报告.txt',data:Buffer.from('MU_COMPLETE_FILE').toString('base64')};
 try{
  execute(upload);
  // A real write/flush failure must not leave a visible duplicate or stale temp.
  assert.throws(()=>execute(upload,"import os\ndef failed_sync(fd):\n raise OSError('fixture disk failure')\nos.fsync=failed_sync\n"));
  assert.deepEqual((await readdir(incoming)).sort(),['.mucodesandbox-upload-staging','报告.txt']);
  assert.deepEqual(await readdir(path.join(incoming,'.mucodesandbox-upload-staging')),[]);
  // Simulate process death before publication: finally cannot run.
  assert.throws(()=>execute(upload,'import os\nos.fsync=lambda fd: os._exit(91)\n'));
  assert.equal((await readdir(path.join(incoming,'.mucodesandbox-upload-staging'))).length,1);
  assert.deepEqual(execute({action:'list'}).map((f:any)=>f.name),['报告.txt']);
  const retry=execute(upload);assert.equal(retry.name,'1-报告.txt');
  assert.equal(await readFile(path.join(incoming,'报告.txt'),'utf8'),'MU_COMPLETE_FILE');
  assert.equal(await readFile(retry.path,'utf8'),'MU_COMPLETE_FILE');
  assert.equal(execute({action:'list'}).length,2);
  // A redirected staging directory must not be followed or written to.
  await rm(path.join(incoming,'.mucodesandbox-upload-staging'),{recursive:true});
  const outside=path.join(root,'outside');await mkdir(outside);await symlink(outside,path.join(incoming,'.mucodesandbox-upload-staging'));
  assert.throws(()=>execute(upload));assert.deepEqual(await readdir(outside),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Transfer never runs with revoked guard and rechecks access before delivering data',async()=>{
 const e=env(),runtime=new LimaRuntime('/tmp/mu-exchange-unused');let calls=0,allowed=false;
 runtime.guest=async()=>{calls++;return '[]';};
 const exchange=new GuestExchange(runtime,async()=>{if(!allowed)throw new AppError('revoked',409);return e;});
 await assert.rejects(exchange.list(e.id));assert.equal(calls,0);
 allowed=true;runtime.guest=async()=>{calls++;allowed=false;return '[]';};await assert.rejects(exchange.list(e.id),/revoked/);assert.equal(calls,1);
});
test('Paged file listing includes later names and all folders without dropping tied timestamps',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-exchange-pages-'))),home=path.join(root,'guest');await mkdir(home);
 const code=FILE_EXCHANGE_PYTHON.replaceAll('/home/dev',home);
 const execute=(input:object)=>JSON.parse(execFileSync('python3',['-c',code],{input:JSON.stringify(input),stdio:['pipe','pipe','pipe']}).toString());
 try{
  execute({action:'list'});
  const expected=new Set<string>();
  for(const [zone,folder,count] of [['incoming','Transfers/Incoming',505],['outgoing','Transfers/Outgoing',4],['downloads','Downloads',4]] as const){
   await Promise.all(Array.from({length:count},async(_,i)=>{
    const name=`file-${String(i).padStart(4,'0')}.txt`,file=path.join(home,folder,name);
    await writeFile(file,'fixture');await utimes(file,1700000000,1700000000);expected.add(`${zone}/${name}`);
   }));
  }
  const newest='最新 文件.txt';await writeFile(path.join(home,'Transfers/Incoming',newest),'newest');expected.add(`incoming/${newest}`);
  await symlink('/etc/passwd',path.join(home,'Downloads','not-a-transfer'));
  assert.equal(execute({action:'list'})[0].name,newest);
  const seen=new Set<string>();let cursor=null,pages=0;
  do{
   const result=execute({action:'list',paged:true,cursor});pages++;
   assert.equal(result.total,expected.size);assert.ok(result.files.length<=50);
   for(const f of result.files){const key=`${f.zone}/${f.name}`;assert.ok(!seen.has(key));seen.add(key);}
   cursor=result.nextCursor?JSON.parse(result.nextCursor):null;
   assert.ok(pages<20);
  }while(cursor);
  assert.deepEqual(seen,expected);assert.equal(pages,11);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Malformed pagination positions are rejected before a guest operation',async()=>{
 const e=env(),runtime=new LimaRuntime('/tmp/mu-exchange-unused');let calls=0;
 runtime.guest=async()=>{calls++;return '{}';};
 const exchange=new GuestExchange(runtime,async()=>e);
 for(const cursor of ['{}','not-json','["123","incoming","../secret"]','["NaN","incoming","a"]','["1","outside","a"]','x'.repeat(1025)]){
  assert.throws(()=>exchange.listPage(e.id,cursor),{code:'INVALID_TRANSFER_CURSOR'});
 }
 assert.equal(calls,0);
});
test('File exchange sends the program and payload through stdin with a short SSH command',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-exchange-stdin-'))),home=path.join(root,'guest');await mkdir(home);
 const e=env(),runtime=new LimaRuntime('/tmp/mu-exchange-unused');
 runtime.guest=async(_e,args,options)=>{
  assert.equal(args[0],'python3');assert.ok(args.join(' ').length<160);assert.equal(options?.onOutput,undefined);
  let input:Buffer|string;
  if(options?.inputBytes){const bytes=Buffer.from(options.inputBytes),line=bytes.indexOf(10);assert.ok(line>0);const program=JSON.parse(bytes.subarray(0,line).toString());assert.equal(program,FILE_EXCHANGE_PYTHON);input=Buffer.concat([Buffer.from(JSON.stringify(program.replaceAll('/home/dev',home))+'\n'),bytes.subarray(line+1)]);}
  else {assert.ok(options?.input?.startsWith(JSON.stringify(FILE_EXCHANGE_PYTHON)+'\n'));input=options!.input!.replaceAll('/home/dev',home);}
  return execFileSync('python3',args.slice(1),{input,stdio:['pipe','pipe','pipe']}).toString();
 };
 const exchange=new GuestExchange(runtime,async()=>e),body=Buffer.from('中文\n\0binary');
 try{
  const saved=await exchange.upload(e.id,'中文 $literal.txt',body);
  assert.ok((await exchange.list(e.id)).some(f=>f.name===saved.name));
  assert.deepEqual(await exchange.download(e.id,'downloads',saved.name),body);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Guest clipboard does not poll or read the host clipboard and uses the same manual guard',async()=>{
 const e=env(),runtime=new LimaRuntime('/tmp/mu-exchange-unused');const calls:any[]=[];
 runtime.management=async(_e,args,options)=>{calls.push({args,input:options?.input,onOutput:options?.onOutput});return JSON.stringify({text:'MU_FAKE_TEXT'});};
 const exchange=new GuestExchange(runtime,async()=>e);assert.equal(calls.length,0);
 await exchange.writeClipboard(e.id,'MU_FAKE_TEXT');const scripts=calls.map(c=>c.input??c.args.join(' ')).join('\n');
 assert.ok(scripts.includes('BindsTo=mucodesandbox-display.service'));assert.ok(scripts.includes('User=dev'));assert.ok(scripts.includes('ExecStopPost=/usr/bin/rm'));assert.ok(calls.every(c=>c.onOutput===undefined));
 assert.equal((await exchange.readClipboard(e.id)).text,'MU_FAKE_TEXT');
});
test('Exchange API requires authentication and a running protected environment before reading or uploading',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-exchange-api-'));
 const service=await createService({dataDir:root,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});const e=env();e.state='stopped';service.manager.store.save(e);
 try{const base=service.url+'/api/environments/'+e.id,headers={Authorization:'Bearer '+service.token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/transfer-files')).status,401);
  assert.equal((await fetch(base+'/transfer-files',{headers})).status,409);
  assert.equal((await fetch(base+'/clipboard/read',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(base+'/clipboard/write',{method:'POST',headers,body:'{"text":"fixture"}'})).status,409);
  assert.equal((await fetch(base+'/transfer-download',{method:'POST',headers,body:'{"zone":"outgoing","name":"../token"}'})).status,400);
  assert.equal((await fetch(base+'/transfer-files?name=a',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/octet-stream'},body:'fixture'})).status,409);
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
