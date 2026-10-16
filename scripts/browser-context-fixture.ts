import { FEATURES_JS } from '../server/probe-assets.ts';

export const CONTEXT_PORT = 18463;
export const CONTEXT_ORIGIN = `http://127.0.0.1:${CONTEXT_PORT}`;
export const CROSS_CONTEXT_ORIGIN = `http://localhost:${CONTEXT_PORT}`;

function features(media: boolean) { return `import {measure} from '/base-features.js';
${media ? "import {media} from '/media.js';" : ''}
export async function extended(){
 // System fonts are measured synchronously; FontFaceSet.ready can wait for page layout.
 const basic=await measure();
 const canvas=typeof document!=='undefined'?document.createElement('canvas'):typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(600,80):null;
 const ctx=canvas?.getContext('2d');
 const fonts={};
 if(ctx) for(const family of ['monospace','Liberation Sans','IPA Gothic','WenQuanYi Zen Hei','__mu_missing_font__']){
  ctx.font='20px "'+family+'", monospace';
  fonts[family]=['MuCodeSandbox 123 ABC','日本語 中文 Ω Ж','iii WWW 012345'].map(text=>ctx.measureText(text).width);
 }
 const headers=await(await fetch('/headers')).json();
 return {...basic,fonts,headers,secureContext:isSecureContext,origin:location.origin${media ? ',media:await media()' : ''}};
}`; }

const dedicated = `import {extended} from '/extended.js';
self.onmessage=()=>{extended().then(value=>postMessage({value}),error=>postMessage({error:String(error)}));};`;
const shared = `import {extended} from '/extended.js';
const instance=crypto.randomUUID();
self.onconnect=event=>{const port=event.ports[0];port.onmessage=()=>{extended().then(value=>port.postMessage({value,instance}),error=>port.postMessage({error:String(error)}));};port.start();};`;
const service = `import {extended} from '/extended.js';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{event.waitUntil((async()=>{
 const cache=await caches.open('mu-context-synthetic');
 const previous=await cache.match('/synthetic-owner');
 const before=previous?await previous.text():null;
 if(event.data.owner) await cache.put('/synthetic-owner',new Response(event.data.owner));
 const current=await cache.match('/synthetic-owner');
 const value=await extended();
 event.ports[0].postMessage({value,before,after:current?await current.text():null,scope:self.registration.scope});
})().catch(error=>event.ports[0].postMessage({error:String(error)})));});`;

const child = `import {extended} from '/extended.js';
const query=new URLSearchParams(location.search), destination=query.get('parent');
if(![${JSON.stringify(CONTEXT_ORIGIN)},${JSON.stringify(CROSS_CONTEXT_ORIGIN)}].includes(destination))throw Error('Invalid fixture parent');
const receiver=opener||parent;
let shared;
const value=await extended();
if(query.get('kind')==='same-frame'){
 shared=new SharedWorker('/shared.js',{type:'module',name:'mu-context-shared'});
 value.sharedInstance=await new Promise((resolve,reject)=>{shared.port.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data.instance);shared.port.start();shared.port.postMessage('measure');});
}
receiver.postMessage({type:'mu-context-child',kind:query.get('kind'),run:query.get('run'),value},destination);
addEventListener('pagehide',()=>shared?.port.close());`;

const probe = `import {extended} from '/extended.js';
const query=new URLSearchParams(location.search),run=query.get('run');
const partial=window.__MU_CONTEXT_PARTIAL__={};
const track=(name,promise)=>promise.then(value=>{partial[name]=value;return value;});
const pending=new Map(),children={},ports=[];
const timed=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),15000)})]);}finally{clearTimeout(timer)}};
const collect=(kind,origin,source)=>timed(new Promise((resolve,reject)=>pending.set(kind,{origin,source,resolve,reject})),kind);
addEventListener('message',event=>{
 const data=event.data,p=data?.type==='mu-context-child'&&data.run===run&&pending.get(data.kind);
 if(!p||event.origin!==p.origin||event.source!==p.source())return;
 pending.delete(data.kind);children[data.kind]=data.value;p.resolve(data.value);
});
const childUrl=(origin,kind)=>origin+'/child?'+new URLSearchParams({parent:location.origin,run,kind});
const frame=async(origin,kind)=>{
 const f=document.createElement('iframe');f.title=kind;f.src=childUrl(origin,kind);f.hidden=true;
 const result=collect(kind,origin,()=>f.contentWindow);document.body.append(f);return result;
};
const shared=new SharedWorker('/shared.js',{type:'module',name:'mu-context-shared'});ports.push(shared.port);
const worker=new Worker('/dedicated.js',{type:'module'});
let opened,resolveWindow,rejectWindow;
const newWindow=new Promise((resolve,reject)=>{resolveWindow=resolve;rejectWindow=reject;});
document.querySelector('#open-window').onclick=()=>{
 opened=open(childUrl(${JSON.stringify(CROSS_CONTEXT_ORIGIN)},'new-window'),'mu-context-child');
 if(!opened){rejectWindow(Error('New window blocked'));return;}
 collect('new-window',${JSON.stringify(CROSS_CONTEXT_ORIGIN)},()=>opened).then(resolveWindow,rejectWindow);
};
window.__MU_CONTEXT_READY__=true;
window.__MU_CONTEXT_RESULT__=(async()=>{
 const page=await extended();partial.page=page;
 const workerResult=timed(new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data.value);worker.onerror=e=>reject(Error(e.message));worker.postMessage('measure');}),'dedicated Worker');
 const sharedResult=timed(new Promise((resolve,reject)=>{shared.port.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data);shared.port.onmessageerror=()=>reject(Error('SharedWorker message error'));shared.port.start();shared.port.postMessage('measure');}),'SharedWorker');
 const registration=await navigator.serviceWorker.register('/service.js',{type:'module',scope:'/'});
 await navigator.serviceWorker.ready;
 const active=registration.active;
 if(!active)throw Error('ServiceWorker not active');
 const channel=new MessageChannel();ports.push(channel.port1);
 const serviceResult=timed(new Promise((resolve,reject)=>{channel.port1.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data);active.postMessage({owner:query.get('owner')},[channel.port2]);}),'ServiceWorker');
 const [dedicated,sharedWorker,serviceWorker,sameFrame,crossFrame,popup]=await Promise.all([track('dedicated',workerResult),track('shared',sharedResult),track('service',serviceResult),track('sameFrame',frame(location.origin,'same-frame')),track('crossFrame',frame(${JSON.stringify(CROSS_CONTEXT_ORIGIN)},'cross-frame')),track('popup',timed(newWindow,'new window'))]);
 const result={run,page,dedicated,shared:sharedWorker,service:serviceWorker,sameFrame,crossFrame,popup,controller:!!navigator.serviceWorker.controller};
 window.__MU_CONTEXT_RECEIPT__=result;document.querySelector('#result').textContent=JSON.stringify(result,null,2);return result;
})().catch(error=>{window.__MU_CONTEXT_ERROR__=String(error);document.querySelector('#result').textContent=String(error);throw error;});
addEventListener('pagehide',()=>{worker.terminate();for(const port of ports)port.close();opened?.close();});`;

export const CONTEXT_ASSETS = {
  '/base-features.js': FEATURES_JS,
  '/extended.js': features(false),
  '/dedicated.js': dedicated,
  '/shared.js': shared,
  '/service.js': service,
  '/child.js': child,
  '/probe.js': probe,
};

export function mediaContextAssets(module: string) {
  return { ...CONTEXT_ASSETS, '/extended.js': features(true), '/media.js': module };
}

export const CONTEXT_SERVER = `import http.server,json,pathlib,time,urllib.parse
PORT=${CONTEXT_PORT}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  host=self.headers.get('Host','')
  if host not in ('127.0.0.1:'+str(PORT),'localhost:'+str(PORT)):
   self.send_error(403);return
  parsed=urllib.parse.urlparse(self.path)
  assets=json.loads(pathlib.Path('assets.json').read_text())
  if parsed.path=='/font-missing.ttf':
   self.send_error(404);return
  if parsed.path=='/font.ttf':
   files=sorted(pathlib.Path('/usr/share/fonts/truetype').glob('liberation*/LiberationSans-Regular.ttf'))
   if not files:self.send_error(404);return
   time.sleep(1)
   body=files[0].read_bytes()
   self.send_response(200);self.send_header('Content-Type','font/ttf');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
  if parsed.path=='/headers':
   body=json.dumps({key.lower():value for key,value in self.headers.items()});kind='application/json'
  elif parsed.path in assets:
   body=assets[parsed.path];kind='text/javascript'
  elif parsed.path=='/blank':
   body='<!doctype html><title>Mu context fixture ready</title>';kind='text/html'
  elif parsed.path=='/child':
   body='<!doctype html><title>Mu context child</title><script type="module" src="/child.js"></script>';kind='text/html'
  else:
   body='<!doctype html><meta charset="utf-8"><title>Mu browser context acceptance</title><style>body{font:16px sans-serif;margin:24px;background:#f4f6f8;color:#202827}h1{font-size:24px}button{padding:12px}pre{font:12px monospace;white-space:pre-wrap;overflow-wrap:anywhere}#font-sample{font-family:"Liberation Sans",sans-serif}</style><h1>Mu browser contexts</h1><button id="open-window">Open test window</button><p id="font-sample">MuCodeSandbox 123 ABC 日本語 中文</p><pre id="result">Running</pre><script type="module" src="/probe.js"></script>';kind='text/html'
  self.send_response(200);self.send_header('Content-Type',kind+'; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body.encode())
http.server.ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
`;
