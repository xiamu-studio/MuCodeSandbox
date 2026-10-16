/** Current, read-only device facts for the supplied 35-item review; no spoofing or settings changes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cpus,totalmem} from 'node:os';
import {DevTools} from '../server/guest-browser.ts';
const exec=promisify(execFile),data='/Users/staff/.mucodesandbox',id='ee85e6f8-043b-4d02-be6e-7a0683c4bde8',instance='mu-ee85e6f8043b4d02';
const info=JSON.parse(await readFile(data+'/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
async function get(route:string){const r=await fetch(info.url+route,{headers});if(!r.ok)throw new Error('Read-only query failed: '+r.status);return r.json();}
const snapshot=await get('/api/snapshot'),env=snapshot.environments.find((e:any)=>e.id===id);
assert.ok(env?.state==='running'&&env.browserRunning);
const observations=await get(`/api/environments/${id}/network/observations`);
const guestCode=String.raw`import pathlib,json,os,hashlib,subprocess,shutil
def read(p):
 try:return pathlib.Path(p).read_text().strip()
 except (FileNotFoundError,PermissionError):return None
def query(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=8);return p.stdout.strip() if p.returncode==0 else None
font=query(['fc-list','--format=%{family}\n']) or ''
mounts=[]
for line in (read('/proc/self/mountinfo') or '').splitlines():
 parts=line.split();sep=parts.index('-');kind=parts[sep+1]
 if kind in ['virtiofs','9p','vboxsf','fuse.sshfs']:mounts.append(kind)
network=[]
for d in pathlib.Path('/sys/class/net').iterdir():
 driver=d/'device/driver';mac=read(d/'address') or ''
 network.append({'name':d.name,'driver':driver.resolve().name if driver.exists() else None,'locallyAdministeredMac':bool(mac and int(mac.split(':')[0],16)&2)})
implementers=sorted({l.split(':',1)[1].strip() for l in (read('/proc/cpuinfo') or '').splitlines() if l.startswith('CPU implementer')})
disk=[]
for d in pathlib.Path('/sys/class/block').iterdir():
 if d.name.startswith(('vd','sd','nvme')):
  driver=d/'device/driver';disk.append({'name':d.name,'driver':driver.resolve().name if driver.exists() else None})
print(json.dumps({'unameMachine':os.uname().machine,'hostname':os.uname().nodename,'hostnameFile':read('/etc/hostname'),
 'machineIdSHA256':hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes()).hexdigest(),
 'virtualization':query(['systemd-detect-virt','--vm']),'dmiProduct':read('/sys/class/dmi/id/product_name'),
 'cpuImplementers':implementers,'networkDrivers':network,'diskDrivers':disk,'sharedMountTypes':mounts,
 'fonts':sorted({part.strip() for line in font.splitlines() for part in line.split(',') if part.strip()}),
 'audioPrograms':{n:shutil.which(n) is not None for n in ['pulseaudio','pipewire','pactl']},
 'soundDevicesPresent':pathlib.Path('/dev/snd').exists(),'videoDeviceCount':len(list(pathlib.Path('/dev').glob('video*'))),
 'powerSupplies':[p.name for p in pathlib.Path('/sys/class/power_supply').iterdir()],
 'productionClaudeInstalled':pathlib.Path('/home/dev/.local/bin/claude').exists()}))`;
const guest=JSON.parse((await exec(data+'/tools/lima/bin/limactl',['shell',instance,'sudo','python3','-c',guestCode],
 {env:{...process.env,LIMA_HOME:data+'/lima'},timeout:20000,maxBuffer:1024*1024})).stdout);
const processLines=(await exec('/bin/ps',['-ax','-o','command='],{maxBuffer:2*1024*1024})).stdout.split('\n');
const paths=processLines.filter(l=>l.includes(data+'/lima/'+instance+'/ssh.config')&&l.includes('/usr/bin/ssh '))
 .map(l=>l.match(/-L\s+(\/tmp\/mu-view-[^\s:]+\/cdp\.sock):127\.0\.0\.1:9222\b/)?.[1]).filter(Boolean);
assert.equal(paths.length,1);
const tools=await DevTools.open(paths[0]!);let observed:any;
try{
 const target=(await tools.send('Target.getTargets')).targetInfos.find((t:any)=>t.type==='page');assert.ok(target);
 const {sessionId}=await tools.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 try{
  const frame=(await tools.send('Page.getFrameTree',{},sessionId)).frameTree.frame.id;
  const {executionContextId}=await tools.send('Page.createIsolatedWorld',{frameId:frame,worldName:'MuDeviceReview'},sessionId);
  const expression=`(async()=>{
   const out={secureContext:isSecureContext,webdriver:navigator.webdriver,language:navigator.language,languages:[...navigator.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory,maxTouchPoints:navigator.maxTouchPoints,
    screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,dpr:devicePixelRatio,outerWidth,outerHeight,innerWidth,innerHeight}};
   const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl');out.webgl=gl?{available:true,renderer:gl.getParameter(gl.RENDERER),vendor:gl.getParameter(gl.VENDOR)}:{available:false};
   const ext=gl?.getExtension('WEBGL_debug_renderer_info');if(ext)Object.assign(out.webgl,{unmaskedRenderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),unmaskedVendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)});
   if(navigator.gpu){const a=await navigator.gpu.requestAdapter();out.webgpu={apiAvailable:true,adapterReturned:!!a,...(a?{fallback:a.isFallbackAdapter,info:{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description}}:{})};}else out.webgpu={apiAvailable:false};
   const perms={};for(const name of ['camera','microphone'])try{perms[name]=(await navigator.permissions.query({name})).state;}catch(e){perms[name]='unavailable';}out.mediaPermissions=perms;
   try{const ds=await navigator.mediaDevices.enumerateDevices();out.mediaDeviceKinds=ds.map(d=>d.kind);}catch(e){out.mediaEnumerationError=e.name;}
   try{const c=new AudioContext();out.audioContext={sampleRate:c.sampleRate,state:c.state};await c.close();}catch(e){out.audioContextError=e.name;}
   return out;
  })()`;
  const result=await tools.send('Runtime.evaluate',{expression,contextId:executionContextId,awaitPromise:true,returnByValue:true,userGesture:false},sessionId);
  if(result.exceptionDetails)throw new Error('Device query exception');observed=result.result.value;
 }finally{await tools.send('Target.detachFromTarget',{sessionId}).catch(()=>{});}
}finally{tools.close();}
const protection=await get(`/api/environments/${id}/network/protection`);
const report={checkedAt:new Date().toISOString(),app:{version:snapshot.system.version,buildId:snapshot.system.application?.buildId},
 hostCapacity:{cpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3)},
 environment:{id,cpus:env.cpus,memoryGiB:env.memoryGiB,identity:env.identity,egressLockEnabled:!!env.network.egressLock,networkMode:env.network.mode,strict:env.network.strict,transparent:env.network.transparent},
 guest,observed,observations,protection,
 scope:'Read-only OS and current browser capability samples. No permission prompts, audio playback, model requests, credential reads, traffic capture, navigation, routing/settings change, or browser replacement. WebGPU adapter was queried without allocating a GPU device. Media device enumeration may be limited by permissions.'};
await mkdir('test-results/device-signal-review',{recursive:true,mode:0o700});
await writeFile('test-results/device-signal-review/current.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({checkedAt:report.checkedAt,hostCapacity:report.hostCapacity,environment:report.environment,
 guest:{virtualization:guest.virtualization,dmiProduct:guest.dmiProduct,cpuImplementers:guest.cpuImplementers,networkDrivers:guest.networkDrivers,diskDrivers:guest.diskDrivers,sharedMountTypes:guest.sharedMountTypes,fontFamilyCount:guest.fonts.length,audioPrograms:guest.audioPrograms,soundDevicesPresent:guest.soundDevicesPresent,videoDeviceCount:guest.videoDeviceCount,powerSupplies:guest.powerSupplies},observed,protection:{active:protection.active,integrity:protection.integrity,leaseActive:protection.leaseActive}},null,2));
