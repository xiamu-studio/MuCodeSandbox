import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Environment} from '../../../shared/types.ts';
import type {Store} from '../../store.ts';
import {AppError} from '../../errors.ts';
import {windowsEnvironmentConfiguration} from './backup-bundle.ts';
import {WindowsSnapshotOwnerCodec,type WindowsSnapshotOwnerPayload} from './snapshot-owner.ts';
import {windowsSnapshotCipher,type WindowsSnapshotTransaction,type WindowsSnapshotOutcome} from './snapshots.ts';

const id=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000'),digest=z.string().regex(/^[a-f0-9]{64}$/);
const binding=z.object({id,platformId:id,imageSha256:digest,seedSha256:digest,seedBytes:z.number().int().min(32774).max(8*2**20),cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256)}).strict();
const version=z.object({cipher:windowsSnapshotCipher,binding}).strict();
const plan=z.object({format:z.literal(1),id,transactionId:id,snapshotId:id,createdAt:z.string().datetime(),prior:version,target:version}).strict();
export type WindowsSnapshotReplayPlan=z.infer<typeof plan>;
export interface WindowsSnapshotReplayEntry {value:WindowsSnapshotReplayPlan;encrypted:string}
export const snapshotCipherDigest=(cipher:string)=>createHash('sha256').update(cipher,'utf8').digest('hex');
export function snapshotOwnerBinding(owner:WindowsSnapshotOwnerPayload){return binding.parse({id:owner.id,platformId:owner.platformId,imageSha256:owner.imageSha256,seedSha256:owner.seedSha256,seedBytes:owner.seedBytes,cpus:owner.config.cpus,memoryGiB:owner.config.memoryGiB,diskGiB:owner.config.diskGiB});}
const failure=()=>new AppError('快照恢复日志、环境配置或事务身份不一致，原资料已保留',409,'SNAPSHOT_REPLAY');

// Windows-only tables in the same private SQLite database as the encrypted
// environment configuration. No plaintext keys/configuration enter this journal.
export class WindowsSnapshotReplayJournal {
 readonly store:Store;readonly codec:WindowsSnapshotOwnerCodec;
 constructor(store:Store,codec:WindowsSnapshotOwnerCodec){
  this.store=store;this.codec=codec;store.db.exec(`PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS windows_snapshot_replays(environment_id TEXT PRIMARY KEY,transaction_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS windows_snapshot_replay_history(transaction_id TEXT PRIMARY KEY,environment_id TEXT NOT NULL,payload TEXT NOT NULL);`);
 }
 private atomic<T>(work:()=>T):T{this.store.db.exec('BEGIN IMMEDIATE');try{const value=work();this.store.db.exec('COMMIT');return value;}catch(error){this.store.db.exec('ROLLBACK');throw error;}}
 private checked(input:unknown){
  const value=plan.parse(input);for(const item of [value.prior,value.target]){if(item.binding.id!==value.id||item.binding.platformId!==value.target.binding.platformId)throw failure();this.codec.decode(item.cipher,item.binding);}return value;
 }
 pending(){
  const rows=this.store.db.prepare('SELECT environment_id FROM windows_snapshot_replays LIMIT 33').all() as {environment_id:string}[];if(rows.length>32)throw failure();return rows.map(row=>id.parse(row.environment_id));
 }
 has(environmentId:string){id.parse(environmentId);return !!this.store.db.prepare('SELECT 1 FROM windows_snapshot_replays WHERE environment_id=?').get(environmentId);}
 get(environmentId:string):WindowsSnapshotReplayEntry|null{
  id.parse(environmentId);const row=this.store.db.prepare('SELECT transaction_id,CASE WHEN length(payload) BETWEEN 1 AND 2097152 THEN payload ELSE NULL END AS payload FROM windows_snapshot_replays WHERE environment_id=?').get(environmentId) as {transaction_id:string;payload:string|null}|undefined;
  if(!row)return null;
  try{
   if(typeof row.payload!=='string'||!row.payload.startsWith('enc:'))throw failure();const bytes=Buffer.from(row.payload.slice(4),'base64');try{if(bytes.length<=28||bytes.toString('base64')!==row.payload.slice(4))throw failure();}finally{bytes.fill(0);}
   const plain=this.store.decrypt(row.payload);if(Buffer.byteLength(plain)>1100*1024)throw failure();const value=this.checked(JSON.parse(plain));if(value.id!==environmentId||value.transactionId!==row.transaction_id)throw failure();return{value,encrypted:row.payload};
  }catch{throw failure();}
 }
 begin(input:WindowsSnapshotReplayPlan,allowMissing=false){
  try{return this.atomic(()=>{
   const value=this.checked(input);if(this.has(value.id))throw failure();this.assertAllowedValue(value,allowMissing);
   const plain=JSON.stringify(value);if(Buffer.byteLength(plain)>1100*1024)throw failure();const encrypted=this.store.encrypt(plain);if(encrypted.length>2*1024*1024)throw failure();
   this.store.db.prepare('INSERT INTO windows_snapshot_replays VALUES(?,?,?)').run(value.id,value.transactionId,encrypted);return{value,encrypted};
  });}catch{throw failure();}
 }
 private current(environmentId:string){try{return this.store.get(environmentId);}catch(error){if(error instanceof AppError&&error.code==='NOT_FOUND')return null;throw error;}}
 private same(environment:Environment,owner:WindowsSnapshotOwnerPayload){return environment.id===owner.id&&environment.instanceName===this.codec.environment(owner).instanceName&&environment.createdAt===owner.createdAt&&JSON.stringify(windowsEnvironmentConfiguration(environment))===JSON.stringify(owner.config);}
 private assertAllowedValue(value:WindowsSnapshotReplayPlan,allowMissing:boolean){
  const current=this.current(value.id);if(!current){if(allowMissing)return;throw failure();}
  if(![value.prior,value.target].some(item=>this.same(current,this.codec.decode(item.cipher,item.binding))))throw failure();
 }
 private exact(entry:WindowsSnapshotReplayEntry){const current=this.get(entry.value.id);if(!current||current.encrypted!==entry.encrypted)throw failure();return current.value;}
 assertAllowed(entry:WindowsSnapshotReplayEntry,allowMissing=false){try{this.assertAllowedValue(this.exact(entry),allowMissing);}catch{throw failure();}}
 selected(entry:WindowsSnapshotReplayEntry,receipt:WindowsSnapshotTransaction){
  try{
   const value=this.exact(entry),selected=receipt.phase==='rolled-back'?value.prior:value.target;
   if(!receipt.pending||!['applied','committed','rolled-back'].includes(receipt.phase)||receipt.id!==value.id||receipt.transactionId!==value.transactionId||receipt.snapshotId!==value.snapshotId||receipt.ownerConfiguration!==selected.cipher)throw failure();
   const owner=this.codec.decode(selected.cipher,receipt);if(JSON.stringify(snapshotOwnerBinding(owner))!==JSON.stringify(selected.binding))throw failure();return owner;
  }catch{throw failure();}
 }
 other(entry:WindowsSnapshotReplayEntry,receipt:WindowsSnapshotTransaction){this.selected(entry,receipt);const item=receipt.phase==='rolled-back'?entry.value.target:entry.value.prior;return this.codec.decode(item.cipher,item.binding);}
 persist(entry:WindowsSnapshotReplayEntry,receipt:WindowsSnapshotTransaction,allowMissing=false){
  try{this.atomic(()=>{const owner=this.selected(entry,receipt);this.assertAllowed(entry,allowMissing);this.store.save(this.codec.environment(owner));this.assertSelected(entry,receipt);});}catch{throw failure();}
 }
 assertSelected(entry:WindowsSnapshotReplayEntry,receipt:WindowsSnapshotTransaction){
  const owner=this.selected(entry,receipt),current=this.current(entry.value.id);if(!current||!this.same(current,owner)||current.state!=='stopped')throw failure();
 }
 archive(entry:WindowsSnapshotReplayEntry,outcome:WindowsSnapshotOutcome){
  try{this.atomic(()=>{
   const value=this.exact(entry),selected=outcome.phase==='rolled-back'?value.prior:value.target;
   if(outcome.acknowledged!==true||!['committed','rolled-back'].includes(outcome.phase)||outcome.id!==value.id||outcome.transactionId!==value.transactionId||outcome.snapshotId!==value.snapshotId||outcome.ownerConfigurationSha256!==snapshotCipherDigest(selected.cipher))throw failure();
   for(const key of Object.keys(selected.binding) as (keyof typeof selected.binding)[])if(outcome[key]!==selected.binding[key])throw failure();
   const old=this.store.db.prepare('SELECT environment_id,payload FROM windows_snapshot_replay_history WHERE transaction_id=?').get(value.transactionId) as {environment_id:string;payload:string}|undefined;
   if(old&&(old.environment_id!==value.id||old.payload!==entry.encrypted))throw failure();if(!old)this.store.db.prepare('INSERT INTO windows_snapshot_replay_history VALUES(?,?,?)').run(value.transactionId,value.id,entry.encrypted);
   // Configuration is deliberately neither read nor written after native ack.
   this.store.db.prepare('DELETE FROM windows_snapshot_replays WHERE environment_id=? AND transaction_id=? AND payload=?').run(value.id,value.transactionId,entry.encrypted);
  });}catch{throw failure();}
 }
}
