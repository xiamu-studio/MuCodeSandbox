// Real ordinary-process termination and restart against installed restore code.
// Hyper-V broker calls and disk/seed bytes are synthetic. No VM is registered,
// started, removed or imported by this verifier; the live desktop is untouched.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir,lstat,copyFile,appendFile} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

const root=path.resolve(import.meta.dirname,'..'),runDirectory=path.join(root,'.mu-data/windows-run');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
const load=(installed,file)=>import(pathToFileURL(path.join(installed,'resources/app/dist-server',file)).href);
async function modules(installed){return{...await load(installed,'server/platform/windows/credentials.js'),...await load(installed,'server/platform/windows/backup-bundle.js'),...await load(installed,'server/platform/windows/backup-archive.js'),...await load(installed,'server/platform/windows/config.js'),...await load(installed,'server/platform/windows/guest.js')};}
const privateJSON=async file=>JSON.parse(await readFile(file,'utf8'));
const workerMode=process.argv.includes('--worker');

async function worker(){
 const selected=process.argv[process.argv.indexOf('--case')+1],mode=process.argv[process.argv.indexOf('--hold')+1];
 const c=await privateJSON(selected),api=await modules(c.installed),store=await api.openWindowsStore(c.store);
 assert.equal(path.dirname(selected),c.directory);assert.equal(c.directory,path.join(c.runRoot,'case-'+c.phase));assert.ok(['preflight','published','none'].includes(mode));
 process.on('message',()=>{}); // Keep the controlled pause alive until parent termination.
 const send=value=>new Promise((resolve,reject)=>process.send({...value,nonce:c.nonce,pid:process.pid},error=>error?reject(error):resolve()));
 const pause=async phase=>{await send({type:'paused',phase});await new Promise(()=>{});};
 const broker={call:async(action,args={})=>{
  await appendFile(path.join(c.directory,'calls-'+process.pid+'.jsonl'),JSON.stringify({action,id:args.id})+'\n');assert.equal(args.id,c.id);
  if(action==='allocation'){if(mode==='preflight')await pause('preflight');return{registered:false};}
  if(action==='absence')return{absent:true};
  if(action==='backup-import'){
   if(mode==='published')await pause('published');
   assert.equal(path.dirname(path.dirname(args.disk)),c.runtime);assert.ok(/^backup-work-[a-f0-9-]{36}$/.test(path.basename(path.dirname(args.disk))));
   assert.equal((await lstat(args.disk)).isSymbolicLink(),false);assert.equal(await fileHash(args.disk),c.diskSha256);assert.equal(await fileHash(args.seed),c.seedSha256);assert.equal(args.diskBytes,c.diskBytes);
   await copyFile(args.disk,path.join(c.directory,'imported-disk.bin'),constants.COPYFILE_EXCL);
   await copyFile(args.seed,path.join(c.directory,'imported-seed.iso'),constants.COPYFILE_EXCL);
   return{restored:true,id:c.id,platformId:c.syntheticPlatformId,state:'Off',diskSha256:c.diskSha256};
  }
  throw Error('Unexpected synthetic broker action');
 }};
 try{
  await send({type:'ready'});
  const restored=await api.restoreWindowsBackup(broker,c.runtime,store,createReadStream(c.archive),c.password);
  assert.equal(restored.id,c.id);assert.equal(restored.state,'stopped');assert.equal(restored.network.password,undefined);
  await send({type:'restored',id:restored.id,state:restored.state});
 }finally{store.close();store.key.fill(0);process.disconnect();}
}

const workers=[];
function launch(c,hold){
 const child=spawn(c.engine,[import.meta.filename,'--worker','--case',path.join(c.directory,'private-case.json'),'--hold',hold],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 const messages=[],events=new EventEmitter();let terminal=null;
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{terminal={code,signal,at:new Date().toISOString()};events.emit('update');resolve(terminal);}));
 child.once('error',error=>{terminal={spawnError:error.code};events.emit('update');});
 child.on('message',message=>{if(message.nonce===c.nonce&&message.pid===child.pid){messages.push(message);events.emit('update');}});
 let stderr='';child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-16384);});child.stdout.on('data',()=>{});
 const wait=(predicate,timeoutMs=45000)=>new Promise((resolve,reject)=>{
  let timer;const finish=(error,value)=>{clearTimeout(timer);events.off('update',scan);error?reject(error):resolve(value);};
  const scan=()=>{const match=messages.find(predicate);if(match)return finish(null,match);if(terminal)return finish(Error('Verifier worker exited before its expected receipt'));};
  timer=setTimeout(()=>finish(Error('Verifier worker observation timed out; original process is retained until cleanup')),timeoutMs);events.on('update',scan);scan();
 });
 const exit=async()=>{let timer;try{return await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Verifier worker exit remains unconfirmed')),15000);})]);}finally{clearTimeout(timer);await writeFile(path.join(c.directory,'worker-'+child.pid+'-stderr.txt'),stderr);}};
 const record={child,wait,exit,get terminal(){return terminal;}};workers.push(record);return record;
}

async function prepare(runRoot,phase,delivery,api){
 const directory=path.join(runRoot,'case-'+phase);await mkdir(directory);await api.secureWindowsDirectory(directory);
 const id=randomUUID(),nonce=randomUUID(),source=path.join(directory,'source-identity');await mkdir(source);
 const p=api.windowsPaths(source,id);await mkdir(p.directory);
 const keygen=path.join(process.env.SystemRoot,'System32/OpenSSH/ssh-keygen.exe');for(const file of [p.key,p.hostKey])await promisify(execFile)(keygen,['-q','-t','ed25519','-N','','-f',file],{windowsHide:true,timeout:10000});
 const publicKey=await readFile(p.key+'.pub','utf8'),hostPublic=await readFile(p.hostKey+'.pub','utf8'),seed=Buffer.alloc(49152);Buffer.from('CD001').copy(seed,32769);Buffer.from(publicKey+'\n'+hostPublic).copy(seed,40000);
 const disk=Buffer.alloc(2*1024**2+113,91);Buffer.from('synthetic-metadata-process-'+nonce).copy(disk,1000);
 const config=api.windowsConfigSchema.parse({version:1,id,image:path.join(directory,'unused-base.vhdx'),imageSha256:'a'.repeat(64),cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9,username:'synthetic',password:'synthetic-proxy-'+nonce},expectedIp:'203.0.113.90'});
 const {state,lastError,browserRunning,createdAt,updatedAt,instanceName,...environment}=api.windowsEnvironment(config);delete environment.id;environment.name='恢复进程中断验收';environment.browserUrl='http://127.0.0.1/';
 const identity={id,managementPrivate:await readFile(p.key,'utf8'),managementPublic:publicKey,hostPrivate:await readFile(p.hostKey,'utf8'),hostPublic,knownHosts:api.vmIdentity(id).name+' '+hostPublic.trim()+'\n',seed:{base64:seed.toString('base64'),sha256:hash(seed)}};
 const c={directory,runRoot,phase,nonce,id,installed:delivery.installed,engine:path.join(delivery.installed,'resources/node/node.exe'),runtime:path.join(directory,'runtime'),store:path.join(directory,'store'),archive:path.join(directory,'synthetic.mucwin'),password:randomBytes(32).toString('base64url'),syntheticPlatformId:randomUUID(),diskSha256:hash(disk),diskBytes:disk.length,seedSha256:hash(seed)};
 const chunks=[];await api.writeWindowsBackupArchive({write:async bytes=>chunks.push(Buffer.from(bytes))},(async function*(){yield disk;})(),{version:2,architecture:'x86_64',platform:'hyperv',config:environment,identity,imageSha256:config.imageSha256,disk:{bytes:c.diskBytes,sha256:c.diskSha256}},c.password);
 await writeFile(c.archive,Buffer.concat(chunks),{flag:'wx'});c.archiveSha256=await fileHash(c.archive);c.materialHashes={'management':hash(Buffer.from(identity.managementPrivate)),'management.pub':hash(Buffer.from(identity.managementPublic)),'host-ed25519':hash(Buffer.from(identity.hostPrivate)),'host-ed25519.pub':hash(Buffer.from(identity.hostPublic)),'known_hosts':hash(Buffer.from(identity.knownHosts)),'seed.iso':hash(seed)};
 await writeFile(path.join(directory,'private-case.json'),JSON.stringify(c,null,2),{flag:'wx'});disk.fill(0);seed.fill(0);return c;
}

async function main(){
 assert.equal(process.platform,'win32');const delivery=await privateJSON(path.join(runDirectory,'local-desktop-delivery.json'));assert.equal(delivery.version,'0.4.66-preview.23');assert.equal((await privateJSON(path.join(delivery.installed,'resources/app/package.json'))).version,delivery.version);
 const api=await modules(delivery.installed);for(const [file,digest] of Object.entries(delivery.payloadHashes))assert.equal(await fileHash(path.join(delivery.installed,file)),digest);
 const runRoot=path.join(root,'.mu-data/windows-runtime','metadata-process-'+randomUUID());await mkdir(runRoot);await api.secureWindowsDirectory(runRoot);
 const report={complete:false,time:new Date().toISOString(),version:delivery.version,runRoot,scope:'real installed ordinary Node process exit and new-process recovery; synthetic archive, disk, seed and Hyper-V broker',actualHyperVExercised:false,actualDesktopRestoreBootExercised:false,physicalPowerLossExercised:false,cases:[]};
 const output=path.join(runDirectory,'backup-metadata-process-complete.json'),save=()=>writeFile(output,JSON.stringify(report,null,2));await save();
 try{
  for(const phase of ['preflight','published']){
   const c=await prepare(runRoot,phase,delivery,api),first=launch(c,phase);await first.wait(message=>message.type==='paused'&&message.phase===phase);
   assert.equal(first.terminal,null);assert.equal(first.child.exitCode,null);const liveBeforeKill=true,killedAt=new Date().toISOString();
   const journal={phase,id:c.id,oldPid:first.child.pid,liveBeforeKill,killedAt,archiveSha256:c.archiveSha256,controlledPauseObserved:true,complete:false};
   await writeFile(path.join(c.directory,'process-journal.json'),JSON.stringify(journal,null,2));assert.equal(first.child.kill('SIGKILL'),true);const stopped=await first.exit();assert.notEqual(stopped.code,0);journal.termination=stopped;await writeFile(path.join(c.directory,'process-journal.json'),JSON.stringify(journal,null,2));
   const p=api.windowsPaths(c.runtime,c.id),credentialHash=await fileHash(path.join(c.store,'credentials.dpapi'));
   let publishedFiles=[];try{publishedFiles=(await readdir(p.directory)).sort();}catch(error){if(error.code!=='ENOENT')throw error;}
   if(phase==='preflight')assert.deepEqual(publishedFiles,[]);else{assert.deepEqual(publishedFiles,['allocation.json','backup-restore.json',...Object.keys(c.materialHashes)].sort());for(const [name,digest] of Object.entries(c.materialHashes))assert.equal(await fileHash(path.join(p.directory,name)),digest);}
   const db=new DatabaseSync(path.join(c.store,'state.sqlite'),{readOnly:true});let beforeRows;try{beforeRows=db.prepare('SELECT config FROM environments WHERE id=?').all(c.id);assert.equal(beforeRows.length,phase==='preflight'?0:1);if(beforeRows.length)assert.equal(JSON.parse(beforeRows[0].config).state,'error');}finally{db.close();}
   const resumed=launch(c,'none'),receipt=await resumed.wait(message=>message.type==='restored');assert.notEqual(resumed.child.pid,first.child.pid);assert.equal((await resumed.exit()).code,0);assert.equal(receipt.state,'stopped');
   assert.equal(await fileHash(c.archive),c.archiveSha256);assert.equal(await fileHash(path.join(c.store,'credentials.dpapi')),credentialHash);assert.equal(await fileHash(path.join(c.directory,'imported-disk.bin')),c.diskSha256);assert.equal(await fileHash(path.join(c.directory,'imported-seed.iso')),c.seedSha256);
   for(const [name,digest] of Object.entries(c.materialHashes))assert.equal(await fileHash(path.join(p.directory,name)),digest);
   await assert.rejects(readFile(path.join(p.directory,'backup-restore.json')),{code:'ENOENT'});const manifest=await privateJSON(p.manifest);assert.equal(manifest.id,c.id);assert.equal(manifest.platformId,c.syntheticPlatformId);
   const privateRemnants=(await readdir(c.runtime)).filter(name=>name.startsWith('backup-work-'));const result={phase,id:c.id,oldPid:first.child.pid,newPid:resumed.child.pid,liveBeforeKill,killedAt,termination:stopped,publishedBeforeKill:phase==='published',archiveUnchanged:true,dpapiKeyUnchanged:true,managementIdentityMatched:true,syntheticDiskAndSeedMatched:true,finalState:'stopped',retainedPrivateWorkDirectories:privateRemnants.length,actualHyperVExercised:false};report.cases.push(result);await writeFile(path.join(c.directory,'process-journal.json'),JSON.stringify({...journal,...result,complete:true},null,2));await save();
  }
  const inputs=['server/platform/windows/backup-bundle.js','server/platform/windows/backup-archive.js','server/platform/windows/credentials.js','server/platform/windows/config.js','server/platform/windows/runtime.js','server/process.js','server/store.js'];report.installedInputHashes=Object.fromEntries(await Promise.all(inputs.map(async file=>[file,await fileHash(path.join(delivery.installed,'resources/app/dist-server',file))])));report.verifierSha256=await fileHash(import.meta.filename);report.engineSha256=await fileHash(path.join(delivery.installed,'resources/node/node.exe'));report.complete=true;await save();console.log(JSON.stringify({complete:true,version:report.version,realProcessTerminations:report.cases.length,newProcessRecoveries:report.cases.length,actualHyperVExercised:false,privateEvidence:output}));
 }catch(error){report.error=String(error.message).slice(0,1200);await save();throw error;}
 finally{for(const worker of workers)if(worker.terminal===null){worker.child.kill('SIGKILL');await worker.exit().catch(()=>{});}}
}

if(workerMode){try{await worker();}catch(error){process.stderr.write('Synthetic metadata worker failed: '+String(error.code??error.name)+'\n');process.exitCode=1;process.disconnect?.();}}
else await main();
