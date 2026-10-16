import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';
const root=path.resolve(import.meta.dirname,'..');
const source=`import React from 'react';import{createRoot}from'react-dom/client';
import GuestExchangePanel from '/src/GuestExchangePanel.tsx';import GuestTextInput from '/src/GuestTextInput.tsx';import '/src/styles.css';import '/src/liquid.css';
window.__MU_CONFIG__={token:'fixture',version:'fixture'};window.pasted=[];
function Harness(){const target=React.useRef(null);const[connected,setConnected]=React.useState(true);const[open,setOpen]=React.useState(true);const[mounted,setMounted]=React.useState(true);const[active,setActive]=React.useState(true);
return <><button onClick={()=>setActive(v=>!v)}>active files</button><button onClick={()=>setMounted(v=>!v)}>mount files</button><button onClick={()=>setConnected(v=>!v)}>connection</button><div ref={target} className="guest-browser-view" style={{height:700,margin:20}}>
<header className="guest-browser-toolbar"><button onClick={()=>setOpen(v=>!v)}>输入工具</button><strong>美国 VPS · 文件与输入</strong>{mounted&&<GuestExchangePanel id="fixture" connected={connected} active={active} dropTarget={target}/>}</header>
<div className="guest-input-container" hidden={!open}><GuestTextInput id="fixture" onClose={()=>setOpen(false)} connected={connected} onPaste={async text=>{window.pasted.push(text);}} onKey={()=>{}}/></div>
<div id="remote-screen" style={{height:300,background:'#e7f0ed',display:'grid',placeItems:'center'}}>沙箱画面 · 可拖入文件</div></div></>}
createRoot(document.getElementById('root')).render(<Harness/>);`;
const vite=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
 name:'convenience-fixture',resolveId(id){if(id==='/convenience.tsx')return id;},load(id){if(id==='/convenience.tsx')return source;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/convenience.html')return next();try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/convenience.tsx"></script></body></html>'));}catch(e){next(e);}});},
}]});
await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1200,height:950}});
const uploads:string[]=[],clipboard:string[]=[],translations:string[]=[],errors:string[]=[];let failName='';let listedFiles:Record<string,unknown>[]=[];
let translationFailure='';
let listGate:Promise<void>|null=null,releaseList=()=>{},failList=false,listReads=0;
let clipboardGate:Promise<void>|null=null,releaseClipboard=()=>{};
let uploadGate:Promise<void>|null=null,releaseUpload=()=>{};
await page.addInitScript(()=>{
 const state={text:'',reads:0,writes:0};(window as any).localClipboard=state;
 Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>{state.reads++;return state.text;},writeText:async(text:string)=>{state.writes++;state.text=text;}}});
});
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
 const url=new URL(route.request().url()),method=route.request().method();
 if(url.pathname.endsWith('/transfer-files')&&method==='POST'){
  const name=url.searchParams.get('name')!;uploads.push(name);if(uploadGate)await uploadGate;
  if(name===failName)return route.fulfill({status:409,json:{error:'fixture connection lost'}});
  return route.fulfill({json:{name:'1-'+name,path:'/home/dev/Transfers/Incoming/1-'+name,bytes:route.request().postDataBuffer()?.length??0}});
 }
 if(url.pathname.endsWith('/transfer-files')){
  listReads++;
  if(listGate)await listGate;
  if(failList)return route.fulfill({status:503,json:{error:'fixture list unavailable'}});
  const offset=Number(url.searchParams.get('cursor')??0);
  return route.fulfill({json:url.searchParams.get('paged')==='1'?{files:listedFiles.slice(offset,offset+50),total:listedFiles.length,nextCursor:offset+50<listedFiles.length?String(offset+50):null}:listedFiles});
 }
 if(url.pathname.endsWith('/clipboard/write')){clipboard.push(route.request().postDataJSON().text);if(clipboardGate)await clipboardGate;return route.fulfill({json:{ok:true}});}
 if(url.pathname.endsWith('/clipboard/read'))return route.fulfill({json:{text:'Please review this document.'}});
 if(url.pathname.endsWith('/translate-text')){translations.push(route.request().postDataJSON().text);if(translationFailure)return route.fulfill({status:502,json:{error:translationFailure,code:'TRANSLATION_REFUSED'}});return route.fulfill({json:{text:'Please review this document.'}});}
 errors.push(url.pathname);return route.fulfill({status:404,json:{error:'unexpected request'}});
});
async function drop(names:string[],size=4){
 const transfer=await page.evaluateHandle(({names,size})=>{const d=new DataTransfer();for(const name of names)d.items.add(new File([new Uint8Array(size)],name,{type:'text/plain'}));return d;},{names,size});
 await page.locator('#remote-screen').dispatchEvent('dragenter',{dataTransfer:transfer});
 await expect(page.getByText('松开即可传入当前沙箱')).toBeVisible();
 await page.locator('#remote-screen').dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();
}
try{
 await page.goto(`http://127.0.0.1:${address.port}/convenience.html`);
 const input=page.getByRole('textbox',{name:'中文或其他文字'});
 const screenBefore=await page.locator('#remote-screen').boundingBox();
 const panel=await page.locator('.guest-input-container').boundingBox();assert.ok(panel&&panel.width<=380&&panel.height<260);
 assert.equal(await page.evaluate(()=>(window as any).localClipboard.reads),0);
 await input.fill('左右');await input.evaluate(el=>(el as HTMLTextAreaElement).setSelectionRange(1,1));
 await page.evaluate(()=>(window as any).localClipboard.text='中文');
 await page.getByRole('button',{name:'粘贴',exact:true}).click();await expect(input).toHaveValue('左中文右');
 await input.evaluate(el=>new Promise<void>(resolve=>requestAnimationFrame(()=>{(el as HTMLTextAreaElement).setSelectionRange(1,3);resolve();})));
 await page.getByRole('button',{name:'复制',exact:true}).click();
 assert.equal(await page.evaluate(()=>(window as any).localClipboard.text),'中文');
 assert.equal(await page.evaluate(()=>(window as any).pasted.length),0);
 await input.fill('请帮我检查这份文件。\n第二行');assert.equal(translations.length,0);
 await input.dispatchEvent('compositionstart');await input.press('Control+Enter');
 assert.deepEqual(await page.evaluate(()=>(window as any).pasted),[]);
 await input.dispatchEvent('compositionend');await input.press('Control+Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).pasted.length)).toBe(1);
 assert.deepEqual(await page.evaluate(()=>(window as any).pasted),['请帮我检查这份文件。\n第二行']);
 await expect(input).toBeHidden();assert.deepEqual(await page.locator('#remote-screen').boundingBox(),screenBefore);
 await page.getByRole('button',{name:'输入工具',exact:true}).click();await expect(input).toHaveValue('请帮我检查这份文件。\n第二行');
 await page.screenshot({path:path.join(root,'test-results/guest-convenience/compact-input.png')});
 await page.getByRole('button',{name:'翻译成英文',exact:true}).click();await expect.poll(()=>translations.length).toBe(1);
 assert.equal(translations[0],'请帮我检查这份文件。\n第二行');
 await expect(page.getByRole('textbox',{name:'英文译文',exact:true})).toHaveValue('Please review this document.');
 await expect(input).toHaveValue('请帮我检查这份文件。\n第二行');
 assert.equal(await page.evaluate(()=>(window as any).pasted.length),1);
 await page.getByRole('textbox',{name:'英文译文',exact:true}).fill('');
 await expect(page.getByRole('textbox',{name:'英文译文',exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).localClipboard.text='Edited English.');
 await page.getByRole('button',{name:'粘贴',exact:true}).nth(1).click();
 await expect(page.getByRole('textbox',{name:'英文译文',exact:true})).toHaveValue('Edited English.');
 await page.getByRole('button',{name:'复制',exact:true}).nth(1).click();
 assert.equal(await page.evaluate(()=>(window as any).localClipboard.text),'Edited English.');
 const translation=page.getByRole('textbox',{name:'英文译文',exact:true});
 await translation.dispatchEvent('compositionstart');await translation.press('Control+Enter');
 assert.equal(await page.evaluate(()=>(window as any).pasted.length),1);
 await translation.press('Escape');await expect(translation).toBeVisible();
 await translation.dispatchEvent('compositionend');await translation.press('Control+Enter');await expect(input).toBeHidden();
 assert.deepEqual(await page.evaluate(()=>(window as any).pasted),['请帮我检查这份文件。\n第二行','Edited English.']);
 await page.getByRole('button',{name:'输入工具',exact:true}).click();
 await page.screenshot({path:path.join(root,'test-results/guest-convenience/inline-translation.png')});
 await input.fill('改过的原文');await expect(page.getByRole('textbox',{name:'英文译文',exact:true})).toHaveCount(0);
 translationFailure='Google 翻译拒绝了这次请求（403）。原文已保留。';
 await page.getByRole('button',{name:'翻译成英文',exact:true}).click();
 await expect(page.getByText(translationFailure,{exact:true})).toBeVisible();
 await expect(input).toHaveValue('改过的原文');
 await expect(page.getByRole('button',{name:'翻译成英文',exact:true})).toBeEnabled();
 assert.equal(translations.length,2);assert.equal(await page.evaluate(()=>(window as any).pasted.length),2);
 translationFailure='';
 await page.getByRole('button',{name:'翻译成英文',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'英文译文',exact:true})).toHaveValue('Please review this document.');
 assert.equal(translations.length,3);await expect(page.getByText('Google 翻译拒绝了这次请求（403）。原文已保留。',{exact:true})).toHaveCount(0);
 await input.fill('继续编辑原文');

 listGate=new Promise(resolve=>{releaseList=resolve;});failList=true;
 await page.getByRole('button',{name:'文件与粘贴',exact:true}).click();
 await expect(page.getByText('正在读取文件列表…',{exact:true})).toBeVisible();
 await expect(page.getByText('这些文件夹里还没有可传输的文件。',{exact:true})).toHaveCount(0);
 releaseList();listGate=null;
 await expect(page.getByText('未能读取文件列表，请刷新重试。',{exact:true})).toBeVisible();
 await expect(page.getByText('这些文件夹里还没有可传输的文件。',{exact:true})).toHaveCount(0);
 failList=false;await page.getByRole('button',{name:'刷新文件',exact:true}).click();
 await expect(page.getByText('这些文件夹里还没有可传输的文件。',{exact:true})).toBeVisible();
 listedFiles=Array.from({length:51},(_,i)=>({zone:'incoming',name:`page-${i}.txt`,path:`/home/dev/Transfers/Incoming/page-${i}.txt`,bytes:19,modifiedAt:'2026-10-14T00:00:00Z'}));
 await page.getByRole('button',{name:'刷新文件',exact:true}).click();
 await expect(page.locator('.guest-transfer-list>div')).toHaveCount(50);
 await expect(page.getByText('已显示 50 / 51 个可传输文件 · 最近修改在前',{exact:true})).toBeVisible();
 failList=true;await page.getByRole('button',{name:'加载更多文件',exact:true}).click();
 await expect(page.getByText('列表未更新，仍显示上次读取的文件。请刷新重试。',{exact:true})).toBeVisible();
 await expect(page.locator('.guest-transfer-list>div')).toHaveCount(50);
 failList=false;await page.getByRole('button',{name:'加载更多文件',exact:true}).click();
 await expect(page.locator('.guest-transfer-list>div')).toHaveCount(51);
 await expect(page.getByRole('button',{name:'加载更多文件',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'文字复制粘贴',exact:true}).click();
 const outgoing=page.getByRole('textbox',{name:'要发送到沙箱的文字'});
 await outgoing.fill('第一段已提交');
 clipboardGate=new Promise(resolve=>{releaseClipboard=resolve;});
 await page.getByRole('button',{name:'发送到沙箱剪贴板',exact:true}).click();
 await expect.poll(()=>clipboard.length).toBe(1);
 await outgoing.fill('下一段正在写');releaseClipboard();clipboardGate=null;
 await expect(page.getByRole('button',{name:'发送到沙箱剪贴板',exact:true})).toBeEnabled();
 await expect(outgoing).toHaveValue('下一段正在写');assert.equal(clipboard[0],'第一段已提交');
 await page.getByRole('button',{name:'发送到沙箱剪贴板',exact:true}).click();
 await expect(outgoing).toHaveValue('');assert.equal(clipboard[1],'下一段正在写');
 clipboard.length=0;
 await page.getByRole('button',{name:'文件传输',exact:true}).click();
 await expect(page.getByRole('button',{name:'刷新文件',exact:true})).toBeEnabled();
 listedFiles=[];await page.getByRole('button',{name:'返回沙箱',exact:true}).click();

 const readsBeforeUpload=listReads;failList=true;
 await drop(['报告.txt']);await expect(page.getByRole('heading',{name:'本次已传入 1 个文件'})).toBeVisible();
 await expect(page.getByRole('button',{name:'返回沙箱',exact:true})).toBeEnabled();
 assert.equal(listReads,readsBeforeUpload,'confirmed upload must not wait for another file listing');
 await expect(page.getByText('fixture list unavailable',{exact:true})).toHaveCount(0);
 await expect(page.locator('.guest-transfer-list>div')).toHaveCount(0);
 failList=false;
 await page.getByRole('button',{name:'复制路径到沙箱',exact:true}).click();await expect.poll(()=>clipboard.length).toBe(1);
 assert.equal(clipboard[0],'/home/dev/Transfers/Incoming/1-报告.txt');
 await expect(page.getByRole('button',{name:'返回沙箱',exact:true})).toBeEnabled();
 await mkdir(path.join(root,'test-results/guest-convenience'),{recursive:true});
 await page.screenshot({path:path.join(root,'test-results/guest-convenience/files-wide.png')});
 await page.setViewportSize({width:520,height:850});await page.screenshot({path:path.join(root,'test-results/guest-convenience/files-narrow.png')});
 assert.ok(await page.getByRole('dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
 listedFiles=Array.from({length:12},(_,i)=>({zone:'incoming',name:`文件-${i+1}-较长的文件名.txt`,path:`/home/dev/Transfers/Incoming/文件-${i+1}-较长的文件名.txt`,bytes:1024,modifiedAt:'2026-10-13T00:00:00Z'}));
 await page.getByRole('button',{name:'刷新文件',exact:true}).click();
 await expect(page.locator('.guest-transfer-list>div')).toHaveCount(12);
 for(const viewport of [{width:1200,height:650},{width:520,height:580}]){
  await page.setViewportSize(viewport);
  const list=page.locator('.guest-transfer-list');
  assert.ok(await list.evaluate(el=>el.clientHeight>=el.scrollHeight-1),'file list must not collapse into nested scrolling');
  for(const row of await list.locator(':scope>div').all()){
   await row.scrollIntoViewIfNeeded();
   assert.ok(await row.evaluate(el=>{const r=el.getBoundingClientRect(),b=el.closest('.modal-body')!.getBoundingClientRect();return r.top>=b.top-1&&r.bottom<=b.bottom+1&&r.right<=b.right+1;}),'each complete file row fits the body viewport');
   for(const button of await row.getByRole('button').all())await expect(button).toBeInViewport({ratio:1});
  }
  await expect(page.getByRole('button',{name:'返回沙箱',exact:true})).toBeInViewport({ratio:1});
  await page.screenshot({path:path.join(root,`test-results/guest-convenience/files-populated-${viewport.width}.png`)});
 }
 listedFiles=[];
 await page.getByRole('button',{name:'返回沙箱',exact:true}).click();
 await page.screenshot({path:path.join(root,'test-results/guest-convenience/input-narrow.png')});
 await page.setViewportSize({width:1200,height:950});
 failName='second.txt';await drop(['first.txt','second.txt','third.txt']);
 await expect(page.getByText(/已传入 1 个文件；second.txt 未确认传入/)).toBeVisible();
 assert.deepEqual(uploads,['报告.txt','first.txt','second.txt']);await expect(page.getByText('/home/dev/Transfers/Incoming/1-first.txt',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'返回沙箱',exact:true}).click();
 await drop(['too-big.txt'],26*1024*1024);await expect(page.getByText(/本批尚未上传/)).toBeVisible();assert.equal(uploads.length,3);
 await page.getByRole('button',{name:'返回沙箱',exact:true}).click();
 await page.getByRole('button',{name:'connection',exact:true}).click();
 await expect(page.getByRole('button',{name:'粘贴原文',exact:true})).toBeDisabled();
 const d=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['x'],'offline.txt'));return d;});
 await page.locator('#remote-screen').dispatchEvent('drop',{dataTransfer:d});await d.dispose();
 await expect(page.getByText('沙箱画面尚未连接，请连接后重新拖入文件。')).toBeVisible();assert.equal(uploads.length,3);
 await page.getByRole('button',{name:'返回沙箱',exact:true}).click();
 await page.getByRole('button',{name:'connection',exact:true}).click();
 uploadGate=new Promise(resolve=>{releaseUpload=resolve;});
 await drop(['leaving-first.txt','leaving-second.txt']);
 await expect.poll(()=>uploads.length).toBe(4);
 await page.getByRole('button',{name:'mount files',exact:true}).evaluate(el=>(el as HTMLButtonElement).click());
 await expect(page.getByRole('dialog')).toHaveCount(0);
 releaseUpload();uploadGate=null;
 // Let the delayed first response finish and the next loop iteration run.
 await page.waitForTimeout(400);
 assert.deepEqual(uploads,['报告.txt','first.txt','second.txt','leaving-first.txt'],'unmount must stop the remaining upload queue');
 await page.getByRole('button',{name:'mount files',exact:true}).click();
 await page.getByRole('button',{name:'文件与粘贴',exact:true}).click();
 await expect(page.getByRole('heading',{name:/本次已传入/})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'选择文件上传',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'返回沙箱',exact:true}).click();
 for(const transition of ['active files','connection']){
  const before:number=uploads.length;
  uploadGate=new Promise(resolve=>{releaseUpload=resolve;});
  await drop([`${transition}-first.txt`,`${transition}-second.txt`]);
  await expect.poll(()=>uploads.length).toBe(before+1);
  const toggle=page.getByRole('button',{name:transition,exact:true});
  await toggle.evaluate(el=>(el as HTMLButtonElement).click());
  if(transition==='active files')await expect(page.getByRole('dialog')).toHaveCount(0);
  else await expect(page.getByRole('button',{name:'选择文件上传',exact:true})).toBeDisabled();
  await toggle.evaluate(el=>(el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toBeVisible();
  releaseUpload();uploadGate=null;
  await expect(page.getByRole('button',{name:'选择文件上传',exact:true})).toBeEnabled();
  assert.equal(uploads.length,before+1,`${transition}: returning before the first response must not resume the queue`);
  await expect(page.getByText(/已传入 1 个文件；.*剩余文件未上传/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'本次已传入 1 个文件'})).toBeVisible();
  await page.getByRole('button',{name:'返回沙箱',exact:true}).click();
 }
 assert.deepEqual(errors,[]);
 const report={passed:true,checks:['confirmed upload enables handoff without another list request; stale pagination invalidated; explicit refresh remains available','quickly hiding and returning never resumes a cancelled batch','quick disconnect and reconnect never resumes a cancelled batch','unmount during upload stops remaining queue and new panel has no stale result','clipboard response preserves a newer draft; unchanged draft clears after successful send','translation IME does not paste or close; shortcut pastes the edited translation','loading and failed listing never report an empty folder','50-file page and continuation show all 51 files','failed continuation retains previous files and retry succeeds','explicit local clipboard only, cursor paste and selected copy','empty translation stays editable','compact panel <=380px wide and <260px tall','paste collapses without changing screen geometry','draft retained on reopen','IME composition does not submit','Unicode multiline paste explicit only','translation explicit only','inline editable translation, explicit paste, stale result cleared','drop remote surface uploads once','server renamed filename path used','partial failure preserves successes and stops batch','oversize selection rejected before upload','disconnected drop does not upload','520px modal fits viewport','12 complete file rows scroll in one body at 1200x650 and 520x580; actions and footer fully visible'],scope:'Production UI with synthetic endpoints; no real files/accounts/translation calls.'};
 await writeFile(path.join(root,'test-results/guest-convenience/ui.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser.close();await vite.close();}
