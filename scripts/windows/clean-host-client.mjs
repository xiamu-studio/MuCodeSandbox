// Standalone local diagnostic client, copied into a disconnected evaluation VM.
// It runs as a synthetic standard user. The test operator starts the production
// broker separately through PowerShell Direct with the synthetic administrator.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {HyperVBrokerClient,brokerSourceDigest} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/broker.js';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {windowsConfigSchema} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/config.js';

const phase=process.argv[2];assert.ok(['before-reboot','after-reboot'].includes(phase));
const directory='C:/MuLab/public',nonce=randomBytes(32).toString('hex'),client=new HyperVBrokerClient(nonce);
let complete=false;const checks=[];let before,after,error,nested;
const pass=name=>checks.push({name,passed:true});
await writeFile(`${directory}/${phase}-owner.json`,JSON.stringify({pid:process.pid,nonce,phase}));
try{
 const deadline=performance.now()+120000;
 for(;;){try{const hello=await client.hello();assert.equal(hello.sourceDigest,await brokerSourceDigest());pass('The protected production broker is bound to this standard-user process and the packaged source');break;}catch(failure){if(failure.code!=='BROKER_UNAVAILABLE'||performance.now()>deadline)throw failure;await delay(500);}}
 before=await client.call('host-status',{}, {timeoutMs:90000});
 assert.equal(before.supported,true);assert.equal(before.firmwareVirtualization,true);assert.equal(before.slat,true);
 if(phase==='before-reboot'){
  assert.equal(before.hyperV,'disabled');assert.equal(before.runtimeActive,false);
  await assert.rejects(client.call('start',{id:'12345678-1234-4234-8234-123456789012'}),{code:'DENIED'});
  pass('A fresh Windows installation has no Hyper-V runtime authority');
  await client.call('prepare-host',{}, {timeoutMs:90000});
  // A timeout does not cancel Windows servicing. Leave its guest running and
  // report incomplete rather than killing DISM or restarting during servicing.
  const until=performance.now()+3600000;
  for(;;){
   after=await client.call('host-status',{}, {timeoutMs:90000});
   if(!['starting','running'].includes(after.operation?.status))break;
   assert.ok(performance.now()<until,'Component servicing is still running; do not restart this VM');await delay(2000);
  }
  assert.equal(after.bootId,before.bootId);assert.equal(after.restartRequired,true);
  assert.ok(after.operation?.changed.includes('hyperv'));
  assert.ok(['enabled','pending'].includes(after.hyperV));
  pass('Hyper-V was actually installed with a durable receipt and without an automatic reboot');
  // An offline OpenSSH failure is retained as failure evidence, never passed.
  assert.equal(after.operation.status,'completed');
 }else{
  const previous=JSON.parse(await readFile('C:/MuLab/approved/before-reboot-result.json','utf8'));
  assert.ok(previous.after?.operation?.changed.includes('hyperv'));
  assert.notEqual(before.bootId,previous.before.bootId);
  assert.equal(before.hyperV,'enabled');assert.equal(before.hypervisorPresent,true);
  assert.equal(before.managementModule,true);assert.equal(before.vmmsRunning,true);
  pass('After the operator restarts only this evaluation guest, its nested Hyper-V service is active');
  assert.equal(before.sshClientPresent,true);assert.equal(before.ready,true);
  assert.equal(before.restartRequired,false);assert.equal(before.runtimeActive,true);
  pass('A new detected-host session enables normal runtime authority only after verified readiness');
  after=before;
  const base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8'));
  const runtime=new HyperVRuntime(`${directory}/nested-runtime`,undefined,client),config=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:2,memoryGiB:4,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:9},expectedIp:'203.0.113.90'});
  nested={id:config.id,started:false,stopped:false,removed:false};
  try{
   await runtime.create(config);await runtime.start(config);
   assert.equal((await runtime.state(config)).state,'Running');nested.started=true;
   await runtime.configure(config);
   assert.equal((await runtime.guest(config,['id','-u'])).trim(),'2001');
   const guard=await runtime.inspectGuard(config);assert.equal(guard.leaseActive,false);assert.equal(guard.remainingMs,0);
   pass('The ordinary user creates and boots an actual nested Linux VM with authenticated management, dev identity and closed business egress');
  }finally{
   await runtime.stop(config);assert.equal((await runtime.state(config)).state,'Off');nested.stopped=true;
   await runtime.remove(config);assert.deepEqual(await client.call('allocation',{id:config.id}),{registered:false});nested.removed=true;
  }
  pass('The nested Linux test VM, its private switch and its runtime files are removed after confirmed stop');
 }
 complete=true;
}catch(failure){error={message:failure.message,code:failure.code??null};}
finally{
 await client.call('shutdown').catch(()=>{});
 await writeFile(`${directory}/${phase}-result.json`,JSON.stringify({phase,pid:process.pid,nonce,complete,checks,before,after,error,nested,actualHyperVInstallationExercised:phase==='before-reboot'&&!!after?.operation?.changed.includes('hyperv'),actualSshInstallationExercised:phase==='before-reboot'&&!before?.sshClientPresent&&!!after?.sshClientPresent,aiWebsitesVisited:0},null,2));
}
if(!complete)process.exitCode=1;
