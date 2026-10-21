import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,access,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {WindowsSetup} from '../server/platform/windows/setup.ts';
import {windowsBaseSchema,windowsConfigSchema} from '../server/platform/windows/config.ts';
import {CANONICAL_NOCLOUD_PATCH,HyperVRuntime} from '../server/platform/windows/runtime.ts';
import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
const sha='a'.repeat(64),base={image:'mu-base:'+sha,imageSha256:sha};
test('Sealed base references bind their digest and reject paths disguised as capabilities',()=>{
 assert.deepEqual(windowsBaseSchema.parse(base),base);
 for(const image of ['mu-base:'+sha+'/disk.vhdx','mu-base:../image','mu-base:'+sha.toUpperCase()])assert.equal(windowsBaseSchema.safeParse({...base,image}).success,false);
 assert.equal(windowsBaseSchema.safeParse({...base,imageSha256:'b'.repeat(64)}).success,false);
});
test('A complete environment config projects only its base descriptor into the sealed verifier',async()=>{
 const seen:object[]=[],broker={call:async(action:string,parameters:object)=>{seen.push({action,...parameters});return{ready:true,...base};}} as unknown as HyperVBrokerClient,runtime=new HyperVRuntime(path.resolve('.'),undefined,broker);
 const config=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:'203.0.113.10'});
 assert.deepEqual(await runtime.verifySealedBase(config),base);assert.deepEqual(seen,[{action:'base-status',imageSha256:sha}]);
});
async function fixture(options:{failCleanup?:boolean;failVerify?:boolean}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-setup-'));await mkdir(path.join(root,'setup'));const events:string[]=[];
 const c=windowsConfigSchema.parse({version:1,id:randomUUID(),image:path.join(root,'official.vhd'),imageSha256:CANONICAL_NOCLOUD_PATCH.sourceSha256,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:'203.0.113.10'});
 await writeFile(path.join(root,'setup/state.json'),JSON.stringify({version:1,builder:c,base,status:'failed',phase:'cleaning'}));
 const runtime={info:async()=>({available:true,issues:[]}),disconnect:async()=>{},discardBaseBuilder:async()=>{events.push('clean');if(options.failCleanup)throw Error('Synthetic unconfirmed cleanup');},verifySealedBase:async()=>{events.push('verify');if(options.failVerify)throw Error('Synthetic changed base');return base;}} as unknown as HyperVRuntime;
 let published=false;const setup=new WindowsSetup(runtime,root,{canPrepare:()=>true,publish:()=>{events.push('publish');published=true;}});await setup.initialize();
 return{root,events,setup,published:()=>published,close:async()=>{await setup.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};
}
test('A recovered sealed image is published only after builder cleanup and fresh verification',{skip:process.platform!=='win32'},async()=>{const f=await fixture();try{assert.equal(f.setup.snapshot().status,'interrupted');f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'ready');assert.deepEqual(f.events,['clean','verify','publish']);assert.equal(f.published(),true);assert.deepEqual(JSON.parse(await readFile(path.join(f.root,'protected-desktop-base.json'),'utf8')),base);}finally{await f.close();}});
test('Unconfirmed builder cleanup cannot publish or advertise a ready base',{skip:process.platform!=='win32'},async()=>{const f=await fixture({failCleanup:true});try{f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.equal(f.setup.snapshot().phase,'cleaning');assert.equal(f.published(),false);await assert.rejects(access(path.join(f.root,'protected-desktop-base.json')),{code:'ENOENT'});}finally{await f.close();}});
test('A changed protected image cannot be published during recovery',{skip:process.platform!=='win32'},async()=>{const f=await fixture({failVerify:true});try{f.setup.start();await f.setup.wait();assert.equal(f.setup.snapshot().status,'failed');assert.equal(f.published(),false);await assert.rejects(access(path.join(f.root,'protected-desktop-base.json')),{code:'ENOENT'});}finally{await f.close();}});
test('Cancelling recovery keeps its verified base unpublished after safe builder cleanup',{skip:process.platform!=='win32'},async()=>{const f=await fixture();try{f.setup.start();f.setup.cancel();await f.setup.wait();assert.equal(f.setup.snapshot().status,'cancelled');assert.equal(f.published(),false);assert.deepEqual(f.events,['clean']);}finally{await f.close();}});
