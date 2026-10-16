// Validate the current browser sample; finite metadata checks do not prove VM invisibility.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'test-results/browser-observable-audit');
const pointer=JSON.parse(await readFile(path.join(dir,'latest.json'),'utf8'));
assert.match(pointer.file,/^[0-9a-f-]+\.json$/);
const raw=await readFile(path.join(dir,pointer.file)),report=JSON.parse(raw);
assert.equal(report.runId,pointer.runId);
assert.equal(report.scriptSHA256,sha(await readFile(path.join(root,'scripts/audit-browser-observables.ts'))));
assert.equal(report.environment.id,'ee85e6f8-043b-4d02-be6e-7a0683c4bde8');
assert.equal(report.app.version,'0.4.5');assert.equal(report.app.buildId,'7c2737978926f345');
assert.equal(report.counts.pagesBefore,3);assert.equal(report.counts.pagesAfter,3);assert.equal(report.pages.length,3);
assert.equal(report.browserStillRunning,true);
for(const phase of ['before','after']){
 assert.equal(report.protection[phase].active,true);assert.equal(report.protection[phase].integrity,'verified');
}
assert.equal(report.protection.before.firewallHash,report.protection.after.firewallHash);
assert.equal(report.protection.after.leaseActive,true);assert.equal(report.protection.after.dnsGuardActive,true);
assert.equal(report.guest.unameMachine,'aarch64');assert.equal(report.guest.processes.length,1);
const process=report.guest.processes[0];assert.equal(process.uid,502);assert.equal(process.elfMachine,183);
assert.equal(process.version,'Google Chrome for Testing 156.0.8078.4');assert.equal(process.remoteDebugPort,'9222');
assert.equal(process.customAutomationSuppression,false);assert.equal(process.userAgentOverride,false);
for(const flag of ['--enable-automation','--headless','--no-sandbox','--disable-setuid-sandbox'])assert.equal(process.flagNames.includes(flag),false);
assert.equal(report.browser.product,'Chrome/156.0.8078.4');
for(const page of report.pages){
 assert.deepEqual(page.page,page.isolated);
 for(const data of [page.page,page.isolated]){
  assert.equal(data.webdriver,false);assert.equal(data.language,report.environment.identity.locale);
  assert.equal(data.timezone,report.environment.identity.timezone);assert.equal(data.platform,'Linux x86_64');
  assert.match(data.userAgent,/X11; Linux x86_64/);assert.match(data.userAgent,/Chrome\/156\.0\.0\.0/);
  assert.equal(data.userAgent.includes('HeadlessChrome'),false);
  assert.equal(data.clientHints.architecture,'arm');assert.equal(data.clientHints.bitness,'64');
  assert.equal(data.clientHints.platform,'Linux');assert.equal(data.clientHints.mobile,false);
  assert.ok(data.clientHints.fullVersionList.some(v=>v.brand==='Chromium'&&v.version==='156.0.8078.4'));
  for(const descriptor of Object.values(data.descriptors)){assert.equal(descriptor.own,false);assert.ok(descriptor.getter.includes('[native code]'));}
 }
}
// Re-read the existing approved archive without extracting or downloading anything.
const archive='/Users/staff/.mucodesandbox/tools/guest-browser/chrome-156.0.8078.4-linux-arm64.zip';
const binding=JSON.parse(await readFile(path.join(dir,'archive-binding.json'),'utf8'));
const expected='910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce';
const code=`import pathlib,hashlib,json,zipfile
p=pathlib.Path(${JSON.stringify(archive)});h=hashlib.sha256()
with p.open('rb') as f:
 for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
archive_hash=h.hexdigest()
assert archive_hash=='${expected}'
with zipfile.ZipFile(p) as z:
 info=z.getinfo('chrome-linux-arm64/chrome');assert info.file_size<=600*1024*1024;h=hashlib.sha256()
 with z.open(info) as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
print(json.dumps({'archiveSHA256':archive_hash,'binarySHA256':h.hexdigest()}))`;
const checked=JSON.parse((await promisify(execFile)('/usr/bin/python3',['-c',code],{timeout:20000,maxBuffer:65536})).stdout);
assert.equal(checked.archiveSHA256,binding.archiveSHA256);assert.equal(checked.archiveSHA256,expected);
assert.equal(checked.binarySHA256,binding.binarySHA256);assert.equal(checked.binarySHA256,process.binarySHA256);
assert.equal(binding.downloadPerformed,false);
const channelBytes=await readFile(path.join(dir,'official-channels.json')),channels=JSON.parse(channelBytes);
assert.equal(channels.source,'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json');
assert.ok(channels.sourceTimestamp&&channels.channels.Stable.version);
const stableVersion=channels.channels.Stable.version;
const result={checkedAt:new Date().toISOString(),sampleCheckedAt:report.checkedAt,evidenceChecksPassed:true,
 rawFile:pointer.file,rawSHA256:sha(raw),scriptSHA256:report.scriptSHA256,archiveSHA256:expected,binarySHA256:checked.binarySHA256,
 samples:6,pages:3,webdriverFalseInBothWorlds:true,pageAndIsolatedValuesMatch:true,noObservedAutomationSuppressionFlag:true,
 nativeLinuxUserAgentReduction:true,trueArchitecture:'ARM64',locale:'en-US',timezone:'Asia/Saigon',browserVersion:'156.0.8078.4',
 officialChannelReceiptSHA256:sha(channelBytes),channelReceiptCheckedAt:channels.checkedAt,stableVersion,
 installedVersionEqualsObservedStable:stableVersion==='156.0.8078.4',
 scope:'Current 0.4.5 app and three existing page top frames, default / temporary isolated worlds. Web metadata, exact binary binding and selected process flags only; no real account decision, whole fingerprint coverage, hidden automation checks, worker/iframe revalidation, network-request header capture, or physical-machine equivalence. Latest channel table cannot assign an older exact build to its original channel.'};
await writeFile(path.join(dir,'verified-report.json'),JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify(result,null,2));
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
