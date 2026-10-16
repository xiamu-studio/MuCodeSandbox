import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packetLines } from './packet-capture.ts';
import { run } from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),results=path.join(root,'test-results');
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bytes=await readFile(path.join(results,'usability-runtime.json')),r=JSON.parse(bytes.toString());
assert.ok(r.passed&&r.inputsUnchanged&&r.testResourcesRemoved&&r.oldViewerRevoked&&r.vmKeptRunning&&r.symlinkRejected);
assert.equal(r.accountFree,true);assert.equal(r.paidModelCalls,0);
const phases=r.stages.filter((s:any)=>s.recoveredEmpty).map((s:any)=>s.name).sort();
assert.deepEqual(phases,['interruption cleaned','interruption detached','interruption intent','interruption published']);
for(const row of r.stages.filter((s:any)=>s.name==='empty local identity'))assert.deepEqual(row.result,{cookie:false,localStorage:null,indexedDB:null});
assert.equal(r.localCheck.state,'passed');assert.equal(r.localCheck.checks.length,6);assert.ok(r.localCheck.checks.every((c:any)=>c.passed));
assert.match(r.guestExit.country,/^Viet(?:nam| Nam)$/i);assert.equal(r.guestExit.source,'guest');
assert.deepEqual(r.configurationBefore.network,r.configurationAfter.network);assert.equal(r.configurationBefore.id,r.configurationAfter.id);
for(const[file,expected]of Object.entries(r.inputs)){
  assert.equal(digest(await readFile(path.join(r.artifacts,'inputs',file))),expected);
  assert.equal(digest(await readFile(path.join(root,file))),expected);
}
const capture=await readFile(r.capture.file);assert.equal(digest(capture),r.capture.sha256);assert.equal(capture.length,r.capture.bytes);
const packets=await packetLines(r.capture.file,'ifindex 2 and outbound and (ip or ip6)');assert.equal(packets.length,r.capture.physicalOut);assert.ok(packets.length>0);
assert.deepEqual(packets.filter(line=>/\sIP6\s/.test(line)||!(line.includes(`.22 > ${r.capture.gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line))),[]);
const bundle=path.join(root,'release/usability-final-candidate/mac-arm64/MuCodeSandbox.app'),app=path.join(bundle,'Contents/Resources/app');
await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
const signature=await run('/usr/bin/codesign',['-d','--verbose=4',bundle]);const cdHash=signature.match(/^CDHash=(.+)$/m)![1];
const modules:Record<string,string>={};
for(const file of(await readdir(path.join(root,'dist-server/server'))).filter(f=>f.endsWith('.js'))){
  const compiled=await readFile(path.join(root,'dist-server/server',file));assert.equal(digest(await readFile(path.join(app,'dist-server/server',file))),digest(compiled));modules[file]=digest(compiled);
}
const installed='/Users/staff/Applications/MuCodeSandbox.app';await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
assert.equal((await run('/usr/bin/codesign',['-d','--verbose=4',installed])).match(/^CDHash=(.+)$/m)![1],cdHash);
const evidence={passed:true,checkedAt:new Date().toISOString(),sourceReportSha256:digest(bytes),sourceRuntimeVerified:true,
  currentInstalledBundle:installed,currentBundleCdHash:cdHash,compiledModuleBinding:modules,
  physicalOut:packets.length,unapproved:0,resetInterruptionPoints:phases,localChecks:6,accountFree:true,paidModelCalls:0,
  scope:'Independent raw source/pcap and compiled-module binding for the selected real-VM source scenarios. Signature and desktop opening do not substitute for actual packaged live-VM acceptance; that is recorded separately.'};
await writeFile(path.join(results,'usability-runtime-evidence.json'),JSON.stringify(evidence,null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,currentCdHash:cdHash,physicalOut:packets.length,unapproved:0,moduleCount:Object.keys(modules).length}));
