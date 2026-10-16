import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';
import {LimaRuntime} from '../server/runtime.ts';
const label=process.argv[2];assert.ok(['before','after'].includes(label));
const root=path.resolve(import.meta.dirname,'..'),info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:'Bearer '+config.token},id='76c193f7-09a2-4544-83b8-4852445ab2be';
async function read(endpoint:string){const r=await fetch(info.url+'/api'+endpoint,{headers});assert.ok(r.ok);return r.json();}
const environment=(await read('/snapshot')).environments.find((e:any)=>e.id===id);assert.equal(environment.state,'running');
async function guard(){const g=await read('/environments/'+id+'/network/protection');assert.ok(g.active&&g.integrity==='verified'&&g.leaseActive);return{integrity:g.integrity,leaseActive:g.leaseActive,firewallHash:g.firewallHash,tunnelConfigHash:g.tunnelConfigHash};}
const before=await guard();
const source=`import React from 'react';import{createRoot}from'react-dom/client';import GuestExchangePanel from '/src/GuestExchangePanel.tsx';import '/src/styles.css';import '/src/liquid.css';window.__MU_CONFIG__={token:'local-fixture'};function Harness(){const target=React.useRef(null);return <div ref={target} style={{height:700}}><GuestExchangePanel id="${id}" connected dropTarget={target}/><div id="drop">Local file handoff benchmark</div></div>};createRoot(document.getElementById('root')).render(<Harness/>);`;
const vite=await createServer({root,cacheDir:path.join('/tmp','mu-handoff-vite-'+label),logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'handoff-measure',resolveId(id){if(id==='/handoff.tsx')return id;},load(id){if(id==='/handoff.tsx')return source;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/handoff.html')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<html><div id="root"></div><script type="module" src="/handoff.tsx"></script></html>'));});}}]});
await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1200,height:950}});
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox'),saved:string[]=[],rows:any[]=[],errors:string[]=[];let calls:any[]=[];
const sourceHash=createHash('sha256').update(await readFile(path.join(root,'src/GuestExchangePanel.tsx'))).digest('hex');
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
 const u=new URL(route.request().url());assert.equal(u.pathname,'/api/environments/'+id+'/transfer-files');
 const method=route.request().method();assert.ok(['GET','POST'].includes(method));
 if(method==='POST')assert.match(u.searchParams.get('name')??'',/^mu-handoff-[a-f0-9-]+\.bin$/);
 const start=performance.now();const response=await fetch(info.url+u.pathname+u.search,{method,headers:{...headers,'Content-Type':method==='POST'?'application/octet-stream':'application/json'},body:method==='POST'?new Uint8Array(route.request().postDataBuffer()!):undefined});
 const data=await response.json();calls.push({method,ms:Math.round(performance.now()-start),status:response.status});
 if(method==='POST'&&response.ok)saved.push(data.path);
 await route.fulfill({status:response.status,json:data});
});
try{
 for(let trial=0;trial<3;trial++){
  calls=[];await page.goto(`http://127.0.0.1:${address.port}/handoff.html`);await page.getByRole('button',{name:'文件与粘贴',exact:true}).waitFor();
  const name='mu-handoff-'+randomUUID()+'.bin';
  await page.evaluate(name=>{
   const state={start:performance.now(),ready:0};(window as any).timing=state;
   const observer=new MutationObserver(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='返回沙箱');if(document.querySelector('.guest-upload-results')&&button&&!button.disabled){state.ready=performance.now();observer.disconnect();}});
   observer.observe(document.body,{subtree:true,childList:true,attributes:true});
   const d=new DataTransfer();d.items.add(new File([new Uint8Array(1024*1024).fill(167)],name));document.querySelector('#drop')!.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));
  },name);
  await page.waitForFunction(()=>(window as any).timing.ready>0,{},{timeout:60000});
  await expect(page.getByRole('region',{name:'本次传入的文件'}).getByRole('button',{name:'复制路径到沙箱',exact:true})).toBeEnabled();
  const timing=await page.evaluate(()=>(window as any).timing);
  rows.push({trial:trial+1,bytes:1024*1024,readyMs:Math.round(timing.ready-timing.start),requests:[...calls]});
  await page.screenshot({path:path.join('/tmp',`mu-handoff-${label}-${trial}.png`)});
 }
 assert.deepEqual(errors,[]);const after=await guard();assert.deepEqual(after,before);
 const report={label,at:new Date().toISOString(),installedVersion:config.version,sourceHash,rows,guardUnchanged:true,scope:'Production file panel in a local test renderer, using installed guarded API and real VM. Three synthetic 1 MiB uploads. Ready measures drop to enabled path/return buttons; not Finder drag, website upload, remote rendering or network RTT.'};
 await mkdir(path.join(root,'test-results/file-handoff-performance'),{recursive:true});await writeFile(path.join(root,`test-results/file-handoff-performance/${label}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
 await browser.close();await vite.close();
 for(const file of saved){assert.match(file,/^\/home\/dev\/Transfers\/Incoming\/mu-handoff-[a-f0-9-]+\.bin$/);await runtime.guest(environment,['rm','--',file],{timeoutMs:10000});}
}
