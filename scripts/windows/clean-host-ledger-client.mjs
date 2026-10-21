// Synthetic ordinary-user recovery probe, only in the disconnected fixture.
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {windowsConfigSchema,windowsPaths} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/config.js';
const directory='C:/MuLab/public',root=`${directory}/ledger-runtime`;
async function receipt(name,nonce){
 const until=performance.now()+120000;
 for(;;){try{const value=JSON.parse(await readFile(`C:/MuLab/approved/${name}.json`,'utf8'));if(value.nonce===nonce)return value;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(performance.now()<until,'The independent ledger operator has not acknowledged '+name);await delay(200);}
}
export async function ledgerAcceptance(phase,client,nonce,pass){
 if(phase==='ledger-deny'){
  const denied=await receipt('ledger-denied',nonce);assert.equal(denied.rejected,true);assert.equal(denied.originalDiskUnchanged,true);assert.equal(denied.originalVmOff,true);
  await assert.rejects(client.hello(),{code:'BROKER_UNAVAILABLE'});
  pass('With both registry copies absent and original VM storage present, the production broker refuses to expose authority and preserves the stopped VM and disk');return denied;
 }
 const runtime=new HyperVRuntime(root,undefined,client);
 if(phase==='ledger-seed'){
  const base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8'));
  const config=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9},expectedIp:'203.0.113.90'}),canary='synthetic-ledger-canary-'+randomUUID();
  await runtime.create(config);await runtime.start(config);await runtime.configure(config);
  assert.equal((await runtime.guest(config,['id','-u'])).trim(),'2001');assert.equal((await runtime.inspectGuard(config)).leaseActive,false);
  await runtime.guest(config,['python3','-c',"from pathlib import Path;Path('/workspace/ledger-canary.txt').write_text("+JSON.stringify(canary)+")"]);
  const platformId=(await runtime.state(config)).platformId;await runtime.stop(config);assert.equal((await runtime.state(config)).state,'Off');
  pass('The standard user writes an actual dev-owned canary inside a new Linux VM and confirms it is stopped');
  await unlink(windowsPaths(root,config.id).manifest);
  pass('Only the local runtime manifest is removed; original management keys and the protected guest disk are retained');
  return {config,canary,platformId,stopped:true,localManifestRemoved:true,removed:false};
 }
 const seed=JSON.parse(await readFile('C:/MuLab/approved/ledger-seed-result.json','utf8')).nested,config=windowsConfigSchema.parse(seed.config);
 assert.equal(await runtime.recoverCreation(config),true);assert.equal((await runtime.state(config)).platformId,seed.platformId);assert.equal((await runtime.state(config)).state,'Off');
 pass('The recovered protected allocation restores the original local manifest and exact Hyper-V VM identity');
 const fault=JSON.parse(await readFile('C:/MuLab/approved/ledger-fault.json','utf8'));
 await writeFile(`${directory}/ledger-inspect-request.json.next`,JSON.stringify({nonce,id:config.id}));await rename(`${directory}/ledger-inspect-request.json.next`,`${directory}/ledger-inspect-request.json`);
 const inspected=await receipt('ledger-inspected',nonce);assert.equal(inspected.originalDiskUnchanged,true);assert.equal(inspected.replicasMatch,true);
 pass('The independent administrator confirms both repaired registry copies and the byte-for-byte original disk before Linux starts');
 let removed=false;
 try{
  await runtime.start(config);await runtime.configure(config);assert.equal((await runtime.guest(config,['cat','/workspace/ledger-canary.txt'])).trim(),seed.canary);assert.equal((await runtime.inspectGuard(config)).leaseActive,false);
  pass('The original Linux disk boots and retains its written canary, with business networking closed');
 }finally{await runtime.stop(config);assert.equal((await runtime.state(config)).state,'Off');}
 if(phase==='ledger-final'){
  const orphan=JSON.parse(await readFile('C:/MuLab/approved/ledger-orphan.json','utf8'));
  assert.equal((await client.call('host-status',{}, {timeoutMs:90000})).unregisteredStorage,1);
  await assert.rejects(client.call('disk',{id:orphan.id,image:config.image,imageSha256:config.imageSha256,cpus:2,memoryGiB:4,diskGiB:32},{timeoutMs:90000}),{code:'DENIED'});
  assert.deepEqual(await client.call('allocation',{id:orphan.id}),{registered:false});
  pass('Known registrations remain usable while a new allocation cannot adopt or overwrite preserved unregistered storage');
  await runtime.remove(config);assert.deepEqual(await client.call('allocation',{id:config.id}),{registered:false});removed=true;pass('After explicit recovery, the stopped synthetic VM and its owned storage are removed');
 }
 return {id:config.id,platformId:seed.platformId,scenario:fault.kind,originalCanary:true,stopped:true,removed};
}
