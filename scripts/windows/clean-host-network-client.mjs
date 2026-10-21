// Runs as the synthetic standard user inside the disconnected Windows guest.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createWindowsService} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/service.js';
import {HyperVRuntime} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
import {PROBE_PORT} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/config.js';
import {localFixtures,LAB_EXIT} from 'file:///C:/MuLab/product/resources/app/dist-server/scripts/windows/local-fixtures.js';

export async function networkAcceptance(client,nonce,pass){
 const directory='C:/MuLab/public',fixtures=await localFixtures('C:/MuLab/network-fixtures','unused',LAB_EXIT,undefined,undefined,{reuseCertificate:true}),results=[];
 const request=async(kind,operation)=>{
  const name=`network-${kind}-${operation}`,target=`${directory}/${name}.json`;
  await writeFile(target+'.next',JSON.stringify({nonce,kind,operation}));await rename(target+'.next',target);
  const until=performance.now()+30000;
  for(;;){try{const receipt=JSON.parse(await readFile(`C:/MuLab/approved/${name}.json`,'utf8'));assert.equal(receipt.nonce,nonce);assert.equal(receipt.complete,true);return receipt;}catch(error){if(error.code!=='ENOENT')throw error;assert.ok(performance.now()<until,'The guest network operator did not acknowledge '+name);await delay(100);}}
 };
 class LocalRuntime extends HyperVRuntime{
  async start(c,options={}){
   await super.start(c,options);
   for(const file of ['/etc/mucodesandbox/lab-ca.crt','/usr/local/share/ca-certificates/mu-local-fixture.crt'])await this.management(c,['sudo','tee',file],{input:fixtures.certificate});
   await this.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
  }
 }
 try{
  const base=JSON.parse(await readFile('C:/MuLab/images/base.json','utf8'));
  for(const kind of ['link','dns','route']){
   await request(kind,'reset');
   const runtime=new LocalRuntime(`${directory}/network-${kind}-runtime`,undefined,client);
   const curl=(c,receiver,probe=false)=>runtime.management(c,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','4','--connect-timeout','2','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',probe?`socks5h://127.0.0.1:${PROBE_PORT}`:'','--noproxy',probe?'':'*',`https://${receiver}/`],{timeoutMs:10000});
   let service,c,streamAbort,stream;
   const result={kind,started:false,detected:false,confirmedOff:false,removed:false};results.push(result);
   try{
    service=await createWindowsService({rootDir:'C:/MuLab/product/resources/app',dataDir:`${directory}/network-${kind}-app`,runtimeRoot:runtime.root,base,runtime,
     probe:config=>async()=>Promise.all(fixtures.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await curl(config,receiver,true)).ip})))});
    const e=await service.manager.create({name:`Synthetic ${kind} transition`,cpus:2,memoryGiB:4,diskGiB:32,network:{mode:'http',host:'127.0.0.1',port:fixtures.port,strict:true,transparent:true,egressLock:{expectedIp:LAB_EXIT},dns:fixtures.dns}});
    c=await service.manager.profile(service.manager.store.get(e.id));result.id=c.id;
    const job=await service.manager.action(e.id,'start');await service.manager.wait(job.id);
    assert.equal(service.manager.store.jobs().find(item=>item.id===job.id).status,'succeeded');assert.equal((await runtime.state(c)).state,'Running');
    assert.equal(JSON.parse(await curl(c,fixtures.receivers[0])).ip,LAB_EXIT);assert.equal((await service.manager.protection(c.id)).integrity,'verified');result.started=true;
    pass(`Before the ${kind} transition, the real nested Linux VM has a verified permit and reaches only local TLS receivers`);
    let lines=0,buffer='';streamAbort=new AbortController();
    stream=runtime.management(c,['sudo','-n','-H','-u','dev','--','env','-i','PATH=/usr/bin:/bin','python3','-u','-c',"import ssl,urllib.request\nr=urllib.request.urlopen('https://203.0.113.10/stream',context=ssl.create_default_context(cafile='/etc/mucodesandbox/lab-ca.crt'),timeout=10)\nwhile r.readline(): print('MU_TRANSITION_STREAM',flush=True)"],{timeoutMs:120000,signal:streamAbort.signal,onOutput:text=>{buffer+=text;for(;;){const end=buffer.indexOf('\n');if(end<0)break;if(buffer.slice(0,end).includes('MU_TRANSITION_STREAM'))lines++;buffer=buffer.slice(end+1);}}}).then(()=>true,()=>false);
    let until=performance.now()+10000;while(lines<3){assert.ok(performance.now()<until,'No established TLS stream');await delay(100);}
    result.beforeFingerprint=await runtime.fingerprint();result.mutation=await request(kind,'mutate');
    until=performance.now()+30000;
    while(service.manager.store.get(c.id).state!=='error'){assert.ok(performance.now()<until,'Actual Windows host change was not detected');await delay(100);}
    assert.equal((await service.manager.snapshot()).system.hostNetwork.state,'failed');assert.notEqual(await runtime.fingerprint(),result.beforeFingerprint);result.detected=true;
    assert.equal((await runtime.state(c)).state,'Off');result.confirmedOff=true;
    pass(`The production host monitor detects the actual Windows ${kind} change and confirms the nested VM is Off`);
    const stoppedLines=lines;await delay(1000);assert.equal(lines,stoppedLines);await assert.rejects(curl(c,fixtures.receivers[0]));
    await assert.rejects(service.manager.action(c.id,'start'),{code:'HOST_NETWORK_CHANGED'});
    pass(`After the ${kind} change, old and new business traffic stop and the existing application cannot restart the environment`);
   }finally{
    streamAbort?.abort();await stream;await service?.close();
    if(c){await runtime.stop(c);assert.equal((await runtime.state(c)).state,'Off');await runtime.remove(c);result.removed=true;}
   }
   pass(`The ${kind} test removes only its stopped nested VM, private switch and files`);
  }
  return {cases:results,removed:results.every(r=>r.removed),scope:'actual-adapter-dns-route-changes-inside-disconnected-windows-vm'};
 }finally{await fixtures.close();}
}
