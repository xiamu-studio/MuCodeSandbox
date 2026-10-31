import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { downloadVerifiedAsset } from '../server/platform/windows/download.ts';

test('Range downloads assemble pinned bytes and reuse the verified cache',async()=>{
  const bytes=Buffer.alloc(60000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const sha256=createHash('sha256').update(bytes).digest('hex');let requests=0;
  const server=createServer((req,res)=>{
    requests++;if(req.method==='HEAD'){res.setHeader('content-length',bytes.length);res.end();return;}
    const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');assert.ok(match);
    const a=Number(match[1]),b=Number(match[2]);res.writeHead(206,{'content-range':`bytes ${a}-${b}/${bytes.length}`,'content-length':b-a+1});res.end(bytes.subarray(a,b+1));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=await mkdtemp(path.join(tmpdir(),'mu-ranges-'));const target=path.join(root,'component');
  try{
    const asset={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/component`,sha256};
    await downloadVerifiedAsset(asset,target,{chunkBytes:4096,concurrency:3});assert.deepEqual(await readFile(target),bytes);
    assert.deepEqual(await readdir(target+'.parts'),[],'verified publication must release duplicate ranges');
    const before=requests;await downloadVerifiedAsset(asset,target);assert.equal(requests,before);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('Unknown entries in a completed range cache are preserved',async()=>{
  const bytes=Buffer.from('known component'),sha256=createHash('sha256').update(bytes).digest('hex');
  const server=createServer((req,res)=>{if(req.method==='HEAD'){res.setHeader('content-length',bytes.length);res.end();return;}
    const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');assert.ok(match);const a=Number(match[1]),b=Number(match[2]);res.writeHead(206,{'content-range':`bytes ${a}-${b}/${bytes.length}`});res.end(bytes.subarray(a,b+1));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const root=await mkdtemp(path.join(tmpdir(),'mu-ranges-unknown-')),target=path.join(root,'component');
  try{let added=false;await downloadVerifiedAsset({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/component`,sha256},target,{chunkBytes:8,onProgress(){if(!added){added=true;writeFileSync(path.join(target+'.parts','unknown.txt'),'preserve');}}});
    assert.deepEqual(await readFile(target),bytes);assert.equal(await readFile(path.join(target+'.parts','unknown.txt'),'utf8'),'preserve');assert.ok((await readdir(target+'.parts')).includes('0.part'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('Wrong bytes and ignored range requests are never published as assets',async()=>{
  const server=createServer((req,res)=>{res.setHeader('content-length',8);res.end(req.method==='HEAD'?undefined:'untrusted');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=await mkdtemp(path.join(tmpdir(),'mu-ranges-fail-')),target=path.join(root,'component');
  try{
    await assert.rejects(downloadVerifiedAsset({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/component`,sha256:'a'.repeat(64)},target,{chunkBytes:4}));
    await assert.rejects(stat(target),{code:'ENOENT'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('Failed checksum keeps downloaded ranges for diagnosis and never publishes a file',async()=>{
  const bytes=Buffer.from('untrusted payload');
  const server=createServer((req,res)=>{if(req.method==='HEAD'){res.setHeader('content-length',bytes.length);res.end();return;}
    const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');assert.ok(match);const a=Number(match[1]),b=Number(match[2]);res.writeHead(206,{'content-range':`bytes ${a}-${b}/${bytes.length}`});res.end(bytes.subarray(a,b+1));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const root=await mkdtemp(path.join(tmpdir(),'mu-ranges-checksum-')),target=path.join(root,'component');
  try{await assert.rejects(downloadVerifiedAsset({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/component`,sha256:'a'.repeat(64)},target,{chunkBytes:8}),/SHA-256 mismatch/);
    await assert.rejects(stat(target),{code:'ENOENT'});const entries=await readdir(target+'.parts');assert.ok(entries.includes('0.part'));assert.ok(entries.includes('invalid.json'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('A pinned size supports a HEAD response without content-length, while an inconsistent size is refused',async()=>{
  const bytes=Buffer.from('verified test component'),sha256=createHash('sha256').update(bytes).digest('hex');let advertised:number|null=null;
  const server=createServer((req,res)=>{if(req.method==='HEAD'){if(advertised!==null)res.setHeader('content-length',advertised);res.end();return;}
    const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');assert.ok(match);const a=Number(match[1]),b=Number(match[2]);res.writeHead(206,{'content-range':`bytes ${a}-${b}/${bytes.length}`,'content-length':b-a+1});res.end(bytes.subarray(a,b+1));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const root=await mkdtemp(path.join(tmpdir(),'mu-ranges-pinned-'));
  try{const asset={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/component`,sha256,bytes:bytes.length};
    await downloadVerifiedAsset(asset,path.join(root,'good'),{chunkBytes:8,maxBytes:bytes.length});assert.deepEqual(await readFile(path.join(root,'good')),bytes);
    advertised=bytes.length+1;await assert.rejects(downloadVerifiedAsset(asset,path.join(root,'bad'),{maxBytes:bytes.length+2}));await assert.rejects(stat(path.join(root,'bad')),{code:'ENOENT'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
