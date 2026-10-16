import assert from 'node:assert/strict';
import { createService } from '../server/service.ts';
import { LEASE_HELPER_PATH } from '../server/guest-lease.ts';
import { measureEgress } from '../server/egress.ts';

const root=process.argv[2],directory=process.argv[3],proxyPort=Number(process.argv[4]);
assert.ok(directory?.split('/').at(-1)?.startsWith('.mu-lease-verification-'));
assert.ok(Number.isInteger(proxyPort)&&proxyPort>0);
const service=await createService({rootDir:root,dataDir:directory,port:0});
const {manager}=service;
let environmentId=manager.store.list()[0]?.id;
const renew=manager.runtime.renewLease.bind(manager.runtime);
const activationChecks:unknown[]=[];
let probeDiagnostic:unknown;
manager.runtime.renewLease=async(e,activate,options)=>{
  if(activate){
    const closed=await manager.runtime.networkProtection({...e,state:'running'},false);
    assert.equal(closed.active,true);assert.equal(closed.leaseActive,false);
    await assert.rejects(manager.runtime.guest({...e,state:'running'},['python3','-c','import socket; s=socket.create_connection(("203.0.113.60",80),2);s.settimeout(2);s.sendall(b"PRE\\n");print(s.recv(128).decode())'],{timeoutMs:5000}));
    await manager.runtime.management(e,['bash','-c','sudo systemctl reset-failed mu-lease-probe-capture.service 2>/dev/null || true; sudo systemd-run --quiet --unit=mu-lease-probe-capture --property=Type=exec /usr/bin/tcpdump --immediate-mode -U -i any -s 128 -w /tmp/mu-lease-probe.pcap']);
    let measured;
    try { measured=await measureEgress(manager.runtime,e); }
    catch(error){
      probeDiagnostic={rules:await manager.runtime.management(e,['sudo','nft','-j','list','table','inet','mu_lease']),packets:await manager.runtime.management(e,['sudo','tcpdump','-nn','-r','/tmp/mu-lease-probe.pcap'])};
      throw error;
    }finally{await manager.runtime.management(e,['sudo','systemctl','stop','mu-lease-probe-capture.service']);}
    activationChecks.push({leasePrepared:closed.leasePrepared,leaseActive:closed.leaseActive,businessDenied:true,productionTlsMeasurementWithBusinessClosed:measured});
  }
  return renew(e,activate,options);
};
process.on('message',async(message:any)=>{
  try {
    let result:unknown;
    if(message.op==='start'){
      await manager.reconcile(true);
      if(!environmentId){
        const e=await manager.create({name:'Lease crash verification',cpus:2,memoryGiB:2,diskGiB:10,network:{mode:'http',host:'127.0.0.1',port:proxyPort,username:'mu',password:'lease-fixture',strict:true,transparent:true}});
        environmentId=e.id;
      }else if(manager.store.get(environmentId).network.port!==proxyPort){
        // Preserve the product's conservative-stop requirement when a failed test's proxy port changes.
        const previous=manager.store.get(environmentId);
        await manager.runtime.start(previous,{});
        await manager.runtime.stop(previous);
        manager.store.state(environmentId,'stopped');
        const {id,instanceName,state,lastError,createdAt,updatedAt,browserRunning,...config}=manager.store.get(environmentId);
        await manager.update(environmentId,{...config,network:{...config.network,port:proxyPort}});
      }
      const job=await manager.lifecycle(environmentId,manager.store.get(environmentId).state==='running'?'restart':'start');
      await manager.tasks.get(job.id)?.promise;
      const finished=manager.store.jobs().find(item=>item.id===job.id)!;
      assert.equal(finished.status,'succeeded',finished.message);
      result={environment:manager.store.get(environmentId),activationChecks};
    } else if(message.op==='access')result=await manager.assertAccess(environmentId!);
    else if(message.op==='close'){
      await service.close();process.send?.({id:message.id,result:{closed:true}});process.disconnect();return;
    } else if(message.op==='session') {
      const text=await manager.runtime.management(manager.store.get(environmentId!),['sudo','cat','/run/mucodesandbox-lease/state']);
      result={session:JSON.parse(text).session,helper:LEASE_HELPER_PATH};
    } else throw new Error('Unknown fixture action');
    process.send?.({id:message.id,result});
  } catch(error) {process.send?.({id:message.id,error:String(error),probeDiagnostic,logs:environmentId?manager.store.logs(environmentId).slice(-30):[]});}
});
process.send?.({ready:true});
