import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { packageProxy } from '../scripts/windows/package-proxy.ts';

test('Image builder proxy allows only read-only Ubuntu package requests',async()=>{
  const seen:string[]=[];
  const proxy=await packageProxy((async(input,options)=>{seen.push(String(input));assert.equal(options?.redirect,'manual');return new Response('signed-package-fixture');}) as typeof fetch);
  const ask=(url:string,method='GET')=>new Promise<number|undefined>((resolve,reject)=>{const req=request({host:'127.0.0.1',port:proxy.port,path:url,method},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  try{
    assert.equal(await ask('http://archive.ubuntu.com/ubuntu/dists/noble/InRelease'),200);
    for(const url of ['http://unapproved.invalid/','http://archive.ubuntu.com.unapproved.invalid/','http://127.0.0.1/','http://archive.ubuntu.com:1234/','http://user:password@archive.ubuntu.com/'])assert.equal(await ask(url),403);
    assert.equal(await ask('http://archive.ubuntu.com/','POST'),403);assert.equal(seen.length,1);
  }finally{await proxy.close();}
});
