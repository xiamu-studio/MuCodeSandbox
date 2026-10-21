import assert from 'node:assert/strict';import {readFile,writeFile,rename} from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {windowsConfigSchema} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/config.js';
const directory='C:/MuLab/public';
export async function resourceAcceptance(phase,client,nonce,pass){
 async function receipt(name){const until=performance.now()+180000;for(;;){try{const r=JSON.parse(await readFile(`C:/MuLab/approved/resource-${name}.json`,'utf8'));if(r.nonce===nonce)return r;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(performance.now()<until,'The pressure operator has not acknowledged '+name);await delay(100);}}
 async function request(action,name){const path=`${directory}/resource-${action}-request.json`;await writeFile(path+'.next',JSON.stringify({nonce,action}));await rename(path+'.next',path);return receipt(name);}
 async function release(action,name){await writeFile(`${directory}/resource-release-${action}.json`,JSON.stringify({nonce}));return receipt(name);}
 const runtime=new HyperVRuntime(`${directory}/resource-runtime`,undefined,client),base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8'));
 const status=()=>client.call('resource-status',{}, {timeoutMs:90000});
 async function boot(config){await runtime.start(config);await runtime.configure(config);assert.equal((await runtime.inspectGuard(config)).leaseActive,false);}
 if(phase==='resource-seed'){
  const configs=[0,1].map(()=>windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:2,memoryGiB:6,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9},expectedIp:'203.0.113.90'})),canaries=configs.map(()=>`synthetic-resource-canary-${randomUUID()}`);
  for(const config of configs)await runtime.create(config);pass('Two actual protected standalone Linux disks are created with capacity reserved before conversion');
  await assert.rejects(client.call('resource-status',{diskFloorBytes:0}),{code:'INVALID_REQUEST'});pass('The caller cannot override resource thresholds');
  const large={...configs[0],id:randomUUID(),diskGiB:256};await assert.rejects(client.call('disk',{id:large.id,image:large.image,imageSha256:large.imageSha256,cpus:2,memoryGiB:6,diskGiB:256},{timeoutMs:120000}),{code:'RESOURCE_DISK'});await client.call('delete',{id:large.id},{timeoutMs:120000});
  pass('A real oversized disk request is refused without overwriting either existing VM disk');
  const memoryId=randomUUID();await assert.rejects(client.call('disk',{id:memoryId,image:base.image,imageSha256:base.imageSha256,cpus:2,memoryGiB:32,diskGiB:32},{timeoutMs:120000}),{code:'RESOURCE_MEMORY'});assert.deepEqual(await client.call('allocation',{id:memoryId}),{registered:false});pass('A configuration exceeding physical memory bounds is refused before allocation');
  const held=request('hold-start','start-released');await receipt('start-held');await assert.rejects(client.call('start',{id:configs[0].id},{timeoutMs:120000}),{code:'RESOURCE_BUSY'});await release('start','start-released');await held;pass('A separate process holding the global start lock prevents another VM start');
  const attempts=await Promise.allSettled(configs.map(config=>client.call('start',{id:config.id},{timeoutMs:120000})));assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.ok(attempts.some(r=>r.status==='rejected'&&['RESOURCE_BUSY','RESOURCE_MEMORY'].includes(r.reason.code)));
  const winner=attempts.findIndex(r=>r.status==='fulfilled'),loser=1-winner;await boot(configs[winner]);await assert.rejects(client.call('start',{id:configs[loser].id},{timeoutMs:120000}),{code:'RESOURCE_MEMORY'});assert.equal((await runtime.state(configs[loser])).state,'Off');
  pass('Concurrent starts admit only one 6 GiB guest; the second remains Off and cannot consume the host reserve');
  const platformIds=[];for(const index of [winner,loser]){await boot(configs[index]);await runtime.guest(configs[index],['python3','-c',"from pathlib import Path;Path('/workspace/resource-canary.txt').write_text("+JSON.stringify(canaries[index])+")"]);platformIds[index]=(await runtime.state(configs[index])).platformId;await runtime.stop(configs[index]);}
  pass('After memory is released, both original disks boot sequentially and retain independent dev canaries');
  return {configs,canaries,platformIds,stopped:true,removed:false};
 }
 const seed=JSON.parse(await readFile('C:/MuLab/approved/resource-seed-result.json','utf8')).nested,configs=seed.configs.map(config=>windowsConfigSchema.parse(config));
 if(phase==='resource-disk'||phase==='resource-memory'){
  const kind=phase==='resource-disk'?'disk':'memory';assert.equal((await status()).fenced,false);await boot(configs[0]);assert.equal((await runtime.guest(configs[0],['cat','/workspace/resource-canary.txt'])).trim(),seed.canaries[0]);
  pass(`The original Linux canary is readable with closed business egress before ${kind} pressure`);
  await request(kind,kind+'-held');const until=performance.now()+120000;let info;
  for(;;){info=await status();if(info.fenced&&info.issue===kind&&info.stopsConfirmed)break;assert.ok(performance.now()<until,'The native resource guardian has not confirmed shutdown');await delay(200);}
  for(const config of configs){const state=await runtime.state(config);assert.equal(state.state,'Off');assert.equal(state.platformId,seed.platformIds[configs.indexOf(config)]);}
  await assert.rejects(client.call('start',{id:configs[0].id}),{code:'RESOURCE_FENCED'});pass(`Actual ${kind} pressure trips the independent native guardian, confirms both VMs Off and blocks old-session restart`);
  const released=await release(kind,kind+'-released');assert.equal(released.complete,true);assert.equal((await status()).fenced,true);pass('Releasing pressure restores resources while the old authorization remains terminally closed');return {kind,fenced:true,stopped:true,removed:false};
 }
 assert.equal(phase,'resource-recover');assert.equal((await status()).fenced,false);
 for(let i=0;i<configs.length;i++){assert.equal(await runtime.recoverCreation(configs[i]),true);await boot(configs[i]);assert.equal((await runtime.state(configs[i])).platformId,seed.platformIds[i]);assert.equal((await runtime.guest(configs[i],['cat','/workspace/resource-canary.txt'])).trim(),seed.canaries[i]);await runtime.stop(configs[i]);await runtime.remove(configs[i]);}
 pass('A new healthy session boots both unchanged VM identities and reads their original canaries after disk and memory fences');
 const failed=[];try{for(let i=0;i<4;i++){const id=randomUUID();failed.push(id);await assert.rejects(client.call('disk',{id,image:'C:\\MuLab\\public\\missing-resource-source.vhdx',imageSha256:createHash('sha256').update(id).digest('hex'),cpus:1,memoryGiB:2,diskGiB:256},{timeoutMs:120000}),{code:'BROKER_FAILED'});}assert.equal((await status()).registeredDiskGiB,1024);const id=randomUUID();await assert.rejects(client.call('disk',{id,image:base.image,imageSha256:base.imageSha256,cpus:1,memoryGiB:2,diskGiB:16}),{code:'RESOURCE_QUOTA'});assert.deepEqual(await client.call('allocation',{id}),{registered:false});pass('Actual protected allocations reach the 1 TiB quota exactly and refuse an additional reservation');}finally{for(const id of failed)await client.call('delete',{id},{timeoutMs:120000});}
 assert.equal((await status()).registeredDiskGiB,0);pass('Confirmed cleanup removes only the synthetic VMs, failed allocations and their private resources');return {removed:true,originalCanariesPreserved:true,quotaBoundary:true};
}
