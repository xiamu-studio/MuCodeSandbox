import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
import { assertGuestBrowserSandbox } from '../server/guest-browser-sandbox.ts';
import { validateBackupBrowser } from './backup-browser-fixture.ts';
import { packetLines } from './packet-capture.ts';
import { APPROVED_BROWSER_RELEASES, CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';

const root=path.resolve(import.meta.dirname,'..'),bridgeOwner=process.argv.includes('--bridge-owner');
const reportName=bridgeOwner?'browser-upgrade-bridge-owner':'browser-upgrade-packaged';
const bytes=await readFile(path.join(root,`test-results/${reportName}.json`));
const report=JSON.parse(bytes.toString()),hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
assert.equal(report.passed,true);assert.equal(report.actualElectronPackageTested,true);assert.equal(report.actualVmUpgradeTested,true);
assert.equal(report.freshDataDirectory,true);assert.equal(report.accountFree,true);assert.equal(report.paidModelCalls,0);assert.equal(report.testResourcesRemoved,true);
assert.equal(report.package.cdHash,bridgeOwner?'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3':'1e2831a747b2e7060f9594ebcd823ebbeb74cc52');assert.equal(report.application.packaged,true);
if(bridgeOwner){
  assert.equal(report.bridgeOwnerPackageTested,true);
  assert.equal(report.package.bundle,path.join(root,'release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app'));
  assert.equal(path.dirname(report.artifactsDirectory),path.join(root,'test-results'));assert.match(path.basename(report.artifactsDirectory),/^browser-upgrade-bridge-owner-\d+$/);
  assert.deepEqual(report.versions,{previous:APPROVED_BROWSER_RELEASES[0].version,candidate:CURRENT_BROWSER_RELEASE.version});
  const modules=(await readdir(path.join(report.package.bundle,'Contents/Resources/app/dist-server/server'))).filter(file=>file.endsWith('.js')).sort();assert.equal(modules.length,45);
  assert.deepEqual(Object.keys(report.package.modules).sort(),['desktop/main.cjs',...modules.map(file=>`dist-server/server/${file}`)].sort());
  assert.deepEqual(Object.keys(report.sources).sort(),['scripts/verify-browser-upgrade-packaged.ts','server/guest-browser-runtime.ts','server/browser-profile-transaction.ts','scripts/backup-browser-fixture.ts','scripts/claude-local-fixture.ts','scripts/packet-capture.ts','server/browser-releases.ts'].sort());
  assert.deepEqual((await readdir(report.artifactsDirectory)).filter(file=>file!=='report.json').sort(),Object.keys(report.artifacts).sort());
}
assert.equal(report.application.appPath,path.join(report.package.bundle,'Contents/Resources/app'));
assert.ok(report.application.renderers.length>0&&report.application.renderers.every((item:any)=>item.sandboxed));
assert.deepEqual(report.uiErrors,[]);assert.equal(report.profileLinkRejected,true);assert.equal(report.corruptCheckpointRejected,true);assert.equal(report.malformedJournalRejected,true);
assert.deepEqual(report,JSON.parse(await readFile(path.join(report.artifactsDirectory,'report.json'),'utf8')));
for(const [file,digest] of Object.entries(report.sources)){
  assert.equal(hash(await readFile(path.join(root,file))),digest);
  if(bridgeOwner)assert.equal(hash(await readFile(path.join(report.artifactsDirectory,`source-${path.basename(file)}`))),digest);
}
for(const [file,digest] of Object.entries(report.artifacts)){assert.equal(path.basename(file),file);assert.equal(hash(await readFile(path.join(report.artifactsDirectory,file))),digest);}
for(const [file,digest] of Object.entries(report.package.modules)){
  assert.equal(hash(await readFile(path.join(report.package.bundle,'Contents/Resources/app',file))),digest);
  assert.equal(hash(await readFile(path.join(root,file))),digest);
}
await run('/usr/bin/codesign',['--verify','--deep','--strict',report.package.bundle]);
const signature=await run('/usr/bin/codesign',['-d','--verbose=4',report.package.bundle]);assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1],report.package.cdHash);assert.match(signature,/Signature=adhoc/);
assert.notEqual(report.versions.previous,report.versions.candidate);
assert.deepEqual(report.observations.map((item:any)=>item.name),['previous-initial','previous-after-rejection','previous-after-ui-recovery','candidate-after-ui-update','candidate-after-restart']);
for(const [index,item] of report.observations.entries()){
  const version=index<3?report.versions.previous:report.versions.candidate;
  assert.equal(item.state.installedVersion,version);assert.equal(item.state.recoveryRequired,false);assert.equal(item.actual.split(' ').at(-1),version);
  assert.ok(item.receiptCount>item.receiptBaseline);assert.deepEqual(report.browserEvidence.receipts[item.receiptBaseline],item.receipt);
  validateBackupBrowser(item.receipt);if(index>0)assert.deepEqual(item.receipt.before,item.receipt.after);
  assert.ok(item.identity.matchesConfiguration);assert.match(item.identity.platform,/^Linux/);
  assert.ok(item.rendered.width===1280&&item.rendered.height===800&&item.rendered.colors>20);assertGuestBrowserSandbox(item.sandbox);
  assert.ok(item.protection.active&&item.protection.integrity==='verified');
  // Private relay ports are regenerated at boot; profile operations in one boot must preserve protection.
  if(!bridgeOwner||(index>0&&index<4)){
    assert.equal(item.protection.firewallHash,report.observations[1].protection.firewallHash);
    assert.equal(item.protection.tunnelConfigHash,report.observations[1].protection.tunnelConfigHash);
  }
}
assert.equal(report.browserEvidence.loginRequests,1);
assert.equal(report.uiJobs.filter((item:any)=>item.action==='browser-update'&&item.status==='failed').length,1);
assert.equal(report.uiJobs.filter((item:any)=>item.action==='browser-update'&&item.status==='succeeded').length,1);
assert.equal(report.uiJobs.filter((item:any)=>item.action==='browser-recover'&&item.status==='failed').length,1);
assert.equal(report.uiJobs.filter((item:any)=>item.action==='browser-recover'&&item.status==='succeeded').length,1);
assert.ok(report.versionUiScreenshot.colors>32);
assert.equal(report.activeViewerShutdown.completed,true);assert.ok(report.activeViewerShutdown.elapsedMs<30_000);
const boot=await readFile(path.join(report.artifactsDirectory,'first-boot.pcap'));
assert.equal(boot.length,report.firstBoot.bytes);assert.equal(hash(boot),report.firstBoot.sha256);
async function inspectCapture(file:string,row:any,requireBusiness=false){
  const physical=(await packetLines(file,'ifindex 2 and outbound and (ip or ip6)')).length;
  const proxy=(await packetLines(file,`ifindex 2 and outbound and tcp and dst host ${row.gateway} and dst port ${row.proxyPort}`)).length;
  const ssh=(await packetLines(file,`ifindex 2 and outbound and tcp and src port 22 and dst host ${row.gateway}`)).length;
  const allowed=`(tcp and src port 22 and dst host ${row.gateway}) or (udp and src port 68 and dst port 67)${bridgeOwner?'':` or (tcp and dst host ${row.gateway} and dst port ${row.proxyPort})`}`;
  assert.deepEqual(await packetLines(file,`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`),[]);
  assert.ok(physical>0);assert.equal(physical,row.physicalPackets);assert.equal(row.unapproved,0);
  if(bridgeOwner){assert.equal(proxy,0);assert.equal(row.approvedProxy,0);assert.equal(row.approvedSsh,ssh);if(requireBusiness)assert.ok(ssh>0);}
  else if(requireBusiness){assert.equal(proxy,row.approvedProxy);assert.ok(proxy>0);}
  return {physicalPackets:physical,approvedProxy:proxy,approvedSsh:ssh,unapproved:0};
}
const firstBoot=await inspectCapture(path.join(report.artifactsDirectory,'first-boot.pcap'),report.firstBoot);
if(bridgeOwner){assert.match(report.firstBoot.bootId,/^[a-f0-9-]{36}$/);assert.equal(report.firstBoot.bootId,report.firstBoot.capturedBootId);assert.equal(report.firstBoot.activeState,'active');assert.equal(report.firstBoot.subState,'exited');}
assert.deepEqual(report.captures.map((item:any)=>item.name),['upgrade','restart']);
const captures=[];
for(const capture of report.captures){
  const file=path.join(report.artifactsDirectory,`${capture.name}.pcap`),raw=await readFile(file);assert.equal(raw.length,capture.bytes);assert.equal(hash(raw),capture.sha256);
  captures.push({name:capture.name,...await inspectCapture(file,capture,true)});
}
const result={passed:true,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),cdHash:report.package.cdHash,
  actualOfficialVersions:report.versions,browserObservations:report.observations.length,profileFaultsRejected:['symlink','corrupt-checkpoint','malformed-journal'],
  actualUiRecoveryAndUpgrade:true,sourceAndPackagedModuleAndArtifactHashesVerified:true,deepStrictSignatureVerified:true,
  compiledBackendModulesVerified:bridgeOwner?45:7,captures,firstBoot,activeViewerShutdown:report.activeViewerShutdown,
  testResourcesRemoved:true,scope:'Independent actual packaged UI/VM evidence and raw captures; previous approved version prepared with source installer; not whole project, power loss or real residential acceptance'};
await writeFile(path.join(root,`test-results/${reportName}-evidence.json`),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));
