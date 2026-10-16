import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createService } from '../dist-server/server/service.js';
import { APPROVED_BROWSER_RELEASES, CURRENT_BROWSER_RELEASE } from '../dist-server/server/browser-releases.js';

const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-browser-upgrade-ui-'));
const artifacts=path.join(root,'test-results',`browser-upgrade-ui-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
const service=await createService({rootDir:root,dataDir:owned,port:0});
const {manager,guestBrowser}=service;
// UI state/operation fixtures exercise real authenticated routes and jobs without launching another VM.
manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
manager.assertAccess=async()=>undefined;
let installed=APPROVED_BROWSER_RELEASES[0].version,pending=false,release;
guestBrowser.versionStatus=async()=>({installedVersion:installed,availableVersion:CURRENT_BROWSER_RELEASE.version,updateAvailable:installed!==CURRENT_BROWSER_RELEASE.version,recoveryRequired:pending});
guestBrowser.update=async()=>{await new Promise(resolve=>{release=resolve;});installed=CURRENT_BROWSER_RELEASE.version;};
guestBrowser.recover=async()=>{await new Promise(resolve=>{release=resolve;});pending=false;};
const browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{const url=new URL(request.url());if(url.pathname.includes('/browser/'))requests.push({path:url.pathname,method:request.method()});});
const report={passed:false,scope:'Source-built browser-version UI with fixture state; real authenticated API and operation locks, no actual VM or Electron package',electronPackageTested:false,actualVmTested:false};
try{
  const environment=await manager.create({name:'Browser upgrade UI acceptance'});manager.store.state(environment.id,'running');
  await page.goto(service.launchUrl());await page.getByRole('button',{name:'Browser upgrade UI acceptance Linux 沙箱',exact:true}).click();
  await page.getByRole('button',{name:'浏览器',exact:true}).click();
  await page.getByText(installed,{exact:true}).waitFor();
  await page.screenshot({path:path.join(artifacts,'desktop-upgrade.png'),fullPage:true});
  await page.getByRole('button',{name:'更新浏览器',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('button[title="检测浏览器版本"]')?.disabled);
  assert.ok(await page.getByRole('button',{name:'更新浏览器',exact:true}).isDisabled());
  const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  const conflict=await fetch(`${service.url}/api/environments/${environment.id}/browser/open`,{method:'POST',headers});assert.equal(conflict.status,409);
  while(!release)await new Promise(resolve=>setTimeout(resolve,10));release();release=undefined;
  await page.getByText('当前版本',{exact:true}).waitFor();assert.equal(installed,CURRENT_BROWSER_RELEASE.version);
  assert.ok(await page.getByRole('button',{name:'更新浏览器',exact:true}).isDisabled());
  installed=APPROVED_BROWSER_RELEASES[0].version;pending=true;
  await page.getByRole('button',{name:'检测浏览器版本',exact:true}).click();await page.getByText('等待恢复',{exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'更新浏览器',exact:true}).isDisabled());
  await page.getByRole('button',{name:'恢复浏览器',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('button[title="检测浏览器版本"]')?.disabled);
  while(!release)await new Promise(resolve=>setTimeout(resolve,10));release();release=undefined;
  await page.getByText('可更新',{exact:true}).waitFor();assert.equal(pending,false);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(artifacts,'mobile-upgrade.png'),fullPage:true});
  const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
    labels:[...document.querySelectorAll('.network-test .facts dd,.network-test button')].filter(e=>e.offsetWidth).map(e=>({text:e.textContent,width:e.clientWidth,scroll:e.scrollWidth}))}));
  assert.ok(bounds.scroll<=bounds.width,'Mobile page must not scroll horizontally');assert.deepEqual(bounds.labels.filter(e=>e.scroll>e.width+1),[]);
  assert.deepEqual(errors,[]);
  assert.ok(requests.some(item=>item.method==='POST'&&item.path.endsWith('/browser/update')));assert.ok(requests.some(item=>item.method==='POST'&&item.path.endsWith('/browser/recover')));
  report.passed=true;report.requests=requests;report.mobileBounds=bounds;report.jobActions=manager.store.jobs().map(item=>({action:item.action,status:item.status}));
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  release?.();await browser.close();await service.close();await rm(owned,{recursive:true});report.testResourcesRemoved=true;
  report.artifactsDirectory=artifacts;await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await writeFile(path.join(root,'test-results/browser-upgrade-ui.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
