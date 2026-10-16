import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalProxy,portOpen } from '../server/local-proxy.ts';
import { run } from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-local-line-check-'));
const source=path.join(homedir(),'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml');
const digest=async()=>createHash('sha256').update(await readFile(source)).digest('hex');
const before=await digest(),proxy=new LocalProxy(owned);
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),accountFree:true,paidModelCalls:0,samples:[],scope:'Dedicated local Vietnam node, two public TLS IP receipts and short HTTP stability; not VM leak or full-day proof'};
try{
  const info=await proxy.info();const node=info.nodes.find((n:any)=>/Vietnam|越南|🇻🇳/i.test(n.name));assert.ok(node);
  const selected=await proxy.start(node.name);report.selected=selected;
  for(let n=0;n<10;n++){
    const start=performance.now();
    const output=await run('/usr/bin/curl',['-q','--proxy',`http://127.0.0.1:${selected.port}`,'--noproxy','','--fail','--silent','--show-error','--max-time','15','https://ipwho.is/'],{timeoutMs:18000,maxBytes:65536});
    const ip=JSON.parse(output);assert.equal(ip.success,true);assert.equal(ip.country_code,'VN');
    report.samples.push({at:new Date().toISOString(),ip:ip.ip,country:ip.country,countryCode:ip.country_code,latencyMs:Math.round(performance.now()-start)});
    console.log(JSON.stringify({sample:n+1,country:ip.country_code,latencyMs:report.samples.at(-1).latencyMs}));
    if(n<9)await delay(2000);
  }
  const other=(await run('/usr/bin/curl',['-q','--proxy',`http://127.0.0.1:${selected.port}`,'--noproxy','','--fail','--silent','--max-time','15','https://api.ipify.org'],{timeoutMs:18000,maxBytes:256})).trim();
  assert.equal(other,report.samples[0].ip);assert.equal(new Set(report.samples.map((s:any)=>s.ip)).size,1);
  report.secondReceipt={source:'api.ipify.org',ip:other};assert.equal(await digest(),before);report.originalConfigUnchanged=true;report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
  await proxy.close();report.localPortClosed=!await portOpen(24897);assert.equal(await digest(),before);
  await rm(owned,{recursive:true,force:true});report.testResourcesRemoved=true;report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,'test-results/local-line-vietnam.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,error:report.error,samples:report.samples.length,localPortClosed:report.localPortClosed}));
}
