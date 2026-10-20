import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { HyperVRuntime, AMD64_TUNNEL, fileHash } from '../server/platform/windows/runtime.ts';
import { windowsConfigSchema, vmIdentity } from '../server/platform/windows/config.ts';
import { packageProxy } from './windows/package-proxy.ts';

// Builds a new, empty lab base. It never reads an existing user environment,
// imports accounts, opens a browser, or contacts a model service.
async function main(){
  if(process.platform!=='win32')throw Error('Windows is required');
  const [image,sha256,resumeFlag,resumePath]=process.argv.slice(2);
  if(!image||!sha256)throw Error('Usage: npm run windows:build-base -- <Canonical VHD> <SHA-256>');
  const root=process.env.MU_WINDOWS_DATA_DIR??path.join(process.env.LOCALAPPDATA!,'MuCodeSandbox-WindowsPreview');
  const runtime=new HyperVRuntime(root),doctor=await runtime.info();if(!doctor.available)throw Error(doctor.issues.join('; '));
  const archive=path.join(root,'sing-box-linux-amd64.tar.gz');if(await fileHash(archive)!==AMD64_TUNNEL.sha256)throw Error('Tunnel checksum mismatch');
  const job=path.join(root,`builder-${randomUUID()}`);await mkdir(job,{recursive:true});
  let phase='starting';const record=async(status='running',extra:object={})=>writeFile(path.join(job,'state.json'),JSON.stringify({status,phase,pid:process.pid,time:new Date().toISOString(),...extra},null,2));
  const step=async(value:string)=>{phase=value;console.log(value);await record();};
  let created=false,serial:Socket|undefined,serialClosed=false;
  let serialWrites:Promise<void>=Promise.resolve();
  let prior:unknown;
  if(resumeFlag){
    if(resumeFlag!=='--resume-builder'||!resumePath||!/^builder-[0-9a-f-]+[\\/]config\.json$/.test(path.relative(root,path.resolve(resumePath))))throw Error('Resume accepts only a local builder job config');
    const state=JSON.parse(await import('node:fs/promises').then(fs=>fs.readFile(path.join(path.dirname(path.resolve(resumePath)),'state.json'),'utf8')));
    if(state.status!=='failed')throw Error('Previous builder is not terminal');
    try{process.kill(state.pid,0);throw Error('Previous builder owner is still live');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    prior=JSON.parse(await import('node:fs/promises').then(fs=>fs.readFile(path.resolve(resumePath),'utf8')));
  }
  const template=windowsConfigSchema.parse(prior?{...windowsConfigSchema.parse(prior),proxy:{mode:'http',address:'127.0.0.1',port:1}}:{version:1,id:randomUUID(),image:path.resolve(image),imageSha256:sha256,cpus:2,memoryGiB:4,diskGiB:32,
    proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:'203.0.113.10'});
  if(template.imageSha256!==sha256||template.expectedIp!=='203.0.113.10')throw Error('Builder source identity changed');
  const proxy=await packageProxy();const c={...template,proxy:{...template.proxy,port:proxy.port}};
  try{
    await writeFile(path.join(job,'config.json'),JSON.stringify(c,null,2));
    if(prior){await step('inspecting-stopped-builder');if((await runtime.inspectVm(c)).state!=='Off')throw Error('Builder VM must be stopped before resume');created=true;}
    else{await step('creating-isolated-vm');await runtime.create(c);created=true;}
    await step('starting-linux');const starting=runtime.start(c);
    void (async()=>{while(!serialClosed){
      const socket=createConnection('\\\\.\\pipe\\'+vmIdentity(c.id).name+'-serial');
      try{await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
        if(serialClosed){socket.destroy();return;}serial=socket;
        socket.on('data',block=>{const bytes=Buffer.from(block);serialWrites=serialWrites.then(()=>appendFile(path.join(job,'serial.log'),bytes)).catch(()=>{});});return;
      }catch{socket.destroy();await delay(1000);}
    }})();
    await starting;await step('opening-approved-package-channel');await runtime.connectBootstrap(c);
    await step('installing-ubuntu-components');await runtime.bootstrap(c,archive);
    await step('installing-closed-network-guard');await runtime.configure(c);
    await step('exporting-empty-protected-base');const exported=await runtime.freezeBase(c);
    await writeFile(path.join(root,'protected-base.json'),JSON.stringify({image:exported.file,imageSha256:exported.sha256},null,2));
    await record('completed',{packageRequests:proxy.counters(),sourceVerified:true});console.log('Protected empty Linux base created.');
  }catch(error){await record('failed',{error:error instanceof Error?error.message:String(error)});throw error;}
  finally{serialClosed=true;serial?.destroy();await serialWrites;try{await runtime.disconnect();if(created)await runtime.stop(c);}finally{await proxy.close();}}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Image build failed');process.exitCode=1;});
