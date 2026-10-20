import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import { createService } from '../server/service.ts';
import type { NetworkObservations } from '../shared/network-observations.ts';

const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-destinations-ui-'));
const results=path.join(root,'test-results/network-destinations');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1320,height:900},deviceScaleFactor:2});
const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
const now=new Date().toISOString();
const fixture:NetworkObservations={enabled:true,capture:'ready',captureGaps:0,startedAt:now,collectedAt:now,sampleIntervalSeconds:30,lockIp:'203.0.113.10',samples:[],summary:{state:'unchanged',lastIp:'203.0.113.10',lastCheckedAt:now,firstCheckedAt:now,distinctIps:1,changes:0,successes:2,failures:0},connections:[
  {id:1,at:now,target:'104.26.13.205',domain:'api.ipify.org',domainSource:'connection',port:443,status:'attempt',protocol:'TCP',route:'proxy',exitIp:'203.0.113.10',exitCheckedAt:now,exitSource:'verification'},
  {id:2,at:now,target:'203.0.113.22',domain:'one.example',domainSource:'dns',port:443,status:'attempt',protocol:'TCP',route:'proxy',exitIp:'203.0.113.10',exitCheckedAt:now,exitSource:'observation'},
  {id:3,at:now,target:'203.0.113.33',domainCandidates:['one.example','two.example'],port:443,status:'attempt',protocol:'TCP',route:'proxy'},
  {id:4,at:now,target:'203.0.113.44',port:443,status:'failed',protocol:'TCP',route:'proxy'},
]};
const report:Record<string,unknown>={passed:false,scope:'Isolated synthetic UI, no production data or network changes',checks:[]};
try {
  await service.manager.networkObserver.close();
  service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
  const e=await service.manager.create({name:'网络目标显示验证',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}});
  service.manager.store.state(e.id,'running');service.manager.networkObserver.info=()=>fixture;
  await page.goto(service.launchUrl());
  await page.getByRole('button',{name:'网络目标显示验证 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'日志',exact:true}).click();
  await page.getByRole('combobox',{name:'连接类型'}).selectOption('all');
  await page.getByRole('combobox',{name:'连接展示方式'}).selectOption('table');
  const table=page.locator('.network-connections-table');await table.waitFor();
  assert.equal(await table.getByRole('columnheader',{name:/目标网址/}).count(),1);
  assert.equal(await table.getByRole('columnheader',{name:/沙箱出口 IP/}).count(),1);
  const first=table.getByRole('row').filter({hasText:'api.ipify.org'});assert.match(await first.innerText(),/服务器 104\.26\.13\.205/);assert.match(await first.innerText(),/203\.0\.113\.10/);
  assert.equal(await table.getByText('DNS 对照',{exact:true}).count(),1);
  assert.equal(await table.getByText('未留有效回执',{exact:true}).count(),2);
  const search=page.getByRole('textbox',{name:'搜索网络连接'});
  await search.fill('api.ipify.org');assert.equal(await table.locator('tbody tr').count(),1);
  await search.fill('203.0.113.10');assert.equal(await table.locator('tbody tr').count(),2);
  await search.fill('');await page.getByRole('checkbox',{name:'只看失败'}).check();assert.equal(await table.locator('tbody tr').count(),1);
  await page.getByRole('checkbox',{name:'只看失败'}).uncheck();
  await table.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(results,'desktop.png')});
  for(const width of [800,390]) {await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  fixture.enabled=false;fixture.summary.state='stale';
  await expect(page.getByText('沙箱已停止，暂停检测',{exact:true})).toBeVisible({timeout:10000});
  await expect(page.getByText('回执已过期',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'立即检测',exact:true})).toBeDisabled();
  await expect(page.locator('.exit-observation-main strong')).toHaveText('203.0.113.10');
  await expect(page.getByText('检测说明',{exact:true})).toBeVisible();
  fixture.enabled=true;
  await expect(page.getByText('检测结果较旧，等待刷新',{exact:true})).toBeVisible({timeout:10000});
  assert.deepEqual(errors,[]);report.checks=['Website domain and destination server IP are distinct','Exit receipt IP and time are visible','DNS references and ambiguous domains are labelled','Old rows do not receive the current IP','Domain/exit search and failures filter','No page overflow at 1320, 800, 390 pixels'];report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
