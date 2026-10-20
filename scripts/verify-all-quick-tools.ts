import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';
import type {WebSocketRoute} from '@playwright/test';

const root=path.resolve(import.meta.dirname,'..'),results=path.join(root,'test-results/all-quick-tools');await mkdir(results,{recursive:true});
const viteCache=await mkdtemp(path.join(tmpdir(),'mu-quick-tools-vite-'));
const source=`import React from 'react';import{createRoot}from'react-dom/client';import TerminalPanel from '/src/TerminalPanel.tsx';import GuestBrowserView from '/src/GuestBrowserView.tsx';import DesktopPanel from '/src/DesktopPanel.tsx';import '/src/styles.css';import '/src/liquid.css';
window.__MU_CONFIG__={token:'local-fixture',version:'fixture'};window.rfbKeys=[];
function Harness(){const[mode,setMode]=React.useState('shell');const[id,setId]=React.useState('environment-a');const e={id,name:id,mounts:[],kind:'vm',state:'running',identity:{timezone:'America/Los_Angeles',locale:'en-US'},network:{strict:true,transparent:true}};
return <><nav>{['shell','claude','browser','desktop'].map(value=><button key={value} onClick={()=>setMode(value)}>{'fixture-'+value}</button>)}<button onClick={()=>setId(id==='environment-a'?'environment-b':'environment-a')}>fixture-switch-environment</button></nav><main key={id}>{['shell','claude','browser','desktop'].map(value=><div className="quick-tools-pane" data-mode={value} key={value} hidden={mode!==value} style={{position:'relative',padding:12}}>{value==='shell'||value==='claude'?<TerminalPanel environment={e} command={value} active={mode===value}/>:value==='browser'?<GuestBrowserView id={id} name={id} timezone={e.identity.timezone} embedded active={mode===value}/>:<DesktopPanel environment={e} snapshot={{jobs:[]}} refresh={async()=>{}} onConfigure={()=>{}} visible={mode===value}/>}</div>)}</main></>};createRoot(document.getElementById('root')).render(<Harness/>);`;
const vite=await createServer({root,cacheDir:viteCache,logLevel:'error',optimizeDeps:{exclude:['@novnc/novnc']},server:{host:'127.0.0.1',port:0},plugins:[{
 name:'all-quick-tools-fixture',enforce:'pre',resolveId(id){if(id==='/quick-tools.tsx')return id;if(id==='@novnc/novnc')return '\0quick-tools-rfb';},
 load(id){if(id==='/quick-tools.tsx')return source;if(id==='\0quick-tools-rfb')return `export default class RFB extends EventTarget{constructor(target){super();this.target=target;const c=document.createElement('canvas');c.width=3200;c.height=2000;c.style.width='100%';c.style.height='100%';target.append(c);setTimeout(()=>this.dispatchEvent(new Event('connect')),0);}sendKey(...args){window.rfbKeys.push(args);}focus(){}disconnect(){}sendCredentials(){}}`;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/quick-tools.html')return next();try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><body><div id="root"></div><script type="module" src="/quick-tools.tsx"></script></body></html>'));}catch(error){next(error);}});}
}]});await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1100,height:800}});
const errors:string[]=[],inputs:{ticket:string;data:string}[]=[],calls:string[]=[],external:string[]=[],sockets=new Map<string,WebSocketRoute>();
let connections=0,failDesktopInspection=false;
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('503'))errors.push(message.text());});
await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>{throw Error('No implicit host clipboard read');},writeText:async()=>{}}});});
await page.route('**/*',route=>{if(!['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)){external.push(route.request().url());return route.abort();}return route.continue();});
await page.route('**/api/**',route=>{
 const request=route.request(),url=new URL(request.url());calls.push(url.pathname);
 const id=url.pathname.split('/')[3];
 if(url.pathname.endsWith('/terminal-ticket'))return route.fulfill({json:{ticket:id+'-'+request.postDataJSON().command}});
 if(url.pathname.endsWith('/transfer-files')){if(request.method()==='POST'){const name=url.searchParams.get('name');return route.fulfill({json:{name,zone:'downloads',path:'/home/dev/Downloads/'+name,bytes:request.postDataBuffer()?.length??0}});}return route.fulfill({json:{files:[{name:"file's 中文.txt",path:"/home/dev/Transfers/Incoming/file's 中文.txt",zone:'incoming',bytes:10,modifiedAt:new Date().toISOString()}],total:1,nextCursor:null}});}
 if(url.pathname.endsWith('/translate-text'))return route.fulfill({json:{text:'Local English result',provider:'DeepSeek'}});
 if(url.pathname.endsWith('/desktop-apps')&&failDesktopInspection)return route.fulfill({status:503,json:{error:'Fixture status temporarily unavailable'}});
 if(url.pathname.endsWith('/desktop-apps'))return route.fulfill({json:{supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'fixture',running:true,rendererProtected:true},{id:'claude-desktop',installed:true,installedVersion:'fixture',running:false}]}});
 if(url.pathname.endsWith('/guest-focus'))return route.fulfill({json:{focused:true}});
 if(url.pathname.endsWith('/guest-browser'))return route.fulfill({json:{running:true,ready:true,browserRunning:true,width:3200,height:2000,display:{cssWidth:1600,cssHeight:1000,width:3200,height:2000,scaleFactor:2,browserScaleFactor:2,mode:'fixed',matched:true}}});
 if(url.pathname.endsWith('/guest-browser-ticket'))return route.fulfill({json:{ticket:'fake-local-rfb',password:'fixture8'}});
 if(url.pathname.endsWith('/guest-browser/display'))return route.fulfill({json:{...request.postDataJSON(),width:3200,height:2000,browserScaleFactor:2,matched:true}});
 if(url.pathname.endsWith('/clipboard/write'))return route.fulfill({json:{ok:true}});
 errors.push('Unexpected API '+url.pathname);return route.fulfill({status:404,json:{error:'Unexpected local call'}});
});
await page.routeWebSocket('**/terminal?ticket=*',socket=>{
 const ticket=new URL(socket.url()).searchParams.get('ticket')!;sockets.set(ticket,socket);
 connections++;
 socket.onMessage(data=>{const value=JSON.parse(String(data));if(value.type==='input')inputs.push({ticket,data:value.data});});
 socket.send(JSON.stringify({type:'connected',data:'Local terminal'}));socket.send(JSON.stringify({type:'data',data:'\x1b[?2004h\r\nMU_LOCAL_SELECTION\r\n'}));
});
const pane=()=>page.locator('.quick-tools-pane:not([hidden])');
const tool=()=>page.locator('.guest-input-floating:not([hidden])');
const input=()=>tool().getByRole('textbox',{name:'中文或其他文字',exact:true});
async function openInput(){await pane().getByRole('button',{name:'中文与快捷输入',exact:true}).click();await expect(input()).toBeVisible();}
const report:Record<string,unknown>={passed:false,scope:'Owned production-component fixture, synthetic terminal/RFB/translation endpoints only; no real AI service or host clipboard reads.'};
try{
 await page.goto(`http://127.0.0.1:${address.port}/quick-tools.html`);await pane().getByText('已连接',{exact:true}).waitFor();await page.waitForTimeout(100);
 for(const mode of ['shell','claude','browser','desktop']){
  await page.getByRole('button',{name:'fixture-'+mode,exact:true}).click();
  await expect(pane().getByRole('button',{name:'文件与粘贴',exact:true})).toBeEnabled();await expect(pane().getByRole('button',{name:'中文与快捷输入',exact:true})).toBeEnabled();
  if(mode==='browser'||mode==='desktop')await expect(pane().getByRole('timer',{name:'沙箱时区时间'})).toHaveAttribute('title',/America\/Los_Angeles/);
  await openInput();await input().fill('中文工具 '+mode);
  if(mode==='shell'||mode==='claude'){
   const count=inputs.length;await tool().getByRole('button',{name:'粘贴原文',exact:true}).click();await expect.poll(()=>inputs.length).toBe(count+1);
   assert.deepEqual(inputs.at(-1),{ticket:'environment-a-'+mode,data:'\x1b[200~中文工具 '+mode+'\x1b[201~'});
  }else{await tool().getByRole('button',{name:'粘贴原文',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).rfbKeys.length)).toBeGreaterThan(0);}
  await expect(input()).toBeHidden();await page.screenshot({path:path.join(results,mode+'.png')});
 }
 // A failed status refresh must report the error without discarding the live viewer.
 await pane().locator('canvas').evaluate(el=>(window as any).desktopCanvas=el);failDesktopInspection=true;
 await pane().getByRole('button',{name:'刷新状态',exact:true}).click();await expect(pane().getByText(/Fixture status temporarily unavailable/)).toBeVisible();assert.equal(await pane().locator('canvas').evaluate(el=>el===(window as any).desktopCanvas),true);
 failDesktopInspection=false;await pane().getByRole('button',{name:'刷新状态',exact:true}).click();await expect(pane().getByText(/Fixture status temporarily unavailable/)).toHaveCount(0);assert.equal(await pane().locator('canvas').evaluate(el=>el===(window as any).desktopCanvas),true);
 await page.getByRole('button',{name:'fixture-shell',exact:true}).click();await openInput();await expect(input()).toHaveValue('中文工具 shell');
 await input().fill('第一行\n第二行');sockets.get('environment-a-shell')!.send(JSON.stringify({type:'data',data:'\x1b[?2004l'}));await page.waitForTimeout(100);
 const blocked=inputs.length;await tool().getByRole('button',{name:'粘贴原文',exact:true}).click();await expect(tool().getByText(/不支持安全的多行粘贴/)).toBeVisible();assert.equal(inputs.length,blocked);await expect(input()).toHaveValue('第一行\n第二行');
 sockets.get('environment-a-shell')!.send(JSON.stringify({type:'data',data:'\x1b[?2004h'}));await page.waitForTimeout(100);await tool().getByRole('button',{name:'粘贴原文',exact:true}).click();await expect.poll(()=>inputs.length).toBe(blocked+1);
 assert.equal(inputs.at(-1)!.data,'\x1b[200~第一行\r第二行\x1b[201~');
 await openInput();await input().fill('本地合成中文');await tool().getByRole('button',{name:'翻译成英文',exact:true}).click();await expect(tool().getByRole('textbox',{name:'译文',exact:true})).toHaveValue('Local English result');
 await tool().getByRole('button',{name:'粘贴译文',exact:true}).click();await expect.poll(()=>inputs.at(-1)?.data).toBe('\x1b[200~Local English result\x1b[201~');
 await pane().getByRole('button',{name:'文件与粘贴',exact:true}).click();const dialog=page.getByRole('dialog',{name:'文件与复制粘贴'});await dialog.getByRole('button',{name:'刷新文件',exact:true}).click();await dialog.getByText("file's 中文.txt",{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'粘贴路径到终端',exact:true}).click();await expect.poll(()=>inputs.at(-1)?.data).toBe("\x1b[200~'/home/dev/Transfers/Incoming/file'\\''s 中文.txt'\x1b[201~");
 await dialog.getByRole('button',{name:'文字复制粘贴',exact:true}).click();await dialog.getByLabel('要发送到沙箱的文字').fill('CLI file-panel text');await dialog.getByRole('button',{name:'粘贴到当前终端',exact:true}).click();await expect.poll(()=>inputs.at(-1)?.data).toBe('\x1b[200~CLI file-panel text\x1b[201~');
 const reads=calls.filter(path=>path.endsWith('/clipboard/read')).length;await dialog.getByRole('button',{name:'取回终端选中文字',exact:true}).click();await expect(dialog.getByText('当前终端尚未选中文字。',{exact:true})).toBeVisible();assert.equal(calls.filter(path=>path.endsWith('/clipboard/read')).length,reads);
 await dialog.getByRole('button',{name:'返回终端',exact:true}).click();
 const beforeDrop=inputs.length;const transfer=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['LOCAL FILE'],'fixture.txt',{type:'text/plain'}));d.setData('text/plain','THIS_MUST_NOT_REACH_PTY');return d;});
 await pane().locator('.terminal-container').dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();await dialog.getByText('fixture.txt',{exact:true}).waitFor();assert.equal(inputs.length,beforeDrop,'Dropping a file must not also paste its host path/text into xterm');await dialog.getByRole('button',{name:'返回终端',exact:true}).click();
 const terminalBounds=await pane().locator('.xterm-screen').boundingBox();assert.ok(terminalBounds);
 await page.mouse.move(terminalBounds.x+2,terminalBounds.y+2);await page.mouse.down();await page.mouse.move(terminalBounds.x+240,terminalBounds.y+40,{steps:8});await page.mouse.up();
 await pane().getByRole('button',{name:'文件与粘贴',exact:true}).click();await dialog.getByRole('button',{name:'文字复制粘贴',exact:true}).click();await dialog.getByRole('button',{name:'取回终端选中文字',exact:true}).click();await expect(dialog.getByRole('textbox',{name:'从沙箱取回的文字',exact:true})).toHaveValue(/MU_LOCAL_SELECTION/);await dialog.getByRole('button',{name:'返回终端',exact:true}).click();
 await openInput();await input().fill('重连保留的中文草稿');const connectedBefore=connections;
 await pane().getByRole('button',{name:'重新连接终端',exact:true}).click();await expect.poll(()=>connections).toBe(connectedBefore+1);await expect(pane().getByRole('button',{name:'中文与快捷输入',exact:true})).toBeEnabled();await openInput();await expect(input()).toHaveValue('重连保留的中文草稿');
 await page.setViewportSize({width:390,height:700});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect.poll(async()=>{const floating=await tool().boundingBox();return !!floating&&floating.x>=0&&floating.y>=0&&floating.x+floating.width<=390&&floating.y+floating.height<=700;}).toBe(true);await page.screenshot({path:path.join(results,'narrow-terminal.png')});
 await page.getByRole('button',{name:'fixture-switch-environment',exact:true}).click();await pane().getByText('已连接',{exact:true}).waitFor();await openInput();await expect(input()).toHaveValue('');
 const previous=inputs.length;await input().fill('新环境');await tool().getByRole('button',{name:'粘贴原文',exact:true}).click();await expect.poll(()=>inputs.length).toBe(previous+1);assert.equal(inputs.at(-1)!.ticket,'environment-b-shell');
 sockets.get('environment-b-shell')!.close();await expect(pane().getByRole('button',{name:'中文与快捷输入',exact:true})).toBeDisabled();await expect(pane().getByRole('button',{name:'文件与粘贴',exact:true})).toBeDisabled();
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);report.passed=true;report.checks=['All four surfaces expose the same tools','CLI Unicode and translated text paste with no appended Enter','Unprotected multiline rejected and draft retained','Bracketed multiline does not escape its envelope','Shell file path quoting preserves apostrophes','File-panel text targets the active terminal','Selection retrieval never reads X11 or host clipboard','CLI shell/agent sessions and drafts stay separate','New environment starts blank and uses only its own WebSocket','Disconnected controls disabled','390px controls do not overflow'];report.inputCount=inputs.length;
}catch(error){report.error=error instanceof Error?error.stack:String(error);report.errors=errors;report.calls=calls;report.external=external;await page.screenshot({path:path.join(results,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();await vite.close();await rm(viteCache,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
