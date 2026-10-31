// Runs the installed exporter in ordinary processes with private synthetic data.
// The Hyper-V reader is a named-pipe fixture; no real VM is touched.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';

const root=path.resolve(import.meta.dirname,'..'),run=path.join(root,'.mu-data/windows-run');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
async function modules(installed){const load=file=>import(pathToFileURL(path.join(installed,'resources/app/dist-server',file)).href);return Object.assign({},...await Promise.all(['server/platform/windows/credentials.js','server/platform/windows/backup-service.js','server/platform/windows/backup-archive.js','server/platform/windows/config.js','server/platform/windows/guest.js','server/platform/windows/manager.js'].map(load)));}

async function worker(){
 const selected=process.argv[process.argv.indexOf('--case')+1],mode=process.argv[process.argv.indexOf('--mode')+1],c=await json(selected);
 assert.equal(path.dirname(selected),c.directory);assert.equal(c.directory,path.join(c.runRoot,'case-'+c.phase));assert.ok(['hold','finish'].includes(mode));assert.ok(['stream','commit','destination-conflict'].includes(c.phase));
 const api=await modules(c.installed),store=await api.openWindowsStore(c.store),disk=await readFile(c.disk),seed=await readFile(c.seed),servers=[],sockets=[];
 assert.equal(hash(disk),c.diskSha256);assert.equal(hash(seed),c.seedSha256);
 const info={id:c.id,session:randomUUID(),bytes:disk.length,sha256:c.diskSha256,seed:{bytes:seed.length,sha256:c.seedSha256},chunkBytes:32768,platformId:c.syntheticPlatformId,imageSha256:'a'.repeat(64),cpus:1,memoryGiB:2,diskGiB:32,diskIdentifier:c.id,state:'Off'};
 let service,job,paused=false,release;
 const send=value=>new Promise((resolve,reject)=>process.send({...value,pid:process.pid,nonce:c.nonce},error=>error?reject(error):resolve()));
 const pause=async phase=>{
  if(paused)return;paused=true;
  const partials=(await readdir(c.directory)).filter(name=>/^\.mucwin-partial-[a-f0-9-]{36}$/.test(name));assert.equal(partials.length,1);
  const partial=path.join(c.directory,partials[0]),size=(await lstat(partial)).size;assert.ok(size>1024*1024);
  await send({type:'paused',phase,jobId:job.id,phaseStatus:service.snapshot().phase,bytes:service.snapshot().bytes,partial:partials[0],partialBytes:size});
 };
 const broker={call:async(action,args={})=>{
  assert.equal(args.id,c.id);
  if(action==='backup-begin')return info;
  if(action==='backup-seed'){const offset=Number(args.offset),end=Math.min(offset+32768,seed.length);return{data:seed.subarray(offset,end).toString('base64'),nextOffset:end,done:end===seed.length};}
  if(action==='backup-close'){
   if(mode==='hold'&&c.phase==='commit'){await pause('commit');await new Promise(resolve=>release=resolve);}
   return{closed:true};
  }
  if(action==='backup-stream'){
   const pipeName='MuCodeSandbox-Backup-'+randomUUID().replaceAll('-',''),server=createServer(socket=>{
    sockets.push(socket);socket.on('error',()=>{});socket.once('data',request=>{
     assert.deepEqual(request,Buffer.from([46]));
     if(mode==='hold'&&c.phase!=='commit'){
      socket.write(disk.subarray(0,2*1024**2));release=()=>socket.write(disk.subarray(2*1024**2));
      const timer=setInterval(()=>{if(service.snapshot().bytes>1024*1024){clearInterval(timer);void pause(c.phase).catch(error=>{process.stderr.write(error.message);process.exitCode=1;socket.destroy();});}},20);timer.unref();
     }else socket.write(disk);
    });
   });servers.push(server);await new Promise(resolve=>server.listen('\\\\.\\pipe\\'+pipeName,resolve));return{pipeName};
  }
  throw Error('Unexpected fixture broker operation: '+action);
 }};
 const manager=new api.WindowsManager(store,{state:async()=>({state:'Off'}),stop:async()=>{}},{runtimeRoot:c.runtime});service=new api.WindowsBackupService(manager,broker);
 process.on('message',message=>{if(message?.type==='release'&&message.nonce===c.nonce){const next=release;release=undefined;next?.();}});
 try{
  await send({type:'ready'});job=service.export(c.id,c.target,c.password,c.name);await manager.wait(job.id);
  const expected=c.phase==='destination-conflict'&&mode==='hold'?'failed':'succeeded';assert.equal(service.snapshot().phase,expected);
  await send({type:'finished',result:expected,jobId:job.id,status:service.snapshot()});
 }finally{
  service.close();await manager.close();store.key.fill(0);for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));disk.fill(0);seed.fill(0);
 }
}

const workers=[];
function launch(c,mode){
 const child=spawn(c.engine,[import.meta.filename,'--worker','--case',path.join(c.directory,'private-case.json'),'--mode',mode],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}),messages=[],events=new EventEmitter();let terminal=null,stderr='';
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{terminal={code,signal,time:new Date().toISOString()};events.emit('update');resolve(terminal);}));
 child.once('error',error=>{terminal={spawnError:error.code};events.emit('update');});child.on('message',message=>{if(message.nonce===c.nonce&&message.pid===child.pid){messages.push(message);events.emit('update');}});child.stdout.on('data',()=>{});child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-16384));
 const wait=(type,timeout=45000)=>new Promise((resolve,reject)=>{let timer;const finish=(error,value)=>{clearTimeout(timer);events.off('update',scan);error?reject(error):resolve(value);};const scan=()=>{const found=messages.find(message=>message.type===type);if(found)return finish(null,found);if(terminal)finish(Error('Worker exited before '+type));};timer=setTimeout(()=>finish(Error('Worker receipt timed out; inspect original handle')),timeout);events.on('update',scan);scan();});
 const exit=async()=>{let timer;try{return await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Worker exit not confirmed')),15000))]);}finally{clearTimeout(timer);await writeFile(path.join(c.directory,'worker-'+child.pid+'-stderr.txt'),stderr);}};
 const current={child,wait,exit,get terminal(){return terminal;}};workers.push(current);return current;
}

async function prepare(runRoot,phase,delivery,api){
 const directory=path.join(runRoot,'case-'+phase);await mkdir(directory);await api.secureWindowsDirectory(directory);
 const id=randomUUID(),nonce=randomUUID(),runtime=path.join(directory,'runtime'),p=api.windowsPaths(runtime,id);await mkdir(p.directory,{recursive:true});
 const keygen=path.join(process.env.SystemRoot,'System32/OpenSSH/ssh-keygen.exe');for(const file of [p.key,p.hostKey])await promisify(execFile)(keygen,['-q','-t','ed25519','-N','','-f',file],{windowsHide:true,timeout:10000});
 const publicKey=await readFile(p.key+'.pub','utf8'),hostPublic=await readFile(p.hostKey+'.pub','utf8'),seed=Buffer.alloc(49152);Buffer.from('CD001').copy(seed,32769);Buffer.from(publicKey+'\n'+hostPublic).copy(seed,40000);
 const c={runRoot,directory,phase,nonce,id,syntheticPlatformId:randomUUID(),installed:delivery.installed,engine:path.join(delivery.installed,'resources/node/node.exe'),runtime,store:path.join(directory,'store'),name:'导出进程故障验收',target:path.join(directory,'合成加密备份.mucwin'),password:randomBytes(32).toString('base64url'),disk:path.join(directory,'synthetic-source.bin'),seed:path.join(directory,'synthetic-seed.iso')};
 const disk=Buffer.alloc(8*1024**2+113,91);Buffer.from('synthetic-export-process-'+nonce).copy(disk,1000);c.diskSha256=hash(disk);c.diskBytes=disk.length;c.seedSha256=hash(seed);
 await writeFile(c.disk,disk,{flag:'wx'});await writeFile(c.seed,seed,{flag:'wx'});await writeFile(p.knownHosts,api.vmIdentity(id).name+' '+hostPublic.trim()+'\n',{flag:'wx'});await writeFile(p.manifest,JSON.stringify({version:1,id,platformId:c.syntheticPlatformId,imageSha256:'a'.repeat(64),purpose:'environment'}),{flag:'wx'});
 const config=api.windowsConfigSchema.parse({version:1,id,image:path.join(directory,'unused-base.vhdx'),imageSha256:'a'.repeat(64),cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9,username:'synthetic',password:'synthetic-proxy-'+nonce},expectedIp:'203.0.113.90'}),store=await api.openWindowsStore(c.store);
 try{store.save({...api.windowsEnvironment(config),name:c.name,browserUrl:'http://127.0.0.1/',state:'stopped'});}finally{store.close();store.key.fill(0);}
 c.dpapiSha256=await fileHash(path.join(c.store,'credentials.dpapi'));c.identityHashes=Object.fromEntries(await Promise.all([p.key,p.key+'.pub',p.hostKey,p.hostKey+'.pub',p.knownHosts,p.manifest].map(async file=>[path.basename(file),await fileHash(file)])));
 await writeFile(path.join(directory,'private-case.json'),JSON.stringify(c,null,2),{flag:'wx'});disk.fill(0);seed.fill(0);return c;
}

async function main(){
 assert.equal(process.platform,'win32');const delivery=await json(path.join(run,'local-desktop-delivery.json'));assert.equal(delivery.version,'0.4.66-preview.25');assert.equal((await json(path.join(delivery.installed,'resources/app/package.json'))).version,delivery.version);
 for(const [file,digest] of Object.entries(delivery.payloadHashes))assert.equal(await fileHash(path.join(delivery.installed,file)),digest);
 const api=await modules(delivery.installed),runRoot=path.join(root,'.mu-data/windows-runtime','export-process-'+randomUUID());await mkdir(runRoot);await api.secureWindowsDirectory(runRoot);
 const report={time:new Date().toISOString(),version:delivery.version,complete:false,runRoot,scope:'installed exporter, real Windows named pipes/files and ordinary-process termination; synthetic Hyper-V reader and disk',actualHyperVExercised:false,actualDesktopRestoreBootExercised:false,realDiskFullExercised:false,physicalPowerLossExercised:false,cases:[]},output=path.join(run,'backup-export-process-complete.json'),save=()=>writeFile(output,JSON.stringify(report,null,2));await save();
 try{
  for(const phase of ['stream','commit','destination-conflict']){
   const c=await prepare(runRoot,phase,delivery,api),first=launch(c,'hold'),paused=await first.wait('paused');assert.equal(paused.phase,phase);assert.equal(paused.phaseStatus,'running');assert.equal(first.terminal,null);assert.equal(first.child.exitCode,null);await assert.rejects(lstat(c.target),{code:'ENOENT'});
   const journal={phase,id:c.id,oldPid:first.child.pid,liveAtControlledPause:true,paused,complete:false};await writeFile(path.join(c.directory,'process-journal.json'),JSON.stringify(journal,null,2));
   let result;
   if(phase==='destination-conflict'){
    const sentinel='Unrelated destination created during the controlled export: '+c.nonce;await writeFile(c.target,sentinel,{flag:'wx'});first.child.send({type:'release',nonce:c.nonce});const receipt=await first.wait('finished');assert.equal(receipt.result,'failed');assert.equal((await first.exit()).code,0);assert.equal(await readFile(c.target,'utf8'),sentinel);assert.equal((await readdir(c.directory)).filter(name=>name.startsWith('.mucwin-partial-')).length,0);
    result={phase,id:c.id,pid:first.child.pid,destinationCreatedAfterExportStarted:true,originalDestinationPreserved:true,normalFailureRemovedTemporary:true,actualHyperVExercised:false};
   }else{
    const killedAt=new Date().toISOString();assert.equal(first.child.kill('SIGKILL'),true);const termination=await first.exit();assert.notEqual(termination.code,0);await assert.rejects(lstat(c.target),{code:'ENOENT'});
    const partial=path.join(c.directory,paused.partial),partialSha256=await fileHash(partial),partialBytes=(await lstat(partial)).size;assert.ok(partialBytes>1024*1024);const header=await readFile(partial);assert.equal(header.subarray(0,8).toString(),'MUCWIN01');assert.ok(!header.includes(Buffer.from('BEGIN OPENSSH PRIVATE KEY')));assert.ok(!header.includes(Buffer.from('synthetic-proxy-'+c.nonce)));header.fill(0);
    await assert.rejects(api.readWindowsBackupArchive(createReadStream(partial),{write:async()=>{}},c.password),{code:'WINDOWS_BACKUP_INTEGRITY'});
    const second=launch(c,'finish'),receipt=await second.wait('finished');assert.notEqual(second.child.pid,first.child.pid);assert.equal(receipt.result,'succeeded');assert.equal((await second.exit()).code,0);
    const restoredHash=createHash('sha256');let restoredBytes=0;const manifest=await api.readWindowsBackupArchive(createReadStream(c.target),{write:async bytes=>{restoredHash.update(bytes);restoredBytes+=bytes.length;}},c.password);assert.equal(restoredHash.digest('hex'),c.diskSha256);assert.equal(restoredBytes,c.diskBytes);assert.equal(manifest.identity.id,c.id);assert.equal(manifest.config.name,c.name);assert.equal(await fileHash(partial),partialSha256);
    result={phase,id:c.id,oldPid:first.child.pid,newPid:second.child.pid,killedAt,termination,liveAtControlledPause:true,unpublishedAfterTermination:true,partialRejectedAsIncomplete:true,sameOutputPathRetrySucceeded:true,fullArchiveAuthenticated:true,syntheticDiskMatched:true,archiveSha256:await fileHash(c.target),retainedEncryptedPartial:{name:paused.partial,bytes:partialBytes,sha256:partialSha256},actualHyperVExercised:false};
   }
   assert.equal(await fileHash(c.disk),c.diskSha256);assert.equal(await fileHash(c.seed),c.seedSha256);assert.equal(await fileHash(path.join(c.store,'credentials.dpapi')),c.dpapiSha256);const p=api.windowsPaths(c.runtime,c.id);for(const [name,digest] of Object.entries(c.identityHashes))assert.equal(await fileHash(path.join(p.directory,name)),digest);
   result.sourceFilesAndDpapiUnchanged=true;report.cases.push(result);await writeFile(path.join(c.directory,'process-journal.json'),JSON.stringify({...journal,...result,complete:true},null,2));await save();
  }
  const inputs=['server/platform/windows/backup-service.js','server/platform/windows/backup-bundle.js','server/platform/windows/backup-reader.js','server/platform/windows/backup-archive.js','server/platform/windows/credentials.js','server/platform/windows/manager.js','server/store.js'];report.installedInputHashes=Object.fromEntries(await Promise.all(inputs.map(async file=>[file,await fileHash(path.join(delivery.installed,'resources/app/dist-server',file))])));report.engineSha256=await fileHash(path.join(delivery.installed,'resources/node/node.exe'));report.verifierSha256=await fileHash(import.meta.filename);report.complete=true;await save();console.log(JSON.stringify({complete:true,version:report.version,realProcessTerminations:2,newProcessRetries:2,exclusiveDestinationRaceVerified:true,actualHyperVExercised:false,realDiskFullExercised:false,privateEvidence:output}));
 }catch(error){report.error=String(error.message).slice(0,1200);await save();throw error;}
 finally{for(const worker of workers)if(worker.terminal===null){worker.child.kill('SIGKILL');await worker.exit().catch(()=>{});}}
}

if(process.argv.includes('--worker')){try{await worker();}catch(error){process.stderr.write('Synthetic export worker failed: '+String(error.code??error.name)+'\n');process.exitCode=1;}finally{if(process.connected)process.disconnect();}}
else await main();
