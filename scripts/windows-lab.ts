import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localFixtures, LAB_EXIT } from './windows/local-fixtures.ts';
import { HyperVRuntime, fileHash } from '../server/platform/windows/runtime.ts';
import { windowsConfigSchema, PROBE_PORT, vmIdentity } from '../server/platform/windows/config.ts';
import { WindowsNetworkSession } from '../server/platform/windows/session.ts';
import {run} from '../server/process.ts';
import {powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';

// Explicit destructive-fault lab, operating only on a freshly allocated test
// VM with no user files/accounts. It never opens a browser or an AI website.
async function main(){
  if(process.platform!=='win32')throw Error('Windows is required');
  const [image,imageSha256]=process.argv.slice(2);
  if(!image||!imageSha256)throw Error('Usage: npm run windows:lab -- <Canonical-VHD-path> <SHA-256>');
  const root=process.env.MU_WINDOWS_DATA_DIR??path.join(process.env.LOCALAPPDATA!,'MuCodeSandbox-WindowsPreview');
  const runtime=new HyperVRuntime(root);const doctor=await runtime.info();
  if(!doctor.available)throw Error(doctor.issues.join('; '));
  const id=randomUUID(),directory=path.join(root,`lab-${id}`);await mkdir(directory,{recursive:true});
  const codeFiles=['scripts/windows-lab.ts','scripts/windows/local-fixtures.ts','scripts/windows/hyperv.ps1','native/windows/HyperVChannel.cs','server/platform/windows/runtime.ts','server/platform/windows/guest.ts','server/platform/windows/channel.ts','server/platform/windows/config.ts','server/platform/windows/session.ts','server/network-guard.ts','server/guest-lease.ts','server/transparent-network.ts'];
  const sourceHashes=Object.fromEntries(await Promise.all(codeFiles.map(async file=>[file,await fileHash(file)])));
  const openssl=process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  const fixtures=await localFixtures(path.join(directory,'fixtures'),openssl);
  const c=windowsConfigSchema.parse({version:1,id,image:path.resolve(image),imageSha256,proxy:{mode:'http',address:'127.0.0.1',port:fixtures.port},expectedIp:LAB_EXIT,dns:fixtures.dns});
  await writeFile(path.join(directory,'config.json'),JSON.stringify(c,null,2));
  const results:{name:string;passed:boolean}[]=[];let session:WindowsNetworkSession|undefined;let created=false,sourceStable=true;
  const curl=(ip:string,probe:boolean)=>runtime.management(c,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin',
    'curl','-q','--fail','--silent','--show-error','--max-time','3','--connect-timeout','2','--cacert','/etc/mucodesandbox/lab-ca.crt',
    ...(probe?['--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,'--noproxy','']:['--proxy','','--noproxy','*']),`https://${ip}/`],{timeoutMs:10000});
  const check=(name:string)=>{results.push({name,passed:true});console.log('PASS '+name);};
  const startSession=async()=>{
    await runtime.start(c);session=await runtime.session(c,async()=>Promise.all(fixtures.probeHosts.map(async(receiver)=>({receiver,ip:JSON.parse(await curl(receiver,true)).ip}))));
    await runtime.connect(c);await session.open();
  };
  try {
    // The image must already contain nftables/curl/python3 and pinned amd64
    // sing-box. Network-free lab never runs apt through an Internet proxy.
    await runtime.create(c);created=true;await runtime.start(c);
    await runtime.management(c,['sudo','tee','/etc/mucodesandbox/lab-ca.crt'],{input:fixtures.certificate});
    await runtime.management(c,['sudo','tee','/usr/local/share/ca-certificates/mu-local-fixture.crt'],{input:fixtures.certificate});
    await runtime.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
    session=await runtime.session(c,async()=>Promise.all(fixtures.probeHosts.map(async(receiver)=>({receiver,ip:JSON.parse(await curl(receiver,true)).ip}))));
    await runtime.connect(c);
    await assert.rejects(curl(fixtures.receivers[0],false));results.push({name:'Business traffic blocked before verification',passed:true});
    await session.open();assert.equal(session.state,'active');results.push({name:'Two local HTTPS receipts required before activation',passed:true});
    assert.equal(JSON.parse(await curl(fixtures.receivers[0],false)).ip,LAB_EXIT);results.push({name:'Developer TCP goes through the approved tunnel',passed:true});
    const dnsBefore=fixtures.counters().dnsRequests;
    assert.equal(JSON.parse(await curl('receiver.mu.test',false)).ip,LAB_EXIT);assert.ok(fixtures.counters().dnsRequests>dnsBefore);check('Developer DNS uses the controlled local DoH receiver');
    let streamLines=0,streamBuffer='';const streamAbort=new AbortController();
    const streaming=runtime.management(c,['sudo','-n','-H','-u','dev','--','env','-i','PATH=/usr/bin:/bin','python3','-u','-c',
      "import ssl,urllib.request\nc=ssl.create_default_context(cafile='/etc/mucodesandbox/lab-ca.crt')\nr=urllib.request.urlopen('https://203.0.113.10/stream',context=c,timeout=10)\nwhile r.readline(): print('MU_STREAM_RECEIPT',flush=True)"],
      {timeoutMs:75000,signal:streamAbort.signal,onOutput:text=>{streamBuffer+=text;for(;;){const end=streamBuffer.indexOf('\n');if(end<0)break;if(streamBuffer.slice(0,end).includes('MU_STREAM_RECEIPT'))streamLines++;streamBuffer=streamBuffer.slice(end+1);}}}).then(()=>true,()=>false);
    const streamDeadline=Date.now()+5000;while(streamLines<3){assert.ok(Date.now()<streamDeadline,'Streaming connection did not start');await delay(100);}
    await assert.rejects(runtime.management(c,['sudo','-n','-H','-u','dev','--','curl','-q','--max-time','2','--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,`https://${fixtures.receivers[0]}/`],{timeoutMs:6000}));
    results.push({name:'Developer cannot use the privileged probe exception',passed:true});
    await assert.rejects(runtime.management(c,['sudo','-n','-H','-u','dev','--','curl','-q','--max-time','2','--proxy','','--noproxy','*',`http://${vmIdentity(id).host}:${fixtures.port}/`],{timeoutMs:6000}));
    results.push({name:'Direct access to host services is blocked',passed:true});
    console.log('Waiting 46 seconds without renewal to test the kernel permit expiry.');
    await delay(46000);
    const expiredLines=streamLines;await delay(3000);assert.equal(streamLines,expiredLines);check('Kernel expiry blocks an already established TLS stream');streamAbort.abort();await streaming;
    await assert.rejects(curl(fixtures.receivers[0],false));results.push({name:'Expired kernel permit blocks new business connections',passed:true});
    await assert.rejects(session.tick());assert.equal(session.state,'failed');results.push({name:'Expired session cannot renew itself',passed:true});
    assert.equal((await runtime.inspectVm(c)).state,'Off');results.push({name:'Failed protection stops the owned VM',passed:true});
    await startSession();
    fixtures.interrupt();await assert.rejects(session!.tick());assert.equal((await runtime.inspectVm(c)).state,'Off');check('Upstream interruption closes the session and stops the VM');fixtures.restore();
    await startSession();
    await runtime.management(c,['sudo','nft','add','rule','inet','mu_egress','output','counter','drop']);
    await assert.rejects(session!.tick());assert.equal((await runtime.inspectVm(c)).state,'Off');check('Changed kernel firewall rules quarantine the VM');
    await startSession();
    await runtime.management(c,['sudo','ip','rule','add','priority','16001','table','main']);
    await assert.rejects(session!.tick());assert.equal((await runtime.inspectVm(c)).state,'Off');check('Changed policy routing quarantines the VM');
    await startSession();
    fixtures.setConflict(true);await assert.rejects(session!.tick());assert.equal((await runtime.inspectVm(c)).state,'Off');check('A conflicting exit receipt closes the environment');fixtures.setConflict(false);
    await startSession();
    fixtures.setDnsAvailable(false);await assert.rejects(session!.tick());assert.equal((await runtime.inspectVm(c)).state,'Off');check('Controlled DNS failure cannot fall back to another route');fixtures.setDnsAvailable(true);
    await startSession();
    await run(powershellPath(),powershellArgs(`Add-VMNetworkAdapterExtendedAcl -VMName '${vmIdentity(c.id).name}' -Action Deny -Direction Outbound -LocalIPAddress ANY -RemoteIPAddress ANY -Weight 2`));
    await assert.rejects(session!.tick());assert.equal((await runtime.state(c)).state,'Off');check('Changed Hyper-V ACLs still allow independently verified quarantine shutdown');
  } finally {
    try{if(session)await session.fail();else {await runtime.disconnect();if(created)await runtime.stop(c);}}finally{await fixtures.close();
      const currentHashes=Object.fromEntries(await Promise.all(codeFiles.map(async file=>[file,await fileHash(file)])));
      sourceStable=JSON.stringify(sourceHashes)===JSON.stringify(currentHashes);
      await writeFile(path.join(directory,'results.json'),JSON.stringify({version:2,scope:'kernel-network-and-faults',synthetic:true,aiWebsitesVisited:0,realAccountTests:0,sourceHashes,sourceChangedDuringTest:!sourceStable,results,counters:fixtures.counters(),complete:sourceStable&&results.length===16},null,2));}
  }
  if(!sourceStable)throw Error('Acceptance source changed while the experiment was running');
  console.log(JSON.stringify({passed:results.length,complete:results.length===16,aiWebsitesVisited:0},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message.replace(/(?:https?|socks5h?):\/\/\S+/g,'[redacted URL]'):'Local Windows lab failed');process.exitCode=1;});
