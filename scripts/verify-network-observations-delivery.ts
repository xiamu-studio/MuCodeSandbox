import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run } from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),results=path.join(root,'test-results');
const installed='/Users/staff/Applications/MuCodeSandbox.app',app=path.join(installed,'Contents/Resources/app');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
const cdHash=(await run('/usr/bin/codesign',['-d','--verbose=4',installed])).match(/^CDHash=(.+)$/m)![1];
const build=JSON.parse(await readFile(path.join(app,'build-info.json'),'utf8'));
assert.deepEqual(build,JSON.parse(await readFile(path.join(root,'build-info.json'),'utf8')));
const modules:Record<string,string>={};
for(const name of ['network-observations','manager','service','store','transparent-network']){
  const file=`dist-server/server/${name}.js`;modules[name]=hash(await readFile(path.join(app,file)));assert.equal(modules[name],hash(await readFile(path.join(root,file))));
}
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
assert.equal(new URL(info.url).hostname,'127.0.0.1');assert.equal(new URL(info.launchUrl).origin,new URL(info.url).origin);
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
const snapshot=await(await fetch(`${info.url}/api/snapshot`,{headers})).json() as any;
assert.equal(snapshot.system.version,'0.4.4');assert.equal(snapshot.system.application.buildId,build.buildId);
const e=snapshot.environments.find((e:any)=>e.name==='越南线路测试');assert.equal(e.state,'running');
assert.equal(snapshot.environments.find((e:any)=>e.id==='69716f45-c7b5-4020-bf84-8f8e6a616ea0').state,'stopped');
const endpoint=`${info.url}/api/environments/${e.id}/network/observations`;
assert.equal((await fetch(endpoint)).status,401);
const observed=await(await fetch(endpoint,{headers})).json() as any;
assert.equal(observed.capture,'ready');assert.ok(observed.connections.length>0);assert.ok(observed.samples.length>=4);
assert.deepEqual(new Set(observed.samples.map((s:any)=>s.provider)),new Set(['ipwho','ipify']));
assert.equal(observed.summary.state,'unchanged');assert.equal(observed.summary.distinctIps,1);assert.equal(observed.summary.failures,0);assert.ok(observed.summary.successes>=4);
assert.equal(observed.lockIp,null);assert.equal(observed.captureGaps,0);
for(const c of observed.connections){assert.ok(c.target&&c.port>0);assert.ok(['attempt','failed','dns-result','dns-cached'].includes(c.status));assert.ok(['proxy','proxy-dns'].includes(c.route));}
assert.ok(observed.connections.some((c:any)=>c.protocol==='DNS'));
const protection=await(await fetch(`${info.url}/api/environments/${e.id}/network/protection`,{headers})).json() as any;
assert.ok(protection.active&&protection.integrity==='verified'&&protection.leaseActive);
const env={...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},cli='/Users/staff/.mucodesandbox/tools/lima/bin/limactl';
const namespace=(await run(cli,['shell',e.instanceName,'systemctl','show','mucodesandbox-tunnel.service','--property=LogNamespace','--value'],{env})).trim();assert.equal(namespace,'mucodesandbox-network');
const limits=await run(cli,['shell',e.instanceName,'cat','/etc/systemd/journald@mucodesandbox-network.conf.d/limits.conf'],{env});assert.match(limits,/RuntimeMaxUse=8M/);assert.match(limits,/Storage=volatile/);
const unit=await readFile(path.join(results,'network-observations-unit-tests.log'),'utf8');assert.match(unit,/tests 171/);assert.match(unit,/fail 0/);
const shots:Record<string,string>={};for(const file of ['native-network-observations.png','native-network-events.png']){const b=await readFile(path.join(results,file));assert.ok(b.length>1000);shots[file]=hash(b);}
const report={passed:true,checkedAt:new Date().toISOString(),version:'0.4.4',build,cdHash,installed,modules,
  environmentId:e.id,observed,protection,journal:{namespace,limits},unitTests:171,screenshots:shots,originalVmStopped:true,
  scope:'Actual installed app, Vietnam VM, native log UI, two anonymous public exit receipts and transparent proxy connection metadata; not full packet capture, per-connection public IP proof or long-term stability.',accountFree:true,paidModelCalls:0};
await writeFile(path.join(results,'network-observations-delivery.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,buildId:build.buildId,cdHash,samples:observed.samples.length,connections:observed.connections.length,exitIp:observed.summary.lastIp,unitTests:171}));
