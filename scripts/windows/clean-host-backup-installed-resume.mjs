// Continue the exact stopped VM from the failed preview.16 fixture, without reinstalling.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const caseId=process.argv[2];assert.match(caseId,/^[a-f0-9]{32}$/);assert.equal(process.env.COMPUTERNAME,'MU-CLEAN-LAB');
const root='C:/MuLab/public/backup-preview14-'+caseId,meta=JSON.parse(await readFile(root+'/case.json','utf8')),app=meta.installed.replaceAll('\\','/')+'/resources/app';
assert.equal(meta.caseId,caseId);assert.equal(meta.version,'0.4.66-preview.16');assert.equal(process.execPath.toLowerCase().replaceAll('\\','/'),(meta.installed.replaceAll('\\','/')+'/resources/node/node.exe').toLowerCase());
const load=name=>import(pathToFileURL(app+'/dist-server/server/platform/windows/'+name+'.js').href);
const {HyperVBrokerClient,brokerSourceDigest}=await load('broker'),{HyperVRuntime}=await load('runtime'),{createWindowsService}=await load('service'),{openProtectedBackupRead}=await load('backup-reader');
const nonce=randomBytes(32).toString('hex'),client=new HyperVBrokerClient(nonce),checks=[];
let service,complete=false,error,nested,observed;
const save=(name,value)=>writeFile(root+'/resume-'+name+'.json',JSON.stringify({caseId,nonce,pid:process.pid,...value},null,2));
const pass=async name=>{checks.push({name,passed:true});await save('progress',{checks});};
await save('owner',{});
try{
 const until=performance.now()+120000;for(;;){try{assert.equal((await client.hello()).sourceDigest,await brokerSourceDigest());break;}catch(e){if(e.code!=='BROKER_UNAVAILABLE'||performance.now()>until)throw e;await delay(250);}}
 const source=new HyperVRuntime(root+'/source-runtime',undefined,client);
 async function launch(runtimeRoot,dataDir,runtime){
  service=await createWindowsService({rootDir:app,runtimeRoot,dataDir,runtime});assert.equal(service.manager.options.base,undefined);
  const original=service.manager.runMaintenance.bind(service.manager);service.manager.runMaintenance=(action,work)=>original(action,async signal=>{try{return await work(signal);}catch(e){observed={name:e.name,code:e.code??null,message:String(e.message).slice(0,2000)};throw e;}});
  const response=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=response.headers.get('set-cookie').split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)[1]);assert.equal(config.capabilities.backups,true);const headers={Cookie:cookie,Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  return async(route,body)=>{const r=await fetch(service.url+'/api'+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,value.code);return value;};
 }
 const finish=async(api,job)=>{await service.manager.wait(job.id);const value=await api('/windows/backups');assert.equal(value.phase,'succeeded',JSON.stringify(observed??{message:value.message}));return value;};
 let api=await launch(root+'/source-runtime',root+'/source-app',source);const environments=service.manager.store.list();assert.equal(environments.length,1);const environment=environments[0];assert.equal(environment.state,'stopped');assert.equal(environment.browserUrl,'about:blank');
 const diagnostic=JSON.parse(await readFile(root+'/diagnostic-result.json','utf8'));assert.equal(diagnostic.complete,true);assert.equal(diagnostic.id,environment.id);assert.equal(diagnostic.observed.name,'ZodError');assert.deepEqual(diagnostic.observed.issues.map(i=>i.path),[['browserUrl']]);
 const sourceConfig=await service.manager.profile(environment,false),originalId=(await source.state(sourceConfig)).platformId,manifest=JSON.parse(await readFile(root+'/source-runtime/mu-win-'+environment.id.replaceAll('-','')+'/manifest.json','utf8'));assert.equal(manifest.platformId,originalId);
 await pass('The actual installed Node resumes the exact failed source VM, management identity and DPAPI store without importing or reinstalling');
 await source.start(sourceConfig);await source.configure(sourceConfig);const canary=(await source.guest(sourceConfig,['cat','/workspace/preview14.txt'])).trim();assert.match(canary,/^preview14-[a-f0-9-]{36}$/);assert.equal((await source.inspectGuard(sourceConfig)).leaseActive,false);await source.stop(sourceConfig);
 // windowsEnvironment is an internal guest-helper model, not a validated UI config.
 service.manager.store.save({...environment,browserUrl:'http://127.0.0.1/'});
 await pass('The original Linux canary is read before export with business egress closed; only the invalid fixture browser URL is corrected');
 const original=await openProtectedBackupRead(client,environment.id);let disk;try{disk=original.info;}finally{await original.close();}
 const archive=root+'/resume-archive.mucwin',password='synthetic-preview16-resume-'+caseId;
 await finish(api,await api('/windows/backups/export',{id:environment.id,path:archive,password,passwordConfirmation:password,confirmation:environment.name}));await service.close();service=undefined;
 await pass('The unchanged installed product API exports the original stopped disk after the fixture correction');
 await save('preserve-request',{id:environment.id,platformId:originalId,disk,canary});
 const preserveUntil=performance.now()+180000;for(;;){try{const value=JSON.parse(await readFile(root+'/resume-preserved.json','utf8'));if(value.nonce===nonce){assert.equal(value.sha256,disk.sha256);break;}}catch(e){if(e.code!=='ENOENT')throw e;}assert.ok(performance.now()<preserveUntil,'Independent original disk preservation pending');await delay(250);}
 await source.remove(sourceConfig);await pass('An independent administrator preserves and hashes the original disk before only its synthetic source allocation is retired');
 let bootRead=false;
 class ObservedRuntime extends HyperVRuntime{async session(config,...args){assert.equal((await this.guest(config,['cat','/workspace/preview14.txt'])).trim(),canary);assert.equal((await this.inspectGuard(config)).leaseActive,false);bootRead=true;return super.session(config,...args);}}
 const target=new ObservedRuntime(root+'/resume-target-runtime',undefined,client);api=await launch(root+'/resume-target-runtime',root+'/resume-target-app',target);
 const reviewed=await finish(api,await api('/windows/backups/review',{path:archive,password}));assert.equal(reviewed.review.name,environment.name);await finish(api,await api('/windows/backups/restore',{token:reviewed.review.token,confirmation:environment.name}));
 assert.equal(service.manager.store.get(environment.id).network.password,'synthetic-preview14-secret');const c=await service.manager.profile(service.manager.store.get(environment.id),false),state=await target.state(c);assert.equal(state.state,'Off');assert.notEqual(state.platformId,originalId);
 const restored=await openProtectedBackupRead(client,environment.id);try{assert.equal(restored.info.sha256,disk.sha256);assert.equal(restored.info.bytes,disk.bytes);}finally{await restored.close();}
 await pass('Installed review and restore produce a new Off VM with the complete original disk digest and a new target DPAPI store');
 const job=await api('/environments/'+environment.id+'/actions/start',{});await service.manager.wait(job.id);assert.equal(bootRead,true);assert.equal(service.manager.store.jobs().find(j=>j.id===job.id).status,'failed');assert.equal((await target.state(c)).state,'Off');
 await pass('The installed product start path reads original Linux data without a base and confirms stop after deliberately offline egress verification');
 await target.remove(c);service.manager.store.remove(c.id);await service.close();service=undefined;assert.equal((await readdir(root+'/resume-target-runtime')).filter(n=>n.startsWith('backup-work-')).length,0);await unlink(archive);
 await pass('Restored allocation, private staging and encrypted synthetic output are removed while the independent original copy remains');
 nested={id:environment.id,originalPlatformId:originalId,restoredPlatformId:state.platformId,diskBytes:disk.bytes,diskSha256:disk.sha256,bootRead:true,noBase:true,offlineStartFailedClosed:true,removed:true};complete=true;
}catch(e){error={name:e.name,message:e.message,code:e.code??null,stack:e.stack};}
finally{await service?.close().catch(e=>{complete=false;error??={message:e.message};});await client.call('shutdown').catch(()=>{});await save('result',{complete,checks,error,observed,nested,version:meta.version,desktopMainExercised:false,guiInstallerExercised:false});}
if(!complete)process.exitCode=1;
