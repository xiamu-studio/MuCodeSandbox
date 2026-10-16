import { WEBGPU_OFFSCREEN_PRESENTATION, verifyWebGPUPresentation } from './browser-webgpu-fixture.ts';
import { verifyWorkerCanvasFrames, verifyWorkerLiveProtection } from './browser-webgpu-worker-canvas-fixture.ts';

const runtime = `const instance=crypto.randomUUID();let frames=0,loopError=null,job=null;
const state=()=>({kind:globalThis.constructor.name,instance,...globalThis.__MU_WEBGPU_STATUS__(),frames,loopError,running:job!==null});
async function initialize(canvas){
 if(canvas)globalThis.__MU_GPU_CANVAS__=canvas;
 const presentation=await ${WEBGPU_OFFSCREEN_PRESENTATION};frames=0;loopError=null;
 return {...state(),presentation};
}
async function operate(data){
 if(data.op==='initialize')return initialize(data.canvas);
 if(data.op==='status')return state();
 if(data.op==='start'){
  if(job)throw Error('Drawing loop already active');
  const end=performance.now()+data.durationMs;
  job=(async()=>{try{while(performance.now()<end){await globalThis.__MU_WEBGPU_PRESENT__(frames%2?.2:0);frames++;console.timeStamp('MU_GPU_WORKER:'+globalThis.constructor.name+':'+instance+':'+frames);}}catch(error){loopError=String(error);}finally{job=null;}})();
  return state();
 }
 if(data.op==='old-frame'){
  try{return {...state(),accepted:true,frame:await globalThis.__MU_WEBGPU_PRESENT__(0)};}catch(error){return {...state(),accepted:false,error:String(error)};}
 }
 if(data.op==='recover'){
  const previous=state();if(previous.lost?.reason!=='unknown')throw Error('Native unexpected device loss required');
  if(job)await job;
  globalThis.__MU_WEBGPU_DISPOSE__?.();
  const recovered=await initialize();return {...recovered,previous};
 }
 if(data.op==='frame')return {...state(),result:await globalThis.__MU_WEBGPU_PRESENT__(data.offset)};
 if(data.op==='dispose'){if(job)await job;globalThis.__MU_WEBGPU_DISPOSE__?.();return true;}
 throw Error('Unknown device loss operation');
}
`;
const handler = runtime + `async function handle(data,reply){try{reply(await operate(data));}catch(error){reply({error:String(error)});}}`;
export const DEVICE_LOSS_ASSETS: Record<string, string> = {
  '/gpu-loss-dedicated.js': handler + `self.onmessage=event=>handle(event.data,value=>postMessage(value));`,
  '/gpu-loss-shared.js': handler + `self.onconnect=event=>{const port=event.ports[0];port.onmessage=message=>handle(message.data,value=>port.postMessage(value));port.start();};`,
  '/gpu-loss-service.js': handler + `self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>event.waitUntil((async()=>{await handle(event.data,value=>event.ports[0].postMessage(value));if(job)await job;})()));`,
};

export const DEVICE_LOSS_SETUP = `(async()=>{
 document.body.innerHTML='';document.body.style.cssText='margin:16px;background:white;color:#152329;font:16px sans-serif';
 const section=document.createElement('div');section.style.cssText='display:flex;gap:24px;align-items:start';document.body.append(section);
 const active={},canvases={};let worker,shared,registration;
 ${runtime}
 const request=(name,data,transfer=[])=>name==='page'?operate(data):new Promise((resolve,reject)=>{
  const port=active[name],channel=new MessageChannel();
  const timer=setTimeout(()=>{channel.port1.close();reject(Error(name+' '+data.op+' timeout'));},15000);
  const receiver=channel.port1;
  if(name!=='service')port.onmessage=event=>receiver.onmessage(event);
  receiver.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data.error&&!Object.hasOwn(event.data,'accepted')?reject(Error(event.data.error)):resolve(event.data);};
  receiver.onmessageerror=()=>{clearTimeout(timer);channel.port1.close();reject(Error(name+' message error'));};
  port.postMessage(data,name==='service'?[channel.port2,...transfer]:transfer);
 });
 const rectangle=name=>{const b=canvases[name].getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
 window.__MU_GPU_LOSS_REQUEST__=async(op,extra={})=>{
  const rows=await Promise.all(['page','dedicated','shared','service'].map(async name=>[name,await request(name,{op,...extra})]));
  const values=Object.fromEntries(rows);for(const name of Object.keys(values))if(values[name]&&typeof values[name]==='object')values[name].bounds=rectangle(name);return values;
 };
 window.__MU_GPU_LOSS_CLEANUP__=async()=>{
  await Promise.allSettled(['page','dedicated','shared','service'].map(name=>request(name,{op:'dispose'})));
  worker?.terminate();shared?.port.close();await registration?.unregister();
 };
 try{
  worker=new Worker('/gpu-loss-dedicated.js');active.dedicated=worker;
  shared=new SharedWorker('/gpu-loss-shared.js',{name:'mu-gpu-loss-'+crypto.randomUUID()});active.shared=shared.port;shared.port.start();
  registration=await navigator.serviceWorker.register('/gpu-loss-service.js',{scope:'/mu-gpu-loss/'});
  const deadline=Date.now()+30000;while(!registration.active){if(Date.now()>deadline)throw Error('Device loss ServiceWorker activation timeout');await new Promise(resolve=>setTimeout(resolve,50));}
  active.service=registration.active;
  const result={};for(const name of ['page','dedicated','shared','service']){
   const column=document.createElement('div'),heading=document.createElement('p'),canvas=document.createElement('canvas');heading.textContent=name;
   canvas.width=64;canvas.height=64;canvas.style.cssText='display:block;width:128px;height:128px;image-rendering:pixelated';column.append(heading,canvas);section.append(column);canvases[name]=canvas;
   const controlled=name==='page'?canvas:canvas.transferControlToOffscreen();
   result[name]=await request(name,{op:'initialize',canvas:controlled},name==='page'?[]:[controlled]);result[name].bounds=rectangle(name);
  }
  return result;
 }catch(error){await window.__MU_GPU_LOSS_CLEANUP__();throw error;}
})()`;

export const DEVICE_LOSS_NAMES = ['page', 'dedicated', 'shared', 'service'] as const;
const kinds = { page: 'Window', dedicated: 'DedicatedWorkerGlobalScope', shared: 'SharedWorkerGlobalScope', service: 'ServiceWorkerGlobalScope' };
const uuid = (value: any) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function verifyDeviceLossSetup(value: any): boolean {
  return DEVICE_LOSS_NAMES.every(name => value?.[name]?.kind === kinds[name] && uuid(value[name].instance)
    && uuid(value[name].deviceInstance) && value[name].lost === null && verifyWebGPUPresentation(value[name].presentation));
}
export function verifyDeviceLossRecovery(value: any): boolean {
  if (!verifyDeviceLossSetup(value?.setup) || !verifyDeviceLossSetup(value?.recovered)) return false;
  const before = value.before?.gpu, after = value.after?.gpu;
  if (before?.processCrashCount !== 0 || after?.processCrashCount !== 1 || typeof before.sandboxed !== 'boolean' || after.sandboxed !== before.sandboxed) return false;
  const gpuIds = (snapshot: any) => snapshot.processes?.filter((p: any) => p.type === 'GPU').map((p: any) => p.id);
  const old = gpuIds(value.before), current = gpuIds(value.after);
  if (old?.length !== 1 || current?.length !== 1 || old[0] === current[0] || value.fault?.method !== 'Browser.crashGpuProcess' || value.fault.completed !== true) return false;
  if (!DEVICE_LOSS_NAMES.every(name => {
    const setup = value.setup[name], lost = value.lost?.[name], recovered = value.recovered[name], failed = value.oldFrames?.[name];
    return lost?.kind === setup.kind && lost.instance === setup.instance && lost.deviceInstance === setup.deviceInstance
      && lost.lost?.reason === 'unknown' && typeof lost.lost.message === 'string' && lost.frames >= 2
      && failed?.accepted === false && typeof failed.error === 'string' && failed.deviceInstance === setup.deviceInstance
      && failed.lost?.reason === 'unknown' && recovered.instance === setup.instance && recovered.deviceInstance !== setup.deviceInstance
      && recovered.previous?.deviceInstance === setup.deviceInstance && recovered.previous.lost?.reason === 'unknown';
  })) return false;
  if (!verifyWorkerCanvasFrames(value.frames)) return false;
  const pageFrames = value.frames.map((frame: any) => ({ ...frame, pixels: { dedicated: frame.pixels.page, shared: frame.pixels.page, service: frame.pixels.page },
    replies: { dedicated: frame.replies.page, shared: frame.replies.page, service: frame.replies.page } }));
  return verifyWorkerCanvasFrames(pageFrames) && value.frames.every((frame: any) => DEVICE_LOSS_NAMES.every(name =>
    frame.replies[name].instance === value.setup[name].instance && frame.replies[name].deviceInstance === value.recovered[name].deviceInstance));
}

export function verifyDeviceLossProtection(value: any): boolean {
  if (!Array.isArray(value?.samples) || value.samples.length !== 5 || value.samples.some((s: any) => s.gpu?.processCrashCount !== 1)) return false;
  const live = { ...value, setup: value.recovered, completed: Object.fromEntries(DEVICE_LOSS_NAMES.map(name => [name, { result: { frames: value.finished?.[name]?.frames } }])) };
  if (!verifyWorkerLiveProtection(live, 1)) return false;
  const protectedSnapshot = (snapshot: any) => snapshot?.gpu?.sandboxed === true && snapshot.security?.processes?.length >= 2
    && snapshot.security.processes.every((p: any) => p.uid === snapshot.security.developmentUid && p.seccomp === 2 && p.noNewPrivileges === 1
      && /^0+$/.test(p.effectiveCapabilities) && p.noSandboxFlag === false && (p.role !== 'renderer' || p.separatePidNamespace === true)
      && p.threads?.length > 0 && p.threads.every((t: any) => t.seccomp === 2 && t.noNewPrivileges === 1 && /^0+$/.test(t.effectiveCapabilities)));
  if (!protectedSnapshot(value.before) || !protectedSnapshot(value.after)) return false;
  const nativeGpuIds = (snapshot: any) => snapshot.security.processes.filter((p: any) => p.role === 'gpu-process').map((p: any) => p.pid).sort();
  for (const snapshot of [value.before, value.after]) {
    const cdpIds = snapshot.processes.filter((p: any) => p.type === 'GPU').map((p: any) => p.id).sort();
    if (JSON.stringify(cdpIds) !== JSON.stringify(nativeGpuIds(snapshot))) return false;
  }
  const label = (event: any) => event.args?.data?.message;
  const before = value.markers.find((e: any) => label(e) === 'MU_GPU_CHECK_BEFORE:0');
  const after = value.markers.find((e: any) => label(e) === 'MU_GPU_CHECK_AFTER:4');
  const prefix = 'MU_GPU_WORKER:Window:'+value.recovered.page.instance+':';
  const events = value.markers.filter((e: any) => label(e)?.startsWith(prefix) && e.ts > before.ts && e.ts < after.ts);
  const pageMatched = events.length >= 2 && events.some((e: any) => value.samples.every((sample: any) => sample.security.processes.some((p: any) =>
    p.role === 'renderer' && p.pid === e.pid && p.threads.some((t: any) => t.namespaceIds?.[0] === t.tid && t.namespaceIds.at(-1) === e.tid))));
  return pageMatched && value.samples.every((sample: any) => sample.protection?.active === true && sample.protection.integrity === 'verified'
    && JSON.stringify(nativeGpuIds({ security: sample.security })) === JSON.stringify(nativeGpuIds(value.after)))
    && value.samples.at(-1).after.page.frames > value.samples[0].before.page.frames;
}
