import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createService} from '../server/service.ts';
import {desktopProfile} from '../server/guest-desktop.ts';

const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-desktop-ui-'));
const results=path.join(root,process.argv.includes('--layout')?'test-results/desktop-layout':process.argv.includes('--installation-state')?'test-results/desktop-installation-state':'test-results/managed-desktop');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1320,height:900},deviceScaleFactor:2});
const calls:unknown[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const report:Record<string,unknown>={passed:false,scope:'Isolated synthetic UI; no account or production environment'};
try {
  // This temp-data fixture has no real VM or approved lease. Disable its real
  // monitor so synthetic UI state is not quarantined mid-test; production is untouched.
  clearInterval(service.manager.protectionTimer);
  await service.manager.networkObserver.close();service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
  const e=await service.manager.create({name:'桌面应用验证',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}});service.manager.store.state(e.id,'running');
  service.manager.desktop.status=async()=>({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'0.68.1',running:false,pid:0,profile:desktopProfile('grok-bot')},{id:'claude-desktop',installed:false,installedVersion:null,running:false,pid:0,profile:desktopProfile('claude-desktop')}]});
  service.manager.desktopAction=async(id,application,action)=>{calls.push({id,application,action});const job=service.manager.store.newJob(id,`desktop-${action}`);service.manager.store.finishJob(job.id,'succeeded','Synthetic operation');return service.manager.store.jobs().find(j=>j.id===job.id)!;};
  await page.goto(service.launchUrl());await page.getByRole('button',{name:'桌面应用验证 Linux 沙箱'}).click();await page.getByRole('button',{name:'桌面应用',exact:true}).click();
  await page.getByRole('heading',{name:'Grok Bot',exact:true}).waitFor();await page.getByRole('heading',{name:'Claude Desktop',exact:true}).waitFor();
  await page.getByText('已安装 0.68.1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'安装官方客户端',exact:true}).click();assert.deepEqual(calls.at(-1),{id:e.id,application:'claude-desktop',action:'install'});
  await page.getByRole('button',{name:'打开客户端',exact:true}).click();assert.deepEqual(calls.at(-1),{id:e.id,application:'grok-bot',action:'start'});
  await page.screenshot({path:path.join(results,'desktop-panel.png'),fullPage:true});
  for(const width of [800,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.setViewportSize({width:1320,height:900});await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'彻底重建环境',exact:true}).click();
  const modal=page.getByRole('dialog');assert.match(await modal.innerText(),/Chrome \/ Claude \/ Grok/);assert.match(await modal.innerText(),/Mac 上的共享源文件保留/);assert.match(await modal.innerText(),/普通关闭重开、切换查看环境会保留资料/);
  assert.equal(await modal.getByRole('button',{name:'确认清除并创建全新环境'}).count(),1);
  await page.screenshot({path:path.join(results,'clean-rebuild-confirmation.png')});await modal.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'桌面应用',exact:true}).click();
  await service.manager.create({name:'另一个空白环境'});
  await page.getByRole('button',{name:'另一个空白环境 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'桌面应用',exact:true}).click();
  await page.getByText('启动后检测',{exact:true}).first().waitFor();
  assert.equal(await page.getByText('已安装 0.68.1',{exact:true}).count(),0,'Previous environment installation state must not carry over');
  assert.equal(await page.getByRole('button',{name:'安装官方客户端',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'安装状态待检测',exact:true}).count(),2);
  await page.getByRole('button',{name:'桌面应用验证 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'桌面应用',exact:true}).click();
  await page.getByText('已安装 0.68.1',{exact:true}).waitFor();
  service.manager.store.state(e.id,'stopped');
  await page.getByText('启动后检测',{exact:true}).first().waitFor();
  assert.equal(await page.getByText('未安装',{exact:true}).count(),0,'Stopped does not mean uninstalled');
  assert.equal(await page.getByText('已安装 0.68.1',{exact:true}).count(),0,'Running status is not asserted from stale data');
  await page.screenshot({path:path.join(results,'stopped-installation-state.png'),fullPage:true});
  service.manager.store.state(e.id,'error','无法确认批准的出口：不足两个独立出口回执，联网保持关闭');
  await page.getByText('环境暂时停止',{exact:true}).waitFor();
  assert.equal(await page.locator('.desktop-state-summary').count(),1);
  assert.equal(await page.locator('.desktop-panel > .notice').count(),0,'Stop guidance and reason should be one summary');
  const layout=await page.evaluate(()=>{
    const r=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect();
    const status=r('.environment-header-actions > .status'),toggle=r('.environment-toggle');
    return {controlsOffset:Math.abs((status.top+status.height/2)-(toggle.top+toggle.height/2)),cardsOffset:r('.desktop-app-grid').top-r('.desktop-panel').top};
  });
  assert.ok(layout.controlsOffset<2,'Header state and main control must align');
  assert.ok(layout.cardsOffset<200,'Repeated notices must not push cards down');
  report.layout=layout;
  await page.screenshot({path:path.join(results,'error-desktop-layout.png'),fullPage:true});
  for(const width of [800,390]){
    await page.setViewportSize({width,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const outOfBounds=await page.evaluate(()=>['.environment-header-actions','.environment-toggle','.environment-restart','.desktop-state-summary','.desktop-app-grid',...Array.from(document.querySelectorAll('.desktop-app-card')).map((_,i)=>`.desktop-app-card:nth-child(${i+1})`)].filter(selector=>{const r=document.querySelector(selector)!.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;}));
    assert.deepEqual(outOfBounds,[],`Controls and cards must fit within ${width}px viewport, including overflow-hidden containers`);
    await page.screenshot({path:path.join(results,`error-layout-${width}.png`),fullPage:false});
  }
  await page.setViewportSize({width:1320,height:900});
  service.manager.desktop.status=async()=>{throw new Error('合成安装状态读取失败');};
  service.manager.store.state(e.id,'running');
  await page.getByText('检测失败',{exact:true}).first().waitFor();
  assert.equal(await page.getByText('未安装',{exact:true}).count(),0,'Inspection failure does not mean uninstalled');
  assert.equal(await page.getByRole('button',{name:'安装官方客户端',exact:true}).count(),0);
  service.manager.desktop.status=async()=>({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'0.68.1',running:false,pid:0,profile:desktopProfile('grok-bot')},{id:'claude-desktop',installed:false,installedVersion:null,running:false,pid:0,profile:desktopProfile('claude-desktop')}]});
  await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByText('已安装 0.68.1',{exact:true}).waitFor();
  assert.equal(await page.getByText('未安装',{exact:true}).count(),1,'Only confirmed missing package shows uninstalled');
  await page.screenshot({path:path.join(results,'installation-state-recovered.png'),fullPage:true});
  assert.deepEqual(errors,[]);report.passed=true;report.actions=calls;report.checks=['Both official client cards','Correct fixed application action routes','No page overflow at 1320/800/390','Complete cleanup confirmation and external-backup boundary','Confirmation cancellation preserves environment','Stopped or unchecked installation state is unknown, not uninstalled','Switching environments never carries old installation state','Failed inspection blocks install without reporting uninstalled','Refresh recovers true installed and uninstalled results'];
}catch(error){report.error=error instanceof Error?error.stack:String(error);report.visibleText=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(results,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
