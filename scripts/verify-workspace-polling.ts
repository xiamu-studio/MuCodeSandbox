import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createService} from '../server/service.ts';
import type {Environment,Snapshot} from '../shared/types.ts';
const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-polling-'));
const service=await createService({rootDir:root,dataDir:temporary,port:0});
clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1360,height:850}});
const at=()=>new Date().toISOString(),errors:string[]=[],checks:string[]=[];
page.on('pageerror',e=>errors.push(e.message));
const environment:Environment={id:'polling-fixture',instanceName:'fixture',name:'刷新性能测试',description:'仅本地合成数据',kind:'vm',color:'blue',cpus:4,memoryGiB:4,diskGiB:30,mounts:[],ports:[],network:{mode:'socks5',host:'127.0.0.1',port:24898,username:'',noProxy:'',strict:true,transparent:true},identity:{timezone:'America/Los_Angeles',locale:'en-US'},browserUrl:'about:blank',state:'running',lastError:null,createdAt:at(),updatedAt:at(),browserRunning:false};
const snapshot:Snapshot={...(await service.manager.snapshot()),environments:[environment],jobs:[]};
const counts={snapshot:0,metrics:0,logs:0};
let holdSnapshot=true,holdMetrics=true,holdLogs=true,failSnapshot=false,failLogs=false,entries=80;
let releaseSnapshot:(()=>void)|undefined,releaseMetrics:(()=>void)|undefined,releaseLogs:(()=>void)|undefined;
await page.route('**/api/**',async route=>{
 const p=new URL(route.request().url()).pathname;let data:unknown={},status=200;
 if(p==='/api/snapshot'){
  counts.snapshot++;const copy=structuredClone(snapshot);
  if(holdSnapshot)await new Promise<void>(resolve=>{releaseSnapshot=resolve;});
  if(failSnapshot){status=503;data={error:'fixture disconnected'};}else data=copy;
 }else if(p.endsWith('/metrics')){
  counts.metrics++;if(holdMetrics)await new Promise<void>(resolve=>{releaseMetrics=resolve;});
  data={cpuPercent:3.5,memoryUsedMiB:1024,memoryTotalMiB:4096,diskUsedGiB:3,diskTotalGiB:30,uptimeSeconds:600};
 }else if(p==='/api/logs'){
  counts.logs++;if(holdLogs)await new Promise<void>(resolve=>{releaseLogs=resolve;});
  if(failLogs){status=503;data={error:'fixture log failure'};}else data=Array.from({length:entries},(_,i)=>({id:i+1,environmentId:null,jobId:null,level:'info',message:'本地测试事件 '+i,createdAt:'2026-10-14T02:00:00Z'}));
 }else if(p.endsWith('/network/protection'))data={active:true,integrity:'verified',leaseActive:true,leaseRemainingMs:40000,checkedAt:at(),issues:[]};
 else if(p.endsWith('/network/egress'))data={status:'unknown'};
 else if(p.endsWith('/browser/version'))data={installedVersion:'fixture',availableVersion:'fixture'};
 else if(p.endsWith('/bridge')||p.endsWith('/protection-events'))data=[];
 else if(p.endsWith('/network/latency'))data=null;
 else{errors.push(p);status=404;data={error:'Unexpected endpoint'};}
 await route.fulfill({status,json:data});
});
try{
 await page.clock.install();await page.goto(service.launchUrl());
 await expect.poll(()=>counts.snapshot).toBe(1);await page.clock.runFor(15000);assert.equal(counts.snapshot,1);checks.push('15-second slow snapshot stays single-flight');
 holdSnapshot=false;releaseSnapshot!();await page.getByRole('button',{name:environment.name+' Linux 沙箱',exact:true}).waitFor();
 failSnapshot=true;await page.clock.runFor(3000);await expect(page.getByText(/本机服务连接失败：fixture disconnected/)).toBeVisible();
 failSnapshot=false;await page.clock.runFor(3000);await expect(page.getByText(/本机服务连接失败：fixture disconnected/)).toHaveCount(0);checks.push('snapshot polling resumes after failure and clears only connection error');
 await page.getByRole('button',{name:environment.name+' Linux 沙箱',exact:true}).click();await expect.poll(()=>counts.metrics).toBe(1);
 await page.clock.runFor(24000);assert.equal(counts.metrics,1);checks.push('24-second guest metrics request does not stack');
 holdMetrics=false;releaseMetrics!();await expect(page.getByText('3.5%',{exact:true})).toBeVisible();
 await page.clock.runFor(6000);await expect.poll(()=>counts.metrics).toBe(2);checks.push('metrics resume at normal cadence after response');
 await page.getByRole('button',{name:'操作记录',exact:true}).click();await expect.poll(()=>counts.logs).toBe(1);
 await page.clock.runFor(11000);assert.equal(counts.logs,1);assert.equal(counts.metrics,2);checks.push('slow logs do not overlap; leaving overview stops metrics');
 holdLogs=false;releaseLogs!();await expect(page.locator('.log-entry')).toHaveCount(entries);
 const surface=page.locator('.log-surface');await surface.evaluate(node=>{node.scrollTop=0;});
 const before=counts.logs;await page.clock.runFor(2500);await expect.poll(()=>counts.logs).toBeGreaterThan(before);
 assert.equal(await surface.evaluate(node=>node.scrollTop),0);checks.push('unchanged log poll preserves user scroll position');
 entries++;await page.clock.runFor(2500);await expect(page.locator('.log-entry')).toHaveCount(entries);await expect.poll(()=>surface.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);checks.push('new log entry still follows to bottom');
 failLogs=true;await page.clock.runFor(2500);await expect(page.getByText('fixture log failure',{exact:true})).toBeVisible();
 failLogs=false;await page.clock.runFor(2500);await expect(page.getByText('fixture log failure',{exact:true})).toHaveCount(0);checks.push('failed logs release pending request and recover');
 holdSnapshot=true;const initial=counts.snapshot;await page.clock.runFor(3000);await expect.poll(()=>counts.snapshot).toBe(initial+1);
 await page.getByRole('button',{name:'刷新记录',exact:true}).click();await page.clock.runFor(9000);assert.equal(counts.snapshot,initial+1);
 snapshot.environments[0].name='操作后最新状态';holdSnapshot=false;releaseSnapshot!();
 await page.getByRole('button',{name:'操作后最新状态 Linux 沙箱',exact:true}).waitFor();assert.equal(counts.snapshot,initial+2);checks.push('explicit refresh waits for older snapshot then reads fresh state');
 assert.deepEqual(errors,[]);
 const report={passed:true,checks,counts,scope:'Production UI with held synthetic responses only. No real VM, clipboard, AI sites or routing changes.'};
 await mkdir(path.join(root,'test-results/workspace-polling'),{recursive:true});await writeFile(path.join(root,'test-results/workspace-polling/ui.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{holdSnapshot=holdMetrics=holdLogs=false;releaseSnapshot?.();releaseMetrics?.();releaseLogs?.();await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});}
