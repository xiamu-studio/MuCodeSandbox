// Check unauthenticated feature gates and version-bound static remote metadata paths.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit'),folder='runtime-features',base=path.join(root,folder);
const binary=await readFile(path.join(root,'packages/2.1.296/claude'));
const hash='f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa';assert.equal(sha(binary),hash);
const runtime=await json('runtime.json'),receipts=await json('receipts.json');
assert.equal(runtime.sha256,hash);assert.equal(runtime.accountFree,true);assert.equal(runtime.paidCalls,0);
assert.equal(runtime.unauthenticatedFeatureGateAudit,true);assert.equal(runtime.firstpartyHostnameFixture,true);
assert.deepEqual(runtime.namespace.interfaces,['lo']);assert.notEqual(runtime.namespace.hostNetwork,runtime.namespace.testNetwork);
assert.ok(runtime.namespace.originalHomesMasked&&runtime.namespace.resolverIpcMasked);
assert.equal(runtime.namespace.routes.some(v=>v.dst==='default'),false);
assert.equal(runtime.runnerSHA256,sha(await readFile(path.join(base,'runner.py'))));
assert.equal(runtime.receiptCount,receipts.length);
assert.deepEqual(runtime.cases.map(c=>c.name),['trace-calibration','feature-auth-none','feature-auth-key','feature-remote-default','feature-remote-optout','feature-remote-help','feature-doctor']);
const rows=[],hashes={};
for(const c of runtime.cases){
 const traceBytes=await readFile(path.join(base,c.name+'.strace')),outputBytes=await readFile(path.join(base,c.name+'.output'));
 assert.equal(traceBytes.length,c.traceBytes);assert.equal(outputBytes.length,c.outputBytes);assert.equal(c.timedOut,false);
 hashes[c.name+'.strace']=sha(traceBytes);hashes[c.name+'.output']=sha(outputBytes);
 const trace=joinSyscalls(traceBytes.toString()),output=outputBytes.toString();
 const dmi=/read\([^\n]*<\/sys\/devices\/virtual\/dmi\/id\/product_name>,\s*"Apple Virtualization Generic Platform\\n"[^\n]*= 38/.test(trace);
 if(c.name==='trace-calibration'){assert.equal(c.exitCode,0);assert.ok(dmi);assert.match(output,/^apple\s*$/);continue;}
 const reqs=receipts.filter(r=>r.case===c.name);assert.equal(reqs.some(r=>/^\/v1\/messages(?:\?|$)/.test(r.path)),false);
 assert.equal(reqs.some(r=>r.path.includes('/environments/bridge')),false);assert.equal(dmi,false);
 let auth=null;
 if(c.name.startsWith('feature-auth-')){
  auth=JSON.parse(output);const key=c.name.endsWith('key');
  assert.equal(c.exitCode,key?0:1);assert.equal(auth.loggedIn,key);assert.equal(auth.authMethod,key?'api_key':'none');
  if(key){assert.equal(auth.apiKeySource,'ANTHROPIC_API_KEY');assert.equal(reqs.length,2);
   assert.ok(reqs.every(r=>r.method==='GET'&&r.responseStatus===200));}
  else assert.equal(reqs.length,0);
 }
 if(c.name.startsWith('feature-remote-')){
  assert.equal(c.exitCode,1);assert.equal(reqs.length,0);assert.match(output,/must be logged in to use Remote Control/);
  assert.match(output,/only available with claude\.ai subscriptions/);
  assert.equal(trace.includes('/sys/hypervisor/uuid'),false);assert.equal(c.identityConfig.length,0);
 }
 if(c.name==='feature-doctor'){
  assert.equal(c.exitCode,0);assert.match(output,/Platform: linux-arm64/);assert.match(output,/Config install method: not set/);
  assert.match(output,/server response could not be parsed/);assert.match(output,/Remote Control requires a claude\.ai subscription/);
  assert.ok(reqs.length>0&&reqs.every(r=>r.method==='GET'&&r.responseStatus===200));
 }
 const fields=[...new Set((c.identityConfig??[]).flatMap(v=>Object.entries(v).filter(([k,value])=>k!=='path'&&value).map(([k])=>k)))];
 assert.equal(fields.includes('remoteControlMachineId'),false);
 rows.push({case:c.name,exitCode:c.exitCode,uuidProbeAttempt:trace.includes('/sys/hypervisor/uuid'),successfulAppleDmiRead:false,
  receivedRequests:reqs.length,modelRequests:0,bridgeRegistrationRequests:0,profileIdentifierFields:fields,
  authStatus:auth?{loggedIn:auth.loggedIn,authMethod:auth.authMethod,apiKeySource:auth.apiKeySource??null}:null,
  subscriptionGateObserved:c.name.startsWith('feature-remote-')});
}
const staticBytes=await readFile(path.join(root,'static/feature-paths.json')),staticReport=JSON.parse(staticBytes);
assert.equal(staticReport.binarySHA256,hash);assert.equal(staticReport.points.length,8);
for(const p of staticReport.points){
 assert.equal(binary.subarray(p.start,p.end).toString(),p.excerpt);
 assert.equal(binary.indexOf(p.needle,p.offset),p.offset);
}
for(const file of ['runtime.json','receipts.json','runner.py'])hashes[file]=sha(await readFile(path.join(base,file)));
hashes['../static/feature-paths.json']=sha(staticBytes);
const afterBytes=await readFile(path.join(root,'features-production-after.json')),after=JSON.parse(afterBytes);
assert.equal(after.environment.id,'ee85e6f8-043b-4d02-be6e-7a0683c4bde8');assert.equal(after.environment.state,'running');
assert.equal(after.environment.browserRunning,true);assert.equal(after.environment.strict,true);assert.equal(after.environment.transparent,true);
assert.equal(after.protection.integrity,'verified');assert.deepEqual(after.protection.issues,[]);
for(const key of ['active','firewallActive','transparentActive','routingReady','dnsGuardActive','leaseActive'])assert.equal(after.protection[key],true);
const guestBytes=await readFile(path.join(root,'features-guest-after.json')),guest=JSON.parse(guestBytes);
assert.equal(guest.binarySHA256,hash);assert.equal(guest.productionClaudeInstalled,false);
assert.equal(guest.machineSHA256,'42193e80006e9b8015f4c246de94dfa9c6222d5e505e379120339c8781142fbf');assert.deepEqual(guest.liveAuditProcesses,[]);
hashes['../features-production-after.json']=sha(afterBytes);hashes['../features-guest-after.json']=sha(guestBytes);
const report={checkedAt:new Date().toISOString(),recordedAt:runtime.recordedAt,version:'2.1.296',binarySHA256:hash,
 evidenceChecksPassed:true,accountFree:true,paidCalls:0,observations:7,calibrations:1,folder,hashes,rows,
 remoteControlStaticFindings:staticReport.findings,
 productionPostCheck:{checkedAt:after.checkedAt,networkProtectionVerified:true,originalMachineIdMatchesPreRunObservation:true,liveAuditProcesses:[]},
 scope:'Blank profiles, absent or synthetic API key, loopback-only namespace. Remote Control exited at the subscription gate before bridge registration; authenticated registration, remote host profile collection/transmission, and actual service account decisions remain unverified. Auth status with an invalid synthetic key reports local credential presence, not provider acceptance. Doctor warnings are caused by the temporary install and intentionally simplified policy fixture.'};
await writeFile(path.join(root,'features-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({evidenceChecksPassed:true,observations:7,calibrations:1,rows,staticFindings:staticReport.findings},null,2));
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
async function json(file){return JSON.parse(await readFile(path.join(base,file),'utf8'));}
function joinSyscalls(text){
 const pending=new Map(),lines=[];
 for(const line of text.split('\n')){
  const row=line.match(/^(\d+)\s+\S+\s+(.+)$/);if(!row){lines.push(line);continue;}
  const [,pid,body]=row,started=body.match(/^(\w+)\(.*<unfinished \.\.\.>$/),resumed=body.match(/^<\.\.\. (\w+) resumed>(.*)$/);
  if(started){pending.set(pid+':'+started[1],body.replace(/<unfinished \.\.\.>$/,''));continue;}
  if(resumed){const key=pid+':'+resumed[1],prefix=pending.get(key);if(prefix){lines.push(pid+' '+prefix+resumed[2]);pending.delete(key);continue;}}
  lines.push(line);
 }return lines.join('\n');
}
