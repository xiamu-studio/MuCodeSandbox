import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {openWindowsStore,protectCurrentUser} from '../server/platform/windows/credentials.ts';
import {recoveryCandidates} from '../server/platform/windows/recovery-candidates.ts';
import {WindowsRecoveryWizard} from '../server/platform/windows/recovery-wizard.ts';
import {createWindowsRecoveryService} from '../server/platform/windows/recovery-service.ts';
import {windowsPaths} from '../server/platform/windows/config.ts';
import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
import type {Environment} from '../shared/types.ts';
import type {WindowsRecoveryCandidate} from '../shared/windows-recovery.ts';
const id='12345678-1234-4234-8234-123456789012',platformId='87654321-4321-4321-8321-210987654321',digest='a'.repeat(64),plan='b'.repeat(64);
const candidate:WindowsRecoveryCandidate={id,name:'原环境合成验收',cpus:1,memoryGiB:2,diskGiB:32,platformId,imageSha256:digest,ready:true,issue:null};
const reviewed={review:{version:1,id,name:'mu-win-'+id.replaceAll('-',''),platformId,cpus:1,memoryGiB:2,diskGiB:32,imageSha256:digest,diskSha256:'c'.repeat(64),seedSha256:'d'.repeat(64),registryFingerprint:'e'.repeat(64),registeredDiskGiB:0},plan,registered:false,state:'Off',diskPreserved:true};
const approved={registered:true,id,platformId,state:'Off',diskPreserved:true,reopenRequired:true};
function broker(call:(action:string,body:Record<string,unknown>,options?:{signal?:AbortSignal})=>Promise<unknown>){return {call} as HyperVBrokerClient;}
const loaded=()=>Promise.resolve({candidates:[structuredClone(candidate)],issue:null,bindings:new Map([[id,'synthetic-private-binding']])});
test('Recovery requires an unchanged original VM identity before presenting a confirmation',async()=>{
 const calls:string[]=[];const wizard=new WindowsRecoveryWizard(broker(async action=>{calls.push(action);return {...reviewed,review:{...reviewed.review,platformId:randomUUID()}};}),loaded);await wizard.refresh();wizard.review(id);await wizard.wait();assert.equal(wizard.snapshot().phase,'failed');assert.equal(wizard.snapshot().review,null);assert.deepEqual(calls,['recovery-review']);
});
test('Recovery rejects wrong names and stale views, then publishes only its saved review and closes further mutation',async()=>{
 const calls:{action:string;body:Record<string,unknown>}[]=[];const wizard=new WindowsRecoveryWizard(broker(async(action,body)=>{calls.push({action,body});return action==='recovery-review'?reviewed:approved;}),loaded);await wizard.refresh();wizard.review(id);await wizard.wait();assert.equal(wizard.snapshot().phase,'reviewed');
 const altered=wizard.snapshot();altered.review!.plan='f'.repeat(64);assert.throws(()=>wizard.adopt(id,altered.review!.plan,candidate.name),{code:'RECOVERY_REVIEW_REQUIRED'});assert.throws(()=>wizard.adopt(id,plan,'wrong'),{code:'RECOVERY_CONFIRMATION_REQUIRED'});assert.equal(calls.length,1);
 wizard.adopt(id,plan,candidate.name);assert.throws(()=>wizard.review(id),{code:'RECOVERY_BUSY'});await wizard.wait();assert.equal(wizard.snapshot().phase,'completed');assert.equal(calls[1].body.confirmName,reviewed.review.name);assert.equal(calls[1].body.plan,plan);assert.throws(()=>wizard.review(id),{code:'RECOVERY_REOPEN_REQUIRED'});await wizard.close();
});
test('Recovery cancels a real pending broker request and serializes refresh with review',async()=>{
 let cancelled=false,release!:()=>void;const loading=new Promise<void>(resolve=>{release=resolve;});
 const wizard=new WindowsRecoveryWizard(broker(async(_action,_body,options)=>new Promise((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>{cancelled=true;reject(Object.assign(Error('cancelled'),{code:'CANCELLED'}));},{once:true});})),async()=>{await loading;return loaded();});
 const refresh=wizard.refresh();assert.throws(()=>wizard.review(id),{code:'RECOVERY_BUSY'});release();await refresh;wizard.review(id);await Promise.resolve();assert.throws(()=>wizard.review(id),{code:'RECOVERY_BUSY'});await assert.rejects(wizard.refresh(),{code:'RECOVERY_BUSY'});wizard.cancel();await wizard.wait();assert.equal(cancelled,true);assert.equal(wizard.snapshot().phase,'cancelled');assert.equal(wizard.snapshot().review,null);await wizard.close();
});
test('Changed local management records cannot use an earlier reviewed approval',async()=>{
 let current=structuredClone(candidate),published=false;const wizard=new WindowsRecoveryWizard(broker(async action=>{if(action==='recovery-adopt')published=true;return action==='recovery-review'?reviewed:approved;}),async()=>({...await loaded(),candidates:[current]}));await wizard.refresh();wizard.review(id);await wizard.wait();current={...current,imageSha256:'f'.repeat(64)};wizard.adopt(id,plan,candidate.name);await wizard.wait();assert.equal(wizard.snapshot().phase,'failed');assert.equal(published,false);await wizard.close();
});

test('Cancelling during the final local material read cannot publish a reviewed approval',async()=>{
 let reads=0,release!:()=>void,started!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{started=resolve;});
 const wizard=new WindowsRecoveryWizard(broker(async()=>reviewed),async()=>{if(++reads===2){started();await pending;}return loaded();});
 try{await wizard.refresh();wizard.review(id);await reading;wizard.cancel();release();await wizard.wait();assert.equal(wizard.snapshot().phase,'cancelled');assert.equal(wizard.snapshot().review,null);}finally{release?.();await wizard.close();}
});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-recovery-ui-')),dataDir=path.join(root,'app'),runtimeRoot=path.join(root,'runtime');await mkdir(runtimeRoot);await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!doctype html><html><head><!-- MU_BOOTSTRAP --></head><body>fixture</body></html>');
 const store=await openWindowsStore(dataDir),env={...candidate,instanceName:reviewed.review.name,description:'',kind:'vm',color:'blue',mounts:[],ports:[],identity:{timezone:'UTC',locale:'en-US'},state:'error',lastError:null,browserRunning:false,browserUrl:'about:blank',createdAt:'',updatedAt:'',network:{mode:'http',host:'127.0.0.1',port:9,username:'',noProxy:'',password:'private-synthetic-recovery-password',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.90'}}} as Environment;
 store.save(env);store.newJob(id,'start');const p=windowsPaths(runtimeRoot,id);await mkdir(p.directory);await writeFile(p.manifest,JSON.stringify({version:1,id,platformId,imageSha256:digest,purpose:'environment'}));for(const file of [p.key,p.hostKey,p.knownHosts])await writeFile(file,'synthetic management material');
 const hash=async()=>Object.fromEntries(await Promise.all(['credentials.dpapi','state.sqlite','state.sqlite-wal'].map(async name=>[name,createHash('sha256').update(await readFile(path.join(dataDir,name))).digest('hex')])));
 const dispose=async()=>{store.close();store.key.fill(0);assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-recovery-ui-/);await rm(root,{recursive:true,force:true});};return {root,dataDir,runtimeRoot,store,hash,dispose};
}
test('Recovery reads existing DPAPI and SQLite records without creating keys, exposing credentials or rewriting interrupted jobs',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();try{const before=await f.hash(),data=await recoveryCandidates(f.dataDir,f.runtimeRoot);assert.equal(data.candidates.length,1);assert.equal(data.candidates[0].ready,true);assert.ok(!JSON.stringify(data).includes('password'));assert.ok(!JSON.stringify(data).includes(f.root));assert.deepEqual(await f.hash(),before);assert.equal(f.store.jobs()[0].status,'running');await unlink(path.join(f.dataDir,'credentials.dpapi'));assert.equal((await recoveryCandidates(f.dataDir,f.runtimeRoot)).candidates.length,0);await assert.rejects(readFile(path.join(f.dataDir,'credentials.dpapi')),{code:'ENOENT'});}finally{await f.dispose();}
});

test('Recovery refuses changed original material before adopting a reviewed VM',{skip:process.platform!=='win32'},async t=>{
 for(const material of ['management','hostKey','knownHosts','manifest','network','credentials'] as const)await t.test(material,async()=>{
  const f=await fixture();let published=false;
  const wizard=new WindowsRecoveryWizard(broker(async action=>{if(action==='recovery-adopt')published=true;return action==='recovery-review'?reviewed:approved;}),()=>recoveryCandidates(f.dataDir,f.runtimeRoot));
  try{
   await wizard.refresh();wizard.review(id);await wizard.wait();assert.equal(wizard.snapshot().phase,'reviewed');
   const p=windowsPaths(f.runtimeRoot,id);
   if(material==='network'){const e=f.store.get(id);e.network.password='replacement-synthetic-password';f.store.save(e);}
   else if(material==='credentials')await writeFile(path.join(f.dataDir,'credentials.dpapi'),await protectCurrentUser(f.store.key,'protect'));
   else if(material==='manifest')await writeFile(p.manifest,JSON.stringify({...JSON.parse(await readFile(p.manifest,'utf8')),note:'changed synthetic metadata'}));
   else await writeFile(material==='management'?p.key:material==='hostKey'?p.hostKey:p.knownHosts,'replacement synthetic material');
   wizard.adopt(id,plan,candidate.name);await wizard.wait();assert.equal(wizard.snapshot().phase,'failed');assert.equal(published,false);
   assert.ok(!JSON.stringify(wizard.snapshot()).includes('replacement'));assert.equal(f.store.jobs()[0].status,'running');
  }finally{await wizard.close();await f.dispose();}
 });
});

test('Recovery refuses material changed during native review and permits a fresh review without exposing its binding',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();let change=true,published=0;
 const wizard=new WindowsRecoveryWizard(broker(async action=>{
  if(action==='recovery-review'&&change){change=false;await writeFile(windowsPaths(f.runtimeRoot,id).key,'changed during synthetic native review');}
  if(action==='recovery-adopt')published++;return action==='recovery-review'?reviewed:approved;
 }),()=>recoveryCandidates(f.dataDir,f.runtimeRoot));
 try{
  const snapshot=await wizard.refresh();assert.equal(Object.hasOwn(snapshot,'bindings'),false);
  const privateBinding=(await recoveryCandidates(f.dataDir,f.runtimeRoot)).bindings.get(id)!;assert.equal(privateBinding.length,64);assert.ok(!JSON.stringify(snapshot).includes(privateBinding));
  wizard.review(id);await wizard.wait();assert.equal(wizard.snapshot().phase,'failed');assert.equal(wizard.snapshot().review,null);assert.equal(published,0);
  await wizard.refresh();wizard.review(id);await wizard.wait();assert.equal(wizard.snapshot().phase,'reviewed');wizard.adopt(id,plan,candidate.name);await wizard.wait();assert.equal(wizard.snapshot().phase,'completed');assert.equal(published,1);
  assert.equal(Object.hasOwn(wizard.snapshot(),'bindings'),false);assert.equal(f.store.jobs()[0].status,'running');
 }finally{await wizard.close();await f.dispose();}
});

test('Recovery refuses hardlinked management material and leaves the original bytes intact',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();const p=windowsPaths(f.runtimeRoot,id),alias=path.join(f.root,'synthetic-management-alias');
 try{
  const before=await f.hash(),key=await readFile(p.key);await link(p.key,alias);
  const data=await recoveryCandidates(f.dataDir,f.runtimeRoot);assert.equal(data.candidates[0].ready,false);assert.equal(data.bindings.has(id),false);assert.deepEqual(await readFile(alias),key);assert.deepEqual(await f.hash(),before);
  await unlink(alias);assert.equal((await recoveryCandidates(f.dataDir,f.runtimeRoot)).candidates[0].ready,true);
 }finally{await f.dispose();}
});
test('Recovery loopback service authenticates its exact UI and offers no ordinary VM operations',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();let service:Awaited<ReturnType<typeof createWindowsRecoveryService>>|undefined,returns=0;const calls:string[]=[];
 const native=broker(async action=>{calls.push(action);if(action==='recovery-info')return {mode:'recovery',registeredIds:[],publicationAttempted:false};return action==='recovery-review'?reviewed:approved;});
 try{
  const before=await f.hash();service=await createWindowsRecoveryService({rootDir:f.root,dataDir:f.dataDir,runtimeRoot:f.runtimeRoot,broker:native,returnToNormal:()=>{returns++;}});assert.equal((await fetch(service.url)).status,403);assert.equal((await fetch(service.url+'/api/windows/recovery')).status,401);
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0],page=await fetch(service.url,{headers:{Cookie:cookie}});const config=JSON.parse((await page.text()).match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]);assert.equal(config.windowsMode,'recovery');assert.equal(config.capabilities.terminal,false);const headers={Cookie:cookie,Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  assert.equal((await fetch(service.url+'/api/windows/recovery',{headers:{Authorization:headers.Authorization}})).status,401);assert.equal((await fetch(service.url+'/api/windows/recovery',{headers:{...headers,Origin:'http://outside.invalid'}})).status,403);
  const wrongHost=await new Promise<number>(resolve=>{const req=httpRequest(service!.url+'/api/windows/recovery',{headers:{...headers,Host:'outside.invalid'}},res=>{res.resume();resolve(res.statusCode!);});req.end();});assert.equal(wrongHost,403);
  for(const url of ['/api/environments','/api/environments/'+id+'/actions/start','/api/windows/host','/api/environments/'+id+'/terminal-ticket'])assert.equal((await fetch(service.url+url,{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(service.url+'/api/windows/recovery/review',{method:'POST',headers,body:JSON.stringify({id,imageSha256:digest,directory:'C:\\outside'})})).status,400);assert.deepEqual(calls,['recovery-info']);
  assert.equal((await fetch(service.url+'/api/windows/recovery/review',{method:'POST',headers,body:JSON.stringify({id})})).status,202);await service.wizard.wait();assert.equal(service.wizard.snapshot().phase,'reviewed');
  assert.equal((await fetch(service.url+'/api/windows/recovery/adopt',{method:'POST',headers,body:JSON.stringify({id,plan,confirmation:'wrong'})})).status,400);assert.ok(!calls.includes('recovery-adopt'));
  assert.equal((await fetch(service.url+'/api/windows/recovery/adopt',{method:'POST',headers,body:JSON.stringify({id,plan,confirmation:candidate.name})})).status,202);await service.wizard.wait();assert.equal(service.wizard.snapshot().phase,'completed');assert.equal(calls.filter(value=>value==='recovery-adopt').length,1);
  assert.equal((await fetch(service.url+'/api/windows/recovery/reopen',{method:'POST',headers,body:'{}'})).status,200);assert.equal(returns,1);assert.deepEqual(await f.hash(),before);assert.equal(f.store.jobs()[0].status,'running');
 }finally{await service?.close();await f.dispose();}
});
