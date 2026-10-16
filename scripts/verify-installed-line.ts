import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const origin=new URL(info.url);assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert.equal(new URL(info.launchUrl).origin,origin.origin);
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'};
const initial=await(await fetch(`${info.url}/api/snapshot`,{headers})).json() as any;
const e=initial.environments.find((e:any)=>e.name==='越南线路测试');assert.ok(e&&e.state==='running'&&e.network.strict&&e.network.transparent);
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),version:initial.system.version,application:initial.system.application,
  environmentId:e.id,environmentName:e.name,accountFree:true,paidModelCalls:0,samples:[],scope:'Installed desktop package, real saved Vietnam VM/line and ten short TLS egress requests; not full-day or all-site proof'};
try{
  for(let n=0;n<10;n++){
    const response=await fetch(`${info.url}/api/environments/${e.id}/network/test`,{method:'POST',headers});const result=await response.json() as any;
    assert.equal(response.status,200,JSON.stringify(result));assert.match(result.country,/^Viet(?:nam| Nam)$/i);assert.equal(result.source,'guest');
    report.samples.push({at:new Date().toISOString(),...result});console.log(JSON.stringify({sample:n+1,country:result.country,latencyMs:result.latencyMs}));
    if(n<9)await delay(2000);
  }
  assert.equal(new Set(report.samples.map((s:any)=>s.ip)).size,1);
  report.protection=await(await fetch(`${info.url}/api/environments/${e.id}/network/protection`,{headers})).json();
  assert.ok(report.protection.active&&report.protection.integrity==='verified'&&report.protection.leaseActive);
  report.localChecks=await(await fetch(`${info.url}/api/lab/checks`,{headers})).json();
  report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,'test-results/installed-vietnam-line.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({passed:report.passed,samples:report.samples.length,error:report.error}));
}
