import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {HyperVRuntime,fileHash} from '../server/platform/windows/runtime.ts';
import {createWindowsService} from '../server/platform/windows/service.ts';
import {PROBE_PORT,type WindowsConfig} from '../server/platform/windows/config.ts';
import type {RunOptions} from '../server/process.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {localFixtures,LAB_EXIT} from './windows/local-fixtures.ts';

const page=`<!doctype html><meta charset="utf-8"><title>Windows Linux 本地验收</title><style>body{font:24px sans-serif;background:#eef4f1;padding:40px;color:#164c3a}textarea{display:block;width:80%;height:160px;font:24px sans-serif}button,input{font-size:22px;margin:20px 0}canvas{border:1px solid #888}</style><h1>本地 Linux 浏览器验收</h1><p>LOCAL FIXTURE · NO ACCOUNTS</p><textarea id="text" aria-label="本地文字输入"></textarea><input id="file" type="file"><button id="send" onclick="fetch('/browser-lab/upload',{method:'POST',body:document.querySelector('#file').files[0]}).then(r=>r.text()).then(t=>document.querySelector('#receipt').textContent=t)">上传到本地接收端</button><pre id="receipt"></pre><a download="浏览器下载验收.txt" href="/browser-lab/download">下载本地测试文件</a>`;
async function main(){
 if(process.platform!=='win32')throw Error('Windows is required');
 const root=windowsRuntimeDirectory();
 const base=JSON.parse(await readFile(path.join(root,'protected-desktop-base.json'),'utf8')),directory=path.join(root,'browser-lab-'+randomUUID());await mkdir(directory,{recursive:true});
 const files=['scripts/windows-browser-lab.ts','scripts/windows/local-fixtures.ts','server/platform/windows/browser.ts','server/platform/windows/browser-guest.ts','server/platform/windows/browser-assets.ts','server/platform/windows/desktop-install.ts','server/platform/windows/paths.ts','server/platform/windows/service.ts','server/platform/windows/manager.ts','server/platform/windows/runtime.ts','server/platform/windows/guest.ts','server/guest-browser.ts','server/guest-browser-sandbox.ts','server/vnc-display.ts','src/windows/WindowsBrowserView.tsx','src/windows/WindowsWorkspace.tsx','src/api.ts'];
 const hashes=()=>Promise.all(files.map(async file=>[file,await fileHash(file)]));const sourceHashes=Object.fromEntries(await hashes());
 await writeFile(path.join(directory,'source.json'),JSON.stringify({sourceHashes,pid:process.pid,base},null,2));
 const results:{name:string;passed:boolean}[]=[],uploads:Buffer[]=[],trace:object[]=[];let complete=false,cleanupConfirmed=false,c:WindowsConfig|undefined,service:Awaited<ReturnType<typeof createWindowsService>>|undefined,viewer:WebSocket|undefined;
 const pass=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
 const download=Buffer.from('仅用于本地浏览器下载验收。\n');
 const fixture=await localFixtures(path.join(directory,'fixtures'),process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',LAB_EXIT,(req,res)=>{
  if(req.url==='/browser-lab'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return true;}
  if(req.url==='/browser-lab/download'){res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('浏览器下载验收.txt'));res.end(download);return true;}
  if(req.url==='/browser-lab/upload'&&req.method==='POST'){void(async()=>{let size=0;const blocks:Buffer[]=[];for await(const block of req){size+=block.length;if(size>1024*1024){res.writeHead(413).end();return;}blocks.push(block);}const bytes=Buffer.concat(blocks);uploads.push(bytes);res.end(createHash('sha256').update(bytes).digest('hex'));})();return true;}return false;
 },event=>{trace.push({time:Date.now(),...event});if(trace.length>512)trace.shift();});
 class BrowserLabRuntime extends HyperVRuntime{
  override async start(config:WindowsConfig,options:RunOptions={}){
   await super.start(config,options);
   await this.management(config,['sudo','tee','/etc/mucodesandbox/browser-lab-ca.crt'],{input:fixture.certificate});
   await this.management(config,['sudo','-H','-u','dev','--','python3','-c',"import pathlib,sys,os; p=pathlib.Path('/home/dev/.pki');p.mkdir(mode=0o700,exist_ok=True);(p/'nssdb').mkdir(mode=0o700,exist_ok=True);f=p/'mu-local-fixture-ca.crt';f.write_bytes(sys.stdin.buffer.read());os.chmod(f,0o600)"],{input:fixture.certificate});
   await this.management(config,['sudo','-H','-u','dev','--','bash','-c',"if ! test -f /home/dev/.pki/nssdb/cert9.db; then certutil -N -d sql:/home/dev/.pki/nssdb --empty-password; fi; certutil -A -d sql:/home/dev/.pki/nssdb -n MuLocalBrowserFixture -t 'C,,' -a -i /home/dev/.pki/mu-local-fixture-ca.crt"],{timeoutMs:15000});
   for(const file of ['/usr/local/share/ca-certificates/mu-local-fixture.crt'])await this.management(config,['sudo','tee',file],{input:fixture.certificate});
   await this.management(config,['sudo','update-ca-certificates'],{timeoutMs:30000});
  }
 }
 const runtime=new BrowserLabRuntime(root);
 const curl=(config:WindowsConfig,receiver:string)=>runtime.management(config,['sudo','-n','-H','-u','mu-probe','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--cacert','/etc/mucodesandbox/browser-lab-ca.crt','--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,`https://${receiver}/`],{timeoutMs:10000});
 try{
  service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:path.join(directory,'app'),runtimeRoot:root,base,runtime,probe:config=>async()=>{
   try{return await Promise.all(fixture.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await curl(config,receiver)).ip})));}
   catch(error){await runtime.disconnect(config.id);let journal='unavailable';try{journal=await runtime.management(config,['sudo','journalctl','-b','-u','mucodesandbox-tunnel.service','-n','80','--no-pager'],{timeoutMs:8000,maxBytes:16000});}catch{}await writeFile(path.join(directory,'network-failure.json'),JSON.stringify({message:error instanceof Error?error.message:String(error),journal,trace,counters:fixture.counters()},null,2));throw error;}
  }});
  const launch=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];const html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]).token;
  const headers={Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const api=async(endpoint:string,body?:unknown)=>{const response=await fetch(service!.url+'/api'+endpoint,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json() as any;assert.ok(response.ok,JSON.stringify(value));return value;};
  const e=await api('/environments',{name:'真实 Linux 浏览器本地验收',cpus:2,memoryGiB:4,diskGiB:32,identity:{timezone:'Asia/Taipei',locale:'zh-CN'},network:{mode:'http',host:'127.0.0.1',port:fixture.port,strict:true,transparent:true,egressLock:{expectedIp:LAB_EXIT},dns:fixture.dns}});
  c=await service.manager.profile(service.manager.store.get(e.id));
  const wait=async(job:{id:string})=>{await service!.manager.wait(job.id);const result=service!.manager.store.jobs().find(value=>value.id===job.id)!;assert.equal(result.status,'succeeded',result.message);};
  await wait(await api(`/environments/${e.id}/actions/start`,{}));c=await service.manager.profile(service.manager.store.get(e.id));pass('A fresh desktop guest starts behind two matching local exit receipts');
  await assert.rejects(runtime.management(c,['ip','link','show','mu-bootstrap']));pass('The package bootstrap dummy interface is absent from the working guest');
  await wait(await api(`/environments/${e.id}/browser/open`,{}));assert.equal(service.browser!.running(e.id),true);const entry=service.browser!.entries.get(e.id)!,tools=entry.tools!,session=()=>[...entry.pages.values()].find(value=>tools.activeSessions.has(value))!;
  const evaluate=async(expression:string)=>{const value=await tools.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session());assert.ok(!value.exceptionDetails,JSON.stringify(value.exceptionDetails));return value.result.value;};
  assert.equal(await evaluate('location.href'),'about:blank');await service.browser!.assertProtection(e.id);pass('Chrome renderer and GPU sandbox pass before any page navigation');
  const identity=await api(`/environments/${e.id}/browser/inspect`);assert.equal(identity.matchesConfiguration,true);assert.match(identity.platform,/Linux/);assert.match(identity.userAgent,/Linux/);assert.equal(identity.language,'zh-CN');assert.equal(new Intl.Locale(identity.locale).language,'zh');assert.equal(new Intl.Locale(identity.locale).region,'CN');pass('Native Linux platform, Chinese locale and configured time zone match');
  await wait(await api(`/environments/${e.id}/browser/navigate`,{url:'https://receiver.mu.test/browser-lab'}));
  const deadline=Date.now()+30000;for(;;){if(await evaluate('document.title')==='Windows Linux 本地验收')break;assert.ok(Date.now()<deadline,'Local HTTPS page did not load');await delay(100);}
  pass('The browser loads only the local HTTPS fixture with an explicitly trusted test CA');
  const rendering=await evaluate(`(async()=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='#27a36f';ctx.fillRect(0,0,1,1);const worker=new Worker(URL.createObjectURL(new Blob(['postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,platform:navigator.platform})'],{type:'text/javascript'})));const identity=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Worker timeout')),3000);worker.onmessage=e=>{clearTimeout(timeout);worker.terminate();resolve(e.data);};});return {pixels:[...ctx.getImageData(0,0,1,1).data],worker:identity};})()`);
  assert.deepEqual(rendering.pixels,[39,163,111,255]);assert.equal(rendering.worker.language,identity.language);assert.equal(rendering.worker.timezone,identity.timezone);assert.equal(rendering.worker.platform,identity.platform);pass('Canvas pixels and Worker identity agree with the real guest browser');
  const display=await api(`/environments/${e.id}/guest-browser/display`,{cssWidth:1600,cssHeight:1000,scaleFactor:2,mode:'fixed'});assert.equal(display.matched,true);pass('Authenticated VNC resizing confirms real screen size and pixel density');
  const connectViewer=async()=>{const ticket=await api(`/environments/${e.id}/guest-browser-ticket`,{});const socket=new WebSocket(service!.url.replace('http:','ws:')+'/guest-browser?ticket='+ticket.ticket,{headers:{Origin:service!.url,Cookie:cookie}});socket.on('error',()=>{});const banner=await new Promise<Buffer>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('VNC banner timeout')),10000);socket.once('message',bytes=>{clearTimeout(timer);resolve(Buffer.from(bytes as Buffer));});socket.once('error',reject);});assert.equal(banner.toString(),'RFB 003.008\n');return socket;};
  viewer=await connectViewer();viewer.terminate();pass('The viewer reaches VNC through a session-bound authenticated WebSocket');
  const payload=Buffer.from('浏览器上传验收\0binary\n'),name='浏览器上传验收.bin';const upload=await fetch(service.url+`/api/environments/${e.id}/transfer-files?name=${encodeURIComponent(name)}`,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:payload});assert.equal(upload.status,200);
  const doc=await tools.send('DOM.getDocument',{},session()),input=await tools.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'},session());await tools.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:['/home/dev/Downloads/'+name]},session());await evaluate("document.querySelector('#send').click()");
  const uploaded=Date.now()+10000;while(!uploads.length){assert.ok(Date.now()<uploaded,'Browser upload not received');await delay(100);}assert.deepEqual(uploads[0],payload);pass('A real browser file upload reaches only the local receiver with unchanged bytes');
  await evaluate("document.querySelector('a[download]').click()");let returned='';const downloaded=Date.now()+20000;
  for(;;){try{returned=(await runtime.guest(c,['python3','-c',"import pathlib,base64,os; p=pathlib.Path('/home/dev/Downloads/浏览器下载验收.txt'); assert not p.is_symlink() and p.stat().st_uid==os.getuid(); print(base64.b64encode(p.read_bytes()).decode())"],{timeoutMs:5000})).trim();break;}catch{assert.ok(Date.now()<downloaded,'Browser download was not saved');await delay(200);}}
  assert.deepEqual(Buffer.from(returned,'base64'),download);pass('A real browser download is saved as a private guest file with unchanged bytes');
  const screenshot=await tools.send('Page.captureScreenshot',{format:'png'},session());await writeFile(path.join(directory,'browser.png'),Buffer.from(screenshot.data,'base64'));
  if(process.argv.includes('--interactive')){
   await evaluate("document.querySelector('#text').focus()");const marker=path.join(directory,'ui-finished.json');
   const viewerDirectory=path.resolve('.mu-data/windows-run');await secureWindowsDirectory(viewerDirectory);
   await writeFile(path.join(viewerDirectory,'browser-lab-view.json'),JSON.stringify({url:service.launchUrl(),id:e.id,directory,marker,pid:process.pid}));console.log('Waiting for the local viewer acceptance marker');
   const until=Date.now()+300000;for(;;){assert.equal(service.manager.store.get(e.id).state,'running','Protection failed while waiting for the viewer');try{await access(marker);break;}catch{assert.ok(Date.now()<until,'Viewer acceptance did not finish');await delay(500);}}
   assert.equal(await evaluate("document.querySelector('#text').value"),'本地浏览器中文粘贴 😀');pass('Host viewer text reaches the real guest through manual clipboard and VNC keys');
  }
  viewer=await connectViewer();assert.equal(viewer.readyState,WebSocket.OPEN);const closed=new Promise<void>(resolve=>viewer!.once('close',()=>resolve()));fixture.interrupt();await service.manager.monitor();await closed;assert.equal((await runtime.state(c)).state,'Off');assert.equal(service.browser!.entries.size,0);pass('Upstream failure revokes browser streams and confirms Hyper-V shutdown');complete=true;
 }finally{
  viewer?.terminate();try{await service?.close();if(c)assert.equal((await runtime.state(c)).state,'Off');cleanupConfirmed=true;}finally{await fixture.close();const sourceChangedDuringTest=JSON.stringify(sourceHashes)!==JSON.stringify(Object.fromEntries(await hashes()));await writeFile(path.join(directory,'results.json'),JSON.stringify({scope:'real-windows-browser',sourceHashes,sourceChangedDuringTest,cleanupConfirmed,results,aiWebsitesVisited:0,realAccountTests:0,complete:complete&&cleanupConfirmed&&!sourceChangedDuringTest},null,2));if(sourceChangedDuringTest)throw Error('Browser acceptance source changed during test');}
 }
 console.log(JSON.stringify({passed:results.length,complete:complete&&cleanupConfirmed}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Windows browser lab failed');process.exitCode=1;});
