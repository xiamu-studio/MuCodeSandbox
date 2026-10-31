import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

// Local component fixture: no actual IME, VM, clipboard or external requests.
const root=path.resolve(import.meta.dirname,'..'),cache=await mkdtemp(path.join(tmpdir(),'mu-compose-guard-'));
const source=`import React from 'react';import{createRoot}from'react-dom/client';import Input from '/src/GuestTextInput.tsx';window.__MU_CONFIG__={token:'fixture'};window.fixtureKeys=[];window.fixturePastes=[];function Test(){const[open,setOpen]=React.useState(true);return <Input id="fixture" connected floating visible={open} hostName={location.search?'Mac':'Windows'} onClose={()=>setOpen(false)} onPaste={async text=>window.fixturePastes.push(text)} onKey={key=>window.fixtureKeys.push(key)}/>};createRoot(document.getElementById('root')).render(<Test/>);`;
const server=await createServer({root,cacheDir:cache,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'compose-guard',resolveId(id){if(id==='/compose.tsx')return id;},load(id){if(id==='/compose.tsx')return source;},configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(!req.url?.startsWith('/compose.html'))return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/compose.tsx"></script>'));});}}]});
await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({executablePath:process.env.MU_CHROME_EXE??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage();await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1')return route.abort();if(url.pathname==='/api/environments/fixture/translate-text')return route.fulfill({json:{text:'译文',provider:'DeepSeek',target:'en',model:'fixture'}});return route.continue();});
 await page.goto(`http://127.0.0.1:${address.port}/compose.html`);const nativeField=page.getByRole('textbox',{name:'中文或其他文字'});await nativeField.fill('键盘草稿');await nativeField.focus();await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>(window as any).fixturePastes.length===1,null,{timeout:3000});assert.deepEqual(await page.evaluate(()=>(window as any).fixturePastes),['键盘草稿']);assert.equal(await nativeField.isVisible(),false);
 await page.goto(`http://127.0.0.1:${address.port}/compose.html`);const committed=page.getByRole('textbox',{name:'中文或其他文字'});await committed.fill('原文');await committed.dispatchEvent('compositionstart');await committed.evaluate(element=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,'原文最终选字');});await committed.dispatchEvent('compositionend',{data:'最终选字'});await committed.press('Control+Enter');await page.waitForFunction(()=>(window as any).fixturePastes.length===1,null,{timeout:3000});assert.deepEqual(await page.evaluate(()=>(window as any).fixturePastes),['原文最终选字']);
 await page.goto(`http://127.0.0.1:${address.port}/compose.html`);const original=page.getByRole('textbox',{name:'中文或其他文字'});await original.fill('原文');await page.getByRole('button',{name:'翻译成英文'}).click();const translated=page.getByRole('textbox',{name:'译文'});await translated.waitFor();await translated.dispatchEvent('compositionstart');await translated.evaluate(element=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,'译文最终选字');});await translated.dispatchEvent('compositionend',{data:'最终选字'});await translated.press('Control+Enter');await page.waitForFunction(()=>(window as any).fixturePastes.length===1,null,{timeout:3000});assert.deepEqual(await page.evaluate(()=>(window as any).fixturePastes),['译文最终选字']);
 for(const host of ['Windows','Mac']){
  await page.goto(`http://127.0.0.1:${address.port}/compose.html${host==='Mac'?'?mac':''}`);const field=page.getByRole('textbox',{name:'中文或其他文字'});await field.fill('中文草稿');await field.dispatchEvent('compositionstart');
  await page.locator('.guest-original-editor').getByRole('button',{name:'清空',exact:true}).evaluate(button=>(button as HTMLButtonElement).click());assert.equal(await field.inputValue(),'中文草稿');
  await page.getByRole('button',{name:'收起中文输入'}).evaluate(button=>(button as HTMLButtonElement).click());assert.equal(await field.isVisible(),true);
  await page.getByRole('button',{name:'放大查看'}).evaluate(button=>(button as HTMLButtonElement).click());assert.equal(await page.getByRole('dialog').count(),0);
  await page.locator('.guest-input-more > summary').evaluate(element=>(element as HTMLElement).click());await page.getByRole('button',{name:'回车',exact:true}).evaluate(button=>(button as HTMLButtonElement).click());assert.deepEqual(await page.evaluate(()=>(window as any).fixtureKeys),[]);
  await field.dispatchEvent('compositionend');await page.getByRole('button',{name:'回车',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixtureKeys),['enter']);
  assert.equal(await field.isVisible(),true);await field.press(host==='Mac'?'Meta+Enter':'Control+Enter');await page.waitForFunction(()=>(window as any).fixturePastes.length===1,null,{timeout:3000});assert.deepEqual(await page.evaluate(()=>(window as any).fixturePastes),['中文草稿']);
 }
 console.log('Windows and Mac component modes preserve composition and accept their normal shortcut after commit.');
}finally{await browser.close();await server.close();assert.equal(path.dirname(cache),path.resolve(tmpdir()));await rm(cache,{recursive:true,force:true});}
