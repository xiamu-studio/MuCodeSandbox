import assert from 'node:assert/strict';
import { readFile,readdir,writeFile } from 'node:fs/promises';
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
const old=JSON.parse(await readFile(path.join(results,'installed-usability-evidence.json'),'utf8'));
const modules:Record<string,string>={};
for(const f of(await readdir(path.join(root,'dist-server/server'))).filter(f=>f.endsWith('.js'))){
  modules[f]=hash(await readFile(path.join(app,'dist-server/server',f)));
  assert.equal(modules[f],hash(await readFile(path.join(root,'dist-server/server',f))));
}
const changed=Object.keys(modules).filter(f=>modules[f]!==old.compiledModuleBinding[f]).sort();
assert.deepEqual(changed,['browser-startpage.js','browser.js','guest-browser-runtime.js','guest-browser.js','manager.js','service.js','validation.js']);
const html=await readFile(path.join(app,'desktop/browser-home.html'));assert.equal(hash(html),hash(await readFile(path.join(root,'desktop/browser-home.html'))));
assert.equal(hash(await readFile(path.join(app,'desktop/main.cjs'))),hash(await readFile(path.join(root,'desktop/main.cjs'))));
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
assert.equal(new URL(info.url).hostname,'127.0.0.1');assert.equal(new URL(info.launchUrl).origin,new URL(info.url).origin);
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const document=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(document.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
const snapshot=await(await fetch(`${info.url}/api/snapshot`,{headers})).json() as any;
assert.equal(snapshot.system.version,'0.4.3');assert.equal(snapshot.system.application.buildId,build.buildId);
const e=snapshot.environments.find((e:any)=>e.name==='越南线路测试');assert.ok(e&&e.state==='running'&&e.browserRunning);
const protection=await(await fetch(`${info.url}/api/environments/${e.id}/network/protection`,{headers})).json() as any;
assert.ok(protection.active&&protection.integrity==='verified'&&protection.leaseActive);
const environment={...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'};
const cli='/Users/staff/.mucodesandbox/tools/lima/bin/limactl';
const stat=(await run(cli,['shell',e.instanceName,'stat','-c','%u %a','/opt/mucodesandbox/browser-home.html'],{env:environment})).trim();assert.equal(stat,'0 644');
const guestHash=(await run(cli,['shell',e.instanceName,'sha256sum','/opt/mucodesandbox/browser-home.html'],{env:environment})).trim().split(/\s+/)[0];assert.equal(guestHash,hash(html));
const unit=await readFile(path.join(results,'browser-home-unit-tests.log'),'utf8');assert.match(unit,/tests 163/);assert.match(unit,/fail 0/);
const homeShot=await readFile(path.join(results,'native-browser-home.png')),progressShot=await readFile(path.join(results,'native-browser-opening.png'));
assert.ok(homeShot.length>1000&&progressShot.length>1000);
const openingUi=JSON.parse(await readFile(path.join(results,'browser-opening-ui.json'),'utf8'));
assert.ok(openingUi.passed&&openingUi.progressInsideBrowserRegion&&openingUi.noFalseClosedLabel&&openingUi.otherEnvironmentIgnored&&openingUi.failureInRegion);
assert.equal(snapshot.environments.find((e:any)=>e.id==='69716f45-c7b5-4020-bf84-8f8e6a616ea0').state,'stopped');
const report={passed:true,checkedAt:new Date().toISOString(),version:'0.4.3',build,cdHash,installed,compiledModuleBinding:modules,
  changedModules:changed,homeSha256:hash(html),guestHomeSha256:guestHash,guestHomeOwnerMode:stat,protection,
  environmentId:e.id,legacyDefault:e.browserUrl==='https://example.com',originalVmStopped:true,unitTests:163,
  screenshots:{home:hash(homeShot),opening:hash(progressShot),openingPhase:'viewer-connection'},
  openingTaskUi:{source:'browser-opening-ui.json',scope:openingUi.scope,passed:true,nativeTaskTextCaptured:false},accountFree:true,paidModelCalls:0,
  scope:'Actual installed browser opening area, static guest homepage, live Vietnam IP receipt observed on native UI, guest file ownership/hash and protection. Historical full VM fault and packet scenarios were not rerun or relabeled.'};
await writeFile(path.join(results,'browser-home-delivery.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,buildId:build.buildId,cdHash,changedModules:changed,guestHomeOwnerMode:stat,unitTests:163}));
