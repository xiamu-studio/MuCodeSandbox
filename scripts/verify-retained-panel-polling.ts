import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';

// Exercise production panels against synthetic endpoints; never access a real VM/profile.
const root=path.resolve(import.meta.dirname,'..');
const source=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import DesktopPanel from '/src/DesktopPanel.tsx';
import {BrowserPanel} from '/src/panels.tsx';
const environment={id:'poll-fixture',name:'Fixture',kind:'vm',state:'running',browserRunning:false,browserUrl:'',identity:{locale:'en-US',timezone:'America/Los_Angeles'},network:{strict:true,transparent:true,mode:'socks5'}};
function Harness(){
 const [visible,setVisible]=React.useState(false),[busy,setBusy]=React.useState(false);
 const snapshot={jobs:busy?[{id:'job',environmentId:environment.id,status:'running',action:'desktop-start'}]:[],system:{browser:{available:true}}};
 return <><button onClick={()=>setVisible(v=>!v)}>visibility</button><button onClick={()=>setBusy(v=>!v)}>job</button>
 <div hidden={!visible}><DesktopPanel environment={environment} snapshot={snapshot} refresh={async()=>{}} onConfigure={()=>{}} visible={visible}/>
 <BrowserPanel environment={environment} snapshot={snapshot} refresh={async()=>{}} visible={visible}/></div></>;
}
createRoot(document.getElementById('root')).render(<Harness/>);`;
const vite=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
 name:'poll-fixture',resolveId(id){if(id==='/poll-fixture.tsx')return id;},load(id){if(id==='/poll-fixture.tsx')return source;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/poll-fixture.html')return next();
  try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/poll-fixture.tsx"></script></body></html>'));}catch(e){next(e);}
 });},
}]});
await vite.listen();
const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
const counts={desktop:0,version:0};const errors:string[]=[];
let hold=false,release:(()=>void)|undefined;
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.clock.install();
 await page.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname;
  if(endpoint.endsWith('/desktop-apps')){
   counts.desktop++;
   if(hold)await new Promise<void>(resolve=>{release=resolve;});
   await route.fulfill({json:{supported:true,apps:[{id:'grok-bot',installed:true,installedVersion:'poll-'+counts.desktop,running:false}],displaySharedWithBrowser:true,accountTested:false}});
  }else if(endpoint.endsWith('/browser/version')){counts.version++;await route.fulfill({json:{installedVersion:'fixture',availableVersion:'fixture'}});}
  else{errors.push(endpoint);await route.fulfill({status:404,json:{error:'Unexpected endpoint'}});}
 });
 await page.goto(`http://127.0.0.1:${address.port}/poll-fixture.html`);
 await expect(page.getByRole('button',{name:'visibility',exact:true})).toBeVisible();
 await page.clock.runFor(15000);assert.deepEqual(counts,{desktop:0,version:0});
 await page.getByRole('button',{name:'visibility',exact:true}).click();
 await expect.poll(()=>counts.desktop).toBe(1);await expect.poll(()=>counts.version).toBe(1);
 await page.getByRole('button',{name:'visibility',exact:true}).click();
 await page.clock.runFor(60000);assert.deepEqual(counts,{desktop:1,version:1});
 // On return, refresh immediately; a slow probe must not accumulate interval requests.
 hold=true;await page.getByRole('button',{name:'visibility',exact:true}).click();
 await expect.poll(()=>counts.desktop).toBe(2);await expect.poll(()=>counts.version).toBe(2);
 await page.clock.runFor(20000);assert.equal(counts.desktop,2);
 await page.getByRole('button',{name:'visibility',exact:true}).click();
 hold=false;release!();await page.clock.runFor(60000);assert.equal(counts.desktop,2);
 // Hidden job transitions must not issue either kind of UI inspection.
 await page.getByRole('button',{name:'job',exact:true}).click();await page.clock.runFor(10000);
 await page.getByRole('button',{name:'job',exact:true}).click();await page.clock.runFor(10000);
 assert.deepEqual(counts,{desktop:2,version:2});
 await page.getByRole('button',{name:'visibility',exact:true}).click();
 await expect.poll(()=>counts.desktop).toBe(3);await expect.poll(()=>counts.version).toBe(3);
 await expect(page.getByText('已安装 poll-3',{exact:true})).toBeVisible();
 await page.clock.runFor(5000);await expect.poll(()=>counts.desktop).toBe(4);
 assert.deepEqual(errors,[]);
 const result={passed:true,counts,checks:['initial hidden tabs do not inspect','hidden tabs stop polling','return refreshes immediately','slow requests do not overlap interval probes','hidden job transitions do not inspect','visible polling resumes'],scope:'Synthetic UI requests only; server protection monitoring is unchanged, no real VM or account.'};
 await mkdir(path.join(root,'test-results/retained-panels'),{recursive:true});
 await writeFile(path.join(root,'test-results/retained-panels/polling.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{release?.();await browser.close();await vite.close();}
