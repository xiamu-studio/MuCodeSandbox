import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {connect} from 'node:net';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
import {WebSocketServer,WebSocket} from 'ws';

// Bounded synthetic display-only measurement. Separate authenticated X server;
// no input or CDP access to the user's browser, no profile/network changes.
const root=path.resolve(import.meta.dirname,'..');
const instance='mu-76c193f709a24544';
const frameRate=Number(process.argv.find(a=>a.startsWith('--fps='))?.split('=')[1]??30);
assert.ok([30,45,60].includes(frameRate));
const dir=await mkdtemp(path.join(tmpdir(),'mu-display-perf-'));
const password=randomBytes(6).toString('base64url');
const guest=String.raw`import ctypes as C,json,os,pathlib,pwd,subprocess,sys,tempfile,time,shutil
u=pwd.getpwnam('dev');folder=tempfile.mkdtemp(prefix='mu-display-perf-');os.chown(folder,u.pw_uid,u.pw_gid)
server=None
try:
 if pathlib.Path('/tmp/.X98-lock').exists():raise RuntimeError('Diagnostic display already occupied')
 secret=folder+'/passwd'
 subprocess.run(['x11vnc','-storepasswd',sys.argv[1],secret],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 os.chown(secret,u.pw_uid,u.pw_gid);os.chmod(secret,0o600)
 auth=folder+'/Xauthority';pathlib.Path(auth).touch();os.chmod(auth,0o600);os.chown(auth,u.pw_uid,u.pw_gid)
 subprocess.run(['xauth','-f',auth,'add',':98','.',os.urandom(16).hex()],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 log=open(folder+'/server.log','wb')
 server=subprocess.Popen(['sudo','-H','-u','dev','--','Xtigervnc',':98','-geometry','3200x2000','-depth','24','-dpi','192','-rfbport','15998','-rfbunixpath',folder+'/vnc.sock','-interface','127.0.0.1','-localhost=1','-SecurityTypes','VncAuth','-rfbauth',secret,'-auth',auth,'-nolisten','tcp','-UseIPv6=0','-AcceptCutText=0','-SendCutText=0','-AlwaysShared=1','-FrameRate='+sys.argv[2]],stdout=log,stderr=log)
 for _ in range(150):
  if pathlib.Path(folder+'/vnc.sock').exists():break
  if server.poll() is not None:raise RuntimeError(pathlib.Path(folder+'/server.log').read_text())
  time.sleep(.05)
 os.environ['XAUTHORITY']=auth
 x=C.CDLL('libX11.so.6')
 def bind(name,args,result):
  f=getattr(x,name);f.argtypes=args;f.restype=result;return f
 P=C.c_void_p;U=C.c_ulong;I=C.c_int
 op=bind('XOpenDisplay',[C.c_char_p],P);d=op(b':98')
 if not d:raise RuntimeError('Diagnostic X display unavailable')
 root=bind('XDefaultRootWindow',[P],U)(d)
 gc=bind('XCreateGC',[P,U,U,P],P)(d,root,0,None)
 pix=bind('XCreatePixmap',[P,U,C.c_uint,C.c_uint,C.c_uint],U)(d,root,3200,4000,24)
 fg=bind('XSetForeground',[P,P,U],I);fill=bind('XFillRectangle',[P,U,P,I,I,C.c_uint,C.c_uint],I)
 fg(d,gc,0xf4f6f8);fill(d,pix,gc,0,0,3200,4000)
 for row in range(160):
  for col in range(8):
   fg(d,gc,0x204050+((row*113+col*317)%0x7f7f7f));fill(d,pix,gc,col*400+20,row*25,200+(row*17+col*23)%150,12)
 cp=bind('XCopyArea',[P,U,U,P,I,I,C.c_uint,C.c_uint,I,I],I);sync=bind('XSync',[P,I],I)
 cp(d,pix,root,gc,0,0,3200,2000,0,0);sync(d,0)
 def server_cpu():
  ids=[server.pid];ticks=0
  for pid in ids:
   try:
    stat=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
    ticks+=int(stat[11])+int(stat[12])
    ids.extend(int(v) for v in pathlib.Path('/proc/'+str(pid)+'/task/'+str(pid)+'/children').read_text().split())
   except FileNotFoundError:pass
  return ticks/os.sysconf('SC_CLK_TCK')
 print(json.dumps({'ready':True}),flush=True)
 for line in sys.stdin:
  command=json.loads(line)
  if command.get('stop'):break
  begin=time.monotonic();cpu=time.process_time();server_before=server_cpu();frames=0
  for n in range(300):
   cp(d,pix,root,gc,0,(n*12)%2000,3200,2000,0,0);sync(d,0);frames+=1
   wait=begin+(n+1)/60-time.monotonic()
   if wait>0:time.sleep(wait)
  print(json.dumps({'frames':frames,'seconds':time.monotonic()-begin,'producerCpuSeconds':time.process_time()-cpu,'serverCpuSeconds':server_cpu()-server_before}),flush=True)
 bind('XCloseDisplay',[P],I)(d)
finally:
 if server is not None:
  server.terminate()
  try:server.wait(3)
  except subprocess.TimeoutExpired:server.kill();server.wait()
 shutil.rmtree(folder,ignore_errors=True)
`;
const worker=spawn('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',instance,'sudo','python3','-c',guest,password,String(frameRate)],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},stdio:['pipe','pipe','pipe']});
let buffer='',stderr='',failure:Error|undefined;const queue:any[]=[];let waiter:((v:any)=>void)|undefined;
worker.stderr.on('data',b=>stderr+=b);
worker.stdout.on('data',b=>{buffer+=b;let p;while((p=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,p);buffer=buffer.slice(p+1);if(!line.startsWith('{'))continue;const v=JSON.parse(line);if(waiter){const w=waiter;waiter=undefined;w(v);}else queue.push(v);}});
worker.on('exit',code=>{if(code!==0)failure=Error(`Diagnostic worker exited ${code}: ${stderr}`);});
const next=async()=>{if(failure)throw failure;if(queue.length)return queue.shift();return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{waiter=undefined;reject(failure??Error('Diagnostic worker timeout'));},12000);waiter=v=>{clearTimeout(timer);resolve(v);};});};
let tunnel:ReturnType<typeof spawn>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const source=`import RFB from '/node_modules/@novnc/novnc/core/rfb.js';window.openViewer=(compression,password)=>{window.flips=[];const r=new RFB(document.getElementById('screen'),'ws://'+location.host+'/measure',{credentials:{password},shared:true});r.scaleViewport=true;r.resizeSession=false;r.qualityLevel=9;r.compressionLevel=compression;window.rfb=r;const flip=r._display.flip.bind(r._display);r._display.flip=(...args)=>{window.flips.push(performance.now());return flip(...args)};r.addEventListener('connect',()=>window.ready=true);r.addEventListener('disconnect',()=>window.ready=false);};`;
const vite=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'display-measure',configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/measure-entry.js'){res.setHeader('Content-Type','text/javascript');res.end(source);}else if(req.url==='/measure.html'){res.setHeader('Content-Type','text/html');res.end('<div id="screen" style="width:1400px;height:875px"></div><script type="module" src="/measure-entry.js"></script>');}else next();});}}]});
const wss=new WebSocketServer({noServer:true});let bytes=0;
const rows:any[]=[];
try{
 assert.equal((await next()).ready,true);
 const sock=path.join(dir,'vnc.sock');
 tunnel=spawn('/usr/bin/ssh',['-F',`/Users/staff/.mucodesandbox/lima/${instance}/ssh.config`,'-S','none','-N','-T','-o','ExitOnForwardFailure=yes','-L',`${sock}:127.0.0.1:15998`,`lima-${instance}`],{stdio:'ignore'});
 for(let i=0;i<50;i++){try{await access(sock);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
 vite.httpServer!.on('upgrade',(req,socket,head)=>{if(req.url!=='/measure')return;wss.handleUpgrade(req,socket,head,ws=>{const remote=connect(sock);remote.on('data',b=>{bytes+=b.length;if(ws.readyState===WebSocket.OPEN)ws.send(b);});ws.on('message',b=>remote.write(b as Buffer));remote.on('error',()=>ws.close());ws.on('close',()=>remote.destroy());});});
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2});
 await page.goto(`http://127.0.0.1:${address.port}/measure.html`);await page.waitForFunction(()=>typeof(window as any).openViewer==='function');
 for(const compression of [2,2]){
  await page.evaluate(({compression,password})=>(window as any).openViewer(compression,password),{compression,password});
  await page.waitForFunction(()=>(window as any).ready===true);
  await page.waitForTimeout(500);bytes=0;
  await page.evaluate(()=>{(window as any).flips=[];});
  worker.stdin.write('{}\n');const producer=await next();
  const received=await page.evaluate(()=>{const a=(window as any).flips as number[];const gaps=a.slice(1).map((n,i)=>n-a[i]).sort((a,b)=>a-b);return{frames:a.length,p50GapMs:gaps[Math.floor(gaps.length*.5)],p95GapMs:gaps[Math.floor(gaps.length*.95)]};});
  rows.push({compression,bytes,producer,received});console.log(JSON.stringify(rows.at(-1)));
  await page.evaluate(()=>(window as any).rfb.disconnect());await page.waitForFunction(()=>(window as any).ready===false);
 }
 await mkdir(path.join(root,'test-results/display-performance'),{recursive:true});
 await writeFile(path.join(root,'test-results/display-performance/transport.json'),JSON.stringify({at:new Date().toISOString(),scope:'Synthetic XCopyArea scrolling at 3200x2000 on separate authenticated X display. Same SSH/noVNC transport; no Chrome rendering, physical input or overall user latency claim.',frameRate,quality:9,rows},null,2)+'\n');
}finally{
 await browser?.close();for(const ws of wss.clients)ws.terminate();wss.close();await vite.close();tunnel?.kill();worker.stdin.end();
 await new Promise<void>(resolve=>{if(worker.exitCode!==null)return resolve();worker.once('exit',()=>resolve());});
 await rm(dir,{recursive:true,force:true});
}
