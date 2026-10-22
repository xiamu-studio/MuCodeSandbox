// Synthetic standard-user acceptance, exclusively in the disconnected fixture.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {windowsConfigSchema} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/config.js';
import {reviewProtectedStorage,adoptProtectedStorage} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/recovery.js';
const root='C:/MuLab/public/adoption-runtime';
async function operator(action,nonce){
 const name='adoption-'+action,request='C:/MuLab/public/'+name+'-request.json';await writeFile(request+'.next',JSON.stringify({action,nonce}));await rename(request+'.next',request);
 const until=performance.now()+120000;for(;;){try{const value=JSON.parse(await readFile('C:/MuLab/approved/'+name+'.json','utf8'));if(value.nonce===nonce)return value;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(performance.now()<until,'The dedicated operator has not acknowledged '+action);await delay(200);}
}
export async function adoptionAcceptance(phase,client,nonce,pass){
 const runtime=new HyperVRuntime(root,undefined,client);
 if(phase==='adoption-seed'){
  const base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8')),config=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9},expectedIp:'203.0.113.90'}),canary='synthetic-adoption-canary-'+randomUUID();
  await runtime.create(config);await runtime.start(config);await runtime.configure(config);assert.equal((await runtime.inspectGuard(config)).leaseActive,false);assert.equal((await runtime.guest(config,['id','-u'])).trim(),'2001');
  await runtime.guest(config,['python3','-c',"from pathlib import Path;Path('/workspace/adoption-canary.txt').write_text("+JSON.stringify(canary)+")"]);const platformId=(await runtime.state(config)).platformId;await runtime.stop(config);assert.equal((await runtime.state(config)).state,'Off');
  pass('A real protected Linux disk is seeded by dev and stopped with business networking closed');return {config,canary,platformId,stopped:true,removed:false};
 }
 const seed=JSON.parse(await readFile('C:/MuLab/approved/adoption-seed-result.json','utf8')).nested,c=windowsConfigSchema.parse(seed.config);
 if(phase==='adoption-backup'){
  const {backupReadAcceptance}=await import('file:///C:/MuLab/backup-read-client.mjs');return backupReadAcceptance(client,nonce,pass,runtime,c,seed);
 }
 if(phase==='adoption-review'){
  const denied=JSON.parse(await readFile('C:/MuLab/approved/adoption-default-denied.json','utf8'));assert.equal(denied.nonce,nonce);assert.equal(denied.normalStartupRejected,true);pass('Normal startup still refuses both missing copies; recovery requires an explicit separate mode');
  for(const action of ['start','stop','delete','channel','prepare-host','host-status','resource-status','cache-status'])await assert.rejects(client.call(action,{id:c.id}),{code:'DENIED'});
  pass('The explicit recovery session cannot start, stop, delete, open a channel, service Windows or expose ordinary management authority');
  await assert.rejects(client.call('recovery-review',{id:c.id,imageSha256:c.imageSha256,directory:'C:\\Windows'}),{code:'INVALID_REQUEST'});
  await assert.rejects(client.call('recovery-review',{id:randomUUID(),imageSha256:c.imageSha256}),{code:'DENIED'});
  await assert.rejects(client.call('recovery-review',{id:c.id,imageSha256:'0'.repeat(64)}),{code:'DENIED'});
  pass('Caller paths, foreign allocation IDs and unknown base digests cannot select recovery resources');
  const reviewed=await reviewProtectedStorage(client,c.id,c.imageSha256);assert.equal(reviewed.review.platformId,seed.platformId);assert.equal(reviewed.review.cpus,c.cpus);assert.equal(reviewed.review.memoryGiB,c.memoryGiB);assert.equal(reviewed.review.diskGiB,c.diskGiB);
  const inspected=await operator('inspect-plan',nonce);assert.equal(inspected.registryAbsent,true);assert.equal(inspected.diskSha256,reviewed.review.diskSha256);
  pass('Read-only review hashes the original stopped disk and leaves both missing registration copies absent');
  await assert.rejects(adoptProtectedStorage(client,reviewed,'wrong-name'),/完整虚拟机名称/);
  await assert.rejects(client.call('recovery-adopt',{id:c.id,imageSha256:c.imageSha256,plan:reviewed.plan,confirmName:'wrong-name'},{timeoutMs:1200000}),{code:'RECOVERY_REVIEW_CHANGED'});
  pass('Native publication requires the reviewed identity and exact typed name');
  await operator('change-seed',nonce);await assert.rejects(adoptProtectedStorage(client,reviewed,reviewed.review.name),{code:'RECOVERY_REVIEW_CHANGED'});const stale=await operator('restore-seed',nonce);assert.equal(stale.registryAbsent,true);
  pass('A changed protected seed invalidates an earlier review without publishing either registration copy');
  await operator('break-acl',nonce);await assert.rejects(reviewProtectedStorage(client,c.id,c.imageSha256),{code:'BROKER_FAILED'});await operator('restore-acl',nonce);
  pass('Incomplete Hyper-V deny rules prevent adoption and are never silently repaired by recovery');
  await operator('break-permissions',nonce);await assert.rejects(reviewProtectedStorage(client,c.id,c.imageSha256),{code:'DENIED'});await operator('restore-permissions',nonce);
  pass('Ordinary-user access on a protected VM input prevents adoption without rewriting its permissions');
  await operator('add-dependency',nonce);await assert.rejects(reviewProtectedStorage(client,c.id,c.imageSha256),{code:'BROKER_FAILED'});await operator('remove-dependency',nonce);
  pass('A real other VM with a differencing disk using the retained disk as parent prevents adoption');
  const fresh=await reviewProtectedStorage(client,c.id,c.imageSha256);assert.equal(fresh.plan,reviewed.plan);return {id:c.id,platformId:seed.platformId,reviewed:fresh,originalDiskUnchanged:true,registered:false};
 }
 if(phase==='adoption-approve'){
  const fresh=JSON.parse(await readFile('C:/MuLab/approved/adoption-review-result.json','utf8')).nested.reviewed;
  const adopted=await adoptProtectedStorage(client,fresh,fresh.review.name);assert.equal(adopted.platformId,seed.platformId);assert.equal(adopted.diskPreserved,true);
  pass('A separate new recovery process verifies the saved review and restores only registration of the original GUID and disk, leaving the VM Off');
  await assert.rejects(adoptProtectedStorage(client,fresh,fresh.review.name),{code:'RECOVERY_REVIEW_CHANGED'});await assert.rejects(client.call('start',{id:c.id}),{code:'DENIED'});
  const confirmed=await operator('inspect-adopted',nonce);assert.equal(confirmed.diskSha256,fresh.review.diskSha256);assert.equal(confirmed.registryMatches,true);
  pass('One successful adoption closes publication for that session and still grants no VM runtime authority');
  return {id:c.id,platformId:seed.platformId,registered:true,originalDiskUnchanged:true,reopenRequired:true};
 }
 assert.equal(phase,'adoption-final');assert.equal(await runtime.recoverCreation(c),true);assert.equal((await runtime.state(c)).platformId,seed.platformId);assert.equal((await runtime.state(c)).state,'Off');pass('A new normal broker session reopens the original adopted allocation');
 try{await runtime.start(c);await runtime.configure(c);assert.equal((await runtime.guest(c,['cat','/workspace/adoption-canary.txt'])).trim(),seed.canary);assert.equal((await runtime.inspectGuard(c)).leaseActive,false);pass('The original disk boots with authenticated dev management and its unchanged canary while business networking stays closed');}finally{await runtime.stop(c);}
 await runtime.remove(c);assert.deepEqual(await client.call('allocation',{id:c.id}),{registered:false});pass('Only the stopped synthetic adopted allocation is removed after the original data has been verified');return {id:c.id,platformId:seed.platformId,originalCanaryPreserved:true,removed:true};
}
