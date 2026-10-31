import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs,HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {createHash} from 'node:crypto';

test('Malformed host snapshots cannot become a trusted hash baseline',{skip:process.platform!=='win32'},async()=>{
 for(const source of ['PRIVATE_NETWORK_DIAGNOSTIC','null','[]','0','{}','{"adapters":[],"routes":[]}','{"adapters":[],"routes":{},"dns":[]}','{"adapters":[],"routes":[],"dns":[],"extra":"PRIVATE_NETWORK_DIAGNOSTIC"}']){
  const runtime=new HyperVRuntime('synthetic',async()=>source);
  await assert.rejects(runtime.fingerprint(),error=>{
   assert.ok(error instanceof Error);assert.equal((error as {code?:string}).code,'HOST_NETWORK_SNAPSHOT_INVALID');
   assert.equal(error.message.includes('PRIVATE_NETWORK_DIAGNOSTIC'),false);return true;
  });
 }
});
test('Valid host snapshots retain their existing full and component hashes',{skip:process.platform!=='win32'},async()=>{
 const snapshot={adapters:[],routes:[],dns:[]},source=JSON.stringify(snapshot),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const runtime=new HyperVRuntime('synthetic',async()=>source);
 assert.deepEqual(JSON.parse(await runtime.fingerprint()),{total:hash(source),adapters:hash('[]'),routes:hash('[]'),dns:hash('[]')});
});

test('Windows network fingerprint is stable when equal-key routes arrive in a different order',{skip:process.platform!=='win32'},async()=>{
 const q=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 const fixture=path.resolve('tests/fixtures/windows-fingerprint-order.ps1'),source=path.resolve('scripts/windows/hyperv.ps1');
 const read=(mode:string)=>run(powershellPath(),powershellArgs(`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${q(fixture)}))) -Source ${q(source)} -Mode ${q(mode)}`),{timeoutMs:15000});
 const [forward,reverse,changed]=await Promise.all([read('forward'),read('reverse'),read('changed')]);
 assert.equal(reverse,forward);assert.notEqual(changed,forward);
 await assert.rejects(read('error'),/Network fingerprint queries failed/);
});
