import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GuestBrowserHost} from '../server/guest-browser.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
const fallback={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
const e={...environmentSchema.parse({name:'Translation',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}}),id:'translation-fixture',instanceName:'fixture',state:'running',lastError:null,browserRunning:true,createdAt:'now',updatedAt:'now'} as Environment;
function fixture(){const host=new GuestBrowserHost(new LimaRuntime('/unused'),fallback),calls:{method:string;params:any}[]=[];let next=0;
 const entry:any={browserReady:true,tools:{send:async(method:string,params:any)=>{calls.push({method,params});return method==='Target.createTarget'?{targetId:'translation-'+(++next)}:{};}}};host.entries.set(e.id,entry);
 return {host,entry,calls,cleanup:async()=>{host.entries.clear();await host.dispose();}};
}
test('Translation uses only managed guest Chrome, fixed Google destination and its own bounded window',async()=>{
 const {host,entry,calls,cleanup}=fixture();let checks=0;host.authorize=async()=>{checks++;};
 try{
  await host.openTranslation(e,'中文 & ? #\nsecond');assert.equal(checks,2);
  const create=calls[0];assert.equal(create.method,'Target.createTarget');const url=new URL(create.params.url);
  assert.equal(url.origin,'https://translate.google.com');assert.equal(url.searchParams.get('text'),'中文 & ? #\nsecond');assert.equal(url.searchParams.get('tl'),'en');assert.equal(create.params.newWindow,true);assert.equal(create.params.width,900);
  assert.equal(entry.translationTarget,'translation-1');await host.openTranslation(e,'next');
  assert.deepEqual(calls.filter(c=>c.method==='Target.closeTarget').map(c=>c.params.targetId),['translation-1']);assert.equal(entry.translationTarget,'translation-2');
 }finally{await cleanup();}
});
test('Revoked access cannot create a window and revocation during creation closes only the newly created window',async()=>{
 const {host,entry,calls,cleanup}=fixture();
 try{
  host.authorize=async()=>{throw new Error('revoked');};await assert.rejects(host.openTranslation(e,'x'),/revoked/);assert.equal(calls.length,0);assert.equal(entry.translationBusy,false);
  let checks=0;host.authorize=async()=>{if(++checks===2)throw new Error('revoked');};entry.translationTarget='prior-translation';
  await assert.rejects(host.openTranslation(e,'x'),/revoked/);assert.deepEqual(calls.map(c=>c.method),['Target.createTarget','Target.closeTarget']);assert.equal(calls[1].params.targetId,'translation-1');assert.equal(entry.translationTarget,'prior-translation');
 }finally{await cleanup();}
});
test('Translation refuses a missing browser or overlapping request',async()=>{
 const {host,entry,calls,cleanup}=fixture();
 try{entry.browserReady=false;await assert.rejects(host.openTranslation(e,''),/打开沙箱浏览器/);entry.browserReady=true;entry.translationBusy=true;await assert.rejects(host.openTranslation(e,''),/正在打开/);assert.equal(calls.length,0);}
 finally{await cleanup();}
});
