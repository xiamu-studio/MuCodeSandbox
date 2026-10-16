import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';
import { APPROVED_BROWSER_RELEASES, CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { validateBackupBrowser } from './backup-browser-fixture.ts';

const root=path.resolve(import.meta.dirname,'..');
const bytes=await readFile(path.join(root,'test-results/browser-upgrade.json')),report=JSON.parse(bytes.toString());
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
assert.equal(report.passed,true);assert.equal(report.sourceRuntimeTested,true);assert.equal(report.electronPackageTested,false);
assert.equal(report.accountFree,true);assert.equal(report.paidModelCalls,0);assert.equal(report.testResourcesRemoved,true);
assert.equal(report.actualVersionUpgradeTested,true);assert.notEqual(report.versions.previous,report.versions.candidate);
assert.equal(report.versions.previous,APPROVED_BROWSER_RELEASES[0].version);assert.equal(report.versions.candidate,CURRENT_BROWSER_RELEASE.version);
assert.deepEqual(report,JSON.parse(await readFile(path.join(report.artifactsDirectory,'report.json'),'utf8')));
for(const [file,digest] of Object.entries(report.sources))assert.equal(hash(await readFile(path.join(root,file))),digest);
for(const [file,digest] of Object.entries(report.artifacts))assert.equal(hash(await readFile(path.join(report.artifactsDirectory,file))),digest);
assert.equal(report.failedAdoptionRestoredProfile,true);assert.equal(report.checkpointReleasedAfterAdoption,true);
assert.equal(report.failedAdoptionCandidate.product.product.split('/').at(-1),report.versions.candidate);
assert.equal(report.failedAdoptionCandidate.changedLocalStorage,'new-version-mutated');assert.equal(report.failedAdoptionCandidate.cookieChanged,true);assert.equal(report.failedAdoptionCandidate.viewerRejected,true);
assert.equal(report.failedAdoptionCandidate.changedIndexedDB,'new-version-mutated');assert.equal(report.failedAdoptionCandidate.cookieReadback,'new-version-mutated');
validateBackupBrowser(report.failedAdoptionCandidate.receipt);
const killed=report.actualCheckpointProcessKilled;
assert.ok(Number.isInteger(killed.pid)&&killed.pid>1);assert.match(killed.processState.exe,/python3/);assert.match(killed.processState.status,/State:\s+T/);
assert.equal(killed.journal.committed,false);
// Remote observation may end by timeout even after SIGKILL releases the guest lock.
// Actual kill authority comes from the stopped PID, checked signal command and next-operation recovery.
assert.equal(typeof killed.outcome.error,'string');assert.ok(killed.outcome.error.length>0);assert.equal(killed.outcome.succeeded,undefined);
assert.equal(killed.journal.priorRecipe,APPROVED_BROWSER_RELEASES[0].recipe);assert.equal(killed.journal.candidateRecipe,CURRENT_BROWSER_RELEASE.recipe);
assert.deepEqual(report.stages.map((stage:any)=>stage.name),['previous-initial','previous-restored','previous-after-kill','candidate-adopted','candidate-after-restart']);
for(const [index,stage] of report.stages.entries()){
  const version=index<3?report.versions.previous:report.versions.candidate;
  assert.equal(stage.product.product.split('/').at(-1),version);assert.equal(stage.version.installedVersion,version);assert.equal(stage.version.recoveryRequired,false);
  validateBackupBrowser(stage.receipt);if(index>0)assert.deepEqual(stage.receipt.before,stage.receipt.after);
  assert.ok(stage.identity.matchesConfiguration);assert.match(stage.identity.platform,/^Linux/);assert.match(stage.identity.userAgent,/Linux/);
  assertGuestBrowserSandbox(stage.sandbox);assert.ok(stage.protection.active&&stage.protection.integrity==='verified');
  assert.equal(stage.protection.firewallHash,report.stages[1].protection.firewallHash);assert.equal(stage.protection.tunnelConfigHash,report.stages[1].protection.tunnelConfigHash);
}
assert.equal(report.browserEvidence.loginRequests,1);assert.equal(report.captures.length,2);
const captures=[];
for(const capture of report.captures){
  const file=path.join(report.artifactsDirectory,`${capture.name}.pcap`),raw=await readFile(file);
  assert.equal(raw.length,capture.bytes);assert.equal(hash(raw),capture.sha256);
  const decoded=await run('/usr/sbin/tcpdump',['-nn','-r',file,'ifindex 2 and outbound and (ip or ip6)'],{maxBytes:128_000_000});
  const packets=decoded.split('\n').filter(line=>/^\d\d:\d\d:\d\d\.\d+\s/.test(line));assert.equal(packets.length,capture.physicalPackets);
  const approved=packets.filter(line=>line.includes(` > ${capture.gateway}.${capture.proxyPort}:`));assert.equal(approved.length,capture.approvedProxy);assert.ok(approved.length>0);
  const bad=packets.filter(line=>/\sIP6\s/.test(line)||!(line.includes(` > ${capture.gateway}.${capture.proxyPort}:`)||line.includes(`.22 > ${capture.gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)));
  assert.deepEqual(bad,[]);assert.equal(capture.unapproved,0);captures.push({name:capture.name,physicalPackets:packets.length,approvedProxy:approved.length,unapproved:0});
}
const result={passed:true,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),actualOfficialVersions:report.versions,
  sourceAndArtifactHashesVerified:true,actualCheckpointProcessKilled:true,failedAdoptionRestoredProfile:true,
  browserObservations:report.stages.length,captures,testResourcesRemoved:true,
  scope:'Independent saved source-runtime evidence and raw network captures; two official versions, failure rollback and VM restart, not Electron package or power-loss acceptance'};
await writeFile(path.join(root,'test-results/browser-upgrade-evidence.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));
