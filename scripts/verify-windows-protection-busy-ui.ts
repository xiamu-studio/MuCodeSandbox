import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
import {environmentSchema} from '../server/validation.ts';

const root=path.resolve(import.meta.dirname,'..'),cache=await mkdtemp(path.join(tmpdir(),'mu-guard-ui-'));
const base=environmentSchema.parse({name:'Synthetic guard UI'}),env={...base,network:{...base.network,strict:true,egressLock:{expectedIp:'203.0.113.10'}},id:'12345678-1234-4234-8234-123456789abc',instanceName:'synthetic-guard',state:'running',browserRunning:false,createdAt:'',updatedAt:'',lastError:null};
const source=`import React from 'react';import{createRoot}from'react-dom/client';import Workspace from '/src/windows/WindowsWorkspace.tsx';import '/src/styles.css';import '/src/windows/windows.css';window.__MU_CONFIG__={token:'fixture',platform:'win32',version:'fixture',capabilities:{browser:true,files:false,terminal:false}};createRoot(document.getElementById('root')).render(<Workspace/>);`;
const vite=await createServer({root,cacheDir:cache,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'guard-ui-fixture',resolveId(id){if(id==='/guard-ui.tsx')return id;},load(id){if(id==='/guard-ui.tsx')return source;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/guard-ui.html')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/guard-ui.tsx"></script>'));});}}]});
await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({executablePath:process.env.MU_CHROME_EXE??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage();let mode:'busy'|'failure'|'healthy'|'hang'|'mixed'|'guard-egress'|'guard-latched'|'guard-recover'|'expiring'|'short-lease'='busy',requests=0,release!:()=>void,releaseMixed!:()=>void,releaseGuard!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),mixedBlocked=new Promise<void>(resolve=>releaseMixed=resolve),guardBlocked=new Promise<void>(resolve=>releaseGuard=resolve);
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.route('**/api/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/api/snapshot')return route.fulfill({json:{environments:[env],jobs:[],system:{version:'fixture',platform:'win32',hostname:'fixture',cpus:4,memoryGiB:16,runtime:{available:true},browser:{available:true}}}});
  if(pathname.endsWith('/network/protection')){requests++;if(mode==='hang'){await blocked;return route.abort().catch(()=>{});}if(mode==='guard-egress')await guardBlocked;if(mode==='guard-recover')await new Promise(resolve=>setTimeout(resolve,300));if(mode==='healthy'||mode==='guard-egress'||mode==='guard-latched'||mode==='guard-recover'||mode==='expiring'||mode==='short-lease')return route.fulfill({json:{active:true,integrity:'verified',leaseActive:true,leaseRemainingMs:mode==='short-lease'?1500:45000,checkedAt:new Date(Date.now()-(mode==='expiring'?14000:0)).toISOString()}}).catch(()=>{});return route.fulfill({status:409,json:mode==='busy'?{code:'PROTECTION_BUSY',error:'浏览器正在切换，防护状态将在操作完成后重新核验'}:{code:'GUARD_FAILED',error:'合成防护检查失败'}});}
  if(pathname.endsWith('/network/egress')&&mode==='guard-egress')return route.fulfill({status:409,json:{code:'GUARD_FAILED',error:'联网许可或防护完整性无法确认'}});
  if(pathname.endsWith('/network/egress')&&mode==='guard-latched')return route.fulfill({json:{status:'unverified'}});
  if(pathname.endsWith('/network/egress')&&mode==='guard-recover')return route.fulfill({json:{status:'verified',expectedIp:'203.0.113.10',actualIp:'203.0.113.10',checkedAt:new Date().toISOString(),verification:{requiredReceivers:2,receipts:[{receiver:'ipwho',ip:'203.0.113.10',latencyMs:10},{receiver:'ipify',ip:'203.0.113.10',latencyMs:11}],timedOutReceivers:[]}}});
  if(pathname.endsWith('/network/egress')&&mode==='mixed'){await mixedBlocked;return route.abort().catch(()=>{});}
  if(pathname.endsWith('/protection-events')||pathname==='/api/logs')return route.fulfill({json:[]});
  return route.fulfill({status:404,json:{error:'fixture unavailable'}});
 });
 await page.goto(`http://127.0.0.1:${address.port}/guard-ui.html`);
 const busyResponse=page.waitForResponse(response=>response.url().endsWith('/network/protection')&&response.status()===409);
 await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();await busyResponse;await page.waitForTimeout(100);
 await page.getByText('正在核验当前防护状态…',{exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.windows-protection-summary')?.textContent?.includes('正在核验'));
 assert.equal(await page.locator('.windows-protection-summary + .notice-error').count(),0);
 assert.equal(await page.locator('.windows-protection-summary.verified').count(),0);assert.equal(requests,1,'The summary and overview must share one protection request');
 mode='failure';await page.reload();await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();
 await page.locator('.windows-protection-summary + .notice-error').getByText('合成防护检查失败',{exact:true}).waitFor();assert.equal(await page.locator('.windows-protection-summary.verified').count(),0);
 mode='healthy';await page.reload();await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();await page.locator('.windows-protection-summary.verified').waitFor();mode='hang';
 await page.locator('.windows-protection-summary + .notice-error').getByText('防护状态读取超时，请等待重新核验。',{exact:true}).waitFor({timeout:26000});assert.equal(await page.locator('.windows-protection-summary.verified').count(),0);
 await page.locator('.environment-health').getByText('状态读取超时，请等待重新核验。',{exact:true}).waitFor({timeout:5000});
 mode='healthy';release();await page.locator('.environment-health').getByText('规则一致 · 联网许可有效',{exact:true}).waitFor({timeout:15000});
 mode='mixed';await page.reload();await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();await page.locator('.environment-health').getByText('合成防护检查失败',{exact:true}).waitFor({timeout:3000});await page.locator('.environment-health').getByText('状态读取超时，请等待重新核验。',{exact:true}).waitFor({timeout:15000});releaseMixed();
 mode='guard-egress';await page.reload();await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();await page.locator('.windows-protection-summary + .notice-error').getByText('联网许可或防护完整性无法确认',{exact:true}).waitFor();releaseGuard();await page.waitForTimeout(300);assert.equal(await page.locator('.windows-protection-summary.verified').count(),0,'A late protection success must not hide a guard failure from egress');
 mode='guard-latched';await page.getByRole('button',{name:'刷新状态'}).click();await page.waitForTimeout(300);assert.equal(await page.locator('.windows-protection-summary.verified').count(),0,'An unverified next exit reading must not clear an earlier guard failure');
 mode='guard-recover';await page.getByRole('button',{name:'刷新状态'}).click();await page.locator('.windows-protection-summary.verified').waitFor({timeout:4000});
 mode='expiring';await page.reload();await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();await page.locator('.windows-protection-summary.verified').waitFor();await page.waitForFunction(()=>!document.querySelector('.windows-protection-summary.verified'),null,{timeout:4000});
 mode='short-lease';await page.reload();await page.getByRole('button',{name:'Synthetic guard UI Linux 沙箱'}).click();const guardCard=page.locator('.environment-health .health-card').filter({has:page.getByRole('heading',{name:'联网防护'})});await guardCard.locator('.health-state.verified').waitFor();await guardCard.locator('.health-state.verified').waitFor({state:'detached',timeout:4000});
 console.log(JSON.stringify({complete:true,checks:['busy remains unverified without a false alarm','actual guard failure remains visible','stalled protection request expires and clears verified display','overview clears stalled reading and resumes after recovery','guard failure appears immediately while the independent exit request stalls'],scope:'local synthetic HTTP and actual Windows workspace component'}));
}finally{await browser.close();await vite.close();await rm(cache,{recursive:true,force:true});}
