import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),results=path.join(root,'test-results');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const installed='/Users/staff/Applications/MuCodeSandbox.app';
const candidate=path.join(root,'release/usability-final-candidate/mac-arm64/MuCodeSandbox.app');
const app=path.join(installed,'Contents/Resources/app');
await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
const signature=await run('/usr/bin/codesign',['-d','--verbose=4',installed]);
const cdHash=signature.match(/^CDHash=(.+)$/m)![1];
assert.equal((await run('/usr/bin/codesign',['-d','--verbose=4',candidate])).match(/^CDHash=(.+)$/m)![1],cdHash);
const build=JSON.parse(await readFile(path.join(app,'build-info.json'),'utf8'));
assert.deepEqual(build,JSON.parse(await readFile(path.join(root,'build-info.json'),'utf8')));
const previous=JSON.parse(await readFile(path.join(results,'usability-runtime-evidence.json'),'utf8'));
const modules:Record<string,string>={};
for(const file of(await readdir(path.join(root,'dist-server/server'))).filter(f=>f.endsWith('.js'))){
  modules[file]=sha(await readFile(path.join(root,'dist-server/server',file)));
  assert.equal(sha(await readFile(path.join(app,'dist-server/server',file))),modules[file]);
}
const changedModules=Object.keys(modules).filter(f=>previous.compiledModuleBinding[f]!==modules[f]);
assert.deepEqual(changedModules,['guest-browser.js']);
const source=JSON.parse(await readFile(path.join(results,'usability-runtime.json'),'utf8'));
const changedInputs:string[]=[];
for(const[file,expected]of Object.entries(source.inputs)){
  assert.equal(sha(await readFile(path.join(source.artifacts,'inputs',file))),expected);
  if(sha(await readFile(path.join(root,file)))!==expected)changedInputs.push(file);
}
assert.deepEqual(changedInputs,['server/guest-browser.ts']);
const line=JSON.parse(await readFile(path.join(results,'installed-vietnam-line.json'),'utf8'));
assert.equal(line.passed,true);assert.equal(line.samples.length,10);assert.equal(line.application.buildId,build.buildId);
const check=line.localChecks.find((r:any)=>r.environmentId===line.environmentId);
assert.equal(check.state,'passed');assert.equal(check.checks.length,6);assert.ok(check.checks.every((c:any)=>c.passed));
assert.ok(Date.parse(check.checkedAt)>Date.parse(build.builtAt));
const unit=await readFile(path.join(results,'usability-unit-tests-latest.log'),'utf8');
assert.match(unit,/tests 158/);assert.match(unit,/fail 0/);
const report={passed:true,checkedAt:new Date().toISOString(),version:'0.4.1',build,cdHash,installed,
  compiledModuleBinding:modules,changedModules,changedInputs,originalRuntimeReportSha256:previous.sourceReportSha256,
  historicalRuntimeScope:'Reset fault recovery and capture remain bound to the archived source inputs and previous module binding. The current delta only suppresses viewer publication during a background check.',
  currentPackagedScope:'Current installed build, native UI lab run, six local checks and ten real Vietnam guest egress requests. No full-day, all-site leak, platform account or signing acceptance.',
  latestLocalCheck:check,lineSamples:line.samples.length,accountFree:true,paidModelCalls:0,unitTests:158};
await writeFile(path.join(results,'installed-usability-evidence.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,buildId:build.buildId,cdHash,unitTests:158,localChecks:6,lineSamples:10,changedModules}));
