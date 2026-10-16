import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createService } from '../server/service.ts';
import type { NetworkProtection } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(path.join(homedir(),'.mu-egress-ui-'));
const results=path.join(root,'test-results');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}});
const report:Record<string,unknown>={passed:false,scope:'Actual UI and persisted configuration; simulated runtime for display states, no VM network proof',checks:[]};
const checks=report.checks as string[],errors:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
  const e=await service.manager.create({name:'出口核验界面',network:{mode:'http',host:'proxy.fixture.test',strict:true,transparent:true}});
  await page.goto(service.launchUrl());
  await page.getByRole('button',{name:'出口核验界面 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'网络',exact:true}).click();
  await page.getByRole('checkbox',{name:'出口变化时停机',exact:true}).check();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('出口变化停机需要 Linux 透明代理和明确批准的 IPv4 地址。',{exact:true}).waitFor();
  checks.push('Empty approval cannot be saved or automatically adopted');
  await page.getByRole('textbox',{name:'批准的公网 IPv4',exact:true}).fill('8.8.8.8');
  const save=page.waitForResponse(response=>response.url().endsWith(`/api/environments/${e.id}`)&&response.request().method()==='PUT');
  await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal((await save).status(),200);
  assert.deepEqual(service.manager.store.get(e.id).network.egressLock,{expectedIp:'8.8.8.8'});
  checks.push('Explicit approval persists');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.waitForResponse(response=>response.url().endsWith(`/api/environments/${e.id}`)&&response.request().method()==='PUT');
  await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal((await settings).status(),200);
  assert.equal(service.manager.store.get(e.id).network.egressLock!.expectedIp,'8.8.8.8');
  checks.push('Unrelated settings preserve approval');
  await page.getByRole('button',{name:'网络',exact:true}).click();
  await page.getByText('尚未核验',{exact:true}).waitFor();
  service.manager.runtime.networkProtection=async()=>({active:true} as NetworkProtection);
  service.manager.runtime.renewLease=async()=>{};
  service.manager.measureExit=async()=>({ip:'8.8.8.8',country:'Fixture',city:'Synthetic',latencyMs:1,source:'guest'});
  service.manager.store.state(e.id,'running');await service.manager.assertAccess(e.id,true);
  await page.reload();await page.getByRole('button',{name:'出口核验界面 Linux 沙箱'}).click();await page.getByRole('button',{name:'网络',exact:true}).click();
  await page.getByText('检测一致',{exact:true}).waitFor();
  assert.ok(await page.getByRole('textbox',{name:'批准的公网 IPv4',exact:true}).isDisabled());
  checks.push('Running approval is read only and verified receipt is displayed');
  await page.screenshot({path:path.join(results,'egress-network-desktop.png'),fullPage:true});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(results,`egress-network-mobile-${width}.png`),fullPage:true});
  }
  checks.push('Desktop, 390px and 320px layout fits');
  service.manager.runtime.stop=async()=>{};
  service.manager.measureExit=async()=>({ip:'9.9.9.9',country:'Fixture',city:'Synthetic',latencyMs:1,source:'guest'});
  await service.manager.monitorProtection();
  await page.getByText('出口已变化',{exact:true}).waitFor();
  assert.equal(service.manager.store.get(e.id).network.egressLock!.expectedIp,'8.8.8.8');
  checks.push('Changed receipt is shown without overwriting approval');
  await page.setViewportSize({width:1440,height:960});
  await page.getByRole('button',{name:'应用代理',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'批准的公网 IPv4',exact:true}).count(),0);
  const switched=page.waitForResponse(response=>response.url().endsWith(`/api/environments/${e.id}`)&&response.request().method()==='PUT');
  await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal((await switched).status(),200);
  assert.equal(service.manager.store.get(e.id).network.egressLock,undefined);
  checks.push('Switching away from transparent mode removes incompatible approval');
  assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{
  report.errors=errors;await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});
  await writeFile(path.join(results,'egress-ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
