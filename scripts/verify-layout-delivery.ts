import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),results=path.join(root,'test-results');
const installed='/Users/staff/Applications/MuCodeSandbox.app',app=path.join(installed,'Contents/Resources/app');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
const signature=await run('/usr/bin/codesign',['-d','--verbose=4',installed]);
const cdHash=signature.match(/^CDHash=(.+)$/m)![1];
const build=JSON.parse(await readFile(path.join(app,'build-info.json'),'utf8'));
assert.deepEqual(build,JSON.parse(await readFile(path.join(root,'build-info.json'),'utf8')));
const previous=JSON.parse(await readFile(path.join(results,'installed-usability-evidence.json'),'utf8'));
const modules:Record<string,string>={};
for(const file of(await readdir(path.join(root,'dist-server/server'))).filter(f=>f.endsWith('.js'))){
  modules[file]=sha(await readFile(path.join(app,'dist-server/server',file)));
  assert.equal(modules[file],previous.compiledModuleBinding[file],`Unexpected backend change ${file}`);
  assert.equal(modules[file],sha(await readFile(path.join(root,'dist-server/server',file))));
}
const layout=JSON.parse(await readFile(path.join(results,'layout-ui.json'),'utf8'));assert.ok(layout.passed);
assert.deepEqual(layout.viewports.map((v:any)=>v.viewport.width),[1360,1000,860,390]);
assert.ok(layout.viewports.every((v:any)=>!v.bodyOverflow&&!v.contentOverflow&&v.bottomGap>=17&&v.content.y>=v.bar.bottom));
assert.ok(layout.scrolled.scrollTop>0);assert.equal(layout.afterNavigation.scrollTop,0);
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
assert.equal(new URL(info.url).hostname,'127.0.0.1');assert.equal(new URL(info.launchUrl).origin,new URL(info.url).origin);
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'};
const snapshot=await(await fetch(`${info.url}/api/snapshot`,{headers})).json() as any;
assert.equal(snapshot.system.version,'0.4.2');assert.equal(snapshot.system.application.buildId,build.buildId);
const e=snapshot.environments.find((e:any)=>e.name==='越南线路测试');assert.ok(e.state==='running'&&e.browserRunning&&e.network.strict&&e.network.transparent);
const response=await fetch(`${info.url}/api/environments/${e.id}/network/test`,{method:'POST',headers}),exit=await response.json() as any;
assert.equal(response.status,200);assert.equal(exit.source,'guest');assert.match(exit.country,/^Viet(?:nam| Nam)$/i);
const protection=await(await fetch(`${info.url}/api/environments/${e.id}/network/protection`,{headers})).json() as any;
assert.ok(protection.active&&protection.integrity==='verified'&&protection.leaseActive);
const original=snapshot.environments.find((e:any)=>e.id==='69716f45-c7b5-4020-bf84-8f8e6a616ea0');assert.equal(original.state,'stopped');
const screenshot=await readFile(path.join(results,'native-vietnam-browser.png'));assert.ok(screenshot.length>1000);
const report={passed:true,checkedAt:new Date().toISOString(),version:'0.4.2',build,cdHash,installed,backendModulesUnchanged:true,
  backendModuleCount:Object.keys(modules).length,compiledModuleBinding:modules,layoutChecks:layout,exit,protection,
  environmentId:e.id,originalVmStopped:true,accountFree:true,paidModelCalls:0,
  screenshotSha256:sha(screenshot),scope:'Frontend layout and native separate browser window, one live guest egress check and native IPinfo page observation. Historical 0.4.1 runtime fault tests were not rerun or relabeled.'};
await writeFile(path.join(results,'layout-delivery.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,version:'0.4.2',buildId:build.buildId,cdHash,backendModuleCount:Object.keys(modules).length,country:exit.country,ip:exit.ip}));
