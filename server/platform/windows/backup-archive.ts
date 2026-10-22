// Windows-only transport format. Disk bytes must come from a stopped, pinned
// protected allocation; this codec does not grant access to a host path or VM.
// Restore sinks must be private staging files, never an existing/live disk.
import {createCipheriv,createDecipheriv,createHash,randomBytes,scrypt} from 'node:crypto';
import {z} from 'zod';
import {environmentSchema} from '../../validation.ts';
import {AppError} from '../../errors.ts';

const magic=Buffer.from('MUCWIN01'),headerBytes=32,tagBytes=16,chunkBytes=1024*1024,manifestBytes=64*1024;
const passwordSchema=z.string().min(12).max(256);
export const windowsBackupManifest=z.object({
 version:z.literal(1),architecture:z.literal('x86_64'),platform:z.literal('hyperv'),
 config:environmentSchema.refine(value=>value.kind==='vm'&&value.cpus<=16&&value.memoryGiB>=2&&value.memoryGiB<=32&&value.diskGiB>=16&&value.diskGiB<=256&&value.mounts.length===0&&value.ports.length===0&&value.network.strict&&value.network.transparent&&!!value.network.egressLock&&['http','https','socks5'].includes(value.network.mode)&&!value.network.tls?.certificate,'Unsupported Windows backup configuration'),
 imageSha256:z.string().regex(/^[a-f0-9]{64}$/),
 disk:z.object({bytes:z.number().int().positive().max(260*2**30).safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
}).strict().refine(value=>{const virtual=value.config.diskGiB*2**30;return value.disk.bytes<=virtual+Math.max(64*2**20,Math.floor(virtual/100));},'Disk file exceeds its declared virtual capacity and format allowance');
export type WindowsBackupManifest=z.infer<typeof windowsBackupManifest>;
export interface BackupSink {write:(bytes:Uint8Array)=>Promise<void>}
type Input=AsyncIterable<Uint8Array>;
function integrity(){return new AppError('备份密码错误、内容已损坏或格式不受支持，未完成恢复',409,'WINDOWS_BACKUP_INTEGRITY');}
async function derive(password:string,salt:Buffer){passwordSchema.parse(password);return new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*2**20},(error,key)=>error?reject(error):resolve(key)));}
function nonce(header:Buffer,index:number){if(index>=2**32)throw integrity();const iv=Buffer.alloc(12);header.copy(iv,0,24,32);iv.writeUInt32BE(index,8);return iv;}
function aad(header:Buffer,index:number,record:Buffer){const sequence=Buffer.alloc(4);sequence.writeUInt32BE(index);return Buffer.concat([header,sequence,record]);}
function commit(bytes:number,hash:Buffer){const value=Buffer.alloc(40);value.writeBigUInt64BE(BigInt(bytes));hash.copy(value,8);return value;}
function aborted(signal?:AbortSignal){signal?.throwIfAborted();}

class Reader {
 private iterator:AsyncIterator<Uint8Array>;private current:Uint8Array=new Uint8Array();private offset=0;private ended=false;private signal?:AbortSignal;
 constructor(input:Input,signal?:AbortSignal){this.iterator=input[Symbol.asyncIterator]();this.signal=signal;}
 async read(length:number,allowEnd=false):Promise<Buffer|null>{
  const result=Buffer.alloc(length);let written=0;
  while(written<length){
   aborted(this.signal);
   if(this.offset===this.current.byteLength){
    if(this.ended){if(allowEnd&&written===0)return null;throw integrity();}
    const next=await this.iterator.next();aborted(this.signal);
    if(next.done){this.ended=true;continue;}
    if(!(next.value instanceof Uint8Array))throw integrity();this.current=next.value;this.offset=0;
    if(!this.current.byteLength)continue;
   }
   const count=Math.min(length-written,this.current.byteLength-this.offset);result.set(this.current.subarray(this.offset,this.offset+count),written);this.offset+=count;written+=count;
  }
  return result;
 }
 async close(){await this.iterator.return?.();}
}

// Salt and nonce prefix are independently random for every export. Record index,
// type and length are authenticated, so reordering/splicing cannot reuse a tag.
// A final authenticated byte count and SHA-256 bind the complete disk; EOF is
// accepted only immediately after that record. There is no compression or tar.
export async function writeWindowsBackupArchive(output:BackupSink,source:Input,manifest:WindowsBackupManifest,password:string,signal?:AbortSignal){
 const parsed=windowsBackupManifest.parse(manifest),metadata=Buffer.from(JSON.stringify(parsed));
 if(metadata.length>manifestBytes)throw integrity();aborted(signal);
 const header=Buffer.concat([magic,randomBytes(16),randomBytes(8)]);let key:Buffer|undefined;
 let index=0,total=0;const hash=createHash('sha256');
 const record=async(type:number,plain:Buffer)=>{
  aborted(signal);const prefix=Buffer.alloc(5);prefix[0]=type;prefix.writeUInt32BE(plain.length,1);
  const cipher=createCipheriv('aes-256-gcm',key!,nonce(header,index));cipher.setAAD(aad(header,index,prefix));
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);index++;
  await output.write(prefix);await output.write(encrypted);await output.write(cipher.getAuthTag());aborted(signal);
 };
 try{
  key=await derive(password,header.subarray(8,24));
  aborted(signal);await output.write(header);await record(1,metadata);
  for await(const chunk of source){
   aborted(signal);if(!(chunk instanceof Uint8Array))throw integrity();
   for(let offset=0;offset<chunk.byteLength;offset+=chunkBytes){
    const bytes=Buffer.from(chunk.subarray(offset,Math.min(chunk.byteLength,offset+chunkBytes)));
    try{if(total+bytes.length>parsed.disk.bytes)throw integrity();total+=bytes.length;hash.update(bytes);await record(2,bytes);}finally{bytes.fill(0);}
   }
  }
  const digest=hash.digest();if(total!==parsed.disk.bytes||digest.toString('hex')!==parsed.disk.sha256)throw integrity();
  await record(3,commit(total,digest));
 }finally{key?.fill(0);metadata.fill(0);}
}

// A successful return is the publication boundary. Until then, the caller must
// retain only a disposable private staging file and must not register/start it.
export async function readWindowsBackupArchive(input:Input,output:BackupSink,password:string,signal?:AbortSignal):Promise<WindowsBackupManifest>{
 passwordSchema.parse(password);const reader=new Reader(input,signal);let key:Buffer|undefined;
 try{
  const header=(await reader.read(headerBytes))!;if(!header.subarray(0,8).equals(magic))throw integrity();
  key=await derive(password,header.subarray(8,24));aborted(signal);
  let index=0,total=0,manifest:WindowsBackupManifest|undefined;const hash=createHash('sha256');
  while(true){
   const prefix=(await reader.read(5))!,type=prefix[0],length=prefix.readUInt32BE(1);
   if(index===0?type!==1||length<2||length>manifestBytes:!manifest||type!==2&&type!==3||type===2&&(length<1||length>chunkBytes||total+length>manifest.disk.bytes)||type===3&&length!==40)throw integrity();
   const encrypted=(await reader.read(length))!,tag=(await reader.read(tagBytes))!;
   const decipher=createDecipheriv('aes-256-gcm',key,nonce(header,index));decipher.setAAD(aad(header,index,prefix));decipher.setAuthTag(tag);
   let plain:Buffer|undefined;
   try{
    // Do not expose update() output before final() has authenticated the record.
    const pending=decipher.update(encrypted);
    try{plain=Buffer.concat([pending,decipher.final()]);}finally{pending.fill(0);}
   }catch{throw integrity();}
   index++;
   try{
    aborted(signal);
    if(type===1){try{manifest=windowsBackupManifest.parse(JSON.parse(plain.toString('utf8')));}catch{throw integrity();}}
    else if(type===2){total+=plain.length;hash.update(plain);await output.write(plain);aborted(signal);}
    else{
     const digest=hash.digest();
     if(!manifest||total!==manifest.disk.bytes||digest.toString('hex')!==manifest.disk.sha256||!plain.equals(commit(total,digest))||await reader.read(1,true)!==null)throw integrity();
     aborted(signal);return manifest;
    }
   }finally{plain.fill(0);}
  }
 }finally{key?.fill(0);await reader.close();}
}
