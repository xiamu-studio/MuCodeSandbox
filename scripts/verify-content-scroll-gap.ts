import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createService} from '../server/service.ts';
import {displayPixels} from '../shared/guest-display.ts';

const root=path.resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(path.join(tmpdir(),'mu-scroll-gap-'));
const results=path.join(root,'test-results/content-scroll-gap');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});
clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();
service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
service.manager.assertAccess=async()=>undefined;service.guestLinks.prepare=async()=>{};
service.manager.runtime.networkProtection=async()=>({active:true,integrity:'verified',leaseActive:true,issues:[]} as any);
service.manager.desktop.status=async()=>({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:['grok-bot','claude-desktop'].map((id:any)=>({id,installed:true,installedVersion:'fixture',running:true,pid:100,profile:'fixture',rendererProtected:true}))});
service.manager.focusApplication=async()=>({focused:true,pending:false});
service.manager.browser.versionStatus=async()=>({installedVersion:'155.0.8059.39',availableVersion:'155.0.8059.39',updateAvailable:false,recoveryRequired:false,installedChannel:'stable',availableChannel:'stable',requiresFreshProfile:false});
const environment=await service.manager.create({name:'导航与桌面高度检查',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}});
service.manager.store.state(environment.id,'running');
service.guestBrowser.running=id=>id===environment.id;
service.guestBrowser.info=()=>({running:true,ready:true,browserRunning:true,width:3200,height:2000,platform:'Linux',display:undefined});
service.guestBrowser.issue=()=>({ticket:'synthetic-gap',password:'abcdefgh'});
service.guestBrowser.resize=async(_id,input)=>({...displayPixels(input),browserScaleFactor:input.scaleFactor,matched:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const report:any={passed:false,scope:'Isolated synthetic guest display; layout at three widths and scroll positions. No real VM or production data.',samples:[]};
try {
 for(const size of [{width:1320,height:760},{width:800,height:700},{width:390,height:740}]) {
  const page=await browser.newPage({viewport:size,deviceScaleFactor:2});
  await page.addInitScript(()=>{window.muDesktop={browserAction:async()=>{},onBrowserState:()=>()=>{},onGuestApplication:()=>()=>{}};});
  await page.route('**/assets/rfb-*.js',route=>route.fulfill({contentType:'application/javascript',body:`export default class RFB extends EventTarget {constructor(target){super();const canvas=document.createElement('canvas');canvas.width=640;canvas.height=400;target.append(canvas);setTimeout(()=>this.dispatchEvent(new Event('connect')),0);}disconnect(){}sendCredentials(){}sendKey(){}focus(){}}`}));
  await page.goto(service.launchUrl());await page.getByRole('button',{name:'导航与桌面高度检查 Linux 沙箱'}).click();
  await page.getByRole('button',{name:'桌面应用',exact:true}).click();
  const view=page.locator('.retained-page:not([hidden]) .guest-browser-view');await view.getByText('已连接',{exact:true}).waitFor();
  for(const fraction of [0,0.5,1]) {
   const sample=await page.evaluate(fraction=>{
    const scroll=document.querySelector('.main-content') as HTMLElement;scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*fraction;
    const nav=document.querySelector('.topbar')!.getBoundingClientRect(),content=scroll.getBoundingClientRect(),footer=document.querySelector('.app-footer')!.getBoundingClientRect();
    const hit=document.elementFromPoint(content.left+content.width/2,nav.bottom+1);
    return {fraction,scrollTop:scroll.scrollTop,navTop:nav.top,navBottom:nav.bottom,contentTop:content.top,contentBottom:content.bottom,footerTop:footer.top,gap:content.top-nav.bottom,contentCoversGap:!!hit&&scroll.contains(hit),horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
   },fraction);
   assert.ok(sample.gap>=7.9,'The scroll viewport needs permanent separation from navigation');
   assert.equal(sample.contentCoversGap,false,'Scrolled guest content must not paint in the reserved gap');
   assert.ok(sample.contentBottom<=sample.footerTop+0.5,'Content must stay above the footer');assert.equal(sample.horizontalOverflow,false);
   report.samples.push({...size,...sample});
  }
  await view.getByRole('button',{name:'中文与快捷输入'}).click();
  await view.getByRole('textbox',{name:'中文或其他文字'}).fill('切换页面保留草稿');
  await page.getByRole('button',{name:'网络',exact:true}).click();
  await page.getByRole('button',{name:'桌面应用',exact:true}).click();
  await expect(view.getByRole('textbox',{name:'中文或其他文字'})).toHaveValue('切换页面保留草稿');
  await view.getByRole('button',{name:'收起中文输入'}).click();
  await page.route('**/transfer-files',route=>route.fulfill({json:[]}));
  const opener=view.getByRole('button',{name:'文件与粘贴',exact:true});await opener.click();
  const dialog=page.getByRole('dialog',{name:'文件与复制粘贴'});await expect(dialog).toBeFocused();await expect(dialog.getByRole('button',{name:'返回沙箱'})).toBeEnabled();
  await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'返回沙箱'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'关闭',exact:true})).toBeFocused();
  await dialog.getByRole('button',{name:'文字复制粘贴'}).click();
  const text=dialog.getByRole('textbox',{name:'要发送到沙箱的文字'});await text.fill('中文组合输入');
  await text.dispatchEvent('keydown',{key:'Escape',isComposing:true});await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
  report.samples.push({...size,interactions:['draft retained across page switch','modal owns initial focus','forward/backward tab loop','IME Escape retained','Escape closes and restores focus']});
  await view.evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.screenshot({path:path.join(results,`gap-${size.width}.png`)});await page.close();
 }
 report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
