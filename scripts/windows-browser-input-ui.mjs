// Focus regression against the real component. The RFB transport and HTTP
// clipboard response are synthetic; this is not an actual VM acceptance.
import {build} from 'vite';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WINDOWS_SOURCE_VERSION as version} from '../shared/windows-release.ts';
import {fixturePng} from './clipboard-image-fixture.ts';
const root=path.resolve(import.meta.dirname,'..'),expectFailure=process.argv.includes('--expect-failure');
const source=await readFile(root+'/src/windows/WindowsBrowserView.tsx');
const entryFile=root+'/.mu-data/windows-run/browser-text-focus-entry.tsx';
await writeFile(entryFile,`import React from 'react';import {createRoot} from 'react-dom/client';import WindowsBrowserView from '../../src/windows/WindowsBrowserView.tsx';import '../../src/windows/windows.css';
window.fixtureHostClipboardText='';window.fixtureHostClipboardReads=0;window.fixtureFullscreenCalls=[];window.fixtureHostImageWrites=[];
window.muWindowsDesktop={readClipboardText:async()=>{window.fixtureHostClipboardReads++;return window.fixtureHostClipboardText;},writeClipboardText:async value=>{window.fixtureHostClipboardText=value;},writeClipboardImage:async data=>{window.fixtureHostImageWrites.push(Array.from(data));return {ok:true,width:2,height:2};},setViewerFullscreen:async value=>{window.fixtureFullscreenCalls.push(value);window.fixtureFullscreenListener?.(value);return value;},onViewerFullscreenChange:listener=>{window.fixtureFullscreenListener=listener;return()=>{window.fixtureFullscreenListener=null;};}};
window.__MU_CONFIG__={token:'local-synthetic',platform:'win32',capabilities:{files:true,translation:true,audio:false,imageClipboard:true}};const root=createRoot(document.getElementById('root'));window.fixtureRender=value=>root.render(value?<WindowsBrowserView environment={{id:'e3654368-eebb-4eea-9c31-dcc29f9cab51',cpus:2,identity:{timezone:'Asia/Taipei'}}}/>:null);window.fixtureRender(true);`);
const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,emptyOutDir:false,minify:false,lib:{entry:entryFile,formats:['iife'],name:'MuTextFocus'}},plugins:[{name:'synthetic-rfb',enforce:'pre',resolveId(id){if(id==='@novnc/novnc')return '\0synthetic-rfb';},load(id){if(id==='\0synthetic-rfb')return "export default class RFB extends EventTarget{constructor(){super();setTimeout(()=>this.dispatchEvent(new Event('connect')),20)}focus(){}sendKey(){}disconnect(){}}";}}]});
const output=(Array.isArray(result)?result[0]:result).output,bundled=output.find(o=>o.type==='chunk').code,styles=output.filter(o=>o.type==='asset'&&o.fileName.endsWith('.css')).map(o=>o.source).join('\n');
const inputFiles=[...new Set((Array.isArray(result)?result:[result]).flatMap(r=>r.output.filter(o=>o.type==='chunk').flatMap(o=>Object.keys(o.modules))).map(file=>file.replaceAll('\\','/')).filter(file=>file.startsWith(root.replaceAll('\\','/')+'/')&&!file.includes('/node_modules/')&&!file.includes('/.mu-data/')).map(file=>path.relative(root,file).replaceAll('\\','/')).concat(['scripts/windows-browser-input-ui.mjs','scripts/clipboard-image-fixture.ts','shared/windows-release.ts']))];
const inputHashes=Object.fromEntries(await Promise.all(inputFiles.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
const displayRequests=[];let reads=0,translationRequests=0,imageMissing=false;const imagePng=fixturePng();
const server=createServer((req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundled);return;}
 if(req.url==='/fixture.css'){res.setHeader('Content-Type','text/css');res.end(styles);return;}
 if(req.url?.endsWith('/guest-browser')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true,running:true,display:{cssWidth:1600,cssHeight:1000,scaleFactor:2,mode:'fixed',width:3200,height:2000,matched:true,browserScaleFactor:2}}));return;}
 if(req.url?.endsWith('/guest-browser/display')){let body='';req.on('data',data=>body+=data);req.on('end',()=>{const display=JSON.parse(body);displayRequests.push(display);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...display,width:display.cssWidth*display.scaleFactor,height:display.cssHeight*display.scaleFactor,browserScaleFactor:display.scaleFactor,matched:true}));});return;}
 if(req.url?.includes('/transfer-files')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({files:[],total:0,nextCursor:null}));return;}
 if(req.url?.endsWith('/guest-browser-ticket')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ticket:'synthetic-only',password:'synthetic-only'}));return;}
 if(req.url?.endsWith('/clipboard/read')){reads++;res.setHeader('Content-Type','application/json');setTimeout(()=>res.end(JSON.stringify({text:'测试20'})),300);return;}
 if(req.url?.endsWith('/clipboard/image/read')){res.setHeader('Content-Type','application/json');setTimeout(()=>{res.statusCode=imageMissing?409:200;res.end(JSON.stringify(imageMissing?{error:'沙箱剪贴板没有 PNG 图片',code:'GUEST_CLIPBOARD_IMAGE_UNAVAILABLE'}:{data:imagePng.toString('base64'),width:2,height:2,bytes:imagePng.length}));},300);return;}
 if(req.url?.endsWith('/translate-text')){translationRequests++;res.statusCode=405;res.end('Translation is outside this local fixture');return;}
 if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>*{box-sizing:border-box}body{font:16px sans-serif}textarea{width:600px;height:150px}button{margin:8px}</style><div id="root"></div><script type="module" src="/bundle.js"></script>');return;}
 res.statusCode=404;res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({channel:'chrome',headless:true});
const report={time:new Date().toISOString(),version,scope:'isolated real browser and floating input components with synthetic RFB and clipboards',inputHashes,sourceSha256:createHash('sha256').update(source).digest('hex'),expectFailure,complete:false};
try{
 const context=await browser.newContext({viewport:{width:1200,height:900}});await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.getByText('已连接',{exact:true}).waitFor({timeout:5000}).catch(async error=>{console.log(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error;});
 // Record actual focus transitions, not fabricated composition events.
 await page.evaluate(()=>{window.fixtureFocus=[];document.addEventListener('focusout',e=>window.fixtureFocus.push({from:e.target.textContent||e.target.getAttribute('aria-label'),to:e.relatedTarget?.textContent??null}),true);});
 await page.getByText('备用输入与图片工具',{exact:true}).click();await page.getByRole('button',{name:'取回客体文字',exact:true}).click();await page.waitForTimeout(600);
 report.reads=reads;report.text=await page.getByRole('textbox',{name:'浏览器待粘贴文字',exact:true}).inputValue();report.focus=await page.evaluate(()=>window.fixtureFocus);report.error=await page.getByText('文字或画面已变化，已保留当前输入；请重新取回。',{exact:true}).count();report.pageErrors=errors;
 if(expectFailure){assert.equal(report.error,1);assert.equal(report.text,'');}else{assert.equal(report.error,0);assert.equal(report.text,'测试20');}
 assert.equal(reads,1);
 if(!expectFailure){
  const draft=page.getByRole('textbox',{name:'浏览器待粘贴文字',exact:true});
  await draft.fill('');await page.getByRole('button',{name:'取回客体文字',exact:true}).click();await draft.fill('保留我的输入');await page.waitForTimeout(600);
  assert.equal(await draft.inputValue(),'保留我的输入');assert.equal(await page.getByText('文字或画面已变化，已保留当前输入；请重新取回。',{exact:true}).count(),1);report.editedDraftPreserved=true;
  await page.reload();await page.getByText('已连接',{exact:true}).waitFor();await page.getByText('备用输入与图片工具',{exact:true}).click();await page.getByRole('button',{name:'取回客体文字',exact:true}).click();await page.getByRole('button',{name:'重新连接画面',exact:true}).click();await page.getByText('已连接',{exact:true}).waitFor();await page.waitForTimeout(600);
  assert.equal(await draft.inputValue(),'');report.reconnectedViewRejectsOldRead=true;assert.equal(reads,3);
  const floating=page.getByRole('textbox',{name:'中文或其他文字',exact:true});
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Y',code:'',ctrlKey:true,shiftKey:true,bubbles:true})));await floating.waitFor({state:'visible',timeout:2000});
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Y',code:'Unidentified',ctrlKey:true,shiftKey:true,bubbles:true})));await floating.waitFor({state:'hidden',timeout:2000});
  await page.keyboard.press('Control+Shift+Y');await floating.waitFor({state:'visible'});report.missingCodeShortcutToggles=true;
  for(const extra of [{repeat:true},{isComposing:true},{keyCode:229}]){await page.evaluate(extra=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Y',code:'',ctrlKey:true,shiftKey:true,bubbles:true,...extra})),extra);assert.equal(await floating.isVisible(),true);}
  await page.evaluate(()=>{window.dispatchEvent(new CompositionEvent('compositionstart'));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Y',code:'',ctrlKey:true,shiftKey:true,bubbles:true}));});assert.equal(await floating.isVisible(),true);await page.evaluate(()=>window.dispatchEvent(new CompositionEvent('compositionend')));report.shortcutCompositionAndRepeatProtected=true;
  await floating.fill('保留我的草稿');await floating.press('Control+A');await page.getByRole('button',{name:'粘贴',exact:true}).click();await page.waitForTimeout(150);
  report.emptyClipboardBefore='保留我的草稿';report.emptyClipboardAfter=await floating.inputValue();report.emptyClipboardSelectionPreserved=report.emptyClipboardAfter===report.emptyClipboardBefore;
  assert.equal(report.emptyClipboardAfter,report.emptyClipboardBefore);assert.equal(await page.getByText('剪贴板中没有可粘贴的普通文字，原有草稿已保留。',{exact:true}).count(),1);
  await page.evaluate(()=>{window.fixtureHostClipboardText=' \t ';});await floating.click();await floating.press('Control+A');await page.getByRole('button',{name:'粘贴',exact:true}).click();await page.waitForTimeout(150);
  assert.equal(await floating.inputValue(),' \t ');report.whitespaceClipboardAccepted=true;report.hostClipboardReads=await page.evaluate(()=>window.fixtureHostClipboardReads);assert.equal(report.hostClipboardReads,2);
  await page.getByRole('button',{name:'收起中文输入',exact:true}).click();
  await page.getByRole('button',{name:'全屏画面',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).waitFor();
  const bounds=await page.locator('.windows-browser').boundingBox();assert.deepEqual(bounds,{x:0,y:0,width:1200,height:900});assert.equal(await page.evaluate(()=>document.fullscreenElement===null),true);report.nativeBridgeFillsViewport=true;
  await page.getByRole('button',{name:'中文输入与翻译',exact:true}).click();assert.equal(await floating.inputValue(),' \t ');await floating.fill('全屏草稿');await floating.press('Escape');assert.equal(await page.getByRole('button',{name:'退出全屏',exact:true}).count(),1);report.floatingEscapeRetainsFullscreen=true;
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'全屏画面',exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.fixtureFullscreenCalls),[true,false]);report.nativeEscapeReturns=true;
  await page.getByRole('button',{name:'全屏画面',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).waitFor();await page.evaluate(()=>window.fixtureFullscreenListener(false));await page.getByRole('button',{name:'全屏画面',exact:true}).waitFor();report.nativeExitEventReturns=true;
  await page.getByRole('button',{name:'全屏画面',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).waitFor();await page.evaluate(()=>window.fixtureRender(false));await page.waitForTimeout(100);assert.deepEqual(await page.evaluate(()=>window.fixtureFullscreenCalls),[true,false,true,true,false]);report.unmountLeavesNativeFullscreen=true;
  await page.evaluate(()=>{delete window.muWindowsDesktop.setViewerFullscreen;window.fixtureRender(true);});await page.getByText('已连接',{exact:true}).waitFor();await page.getByRole('button',{name:'全屏画面',exact:true}).click();await page.waitForFunction(()=>document.fullscreenElement?.classList.contains('windows-browser'));await page.getByRole('button',{name:'退出全屏',exact:true}).click();await page.waitForFunction(()=>document.fullscreenElement===null);report.standardWebFullscreenReturns=true;
  if(await page.locator('.windows-input-fallback').getAttribute('open')===null)await page.getByText('备用输入与图片工具',{exact:true}).click();
  const preview=page.getByRole('img',{name:'取回的沙箱剪贴板图片',exact:true}),receiveImage=page.getByRole('button',{name:'取回沙箱图片',exact:true});
  await receiveImage.click();await preview.waitFor();assert.equal(await page.evaluate(()=>window.fixtureHostImageWrites.length),0);assert.equal(await preview.getAttribute('src'),'data:image/png;base64,'+imagePng.toString('base64'));report.imageReceiveOnlyPreviews=true;
  await page.getByRole('button',{name:'复制图片到 Windows',exact:true}).click();await page.getByText('图片已复制到 Windows，可在本机应用中粘贴。',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.fixtureHostImageWrites),[Array.from(imagePng)]);report.imageCopyRequiresSecondClick=true;
  await receiveImage.click();await page.getByRole('button',{name:'重新连接画面',exact:true}).click();await page.getByText('已连接',{exact:true}).waitFor();await page.waitForTimeout(500);assert.equal(await preview.count(),0);assert.equal(await page.evaluate(()=>window.fixtureHostImageWrites.length),1);report.staleImageReadDiscarded=true;
  imageMissing=true;await receiveImage.click();await page.getByText('沙箱剪贴板没有 PNG 图片',{exact:true}).waitFor();assert.equal(await preview.count(),0);assert.equal(await page.evaluate(()=>window.fixtureHostImageWrites.length),1);report.emptyGuestImagePreservesHost=true;
 }
 await page.getByRole('button',{name:'显示设置',exact:true}).click();await page.getByRole('combobox',{name:'固定桌面尺寸',exact:true}).selectOption('1440x900');await page.waitForTimeout(700);assert.ok(displayRequests.some(value=>value.cssWidth===1440&&value.cssHeight===900&&value.mode==='fixed'&&value.scaleFactor===2));await page.getByRole('combobox',{name:'画面查看方式',exact:true}).selectOption('native');assert.equal(await page.locator('.windows-browser-native').count(),1);report.displaySettingsReachGuest=true;
 const fixedRequestCount=displayRequests.length;await page.setViewportSize({width:1000,height:800});await page.waitForTimeout(700);assert.equal(displayRequests.length,fixedRequestCount);await page.getByRole('combobox',{name:'虚拟桌面模式',exact:true}).selectOption('adaptive');await page.waitForTimeout(700);assert.equal(displayRequests.at(-1).mode,'adaptive');await page.setViewportSize({width:1200,height:900});report.fixedAndAdaptiveDisplayModes=true;
 await page.getByRole('button',{name:'文件与粘贴',exact:true}).click();await page.getByRole('heading',{name:'文件与复制粘贴',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'项目目录',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'文字复制粘贴',exact:true}).click();await page.getByRole('button',{name:'复制到 Windows',exact:true}).waitFor();assert.equal(await page.getByText('Windows → 沙箱',{exact:true}).count(),1);assert.equal(await page.getByText('Mac → 沙箱',{exact:true}).count(),0);report.commonMacToolsUseWindowsClipboardAndBoundary=true;await page.getByRole('button',{name:'取回沙箱文字',exact:true}).click();await page.getByRole('textbox',{name:'从沙箱取回的文字',exact:true}).waitFor();await page.getByRole('button',{name:'复制到 Windows',exact:true}).click();assert.equal(await page.evaluate(()=>window.fixtureHostClipboardText),'测试20');report.commonToolsWriteWindowsClipboardOnlyAfterClick=true;
 assert.deepEqual(errors,[]);assert.equal(translationRequests,0);report.translationRequests=translationRequests;report.totalReads=reads;report.checks=expectFailure?1:21;report.complete=true;await context.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await writeFile(root+'/.mu-data/windows-run/browser-input-ui-preview'+version.split('.').at(-1)+(expectFailure?'-failure':'')+'.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
