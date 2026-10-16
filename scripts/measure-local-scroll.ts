import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,access,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DevTools} from '../server/guest-browser.ts';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
import {WebSocketServer,WebSocket} from 'ws';
import {connect} from 'node:net';
import {nativeFrameEncodingSource} from './native-frame-encoding.ts';
import {resizeVncDisplay} from '../server/vnc-display.ts';

const root=path.resolve(import.meta.dirname,'..'),label=process.argv[2];
assert.match(label??'',/^[a-z0-9-]{1,48}$/);
const width=Number(process.argv.find(v=>v.startsWith('--width='))?.split('=')[1]??3200);
const height=Number(process.argv.find(v=>v.startsWith('--height='))?.split('=')[1]??2000);
const fps=Number(process.argv.find(v=>v.startsWith('--fps='))?.split('=')[1]??45),compare=Number(process.argv.find(v=>v.startsWith('--compare='))?.split('=')[1]??2);
const quality=Number(process.argv.find(v=>v.startsWith('--quality='))?.split('=')[1]??9);
const viewerWidth=Number(process.argv.find(v=>v.startsWith('--viewer-width='))?.split('=')[1]??1400),headed=process.argv.includes('--headed');
const compression=Number(process.argv.find(v=>v.startsWith('--compression='))?.split('=')[1]??2);
assert.ok(viewerWidth>=600&&viewerWidth<=1440);
assert.ok([1,2,6].includes(compression));
assert.ok([45,60].includes(fps)&&[0,2].includes(compare));
assert.ok([7,8,9].includes(quality));
assert.ok(width>=1600&&width<=3200&&height>=1000&&height<=2000&&width%2===0&&height%2===0);
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const turbo=process.argv.includes('--turbo')?JSON.parse(await readFile(path.join(root,'test-results/local-scroll-performance/turbo-candidate.json'),'utf8')):null;
const turboRectArg=process.argv.find(v=>v.startsWith('--turbo-rect='));
const turboRectSize=turboRectArg?Number(turboRectArg.split('=')[1]):undefined;
assert.ok(turboRectSize===undefined||(turbo&&[65536,262144,1048576,4194304].includes(turboRectSize)));
const turboCombineArg=process.argv.find(v=>v.startsWith('--turbo-combine='));
const turboCombine=turboCombineArg?Number(turboCombineArg.split('=')[1]):undefined;
assert.ok(turboCombine===undefined||(turbo&&[1,100].includes(turboCombine)));
async function api(suffix:string){const r=await fetch(info.url+'/api/'+suffix,{headers:{Authorization:'Bearer '+config.token}});assert.ok(r.ok);return r.json();}
const snapshot=await api('snapshot'),e=snapshot.environments.find((v:any)=>v.id==='76c193f7-09a2-4544-83b8-4852445ab2be');
assert.equal(e.state,'running');
const protection=()=>api('environments/'+e.id+'/network/protection');
const before=await protection();assert.ok(before.active&&before.integrity==='verified'&&before.leaseActive);
const fixture=(await readFile(path.join(root,'scripts/local-scroll-fixture.html'),'utf8')).replaceAll('12000','8000');
const workerSource=await readFile(path.join(root,'scripts/local-scroll-worker.py'),'utf8');
const folder=await mkdtemp(path.join(tmpdir(),'mu-local-scroll-host-'));
const worker=spawn('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',e.instanceName,'sudo','python3','-u','-c',workerSource],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},stdio:['pipe','pipe','pipe']});
let pending:((v:any)=>void)|undefined,rejectPending:((error:Error)=>void)|undefined,buffer='',stderr='',exited=false;const queue:any[]=[];
worker.stderr.on('data',b=>{stderr+=b;});
worker.stdout.on('data',b=>{buffer+=b;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.startsWith('{'))continue;const value=JSON.parse(line);if(pending){const receive=pending;pending=undefined;receive(value);}else queue.push(value);}});
worker.on('exit',()=>{exited=true;rejectPending?.(Error('Diagnostic exited: '+stderr.slice(-1500)));});
async function next(){if(queue.length)return queue.shift();if(exited)throw Error('Diagnostic exited: '+stderr.slice(-1500));return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending=undefined;rejectPending=undefined;reject(Error('Diagnostic response timeout: '+stderr.slice(-1500)));},20000);rejectPending=error=>{clearTimeout(timer);pending=undefined;rejectPending=undefined;reject(error);};pending=value=>{clearTimeout(timer);rejectPending=undefined;resolve(value);};});}
function verify(report:any){
 assert.ok(report.processes.some((p:any)=>p.role==='renderer')&&report.processes.some((p:any)=>p.role==='gpu-process'));
 for(const p of report.processes){assert.equal(p.noSandboxFlag,false);if(p.role==='renderer')assert.equal(p.separatePidNamespace,true);assert.ok(p.threads.length);for(const t of p.threads){assert.equal(t.uid,report.developmentUid);assert.equal(t.seccomp,2);assert.equal(t.noNewPrivileges,1);assert.match(t.effectiveCapabilities,/^0+$/);}}
}
let tunnel:ReturnType<typeof spawn>|undefined,tools:DevTools|undefined;
let viewerBrowser:Awaited<ReturnType<typeof chromium.launch>>|undefined,viewerPage:Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>>|undefined,vite:Awaited<ReturnType<typeof createServer>>|undefined,wss:WebSocketServer|undefined,bytes=0;
let viewerProfiler:Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newBrowserCDPSession']>>|undefined;
const result:any={label,at:new Date().toISOString(),version:snapshot.system.version,resources:{cpus:e.cpus,memoryGiB:e.memoryGiB},display:{width,height,dpr:2},variants:[],scope:'Disposable authenticated display and temporary browser profiles in the real VM, installed Chrome and normal graphics sandbox. Local 200-card scroll/layout fixture only. No user profile, AI service, account, external page or physical input. Frame scheduling is not pointer-to-photon latency; VNC encoding is measured separately.'};
try{
 const password=randomBytes(6).toString('base64url');
 worker.stdin.write(JSON.stringify({html:fixture,password,width,height,fps,compare,functional:process.argv.includes('--display-check'),turboExecutable:turbo?.executable,turboRectSize,turboCombine,executable:'/opt/mucodesandbox/chromium-155.0.8059.39/chrome-linux-arm64/chrome'})+'\n');result.displayServer=turbo?{name:'TurboVNC',version:turbo.version,sha256:turbo.expectedSha256,threads:4,deferUpdateMs:1,maxTightRectPixels:turboRectSize??65536,combineRectanglesAbove:turboCombine??100}:{name:'TigerVNC',fpsLimit:fps,compare};
 const ready=await next();assert.ok(ready.ready);result.actualCpus=ready.cpus;result.displaySecurity=ready.security;
 const socket=path.join(folder,'cdp.sock');
 const vncSocket=path.join(folder,'vnc.sock');
 tunnel=spawn('/usr/bin/ssh',['-F','/Users/staff/.mucodesandbox/lima/'+e.instanceName+'/ssh.config','-S','none','-N','-T','-o','ExitOnForwardFailure=yes','-L',socket+':127.0.0.1:19223','-L',vncSocket+':127.0.0.1:15997','lima-'+e.instanceName],{stdio:'ignore'});
 for(let n=0;n<60;n++){try{await access(socket);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(process.argv.includes('--viewer')){
  const rectangleNegotiation=process.argv.includes('--no-last-rect')?"const sendEncodings=RFB.messages.clientEncodings;RFB.messages.clientEncodings=(socket,encodings)=>sendEncodings(socket,encodings.filter(value=>value!==-224));":"";
  const nativeBase64=process.argv.includes('--native-base64')?"if(typeof Uint8Array.prototype.toBase64!=='function')throw Error('Native Base64 unavailable');window.nativeBase64Calls=0;":"";
  const imageDecoder=process.argv.includes('--bitmap-images')?"r._display.imageRect=(x,y,width,height,mime,arr)=>{if(!width||!height)return;const frame={ready:false,frame:null,promise:null};frame.promise=createImageBitmap(new Blob([arr],{type:mime})).then(b=>{if(b.width!==width||b.height!==height)throw Error('Unexpected decoded size');b.codedWidth=b.width;b.codedHeight=b.height;frame.frame=b;frame.ready=true;});r._display.videoFrame(x,y,width,height,frame);};":process.argv.includes('--blob-images')?"r._display.imageRect=(x,y,width,height,mime,arr)=>{if(!width||!height)return;const img=new Image(),url=URL.createObjectURL(new Blob([arr],{type:mime}));const revoke=()=>URL.revokeObjectURL(url);img.addEventListener('load',revoke,{once:true});img.addEventListener('error',revoke,{once:true});img.src=url;r._display._renderQPush({type:'img',img,x,y,width,height});};":"";
  const source="import RFB from '/node_modules/@novnc/novnc/core/rfb.js';"+rectangleNegotiation+nativeBase64+"window.openViewer=password=>{window.flips=[];let dirty=false;const frame=t=>{if(dirty){window.flips.push(t);dirty=false;}requestAnimationFrame(frame);};requestAnimationFrame(frame);const r=new RFB(document.getElementById('screen'),'ws://'+location.host+'/rfb',{credentials:{password},shared:true});r.scaleViewport=true;r.resizeSession=false;r.qualityLevel="+quality+";r.compressionLevel="+compression+";window.rfb=r;"+imageDecoder+"const flip=r._display.flip.bind(r._display);r._display.flip=(...a)=>{const d=r._display,b=d._damageBounds,paint=(!d._renderQ.length||a[0])&&b.right>b.left&&b.bottom>b.top;const out=flip(...a);if(paint)dirty=true;return out;};r.addEventListener('connect',()=>window.ready=true);};";
  vite=await createServer({configFile:false,root,cacheDir:path.join(folder,'vite'),logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'owned-scroll-viewer',transform(code,id){
   if(!process.argv.includes('--native-base64')||!id.split('?')[0].endsWith('/@novnc/novnc/core/base64.js'))return;
   return nativeFrameEncodingSource(code).replace('return Uint8Array.prototype.toBase64.call(data);',"window.nativeBase64Calls=(window.nativeBase64Calls??0)+1;return Uint8Array.prototype.toBase64.call(data);");
  },configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/scroll-viewer.js'){res.setHeader('Content-Type','text/javascript');res.end(source);}else if(req.url==='/scroll-viewer.html'){res.setHeader('Content-Type','text/html');res.end('<div id="screen" style="width:'+viewerWidth+'px;height:'+Math.round(viewerWidth*height/width)+'px"></div><script type="module" src="/scroll-viewer.js"></script>');}else next();});}}]});
  wss=new WebSocketServer({noServer:true});await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
  vite.httpServer!.on('upgrade',(req,socket,head)=>{if(req.url!=='/rfb')return;wss!.handleUpgrade(req,socket,head,ws=>{const remote=connect(vncSocket);remote.on('data',b=>{bytes+=b.length;if(ws.readyState===WebSocket.OPEN)ws.send(b);});remote.on('error',()=>ws.close());ws.on('message',b=>remote.write(b as Buffer));ws.on('close',()=>remote.destroy());});});
  viewerBrowser=await chromium.launch({channel:'chrome',headless:!headed});viewerPage=await viewerBrowser.newPage({viewport:{width:Math.min(1440,viewerWidth+40),height:Math.min(950,Math.round(viewerWidth*height/width)+75)},deviceScaleFactor:2});await viewerPage.goto('http://127.0.0.1:'+address.port+'/scroll-viewer.html');await viewerPage.waitForFunction(()=>typeof(window as any).openViewer==='function');await viewerPage.evaluate(password=>(window as any).openViewer(password),password);await viewerPage.waitForFunction(()=>(window as any).ready===true);
  const hostGraphics=await viewerPage.evaluate(()=>{const c=document.createElement('canvas'),g=c.getContext('webgl');if(!g)return{available:false};const e=g.getExtension('WEBGL_debug_renderer_info');const renderer=g.getParameter(e?e.UNMASKED_RENDERER_WEBGL:g.RENDERER);g.getExtension('WEBGL_lose_context')?.loseContext();return{available:true,renderer};});
  await viewerPage.evaluate(()=>{
   const display=(window as any).rfb._display,original=display.imageRect.bind(display);
   (window as any).imageStatistics={rectangles:0,pixels:0};
   display.imageRect=(...args:any[])=>{
    const stats=(window as any).imageStatistics;stats.rectangles++;stats.pixels+=args[2]*args[3];
    return original(...args);
   };
  });
  if(process.argv.includes('--profile-viewer')){
   viewerProfiler=await viewerPage.context().newCDPSession(viewerPage);
   await viewerProfiler.send('Profiler.enable');
   await viewerProfiler.send('Profiler.setSamplingInterval',{interval:1000});
  }
  result.viewer={fpsLimit:turbo?null:fps,compare:turbo?null:compare,quality,compression,headed,viewerWidth,hostGraphics,nativeBase64:process.argv.includes('--native-base64'),lastRect:!process.argv.includes('--no-last-rect'),blobImages:process.argv.includes('--blob-images'),bitmapImages:process.argv.includes('--bitmap-images'),measurement:'Changed visible canvas sampled at host requestAnimationFrame; queued flip calls and same-refresh duplicate paints are excluded. Not physical monitor or pointer-to-photon timing.'};
 }
 for(const variant of process.argv.includes('--matrix')?['production','software-compositing']:process.argv.includes('--software')?['software-compositing']:['production']){
  worker.stdin.write(JSON.stringify({variant})+'\n');await next();
  tools=await DevTools.open(socket);
  let target:any;
  for(let n=0;n<40;n++){const found=await tools.send('Target.getTargets');target=found.targetInfos.find((t:any)=>t.type==='page'&&t.url===ready.pageUrl);if(target)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(target);
  const {sessionId}=await tools.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  let fixtureReady=false;
  for(let attempt=0;attempt<100;attempt++){
   const state=await tools.send('Runtime.evaluate',{expression:"Boolean(document.getElementById('results')&&document.getElementById('start')?.onclick)",returnByValue:true},sessionId);
   if(state.result.value===true){fixtureReady=true;break;}
   await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(fixtureReady,'Owned local fixture must finish loading before measurement');
  const row:any={variant,trials:[]};result.variants.push(row);
  for(let n=0;n<(process.argv.includes('--input-only')?0:3);n++){
   worker.stdin.write('{"inspect":true}\n');const cpuBefore=await next();
   if(viewerPage){bytes=0;await viewerPage.evaluate(()=>{(window as any).flips=[];(window as any).nativeBase64Calls=0;(window as any).imageStatistics={rectangles:0,pixels:0};});}
   if(viewerProfiler)await viewerProfiler.send('Profiler.start');
   const response:any=await tools.send('Runtime.evaluate',{expression:"new Promise((resolve,reject)=>{const box=document.getElementById('results');box.style.display='none';const start=document.getElementById('start');start.disabled=false;start.click();const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Scroll fixture timed out'));},12000);const poll=setInterval(()=>{if(box.style.display!=='block')return;clearTimeout(timer);clearInterval(poll);resolve(JSON.parse(box.textContent));},50);})",awaitPromise:true,returnByValue:true},sessionId);
   assert.equal(response.exceptionDetails,undefined);assert.equal(response.result.value.dpr,2);const measurement=response.result.value;
   if(viewerProfiler){
    const {profile}=await viewerProfiler.send('Profiler.stop');
    const self=new Map<number,number>();
    for(let index=0;index<(profile.samples?.length??0);index++)self.set(profile.samples![index],(self.get(profile.samples![index])??0)+(profile.timeDeltas?.[index]??0));
    measurement.viewerProfile=profile.nodes.map(node=>({name:node.callFrame.functionName,file:node.callFrame.url.split('/').slice(-2).join('/'),line:node.callFrame.lineNumber,selfMs:Math.round((self.get(node.id)??0)/1000)})).sort((a,b)=>b.selfMs-a.selfMs).slice(0,20);
   }
   if(viewerPage){measurement.viewer=await viewerPage.evaluate(()=>{const a=(window as any).flips as number[],g=a.slice(1).map((v,i)=>v-a[i]).sort((a,b)=>a-b);return{frames:a.length,p50GapMs:g[Math.floor(g.length*.5)],p95GapMs:g[Math.floor(g.length*.95)],images:(window as any).imageStatistics,nativeBase64Calls:(window as any).nativeBase64Calls};});measurement.viewer.bytes=bytes;measurement.viewer.averageFps=measurement.viewer.frames/(measurement.elapsedMs/1000);if(process.argv.includes('--native-base64'))assert.ok(measurement.viewer.nativeBase64Calls>0,'Candidate Base64 encoder must be used by the real viewer');}
   row.trials.push(measurement);
   worker.stdin.write('{"inspect":true}\n');const cpuAfter=await next();measurement.guestCpu={browserSeconds:cpuAfter.cpuSeconds-cpuBefore.cpuSeconds,displaySeconds:cpuAfter.displayCpuSeconds-cpuBefore.displayCpuSeconds};
  }
  if(process.argv.includes('--wheel-check')){
   assert.ok(viewerPage,'Wheel check needs the owned viewer');row.wheel=[];
   await tools.send('Runtime.evaluate',{expression:"window.ownedWheelEvents=[];window.addEventListener('wheel',e=>window.ownedWheelEvents.push({deltaY:e.deltaY,trusted:e.isTrusted}),{passive:true})"},sessionId);
   await viewerPage.mouse.move(viewerWidth/2,350);
   for(const deltas of [[50],[150],[40,20,40]]){
    await tools.send('Runtime.evaluate',{expression:"window.scrollTo(0,0);window.ownedWheelEvents=[]"},sessionId);
    await viewerPage.evaluate(()=>{const r=(window as any).rfb;r._accumulatedWheelDeltaX=0;r._accumulatedWheelDeltaY=0;});
    await new Promise(r=>setTimeout(r,150));
    for(const delta of deltas){await viewerPage.mouse.wheel(0,delta);await new Promise(r=>setTimeout(r,70));}
    await new Promise(r=>setTimeout(r,350));
    const observed=await tools.send('Runtime.evaluate',{expression:"({scrollY:window.scrollY,events:window.ownedWheelEvents})",returnByValue:true},sessionId);
    row.wheel.push({deltas,...observed.result.value,remainingClientDelta:await viewerPage.evaluate(()=>(window as any).rfb._accumulatedWheelDeltaY)});
   }
  }
  const canvas=await tools.send('Runtime.evaluate',{expression:"(()=>{const out={};for(const type of ['2d','webgl','webgl2']){const c=document.createElement('canvas');c.width=c.height=64;c.style.cssText='position:fixed;z-index:1000;right:'+(20+Object.keys(out).length*80)+'px;bottom:20px;width:64px;height:64px';document.body.append(c);const g=c.getContext(type);if(!g){out[type]={supported:false};continue;}if(type==='2d'){g.fillStyle='#00ff00';g.fillRect(0,0,64,64);out[type]={pixels:[...g.getImageData(32,32,1,1).data]};}else{g.clearColor(0,1,0,1);g.clear(g.COLOR_BUFFER_BIT);const p=new Uint8Array(4);g.readPixels(32,32,1,1,g.RGBA,g.UNSIGNED_BYTE,p);out[type]={pixels:[...p],error:g.getError()};}}return out;})()",returnByValue:true},sessionId);
  row.canvas=canvas.result.value;for(const type of ['2d','webgl','webgl2'])assert.deepEqual(row.canvas[type].pixels,[0,255,0,255]);
  await new Promise(r=>setTimeout(r,500));
  worker.stdin.write('{"inspect":true}\n');row.protection=await next();verify(row.protection);
  const screenshot=await tools.send('Page.captureScreenshot',{format:'png'},sessionId);
  const visible=await tools.send('Runtime.evaluate',{expression:"(async()=>{const b=Uint8Array.from(atob("+JSON.stringify(screenshot.data)+"),c=>c.charCodeAt(0));const image=await createImageBitmap(new Blob([b],{type:'image/png'}));const c=new OffscreenCanvas(image.width,image.height),g=c.getContext('2d');g.drawImage(image,0,0);const p=g.getImageData(0,0,c.width,c.height).data;let green=0;for(let i=0;i<p.length;i+=4)if(p[i]===0&&p[i+1]===255&&p[i+2]===0)green++;return{width:image.width,height:image.height,green};})()",awaitPromise:true,returnByValue:true},sessionId);
  row.visibleCanvas=visible.result.value;assert.equal(row.visibleCanvas.green,64*64*4*3,'Canvas2D, WebGL and WebGL2 must actually appear in the captured frame');
  await mkdir(path.join(root,'test-results/local-scroll-performance'),{recursive:true});
  await writeFile(path.join(root,'test-results/local-scroll-performance',label+'-'+variant+'.png'),Buffer.from(screenshot.data,'base64'));
  if(process.argv.includes('--display-check')){
   assert.ok(viewerPage);row.resizes=[];
   await viewerPage.evaluate(()=>{(window as any).ownedClipboardEvents=[];(window as any).rfb.addEventListener('clipboard',(event:any)=>(window as any).ownedClipboardEvents.push(event.detail.text));});
   worker.stdin.write('{"clipboardSeed":true}\n');assert.ok((await next()).clipboardSeeded);
   await new Promise(r=>setTimeout(r,150));
   await viewerPage.evaluate(()=>(window as any).rfb.clipboardPasteFrom('MU_HOST_CLIPBOARD_FIXTURE'));
   await new Promise(r=>setTimeout(r,150));
   worker.stdin.write('{"clipboardRead":true}\n');const clipboard=await next();
   assert.equal(clipboard.clipboard,'MU_GUEST_CLIPBOARD_FIXTURE');
   const clipboardEvents=await viewerPage.evaluate(()=>(window as any).ownedClipboardEvents);assert.deepEqual(clipboardEvents,[]);
   row.clipboard={incomingDisabled:true,outgoingDisabled:true,scope:'Only synthetic X11 clipboard in the owned diagnostic display; Mac clipboard never read or written.'};
   for(const dimensions of [{width:2560,height:1600},{width,height}]){
    const actual=await resizeVncDisplay(vncSocket,password,dimensions.width,dimensions.height);assert.deepEqual(actual,dimensions);
    await viewerPage.waitForFunction(d=>{const r=(window as any).rfb;return r._fbWidth===d.width&&r._fbHeight===d.height;},dimensions);
    const screenSample:any=await tools.send('Runtime.evaluate',{expression:'({width:screen.width,height:screen.height,dpr:devicePixelRatio})',returnByValue:true},sessionId);
    assert.deepEqual(screenSample.result.value,{width:dimensions.width/2,height:dimensions.height/2,dpr:2});row.resizes.push({actual,screen:screenSample.result.value});
   }
   await tools.send('Runtime.evaluate',{expression:"localStorage.setItem('mu-owned-reconnect','unchanged');const i=document.createElement('input');i.id='mu-owned-keyboard';i.style.cssText='position:fixed;z-index:2001;top:100px;left:10px;width:200px';document.body.append(i);window.ownedKeyEvents=[];i.addEventListener('input',e=>window.ownedKeyEvents.push(e.isTrusted));i.focus()"},sessionId);
   await viewerPage.evaluate(()=>(window as any).rfb.focus());
   // RFB forwards physical key codes. Playwright.type() inserts uppercase text
   // without holding Shift, so exercise the actual keyboard chords instead.
   for(const key of ['KeyM','KeyU','Minus','KeyL','KeyO','KeyC','KeyA','KeyL','Minus','KeyI','KeyN','KeyP','KeyU','KeyT'])await viewerPage.keyboard.press('Shift+'+key);
   await new Promise(r=>setTimeout(r,150));
   const input=await tools.send('Runtime.evaluate',{expression:"({value:document.getElementById('mu-owned-keyboard').value,trusted:window.ownedKeyEvents})",returnByValue:true},sessionId);
   row.keyboard=input.result.value;assert.equal(input.result.value.value,'MU_LOCAL_INPUT');assert.ok(input.result.value.trusted.length&&input.result.value.trusted.every(Boolean));
   await viewerPage.evaluate(()=>new Promise<void>(resolve=>{const r=(window as any).rfb;r.addEventListener('disconnect',()=>resolve(),{once:true});r.disconnect();}));
   await viewerPage.evaluate(password=>{(window as any).ready=false;(window as any).openViewer(password);},password);
   await viewerPage.waitForFunction(()=>(window as any).ready===true);
   const retained=await tools.send('Runtime.evaluate',{expression:"({marker:localStorage.getItem('mu-owned-reconnect'),value:document.getElementById('mu-owned-keyboard').value})",returnByValue:true},sessionId);
   assert.deepEqual(retained.result.value,{marker:'unchanged',value:'MU_LOCAL_INPUT'});row.reconnectPreserved=retained.result.value;
  }
  console.log(JSON.stringify({variant,trials:row.trials}));tools.close();tools=undefined;
 }
 const after=await protection();result.afterProtection={active:after.active,integrity:after.integrity,leaseActive:after.leaseActive};assert.ok(after.active&&after.integrity==='verified'&&after.leaseActive);assert.equal(after.firewallHash,before.firewallHash);assert.equal(after.tunnelConfigHash,before.tunnelConfigHash);result.guardUnchanged=true;
 await writeFile(path.join(root,'test-results/local-scroll-performance',label+'.json'),JSON.stringify(result,null,2)+'\n');
}catch(error){
 result.failed=true;result.error=(error as Error).message;
 await mkdir(path.join(root,'test-results/local-scroll-performance'),{recursive:true});await writeFile(path.join(root,'test-results/local-scroll-performance',label+'.failed.json'),JSON.stringify(result,null,2)+'\n');throw error;
}finally{
 tools?.close();await viewerBrowser?.close();if(wss){for(const c of wss.clients)c.terminate();wss.close();}await vite?.close();worker.stdin.end();tunnel?.kill();
 await new Promise<void>(resolve=>{if(exited)return resolve();worker.once('exit',()=>resolve());});
 await rm(folder,{recursive:true,force:true});
}
