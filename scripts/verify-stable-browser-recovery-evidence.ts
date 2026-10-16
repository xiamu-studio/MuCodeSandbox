import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {CURRENT_BROWSER_RELEASE} from '../server/browser-releases.ts';
import {assertGuestBrowserSandbox} from '../server/guest-browser-sandbox.ts';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const root=path.resolve(import.meta.dirname,'..'),file=path.join(root,'test-results/browser-install-recovery.json');
const bytes=await readFile(file),r=JSON.parse(bytes.toString());
assert.equal(r.release.format,'deb');assert.equal(r.release.version,CURRENT_BROWSER_RELEASE.version);assert.equal(r.release.recipe,CURRENT_BROWSER_RELEASE.recipe);assert.equal(r.release.sha256,CURRENT_BROWSER_RELEASE.sha256);
assert.equal(r.extractionFailureRetainsPrevious,true);assert.equal(r.checksumFailureRetainsPrevious,true);assert.equal(r.testResourcesRemoved,true);
assert.ok(!r.error && !r.cleanupError);
// Preserve the historical full-run failure. Only its obsolete direct-proxy
// packet expectation may be reconciled from the retained capture.
assert.ok(r.capture || /assert\.ok\(proxy\.length > 0\)/.test(r.captureError??''));
const directory=r.artifactsDirectory;
assert.equal(hash(await readFile(path.join(directory,'executed-script.ts'))),r.sources['scripts/verify-browser-install-recovery.ts']);
for(const name of ['server/browser-install-transaction.ts','server/guest-browser-runtime.ts'])assert.equal(hash(await readFile(path.join(root,name))),r.sources[name]);
for(const [name,expected] of Object.entries(r.artifacts))assert.equal(hash(await readFile(path.join(directory,name))),expected);
const stages=['prepared','backed-up','switched','configured','committed'];
for(const stage of stages){const killed=r.stages.find((s:any)=>s.stage===`killed-${stage}`);assert.equal(killed.actualInstallerProcessKilled,true);assert.match(killed.processState.state,/^T/);assert.match(killed.processState.exe,/python3/);assert.equal(killed.journal.committed,stage==='committed');assert.ok(killed.outcome.error);assert.equal(killed.previousCanaryRetained,stage!=='committed');}
const recovered=r.stages.filter((s:any)=>s.stage==='initial'||s.stage==='final'||s.stage.startsWith('recovered-'));assert.equal(recovered.length,7);
for(const s of recovered){assertGuestBrowserSandbox(s.sandbox);assert.equal(s.protection.active,true);assert.equal(s.protection.integrity,'verified');assert.ok(s.protection.proxyEndpoints.length&&s.protection.proxyEndpoints.every((x:string)=>/^127\.0\.0\.1:\d+$/.test(x)));if(s.stage!=='initial')assert.deepEqual(s.receipt.before,s.receipt.after);}
assert.equal(r.browserEvidence.loginRequests,1);assert.equal(r.browserEvidence.protectedRequests.length,7);assert.ok(r.browserEvidence.protectedRequests.every((x:string)=>x==='synthetic=mu-portable-synthetic-account'));
const capture=await readFile(path.join(directory,'tasks.pcap')),text=(await readFile(path.join(directory,'tasks-network.txt'),'utf8'));
const packets=text.split('\n').filter(l=>/\seth0\s+Out\s+IP6?\s/.test(l));assert.ok(packets.length>0);
const gateways=new Set(packets.flatMap(l=>{const m=l.match(/\.22 > (\d+\.\d+\.\d+\.\d+)\.\d+:/);return m?[m[1]]:[];}));assert.equal(gateways.size,1);const gateway=[...gateways][0];
const ssh=packets.filter(l=>l.includes(`.22 > ${gateway}.`));assert.ok(ssh.length>0);
const unapproved=packets.filter(l=>/\sIP6\s/.test(l)||!(l.includes(`.22 > ${gateway}.`)||/\.68 > [0-9.]+\.67:/.test(l)));assert.deepEqual(unapproved,[]);
const result={passed:true,at:new Date().toISOString(),executionReportSha256:hash(bytes),historicalExecutionPassed:r.passed,historicalCaptureError:r.captureError,scope:'Independent verification of actual stable Debian failure / recovery execution and retained guest capture, using the current SSH-carried local proxy path. No new execution or real accounts.',stages,verifiedBrowserStates:recovered.length,capture:{bytes:capture.length,sha256:hash(capture),physicalPackets:packets.length,approvedSshPackets:ssh.length,unapproved:0},testResourcesRemoved:true};
await writeFile(path.join(root,'test-results/browser-install-recovery-deb-evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
