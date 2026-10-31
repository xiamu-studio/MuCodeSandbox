import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {startBroker,installedBrokerPath} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';
import {PROBE_PORT,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {RunOptions} from '../server/process.ts';

// Explicit opt-in; creates one new disposable VM and never selects an existing
// environment. Retains its disk, journal and evidence on success or failure.
if(process.platform!=='win32'||process.argv.length!==3||!['--execute','--execute-interrupted','--execute-schedule'].includes(process.argv[2]))throw Error('Windows and explicit execution mode required');
const interrupted=process.argv[2]==='--execute-interrupted';
const scheduled=process.argv[2]==='--execute-schedule';let scheduleNow=Date.now();
const id=randomUUID(),root=windowsRuntimeDirectory(),directory=path.join(root,'compaction-lab-'+id),runtimeRoot=path.join(directory,'runtime');
await mkdir(runtimeRoot,{recursive:true});
const base=JSON.parse(await readFile(path.join(root,'protected-desktop-base.json'),'utf8'));
const fixture=await localFixtures(path.join(directory,'fixtures'),process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
const evidence:Record<string,unknown>={testId:id,scope:'new synthetic environment only',complete:false,steps:[]};
let broker:Awaited<ReturnType<typeof startBroker>>|undefined,service:Awaited<ReturnType<typeof createWindowsService>>|undefined,config:WindowsConfig|undefined;
const steps=evidence.steps as string[],mark=(step:string)=>{steps.push(step);console.log(step);};
try{
 broker=await startBroker(await installedBrokerPath());await broker.hello();
 class LabRuntime extends HyperVRuntime {
  override async start(c:WindowsConfig,options:RunOptions={}){await super.start(c,options);await this.management(c,['sudo','tee','/etc/mucodesandbox/lab-ca.crt'],{input:fixture.certificate});await this.management(c,['sudo','tee','/usr/local/share/ca-certificates/mu-local-fixture.crt'],{input:fixture.certificate});await this.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});}
 }
 let runtime=new LabRuntime(runtimeRoot,undefined,broker);
 const probe=(c:WindowsConfig)=>async()=>Promise.all(fixture.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await runtime.management(c,['sudo','-n','-H','-u','mu-probe','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,'--noproxy','',`https://${receiver}/`],{timeoutMs:10000})).ip})));
 service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:path.join(directory,'app'),runtimeRoot,base,runtime,probe,enableDiskCompactionPreview:true,diskCompactionScheduleClock:scheduled?()=>scheduleNow:undefined});
 const e=await service.manager.create({name:'Synthetic disk reclaim '+id.slice(0,8),cpus:2,memoryGiB:4,diskGiB:32,network:{mode:'http',host:'127.0.0.1',port:fixture.port,strict:true,transparent:true,egressLock:{expectedIp:LAB_EXIT},dns:fixture.dns}});
 evidence.environmentId=e.id;config=await service.manager.profile(e);
 async function action(name:'start'|'stop'){const job=await service!.manager.action(e.id,name);await service!.manager.wait(job.id);const result=service!.manager.store.jobs().find(j=>j.id===job.id);assert.equal(result?.status,'succeeded',result?.message);}
 await action('start');mark('Synthetic VM started');
 const canary='mu-compaction-canary-'+id,hash=createHash('sha256').update(canary).digest('hex');
 const create=`from pathlib import Path\nimport os\np=Path('/workspace/.mu-compact-${id}');p.mkdir()\n(p/'canary').write_text('${canary}')\nwith (p/'temporary').open('xb') as f:\n for i in range(256):f.write(os.urandom(1024*1024))\n f.flush();os.fsync(f.fileno())\nprint('created')`;
 assert.equal((await runtime.guest(config,['python3','-c',create],{timeoutMs:120000})).trim(),'created');
 const remove=`from pathlib import Path\np=Path('/workspace/.mu-compact-${id}');assert (p/'canary').read_text()=='${canary}'\n(p/'temporary').unlink()\nprint('deleted')`;
 assert.equal((await runtime.guest(config,['python3','-c',remove],{timeoutMs:30000})).trim(),'deleted');
 await action('stop');assert.equal((await runtime.state(config)).state,'Off');const before=await runtime.diskGrowthInfo(config);evidence.beforeBytes=before.allocatedBytes;mark('Synthetic file deleted and VM independently confirmed stopped');
 if(interrupted){
  const original=broker.call.bind(broker);let injected=false;
  broker.call=async(action,parameters,options)=>{
   if(action!=='disk-compact-run')return original(action,parameters,options);
   try{const result=await original(action,parameters,options);injected=true;evidence.originalReply='completed';throw Error('Synthetic interruption after submit reply');}
   catch(error){if(injected)throw error;if((error as {code?:string}).code!=='DISK_COMPACTION_RUNNING')throw error;injected=true;evidence.originalReply='running';throw Error('Synthetic interruption after running reply');}
  };
  const interruptedJob=await service.manager.compactDisk(e.id,'start',e.name);await service.manager.wait(interruptedJob.id);
  const failed=service.manager.store.jobs().find(j=>j.id===interruptedJob.id);assert.equal(failed?.status,'failed');assert.equal(injected,true);evidence.interruptedJob=failed;
  const pending=await runtime.diskCompactionStatus(config);assert.equal(pending.pending,true);if(!pending.pending)throw Error('Pending maintenance was lost');assert.ok(['compacting','verifying'].includes(pending.phase));evidence.pendingBeforeRestart=pending.phase;
  await service.close();service=undefined;await broker.call('shutdown');broker=undefined;mark('Original maintenance fenced; restarting broker and controller');
  broker=await startBroker(await installedBrokerPath());await broker.hello();runtime=new LabRuntime(runtimeRoot,undefined,broker);
  service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:path.join(directory,'app'),runtimeRoot,base,runtime,probe,enableDiskCompactionPreview:true});
  config=await service.manager.profile(service.manager.store.get(e.id),false);
  const afterRestart=await runtime.diskCompactionStatus(config);assert.equal(afterRestart.pending,true);if(!afterRestart.pending)throw Error('Maintenance journal did not survive restart');assert.equal(afterRestart.phase,pending.phase);evidence.pendingAfterRestart=afterRestart.phase;
  const resumed=await service.manager.compactDisk(e.id,'resume',e.name);await service.manager.wait(resumed.id);const result=service.manager.store.jobs().find(j=>j.id===resumed.id);evidence.compactionJob=result;assert.equal(result?.status,'succeeded',result?.message);
  assert.deepEqual(await runtime.diskCompactionStatus(config),{pending:false});mark('Original maintenance verified after broker restart');
 }else if(scheduled){
  assert.ok(service.diskSchedule);assert.equal(service.diskSchedule.status(e.id).enabled,false);await service.diskSchedule.configure(e.id,true);scheduleNow+=7*24*60*60*1000;
  await service.diskSchedule.run();const state=service.diskSchedule.status(e.id);evidence.schedule=state;assert.equal(state.result,'done');assert.equal(state.enabled,true);mark('Accelerated weekly schedule completed real maintenance');
 }else{
  const job=await service.manager.compactDisk(e.id,'start',e.name);await service.manager.wait(job.id);const result=service.manager.store.jobs().find(j=>j.id===job.id);evidence.compactionJob=result;assert.equal(result?.status,'succeeded',result?.message);
 }
 assert.equal((await runtime.state(config)).state,'Off');const after=await runtime.diskGrowthInfo(config);evidence.afterBytes=after.allocatedBytes;assert.ok(after.allocatedBytes<before.allocatedBytes,'No host space was observed reclaimed');mark('Host allocation decreased after product maintenance');
 await action('start');const value=await runtime.guest(config,['cat',`/workspace/.mu-compact-${id}/canary`]);assert.equal(createHash('sha256').update(value).digest('hex'),hash);await action('stop');assert.equal((await runtime.state(config)).state,'Off');mark('Canary survived recovery and independently confirmed stop');
 evidence.complete=true;
}catch(error){evidence.error=error instanceof Error?error.message:String(error);throw error;}
finally{try{await service?.close();}finally{await broker?.call('shutdown').catch(()=>{});await fixture.close();await writeFile(path.join(directory,'results.json'),JSON.stringify(evidence,null,2));}}
