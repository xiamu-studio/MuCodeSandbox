import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localFixtures, LAB_EXIT } from './windows/local-fixtures.ts';
import { HyperVRuntime } from '../server/platform/windows/runtime.ts';
import { windowsConfigSchema, PROBE_PORT, vmIdentity } from '../server/platform/windows/config.ts';
import { WindowsNetworkSession } from '../server/platform/windows/session.ts';

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
  const openssl=process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  const fixtures=await localFixtures(path.join(directory,'fixtures'),openssl);
  const c=windowsConfigSchema.parse({version:1,id,image:path.resolve(image),imageSha256,proxy:{mode:'http',address:'127.0.0.1',port:fixtures.port},expectedIp:LAB_EXIT});
  const results:{name:string;passed:boolean}[]=[];let session:WindowsNetworkSession|undefined;let created=false;
  const curl=(ip:string,probe:boolean)=>runtime.management(c,['sudo','-n','-H','-u',probe?'mu-probe':'dev','--','env','-i','PATH=/usr/bin:/bin',
    'curl','-q','--fail','--silent','--show-error','--max-time','3','--connect-timeout','2','--cacert','/etc/mucodesandbox/lab-ca.crt',
    ...(probe?['--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,'--noproxy','']:['--proxy','','--noproxy','*']),`https://${ip}/`],{timeoutMs:10000});
  try {
    // The image must already contain nftables/curl/python3 and pinned amd64
    // sing-box. Network-free lab never runs apt through an Internet proxy.
    await runtime.create(c);created=true;await runtime.start(c);await runtime.connect(c);
    await runtime.management(c,['sudo','tee','/etc/mucodesandbox/lab-ca.crt'],{input:fixtures.certificate});
    session=await runtime.session(c,async()=>Promise.all(fixtures.receivers.map(async(receiver)=>({receiver,ip:JSON.parse(await curl(receiver,true)).ip}))));
    await assert.rejects(curl(fixtures.receivers[0],false));results.push({name:'Business traffic blocked before verification',passed:true});
    await session.open();assert.equal(session.state,'active');results.push({name:'Two local HTTPS receipts required before activation',passed:true});
    assert.equal(JSON.parse(await curl(fixtures.receivers[0],false)).ip,LAB_EXIT);results.push({name:'Developer TCP goes through the approved tunnel',passed:true});
    await assert.rejects(runtime.management(c,['sudo','-n','-H','-u','dev','--','curl','-q','--max-time','2','--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,`https://${fixtures.receivers[0]}/`],{timeoutMs:6000}));
    results.push({name:'Developer cannot use the privileged probe exception',passed:true});
    await assert.rejects(runtime.management(c,['sudo','-n','-H','-u','dev','--','curl','-q','--max-time','2','--proxy','','--noproxy','*',`http://${vmIdentity(id).host}:${fixtures.port}/`],{timeoutMs:6000}));
    results.push({name:'Direct access to host services is blocked',passed:true});
    console.log('Waiting 46 seconds without renewal to test the kernel permit expiry.');
    await delay(46000);
    await assert.rejects(curl(fixtures.receivers[0],false));results.push({name:'Expired kernel permit blocks new business connections',passed:true});
    await assert.rejects(session.tick());assert.equal(session.state,'failed');results.push({name:'Expired session cannot renew itself',passed:true});
    assert.equal((await runtime.inspectVm(c)).state,'Off');results.push({name:'Failed protection stops the owned VM',passed:true});
  } finally {
    try{if(session)await session.fail();else {await runtime.disconnect();if(created)await runtime.stop(c);}}finally{await fixtures.close();
      await writeFile(path.join(directory,'results.json'),JSON.stringify({version:1,synthetic:true,aiWebsitesVisited:0,realAccountTests:0,results,counters:fixtures.counters(),complete:results.length===8},null,2));}
  }
  console.log(JSON.stringify({passed:results.length,complete:results.length===8,aiWebsitesVisited:0},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message.replace(/(?:https?|socks5h?):\/\/\S+/g,'[redacted URL]'):'Local Windows lab failed');process.exitCode=1;});
