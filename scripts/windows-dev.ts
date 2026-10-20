import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HyperVRuntime, AMD64_TUNNEL, CANONICAL_IMAGE, fileHash } from '../server/platform/windows/runtime.ts';
import { windowsConfigSchema } from '../server/platform/windows/config.ts';
import { run } from '../server/process.ts';
import { WindowsHostMonitor } from '../server/platform/windows/monitor.ts';
import { downloadVerifiedAsset } from '../server/platform/windows/download.ts';

// Separate entry point: never opens the Mac database, UI or Lima directory.
const root=process.env.MU_WINDOWS_DATA_DIR??path.join(process.env.LOCALAPPDATA??process.cwd(),'MuCodeSandbox-WindowsPreview');
const [action,configPath]=process.argv.slice(2);
async function main() {
  if(process.platform!=='win32')throw Error('This preview requires Windows');
  const runtime=new HyperVRuntime(root);
  if(action==='doctor'){console.log(JSON.stringify(await runtime.info(),null,2));return;}
  if(action==='download-tunnel'||action==='download-base') {
    const asset=action==='download-base'?CANONICAL_IMAGE:AMD64_TUNNEL;
    const maxBytes=action==='download-base'?1500*1024*1024:100*1024*1024;
    await mkdir(root,{recursive:true});const target=path.join(root,action==='download-base'?'canonical-amd64.vhd.tar.gz':'sing-box-linux-amd64.tar.gz');
    let last=0;
    await downloadVerifiedAsset(asset,target,{maxBytes,onProgress:(done,total)=>{if(Date.now()-last>10000){last=Date.now();console.log(`Downloading ${Math.floor(done/1048576)}/${Math.ceil(total/1048576)} MiB`);}}});
    console.log('Official component downloaded and SHA-256 verified.');
      if(action==='download-base') {
        const entries=(await run('tar.exe',['-tf',target],{timeoutMs:30000})).trim().split(/\r?\n/);
        if(entries.length!==1||!/^[-a-zA-Z0-9_.]+\.vhd$/.test(entries[0]))throw Error('Unexpected Canonical image archive layout');
        const output=path.join(root,`canonical-${randomUUID()}`);await mkdir(output);
        await run('tar.exe',['-xzf',target,'-C',output],{timeoutMs:600000});
        const image=path.join(output,entries[0]);console.log(JSON.stringify({image,imageSha256:await fileHash(image)},null,2));
      }
    return;
  }
  if(!configPath||!['create','bootstrap','freeze-base','run','stop','inspect'].includes(action))throw Error('Usage: npm run windows:dev -- doctor | download-base | download-tunnel | create|bootstrap|freeze-base|run|stop|inspect <local-config.json>');
  const c=windowsConfigSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
  const locks=path.join(root,'locks');await mkdir(locks,{recursive:true});
  const lockPath=path.join(locks,`${c.id}.lock`);
  const lock=await open(lockPath,'wx');await lock.writeFile(String(process.pid));
  try {
  if(action==='create'){await runtime.create(c);console.log('Isolated VM created and left stopped.');return;}
  if(action==='stop'){await runtime.disconnect();await runtime.stop(c);console.log('VM stopped.');return;}
  if(action==='inspect'){console.log(JSON.stringify(await runtime.inspectVm(c),null,2));return;}
  let session:Awaited<ReturnType<HyperVRuntime['session']>>|undefined;
  let monitor:WindowsHostMonitor|undefined;
  let stopping=false;
  const close=async()=>{
    stopping=true;
    monitor?.stop();
    if(session)await session.fail();else {await runtime.disconnect();await runtime.stop(c);}
  };
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void close().catch(()=>{process.exitCode=1;});});
  try {
    await runtime.start(c);if(stopping)return;
    if(action==='freeze-base') {
      console.log(JSON.stringify(await runtime.freezeBase(c),null,2));return;
    }
    if(action==='bootstrap') {
      await runtime.connectBootstrap(c);if(stopping)return;
      const archive=path.join(root,'sing-box-linux-amd64.tar.gz');
      if(await fileHash(archive)!==AMD64_TUNNEL.sha256)throw Error('Run download-tunnel before bootstrap');
      await runtime.bootstrap(c,archive);
      // Install the closed boot guard now, before this VM is ever used for work.
      await runtime.configure(c);
      console.log('Guest dependencies and default-closed boot protection installed. VM will be stopped.');
      return;
    }
    session=await runtime.session(c);if(stopping)return;
    await runtime.connect(c);if(stopping)return;
    monitor=new WindowsHostMonitor(()=>runtime.fingerprint(),()=>{void close().catch(()=>{process.exitCode=1;});});
    await monitor.start();if(stopping)return;await session.open();if(stopping)return;
    console.log('Strict protection active. Two matching exit receipts verified. Ctrl+C closes the network and stops this VM.');
    let last=Date.now();
    while(!stopping&&session.state==='active') {
      await delay(8000);
      if(stopping)break;
      const now=Date.now();
      if(now-last>15000||now<last)throw Error('Host suspend or clock discontinuity detected');
      if(stopping)break;
      await session.tick();last=Date.now();
    }
  } finally {
    // Cleanup again after in-flight startup finishes: a signal can arrive
    // while a Hyper-V/SSH operation is still completing.
    try {await close();}finally{await runtime.disconnect();await runtime.stop(c);}
  }
  } finally {await lock.close();await rm(lockPath,{force:true});}
}
main().catch(error=>{
  // Do not print proxy URLs, credentials, local paths or raw SSH/apt diagnostics.
  console.error(error instanceof Error&&/Hyper-V|administrator|Usage:|checksum|SHA-256|requires Windows|network configuration changed|suspend|clock discontinuity/.test(error.message)?error.message:'Windows preview operation failed. Inspect the local VM and cleanup status for details.');
  process.exitCode=1;
});
