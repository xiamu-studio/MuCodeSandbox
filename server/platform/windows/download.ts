import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export interface VerifiedAsset { url:string; sha256:string }
interface DownloadOptions { signal?:AbortSignal; concurrency?:number; chunkBytes?:number; maxBytes?:number; onProgress?:(completed:number,total:number)=>void }
const length=async(file:string)=>stat(file).then(s=>s.size,error=>{if(error.code==='ENOENT')return 0;throw error;});
async function digest(file:string){const h=createHash('sha256');for await(const block of createReadStream(file))h.update(block);return h.digest('hex');}

// Parallel bounded ranges make large VM images resumable. No partial file is
// ever published as an installable component; the vendor-pinned full digest is
// checked after assembly, including when all chunks came from a previous run.
export async function downloadVerifiedAsset(asset:VerifiedAsset,target:string,options:DownloadOptions={}) {
  if(!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('Invalid pinned checksum');
  const url=new URL(asset.url);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw Error('Downloads require verified HTTPS');
  if(await length(target)>0&&await digest(target)===asset.sha256)return;
  const directory=target+'.parts';await mkdir(directory,{recursive:true});
  const lockPath=path.join(directory,'owner.json');
  let lock;
  try{lock=await open(lockPath,'wx');}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const owner=JSON.parse(await readFile(lockPath,'utf8'));
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid download owner');
    try{process.kill(owner.pid,0);throw Error('Download already has a live owner');}catch(probe){if((probe as NodeJS.ErrnoException).code!=='ESRCH')throw probe;}
    await rm(lockPath);lock=await open(lockPath,'wx');
  }
  await lock.writeFile(JSON.stringify({pid:process.pid}));
  const controller=new AbortController();const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
  try{
    const head=await fetch(asset.url,{method:'HEAD',headers:{'accept-encoding':'identity'},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
    if(!head.ok)throw Error('Official asset metadata unavailable');
    const total=Number(head.headers.get('content-length'));
    if(!Number.isSafeInteger(total)||total<=0||total>(options.maxBytes??1500*1024*1024))throw Error('Invalid asset size');
    const chunk=options.chunkBytes??8*1024*1024;
    if(!Number.isSafeInteger(chunk)||chunk<1)throw Error('Invalid chunk size');
    const metadata={url:asset.url,sha256:asset.sha256,total,chunk};const metadataPath=path.join(directory,'asset.json');
    try{if(JSON.stringify(JSON.parse(await readFile(metadataPath,'utf8')))!==JSON.stringify(metadata))throw Error('Cached ranges belong to a different asset');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await writeFile(metadataPath,JSON.stringify(metadata),{flag:'wx'});}
    const count=Math.ceil(total/chunk),invalid=path.join(directory,'invalid.json');
    try{
      const rejected=JSON.parse(await readFile(invalid,'utf8'));
      if(rejected.sha256!==asset.sha256)throw Error('Invalid cache rejection marker');
      for(let i=0;i<count;i++)await rm(path.join(directory,`${i}.part`),{force:true});
      await rm(invalid);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const sizes=await Promise.all(Array.from({length:count},(_,i)=>length(path.join(directory,`${i}.part`))));
    let completed=sizes.reduce((a,b)=>a+b,0);options.onProgress?.(completed,total);
    let cursor=0;
    const worker=async()=>{while(cursor<count){const index=cursor++,file=path.join(directory,`${index}.part`),start=index*chunk,end=Math.min(total,start+chunk)-1,expected=end-start+1;
      if(sizes[index]>expected)throw Error('Cached range is oversized');
      for(let attempt=0;attempt<4;attempt++){
        const offset=await length(file);if(offset===expected)break;
        try{
          const response=await fetch(asset.url,{headers:{range:`bytes=${start+offset}-${end}`,'accept-encoding':'identity'},signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])});
          if(response.status!==206||response.headers.get('content-range')!==`bytes ${start+offset}-${end}/${total}`||!response.body||response.headers.get('content-encoding')){await response.body?.cancel();throw Error('Server did not honor the bounded byte range');}
          if(new URL(response.url).protocol!==url.protocol)throw Error('Download protocol changed');
          let received=0;
          await pipeline(Readable.fromWeb(response.body as never),new Transform({transform(block,_enc,done){received+=block.length;if(offset+received>expected){done(Error('Oversized range'));return;}completed+=block.length;options.onProgress?.(completed,total);done(null,block);}}),createWriteStream(file,{flags:'a'}),{signal});
          if(await length(file)!==expected)throw Error('Incomplete byte range');
          break;
        }catch(error){if(signal.aborted||attempt===3)throw error;}
      }
    }};
    const workers=Array.from({length:Math.min(count,options.concurrency??6)},()=>worker().catch(error=>{controller.abort();throw error;}));
    const outcomes=await Promise.allSettled(workers);const failed=outcomes.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    const assembled=target+'.assembling';await rm(assembled,{force:true});
    const hash=createHash('sha256');
    const blocks=async function*(){for(let i=0;i<count;i++)for await(const block of createReadStream(path.join(directory,`${i}.part`)))yield block;};
    await pipeline(Readable.from(blocks()),new Transform({transform(block,_enc,done){hash.update(block);done(null,block);}}),createWriteStream(assembled,{flags:'wx'}),{signal});
    if(hash.digest('hex')!==asset.sha256){await writeFile(invalid,JSON.stringify({sha256:asset.sha256}));await rm(assembled,{force:true});throw Error('Official component SHA-256 mismatch');}
    await rename(assembled,target);
  }finally{controller.abort();await lock.close();await rm(lockPath,{force:true});}
}
