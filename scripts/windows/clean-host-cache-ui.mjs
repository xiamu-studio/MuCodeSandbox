import assert from 'node:assert/strict';import {readFile,writeFile,rename} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
import {_electron} from 'file:///C:/MuLab/test-tools/playwright-core/index.mjs';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {createWindowsService} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/service.js';
export async function cacheUiAcceptance(client,nonce,pass){
 const data=JSON.parse(await readFile('C:/MuLab/approved/cache-seed.json','utf8'));
 async function receipt(name){const until=performance.now()+30000;for(;;){try{const value=JSON.parse(await readFile(`C:/MuLab/approved/cache-${name}.json`,'utf8'));if(value.nonce===nonce)return;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(performance.now()<until,'Cache UI operator did not respond');await delay(100);}}
 async function request(action,name){const path=`C:/MuLab/public/cache-${action}-request.json`;await writeFile(path+'.next',JSON.stringify({nonce,action}));await rename(path+'.next',path);return receipt(name);}
 const runtime=new HyperVRuntime('C:/MuLab/public/cache-ui-runtime',undefined,client);let app,service;
 try{
  service=await createWindowsService({rootDir:'C:/MuLab/product/resources/app',dataDir:'C:/MuLab/public/cache-ui-app',runtimeRoot:runtime.root,runtime,base:{image:'mu-base:'+data.current,imageSha256:data.current}});
  await request('ui-seed','ui-seeded');
  const restoring=request('permissions','permissions-restored');await receipt('permissions-changed');await assert.rejects(client.call('cache-status',{keepDigest:data.current},{timeoutMs:60000}),{code:'DENIED'});await writeFile('C:/MuLab/public/cache-permissions-release.json',JSON.stringify({nonce}));await restoring;
  pass('A writable catalogue directory is rejected before inspection or deletion, and the independent operator restores its original permissions');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  app=await _electron.launch({executablePath:'C:/MuLab/test-tools/electron/electron.exe',args:['C:/MuLab/cache-ui.cjs',service.launchUrl()],env,timeout:30000});const page=await app.firstWindow();await page.getByRole('heading',{name:'工作区',exact:true}).waitFor();assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  await page.getByRole('button',{name:'系统状态',exact:true}).click();await page.getByRole('heading',{name:'存储与缓存',exact:true}).waitFor();
  const status=()=>page.evaluate(async()=>{const r=await fetch('/api/windows/storage',{headers:{Authorization:'Bearer '+window.__MU_CONFIG__.token}});if(!r.ok)throw Error('Storage API unavailable');return r.json();});
  let info=await status();assert.equal(info.canPrune,true);const initial=info.reclaimableFiles;assert.ok(initial>=1);
  const clear=page.getByRole('button',{name:'清理未使用缓存',exact:true});await clear.waitFor();const deadline=performance.now()+15000;while(!await clear.isEnabled()){assert.ok(performance.now()<deadline);await delay(100);}
  pass('The sandboxed production manager renders actual privileged cache statistics through its authenticated local API');
  await clear.click();let dialog=page.getByRole('dialog',{name:'清理未使用缓存'});await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await status()).reclaimableFiles,initial);
  pass('Cancelling the review dialog leaves the actual cache files untouched');
  await clear.click();dialog=page.getByRole('dialog',{name:'清理未使用缓存'});await request('ui-change','ui-changed');await dialog.getByRole('button',{name:'确认清理缓存',exact:true}).click();await page.getByText('缓存或引用已变化，请重新检查后再清理。',{exact:true}).waitFor();assert.equal((await status()).reclaimableFiles,initial+1);
  pass('A cache change after dialog review is rejected by the native plan token and shown to the user');
  await page.getByRole('button',{name:'重新检查存储',exact:true}).click();await delay(300);await clear.click();dialog=page.getByRole('dialog',{name:'清理未使用缓存'});await dialog.getByRole('button',{name:'确认清理缓存',exact:true}).click();await page.getByText(`已清理 ${initial+1} 个缓存文件`,{exact:false}).waitFor();info=await status();assert.equal(info.reclaimableFiles,0);assert.equal(info.imageCount,1);await page.getByRole('region',{name:'Windows 存储与缓存'}).scrollIntoViewIfNeeded().catch(()=>{});await page.screenshot({path:'C:/MuLab/public/cache-ui.png',fullPage:true});
  pass('Confirming the refreshed plan reclaims only the real temporary copies and keeps the current base');
  await app.close();app=undefined;await service.close();service=undefined;pass('The local cache UI and service close normally without any guest VM or external website');return {removed:true,currentBaseRetained:true,realNativeApi:true};
 }finally{await app?.close().catch(()=>{});await service?.close();}
}
