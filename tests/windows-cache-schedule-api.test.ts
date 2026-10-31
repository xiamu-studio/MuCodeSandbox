import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {createWindowsService} from '../server/platform/windows/service.ts';import {WindowsStorage} from '../server/platform/windows/storage.ts';import type {WindowsBackend} from '../server/platform/windows/manager.ts';import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
test('Scheduled cache settings require authenticated UI, persist and reject extra input without deleting anything',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-cache-schedule-api-'));let service:Awaited<ReturnType<typeof createWindowsService>>|undefined;let calls=0;
 try{
  await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
  const unexpected=async()=>{throw Error('Unexpected VM action');};
  const runtime:WindowsBackend&Pick<HyperVRuntime,'fingerprint'>={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:'Off'}),stop:async()=>{},create:unexpected,start:unexpected,session:unexpected,connect:unexpected,inspectGuard:unexpected};
  const storage=()=>new WindowsStorage({call:async()=>{calls++;throw Error('No cleanup expected');}} as never,()=>null,()=>true);
  service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'runtime'),runtime,storageFactory:storage,cacheScheduleIdle:()=>true});
  const url=service.url+'/api/windows/storage/schedule';assert.equal((await fetch(url)).status,401);
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];const html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text();const bootstrap=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]);
  const headers={Cookie:cookie,Authorization:'Bearer '+bootstrap.token,'Content-Type':'application/json'};
  assert.equal((await(await fetch(url,{headers})).json()).enabled,false);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({enabled:true,path:'C:/outside'})})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'http://attacker.invalid'},body:JSON.stringify({enabled:true})})).status,403);
  const enabled=await fetch(url,{method:'POST',headers,body:JSON.stringify({enabled:true})});assert.equal(enabled.status,200);assert.equal((await enabled.json()).enabled,true);
  assert.equal((await(await fetch(url,{headers})).json()).enabled,true);assert.equal(calls,0);
  await service.close();service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'runtime'),runtime,storageFactory:storage,cacheScheduleIdle:()=>true});
  const launch2=await fetch(service.launchUrl(),{redirect:'manual'}),cookie2=launch2.headers.get('set-cookie')!.split(';')[0];const html2=await(await fetch(service.url,{headers:{Cookie:cookie2}})).text();const token2=JSON.parse(html2.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token;
  const headers2={Cookie:cookie2,Authorization:'Bearer '+token2,'Content-Type':'application/json'},url2=service.url+'/api/windows/storage/schedule';assert.equal((await(await fetch(url2,{headers:headers2})).json()).enabled,true);
  const disabled=await fetch(url2,{method:'POST',headers:headers2,body:JSON.stringify({enabled:false})});assert.equal((await disabled.json()).enabled,false);assert.equal(calls,0);
 }finally{await service?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-cache-schedule-api-/);await rm(root,{recursive:true,force:true});}
});
