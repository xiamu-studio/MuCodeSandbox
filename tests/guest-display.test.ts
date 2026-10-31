import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {displayRequestSchema,displayPixels,fitDisplay} from '../shared/guest-display.ts';
import {dpiScript} from '../server/guest-display.ts';
import {resizeVncDisplay,vncChallenge} from '../server/vnc-display.ts';
import {DISPLAY_COMPONENT_SCRIPT} from '../server/guest-browser-runtime.ts';
import {createService} from '../server/service.ts';
import {environmentSchema} from '../server/validation.ts';
import {randomUUID} from 'node:crypto';

test('Retina plan uses viewport physical pixels and bounds untrusted dimensions',()=>{
  assert.deepEqual(displayPixels({cssWidth:1470,cssHeight:912,scaleFactor:2}),{cssWidth:1470,cssHeight:912,scaleFactor:2,width:2940,height:1824});
  for(const value of [{cssWidth:1470,cssHeight:912,scaleFactor:20},{cssWidth:-1,cssHeight:912,scaleFactor:2},{cssWidth:8192,cssHeight:8192,scaleFactor:4},{cssWidth:'$(id)',cssHeight:900,scaleFactor:2},{cssWidth:900,cssHeight:600,scaleFactor:2,command:'id'}])assert.equal(displayRequestSchema.safeParse(value).success,false);
  const limited=displayPixels(fitDisplay(7680,4320,2));assert.ok(limited.width*limited.height<=16_000_000);
});
test('DPI update verifies the owned process and uses no broad process signalling or browser emulation',()=>{
  const source=dpiScript({cssWidth:1470,cssHeight:912,scaleFactor:2});
  assert.match(source,/mucodesandbox-display\.service/);assert.match(source,/\/usr\/bin\/xsettingsd/);assert.match(source,/is_symlink/);assert.match(source,/196608/);
  assert.ok(!source.includes('pkill')&&!source.includes('Emulation'));
  assert.ok(!DISPLAY_COMPONENT_SCRIPT.includes('x11-xserver-utils')&&!DISPLAY_COMPONENT_SCRIPT.includes('build-essential'));
});
test('VNC challenge has strict inputs, no padding and deterministic legacy authentication',()=>{
  assert.equal(vncChallenge('abcdefgh',Buffer.alloc(16)).length,16);
  assert.notDeepEqual(vncChallenge('abcdefgh',Buffer.alloc(16)),vncChallenge('abcdefgh',Buffer.alloc(16,1)));
  assert.throws(()=>vncChallenge('too-long-value',Buffer.alloc(16)));assert.throws(()=>vncChallenge('abcdefgh',Buffer.alloc(8)));
});
test('Display client refuses a server that offers only unauthenticated VNC',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-vnc-test-')),socket=process.platform==='win32'?'\\\\.\\pipe\\mu-vnc-'+randomUUID():path.join(dir,'vnc.sock');
  const server=createServer(peer=>{peer.write('RFB 003.008\n');peer.once('data',()=>peer.write(Buffer.from([1,1])));});
  await new Promise<void>(r=>server.listen(socket,r));
  try{await assert.rejects(resizeVncDisplay(socket,'abcdefgh',2940,1800),/authentication required/);}
  finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('Display API rejects missing authority, hostile origins and malformed geometry',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mu-display-api-'));
  const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
  const service=await createService({dataDir:dir,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});
  const e={...environmentSchema.parse({name:'Display test'}),id:randomUUID(),instanceName:'mu-display-test',state:'stopped' as const,lastError:null,browserRunning:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};service.manager.store.save(e);
  const url=`${service.url}/api/environments/${e.id}/guest-browser/display`,headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:'{}'})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"cssWidth":900,"cssHeight":600,"scaleFactor":2,"command":"id"}'})).status,400);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"cssWidth":900,"cssHeight":600,"scaleFactor":2}'})).status,409);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
