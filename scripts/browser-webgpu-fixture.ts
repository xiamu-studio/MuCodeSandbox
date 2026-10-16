export const WEBGPU_PROBE = `(async()=>{
 const result={secureContext:isSecureContext,apiAvailable:!!navigator.gpu,supported:false};
 if(!result.apiAvailable)return {...result,reason:'navigator.gpu unavailable'};
 const adapter=await navigator.gpu.requestAdapter();
 result.adapterAvailable=!!adapter;
 if(!adapter)return {...result,reason:'No default WebGPU adapter'};
 const info=adapter.info;
 result.adapter={vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter};
 result.features=[...adapter.features].sort();
 const device=await adapter.requestDevice(),resources=[],errors=[];
 device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 let unexpectedLoss=null,disposing=false;
 device.lost.then(info=>{if(!disposing)unexpectedLoss={reason:info.reason,message:info.message};});
 device.pushErrorScope('validation');
 const buffer=descriptor=>{const value=device.createBuffer(descriptor);resources.push(value);return value;};
 const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
 try{
  const input=new Uint32Array([1,2,3,4,5,6,7,8]);
  const storage=buffer({size:input.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
  const readback=buffer({size:input.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const module=device.createShaderModule({code:'@group(0) @binding(0) var<storage,read_write> values:array<u32>; @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>){values[id.x]=values[id.x]*3u+7u;}'});
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:storage}}]});
  device.queue.writeBuffer(storage,0,input);
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(input.length);pass.end();encoder.copyBufferToBuffer(storage,0,readback,0,input.byteLength);device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);result.compute={input:[...input],output:[...new Uint32Array(readback.getMappedRange())]};readback.unmap();
  result.compute.verified=result.compute.output.every((value,index)=>value===input[index]*3+7);
  const shader=device.createShaderModule({code:'struct Out{@builtin(position) position:vec4<f32>}; @vertex fn vertex(@builtin(vertex_index) i:u32)->Out{var points=array<vec2<f32>,3>(vec2<f32>(-0.7,-0.7),vec2<f32>(0.7,-0.7),vec2<f32>(0.0,0.7)); var result:Out;result.position=vec4<f32>(points[i],0.0,1.0);return result;} @fragment fn fragment()->@location(0) vec4<f32>{return vec4<f32>(0.0,1.0,0.0,1.0);}'});
  const renderPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:shader,entryPoint:'vertex'},fragment:{module:shader,entryPoint:'fragment',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list'}});
  const render=async draw=>{
   const texture=device.createTexture({size:[64,64],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});resources.push(texture);
   const pixels=buffer({size:64*256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const commands=device.createCommandEncoder(),renderPass=commands.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:{r:1,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
   if(draw){renderPass.setPipeline(renderPipeline);renderPass.draw(3);}renderPass.end();
   commands.copyTextureToBuffer({texture},{buffer:pixels,bytesPerRow:256},[64,64]);device.queue.submit([commands.finish()]);await pixels.mapAsync(GPUMapMode.READ);
   const bytes=new Uint8Array(pixels.getMappedRange()).slice();pixels.unmap();let green=0,red=0;
   for(let i=0;i<bytes.length;i+=4){if(bytes[i]===0&&bytes[i+1]===255&&bytes[i+2]===0&&bytes[i+3]===255)green++;if(bytes[i]===255&&bytes[i+1]===0&&bytes[i+2]===0&&bytes[i+3]===255)red++;}
   return {hash:await hash(bytes),green,red};
  };
  const first=await render(true),repeated=await render(true),changed=await render(false);
  result.render={first,repeated,changed,verified:first.green>500&&first.red>500&&first.hash===repeated.hash&&first.hash!==changed.hash&&changed.green===0&&changed.red===4096};
  await device.queue.onSubmittedWorkDone();
  const validation=await device.popErrorScope();if(validation)errors.push(validation.message);
  result.errors=errors;result.unexpectedLoss=unexpectedLoss;
  result.supported=result.compute.verified&&result.render.verified&&errors.length===0&&!unexpectedLoss;
  return result;
 }finally{disposing=true;for(const resource of resources)resource.destroy();device.destroy();}
})()`;

export const WEBGPU_CONTEXTS = `(async()=>{
 const page=await ${WEBGPU_PROBE};
 const source='self.onmessage=async()=>{try{self.postMessage({result:await '+${JSON.stringify(WEBGPU_PROBE)}+'});}catch(error){self.postMessage({error:String(error)});}};';
 const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
 const worker=await new Promise((resolve,reject)=>{
  const task=new Worker(url),timer=setTimeout(()=>{task.terminate();reject(Error('WebGPU Worker timeout'));},30000);
  task.onmessage=event=>{clearTimeout(timer);task.terminate();resolve(event.data);};
  task.onerror=event=>{clearTimeout(timer);task.terminate();reject(Error(event.message));};task.postMessage(null);
 }).finally(()=>URL.revokeObjectURL(url));
 return {page,worker};
})()`;

export function verifyWebGPUContexts(value: any): boolean {
  const contexts = [value?.page, value?.worker?.result];
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const adapterKeys = ['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'];
  return !value?.worker?.error && contexts.every(context => {
    const compute = context?.compute, render = context?.render;
    return context?.supported === true && context.secureContext === true && context.apiAvailable === true && context.adapterAvailable === true
      && adapterKeys.slice(0, 4).every(key => typeof context.adapter?.[key] === 'string') && typeof context.adapter?.isFallbackAdapter === 'boolean'
      && Array.isArray(context.features) && context.features.every((feature: unknown) => typeof feature === 'string')
      && compute?.verified === true && JSON.stringify(compute.input) === '[1,2,3,4,5,6,7,8]' && JSON.stringify(compute.output) === '[10,13,16,19,22,25,28,31]'
      && render?.verified === true && hash(render.first?.hash) && render.first.hash === render.repeated?.hash && hash(render.changed?.hash) && render.first.hash !== render.changed.hash
      && render.first.green > 500 && render.first.red > 500 && render.first.green + render.first.red === 4096
      && render.repeated.green === render.first.green && render.repeated.red === render.first.red && render.changed.green === 0 && render.changed.red === 4096
      && Array.isArray(context.errors) && context.errors.length === 0 && context.unexpectedLoss === null;
  })
    && contexts[0].render.first.hash === contexts[1].render.first.hash
    && adapterKeys.every(key => contexts[0].adapter[key] === contexts[1].adapter[key])
    && JSON.stringify([...contexts[0].features].sort()) === JSON.stringify([...contexts[1].features].sort());
}

function canvasPresentation(worker: boolean) { return `(async()=>{
 const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No presentation adapter');
 const device=await adapter.requestDevice(),canvas=${worker ? 'globalThis.__MU_GPU_CANVAS__' : "document.createElement('canvas')"};
 if(!canvas)throw Error('No transferred canvas');canvas.width=64;canvas.height=64;
 ${worker ? '' : "canvas.style.cssText='display:block;width:256px;height:256px;image-rendering:pixelated';const heading=document.createElement('h2');heading.textContent='WebGPU';document.body.append(heading,canvas);"}
 const frameWait=()=>new Promise(resolve=>${worker ? 'setTimeout(resolve,20)' : 'requestAnimationFrame(resolve)'});
 const context=canvas.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();
 if(!context)throw Error('WebGPU canvas context unavailable');
 context.configure({device,format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC,alphaMode:'opaque'});
 const errors=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 let lost=null;device.lost.then(info=>{lost={reason:info.reason,message:info.message};});
 const deviceInstance=crypto.randomUUID();
 globalThis.__MU_WEBGPU_STATUS__=()=>({deviceInstance,lost,errors:[...errors]});
 const module=device.createShaderModule({code:'struct Out{@builtin(position) position:vec4<f32>}; @group(0) @binding(0) var<uniform> offset:f32; @vertex fn vertex(@builtin(vertex_index) i:u32)->Out{var points=array<vec2<f32>,3>(vec2<f32>(-0.5,-0.6),vec2<f32>(0.5,-0.6),vec2<f32>(0.0,0.6));var result:Out;result.position=vec4<f32>(points[i]+vec2<f32>(offset,0.0),0.0,1.0);return result;} @fragment fn fragment()->@location(0) vec4<f32>{return vec4<f32>(0.0,1.0,0.0,1.0);}'});
 const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]},primitive:{topology:'triangle-list'}});
 const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
 const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
 const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
 globalThis.__MU_WEBGPU_PRESENT__=async offset=>{
  await frameWait();device.pushErrorScope('validation');
  device.queue.writeBuffer(uniform,0,new Float32Array([offset,0,0,0]));
  const texture=context.getCurrentTexture(),pixels=device.createBuffer({size:64*256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:{r:1,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
  pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.draw(3);pass.end();encoder.copyTextureToBuffer({texture},{buffer:pixels,bytesPerRow:256},[64,64]);device.queue.submit([encoder.finish()]);
  await pixels.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(pixels.getMappedRange()).slice();pixels.unmap();pixels.destroy();
  let green=0,red=0;for(let i=0;i<bytes.length;i+=4){const r=format==='bgra8unorm'?bytes[i+2]:bytes[i],b=format==='bgra8unorm'?bytes[i]:bytes[i+2];if(r===0&&bytes[i+1]===255&&b===0&&bytes[i+3]===255)green++;if(r===255&&bytes[i+1]===0&&b===0&&bytes[i+3]===255)red++;}
  const validation=await device.popErrorScope();if(validation)errors.push(validation.message);
  await frameWait();await frameWait();
  const bounds=canvas.getBoundingClientRect?.()??{x:0,y:0,width:canvas.width,height:canvas.height};return {offset,format,hash:await hash(bytes),green,red,errors:[...errors],lost,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}};
 };
 globalThis.__MU_WEBGPU_DISPOSE__=()=>{context.unconfigure();uniform.destroy();device.destroy();};
 canvas.scrollIntoView?.({block:'nearest'});
 const first=await globalThis.__MU_WEBGPU_PRESENT__(0),repeated=await globalThis.__MU_WEBGPU_PRESENT__(0),moved=await globalThis.__MU_WEBGPU_PRESENT__(.2);
 return {first,repeated,moved};
})()`; }

export const WEBGPU_PRESENTATION = canvasPresentation(false);
export const WEBGPU_OFFSCREEN_PRESENTATION = canvasPresentation(true);

export function verifyWebGPUPresentation(value: any): boolean {
  const { first, repeated, moved } = value ?? {};
  return [first, repeated, moved].every(frame => frame && /^[a-f0-9]{64}$/.test(frame.hash)
    && frame.green > 300 && frame.red > 1000 && frame.green + frame.red === 4096
    && frame.errors?.length === 0 && frame.lost === null)
    && first.hash === repeated.hash && first.hash !== moved.hash;
}
