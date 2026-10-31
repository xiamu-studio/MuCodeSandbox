import {test} from 'node:test';import assert from 'node:assert/strict';import {access,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {HyperVBrokerClient,type BrokerAction} from '../server/platform/windows/broker.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
const id='12345678-1234-4234-8234-123456789abc',quote=(v:string)=>"'"+path.resolve(v).replaceAll("'","''")+"'";
test('Real Windows pipe and production request handling carry the synthetic compaction lifecycle',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-compact-ipc-')),nonce=randomBytes(32).toString('hex'),client=new HyperVBrokerClient(nonce);
 const script=`& ${quote('tests/fixtures/windows-disk-compaction-rpc.ps1')} -Directory ${quote(root)} -Native ${quote('native/windows')} -TransactionFixture ${quote('tests/fixtures/windows-disk-compaction-broker.ps1')} -OwnerPid ${process.pid} -Nonce '${nonce}'`;
 const child=spawn(powershellPath(),powershellArgs(script),{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout!.on('data',b=>{out+=b.toString();});child.stderr!.on('data',b=>{err+=b.toString();});
 const ended=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('IPC fixture failed '+code+': '+err)));});void ended.catch(()=>{});
 try{
  const deadline=Date.now()+12000;while(!out.includes('READY')){if(child.exitCode!==null)throw Error(err);assert.ok(Date.now()<deadline,'IPC fixture did not start: '+err);await new Promise(r=>setTimeout(r,20));}
  assert.deepEqual(await client.call('disk-compact-status',{id}),{pending:false});
  await assert.rejects(client.call('disk-compact-begin',{id,path:'C:\\foreign.vhdx'}));
  const begin=await client.call('disk-compact-begin',{id}) as {phase:string};assert.equal(begin.phase,'preparing');
  const pipe='\\\\.\\pipe\\MuCodeSandbox-Broker-'+nonce,probe=`const net=require('node:net');const p=net.connect(${JSON.stringify(pipe)});p.on('connect',()=>p.write(JSON.stringify({action:'disk-compact-status',id:process.argv[1]})+'\\n'));p.on('data',x=>{process.stdout.write(x);p.end();});p.on('error',()=>process.exit(2));`;
  const foreign=spawnSync(process.execPath,['-e',probe,id],{encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(foreign.status,0,foreign.stderr);assert.equal(JSON.parse(foreign.stdout).code,'DENIED');
  await assert.rejects(client.call('start',{id}),{code:'DISK_COMPACTION_PENDING'});
  await assert.rejects(client.call('disk-compact-run',{id}));
  assert.equal(await client.call('disk-compact-start',{id}),'started');await client.call('stop',{id});
  assert.equal((await client.call('disk-compact-trimmed',{id}) as {phase:string}).phase,'armed');
  assert.equal((await client.call('disk-compact-run',{id}) as {phase:string}).phase,'verifying');
  assert.equal(await client.call('disk-compact-verify-start',{id}),'started');await client.call('stop',{id});
  const review=await client.call('disk-compact-review',{id}) as {beforeBytes:number;afterBytes:number};assert.equal(review.beforeBytes,5*2**30);assert.equal(review.afterBytes,3*2**30);
  const result=await client.call('disk-compact-finish',{id,filesystemBytes:31*2**30,partitionBytes:31*2**30,partitionStartBytes:128*2**20,afterBytes:review.afterBytes}) as {completed:boolean};assert.equal(result.completed,true);
  assert.deepEqual(await client.call('disk-compact-status',{id}),{pending:false});
  await client.call('disk-compact-begin',{id});await client.call('disk-compact-start',{id});await client.call('stop',{id});await client.call('disk-compact-trimmed',{id});await client.call('fixture-async-pending' as BrokerAction);
  await assert.rejects(client.call('disk-compact-run',{id}),{code:'DISK_COMPACTION_RUNNING'});const running=await client.call('disk-compact-status',{id}) as {phase:string;jobTracked:boolean};assert.equal(running.phase,'compacting');assert.equal(running.jobTracked,true);
  await assert.rejects(client.call('disk-compact-reconcile',{id}),{code:'DISK_COMPACTION_RUNNING'});await client.call('fixture-async-ready' as BrokerAction);
  assert.equal((await client.call('disk-compact-reconcile',{id}) as {phase:string}).phase,'verifying');await client.call('disk-compact-verify-start',{id});await client.call('stop',{id});
  const resumed=await client.call('disk-compact-review',{id}) as {afterBytes:number};await client.call('disk-compact-finish',{id,filesystemBytes:31*2**30,partitionBytes:31*2**30,partitionStartBytes:128*2**20,afterBytes:resumed.afterBytes});
  await client.call('disk-compact-begin',{id});await client.call('disk-compact-start',{id});await client.call('stop',{id});await client.call('disk-compact-trimmed',{id});await client.call('fixture-hold' as BrokerAction);
  const controller=new AbortController(),inFlight=client.call('disk-compact-run',{id},{signal:controller.signal,timeoutMs:5000});void inFlight.catch(()=>{});
  const until=Date.now()+5000;while(!await access(path.join(root,'compact-entered')).then(()=>true,()=>false)){assert.ok(Date.now()<until,'Synthetic provider did not start');await new Promise(r=>setTimeout(r,10));}
  controller.abort();await assert.rejects(inFlight,{code:'CANCELLED'});
  const pending=await client.call('disk-compact-status',{id},{timeoutMs:5000}) as {pending:boolean;phase:string;jobTracked:boolean|null};assert.equal(pending.pending,true);assert.equal(pending.phase,'compacting');assert.equal(pending.jobTracked,null);
  await assert.rejects(client.call('disk-compact-run',{id},{timeoutMs:2000}));
  await client.call('shutdown');await ended;
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill();await ended.catch(()=>{});}assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-compact-ipc-/);await rm(root,{recursive:true,force:true});
 }
});
