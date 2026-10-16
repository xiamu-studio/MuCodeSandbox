import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createService} from '../server/service.ts';
import type {Environment,Snapshot} from '../shared/types.ts';
const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-status-ui-')),results=path.join(root,'test-results/status-overview');
await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1360,height:1050},deviceScaleFactor:2});
page.setDefaultTimeout(12000);
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const at=()=>new Date().toISOString(),ip='203.0.113.8';
const e:Environment={id:randomUUID(),instanceName:'fixture',name:'状态与恢复验证',description:'临时测试 · 不连接真实虚拟机',kind:'vm',color:'blue',cpus:4,memoryGiB:4,diskGiB:30,mounts:[],ports:[],network:{mode:'socks5',host:'127.0.0.1',port:24898,username:'',noProxy:'',strict:true,transparent:true,egressLock:{expectedIp:ip}},identity:{timezone:'America/Los_Angeles',locale:'en-US'},browserUrl:'about:blank',state:'running',lastError:null,createdAt:at(),updatedAt:at(),browserRunning:true};
const snapshot:Snapshot={...(await service.manager.snapshot()),environments:[e],jobs:[{id:randomUUID(),environmentId:e.id,action:'disk-grow',status:'failed',message:'测试磁盘扩容未完成，请检查状态',createdAt:new Date(Date.now()-4000).toISOString(),finishedAt:at()}]};
let mode:'normal'|'stale'|'single'|'failure'='normal',inspectionCalls=0;
const requests:{method:string;path:string}[]=[];
await page.route('**/api/**',async route=>{
 const request=route.request(),p=new URL(request.url()).pathname;requests.push({method:request.method(),path:p});
 let data:unknown={},status=200;
 if(p==='/api/snapshot')data=snapshot;
 else if(p.endsWith('/network/protection'))data={active:true,integrity:'verified',leaseActive:true,leaseRemainingMs:40000,checkedAt:mode==='stale'?new Date(Date.now()-60000).toISOString():at(),issues:[]};
 else if(p.endsWith('/network/egress')){if(mode==='failure'){status=503;data={error:'测试出口读取失败'};}else data={status:'verified',expectedIp:ip,actualIp:ip,checkedAt:mode==='stale'?new Date(Date.now()-60000).toISOString():at(),verification:{requiredReceivers:2,timedOutReceivers:[],receipts:(mode==='single'?['ipwho']:['ipwho','ipify']).map(receiver=>({receiver,ip,latencyMs:150}))}};}
 else if(p.endsWith('/browser/version'))data={installedVersion:'155.0.8059.39',availableVersion:'155.0.8059.39',installedChannel:'stable',availableChannel:'stable',updateAvailable:false,recoveryRequired:false};
 else if(p.endsWith('/browser/inspect')){inspectionCalls++;data={timezone:'America/Los_Angeles',language:'en-US',locale:'en-US',languages:['en-US'],matchesConfiguration:true,checkedAt:at()};}
 else if(p.endsWith('/bridge'))data=[{id:'fixture-grant',environmentId:e.id,root:'/fixture',commands:['git-status'],writable:false,guestReady:true,expiresAt:new Date(Date.now()+60000).toISOString()}];
 else if(p.endsWith('/protection-events')||p.endsWith('/logs')||p.endsWith('/snapshots'))data=[];
 else if(p.endsWith('/network/latency'))data=null;
 else if(p.endsWith('/disk'))data={pending:true,targetGiB:35};
 else if(p.endsWith('/metrics'))data={cpuPercent:1,memoryUsedMiB:1024,memoryTotalMiB:4096,diskUsedGiB:3,diskTotalGiB:30,uptimeSeconds:600};
 else if(p.endsWith('/actions/delete')){status=409;data={error:'测试删除未完成：请保留记录后检查磁盘'};}
 else throw new Error(`Unexpected fixture API ${request.method()} ${p}`);
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
});
const report:any={passed:false,scope:'Disposable UI fixture: no live VM, credentials, deletion or network changes',screenshots:[]};
try{
 await page.goto(service.launchUrl());await page.getByRole('button',{name:e.name+' Linux 沙箱',exact:true}).click();
 const health=page.getByRole('region',{name:'环境状态总览'}),exit=health.locator('.health-card').filter({has:page.getByRole('heading',{name:'出口 IP',exact:true})});
 await expect(exit.locator('.health-state')).toHaveText('已核验');await health.getByText('1 项有效授权',{exact:true}).waitFor();
 await page.getByText('测试磁盘扩容未完成，请检查状态',{exact:true}).waitFor();assert.equal(requests.filter(r=>r.method!=='GET').length,0,'Overview only reads existing state');
 for(const width of [1360,800,390]){await page.setViewportSize({width,height:1050});await health.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const file=`overview-${width}.png`;await page.screenshot({path:path.join(results,file)});report.screenshots.push(file);}
 await page.setViewportSize({width:1360,height:1050});mode='stale';await health.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(exit.locator('.health-state')).toHaveText('待刷新');await expect(page.locator('.protection-banner.verified')).toHaveCount(0);
 mode='single';await health.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(exit.locator('.health-state')).toHaveText('需检查');
 mode='failure';await health.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(exit.locator('.health-state')).toHaveText('读取失败');assert.ok(!(await exit.innerText()).includes(ip+' · 2 份回执'),'A failed read must clear the previous receipt');
 mode='normal';e.browserRunning=false;e.updatedAt=at();await health.getByText('浏览器未打开，尚未实测',{exact:true}).waitFor();const count=inspectionCalls;await health.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(health.getByRole('button',{name:'刷新状态',exact:true})).toBeEnabled();assert.equal(inspectionCalls,count,'Closed browser is not inspected or opened');
 await page.getByRole('button',{name:'检查扩容状态',exact:true}).click();await page.getByRole('heading',{name:'环境设置',exact:true}).waitFor();
 await page.getByRole('button',{name:'彻底重建环境',exact:true}).click();let modal=page.getByRole('dialog');await modal.getByText('永久清除',{exact:true}).waitFor();assert.match(await modal.innerText(),/Chrome \/ Claude \/ Grok \/ CLI/);assert.match(await modal.innerText(),/线路与地区设置/);assert.match(await modal.innerText(),/导出备份和网站服务端记录不在删除范围/);await page.screenshot({path:path.join(results,'rebuild.png')});await modal.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'删除环境',exact:true}).click();modal=page.getByRole('dialog');await modal.getByRole('button',{name:'删除环境',exact:true}).click();await modal.getByText('测试删除未完成：请保留记录后检查磁盘',{exact:true}).waitFor();assert.equal(e.state,'running');await page.screenshot({path:path.join(results,'delete-failure.png')});await modal.getByRole('button',{name:'取消',exact:true}).click();
 e.state='stopped';e.updatedAt=at();await page.getByRole('button',{name:'总览',exact:true}).click();await expect(exit.locator('.health-state')).toHaveText('未运行');assert.equal(await health.locator('.health-state.verified').count(),0);
 assert.deepEqual(errors,[]);Object.assign(report,{passed:true,expiredReceipts:true,singleReceiptRejected:true,readFailureClearsSuccess:true,closedBrowserReadOnly:true,realGrantShown:true,failureNavigation:true,deleteFailureRetained:true,stoppedNotVerified:true});
}catch(error){report.error=String(error);process.exitCode=1;}finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
