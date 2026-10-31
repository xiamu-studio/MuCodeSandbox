import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,open,rename,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openWindowsStore,secureWindowsDirectory} from '../../server/platform/windows/credentials.ts';
import {windowsPaths,vmIdentity} from '../../server/platform/windows/config.ts';
import {WindowsSnapshotCoordinator} from '../../server/platform/windows/snapshot-coordinator.ts';
import {snapshotOwnerBinding,snapshotCipherDigest} from '../../server/platform/windows/snapshot-replay-journal.ts';
import {windowsEnvironmentConfiguration} from '../../server/platform/windows/backup-bundle.ts';
import {environmentSchema} from '../../server/validation.ts';
import {run,type RunOptions} from '../../server/process.ts';
import type {Environment} from '../../shared/types.ts';
import type {Store} from '../../server/store.ts';
import type {BrokerAction} from '../../server/platform/windows/broker.ts';
import type {WindowsSnapshotOwnerPayload} from '../../server/platform/windows/snapshot-owner.ts';
import type {WindowsSnapshotTransaction,WindowsSnapshotOutcome} from '../../server/platform/windows/snapshots.ts';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
type Role={cipher:string;binding:ReturnType<typeof snapshotOwnerBinding>;config:WindowsSnapshotOwnerPayload['config'];createdAt:string;seed:string;files:{name:string;sha256:string}[]};
type State={id:string;platformId:string;snapshotId:string;roles:{prior:Role;target:Role};current:'prior'|'target';active:null|{transactionId:string;phase:WindowsSnapshotTransaction['phase'];before:'prior'|'target';prior:Role;target:Role};history:Record<string,WindowsSnapshotOutcome>};

// Native authority is a deliberately named fixture. Ordinary production codec,
// DPAPI, SQL configuration/journal and Windows file/ACL replay are real here.
export class SnapshotNativeFixture {
 readonly root:string;readonly runtimeRoot:string;readonly store:Store;state:State;calls:BrokerAction[]=[];
 faults:{prepareLost?:boolean;commitLost?:boolean;ackLost?:boolean;beforeCommit?:()=>void|Promise<void>;afterCommit?:()=>void|Promise<void>;afterAck?:()=>void|Promise<void>;afterPrepare?:()=>void|Promise<void>}={};
 constructor(root:string,store:Store,state:State){this.root=root;this.runtimeRoot=path.join(root,'runtime');this.store=store;this.state=state;}
 async save(){const next=path.join(this.root,'native-'+randomUUID()+'.next'),file=await open(next,'wx');try{await file.writeFile(JSON.stringify(this.state));await file.sync();}finally{await file.close();}await rename(next,path.join(this.root,'native.json'));}
 receipt():WindowsSnapshotTransaction{const active=this.state.active;assert.ok(active);const role=active.phase==='rolled-back'?active.prior:active.target;return{pending:true,...role.binding,transactionId:active.transactionId,snapshotId:this.state.snapshotId,phase:active.phase,ownerConfiguration:role.cipher};}
 async verify(role:Role){
  const current=this.store.get(this.state.id);assert.deepEqual(windowsEnvironmentConfiguration(current),role.config);assert.equal(current.createdAt,role.createdAt);assert.equal(current.state,'stopped');
  for(const file of role.files)assert.equal(hash(await readFile(path.join(windowsPaths(this.runtimeRoot,this.state.id).directory,file.name))),file.sha256,file.name);
  const row=this.store.db.prepare('SELECT payload FROM windows_snapshot_replays WHERE environment_id=?').get(this.state.id) as {payload:string}|undefined;assert.ok(row);assert.ok(row.payload.startsWith('enc:'));assert.equal(row.payload.includes(role.config.network.password!),false);
 }
 async call(action:BrokerAction,p:Record<string,unknown>={},options:RunOptions={}):Promise<unknown>{
  options.signal?.throwIfAborted();this.calls.push(action);if(action!=='snapshot-pending')assert.equal(p.id,this.state.id);
  if(action==='snapshot-pending')return{ids:this.state.active?[this.state.id]:[]};
  // This adapter never writes unpublished copies; real retained-copy cases use the native staging fixture.
  if(action==='snapshot-staging')return{entries:[],truncated:false};
  if(action==='snapshot-status')return this.state.active?this.receipt():{pending:false};
  if(action==='snapshot-list'){const target=this.state.roles.target;return[{id:this.state.snapshotId,environmentId:this.state.id,name:'合成完整快照',createdAt:target.createdAt,bytes:3*2**20+target.binding.seedBytes,...Object.fromEntries(['cpus','memoryGiB','diskGiB','imageSha256','seedSha256'].map(k=>[k,target.binding[k as keyof typeof target.binding]]))}];}
  if(action==='snapshot-outcome'){const found=this.state.history[String(p.transactionId)];assert.ok(found,'Acknowledged native fixture decision missing');return structuredClone(found);}
  if(action==='snapshot-prepare'){
   assert.equal(this.state.active,null);assert.equal(p.snapshotId,this.state.snapshotId);const role=this.state.roles[this.state.current];
   for(const key of ['cpus','memoryGiB','diskGiB','imageSha256','seedSha256'] as const)assert.equal(p[key],role.binding[key]);
   const payload=JSON.parse(this.store.decrypt(String(p.ownerConfiguration))) as WindowsSnapshotOwnerPayload;assert.deepEqual(payload.config,role.config);assert.equal(payload.platformId,this.state.platformId);
   this.state.active={transactionId:randomUUID(),phase:'applied',before:this.state.current,prior:{...role,cipher:String(p.ownerConfiguration)},target:this.state.roles.target};this.state.current='target';await this.save();await this.faults.afterPrepare?.();
   if(this.faults.prepareLost){this.faults.prepareLost=false;throw Error('Synthetic lost native preparation reply');}return this.receipt();
  }
  const active=this.state.active;assert.ok(active,'Native fixture operation requires active restore');
  if(action==='snapshot-recover'){
   if(p.transactionId!==undefined)assert.equal(p.transactionId,active.transactionId);if(active.phase!=='committed'){active.phase='rolled-back';this.state.current=active.before;}await this.save();return this.receipt();
  }
  assert.equal(p.transactionId,active.transactionId);
  if(action==='snapshot-seed'){const seed=Buffer.from((active.phase==='rolled-back'?active.prior:active.target).seed,'base64'),offset=Number(p.offset),chunk=seed.subarray(offset,offset+32768);return{data:chunk.toString('base64'),nextOffset:offset+chunk.length,done:offset+chunk.length===seed.length};}
  if(action==='snapshot-commit'){
   assert.equal(active.phase,'applied');await this.verify(active.target);await this.faults.beforeCommit?.();active.phase='committed';await this.save();await this.faults.afterCommit?.();if(this.faults.commitLost){this.faults.commitLost=false;throw Error('Synthetic lost native commit reply');}return this.receipt();
  }
  if(action==='snapshot-acknowledge'){
   assert.ok(['committed','rolled-back'].includes(active.phase));const role=active.phase==='rolled-back'?active.prior:active.target;await this.verify(role);
   const outcome:WindowsSnapshotOutcome={acknowledged:true,...role.binding,transactionId:active.transactionId,snapshotId:this.state.snapshotId,phase:active.phase as 'committed'|'rolled-back',ownerConfigurationSha256:snapshotCipherDigest(role.cipher)};
   this.state.history[active.transactionId]=outcome;this.state.active=null;await this.save();await this.faults.afterAck?.();if(this.faults.ackLost){this.faults.ackLost=false;throw Error('Synthetic lost native acknowledgement reply');}return{acknowledged:true};
  }
  throw Error('Unsupported fixture action '+action);
 }
}

export async function openSnapshotCoordinatorFixture(root:string){
 const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-snapshot-coordinator-/);assert.equal((await lstat(root)).isSymbolicLink(),false);
 const store=await openWindowsStore(path.join(root,'store')),state=JSON.parse(await readFile(path.join(root,'native.json'),'utf8')) as State,broker=new SnapshotNativeFixture(root,store,state),coordinator=new WindowsSnapshotCoordinator(store,path.join(root,'runtime'),broker);
 return{root,store,broker,coordinator,id:state.id,snapshotId:state.snapshotId,environment:()=>store.get(state.id),close:()=>store.close()};
}
export async function snapshotCoordinatorFixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-snapshot-coordinator-'));await secureWindowsDirectory(root);const runtimeRoot=path.join(root,'runtime');await mkdir(runtimeRoot);await secureWindowsDirectory(runtimeRoot);
 const id=randomUUID(),platformId=randomUUID(),snapshotId=randomUUID(),createdAt=new Date().toISOString(),store=await openWindowsStore(path.join(root,'store')),directory=windowsPaths(runtimeRoot,id).directory;await mkdir(directory);await secureWindowsDirectory(directory);
 let coordinator:WindowsSnapshotCoordinator;const roles={} as State['roles'];
 const emptyBroker={call:async()=>{throw Error('No native operations during fixture setup');}};coordinator=new WindowsSnapshotCoordinator(store,runtimeRoot,emptyBroker);
 for(const kind of ['target','prior'] as const){
  const stage=path.join(root,'keys-'+kind);await mkdir(stage);const p=windowsPaths(runtimeRoot,id),keygen=path.join(process.env.SystemRoot!,'System32/OpenSSH/ssh-keygen.exe');
  for(const name of ['management','host-ed25519']){await run(keygen,['-q','-t','ed25519','-N','','-C','synthetic-'+kind,'-f',path.join(stage,name)]);for(const suffix of ['', '.pub'])await copyFile(path.join(stage,name+suffix),path.join(directory,name+suffix));}
  const pub=await readFile(p.key+'.pub','utf8'),host=await readFile(p.hostKey+'.pub','utf8'),seed=Buffer.alloc(49152,0);Buffer.from('CD001').copy(seed,32769);Buffer.from(pub+'\n'+host).copy(seed,40000);await writeFile(p.seed,seed);await writeFile(p.knownHosts,vmIdentity(id).name+' '+host);
  await writeFile(p.manifest,JSON.stringify({version:1,id,platformId,imageSha256:(kind==='target'?'a':'b').repeat(64),purpose:'environment'}));await writeFile(path.join(directory,'allocation.json'),JSON.stringify({version:1,id,backend:'hyperv-broker'}));
  const environment:Environment={...environmentSchema.parse({name:kind==='target'?'快照时配置':'当前配置',cpus:kind==='target'?1:2,memoryGiB:2,diskGiB:kind==='target'?32:40,network:{mode:'http',host:'127.0.0.1',port:7897,password:'SYNTHETIC_'+kind+'_PROXY_PASSWORD',strict:true,transparent:true,egressLock:{expectedIp:kind==='target'?'198.51.100.35':'198.51.100.36'}}}),id,instanceName:vmIdentity(id).name,createdAt,updatedAt:createdAt,state:'stopped',browserRunning:false,lastError:null};store.save(environment);
  const captured=await coordinator.codec.captureState(environment),files=await coordinator.codec.files(captured.owner,seed);try{roles[kind]={cipher:captured.configuration.ownerConfiguration,binding:snapshotOwnerBinding(captured.owner),config:captured.owner.config,createdAt,seed:seed.toString('base64'),files:files.map(v=>({name:v.name,sha256:hash(v.bytes)}))};}finally{seed.fill(0);for(const file of files)file.bytes.fill(0);}
 }
 const state:State={id,platformId,snapshotId,roles,current:'prior',active:null,history:{}},broker=new SnapshotNativeFixture(root,store,state);await broker.save();coordinator=new WindowsSnapshotCoordinator(store,runtimeRoot,broker);
 return{root,store,broker,coordinator,id,snapshotId,environment:()=>store.get(id),close:async()=>{if(store.db.isOpen)store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.equal((await lstat(root)).isSymbolicLink(),false);await rm(root,{recursive:true,force:true});}};
}
