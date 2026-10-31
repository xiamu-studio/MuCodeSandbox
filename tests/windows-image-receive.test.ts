import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {GuestExchange} from '../server/guest-exchange.ts';import type {Environment} from '../shared/types.ts';
import {readWindowsGuestClipboardImage,WINDOWS_IMAGE_CLIPBOARD_READ} from '../server/platform/windows/clipboard-image-read.ts';
import {receivedWindowsImageBytes} from '../src/windows/clipboard-image.ts';
import {fixturePng} from '../scripts/clipboard-image-fixture.ts';
import {IMAGE_CLIPBOARD_MAX_BYTES} from '../shared/clipboard-image.ts';
const require=createRequire(import.meta.url),{createClipboardImageWriteHandler}=require('../desktop/windows/clipboard-image-write.cjs');
const png=fixturePng(),env={id:'12345678-1234-4234-8234-123456789abc',kind:'vm',updatedAt:'same-session'} as Environment;
function exchange(management:GuestExchange['runtime']['management'],authorize:()=>Promise<Environment>=async()=>env){return new GuestExchange({guest:async()=>{throw Error('Guest task not expected');},management},authorize);}
test('Windows manual image read uses a bounded ordinary display clipboard command and validates its complete PNG',async()=>{
 let calls=0;const x=exchange(async(_e,args,options)=>{calls++;assert.ok(args.includes('dev'));assert.ok(args.includes('env'));assert.ok(args.includes('DISPLAY=:99'));assert.equal(args.at(-1),WINDOWS_IMAGE_CLIPBOARD_READ);assert.equal(options?.maxBytes,4*Math.ceil(IMAGE_CLIPBOARD_MAX_BYTES/3)+256);assert.equal(options?.onOutput,undefined);assert.equal(options?.timeoutMs,6000);return JSON.stringify({data:png.toString('base64')});});
 const result=await readWindowsGuestClipboardImage(x,env.id,new AbortController().signal);assert.deepEqual(result,{data:png.toString('base64'),width:2,height:2,bytes:png.length});assert.equal(calls,1);assert.equal(x.busy.size,0);
});
test('Malformed, oversized, noncanonical and incomplete guest image responses are rejected and release the exchange mutex',async()=>{
 const broken=Buffer.from(png);broken[broken.length-1]^=1;
 for(const value of [{data:'x'.repeat(4*Math.ceil(IMAGE_CLIPBOARD_MAX_BYTES/3)+1)},{data:png.toString('base64')+'\n'},{data:broken.toString('base64')},{data:png.subarray(0,-1).toString('base64')},{data:png.toString('base64'),unexpected:true},{data:Buffer.alloc(45).toString('base64')}]){const x=exchange(async()=>JSON.stringify(value));await assert.rejects(readWindowsGuestClipboardImage(x,env.id,new AbortController().signal));assert.equal(x.busy.size,0);}
});
test('A revoked or busy environment cannot read a PNG; changed authorization and cancellation discard late responses',async()=>{
 let calls=0;const x=exchange(async()=>{calls++;return JSON.stringify({data:png.toString('base64')});},async()=>{throw Error('revoked');});await assert.rejects(readWindowsGuestClipboardImage(x,env.id,new AbortController().signal),/revoked/);assert.equal(calls,0);x.busy.add(env.id);await assert.rejects(readWindowsGuestClipboardImage(x,env.id,new AbortController().signal),/正在传输/);assert.equal(calls,0);x.busy.clear();
 let authorize=0;const changed=exchange(async()=>JSON.stringify({data:png.toString('base64')}),async()=>({...env,updatedAt:String(authorize++)}));await assert.rejects(readWindowsGuestClipboardImage(changed,env.id,new AbortController().signal),/环境已变化/);assert.equal(changed.busy.size,0);
 const abort=new AbortController(),cancelled=exchange(async()=>{abort.abort();return JSON.stringify({data:png.toString('base64')});});await assert.rejects(readWindowsGuestClipboardImage(cancelled,env.id,abort.signal));assert.equal(cancelled.busy.size,0);
});
function desktop(){
 let gesture=true,focused=true,normal=true,epoch=1,url='http://127.0.0.1:12345/',check:undefined|(()=>Promise<void>);const writes:any[]=[],decodes:Buffer[]=[];
 const frame={get url(){return url;},isDestroyed:()=>false},web={mainFrame:frame,isDestroyed:()=>false,getURL:()=>url,async executeJavaScriptInIsolatedWorld(world:number,scripts:any[],userGesture:boolean){assert.equal(world,1001);assert.equal(userGesture,false);assert.equal(scripts[0].code,'Boolean(navigator.userActivation.isActive)');await check?.();return gesture;}};
 const window={webContents:web,isDestroyed:()=>false,isFocused:()=>focused},event={sender:web,senderFrame:frame};
 const handler=createClipboardImageWriteHandler({getState:()=>({window,origin:'http://127.0.0.1:12345',epoch,normal}),clipboard:{async write(items:any[]){writes.push(items);}},ClipboardItem:class{data:any;constructor(data:any){this.data=data;}},nativeImage:{createFromBuffer(data:Buffer){decodes.push(data);assert.deepEqual(data,png);return{isEmpty:()=>false,getSize:()=>({width:2,height:2}),toPNG:()=>png};}}});
 return {event,handler,writes,decodes,set gesture(v:boolean){gesture=v;},set focused(v:boolean){focused=v;},set normal(v:boolean){normal=v;},set epoch(v:number){epoch=v;},set url(v:string){url=v;},set check(v:(()=>Promise<void>)|undefined){check=v;}};
}
test('Windows image copy requires the focused normal root frame and isolated user activation before decoding or writing',async()=>{
 const f=desktop(),input={data:new Uint8Array(png)};for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{url:f.event.senderFrame.url}}])await assert.rejects(f.handler(event,input));
 f.focused=false;await assert.rejects(f.handler(f.event,input));f.focused=true;f.normal=false;await assert.rejects(f.handler(f.event,input));f.normal=true;f.url='http://127.0.0.1:12345/other';await assert.rejects(f.handler(f.event,input));f.url='http://127.0.0.1:12345/';f.gesture=false;await assert.rejects(f.handler(f.event,input));assert.equal(f.writes.length,0);assert.equal(f.decodes.length,0);
 f.gesture=true;assert.deepEqual(await f.handler(f.event,input),{ok:true,width:2,height:2});assert.equal(f.writes.length,1);const items=f.writes[0];assert.equal(items.length,1);assert.deepEqual(Object.keys(items[0].data),['image/png']);assert.deepEqual(Buffer.from(await items[0].data['image/png'].arrayBuffer()),png);
});
test('Invalid and excessive PNG clipboard writes cannot change host content or reach the decoder',async()=>{
 const f=desktop(),huge=Buffer.from(png);huge.writeUInt32BE(16000001,16);
 for(const input of [{},{data:[...png]},{data:new Uint8Array(png),extra:true},{data:new Uint8Array(IMAGE_CLIPBOARD_MAX_BYTES+1)},{data:new Uint8Array(44)},{data:new Uint8Array(huge)}])await assert.rejects(f.handler(f.event,input));assert.equal(f.writes.length,0);assert.equal(f.decodes.length,0);
});
test('Pending image copies reject navigation or overlapping calls and snapshot caller bytes before the asynchronous gesture check',async()=>{
 const f=desktop();let release!:()=>void,entered!:()=>void;let began=new Promise<void>(r=>entered=r);f.check=()=>{entered();return new Promise<void>(r=>release=r);};const original=new Uint8Array(png),first=f.handler(f.event,{data:original});await began;await assert.rejects(f.handler(f.event,{data:original}),/正在复制/);f.epoch=2;release();await assert.rejects(first);assert.equal(f.writes.length,0);
 began=new Promise<void>(r=>entered=r);const pending=f.handler(f.event,{data:original});await began;original.fill(0);release();await pending;assert.equal(f.writes.length,1);assert.deepEqual(f.decodes[0],png);
});
test('A renderer preview accepts only bounded canonical PNG data with matching dimensions and byte length',()=>{
 const valid={data:png.toString('base64'),width:2,height:2,bytes:png.length};assert.deepEqual(Buffer.from(receivedWindowsImageBytes(valid)),png);
 for(const invalid of [{...valid,bytes:png.length+1},{...valid,width:3},{...valid,height:0},{...valid,width:16000001},{...valid,data:valid.data+'\n'},{...valid,data:'x'.repeat(4*Math.ceil(IMAGE_CLIPBOARD_MAX_BYTES/3)+1)}])assert.throws(()=>receivedWindowsImageBytes(invalid));
});
test('Windows image read HTTP authenticates, rejects stopped guests and aborts or discards responses from an old session',{skip:process.platform!=='win32'},async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),path=await import('node:path'),{tmpdir}=await import('node:os'),{setTimeout:delay}=await import('node:timers/promises');
 const {createWindowsService}=await import('../server/platform/windows/service.ts'),{WindowsNetworkSession}=await import('../server/platform/windows/session.ts'),{windowsPaths}=await import('../server/platform/windows/config.ts');
 const root=await mkdtemp(path.join(tmpdir(),'mu-image-read-')),runtimeRoot=path.join(root,'runtime');await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 let state='Off',lease=false,calls=0,wait:undefined|((signal:AbortSignal)=>Promise<void>);const inspect=async()=>({digest:'a'.repeat(64),leaseActive:lease,remainingMs:lease?40000:0});
 const driver={inspect,probe:async()=>[{receiver:'local-a',ip:'203.0.113.10'},{receiver:'local-b',ip:'203.0.113.10'}],activate:async()=>{lease=true;},renew:async()=>{},revoke:async()=>{lease=false;},disconnect:async()=>{},stop:async()=>{state='Off';lease=false;}};
 const runtime={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state}),stop:driver.stop,create:async(c:any)=>{const manifest=windowsPaths(runtimeRoot,c.id).manifest;await mkdir(path.dirname(manifest),{recursive:true});await writeFile(manifest,'{}');},start:async()=>{state='Running';},session:async()=>new WindowsNetworkSession(driver,'203.0.113.10'),connect:async()=>{},inspectGuard:inspect,guest:async()=>{throw Error('No guest tasks expected');},management:async(_c:any,args:string[],options:any)=>{calls++;assert.equal(args.at(-1),WINDOWS_IMAGE_CLIPBOARD_READ);assert.equal(options?.onOutput,undefined);await wait?.(options.signal);return JSON.stringify({data:png.toString('base64')});}};
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot,runtime,base:{image:path.join(root,'base.vhdx'),imageSha256:'b'.repeat(64)}});
 try{
  const launched=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launched.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token,headers={Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const e=await service.manager.create({name:'Synthetic PNG return',cpus:1,memoryGiB:2,diskGiB:16,network:{mode:'http',host:'127.0.0.1',port:12345,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}}),url=service.url+'/api/environments/'+e.id+'/clipboard/image/read';
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://outside.invalid'},body:'{}'})).status,403);assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,409);assert.equal(calls,0);
  const job=await service.manager.action(e.id,'start');await service.manager.wait(job.id);assert.equal(service.manager.store.jobs().find(j=>j.id===job.id)!.status,'succeeded');
  assert.equal((await fetch(url,{method:'POST',headers,body:'{"path":"/etc/shadow"}'})).status,400);assert.equal(calls,0);
  const ok=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{data:png.toString('base64'),width:2,height:2,bytes:png.length});assert.equal(calls,1);
  let release!:()=>void,entered!:()=>void;let began=new Promise<void>(resolve=>entered=resolve);wait=async()=>{entered();await new Promise<void>(resolve=>release=resolve);};const original=service.manager.sessions.get(e.id)!;
  const pending=fetch(url,{method:'POST',headers,body:'{}'});await began;service.manager.sessions.set(e.id,new WindowsNetworkSession(driver,'203.0.113.10'));release();const stale=await pending;assert.equal(stale.status,409);assert.equal((await stale.text()).includes(png.toString('base64')),false);service.manager.sessions.set(e.id,original);
  began=new Promise<void>(resolve=>entered=resolve);let cancelled!:()=>void;const aborted=new Promise<void>(resolve=>cancelled=resolve);wait=signal=>new Promise<void>((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>{cancelled();reject(signal.reason);},{once:true});});
  const abort=new AbortController(),cancel=fetch(url,{method:'POST',headers,body:'{}',signal:abort.signal});await began;abort.abort();await assert.rejects(cancel);await Promise.race([aborted,delay(3000).then(()=>{throw Error('Guest image read was not cancelled');})]);
 }finally{await service.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
