import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {Environment} from '../../../shared/types.ts';
import type {Store} from '../../store.ts';
import type {RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {windowsPaths,vmIdentity} from './config.ts';
import {readOriginal} from './recovery-candidates.ts';
import {windowsBackupConfiguration,windowsBackupIdentity} from './backup-archive.ts';
import {privateWindowsBackupWork,readWindowsManagementMaterials,validateBackupIdentity,windowsEnvironmentConfiguration} from './backup-bundle.ts';
import {windowsSnapshotCipher,type WindowsSnapshotOwner} from './snapshots.ts';
import {WindowsBackupCleanupRegistry,type OwnedBackupWork} from './backup-cleanup.ts';

const canonicalId=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema=z.object({version:z.literal(1),id:canonicalId,platformId:canonicalId,imageSha256:digest,purpose:z.literal('environment'),createdAt:z.string().datetime().optional()}).strict();
const allocationSchema=z.object({version:z.literal(1),id:canonicalId,backend:z.literal('hyperv-broker')}).strict();
const identity=z.object({id:canonicalId,managementPrivate:z.string().min(1).max(32768),managementPublic:z.string().min(1).max(16384),hostPrivate:z.string().min(1).max(32768),hostPublic:z.string().min(1).max(16384),knownHosts:z.string().min(1).max(16384)}).strict();
const payloadSchema=z.object({format:z.literal(1),id:canonicalId,platformId:canonicalId,imageSha256:digest,createdAt:z.string().datetime(),config:windowsBackupConfiguration,identity,seedSha256:digest,seedBytes:z.number().int().min(32774).max(8*2**20),manifest:z.string().min(1).max(8192),allocation:z.string().min(1).max(8192)}).strict().superRefine((value,ctx)=>{
 try{const manifest=manifestSchema.parse(JSON.parse(value.manifest)),allocation=allocationSchema.parse(JSON.parse(value.allocation));if(value.identity.id!==value.id||manifest.id!==value.id||manifest.platformId!==value.platformId||manifest.imageSha256!==value.imageSha256||allocation.id!==value.id)throw Error('identity');}catch{ctx.addIssue({code:'custom',message:'Snapshot owner metadata identity differs'});}
});
export type WindowsSnapshotOwnerPayload=z.infer<typeof payloadSchema>;
export interface WindowsSnapshotOwnerBinding {id:string;platformId:string;imageSha256:string;seedSha256:string;seedBytes?:number;cpus:number;memoryGiB:number;diskGiB:number}
export const windowsSnapshotOwnerFileNames=['management','management.pub','host-ed25519','host-ed25519.pub','known_hosts','seed.iso','manifest.json','allocation.json'] as const;
export type WindowsSnapshotOwnerFile={name:typeof windowsSnapshotOwnerFileNames[number];bytes:Buffer};
export type WindowsSnapshotOwnerFileBinding={name:typeof windowsSnapshotOwnerFileNames[number];sha256:string;bytes:number};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const ownerError=()=>new AppError('快照配置、管理身份或种子不一致，现有文件已保留',409,'SNAPSHOT_OWNER');
async function finishIdentityWork(work:OwnedBackupWork,primaryFailed:boolean){
 try{await work.close();}catch(error){if(!primaryFailed)throw error;}
}

// The native transaction stores only this authenticated owner envelope. It
// contains all configuration and original key material, without host paths or
// a duplicate multi-megabyte seed. The native seed is independently bound.
export class WindowsSnapshotOwnerCodec {
 readonly store:Store;readonly root:string;
 constructor(store:Store,root:string){this.store=store;this.root=root;}
 async capture(e:Environment,options:RunOptions={}):Promise<WindowsSnapshotOwner>{
  return (await this.captureState(e,options)).configuration;
 }
 async captureState(e:Environment,options:RunOptions={}):Promise<{configuration:WindowsSnapshotOwner;owner:WindowsSnapshotOwnerPayload}>{
  canonicalId.parse(e.id);options.signal?.throwIfAborted();const staging=await privateWindowsBackupWork(this.root),work=await new WindowsBackupCleanupRegistry(this.store,this.root).begin(staging.directory,'snapshot-identity');let material:Awaited<ReturnType<typeof readWindowsManagementMaterials>>|undefined,seed:Buffer|undefined,allocation:Buffer|undefined,failed=false;
  try{
   const p=windowsPaths(this.root,e.id),entry=await lstat(p.directory);if(!entry.isDirectory()||entry.isSymbolicLink())throw ownerError();
   material=await readWindowsManagementMaterials(this.root,e.id);seed=await readOriginal(p.seed,8*2**20);allocation=await readOriginal(path.join(p.directory,'allocation.json'),8192);
   const manifest=manifestSchema.parse(JSON.parse(material.bytes[5].toString('utf8'))),seedSha256=sha(seed);
   const complete=windowsBackupIdentity.parse({id:e.id,managementPrivate:material.bytes[0].toString('utf8'),managementPublic:material.bytes[1].toString('utf8'),hostPrivate:material.bytes[2].toString('utf8'),hostPublic:material.bytes[3].toString('utf8'),knownHosts:material.bytes[4].toString('utf8'),seed:{base64:seed.toString('base64'),sha256:seedSha256}});
   await validateBackupIdentity(complete,staging.directory,options.signal,work.write);const {seed:_seed,...management}=complete;
   const payload=payloadSchema.parse({format:1,id:e.id,platformId:manifest.platformId,imageSha256:manifest.imageSha256,createdAt:e.createdAt,config:windowsEnvironmentConfiguration(e),identity:management,seedSha256,seedBytes:seed.length,manifest:material.bytes[5].toString('utf8'),allocation:allocation.toString('utf8')});
   const again=await readWindowsManagementMaterials(this.root,e.id);try{if(again.binding!==material.binding)throw ownerError();}finally{for(const bytes of again.bytes)bytes.fill(0);}
   const finalSeed=await readOriginal(p.seed,8*2**20);let finalAllocation:Buffer|undefined;try{finalAllocation=await readOriginal(path.join(p.directory,'allocation.json'),8192);if(sha(finalSeed)!==seedSha256||!finalAllocation.equals(allocation))throw ownerError();}finally{finalSeed.fill(0);finalAllocation?.fill(0);}
   const current=this.store.get(e.id);if(JSON.stringify(windowsEnvironmentConfiguration(current))!==JSON.stringify(payload.config)||current.createdAt!==e.createdAt)throw ownerError();
   const plain=JSON.stringify(payload);if(Buffer.byteLength(plain)>384*1024-64)throw ownerError();options.signal?.throwIfAborted();
   return {configuration:{ownerConfiguration:windowsSnapshotCipher.parse(this.store.encrypt(plain)),seedSha256,cpus:payload.config.cpus,memoryGiB:payload.config.memoryGiB,diskGiB:payload.config.diskGiB,imageSha256:payload.imageSha256},owner:payload};
  }catch{failed=true;options.signal?.throwIfAborted();throw ownerError();}
  finally{seed?.fill(0);allocation?.fill(0);if(material)for(const bytes of material.bytes)bytes.fill(0);await finishIdentityWork(work,failed);}
 }
 decode(cipher:string,binding:WindowsSnapshotOwnerBinding):WindowsSnapshotOwnerPayload{
  try{
   windowsSnapshotCipher.parse(cipher);const plain=this.store.decrypt(cipher);if(Buffer.byteLength(plain)>384*1024-64)throw ownerError();const value=payloadSchema.parse(JSON.parse(plain));
   if(value.id!==binding.id||value.platformId!==binding.platformId||value.imageSha256!==binding.imageSha256||value.seedSha256!==binding.seedSha256||(binding.seedBytes!==undefined&&value.seedBytes!==binding.seedBytes)||(['cpus','memoryGiB','diskGiB'] as const).some(k=>value.config[k]!==binding[k]))throw ownerError();return value;
  }catch{throw ownerError();}
 }
 async validateSeed(owner:WindowsSnapshotOwnerPayload,seed:Buffer,options:RunOptions={}){
  options.signal?.throwIfAborted();const staging=await privateWindowsBackupWork(this.root),work=await new WindowsBackupCleanupRegistry(this.store,this.root).begin(staging.directory,'snapshot-identity');let failed=false;
  try{const value=payloadSchema.parse(owner);if(seed.length!==value.seedBytes)throw ownerError();const complete=windowsBackupIdentity.parse({...value.identity,seed:{base64:seed.toString('base64'),sha256:value.seedSha256}});await validateBackupIdentity(complete,staging.directory,options.signal,work.write);}
  catch{failed=true;options.signal?.throwIfAborted();throw ownerError();}finally{await finishIdentityWork(work,failed);}
 }
 async files(owner:WindowsSnapshotOwnerPayload,seed:Buffer,options:RunOptions={}):Promise<WindowsSnapshotOwnerFile[]>{
  const value=payloadSchema.parse(owner),pinned=Buffer.from(seed);
  try{await this.validateSeed(value,pinned,options);const i=value.identity;
   const contents=[i.managementPrivate,i.managementPublic,i.hostPrivate,i.hostPublic,i.knownHosts,pinned,value.manifest,value.allocation];
   return windowsSnapshotOwnerFileNames.map((name,index)=>({name,bytes:Buffer.from(contents[index])}));
  }finally{pinned.fill(0);}
 }
 fileBindings(owner:WindowsSnapshotOwnerPayload):WindowsSnapshotOwnerFileBinding[]{
  const value=payloadSchema.parse(owner),i=value.identity,contents=[i.managementPrivate,i.managementPublic,i.hostPrivate,i.hostPublic,i.knownHosts,'',value.manifest,value.allocation];
  return windowsSnapshotOwnerFileNames.map((name,index)=>{if(name==='seed.iso')return{name,sha256:value.seedSha256,bytes:value.seedBytes};const bytes=Buffer.from(contents[index]);try{return{name,sha256:sha(bytes),bytes:bytes.length};}finally{bytes.fill(0);}});
 }
 environment(owner:WindowsSnapshotOwnerPayload):Environment{
  const value=payloadSchema.parse(owner);return {...value.config,id:value.id,instanceName:vmIdentity(value.id).name,createdAt:value.createdAt,updatedAt:new Date().toISOString(),state:'stopped',lastError:null,browserRunning:false};
 }
}
