import {test} from 'node:test';import assert from 'node:assert/strict';import {deflateSync,crc32} from 'node:zlib';import {createRequire} from 'node:module';
import {validateClipboardImage} from '../server/clipboard-image.ts';import {GuestExchange} from '../server/guest-exchange.ts';import {LimaRuntime} from '../server/runtime.ts';import {environmentSchema} from '../server/validation.ts';import type {Environment} from '../shared/types.ts';import {IMAGE_CLIPBOARD_MAX_BYTES} from '../shared/clipboard-image.ts';
const require=createRequire(import.meta.url),{readClipboardImage}=require('../desktop/clipboard-image.cjs');
import {fixturePng} from '../scripts/clipboard-image-fixture.ts';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createService} from '../server/service.ts';

test('PNG validation bounds pixels, bytes, checks CRC/chunks and exact decompression size',()=>{
 const image=fixturePng();assert.deepEqual(validateClipboardImage(image),{width:2,height:2,bytes:image.length});
 for(const invalid of [Buffer.from('not an image'),image.subarray(0,-1),Buffer.concat([image,Buffer.from('extra')]),Buffer.alloc(IMAGE_CLIPBOARD_MAX_BYTES+1)])assert.throws(()=>validateClipboardImage(invalid));
 const bad=Buffer.from(image);bad[29]^=1;assert.throws(()=>validateClipboardImage(bad));
 const enormous=Buffer.from(image);enormous.writeUInt32BE(10000000,16);enormous.writeUInt32BE(crc32(enormous.subarray(12,29)),29);assert.throws(()=>validateClipboardImage(enormous),{code:'CLIPBOARD_IMAGE_TOO_LARGE'});
 const bomb=fixturePng(300,300);bomb.writeUInt32BE(1,16);bomb.writeUInt32BE(1,20);bomb.writeUInt32BE(crc32(bomb.subarray(12,29)),29);assert.throws(()=>validateClipboardImage(bomb),{code:'INVALID_CLIPBOARD_IMAGE'});
 const paletteMissing=Buffer.from(image);paletteMissing[25]=3;paletteMissing.writeUInt32BE(crc32(paletteMissing.subarray(12,29)),29);assert.throws(()=>validateClipboardImage(paletteMissing));
 const unknown=Buffer.from(image);unknown.write('ABCD',37);unknown.writeUInt32BE(crc32(unknown.subarray(37,unknown.length-16)),unknown.length-16);assert.throws(()=>validateClipboardImage(unknown));
});
test('Image endpoint rejects unauthenticated, foreign-origin, stopped, invalid or oversized requests before guest mutation',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-image-api-')),service=await createService({dataDir:root,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser:{native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}}});clearInterval(service.manager.protectionTimer);
 const e={...environmentSchema.parse({name:'image API fixture'}),id:'5cfb1cc0-22a3-4a34-a16b-0890b0699e26',instanceName:'image-fixture',state:'stopped',updatedAt:'one'} as Environment;service.manager.store.save(e);
 const url=service.url+'/api/environments/'+e.id+'/clipboard/image',headers={Authorization:'Bearer '+service.token,'Content-Type':'image/png'},body=fixturePng();let guestCalls=0;service.manager.runtime.management=async()=>{guestCalls++;throw Error('Must not reach guest');};
 try{
  assert.equal((await fetch(url,{method:'POST',body})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://untrusted.invalid'},body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body})).status,409);
  service.manager.assertAccess=async()=>undefined;
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'not PNG'})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:'not PNG'})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:Buffer.alloc(IMAGE_CLIPBOARD_MAX_BYTES+1)})).status,413);
  assert.equal(guestCalls,0);
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
test('Native clipboard bridge uses async ClipboardItem API after trusted gesture and reads PNG only',async()=>{
 let reads=0,trusted=true,gesture=true,types:string[]=[];const data=fixturePng();const clipboard={async read(){reads++;return[{types:['text/plain','text/html','image/png','electron application/osclipboard;format="public.file-url"'],async getType(type:string){types.push(type);assert.equal(type,'image/png');return new Blob([data],{type});}}];}};const nativeImage={createFromBuffer:(bytes:Buffer)=>{assert.deepEqual(bytes,data);return{isEmpty:()=>false,getScaleFactors:()=>[1,2],getSize:(scale:number)=>{assert.equal(scale,2);return{width:2,height:2};},toPNG:({scaleFactor}:{scaleFactor:number})=>{assert.equal(scaleFactor,2);return data;}};}};const event={senderFrame:{executeJavaScript:async()=>gesture}};const options={clipboard,nativeImage,allowed:()=>trusted};
 trusted=false;await assert.rejects(readClipboardImage(event,options));assert.equal(reads,0);trusted=true;gesture=false;await assert.rejects(readClipboardImage(event,options));assert.equal(reads,0);
 gesture=true;assert.deepEqual(Buffer.from((await readClipboardImage(event,options)).data),data);assert.equal(reads,1);
 event.senderFrame.executeJavaScript=async()=>{trusted=false;return true;};await assert.rejects(readClipboardImage(event,options));assert.equal(reads,1);
 assert.deepEqual(types,['image/png']);
});
test('Native async reads recheck frame after waiting and reject nonimages or oversized PNG before decoding',async()=>{
 let trusted=true,decoded=0,typed=0;const event={senderFrame:{executeJavaScript:async()=>true}},nativeImage={createFromBuffer:()=>{decoded++;throw Error('Must not decode');}},allowed=()=>trusted;
 await assert.rejects(readClipboardImage(event,{allowed,nativeImage,clipboard:{read:async()=>[{types:['text/plain'],getType:async()=>{typed++;throw Error();}}]}}),/没有图片/);
 assert.equal(typed,0);
 await assert.rejects(readClipboardImage(event,{allowed,nativeImage,clipboard:{read:async()=>{trusted=false;return[{types:['image/png'],getType:async()=>{typed++;throw Error();}}];}}}),/已失效/);
 assert.equal(typed,0);trusted=true;
 for(const blob of [new Blob([Buffer.alloc(IMAGE_CLIPBOARD_MAX_BYTES+1)]),new Blob([Buffer.from('invalid')])])await assert.rejects(readClipboardImage(event,{allowed,nativeImage,clipboard:{read:async()=>[{types:['image/png'],getType:async()=>blob}]}}));
 const image=Buffer.from(fixturePng());image.writeUInt32BE(10000000,16);
 await assert.rejects(readClipboardImage(event,{allowed,nativeImage,clipboard:{read:async()=>[{types:['image/png'],getType:async()=>new Blob([image])}]}}),/分辨率过大/);
 await assert.rejects(readClipboardImage(event,{allowed,nativeImage,clipboard:{read:async()=>[{types:['image/png'],getType:async()=>{trusted=false;return new Blob([fixturePng()]);}}]}}),/已失效/);
 assert.equal(decoded,0);
});
test('Image transfer uses dev stdin after authorization and rejects stale/revoked results without file upload',async()=>{
 const e={...environmentSchema.parse({name:'image fixture'}),id:'fixture',instanceName:'fixture',state:'running',updatedAt:'one'} as Environment,runtime=new LimaRuntime('/tmp/mu-image-unused'),data=fixturePng();let allowed=false,calls=0;
 runtime.management=async(_e,args,options)=>{calls++;assert.equal(options?.onOutput,undefined);assert.ok(!args.join(' ').includes(data.toString('base64')));if(calls===1){assert.match(options!.input!,/Accept=yes/);assert.match(options!.input!,/MemoryMax=256M/);assert.match(options!.input!,/BindsTo=mucodesandbox-display.service/);return '';}assert.ok(args.includes('dev'));assert.equal(JSON.parse(options!.input!).data,data.toString('base64'));return '{"ok":true}';};
 const exchange=new GuestExchange(runtime,async()=>{if(!allowed)throw Error('revoked');return e;});await assert.rejects(exchange.writeClipboardImage(e.id,data),/revoked/);assert.equal(calls,0);
 assert.throws(()=>exchange.writeClipboardImage(e.id,Buffer.from('bad')));assert.equal(calls,0);allowed=true;assert.equal((await exchange.writeClipboardImage(e.id,data)).ok,true);assert.equal(calls,2);
 runtime.management=async()=>{allowed=false;return '{"ok":true}';};await assert.rejects(exchange.writeClipboardImage(e.id,data),/revoked/);
});
