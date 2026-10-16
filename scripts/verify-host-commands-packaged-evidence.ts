import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),bytes=await readFile(path.join(root,'test-results/host-commands-packaged.json'));
const report=JSON.parse(bytes.toString()),hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
assert.equal(report.passed,true);assert.equal(report.actualElectronPackageTested,true);assert.equal(report.actualVmTested,true);
assert.equal(report.freshDataDirectory,true);assert.equal(report.accountFree,true);assert.equal(report.paidModelCalls,0);assert.equal(report.testResourcesRemoved,true);
assert.equal(report.package.cdHash,'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');assert.equal(report.application.packaged,true);
assert.equal(report.application.appPath,path.join(report.package.bundle,'Contents/Resources/app'));
assert.ok(report.application.renderers.length>0&&report.application.renderers.every((item:any)=>item.sandboxed));
assert.deepEqual(report,JSON.parse(await readFile(path.join(report.artifactsDirectory,'report.json'),'utf8')));
for(const [file,digest] of Object.entries(report.sources))assert.equal(hash(await readFile(path.join(root,file))),digest,file);
for(const [file,digest] of Object.entries(report.artifacts))assert.equal(hash(await readFile(path.join(report.artifactsDirectory,file))),digest,file);
let canonicalNativeHash='';
for(const [file,digest] of Object.entries(report.package.modules)){
  assert.equal(hash(await readFile(path.join(report.package.bundle,'Contents/Resources/app',file))),digest,file);
  if(file==='native/bin/mu-host-bridge'){
    const temporary=await mkdtemp(path.join(tmpdir(),'mu-native-identity-'));
    try{
      const digests=[];
      for(const [name,directory] of [['source',root],['packaged',report.application.appPath]]){
        const target=path.join(temporary,name);await copyFile(path.join(directory,file),target);
        // Packaging replaces the linker signature. Compare identical re-signings of copies.
        await run('/usr/bin/codesign',['--remove-signature',target]);
        await run('/usr/bin/codesign',['--sign','-','--identifier','mu-host-bridge',target]);
        digests.push(hash(await readFile(target)));
      }
      assert.equal(digests[0],digests[1]);canonicalNativeHash=digests[0]!;
    }finally{await rm(temporary,{recursive:true});}
  }else assert.equal(hash(await readFile(path.join(root,file))),digest,file);
}
assert.equal(report.package.modules['native/bin/host-command.sb'],report.sources['native/host-command.sb']);
await run('/usr/bin/codesign',['--verify','--deep','--strict',report.package.bundle]);
const signature=await run('/usr/bin/codesign',['-d','--verbose=4',report.package.bundle]);
assert.equal(signature.match(/^CDHash=(.+)$/m)?.[1],report.package.cdHash);assert.match(signature,/Signature=adhoc/);
assert.equal(report.packagedNativeTestsPassed,true);assert.equal(report.verifiedProxyCacheReused,true);
assert.deepEqual(report.network,{mode:'http',host:'127.0.0.1',port:9,strict:true,transparent:false,noProxy:''});
const tests=await readFile(path.join(report.artifactsDirectory,'packaged-native-tests.txt'),'utf8');
assert.match(tests,/\btests 10\b/);assert.match(tests,/\bpass 10\b/);assert.match(tests,/\bfail 0\b/);assert.match(tests,/\bskipped 0\b/);
assert.equal(report.repeatedDirectoryListings,true);
assert.equal(report.commands.status.exitCode,0);assert.match(report.commands.status.output,/ M notes.txt/);
assert.equal(report.commands.diff.exitCode,0);assert.match(report.commands.diff.output,/MU_PACKAGED_HOST_CHANGED/);
for(const key of ['unapprovedRejected','extraArgumentsRejected','hostSchemaRejected'])assert.equal(report.commands[key],true);
assert.equal(report.uiRevocationRejectedOldToken,true);assert.equal(report.environmentStopRevokedCommands,true);assert.equal(report.auditContainsNoOutput,true);assert.deepEqual(report.uiErrors,[]);
assert.ok(report.before.active&&report.after.active);assert.equal(report.before.integrity,'verified');assert.equal(report.after.integrity,'verified');assert.equal(report.before.firewallHash,report.after.firewallHash);
assert.equal(report.mobileBounds.width,390);assert.ok(report.mobileBounds.scroll<=report.mobileBounds.width);
for(const name of ['desktopScreenshot','mobileScreenshot'])assert.ok(report[name].colors>32&&report[name].size.width>0&&report[name].size.height>0);
const shutdown=report.activeCommandShutdown;assert.equal(shutdown.completed,true);assert.equal(shutdown.guestCommandRejected,true);assert.ok(shutdown.elapsedMs<30_000);
assert.equal(shutdown.helper.parent,report.application.pid);assert.equal(shutdown.helper.pid,shutdown.helper.group);
assert.ok(shutdown.members.some((item:any)=>item.pid!==shutdown.helper.pid&&item.group===shutdown.helper.group&&item.command.endsWith('/git')));
assert.deepEqual(report.captures.map((item:any)=>item.name),['first-boot','commands','shutdown']);
const captures=[];
for(const capture of report.captures){
  const file=path.join(report.artifactsDirectory,`${capture.name}.pcap`),raw=await readFile(file);assert.equal(raw.length,capture.bytes);assert.equal(hash(raw),capture.sha256);
  assert.equal(capture.proxyPort,9);assert.equal(capture.allowProxy,true);
  const decoded=await run('/usr/sbin/tcpdump',['-nn','-r',file,'ifindex 2 and outbound and (ip or ip6)'],{maxBytes:128_000_000});
  const physical=decoded.split('\n').filter(line=>/^\d\d:\d\d:\d\d\.\d+\s/.test(line));assert.ok(physical.length>0);assert.equal(physical.length,capture.physicalPackets);
  const bad=physical.filter(line=>/\sIP6\s/.test(line)||!(line.includes(`.22 > ${capture.gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)||(capture.allowProxy&&line.includes(` > ${capture.gateway}.9:`))));
  const approvedProxy=physical.filter(line=>line.includes(` > ${capture.gateway}.9:`)).length;
  assert.equal(approvedProxy,capture.approvedProxy);
  assert.deepEqual(bad,[]);assert.equal(capture.unapproved,0);captures.push({name:capture.name,physicalPackets:physical.length,approvedProxy,unapproved:0});
}
const result={passed:true,verifiedAt:new Date().toISOString(),reportSha256:hash(bytes),cdHash:report.package.cdHash,
  packagedNativeTests:10,repeatedDirectoryListings:true,actualElectronUiAndVmAuthorization:true,sourceAndPackagedModuleAndArtifactHashesVerified:true,canonicalNativeHash,deepStrictSignatureVerified:true,
  captures,activeCommandShutdown:shutdown,testResourcesRemoved:true,
  scope:'Actual packaged UI and VM command bridge, ten saved native file/command boundary tests with positive controls including signal-denial cleanup, repeated directory listings, native screenshots and raw captures; management traffic is not business proxy acceptance; no arbitrary shell, Network Extension or whole-project claim'};
await writeFile(path.join(root,'test-results/host-commands-packaged-evidence.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));
