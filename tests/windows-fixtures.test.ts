import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import { localFixtures, LAB_EXIT } from '../scripts/windows/local-fixtures.ts';

const openssl=process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
test('Local TLS/CONNECT fixtures accept only the two synthetic destinations',{skip:process.platform!=='win32'},async()=>{
  await access(openssl);const root=await mkdtemp(path.join(tmpdir(),'mu-local-receivers-'));
  const f=await localFixtures(root,openssl);
  try{
    for(const ip of f.receivers){
      const output=await new Promise<string>((resolve,reject)=>{
        const req=request({host:'127.0.0.1',port:f.port,method:'CONNECT',path:`${ip}:443`});
        req.on('error',reject);req.on('connect',(res,socket)=>{
          assert.equal(res.statusCode,200);
          const tls=tlsConnect({socket,ca:f.certificate,checkServerIdentity:(_host,certificate)=>checkServerIdentity(ip,certificate)},()=>tls.write(`GET / HTTP/1.1\r\nHost: ${ip}\r\nConnection: close\r\n\r\n`));
          let body='';tls.on('data',chunk=>{body+=chunk;});tls.on('error',reject);tls.on('end',()=>resolve(body));
        });req.end();
      });
      assert.ok(output.includes(LAB_EXIT));
    }
    const code=await new Promise<number|undefined>((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port:f.port,method:'CONNECT',path:'unapproved.invalid:443'});
      req.on('error',reject);req.on('connect',(res,socket)=>{socket.destroy();resolve(res.statusCode);});req.end();
    });
    assert.equal(code,403);assert.deepEqual(f.counters(),{receipts:2,denied:1});
  }finally{await f.close();await rm(root,{recursive:true,force:true});}
});
