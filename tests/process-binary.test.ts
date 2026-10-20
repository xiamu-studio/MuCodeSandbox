import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {run} from '../server/process.ts';
test('Runner preserves raw binary stdin including invalid UTF8 and NUL bytes',async()=>{
 const body=Buffer.alloc(4*1024*1024);for(let i=0;i<body.length;i++)body[i]=i%256;
 const result=JSON.parse(await run('python3',['-c','import sys,hashlib,json;v=sys.stdin.buffer.read();print(json.dumps({"bytes":len(v),"sha256":hashlib.sha256(v).hexdigest()}))'],{inputBytes:body,timeoutMs:10000,maxBytes:1000}));assert.equal(result.bytes,body.length);assert.equal(result.sha256,createHash('sha256').update(body).digest('hex'));
});
test('A binary pipe closed by the receiver rejects without crashing the service process',async()=>{
 await assert.rejects(run('python3',['-c','import os;os._exit(1)'],{inputBytes:Buffer.alloc(4*1024*1024),timeoutMs:5000}),error=>error instanceof Error);
});
test('A cancelled raw transfer terminates the child and remains bounded',async()=>{
 const controller=new AbortController(),promise=run('python3',['-c','import time;time.sleep(30)'],{inputBytes:Buffer.alloc(4*1024*1024),signal:controller.signal,timeoutMs:5000});controller.abort();await assert.rejects(promise,{code:'CANCELLED'});
});
