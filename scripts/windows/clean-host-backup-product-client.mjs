// Real HTTP product API and native restore, with synthetic data only.
import assert from 'node:assert/strict';
import {open,readFile,writeFile,rename,readdir,unlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

export async function backupProductAcceptance(client,nonce,pass,runtime,c,seed,{productRoot='C:/MuLab/product/resources/app'}={}){
 const load=file=>import(pathToFileURL(productRoot+'/dist-server/server/platform/windows/'+file+'.js').href);
 const {createWindowsService}=await load('service'),{openWindowsStore}=await load('credentials'),{HyperVRuntime}=await load('runtime'),{windowsEnvironment}=await load('guest'),{openProtectedBackupRead}=await load('backup-reader');
 const archive='C:/MuLab/public/backup-restore-'+nonce+'.mucwin',password='synthetic-restoration-password-'+nonce,root='C:/MuLab/public/restored-runtime-'+nonce,sourceData='C:/MuLab/public/backup-source-store-'+nonce,targetData='C:/MuLab/public/backup-target-store-'+nonce;
 const name='合成产品加密恢复',environment={...windowsEnvironment(c),name,browserUrl:'http://127.0.0.1/',state:'stopped',network:{...windowsEnvironment(c).network,username:'synthetic-restored-user',password:'synthetic-restored-private-password'}};
 let service,oldStore,complete=false,restored=false,imports=0,interrupt=false;
 const broker={call:async(action,args,options)=>{if(action==='backup-import'){imports++;if(interrupt){interrupt=false;return client.call(action,{...args,disk:'C:\\MuLab\\public\\missing-source-'+nonce+'.vhdx'},options);}}return client.call(action,args,options);}};
 async function operator(action){const file='C:/MuLab/public/adoption-'+action+'-request.json';await writeFile(file+'.next',JSON.stringify({nonce,action}));await rename(file+'.next',file);const until=performance.now()+180000;for(;;){try{const value=JSON.parse(await readFile('C:/MuLab/approved/adoption-'+action+'.json','utf8'));if(value.nonce===nonce)return value;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(performance.now()<until,'Restore operator has not acknowledged '+action);await delay(200);}}
 async function launch(runtimeRoot,dataDir){
  service=await createWindowsService({rootDir:productRoot,runtimeRoot,dataDir,runtime:new HyperVRuntime(runtimeRoot,undefined,broker),base:{image:c.image,imageSha256:c.imageSha256}});
  const response=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=response.headers.get('set-cookie').split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),bootstrap=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)[1]);assert.equal(bootstrap.capabilities.backups,true);
  const headers={Cookie:cookie,Authorization:'Bearer '+bootstrap.token,'Content-Type':'application/json'};
  return async(route,body,expected=body?202:200)=>{const response=await fetch(service.url+'/api'+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify({route,code:value.code}));return value;};
 }
 async function finish(api,job,phase='succeeded'){await service.manager.wait(job.id);const state=await api('/windows/backups');assert.equal(state.phase,phase,state.message);return state;}
 try{
  const original=await openProtectedBackupRead(client,c.id);let info;try{info=original.info;}finally{await original.close();}
  let api=await launch('C:/MuLab/public/adoption-runtime',sourceData);service.manager.store.save(environment);
  assert.equal((await fetch(service.url+'/api/windows/backups')).status,401);
  await api('/windows/backups/export',{id:c.id,path:archive,password,passwordConfirmation:'different-synthetic-password',confirmation:name},400);
  await finish(api,await api('/windows/backups/export',{id:c.id,path:archive,password,passwordConfirmation:password,confirmation:name}));
  pass('The real authenticated product API exports a stopped original VM with double password and name confirmation');
  const existing=await finish(api,await api('/windows/backups/export',{id:c.id,path:archive,password,passwordConfirmation:password,confirmation:name}),'failed');assert.ok(existing.message.includes('已存在'));
  pass('A second product export refuses the existing encrypted file without replacing it');
  await service.close();service=undefined;oldStore=await openWindowsStore(sourceData);
  api=await launch(root,targetData);
  await finish(api,await api('/windows/backups/review',{path:archive,password:'incorrect-synthetic-password'}),'failed');assert.equal(imports,0);assert.equal(service.manager.store.list().length,0);
  pass('An incorrect password fails the product review without publishing any environment or native import');
  let reviewed=await finish(api,await api('/windows/backups/review',{path:archive,password}));assert.equal(reviewed.review.name,name);assert.equal(reviewed.review.expectedIp,c.expectedIp);assert.ok(!JSON.stringify(reviewed).includes(password));assert.ok(!JSON.stringify(reviewed).includes('synthetic-restored-private-password'));
  await api('/windows/backups/restore',{token:reviewed.review.token,confirmation:'wrong-name'},400);
  pass('Full product review exposes only the restored configuration summary and requires the complete original name');
  await finish(api,await api('/windows/backups/restore',{token:reviewed.review.token,confirmation:name}),'failed');assert.equal(imports,0);assert.equal((await runtime.state(c)).state,'Off');
  pass('The product commit refuses a still-registered source and preserves its stopped VM');
  const preserved=await operator('preserve-restore-source');assert.equal(preserved.originalDiskSha256,info.sha256);assert.equal(preserved.sourceCopyVerified,true);await runtime.remove(c);assert.deepEqual(await client.call('allocation',{id:c.id}),{registered:false});
  pass('An independent administrator preserves the complete byte-verified original before the synthetic source allocation is retired');
  const damage=await open(archive,'r+');let last,position;
  try{position=(await damage.stat()).size-1;last=Buffer.alloc(1);await damage.read(last,0,1,position);await damage.write(Buffer.from([last[0]^1]),0,1,position);await damage.sync();await finish(api,await api('/windows/backups/review',{path:archive,password}),'failed');assert.equal(imports,0);assert.equal(service.manager.store.list().length,0);}finally{if(last){await damage.write(last,0,1,position);await damage.sync();}await damage.close();}
  pass('A corrupted final tag is rejected by full product review before any VM publication');
  reviewed=await finish(api,await api('/windows/backups/review',{path:archive,password}));interrupt=true;
  await finish(api,await api('/windows/backups/restore',{token:reviewed.review.token,confirmation:name}),'failed');assert.equal((await client.call('allocation',{id:c.id})).backupRestorePending,true);await assert.rejects(client.call('start',{id:c.id}),{code:'RESTORE_PENDING'});await assert.rejects(client.call('prepare',{id:c.id}),{code:'RESTORE_PENDING'});
  pass('An actual native source-read failure leaves a resumable product restore and refuses startup or rebuild');
  reviewed=await finish(api,await api('/windows/backups/review',{path:archive,password}));const token=reviewed.review.token;
  const done=await finish(api,await api('/windows/backups/restore',{token,confirmation:name}));restored=true;assert.equal(done.bytes,info.bytes);await api('/windows/backups/restore',{token,confirmation:name},409);assert.equal(service.manager.store.get(c.id).state,'stopped');const state=await service.manager.runtime.state(c);assert.equal(state.state,'Off');assert.notEqual(state.platformId,seed.platformId);
  pass('A fresh one-use product review resumes the exact backup into a new stopped protected Hyper-V VM');
  const target=service.manager.store,sourceRaw=JSON.parse(oldStore.db.prepare('SELECT config FROM environments WHERE id=?').get(c.id).config),targetRaw=JSON.parse(target.db.prepare('SELECT config FROM environments WHERE id=?').get(c.id).config);assert.notEqual(sourceRaw.network.password,targetRaw.network.password);assert.throws(()=>oldStore.decrypt(targetRaw.network.password));assert.notDeepEqual(oldStore.key,target.key);assert.equal(target.get(c.id).network.password,'synthetic-restored-private-password');
  pass('Product restore re-encrypts its secret with a new actual DPAPI-backed target store');
  const pinned=await openProtectedBackupRead(client,c.id);try{assert.equal(pinned.info.sha256,info.sha256);assert.equal(pinned.info.bytes,info.bytes);}finally{await pinned.close();}
  pass('The complete restored disk SHA-256 equals the preserved original before its first boot');
  const restoredRuntime=service.manager.runtime;await restoredRuntime.start(c);await restoredRuntime.configure(c);assert.equal((await restoredRuntime.guest(c,['id','-u'])).trim(),'2001');assert.equal((await restoredRuntime.guest(c,['cat','/workspace/adoption-canary.txt'])).trim(),seed.canary);assert.equal((await restoredRuntime.inspectGuard(c)).leaseActive,false);await restoredRuntime.stop(c);
  pass('The VM restored through the product API boots and reads its original Linux canary with business egress closed');
  await restoredRuntime.remove(c);restored=false;target.remove(c.id);assert.deepEqual(await client.call('allocation',{id:c.id}),{registered:false});assert.equal((await readdir(root)).filter(value=>value.startsWith('backup-work-')).length,0);await operator('verify-preserved-source');await service.close();service=undefined;await unlink(archive);complete=true;
  pass('Product-restored resources, staging and encrypted fixture are removed while the independent original copy stays unchanged');
  return{id:c.id,originalPlatformId:seed.platformId,restoredPlatformId:state.platformId,diskBytes:info.bytes,originalCopyPreserved:true,originalCanaryRestored:true,newDpapiStore:true,sameUserOnly:true,vmRestoreExercised:true,productApiExercised:true,desktopUiExercised:false,removed:true};
 }finally{if(restored)await service?.manager.runtime.stop(c).catch(()=>{});await service?.close();oldStore?.close();oldStore?.key.fill(0);if(!complete){/* Retain failed original artifacts for inspection. */}}
}
