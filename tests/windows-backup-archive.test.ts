import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readWindowsBackupArchive,writeWindowsBackupArchive,windowsBackupManifest,type WindowsBackupManifest} from '../server/platform/windows/backup-archive.ts';

const password='synthetic-Windows-backup-password',chunkSize=1024*1024;
function fixture(bytes=chunkSize*2+131){
 const disk=Buffer.alloc(bytes);for(let i=0;i<disk.length;i++)disk[i]=i%251;
 Buffer.from('SYNTHETIC PRIVATE WINDOWS DISK').copy(disk);
 const manifest=windowsBackupManifest.parse({version:1,architecture:'x86_64',platform:'hyperv',imageSha256:'a'.repeat(64),config:{name:'合成 Windows 备份',cpus:1,memoryGiB:2,diskGiB:32,identity:{timezone:'UTC',locale:'zh-CN'},network:{mode:'http',host:'127.0.0.1',port:12345,password:'synthetic-private-proxy-password',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.10'}}},disk:{bytes,sha256:createHash('sha256').update(disk).digest('hex')}});
 return {disk,manifest};
}
async function* input(bytes:Buffer,step=chunkSize){for(let i=0;i<bytes.length;i+=step)yield bytes.subarray(i,i+step);}
function sink(){const chunks:Buffer[]=[];return {chunks,write:async(bytes:Uint8Array)=>{chunks.push(Buffer.from(bytes));},bytes:()=>Buffer.concat(chunks)};}
async function encode(disk:Buffer,manifest:WindowsBackupManifest){const output=sink();await writeWindowsBackupArchive(output,input(disk),manifest,password);return output.bytes();}
function records(bytes:Buffer){const result:{start:number;end:number;type:number}[]=[];let offset=32;while(offset<bytes.length){const length=bytes.readUInt32BE(offset+1),end=offset+5+length+16;result.push({start:offset,end,type:bytes[offset]});offset=end;}assert.equal(offset,bytes.length);return result;}

test('Windows backup round-trips private configuration and a multi-record AMD64 disk across arbitrary input boundaries',async()=>{
 const f=fixture(),encrypted=await encode(f.disk,f.manifest),output=sink();
 const restored=await readWindowsBackupArchive(input(encrypted,137),output,password);
 assert.deepEqual(restored,f.manifest);assert.deepEqual(output.bytes(),f.disk);assert.equal(encrypted.subarray(0,8).toString(),'MUCWIN01');
 for(const secret of ['合成 Windows 备份','synthetic-private-proxy-password','SYNTHETIC PRIVATE WINDOWS DISK'])assert.equal(encrypted.includes(Buffer.from(secret)),false);
 const second=await encode(f.disk,f.manifest);assert.notDeepEqual(encrypted.subarray(8,32),second.subarray(8,32));assert.notDeepEqual(encrypted,second);
 assert.deepEqual(records(encrypted).map(value=>value.type),[1,2,2,2,3]);
});

test('Windows backup rejects wrong passwords before writing any disk data',async()=>{
 const f=fixture(512),encrypted=await encode(f.disk,f.manifest),output=sink();
 await assert.rejects(readWindowsBackupArchive(input(encrypted),output,'incorrect-synthetic-password'),{code:'WINDOWS_BACKUP_INTEGRITY'});assert.equal(output.bytes().length,0);
});

test('Windows backup authenticates header, metadata, every disk record and the terminal commit',async t=>{
 const f=fixture(),original=await encode(f.disk,f.manifest),entries=records(original);
 for(const [name,offset] of [['salt',8],['nonce',24],['metadata',entries[0].start+9],['disk',entries[1].start+42],['disk-tag',entries[1].end-1],['commit',entries.at(-1)!.start+9],['commit-tag',original.length-1]] as const)await t.test(name,async()=>{
  const damaged=Buffer.from(original);damaged[offset]^=1;const output=sink();let published=false;
  await assert.rejects((async()=>{await readWindowsBackupArchive(input(damaged),output,password);published=true;})(),{code:'WINDOWS_BACKUP_INTEGRITY'});assert.equal(published,false);
  if(name==='salt'||name==='nonce'||name==='metadata'||name==='disk'||name==='disk-tag')assert.equal(output.bytes().length,0);
 });
});

test('Windows backup refuses removed, reordered, duplicated and cross-archive spliced disk records',async t=>{
 const f=fixture(),first=await encode(f.disk,f.manifest),second=await encode(f.disk,f.manifest),r=records(first),s=records(second),disk=r[1];
 const cases={
  removed:Buffer.concat([first.subarray(0,disk.start),first.subarray(disk.end)]),
  reordered:Buffer.concat([first.subarray(0,disk.start),first.subarray(r[2].start,r[2].end),first.subarray(disk.start,disk.end),first.subarray(r[2].end)]),
  duplicated:Buffer.concat([first.subarray(0,disk.end),first.subarray(disk.start,disk.end),first.subarray(disk.end)]),
  spliced:Buffer.concat([first.subarray(0,disk.start),second.subarray(s[1].start,s[1].end),first.subarray(disk.end)]),
 };
 for(const [name,bytes] of Object.entries(cases))await t.test(name,async()=>{await assert.rejects(readWindowsBackupArchive(input(bytes),sink(),password),{code:'WINDOWS_BACKUP_INTEGRITY'});});
});

test('Windows backup refuses truncation and trailing content even after all disk records authenticate',async t=>{
 const f=fixture(512),original=await encode(f.disk,f.manifest),r=records(original);
 for(const cut of [0,7,31,32,36,r[0].end-1,r[0].end,r[1].end-1,r[1].end,original.length-1])await t.test('cut-'+cut,async()=>{await assert.rejects(readWindowsBackupArchive(input(original.subarray(0,cut)),sink(),password),{code:'WINDOWS_BACKUP_INTEGRITY'});});
 await assert.rejects(readWindowsBackupArchive(input(Buffer.concat([original,Buffer.from([0])])),sink(),password),{code:'WINDOWS_BACKUP_INTEGRITY'});
});

test('Windows backup rejects overlarge record declarations without reading or allocating the declared body',async()=>{
 const f=fixture(512),encrypted=await encode(f.disk,f.manifest),r=records(encrypted),prefix=Buffer.from(encrypted.subarray(0,r[0].start+5));prefix.writeUInt32BE(0xffffffff,r[0].start+1);let requestedBody=false;
 async function* malicious(){yield prefix;requestedBody=true;throw Error('Unbounded body requested');}
 await assert.rejects(readWindowsBackupArchive(malicious(),sink(),password),{code:'WINDOWS_BACKUP_INTEGRITY'});assert.equal(requestedBody,false);
});

test('Windows backup cannot commit a changed, short or long source and closes a failed source iterator',async t=>{
 const f=fixture(512);
 for(const [name,bytes] of [['changed',Buffer.alloc(512)],['short',f.disk.subarray(0,511)],['long',Buffer.concat([f.disk,Buffer.from([0])])]] as const)await t.test(name,async()=>{
  const output=sink();await assert.rejects(writeWindowsBackupArchive(output,input(bytes),f.manifest,password),{code:'WINDOWS_BACKUP_INTEGRITY'});assert.ok(!records(output.bytes()).some(value=>value.type===3));
  await assert.rejects(readWindowsBackupArchive(input(output.bytes()),sink(),password),{code:'WINDOWS_BACKUP_INTEGRITY'});
 });
 let closed=false;async function* source(){try{yield f.disk;throw Error('synthetic source lost');}finally{closed=true;}}
 await assert.rejects(writeWindowsBackupArchive(sink(),source(),f.manifest,password),/synthetic source lost/);assert.equal(closed,true);
});

test('Windows backup cancellation and sink failure cannot return a publishable result',async()=>{
 const f=fixture(512),encrypted=await encode(f.disk,f.manifest),abort=new AbortController(),output=sink();
 const target={write:async(bytes:Uint8Array)=>{await output.write(bytes);abort.abort();}};
 await assert.rejects(readWindowsBackupArchive(input(encrypted),target,password,abort.signal),{name:'AbortError'});assert.deepEqual(output.bytes(),f.disk);
 const early=new AbortController();early.abort();await assert.rejects(writeWindowsBackupArchive(sink(),input(f.disk),f.manifest,password,early.signal),{name:'AbortError'});
 await assert.rejects(writeWindowsBackupArchive({write:async()=>{throw Error('synthetic disk full');}},input(f.disk),f.manifest,password),/synthetic disk full/);
 let closed=false;async function* tracked(){try{yield encrypted;}finally{closed=true;}}
 await assert.rejects(readWindowsBackupArchive(tracked(),{write:async()=>{throw Error('synthetic restore disk full');}},password),/synthetic restore disk full/);assert.equal(closed,true);
});

test('Windows backup rejects Mac architecture, unknown authority, host grants and weak passwords before export',async()=>{
 const f=fixture(512);
 for(const altered of [{...f.manifest,architecture:'aarch64'},{...f.manifest,platform:'vz'},{...f.manifest,hostPath:'C:/private'},{...f.manifest,config:{...f.manifest.config,ports:[{id:'12345678-1234-4234-8234-123456789abc',guestPort:3000,hostPort:4000}]}},{...f.manifest,config:{...f.manifest.config,network:{...f.manifest.config.network,strict:false,transparent:false,egressLock:undefined}}}]){
  const output=sink();await assert.rejects(writeWindowsBackupArchive(output,input(f.disk),altered as WindowsBackupManifest,password));assert.equal(output.bytes().length,0);
 }
 for(const value of ['short','x'.repeat(257)])await assert.rejects(writeWindowsBackupArchive(sink(),input(f.disk),f.manifest,value));
});
test('Windows backup permits VHDX format overhead while bounding both virtual capacity and its file footprint',()=>{
 const f=fixture(512),virtual=256*2**30,maximum=virtual+Math.floor(virtual/100);
 assert.equal(windowsBackupManifest.parse({...f.manifest,config:{...f.manifest.config,diskGiB:256},disk:{...f.manifest.disk,bytes:maximum}}).disk.bytes,maximum);
 assert.throws(()=>windowsBackupManifest.parse({...f.manifest,config:{...f.manifest.config,diskGiB:257}}));
 assert.throws(()=>windowsBackupManifest.parse({...f.manifest,disk:{...f.manifest.disk,bytes:40*2**30}}));
 assert.throws(()=>windowsBackupManifest.parse({...f.manifest,config:{...f.manifest.config,diskGiB:256},disk:{...f.manifest.disk,bytes:maximum+1}}));
});


test('Archive input close failures cannot hide the original restore failure or publish a successful read',async()=>{
 const f=fixture(512),encrypted=await encode(f.disk,f.manifest),closeError=new Error('synthetic input close failed');
 const source=()=>({[Symbol.asyncIterator](){let done=false;return {next:async()=>done?{done:true as const,value:undefined}:(done=true,{done:false as const,value:encrypted}),return:async()=>{throw closeError;}};}});
 await assert.rejects(readWindowsBackupArchive(source(),sink(),'incorrect-synthetic-password'),{code:'WINDOWS_BACKUP_INTEGRITY'});
 const diskError=new Error('synthetic restore disk full');
 await assert.rejects(readWindowsBackupArchive(source(),{write:async()=>{throw diskError;}},password),error=>error===diskError);
 const abort=new AbortController();abort.abort();await assert.rejects(readWindowsBackupArchive(source(),sink(),password,abort.signal),{name:'AbortError'});
 await assert.rejects(readWindowsBackupArchive(source(),sink(),password),error=>error===closeError);
});
