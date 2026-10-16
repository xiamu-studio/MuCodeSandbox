// Production access only through the already running desktop service. No Store/Manager.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run } from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be';
const installed='/Users/staff/Applications/MuCodeSandbox.app';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
assert.equal(new URL(info.url).hostname,'127.0.0.1');
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown) {
  const response=await fetch(info.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
}
const report:Record<string,any>={passed:false,checkedAt:new Date().toISOString(),scope:'Installed native app and actual protected VM; no real account login or paid models'};
try {
  const before=await api('/api/snapshot');assert.equal(before.system.version,'0.4.9');assert.ok(!before.jobs.some((j:any)=>j.status==='running'));
  report.version=before.system.version;report.buildId=before.system.application.buildId;report.pid=info.pid;
  const e=before.environments.find((e:any)=>e.id===id);assert.ok(e);assert.equal(e.network.port,24898);assert.equal(e.network.egressLock.expectedIp,'166.88.36.199');
  await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
  report.cdHash=(await run('/usr/bin/codesign',['-d','--verbose=4',installed])).match(/^CDHash=(\S+)/m)![1];
  report.modules={};
  for(const file of ['server/network-observations.js','server/manager.js','server/store.js','shared/network-observations.js']) {
    const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
    const actual=sha(await readFile(path.join(installed,'Contents/Resources/app/dist-server',file)));
    assert.equal(actual,sha(await readFile(path.join(root,'dist-server',file))));report.modules[file]=actual;
  }
  if(process.argv.includes('--restart')) {
    const job=await api(`/api/environments/${id}/actions/restart`,{});
    let completed=false;for(let i=0;i<120;i++) {
      const state=await api('/api/snapshot'),j=state.jobs.find((j:any)=>j.id===job.id);
      if(j&&['succeeded','failed','cancelled'].includes(j.status)){assert.equal(j.status,'succeeded',j.message);completed=true;break;}
      await new Promise(r=>setTimeout(r,500));
    }assert.ok(completed,'Environment restart exceeded 60 seconds');
  }
  await api(`/api/environments/${id}/network/test`,{});
  report.googleRequest=await run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',e.instanceName,'sudo','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/local/bin:/usr/bin:/bin','/usr/bin/curl','-q','--max-time','15','--output','/dev/null','--write-out','HTTP %{http_code}\n','https://www.google.com/'],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},timeoutMs:20_000,maxBytes:1024});
  let rows:any[]=[];
  for(let i=0;i<40;i++) {
    const data=await api(`/api/environments/${id}/network/observations`);
    rows=data.connections.filter((c:any)=>c.exitIp&&c.domain);
    if(rows.some(c=>c.domain==='www.google.com')&&rows.some(c=>c.domainSource==='connection')){report.capture=data.capture;break;}
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(rows.some(c=>c.domain==='www.google.com'),'Real website destination not observed');
  assert.ok(rows.some(c=>c.domainSource==='connection'),'Actual per-connection requested domain not observed');
  assert.ok(rows.every(c=>c.exitIp==='166.88.36.199'));
  assert.ok(rows.every(c=>Date.parse(c.exitCheckedAt)<=Date.parse(c.at)));
  report.examples=[...rows.filter(c=>c.domain==='www.google.com').slice(-1),...rows.filter(c=>c.domainSource==='connection').slice(-3)];
  report.protection=await api(`/api/environments/${id}/network/protection`);assert.ok(report.protection.active&&report.protection.integrity==='verified'&&report.protection.leaseActive);
  report.egress=await api(`/api/environments/${id}/network/egress`);assert.equal(report.egress.status,'verified');assert.equal(report.egress.actualIp,'166.88.36.199');
  const after=await api('/api/snapshot');assert.equal(after.environments.find((e:any)=>e.id===id).state,'running');
  assert.equal(after.environments.find((e:any)=>e.id==='8c3bb910-a957-4982-92cc-772fae923446').state,'stopped');
  report.profilesReset=false;report.networkConfigurationChanged=false;report.passed=true;
} catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally {report.finishedAt=new Date().toISOString();await writeFile(path.join(root,'test-results/network-destinations/installed.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,version:report.version,buildId:report.buildId,exit:report.egress?.actualIp,domains:report.examples?.map((c:any)=>c.domain),error:report.error}));}
