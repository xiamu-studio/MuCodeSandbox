import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),bytes=await readFile(path.join(root,'test-results/host-commands.json'));
const report=JSON.parse(bytes.toString()),hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
assert.equal(report.passed,true);assert.equal(report.actualVmTested,true);assert.equal(report.actualElectronPackageTested,false);
assert.equal(report.accountFree,true);assert.equal(report.paidModelCalls,0);assert.equal(report.testResourcesRemoved,true);assert.equal(report.nativeBoundaryTestsPassed,true);
assert.deepEqual(report,JSON.parse(await readFile(path.join(report.artifactsDirectory,'report.json'),'utf8')));
for(const [file,digest] of Object.entries(report.sources))assert.equal(hash(await readFile(path.join(root,file))),digest);
for(const [file,digest] of Object.entries(report.artifacts))assert.equal(hash(await readFile(path.join(report.artifactsDirectory,file))),digest);
assert.equal(report.sources['native/host-command.sb'],report.sources['native/bin/host-command.sb']);
const tests=await readFile(path.join(report.artifactsDirectory,'native-tests.txt'),'utf8');
assert.match(tests,/\btests 6\b/);assert.match(tests,/\bpass 6\b/);assert.match(tests,/\bfail 0\b/);assert.match(tests,/\bskipped 0\b/);
assert.equal(report.commands.status.exitCode,0);assert.match(report.commands.status.output,/ M notes.txt/);
assert.equal(report.commands.diff.exitCode,0);assert.match(report.commands.diff.output,/MU_HOST_COMMAND_CHANGED/);
for(const key of ['unapprovedRejected','extraArgumentsRejected','hostSchemaRejected'])assert.equal(report.commands[key],true);
assert.equal(report.uiRevocationRejectedOldToken,true);assert.equal(report.environmentStopRevokedCommands,true);assert.equal(report.auditContainsNoOutput,true);assert.deepEqual(report.uiErrors,[]);
assert.ok(report.before.active&&report.after.active);assert.equal(report.before.integrity,'verified');assert.equal(report.after.integrity,'verified');assert.equal(report.before.firewallHash,report.after.firewallHash);
assert.ok(report.mobileBounds.scroll<=report.mobileBounds.width);
const capture=await readFile(path.join(report.artifactsDirectory,'commands.pcap'));assert.equal(capture.length,report.capture.bytes);assert.equal(hash(capture),report.capture.sha256);
const decoded=await run('/usr/sbin/tcpdump',['-nn','-r',path.join(report.artifactsDirectory,'commands.pcap'),'ifindex 2 and outbound and (ip or ip6)']);
const physical=decoded.split('\n').filter(line=>/^\d\d:\d\d:\d\d\.\d+\s/.test(line));assert.equal(physical.length,report.capture.physicalPackets);assert.ok(physical.length>0);
const bad=physical.filter(line=>/\sIP6\s/.test(line)||!(line.includes(`.22 > ${report.capture.gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)));assert.deepEqual(bad,[]);assert.equal(report.capture.unapproved,0);
const result={passed:true,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),nativeTests:6,sourceAndNativeBinaryAndArtifactHashesVerified:true,
  actualVmAndUiAuthorization:true,physicalPackets:physical.length,unapproved:0,testResourcesRemoved:true,
  scope:'Independent source web UI / VM receipt and guest capture; saved six actual native boundary tests with positive controls; no Electron package, arbitrary shell, signed Network Extension or root-compromise claim'};
await writeFile(path.join(root,'test-results/host-commands-evidence.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));
