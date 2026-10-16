import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createService } from '../server/service.ts';

const root=path.resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(path.join(homedir(),'.mu-wg-ui-'));
const results=path.join(root,'test-results');
await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}});
const errors:string[]=[], responses:unknown[]=[], edits:unknown[]=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.status()>=400&&new URL(response.url()).pathname.startsWith('/api/'))responses.push({status:response.status(),path:new URL(response.url()).pathname});});
page.on('request',request=>{if(request.method()==='PUT')edits.push(request.postDataJSON());});
const privateKey=randomBytes(32).toString('base64'), peerPublicKey=randomBytes(32).toString('base64');
const label='WireGuard · 测试';
const report:Record<string,unknown>={passed:false,scope:'Local UI and configuration API only; no VM, peer connection or account',startedAt:new Date().toISOString()};
try {
  const e=await service.manager.create({name:'整包隧道配置验收',memoryGiB:2,network:{mode:'http',host:'127.0.0.1',username:'synthetic-user',password:'synthetic-password'}});
  await page.goto(service.launchUrl());
  await page.getByRole('button',{name:'整包隧道配置验收 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'网络',exact:true}).click();
  await page.getByRole('button',{name:label,exact:true}).click();
  const strict=page.getByRole('checkbox',{name:'强制隧道联网（Linux 防火墙）'});
  assert.ok(await strict.isChecked()&&await strict.isDisabled());
  assert.equal(await page.getByRole('button',{name:'应用代理',exact:true}).count(),0);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('请填写隧道对端公钥。',{exact:true}).waitFor();
  assert.equal(edits.length,0);
  await page.getByRole('textbox',{name:'隧道端点 IPv4',exact:true}).fill('192.0.2.1');
  await page.getByRole('textbox',{name:'隧道 IPv4 /32',exact:true}).fill('10.77.0.2/32');
  await page.getByRole('textbox',{name:'对端公钥',exact:true}).fill(peerPublicKey);
  const secret=page.locator('input[aria-label="隧道私钥"]');
  assert.equal(await secret.getAttribute('type'),'password');
  await secret.fill(privateKey);
  async function save() {
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/environments/${e.id}`&&r.request().method()==='PUT');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    const result=await response;
    assert.equal(result.status(),200);
    assert.ok(!(await result.text()).includes(privateKey));
  }
  await save();
  let stored=service.manager.store.get(e.id);
  assert.equal(stored.network.mode,'wireguard');
  assert.equal(stored.network.password,undefined);
  assert.equal(stored.network.username,'');
  assert.equal(stored.network.wireguard?.privateKey,privateKey);
  await page.reload();
  await page.getByRole('button',{name:'整包隧道配置验收 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'网络',exact:true}).click();
  assert.equal(await secret.inputValue(),'');
  assert.match(await secret.getAttribute('placeholder')??'',/已保存/);
  await save();
  assert.equal(service.manager.store.get(e.id).network.wireguard?.privateKey,privateKey);
  for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:width===1440?960:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const collisions=await page.locator('.network-editor input,.network-editor button').evaluateAll(elements=>elements.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')??e.textContent})).filter(e=>e.tag!=='INPUT'));
    assert.deepEqual(collisions,[]);
    await page.screenshot({path:path.join(results,`wireguard-ui-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:960});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await save();
  assert.equal(service.manager.store.get(e.id).network.wireguard?.privateKey,privateKey);
  await page.getByRole('button',{name:'网络',exact:true}).click();
  await page.getByRole('button',{name:'直连',exact:true}).click();
  await save();
  stored=service.manager.store.get(e.id);
  assert.equal(stored.network.wireguard,undefined);
  assert.ok(!stored.network.strict&&!stored.network.transparent);
  await page.getByRole('button',{name:'新建环境',exact:true}).first().click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:label,exact:true}).click();
  await dialog.getByRole('button',{name:/^本机浏览器/}).click();
  assert.ok(await dialog.getByRole('button',{name:label,exact:true}).isDisabled());
  assert.ok(await dialog.getByRole('button',{name:'创建环境',exact:true}).isDisabled());
  assert.ok(service.manager.store.list().every(e=>e.state==='not_created'));
  assert.deepEqual(errors,[]);assert.deepEqual(responses,[]);
  report.passed=true;
  report.checks=['locked strict routing','required peer and private key','password input','encrypted save and redacted API','blank secret retained on reload and unrelated edits','direct mode removes secret','Mac mode rejected','1440/390/320 layouts'];
} catch(error) {report.error=(error as Error).message;process.exitCode=1;}
finally {
  report.browserErrors=errors;report.responseErrors=responses;report.finishedAt=new Date().toISOString();
  await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});
  await writeFile(path.join(results,'wireguard-ui.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
