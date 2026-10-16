export const FEATURES_JS = `export async function measure() {
  const n = navigator;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(320,80) : null;
  let canvasHash = null, gpu = null;
  if (canvas) {
    canvas.width=320; canvas.height=80;
    const c=canvas.getContext('2d');
    if(c) { c.fillStyle='#23664f';c.fillRect(0,0,320,80);c.font='18px Arial';c.fillStyle='#ffffff';c.fillText('MuCodeSandbox 123 ABC',12,42);
      const bytes=c.getImageData(0,0,320,80).data;
      canvasHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join(''); }
    const g=typeof document!=='undefined'?document.createElement('canvas'):new OffscreenCanvas(16,16);
    const gl=g.getContext('webgl');
    if(gl){ const ext=gl.getExtension('WEBGL_debug_renderer_info');gpu={vendor:gl.getParameter(ext?ext.UNMASKED_VENDOR_WEBGL:gl.VENDOR),renderer:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  }
  let clientHints=null;
  if(n.userAgentData) clientHints=await n.userAgentData.getHighEntropyValues(['platform','architecture','bitness','model','fullVersionList']);
  return { timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:n.language,languages:[...n.languages],platform:n.platform,userAgent:n.userAgent,hardwareConcurrency:n.hardwareConcurrency,deviceMemoryGiB:n.deviceMemory??null,clientHints,canvasHash,gpu,screen:typeof screen!=='undefined'?{width:screen.width,height:screen.height,colorDepth:screen.colorDepth,pixelRatio:devicePixelRatio}:null };
}`;

export const PROBE_JS = `import {measure} from '/features.js';
async function timed(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),6000)})]);}finally{clearTimeout(timer)}}
async function run(){
 const page=await measure();
 const worker=await timed(new Promise((resolve,reject)=>{const w=new Worker('/worker.js',{type:'module'});w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=e=>{w.terminate();reject(new Error(e.message))}}),'Worker');
 const frame=await timed(new Promise(resolve=>{const f=document.createElement('iframe');f.hidden=true;const receive=e=>{if(e.source===f.contentWindow&&e.origin===location.origin){removeEventListener('message',receive);f.remove();resolve(e.data)}};addEventListener('message',receive);f.src='/frame';document.body.append(f)}),'iframe');
 const headers=await(await fetch('/api/echo')).json();
 const status=await(await fetch('/api/status')).json();
 const candidates=[];
 const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:'+status.stunPort}]});
 pc.onicecandidate=e=>{if(e.candidate)candidates.push({candidate:e.candidate.candidate,type:e.candidate.type,address:e.candidate.address,protocol:e.candidate.protocol})};
 pc.createDataChannel('mu');await pc.setLocalDescription(await pc.createOffer());
 await Promise.race([new Promise(resolve=>{pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolve()}}),new Promise(resolve=>setTimeout(resolve,2500))]);pc.close();
 const keys=['timezone','locale','language','languages','platform','userAgent','hardwareConcurrency','deviceMemoryGiB','clientHints','canvasHash','gpu'];
 const mismatches=keys.filter(k=>JSON.stringify(page[k])!==JSON.stringify(worker[k])||JSON.stringify(page[k])!==JSON.stringify(frame[k]));
 const receipt={page,worker,frame,headers,candidates,mismatches,checkedAt:new Date().toISOString(),scope:'loopback-lab'};
 const saved=await(await fetch('/api/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(receipt)})).json();
 window.__MU_PROBE__={...receipt,id:saved.id};
 document.querySelector('#result').textContent=JSON.stringify(window.__MU_PROBE__,null,2);
 document.querySelector('#state').textContent=mismatches.length?'有特征差异':'特征一致';
}
document.querySelector('#login').onclick=async()=>{await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'synthetic-a'})});document.querySelector('#account').textContent=(await(await fetch('/api/session')).json()).account;};
run().catch(e=>{window.__MU_PROBE_ERROR__=e.message;document.querySelector('#state').textContent=e.message});
`;

export const PROBE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MuCodeSandbox 环境检测</title><style>body{margin:0;background:#f7f8fa;color:#25372e;font:14px system-ui}main{max-width:960px;margin:0 auto;padding:24px}h1{font-size:22px}button{background:#23664f;color:white;border:0;padding:10px 16px;border-radius:4px}pre{overflow:auto;font:12px monospace;border-top:1px solid #d7e0db;padding-top:18px}header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}#state{color:#47685a}</style><script type="module" src="/probe.js"></script></head><body><main><header><h1>MuCodeSandbox 环境检测</h1><span id="state">检测中</span><button id="login" type="button">模拟登录</button><span id="account">未登录</span></header><pre id="result"></pre></main></body></html>`;
