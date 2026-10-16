export const MEDIA_FEATURES = `const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
const canvas=(width,height)=>{const c=typeof document==='undefined'?new OffscreenCanvas(width,height):document.createElement('canvas');c.width=width;c.height=height;return c;};
async function webFont(){
 const family='MuAsync_'+crypto.randomUUID().replaceAll('-','');
 const c=canvas(600,80),ctx=c.getContext('2d'),sample='iii WWW MuCodeSandbox 123 ABC';
 if(!ctx)throw Error('Font Canvas unavailable');
 const render=async(name=family)=>{ctx.fillStyle='#ffffff';ctx.fillRect(0,0,c.width,c.height);ctx.font='24px "'+name+'", monospace';ctx.fillStyle='#152329';ctx.fillText(sample,10,40);return {width:ctx.measureText(sample).width,hash:await digest(ctx.getImageData(0,0,c.width,c.height).data)};};
 const before=await render(),set=typeof document==='undefined'?self.fonts:document.fonts;
 if(!set||typeof FontFace==='undefined')throw Error('Font loading API unavailable');
 const face=new FontFace(family,'url(/font.ttf?run='+crypto.randomUUID()+')');
 const initialStatus=face.status;set.add(face);
 const started=performance.now(),loading=face.load(),loadingStatus=face.status;
 await loading;
 const elapsedMs=performance.now()-started,late=await render();
 const preparedFamily=family+'Prepared',prepared=new FontFace(preparedFamily,'url(/font.ttf?run='+crypto.randomUUID()+')');
 await prepared.load();set.add(prepared);const after=await render(preparedFamily);
 const missing=new FontFace('MuMissing_'+crypto.randomUUID().replaceAll('-',''),'url(/font-missing.ttf)');
 let missingRejected=false;try{await missing.load();}catch{missingRejected=true;}
 const negative=await render(preparedFamily);
 if(typeof document!=='undefined'){
  const span=document.createElement('p');span.id='web-font-sample';span.style.fontFamily='"'+preparedFamily+'", monospace';span.textContent=sample;document.body.append(span);
 }
 return {family,preparedFamily,initialStatus,loadingStatus,loadedStatus:face.status,preparedStatus:prepared.status,elapsedMs,before,late,after,negative,missingRejected,missingStatus:missing.status};
}
async function audio(frequency){
 if(typeof OfflineAudioContext==='undefined')return {supported:false};
 const context=new OfflineAudioContext(1,4096,44100),oscillator=context.createOscillator(),compressor=context.createDynamicsCompressor();
 oscillator.type='triangle';oscillator.frequency.value=frequency;
 compressor.threshold.value=-50;compressor.knee.value=40;compressor.ratio.value=12;compressor.attack.value=0;compressor.release.value=.25;
 oscillator.connect(compressor);compressor.connect(context.destination);oscillator.start();
 const buffer=await context.startRendering(),samples=buffer.getChannelData(0);
 let peak=0,energy=0,nonzero=0;for(const sample of samples){if(!Number.isFinite(sample))throw Error('Invalid audio sample');peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;if(sample!==0)nonzero++;}
 return {supported:true,sampleRate:buffer.sampleRate,length:buffer.length,channels:buffer.numberOfChannels,hash:await digest(samples),peak,energy,nonzero};
}
function webgl(){
 const c=canvas(16,16);let creationError=null;
 c.addEventListener('webglcontextcreationerror',event=>{creationError=event.statusMessage;});
 const gl=c.getContext('webgl');
 if(!gl)return {supported:false,creationError};
 gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
 const extension=gl.getExtension('WEBGL_debug_renderer_info');
 const result={supported:true,pixel:[...pixel],error:gl.getError(),vendor:gl.getParameter(extension?extension.UNMASKED_VENDOR_WEBGL:gl.VENDOR),renderer:gl.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};
 gl.getExtension('WEBGL_lose_context')?.loseContext();return result;
}
export async function media(){
 const font=await webFont();
 const first=await audio(1000),repeated=await audio(1000),changed=await audio(1100);
 return {font,audio:{first,repeated,changed},webgl:webgl()};
}`;

export const BROWSER_PROCESS_INSPECTION = `import pathlib,json,pwd,shlex
rows=[]
initial=pathlib.Path('/proc/1/ns/pid').readlink().as_posix()
for process in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  if process.joinpath('exe').readlink().name!='chrome':continue
  args=[part.decode() for part in process.joinpath('cmdline').read_bytes().split(bytes([0])) if part]
  # Chromium rewrites argv into a single process-title field on Linux.
  if len(args)==1:args=shlex.split(args[0])
  role=next((value.split('=',1)[1] for value in args if value.startswith('--type=')),'browser')
  if role not in ('renderer','gpu-process'):continue
  status=dict(line.split(':',1) for line in process.joinpath('status').read_text().splitlines() if ':' in line)
  threads=[]
  for thread in process.joinpath('task').glob('[0-9]*'):
   try:
    values=dict(line.split(':',1) for line in thread.joinpath('status').read_text().splitlines() if ':' in line)
    threads.append(dict(tid=int(thread.name),seccomp=int(values['Seccomp']),noNewPrivileges=int(values['NoNewPrivs']),effectiveCapabilities=values['CapEff'].strip()))
   except (FileNotFoundError,ProcessLookupError):pass
  rows.append(dict(pid=int(process.name),role=role,uid=int(status['Uid'].split()[0]),seccomp=int(status['Seccomp']),noNewPrivileges=int(status['NoNewPrivs']),effectiveCapabilities=status['CapEff'].strip(),separatePidNamespace=process.joinpath('ns/pid').readlink().as_posix()!=initial,noSandboxFlag='--no-sandbox' in args,threads=threads))
 except (FileNotFoundError,ProcessLookupError):pass
print(json.dumps(dict(developmentUid=pwd.getpwnam('dev').pw_uid,processes=rows)))
`;
