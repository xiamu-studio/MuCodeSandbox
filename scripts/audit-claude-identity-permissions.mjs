import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const binaryHash='f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa';
const runs=[],identity=[],permissions=[];
for(const folder of ['runtime-identity','runtime-permissions']){
 const runtime=await json(folder+'/runtime.json'),receipts=await json(folder+'/receipts.json');
 assert.equal(runtime.sha256,binaryHash);assert.equal(runtime.paidCalls,0);assert.equal(runtime.accountFree,true);
 assert.deepEqual(runtime.namespace.interfaces,['lo']);assert.notEqual(runtime.namespace.hostNetwork,runtime.namespace.testNetwork);
 assert.ok(runtime.namespace.originalHomesMasked&&runtime.namespace.resolverIpcMasked);
 assert.equal(runtime.namespace.routes.some(r=>r.dst==='default'),false);
 assert.equal(runtime.runnerSHA256,sha(await readFile(path.join(root,folder,'runner.py'))));
 const hashes={};
 for(const c of runtime.cases){
  const trace=await readFile(path.join(root,folder,c.name+'.strace')),output=await readFile(path.join(root,folder,c.name+'.output'));
  assert.equal(trace.length,c.traceBytes);assert.equal(output.length,c.outputBytes);
  hashes[c.name+'.strace']=sha(trace);hashes[c.name+'.output']=sha(output);
  const text=joinSyscalls(trace.toString('utf8'));assert.equal(c.exitCode,0);assert.equal(c.timedOut,false);
  if(c.name==='trace-calibration'){assert.ok(text.includes('Apple Virtualization Generic Platform'));continue;}
  const requests=receipts.filter(r=>r.case===c.name&&r.path.startsWith('/v1/messages'));
  assert.ok(requests.length>0);assert.ok(text.includes('/sys/hypervisor/uuid'));
  if(folder==='runtime-identity'){
   const meta=JSON.parse(requests[0].body.metadata.user_id),cfg=c.identityConfig.find(v=>v.userID===meta.device_id);
   assert.ok(cfg);assert.match(meta.device_id,/^[a-f0-9]{64}$/);assert.match(cfg.machineID,/^[a-f0-9]{64}$/);
   const pattern=new RegExp('read\\([^\\n]*<\\/etc\\/machine-id>,\\s*"'+c.syntheticMachineId+'\\\\n"');
   assert.ok(pattern.test(text),'Synthetic system identifier was not actually read');
   identity.push({case:c.name,profile:c.profile,systemId:c.syntheticMachineId,deviceId:meta.device_id,
    userId:cfg.userID,profileMachineId:cfg.machineID,sessionId:meta.session_id,
    rawSystemIdInBody:requests.some(r=>JSON.stringify(r.body).includes(c.syntheticMachineId))});
  }else{
   const results=requests.flatMap(r=>r.body.messages).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result');
   const last=results.at(-1);assert.ok(last);
   const dmiRead=/read\([^\n]*<\/sys\/devices\/virtual\/dmi\/id\/product_name>/.test(text);
   const allowed=c.name==='permissions-read-allowed';
   assert.equal(dmiRead,allowed);
   assert.equal(last.is_error===true,!allowed);
   assert.equal(last.content.includes('Apple Virtualization Generic Platform'),allowed);
   if(c.name==='permissions-bash-denied')assert.match(last.content,/has been denied/);
   if(c.name==='permissions-bash-disabled')assert.match(last.content,/No such tool available/);
   if(c.name==='permissions-read-path-denied')assert.match(last.content,/denied by your permission settings/);
   permissions.push({case:c.name,toolError:last.is_error===true,appleDmiRead:dmiRead,
    appleMarkerInToolResult:last.content.includes('Apple Virtualization Generic Platform'),startupVmProbeAttempt:true,
    modelRequestCount:requests.length});
  }
 }
 runs.push({folder,runnerSHA256:runtime.runnerSHA256,recordedAt:runtime.recordedAt,hashes,
  receiptSHA256:sha(await readFile(path.join(root,folder,'receipts.json')))});
}
const [a1,a2,changed,b1,b2]=identity;
assert.equal(a1.deviceId,a2.deviceId);assert.equal(a2.deviceId,changed.deviceId);
assert.equal(a1.profileMachineId,changed.profileMachineId);
assert.notEqual(changed.systemId,a2.systemId);assert.equal(changed.systemId,b1.systemId);
assert.notEqual(changed.deviceId,b1.deviceId);assert.equal(b1.deviceId,b2.deviceId);
assert.equal(new Set(identity.map(r=>r.sessionId)).size,identity.length);
const evidence=await json('static/identity-generator.json');
assert.equal(evidence.executableSHA256,binaryHash);assert.ok(evidence.cryptoImports.some(s=>s.includes('randomBytes as vf')));
assert.ok(evidence.identityGenerator.includes('userID:h')&&evidence.identityGenerator.includes('vf(32).toString("hex")'));
const report={checkedAt:new Date().toISOString(),version:'2.1.296',binarySHA256:binaryHash,evidenceChecksPassed:true,
 accountFree:true,paidCalls:0,runs,observations:11,calibrations:2,
 identityFindings:{sameProfileStable:true,systemIdChangeDidNotChangeRequestDeviceId:true,
   differentProfileHasDifferentDeviceId:true,requestDeviceIdEqualsProfileUserId:true,
   profileMachineIdStable:true,sessionIdsUnique:true,
   rawSyntheticSystemIdObservedInBody:identity.some(r=>r.rawSystemIdInBody)},
 identityRows:identity.map(({deviceId,userId,profileMachineId,sessionId,...row})=>({...row,
   deviceIdSHA256:sha(Buffer.from(deviceId)),profileMachineIdSHA256:sha(Buffer.from(profileMachineId)),
   configUserIdMatches:true})),permissions,
 scope:'Unmodified native client. Synthetic system identifier changes only inside a private mount namespace. Local TLS receiver; no real account/provider. Deny tests cover named Bash command and Read path; not all indirect subprocesses or client-internal reads. Identity conclusions refer only to the tested Messages metadata.device_id, not every identifier or server correlation.'};
await writeFile(path.join(root,'identity-permissions-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({evidenceChecksPassed:true,identity:report.identityFindings,permissions,observations:11},null,2));
function sha(b){return createHash('sha256').update(b).digest('hex');}
async function json(file){return JSON.parse(await readFile(path.join(root,file),'utf8'));}
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
