import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createService} from '../server/service.ts';
import {summarizeLatency} from '../server/latency.ts';
import type {AccessLatency,LatencySample} from '../shared/latency.ts';
import type {NetworkProtection} from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-latency-ui-')),results=path.join(root,process.argv.includes('--headline')?'test-results/headline-latency':process.argv.includes('--unified')?'test-results/unified-line-delay':'test-results/access-latency');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1320,height:900},deviceScaleFactor:2});
const report:Record<string,unknown>={passed:false,scope:'Synthetic isolated UI; no actual network, VM, account or user environment'},calls:unknown[]=[],errors:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();
  service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});service.manager.runtime.revokeLease=async()=>{};
  service.manager.runtime.networkProtection=async()=>({active:true,integrity:'verified',leaseActive:true,proxyEndpoints:[],issues:[]} as unknown as NetworkProtection);
  const e=await service.manager.create({name:'延迟测试环境',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}});service.manager.store.state(e.id,'running');
  const other=await service.manager.create({name:'另一个延迟环境'});
  const cache=new Map<string,AccessLatency>();let mode:'good'|'partial'|'failed'|'denied'='good';
  let failRead=false,reads=0;
  service.manager.accessLatency=id=>{reads++;if(failRead)throw Error('合成延迟读取失败');return cache.get(id)??null;};
  service.manager.testAccessLatency=async(id,target='google')=>{
    calls.push({id,target});if(mode==='denied')throw Error('合成防护拒绝，保持关闭');
    const good=(ms:number):LatencySample=>({ok:true,lineDelayMs:ms,firstByteMs:ms+1000,totalMs:ms+1012,httpStatus:204,reusedConnection:true});
    const samples:LatencySample[]=mode==='good'?[good(100),good(250),good(180)]:mode==='partial'?[good(220),{ok:false,issue:'连接或响应超时'},good(400)]:Array.from({length:3},()=>({ok:false,issue:'连接或响应超时'}));
    const value=summarizeLatency(target,samples);cache.set(id,value);return value;
  };
  await page.goto(service.launchUrl());await page.getByRole('button',{name:'延迟测试环境 Linux 沙箱'}).click();
  const badge=page.getByRole('button',{name:'检测线路延迟',exact:true});await badge.click();await badge.getByText('180 ms',{exact:true}).waitFor();
  assert.deepEqual(calls.at(-1),{id:e.id,target:'google'});
  assert.equal(await page.locator('.environment-title-line .latency-badge').count(),1);
  assert.equal(await page.locator('.protection-banner .latency-badge').count(),0);
  const headline=await page.evaluate(()=>{
    const name=document.querySelector('.environment-title-line h1')!.getBoundingClientRect();
    const badge=document.querySelector('.environment-title-line .latency-badge')!.getBoundingClientRect();
    return {nameRight:name.right,badgeLeft:badge.left,centerDifference:Math.abs(name.top+name.height/2-badge.top-badge.height/2),numberFontPx:parseFloat(getComputedStyle(document.querySelector('.latency-badge strong')!).fontSize)};
  });
  assert.ok(headline.badgeLeft>=headline.nameRight&&headline.centerDifference<3,'Delay must sit beside the environment name on a wide window');
  assert.ok(headline.numberFontPx>=12&&headline.numberFontPx<=14,'Delay value uses compact readable typography');report.headline=headline;
  await page.getByRole('button',{name:'网络',exact:true}).click();const panel=page.locator('.access-latency-panel');
  await panel.getByText('第 1 次',{exact:true}).waitFor();assert.match(await panel.innerText(),/Clash 式统一延迟/);assert.match(await panel.innerText(),/网页首次响应耗时：1180 ms/);
  await page.getByLabel('延迟测试站点').selectOption('cloudflare');mode='partial';await panel.getByRole('button',{name:'测延迟',exact:true}).click();
  await panel.getByText('310 ms',{exact:true}).waitFor();assert.match(await panel.innerText(),/2\/3 次成功/);assert.match(await panel.innerText(),/连接或响应超时/);
  await badge.getByText('310 ms',{exact:true}).waitFor();
  failRead=true;
  await expect(panel.getByText('合成延迟读取失败',{exact:true})).toBeVisible({timeout:10000});
  await expect(badge.getByText('310 ms',{exact:true})).toHaveCount(0);
  failRead=false;
  await expect(badge.getByText('310 ms',{exact:true})).toBeVisible({timeout:10000});
  await expect(panel.getByText('合成延迟读取失败',{exact:true})).toHaveCount(0);

  assert.deepEqual(calls.at(-1),{id:e.id,target:'cloudflare'});
  await page.screenshot({path:path.join(results,'latency-network-panel.png'),fullPage:true});
  for(const width of [800,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const bad=await page.evaluate(()=>['.latency-badge','.access-latency-panel','.latency-controls','.latency-samples'].filter(selector=>{const r=document.querySelector(selector)!.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;}));assert.deepEqual(bad,[],`Latency controls fit ${width}px`);}
  await page.setViewportSize({width:1320,height:900});
  mode='failed';await panel.getByRole('button',{name:'测延迟',exact:true}).click();await panel.getByText('0/3 次成功',{exact:false}).waitFor();assert.equal(await panel.getByText('0 ms',{exact:true}).count(),0);assert.equal(await panel.getByText('310 ms',{exact:true}).count(),0);
  mode='denied';await panel.getByRole('button',{name:'测延迟',exact:true}).click();await panel.getByText('合成防护拒绝，保持关闭',{exact:true}).waitFor();assert.equal(await panel.getByText('310 ms',{exact:true}).count(),0);
  const readsAfterFailure=reads;
  await expect.poll(()=>reads,{timeout:10000}).toBeGreaterThan(readsAfterFailure);
  await expect(panel.getByText('合成防护拒绝，保持关闭',{exact:true})).toBeVisible();
  assert.equal(await badge.getByText('310 ms',{exact:true}).count(),0);
  service.manager.store.state(e.id,'stopped');await panel.getByText('先启动环境',{exact:true}).waitFor();assert.equal(await badge.isEnabled(),false);assert.equal(await panel.getByRole('button',{name:'测延迟',exact:true}).isEnabled(),false);
  await page.getByRole('button',{name:'另一个延迟环境 Linux 沙箱'}).click();await badge.getByText('先启动',{exact:true}).waitFor();assert.equal(await badge.getByText('180 ms',{exact:true}).count(),0);
  service.manager.store.save({...service.manager.store.get(e.id),name:'美国 VPS · 全新环境 · 较长环境名称用于检查自动换行和数值完整展示',state:'running'});
  await page.getByRole('button',{name:/美国 VPS · 全新环境 · 较长环境名称/}).click();
  for(const width of [1320,800,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const bad=await page.evaluate(()=>['.environment-title-line h1','.environment-title-line .latency-badge','.environment-header-actions'].filter(selector=>{const r=document.querySelector(selector)!.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;}));assert.deepEqual(bad,[],`Long name and headline delay fit ${width}px`);}
  await page.setViewportSize({width:1320,height:900});
  assert.deepEqual(errors,[]);report.passed=true;report.actions=calls;report.checks=['A temporary read error clears on successful polling in both views','A denied measurement stays failed after a successful cache read','Headline badge beside environment name runs default Google measurement','Larger value and long-name wrapping at 1320/800/390','Network page switches to Cloudflare','Partial results show count and failed sample with median','All failures never show fake 0 ms or stale value','Guard rejection does not retain a success value','Stopped and other environment do not carry latency','1320/800/390 page and internal controls fit'];
}catch(error){report.error=error instanceof Error?error.stack:String(error);report.visibleText=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(results,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
