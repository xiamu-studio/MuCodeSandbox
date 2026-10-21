import assert from 'node:assert/strict';import {readFile,writeFile,rename,readdir} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';import {randomUUID} from 'node:crypto';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {windowsConfigSchema} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/config.js';
import {WindowsStorage} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/storage.js';
const directory='C:/MuLab/public';
export async function cacheAcceptance(client,nonce,pass){
 async function receipt(name){const deadline=performance.now()+(name==='seed'?1800000:120000);for(;;){try{const value=JSON.parse(await readFile(`C:/MuLab/approved/cache-${name}.json`,'utf8'));if(value.nonce===nonce)return value;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(performance.now()<deadline,'The cache operator did not acknowledge '+name);await delay(100);}}
 async function request(action,name){const path=`${directory}/cache-${action}-request.json`;await writeFile(path+'.next',JSON.stringify({nonce,action}));await rename(path+'.next',path);return receipt(name);}
 const root=`${directory}/cache-runtime`,runtime=new HyperVRuntime(root,undefined,client),base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8'));
 const prior=(await readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).filter(entry=>entry.isDirectory()&&/^mu-win-[a-f0-9]{32}$/.test(entry.name));assert.ok(prior.length<=1,'Inspect the prior diagnostic resources instead of allocating another canary');
 const old=prior.length?JSON.parse(await readFile(`${root}/${prior[0].name}/manifest.json`,'utf8')):null;
 const config=windowsConfigSchema.parse({version:1,id:old?.id??randomUUID(),...base,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9},expectedIp:'203.0.113.90'});let canary='synthetic-cache-canary-'+randomUUID();
 let removed=false,clone;
 try{
  if(old)assert.equal(await runtime.recoverCreation(config),true);else await runtime.create(config);await runtime.start(config);await runtime.configure(config);
  if(old){canary=(await runtime.guest(config,['cat','/workspace/cache-canary.txt'])).trim();assert.match(canary,/^synthetic-cache-canary-[a-f0-9-]{36}$/);}else await runtime.guest(config,['python3','-c',"from pathlib import Path;Path('/workspace/cache-canary.txt').write_text("+JSON.stringify(canary)+")"]);assert.equal((await runtime.inspectGuard(config)).leaseActive,false);
  pass('A real running Linux VM has a written canary and closed business networking before cleanup');
  const dataset=await request('seed','seed');assert.equal(dataset.snapshotOnlyReference,true);
  const storage=new WindowsStorage(client,()=>dataset.current,()=>true);
  let info=await storage.inspect();assert.equal(info.reason,null);assert.equal(info.canPrune,true);assert.ok(info.reclaimableFiles>=3);assert.ok(info.retainedBytes>0);
  pass('The privileged inventory resolves real snapshot parent chains and offers only unused cache copies');
  await assert.rejects(client.call('cache-prune',{keepDigest:dataset.current,plan:info.plan,directory:'C:\\Windows'}),{code:'INVALID_REQUEST'});
  pass('Cache requests reject caller-selected directories before any deletion');
  await request('change','changed');await assert.rejects(storage.prune(info.plan),{code:'CACHE_PLAN_CHANGED'});
  pass('A real cache mutation invalidates the reviewed plan without deleting the old candidates');
  info=await storage.inspect();const holding=request('hold','released');await receipt('held');
  await assert.rejects(storage.prune(info.plan),{code:'STORAGE_BUSY'});await writeFile(`${directory}/cache-release.json`,JSON.stringify({nonce}));await holding;
  pass('An actual cross-process import lock blocks cleanup without affecting the running VM');
  info=await storage.inspect();const attempts=await Promise.allSettled([client.call('cache-prune',{keepDigest:dataset.current,plan:info.plan},{timeoutMs:60000}),client.call('cache-prune',{keepDigest:dataset.current,plan:info.plan},{timeoutMs:60000})]);assert.equal(attempts.filter(value=>value.status==='fulfilled').length,1);const failure=attempts.find(value=>value.status==='rejected');assert.ok(['STORAGE_BUSY','CACHE_PLAN_CHANGED'].includes(failure.reason.code));
  assert.equal((await runtime.state(config)).state,'Running');assert.equal((await runtime.guest(config,['cat','/workspace/cache-canary.txt'])).trim(),canary);
  pass('Concurrent cleanup requests cannot both execute a stale plan; the original running VM and canary survive');
  info=await storage.inspect();assert.equal(info.reclaimableFiles,0);assert.equal(info.imageCount,3);
  pass('The current base, registered source and snapshot-only parent are all retained after cleanup');
  await request('remove-control','control-removed');await runtime.stop(config);await runtime.remove(config);removed=true;
  info=await storage.inspect();assert.equal(info.canPrune,true);await storage.prune(info.plan);info=await storage.inspect();assert.equal(info.imageCount,1);assert.equal(info.reclaimableFiles,0);
  pass('Only after explicit VM and snapshot removal do their unreferenced cache copies become reclaimable');
  clone=windowsConfigSchema.parse({...config,id:randomUUID(),image:'mu-base:'+dataset.current,imageSha256:dataset.current});await runtime.create(clone);await runtime.start(clone);await runtime.configure(clone);assert.equal((await runtime.guest(clone,['id','-u'])).trim(),'2001');await assert.rejects(runtime.guest(clone,['test','-e','/workspace/cache-canary.txt']));assert.equal((await runtime.inspectGuard(clone)).leaseActive,false);
  pass('The retained current base still creates and boots a fresh isolated Linux VM after reclamation');
  await runtime.stop(clone);await runtime.remove(clone);clone=undefined;
  pass('Both native test VMs are stopped and their owned disks and switches are removed');
  return {removed:true,currentDigest:dataset.current,concurrency:true,snapshotOnlyReference:true,originalCanaryPreserved:true};
 }finally{if(clone){await runtime.stop(clone);await runtime.remove(clone);}if(!removed){await runtime.stop(config);}}
}
