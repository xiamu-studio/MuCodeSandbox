import { chromium } from '@playwright/test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createService } from '../dist-server/server/service.js';
const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-wizard-ui-'));
const service=await createService({rootDir:root,dataDir:owned,port:0});
const e=await service.manager.create({name:'Wizard-only disposable configuration',kind:'vm'});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1360,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(service.launchUrl());await page.getByRole('button',{name:/Wizard-only disposable configuration Linux 沙箱/}).click();
  await page.getByRole('button',{name:'网络',exact:true}).click();await page.getByRole('button',{name:'线路设置向导',exact:true}).click();
  const node=page.getByRole('combobox',{name:'独立线路节点',exact:true});
  await node.waitFor();await node.selectOption('');
  await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByRole('button',{name:'保存线路配置',exact:true}).click();
  await page.getByText('线路配置已保存',{exact:true}).waitFor();await page.getByRole('button',{name:'完成',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'代理服务器',exact:true}).inputValue(),'127.0.0.1');
  assert.equal(await page.getByRole('checkbox',{name:'仅代理联网（Linux 防火墙）',exact:true}).isChecked(),true);
  assert.equal(service.manager.store.get(e.id).network.transparent,true);
  await page.screenshot({path:path.join(root,'test-results/wizard-saved-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'使用指南',exact:true}).click();await page.getByRole('button',{name:'完整指南',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(root,'test-results/guide-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);await writeFile(path.join(root,'test-results/wizard-ui.json'),JSON.stringify({passed:true,configurationRefreshed:true,guideEntryVerified:true,smallScreenOverflow:false,vmStarted:false},null,2));
  console.log('Wizard configuration refresh and help layout passed');
}finally{await browser.close();await service.close();await rm(owned,{recursive:true,force:true});}
