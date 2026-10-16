import { WEBGPU_OFFSCREEN_PRESENTATION, verifyWebGPUPresentation } from './browser-webgpu-fixture.ts';
import { BROWSER_PROCESS_INSPECTION } from './browser-media-fixture.ts';

// Tracing uses namespace TIDs while /proc is read from the management namespace.
export const WORKER_PROCESS_INSPECTION = `import contextlib,io,json,pathlib
output=io.StringIO()
with contextlib.redirect_stdout(output):exec(compile(${JSON.stringify(BROWSER_PROCESS_INSPECTION)},'native-browser-inspection','exec'))
data=json.loads(output.getvalue())
for process in data['processes']:
 for thread in process['threads']:
  try:
   values=dict(line.split(':',1) for line in pathlib.Path('/proc',str(process['pid']),'task',str(thread['tid']),'status').read_text().splitlines() if ':' in line)
   thread['namespaceIds']=[int(value) for value in values['NSpid'].split()]
  except (FileNotFoundError,ProcessLookupError):thread['namespaceIds']=[]
print(json.dumps(data))
`;

const handler = `const instance=crypto.randomUUID();let running=false;
async function handle(data,reply){
 try{
  const kind=self.constructor.name;
  if(data.op==='initialize'){
   globalThis.__MU_GPU_CANVAS__=data.canvas;
   const presentation=await ${WEBGPU_OFFSCREEN_PRESENTATION};
   reply({result:presentation,kind,instance,operation:data.op});
  }else if(data.op==='frame'){
   reply({result:await globalThis.__MU_WEBGPU_PRESENT__(data.offset),kind,instance,operation:data.op});
  }else if(data.op==='work'){
   const end=performance.now()+data.durationMs;let frames=0;running=true;
   while(running&&performance.now()<end){
    await globalThis.__MU_WEBGPU_PRESENT__(frames % 2 ? .2 : 0);frames++;
    console.timeStamp('MU_GPU_WORKER:'+kind+':'+instance+':'+frames);
    reply({progress:true,kind,instance,frames});
   }
   running=false;reply({result:{frames},kind,instance,operation:data.op});
  }else if(data.op==='dispose'){running=false;globalThis.__MU_WEBGPU_DISPOSE__?.();reply({result:true,kind,instance,operation:data.op});}
 }catch(error){reply({error:String(error),operation:data.op});}
}
`;
export const WORKER_CANVAS_ASSETS: Record<string, string> = {
  '/gpu-canvas-dedicated.js': handler + `self.onmessage=event=>handle(event.data,value=>postMessage(value));`,
  '/gpu-canvas-shared.js': handler + `self.onconnect=event=>{const port=event.ports[0];port.onmessage=message=>handle(message.data,value=>port.postMessage(value));port.start();};`,
  '/gpu-canvas-service.js': handler + `self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>event.waitUntil(handle(event.data,value=>event.ports[0].postMessage(value))));`,
};

export const WORKER_CANVAS_SETUP = `(async()=>{
 document.body.innerHTML='';document.body.style.cssText='margin:16px;background:white;color:#152329;font:16px sans-serif';
 const section=document.createElement('div');section.style.cssText='display:flex;gap:24px;align-items:start';document.body.append(section);
 const active={},canvases={},progress=window.__MU_GPU_WORKER_PROGRESS__={},instances={};
 let worker,shared,registration;
 const request=(name,data,transfer=[])=>new Promise((resolve,reject)=>{
  const connection=active[name],port=connection.port,channel=connection.service?new MessageChannel():null,receiver=channel?.port1??port;
  const timer=setTimeout(()=>{channel?.port1.close();reject(Error(name+' '+data.op+' timeout'));},45000);
  receiver.onmessage=event=>{
   if(event.data.progress){progress[name]=event.data;return;}
   clearTimeout(timer);channel?.port1.close();event.data.error?reject(Error(event.data.error)):resolve(event.data);
  };
  receiver.onmessageerror=()=>{clearTimeout(timer);channel?.port1.close();reject(Error(name+' message error'));};
  receiver.start?.();port.postMessage(data,channel?[channel.port2,...transfer]:transfer);
 });
 const rectangle=name=>{const b=canvases[name].getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
 window.__MU_GPU_WORKER_FRAME__=async offset=>{
  const result={};for(const name of Object.keys(active)){result[name]=await request(name,{op:'frame',offset});result[name].bounds=rectangle(name);}
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return result;
 };
 window.__MU_GPU_WORKER_WORK__=async durationMs=>{
  const results=await Promise.all(Object.keys(active).map(async name=>[name,await request(name,{op:'work',durationMs})]));return Object.fromEntries(results);
 };
 window.__MU_GPU_WORKER_CLEANUP__=async()=>{
  await Promise.allSettled(Object.keys(active).map(name=>request(name,{op:'dispose'})));
  worker?.terminate();shared?.port.close();await registration?.unregister();
 };
 try{
  worker=new Worker('/gpu-canvas-dedicated.js');active.dedicated={port:worker};
  shared=new SharedWorker('/gpu-canvas-shared.js',{name:'mu-gpu-canvas-'+crypto.randomUUID()});active.shared={port:shared.port};
  registration=await navigator.serviceWorker.register('/gpu-canvas-service.js',{scope:'/mu-gpu-canvas/'});
  const end=Date.now()+30000;while(!registration.active){if(Date.now()>end)throw Error('Canvas ServiceWorker activation timeout');await new Promise(resolve=>setTimeout(resolve,50));}
  active.service={port:registration.active,service:true};
  const result={};for(const name of Object.keys(active)){
   const column=document.createElement('div'),heading=document.createElement('p'),canvas=document.createElement('canvas');heading.textContent=name;
   canvas.width=64;canvas.height=64;canvas.style.cssText='display:block;width:128px;height:128px;image-rendering:pixelated';
   column.append(heading,canvas);section.append(column);canvases[name]=canvas;
   const offscreen=canvas.transferControlToOffscreen();result[name]=await request(name,{op:'initialize',canvas:offscreen},[offscreen]);
   result[name].bounds=rectangle(name);instances[name]=result[name].instance;
  }
  window.__MU_GPU_WORKER_INSTANCES__=instances;
  return result;
 }catch(error){await window.__MU_GPU_WORKER_CLEANUP__();throw error;}
})()`;

export function verifyWorkerCanvasSetup(value: any): boolean {
  const kinds: Record<string, string> = { dedicated: 'DedicatedWorkerGlobalScope', shared: 'SharedWorkerGlobalScope', service: 'ServiceWorkerGlobalScope' };
  return Object.entries(kinds).every(([name, kind]) => value?.[name]?.kind === kind
    && typeof value[name].instance === 'string' && /^[a-f0-9-]{36}$/.test(value[name].instance)
    && verifyWebGPUPresentation(value[name].result));
}

export function workerCanvasPixels(encoded: string, bounds: Record<string, any>) {
  return `(async()=>{
 const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),v=>v.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
 const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
 const scale=canvas.width/innerWidth,results={};
 for(const [name,b] of Object.entries(${JSON.stringify(bounds)})){
  const x=Math.round(b.x*scale),y=Math.round(b.y*scale),width=Math.round(b.width*scale),height=Math.round(b.height*scale);
  if(!(x>=0&&y>=0&&width>0&&height>0&&x+width<=canvas.width&&y+height<=canvas.height))throw Error('Worker canvas outside screenshot');
  const data=context.getImageData(x,y,width,height).data;let green=0,red=0;
  for(let i=0;i<data.length;i+=4){if(data[i]===0&&data[i+1]===255&&data[i+2]===0&&data[i+3]===255)green++;if(data[i]===255&&data[i+1]===0&&data[i+2]===0&&data[i+3]===255)red++;}
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
  results[name]={green,red,pixels:data.length/4,scale,hash};
 }
 return results;
})()`;
}

export function verifyWorkerCanvasFrames(frames: any): boolean {
  const names = ['dedicated', 'shared', 'service'];
  return Array.isArray(frames) && frames.length === 2 && frames[0].offset === 0 && frames[1].offset === .2
    && names.every(name => frames.every(frame => {
      const pixel = frame.pixels?.[name], reply = frame.replies?.[name];
      return pixel?.green > 1000 && pixel.red > 1000 && pixel.green + pixel.red === pixel.pixels
        && /^[a-f0-9]{64}$/.test(pixel.hash) && /^[a-f0-9]{64}$/.test(reply?.result?.hash)
        && reply.result.errors?.length === 0 && reply.result.lost === null
        && Math.abs(pixel.green / pixel.pixels - reply.result.green / 4096) < .01;
    }) && frames[0].pixels[name].hash !== frames[1].pixels[name].hash
      && frames[0].replies[name].result.hash !== frames[1].replies[name].result.hash);
}

export function verifyWorkerLiveProtection(value: any, expectedGpuCrashes = 0): boolean {
  if (!Array.isArray(value?.samples) || value.samples.length < 5 || !Array.isArray(value.markers)) return false;
  const protectedProcess = (p: any, uid: number) => p.uid === uid && p.seccomp === 2 && p.noNewPrivileges === 1
    && /^0+$/.test(p.effectiveCapabilities) && p.noSandboxFlag === false && (p.role !== 'renderer' || p.separatePidNamespace)
    && p.threads?.length > 0 && p.threads.every((t: any) => t.seccomp === 2 && t.noNewPrivileges === 1 && /^0+$/.test(t.effectiveCapabilities));
  const first = value.samples[0], last = value.samples.at(-1);
  const label = (event: any) => event.args?.data?.message;
  const before = value.markers.find((e: any) => label(e) === 'MU_GPU_CHECK_BEFORE:0');
  const after = value.markers.find((e: any) => label(e) === `MU_GPU_CHECK_AFTER:${value.samples.length - 1}`);
  if (!before || !after || !(before.ts < after.ts)) return false;
  const workerThreads = new Set<string>();
  return value.samples.every((sample: any) => sample.security?.processes?.length >= 2 && sample.gpu?.sandboxed === true && sample.gpu.processCrashCount === expectedGpuCrashes
    && sample.security.processes.every((p: any) => protectedProcess(p, sample.security.developmentUid)))
    && ['dedicated', 'shared', 'service'].every(name => {
      const observed = value.setup?.[name], prefix = `MU_GPU_WORKER:${observed?.kind}:${observed?.instance}:`;
      const events = value.markers.filter((e: any) => e.name === 'TimeStamp' && label(e)?.startsWith(prefix) && e.ts > before.ts && e.ts < after.ts);
      if (events.length < 2 || first.before?.[name]?.instance !== observed?.instance || last.after?.[name]?.instance !== observed?.instance
        || !(last.after[name].frames > first.before[name].frames) || !(value.completed?.[name]?.result?.frames >= last.after[name].frames)) return false;
      const matches = (thread: any, tid: number) => Array.isArray(thread.namespaceIds)
        ? thread.namespaceIds.length > 0 && thread.namespaceIds[0] === thread.tid && thread.namespaceIds.at(-1) === tid
        : thread.tid === tid;
      const matched = events.find((event: any) => value.samples.every((sample: any) => sample.security.processes.some((p: any) => p.pid === event.pid && p.role === 'renderer' && p.threads.some((t: any) => matches(t, event.tid)))));
      if (!matched) return false;
      workerThreads.add(`${matched.pid}:${matched.tid}`);return true;
    }) && workerThreads.size === 3;
}
