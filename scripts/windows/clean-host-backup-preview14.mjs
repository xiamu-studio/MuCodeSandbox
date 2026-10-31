// Isolated preview.13 -> preview.14 CLI upgrade and installed-Node VM round trip.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.env.COMPUTERNAME,'MU-CLEAN-LAB');
const [mode,caseId]=process.argv.slice(2);assert.match(caseId,/^[a-f0-9]{32}$/);assert.ok(['upgrade','verify'].includes(mode));
const root='C:/MuLab/public/backup-preview14-'+caseId,meta=JSON.parse(await readFile(root+'/case.json','utf8'));
assert.equal(meta.caseId,caseId);const installed=meta.installed.replaceAll('\\','/'),app=installed+'/resources/app';
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const execute=async(file,args)=>{const p=spawn(file,args,{shell:false,windowsHide:true,windowsVerbatimArguments:true,stdio:'ignore',env:{...process.env,TEMP:(root+'/temp').replaceAll('/','\\'),TMP:(root+'/temp').replaceAll('/','\\'),MU_WINDOWS_INSTALL_TRACE:(root+'/installer-trace.txt').replaceAll('/','\\')}});const [code]=await once(p,'exit');assert.equal(code,0);};
const checks=[],pass=name=>checks.push({name,passed:true}),save=(name,data)=>writeFile(root+'/'+name+'.json',JSON.stringify(data,null,2));
let complete=false,error,service,client,nested;
try{
 if(mode==='upgrade'){
  await mkdir(root+'/temp',{recursive:true});
  assert.equal(meta.version,'0.4.66-preview.16');assert.equal(await hash(root+'/setup.exe'),meta.installerSha256);
  const fromVersion=JSON.parse(await readFile(app+'/package.json','utf8')).version;assert.ok(['0.4.66-preview.13','0.4.66-preview.15',meta.version].includes(fromVersion));
  // The incoming installer must recover any retained transaction itself.
  await execute(root+'/setup.exe',['/S','/currentuser','/D='+meta.installed]);
  assert.equal(JSON.parse(await readFile(app+'/package.json','utf8')).version,meta.version);
  pass('An ordinary user completes the real NSIS '+(fromVersion===meta.version?'repair':'upgrade')+' in the retained Unicode and special-character directory');
  const child=spawn(installed+'/resources/node/node.exe',['--no-warnings','C:/MuLab/backup-preview14.mjs','verify',caseId],{shell:false,windowsHide:true,stdio:'ignore'});
  await save('child',{pid:child.pid});const [code]=await once(child,'exit');assert.equal(code,0);const result=JSON.parse(await readFile(root+'/verify-result.json','utf8'));assert.equal(result.complete,true);nested=result;complete=true;
 }else{
  assert.equal(process.execPath.toLowerCase().replaceAll('\\','/'),(installed+'/resources/node/node.exe').toLowerCase());
  const load=name=>import(pathToFileURL(app+'/dist-server/server/platform/windows/'+name+'.js').href);
  const {HyperVBrokerClient,brokerSourceDigest}=await load('broker'),{HyperVRuntime}=await load('runtime'),{windowsConfigSchema}=await load('config'),{windowsEnvironment}=await load('guest'),{createWindowsService}=await load('service'),{openProtectedBackupRead}=await load('backup-reader');
  const nonce=randomBytes(32).toString('hex');client=new HyperVBrokerClient(nonce);await save('owner',{pid:process.pid,nonce,caseId});
  const deadline=performance.now()+120000;for(;;){try{assert.equal((await client.hello()).sourceDigest,await brokerSourceDigest());break;}catch(e){if(e.code!=='BROKER_UNAVAILABLE'||performance.now()>deadline)throw e;await delay(250);}}
  pass('The actual installed Node process owns the production broker and loads unchanged installed modules');
  const base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8')),c=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9},expectedIp:'203.0.113.90'}),canary='preview14-'+randomUUID();
  const source=new HyperVRuntime(root+'/source-runtime',undefined,client);
  await source.create(c);await source.start(c);await source.configure(c);assert.equal((await source.inspectGuard(c)).leaseActive,false);await source.guest(c,['python3','-c',"from pathlib import Path;Path('/workspace/preview14.txt').write_text("+JSON.stringify(canary)+")"]);await source.stop(c);
  const originalId=(await source.state(c)).platformId;pass('The installed runtime creates and stops a real synthetic Linux disk with a dev canary and closed business network');
  const original=await openProtectedBackupRead(client,c.id);let disk;try{disk=original.info;}finally{await original.close();}
  const archive=root+'/archive.mucwin',password='synthetic-preview14-'+caseId,name='合成 preview14 恢复';
  async function launch(runtimeRoot,dataDir,runtime){service=await createWindowsService({rootDir:app,runtimeRoot,dataDir,runtime});assert.equal(service.manager.options.base,undefined);const response=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=response.headers.get('set-cookie').split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)[1]);assert.equal(config.capabilities.backups,true);const headers={Cookie:cookie,Authorization:'Bearer '+config.token,'Content-Type':'application/json'};return async(route,body)=>{const r=await fetch(service.url+'/api'+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,value.code);return value;};}
  const finish=async(api,job)=>{await service.manager.wait(job.id);const state=await api('/windows/backups');assert.equal(state.phase,'succeeded',state.message);return state;};
  let api=await launch(root+'/source-runtime',root+'/source-app',source);service.manager.store.save({...windowsEnvironment(c),name,state:'stopped',network:{...windowsEnvironment(c).network,password:'synthetic-preview14-secret'}});
  await finish(api,await api('/windows/backups/export',{id:c.id,path:archive,password,passwordConfirmation:password,confirmation:name}));await service.close();service=undefined;pass('The installed product HTTP API exports the actual stopped disk into an authenticated encrypted archive');
  await save('preserve-request',{caseId,nonce,id:c.id,platformId:originalId,disk});
  const until=performance.now()+180000;for(;;){try{const receipt=JSON.parse(await readFile(root+'/preserved.json','utf8'));if(receipt.nonce===nonce){assert.equal(receipt.sha256,disk.sha256);break;}}catch(e){if(e.code!=='ENOENT')throw e;}assert.ok(performance.now()<until,'Independent original copy pending');await delay(250);}
  await source.remove(c);pass('An independent administrator preserves and hashes the original disk before its synthetic source VM is retired');
  let bootRead=false;
  class ObservedRuntime extends HyperVRuntime{async session(config,...args){assert.equal((await this.guest(config,['cat','/workspace/preview14.txt'])).trim(),canary);assert.equal((await this.inspectGuard(config)).leaseActive,false);bootRead=true;return super.session(config,...args);}}
  const target=new ObservedRuntime(root+'/target-runtime',undefined,client);api=await launch(root+'/target-runtime',root+'/target-app',target);
  const reviewed=await finish(api,await api('/windows/backups/review',{path:archive,password}));assert.equal(reviewed.review.name,name);await finish(api,await api('/windows/backups/restore',{token:reviewed.review.token,confirmation:name}));
  assert.equal(service.manager.store.get(c.id).network.password,'synthetic-preview14-secret');const restoredId=(await target.state(c)).platformId;assert.notEqual(restoredId,originalId);assert.equal((await target.state(c)).state,'Off');
  const read=await openProtectedBackupRead(client,c.id);try{assert.equal(read.info.sha256,disk.sha256);assert.equal(read.info.bytes,disk.bytes);}finally{await read.close();}pass('Installed backup review and restore produce a new Off VM with original disk SHA-256 and target DPAPI-encrypted configuration');
  const job=await api('/environments/'+c.id+'/actions/start',{});await service.manager.wait(job.id);assert.equal(bootRead,true);assert.equal(service.manager.store.jobs().find(j=>j.id===job.id).status,'failed');assert.equal((await target.state(c)).state,'Off');pass('The installed product start path boots without a base, reads original Linux data and confirms stop after the deliberately offline egress check');
  await target.remove(c);service.manager.store.remove(c.id);await service.close();service=undefined;assert.equal((await readdir(root+'/target-runtime')).filter(n=>n.startsWith('backup-work-')).length,0);await unlink(archive);pass('The installed controller removes its restored allocation, plaintext staging and encrypted synthetic output');
  nested={id:c.id,originalPlatformId:originalId,restoredPlatformId:restoredId,diskSha256:disk.sha256,diskBytes:disk.bytes,bootRead,noBase:true,offlineStartFailedClosed:true,removed:true};complete=true;
 }
}catch(e){error={message:e.message,code:e.code??null,stack:e.stack};}
finally{await service?.close().catch(e=>{complete=false;error??={message:e.message};});await client?.call('shutdown').catch(()=>{});await save(mode+'-result',{caseId,mode,pid:process.pid,complete,checks,nested,error,installed,version:meta.version,desktopMainExercised:false,guiInstallerExercised:false});}
if(!complete)process.exitCode=1;
