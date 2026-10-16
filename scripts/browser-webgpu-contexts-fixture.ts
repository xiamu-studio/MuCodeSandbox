import { WEBGPU_PROBE, verifyWebGPUContexts } from './browser-webgpu-fixture.ts';

const measured = `({result:await ${WEBGPU_PROBE},kind:self.constructor.name,instance})`;
export const WEBGPU_WORKER_ASSETS: Record<string, string> = {
  '/webgpu-dedicated.js': `const instance=crypto.randomUUID();self.onmessage=async()=>{try{postMessage(${measured});}catch(error){postMessage({error:String(error)});}};`,
  '/webgpu-shared.js': `const instance=crypto.randomUUID();self.onconnect=event=>{const port=event.ports[0];port.onmessage=async()=>{try{port.postMessage(${measured});}catch(error){port.postMessage({error:String(error)});}};port.start();};`,
  '/webgpu-service.js': `const instance=crypto.randomUUID();self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>event.waitUntil((async()=>{try{event.ports[0].postMessage(${measured});}catch(error){event.ports[0].postMessage({error:String(error)});}})()));`,
};

export const WEBGPU_ALL_CONTEXTS = `(async()=>{
 const page=await ${WEBGPU_PROBE};
 const request=async(port,label)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(label+' timeout')),30000);
  port.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
  port.onmessageerror=()=>{clearTimeout(timer);reject(Error(label+' message error'));};
  port.start?.();port.postMessage(null);
 });
 const worker=new Worker('/webgpu-dedicated.js');
 let shared,second,registration;
 try{
  const dedicated=await request(worker,'DedicatedWorker');
  const workerName='mu-webgpu-'+crypto.randomUUID();
  shared=new SharedWorker('/webgpu-shared.js',{name:workerName});
  second=new SharedWorker('/webgpu-shared.js',{name:workerName});
  const sharedResult=await request(shared.port,'SharedWorker');
  const sharedSecond=await request(second.port,'SharedWorker second connection');
  registration=await navigator.serviceWorker.register('/webgpu-service.js',{scope:'/mu-webgpu/'});
  const deadline=Date.now()+30000;
  while(!registration.active){if(Date.now()>deadline)throw Error('ServiceWorker activation timeout');await new Promise(resolve=>setTimeout(resolve,50));}
  const channel=new MessageChannel();
  const service=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{channel.port1.close();reject(Error('ServiceWorker GPU timeout'));},30000);
   channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};
   channel.port1.onmessageerror=()=>{clearTimeout(timer);channel.port1.close();reject(Error('ServiceWorker message error'));};
   registration.active.postMessage(null,[channel.port2]);
  });
  return {page,worker:dedicated,shared:sharedResult,sharedSecond,service};
 }finally{worker.terminate();shared?.port.close();second?.port.close();await registration?.unregister();}
})()`;

export function verifyWebGPUAllContexts(value: any): boolean {
  return verifyWebGPUContexts(value)
    && value.worker?.kind === 'DedicatedWorkerGlobalScope'
    && ['shared', 'sharedSecond', 'service'].every(key => verifyWebGPUContexts({ page: value.page, worker: value[key] }))
    && value.shared.kind === 'SharedWorkerGlobalScope' && value.sharedSecond.kind === 'SharedWorkerGlobalScope'
    && value.service.kind === 'ServiceWorkerGlobalScope'
    && [value.worker, value.shared, value.sharedSecond, value.service].every(context => typeof context.instance === 'string' && /^[a-f0-9-]{36}$/.test(context.instance))
    && value.shared.instance === value.sharedSecond.instance;
}
