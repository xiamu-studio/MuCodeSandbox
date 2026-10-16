import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createService} from '../server/service.ts';
import {desktopProfile} from '../server/guest-desktop.ts';
const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-display-only-ui-'));
const results=path.join(root,'test-results/desktop-display-separation');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1320,height:1000},deviceScaleFactor:2});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const report:any={passed:false,scope:'Temporary synthetic UI with display ready but no Chrome; no production data'};
try{
 clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
 const e=await service.manager.create({name:'桌面独立启动验证',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}});service.manager.store.state(e.id,'running');
 service.manager.desktop.status=async()=>({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'0.68.1',running:true,pid:100,profile:desktopProfile('grok-bot'),rendererProtected:true}]});
 service.guestBrowser.info=()=>({running:true,ready:false,browserRunning:false,width:3200,height:2000,platform:'Linux',display:undefined});
 assert.equal(service.manager.view(service.manager.store.get(e.id)).browserRunning,false);
 await page.goto(service.launchUrl());await page.getByRole('button',{name:'桌面独立启动验证 Linux 沙箱'}).click();await page.getByRole('button',{name:'桌面应用',exact:true}).click();
 await page.getByRole('heading',{name:'Grok Bot · Linux 沙箱桌面',exact:true}).waitFor();
 await page.locator('.desktop-display .guest-browser-view').waitFor();
 assert.equal(await page.locator('.desktop-display .guest-browser-view').count(),1,'Desktop viewer must render even while browserRunning is false');
 await page.getByText('资料保存、清理与运行说明',{exact:true}).click();assert.match(await page.locator('.desktop-notes').innerText(),/不会自动打开 Chrome/);
 for(const width of [1320,800,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.setViewportSize({width:1320,height:1000});await page.screenshot({path:path.join(results,'synthetic-ui.png'),fullPage:true});assert.deepEqual(errors,[]);
 report.passed=true;report.checks=['Desktop display renders independently of browserRunning','Revised lifecycle explanation','No horizontal overflow at 1320/800/390'];
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
