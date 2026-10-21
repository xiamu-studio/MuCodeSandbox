import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {watchWindowsDesktopOwner} from '../server/platform/windows/desktop-owner.ts';
const require=createRequire(import.meta.url),{launchOrigin,allowedRequest,workerEnvironment,statusDocument}=require('../desktop/windows/policy.cjs'),{createController}=require('../desktop/windows/controller.cjs');
const token='A'.repeat(43),launch=`http://127.0.0.1:12345/?launch=${token}`;
test('Windows desktop accepts only its exact loopback service and confines renderer requests',()=>{
 const origin=launchOrigin(launch);assert.equal(origin,'http://127.0.0.1:12345');for(const value of [launch.replace('127.0.0.1','localhost'),launch.replace('127.0.0.1','127.0.0.1.evil'),launch.replace('http:','https:'),launch+'&other=1',launch.replace('/?','/api?')])assert.throws(()=>launchOrigin(value));
 assert.equal(allowedRequest(origin,origin+'/api/snapshot'),true);assert.equal(allowedRequest(origin,'ws://127.0.0.1:12345/terminal'),true);assert.equal(allowedRequest(origin,'blob:'+origin+'/download'),true);for(const value of ['file:///C:/Windows/win.ini','https://example.test','http://127.0.0.1:12346/','data:text/html,external'])assert.equal(allowedRequest(origin,value),false);assert.equal(allowedRequest(origin,origin+'/api/snapshot',true),false);assert.equal(allowedRequest(origin,origin+'/',true),true);
});
test('Desktop workers do not inherit Node injection, Electron runtime or proxy environment variables',()=>{
 const env=workerEnvironment({SystemRoot:'C:\\Windows',NODE_OPTIONS:'--require=outside',ELECTRON_RUN_AS_NODE:'1',HTTP_PROXY:'http://secret.invalid',PATHEXT:'.MAL',USERPROFILE:'C:\\Users\\fixture'},{NODE_OPTIONS:'outside',MU_WINDOWS_APP_DIR:'C:\\fixture\\app'});assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(env.HTTP_PROXY,undefined);assert.equal(env.PATHEXT,'.COM;.EXE;.BAT;.CMD');assert.equal(env.MU_WINDOWS_APP_DIR,'C:\\fixture\\app');
});
test('Desktop status messages escape markup and permit no remote scripts',()=>{const html=statusDocument('<img src=x>','<script>alert(1)</script>');assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<script>'));assert.ok(html.includes("default-src 'none'"));});
async function fixture(mode:string){
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-desktop-')),entry=path.join(root,'worker.cjs');await writeFile(entry,`let attempts=0;process.on('message',message=>{if(message.type==='start')process.send({version:1,type:'ready',pid:process.pid,url:${JSON.stringify(mode==='bad-url'?'https://example.test/':launch)}});if(message.type==='shutdown'){attempts++;if(${JSON.stringify(mode)}==='no-receipt')process.exit(0);else if(${JSON.stringify(mode)}==='retry'&&attempts===1)process.send({version:1,type:'stop-error',message:'Synthetic unconfirmed stop'});else process.send({version:1,type:'stopped'},()=>{process.disconnect();process.exit(0)});}});`);
 const controller=createController({node:process.execPath,entry,rootDir:root});return{controller,cleanup:async()=>{controller.terminate();await controller.exited;assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};
}
test('Desktop shutdown waits for the worker receipt and actual process exit',async()=>{const f=await fixture('normal');try{const ready=await f.controller.ready;assert.equal(ready.origin,'http://127.0.0.1:12345');await f.controller.close();await f.controller.exited;}finally{await f.cleanup();}});
test('An exited worker without a stop receipt never becomes confirmed shutdown',async()=>{const f=await fixture('no-receipt');try{await f.controller.ready;await assert.rejects(f.controller.close());await assert.rejects(f.controller.close());}finally{await f.cleanup();}});
test('Unconfirmed stops can be retried without starting another worker',async()=>{const f=await fixture('retry');try{const ready=await f.controller.ready;await assert.rejects(f.controller.close());await f.controller.close();assert.equal(f.controller.pid,ready.pid);}finally{await f.cleanup();}});
test('A worker cannot redirect the desktop to a nonlocal launch URL',async()=>{const f=await fixture('bad-url');try{await assert.rejects(f.controller.ready);}finally{await f.cleanup();}});
test('The OS owner watcher notices a killed owner independently of inherited IPC handles',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-owner-')),entry=path.join(root,'owner.cjs');await writeFile(entry,'setInterval(()=>{},1000)');const owner=fork(entry,[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});let watch:Awaited<ReturnType<typeof watchWindowsDesktopOwner>>|undefined;
 try{let resolveExit!:()=>void;const exited=new Promise<void>(resolve=>{resolveExit=resolve;});watch=await watchWindowsDesktopOwner(owner.pid!,resolveExit);owner.kill('SIGKILL');await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('OS desktop ownership was not revoked')),5000))]);}finally{watch?.stop();owner.kill('SIGKILL');assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
