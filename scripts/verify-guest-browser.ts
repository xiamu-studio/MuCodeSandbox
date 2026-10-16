import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { createService } from '../server/service.ts';
import type { Job } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..');
const temporary=process.env.MU_BROWSER_TEST_DATA??await mkdtemp(path.join(homedir(),'.mu-browser-verification-'));
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const receipts:any[]=[];const sockets=new Set<Socket>();const destinations:string[]=[];
const target=createServer((req,res)=>{
  if(req.url==='/receipt'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{receipts.push(JSON.parse(body));res.end('ok');});return;}
  if(req.url==='/clicked'){receipts.push({clicked:true});res.end('ok');return;}
  if(req.url==='/login'){res.setHeader('Set-Cookie','synthetic=account-a; HttpOnly; SameSite=Lax');res.end('ok');return;}
  if(req.url==='/cookies'){res.end(req.headers.cookie??'');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><title>Mu VM Browser Verification</title><style>body{margin:0;font:18px Arial;background:#f4f6f8;color:#182128}header{padding:32px;background:#146c54;color:white}main{padding:40px}button{background:#ffdf57;border:2px solid #182128;padding:24px;font:24px Arial}input{display:block;margin:24px 0;padding:12px;width:400px}</style></head><body><header><h1>Mu VM Browser</h1></header><main><p id="status">Real Linux Chromium</p><button onclick="fetch('/clicked');this.textContent='Interaction verified'">Verify interaction</button><input placeholder="Type a test value"><canvas id="art" width="300" height="90"></canvas></main><script>
const actual=()=>({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],platform:navigator.platform,userAgent:navigator.userAgent,cores:navigator.hardwareConcurrency});
const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#176c54';c.fillRect(0,0,300,90);c.fillStyle='#ffdf57';c.font='24px Arial';c.fillText('Linux rendered pixels',12,52);
const worker=new Worker(URL.createObjectURL(new Blob(['postMessage(('+actual.toString()+')())'],{type:'text/javascript'})));
worker.onmessage=async event=>{await fetch('/login');const cookie=await(await fetch('/cookies')).text();fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,page:actual(),worker:event.data,headers:${JSON.stringify(req.headers)},cookie,canvas:document.querySelector('canvas').toDataURL()})});};
</script></body></html>`);
});
await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const targetPort=(target.address()as{port:number}).port;
const proxy=createServer((req,res)=>{
  if(req.headers['proxy-authorization']!==`Basic ${Buffer.from('mu:verification').toString('base64')}`){res.writeHead(407,{'Proxy-Authenticate':'Basic realm="Mu test"'});res.end();return;}
  const headers={...req.headers};delete headers['proxy-authorization'];const remote=httpRequest(new URL(req.url!),{method:req.method,headers},response=>{res.writeHead(response.statusCode!,response.headers);response.pipe(res);});remote.on('error',()=>{res.writeHead(502);res.end();});req.pipe(remote);
});
proxy.on('connect',(req,client,head)=>{
  if(req.headers['proxy-authorization']!==`Basic ${Buffer.from('mu:verification').toString('base64')}`){client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
  destinations.push(req.url!);const destination=new URL(`https://${req.url}`);const fixture=destination.hostname==='203.0.113.10';
  const management=destination.hostname==='203.0.113.20';
  const remote=connect(fixture?targetPort:management?service.port:Number(destination.port)||443,fixture||management?'127.0.0.1':destination.hostname,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);});
  sockets.add(remote);remote.on('close',()=>sockets.delete(remote));remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());client.on('close',()=>remote.destroy());
});
proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyPort=(proxy.address()as{port:number}).port;
const service=await createService({rootDir:root,port:0,dataDir:temporary});
const manager=service.manager;let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let guestBrowserEntry: ReturnType<typeof service.guestBrowser.entries.get>;
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),dataDir:temporary};
let id='';
async function finish(job:Job){await manager.tasks.get(job.id)?.promise;const done=manager.store.jobs().find(j=>j.id===job.id)!;if(done.status!=='succeeded'){report.logs=manager.store.logs(id).slice(-30);}assert.equal(done.status,'succeeded',done.message);}
async function until(check:()=>boolean,milliseconds=30_000){const end=Date.now()+milliseconds;while(!check()){assert.ok(Date.now()<end,'Timed out waiting for browser evidence');await new Promise(resolve=>setTimeout(resolve,200));}}
try{
  let e=manager.store.list().find(e=>e.kind==='vm');
  if(e){id=e.id;await finish(await manager.lifecycle(id,'stop'));e=await manager.update(id,{name:e.name,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,identity:{timezone:'Asia/Tokyo',locale:'ja-JP'},browserUrl:'http://203.0.113.10/',network:{mode:'http',host:'127.0.0.1',port:proxyPort,username:'mu',password:'verification',noProxy:'',strict:true,transparent:true}});}
  else{e=await manager.create({name:'VM Browser Verification',cpus:2,memoryGiB:2,diskGiB:10,browserUrl:'http://203.0.113.10/',identity:{timezone:'Asia/Tokyo',locale:'ja-JP'},network:{mode:'http',host:'127.0.0.1',port:proxyPort,username:'mu',password:'verification',noProxy:'',strict:true,transparent:true}});id=e.id;}
  await mkdir(path.join(temporary,'tools/guest-browser'),{recursive:true,mode:0o700});await copyFile('/tmp/mu-chromium-156.0.8078.4-arm64.zip',path.join(temporary,'tools/guest-browser/chrome-156.0.8078.4-linux-arm64.zip')).catch(()=>{});
  console.log('Starting protected VM browser verification.');await finish(await manager.lifecycle(id,'start'));
  const protectionBefore=await manager.runtime.networkProtection(manager.store.get(id));
  await manager.runtime.management(manager.store.get(id),['bash','-s'],{input:`set -eu\nsudo tcpdump -ni eth0 -Q out -U -s 96 -w /tmp/mu-browser-test.pcap 'ip or ip6' >/tmp/mu-browser-capture.log 2>&1 </dev/null &\necho $! >/tmp/mu-browser-capture.pid\nsleep 1\n`});
  console.log('Installing and opening Linux Chromium with its sandbox enabled.');await finish(await manager.openBrowser(id));
  guestBrowserEntry=service.guestBrowser.entries.get(id);
  await until(()=>receipts.some(r=>r.page));const receipt=receipts.find(r=>r.page);report.identity={...receipt,canvas:`PNG data URL, ${receipt.canvas.length} characters`};
  assert.match(receipt.page.platform,/^Linux /);assert.equal(receipt.page.timezone,'Asia/Tokyo');assert.equal(receipt.page.language,'ja-JP');assert.equal(receipt.page.locale,'ja-JP');assert.deepEqual(receipt.page,receipt.worker);assert.match(receipt.headers['accept-language'],/^ja-JP/);assert.equal(receipt.cookie,'synthetic=account-a');report.pageWorkerHeadersAndCookie=true;
  report.inspection=await manager.browser.inspect!(id);assert.equal(report.inspection.matchesConfiguration,true);
  const state=await manager.runtime.management(manager.store.get(id),['bash','-s'],{input:`set -eu\nsudo systemctl show mucodesandbox-browser.service -p User -p MainPID -p ActiveState\nsudo ss -ltnp | grep -E ':(5900|9222)'\nps -eo uid,args | grep '[c]hrome'\n`});report.processes=state;assert.match(state,/User=dev/);assert.match(state,/127\.0\.0\.1:5900/);assert.match(state,/127\.0\.0\.1:9222/);assert.ok(!state.includes('[::]:5900')&&!state.includes('0.0.0.0:5900'));assert.ok(!state.includes('--no-sandbox'));assert.match(state,/--type=renderer/);
  const sandbox=JSON.parse((await manager.runtime.management(manager.store.get(id),['sudo','python3','-c',`import pathlib,json
rows=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  executable=(p/'exe').readlink().as_posix()
  if executable!='/opt/mucodesandbox/chromium-156.0.8078.4/chrome-linux-arm64/chrome': continue
  cmd=(p/'cmdline').read_bytes().replace(bytes([0]),b' ').split()
  if b'--type=renderer' not in cmd: continue
  status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
  rows.append({'pid':int(p.name),'executable':executable,'seccomp':status['Seccomp'].strip(),'noNewPrivs':status['NoNewPrivs'].strip(),'pidNamespace':(p/'ns/pid').readlink().as_posix(),'rootNamespace':pathlib.Path('/proc/1/ns/pid').readlink().as_posix()})
 except (FileNotFoundError,ProcessLookupError): pass
print(json.dumps(rows))`])).trim());report.rendererSandbox=sandbox;assert.ok(sandbox.length>0,'No browser renderer found');assert.ok(sandbox.every((r:any)=>r.seccomp==='2'&&r.noNewPrivs==='1'&&r.pidNamespace!==r.rootNamespace),'Renderer sandbox must enable seccomp, no-new-privileges and a separate PID namespace');report.chromiumSandboxEnabled=true;
  const protectionAfter=await manager.runtime.networkProtection(manager.store.get(id));assert.ok(protectionAfter.active);assert.equal(protectionAfter.firewallHash,protectionBefore.firewallHash);assert.equal(protectionAfter.tunnelConfigHash,protectionBefore.tunnelConfigHash);report.browserDoesNotRelaxFirewall=true;
  const denied=await manager.runtime.guest(manager.store.get(id),['curl','--silent','--max-time','10','--header',`Host: 127.0.0.1:${service.port}`,'http://203.0.113.20/']);assert.match(denied,/UI session authorization required/);assert.ok(!denied.includes(service.token));report.managementBootstrapUnavailableThroughProxy=true;
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(service.launchUrl(`/?guestBrowser=${id}`));await page.getByRole('status').filter({hasText:'已连接'}).waitFor({timeout:30_000});const canvas=page.locator('.guest-browser-canvas canvas');await canvas.waitFor();
  await until(()=>receipts.some(r=>r.page));await new Promise(resolve=>setTimeout(resolve,1500));
  const pixels=await canvas.evaluate((node:HTMLCanvasElement)=>{const context=node.getContext('2d')!;const p=context.getImageData(0,0,node.width,node.height).data;let colors=new Set<string>();for(let i=0;i<p.length;i+=400)colors.add(`${p[i]},${p[i+1]},${p[i+2]}`);return {width:node.width,height:node.height,colors:colors.size};});assert.ok(pixels.width===1280&&pixels.height===800&&pixels.colors>20,JSON.stringify(pixels));report.nonblankFrame=pixels;
  await mkdir(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results/guest-browser-desktop.png')});
  const bounds=await canvas.boundingBox();assert.ok(bounds);await page.mouse.click(bounds.x+bounds.width*0.12,bounds.y+bounds.height*0.54);await until(()=>receipts.some(r=>r.clicked),5000);report.vncMouseInteraction=true;
  await canvas.click();await page.keyboard.press('Control+l');await page.waitForTimeout(200);await page.keyboard.type('http://203.0.113.10/keyboard',{delay:20});await page.keyboard.press('Enter');await until(()=>receipts.some(r=>r.path==='/keyboard'),5000);report.vncKeyboardNavigation=true;
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results/guest-browser-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));report.mobileFits=true;assert.deepEqual(errors,[]);report.viewerErrors=errors;
  const invalid=new WebSocket(`${service.url.replace('http:','ws:')}/guest-browser?ticket=invalid`,{origin:service.url});await new Promise<void>(resolve=>{invalid.on('error',()=>resolve());invalid.on('open',()=>{report.invalidTicketAccepted=true;invalid.close();resolve();});});assert.ok(!report.invalidTicketAccepted);report.invalidTicketRejected=true;
  const previous=receipts.length;for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));
  await page.setViewportSize({width:1440,height:1000});await canvas.click();await page.keyboard.press('Control+l');await page.waitForTimeout(200);await page.keyboard.type('http://203.0.113.10/after-proxy-loss',{delay:20});await page.keyboard.press('Enter');await new Promise(resolve=>setTimeout(resolve,3000));assert.equal(receipts.length,previous);report.proxyLossNoDirectFallback=true;
  await manager.runtime.management(manager.store.get(id),['bash','-c','sudo kill -INT "$(cat /tmp/mu-browser-capture.pid)"; sleep 1']);
  const gateway=(await manager.runtime.guest(manager.store.get(id),['ip','-4','route','show','default'])).match(/default via (\S+)/)![1];
  const unapproved=await manager.runtime.management(manager.store.get(id),['sudo','tcpdump','-nn','-r','/tmp/mu-browser-test.pcap',`not (tcp dst port ${proxyPort} and dst host ${gateway}) and not tcp src port 22 and not (udp src port 68 and udp dst port 67)`]);assert.ok(!unapproved.split('\n').some(line=>/^\d\d:\d\d:\d\d/.test(line)),unapproved);
  const approved=await manager.runtime.management(manager.store.get(id),['sudo','tcpdump','-nn','-r','/tmp/mu-browser-test.pcap',`tcp dst port ${proxyPort} and dst host ${gateway}`]);assert.ok(approved.split('\n').some(line=>/^\d\d:\d\d:\d\d/.test(line)));report.physicalCaptureOnlyProxySshDhcp=true;
  await manager.closeBrowser(id);assert.equal(service.guestBrowser.info(id).running,false);report.closeRevokesViewer=true;
  await finish(await manager.lifecycle(id,'stop'));report.passed=true;
}catch(error){
  report.error=error instanceof Error?error.stack:String(error);report.logs=manager.store.logs(id).slice(-35);process.exitCode=1;
  report.browserFailure=guestBrowserEntry?.failure?.stack;report.transportExit=guestBrowserEntry?.transport.exitCode;
  if(browser){
    const page=browser.contexts()[0]?.pages()[0];
    await page?.screenshot({path:path.join(root,'test-results/guest-browser-failure.png')}).catch(()=>{});
    report.focus=await page?.evaluate(()=>({tag:document.activeElement?.tagName,html:document.activeElement?.outerHTML.slice(0,500)})).catch(()=>null);
    report.guestPages=await manager.runtime.guest(manager.store.get(id),['curl','--silent','--max-time','5','http://127.0.0.1:9222/json/list']).catch(()=>null);
  }
}
finally{
  await browser?.close();await service.close();for(const socket of sockets)socket.destroy();if(proxy.listening)await new Promise<void>(resolve=>proxy.close(()=>resolve()));await new Promise<void>(resolve=>target.close(()=>resolve()));
  await mkdir(path.join(root,'test-results'),{recursive:true});await writeFile(path.join(root,'test-results/guest-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...Object.fromEntries(Object.entries(report).filter(([,value])=>typeof value==='boolean')),error:report.error,browserFailure:report.browserFailure,transportExit:report.transportExit},null,2));
  if(report.passed&&!process.env.MU_BROWSER_TEST_DATA){const {LimaRuntime}=await import('../server/runtime.ts');const runtime=new LimaRuntime(temporary);for(const instance of await runtime.list())await runtime.command(['delete','--force',instance.name],{timeoutMs:60_000});await rm(temporary,{recursive:true,force:true});}
}
