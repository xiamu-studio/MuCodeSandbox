// Verify actual hook reads, first request context, and bounded synthetic API errors.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const folder='runtime-hooks-errors',base=path.join(root,folder);
const binaryHash='f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa';
const runtime=await json('runtime.json'),receipts=await json('receipts.json');
assert.equal(runtime.sha256,binaryHash);assert.equal(sha(await readFile(path.join(root,'packages/2.1.296/claude'))),binaryHash);
assert.equal(runtime.paidCalls,0);assert.equal(runtime.accountFree,true);
assert.equal(runtime.intentionalHookAndApiErrors,true);assert.equal(runtime.firstpartyHostnameFixture,true);
assert.deepEqual(runtime.namespace.interfaces,['lo']);assert.notEqual(runtime.namespace.hostNetwork,runtime.namespace.testNetwork);
assert.ok(runtime.namespace.originalHomesMasked&&runtime.namespace.resolverIpcMasked);
assert.equal(runtime.namespace.routes.some(v=>v.dst==='default'),false);assert.equal(runtime.namespace.clientUid,502);
assert.equal(runtime.runnerSHA256,sha(await readFile(path.join(base,'runner.py'))));
assert.equal(runtime.platformFixtureSHA256,sha(await readFile(path.join(base,'platform-fixture.py'))));
assert.equal(runtime.receiptCount,receipts.length);
const names=['trace-calibration','hook-startup-enabled','hook-startup-tools-denied','hook-startup-disabled',
 'error-400-default','error-400-optout','error-500-default','error-500-optout'];
assert.deepEqual(runtime.cases.map(c=>c.name),names);
const hashes={},rows=[],marker='Apple Virtualization Generic Platform';
for(const c of runtime.cases){
 const tb=await readFile(path.join(base,c.name+'.strace')),ob=await readFile(path.join(base,c.name+'.output'));
 hashes[c.name+'.strace']=sha(tb);hashes[c.name+'.output']=sha(ob);
 assert.equal(tb.length,c.traceBytes);assert.equal(ob.length,c.outputBytes);assert.equal(c.timedOut,false);
 const trace=joinSyscalls(tb.toString());
 const dmi=trace.split('\n').filter(l=>/read\([^\n]*<\/sys\/devices\/virtual\/dmi\/id\/product_name>,\s*"Apple Virtualization Generic Platform\\n"/.test(l)&&/= 38\s*$/.test(l));
 if(c.name==='trace-calibration'){assert.equal(c.exitCode,0);assert.ok(dmi.length);assert.match(ob.toString(),/^apple\s*$/);continue;}
 const all=receipts.filter(r=>r.case===c.name),models=all.filter(r=>/^\/v1\/messages(?:\?|$)/.test(r.path));
 assert.ok(models.length);assert.ok(trace.includes('/sys/hypervisor/uuid'));
 const statuses=models.map(r=>r.responseStatus),bodyHasMarker=models.some(r=>JSON.stringify(r.body).includes(marker));
 const blocks=models.flatMap(r=>r.body.messages).flatMap(m=>Array.isArray(m.content)?m.content:[]);
 assert.equal(blocks.some(b=>['tool_use','tool_result'].includes(b.type)),false);
 const eventsBytes=await readFile(path.join(base,c.name+'.fixture-events.jsonl'));
 hashes[c.name+'.fixture-events.jsonl']=sha(eventsBytes);
 const events=eventsBytes.toString().split('\n').filter(Boolean).map(l=>JSON.parse(l));assert.deepEqual(events,c.fixtureEvents);
 const eventRequests=all.filter(r=>r.path.startsWith('/api/event_logging/'));
 const metrics=eventRequests.flatMap(r=>r.body.events??[]).map(e=>e.event_data).filter(Boolean);
 const diagnostics=metrics.filter(e=>/^tengu_api_(error|retry|success)$/.test(e.event_name)).map(e=>({name:e.event_name,env:e.env,metadata:decode(e.additional_metadata)}));
 if(c.name.startsWith('hook-')){
  assert.equal(c.exitCode,0);assert.deepEqual(statuses,[200]);assert.equal(eventRequests.length,0);
  const disabled=c.name.endsWith('disabled'),setup=JSON.parse(c.argv[c.argv.indexOf('--settings')+1]);
  assert.equal(setup.disableAllHooks,disabled);assert.ok(setup.hooks.SessionStart.length);
  assert.equal(dmi.length>0,!disabled);assert.equal(bodyHasMarker,!disabled);
  if(disabled)assert.equal(events.length,0);
  else{
   const read=events.find(e=>e.event==='hook-read'),start=events.find(e=>e.event==='process-start');
   assert.ok(read&&start);assert.equal(read.uid,502);assert.equal(read.value,marker);assert.equal(start.mode,'hook');
   assert.ok(dmi.some(l=>l.startsWith(read.pid+' ')));
   assert.ok(trace.split('\n').some(l=>l.startsWith(read.pid+' ')&&l.includes('execve(')&&l.includes('platform-fixture.py')));
   assert.equal(events.find(e=>e.event==='hook-input')?.hookEvent,'SessionStart');
   assert.ok(JSON.stringify(models[0].body.messages).includes('MU LOCAL AUDIT PLATFORM: '+marker));
  }
  if(c.name.endsWith('tools-denied'))assert.ok(c.argv.includes('--disallowedTools')&&c.argv.includes('Bash')&&c.argv.includes('Read'));
 }else{
  assert.equal(events.length,0);assert.equal(dmi.length,0);assert.equal(bodyHasMarker,false);
  const bad=c.name.includes('-400-'),optout=c.name.endsWith('optout');
  assert.equal(c.exitCode,bad?1:0);assert.deepEqual(statuses,bad?[400]:[500,200]);
  assert.equal(eventRequests.length===0,optout);
  assert.equal(c.environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC==='1',optout);
  if(bad)assert.match(ob.toString(),/MU LOCAL AUDIT ERROR400/);else assert.match(ob.toString(),/LOCAL AUDIT ONLY/);
  if(!optout){
   assert.ok(diagnostics.length);
   for(const e of diagnostics){assert.equal(e.env.platform,'linux');assert.equal(e.env.arch,'arm64');
    assert.equal(e.env.deployment_environment,'unknown-linux');assert.match(e.env.linux_kernel,/^6\.8\./);}
   if(bad){
    const e=diagnostics.find(v=>v.name==='tengu_api_error');assert.ok(e);
    assert.equal(e.metadata.response_status,400);assert.equal(e.metadata.extra_ca_certs,true);
    assert.equal(e.metadata.https_proxy,false);assert.equal(e.metadata.response_server,'other');
    assert.equal(e.metadata.gzipSkipReason,'custom_ca');assert.match(e.metadata.error_message_hash,/^[a-f0-9]+$/);
   }else{
    assert.ok(diagnostics.some(e=>e.name==='tengu_api_retry'&&e.metadata.status===500));
    assert.ok(diagnostics.some(e=>e.name==='tengu_api_success'&&e.metadata.attempt===2));
    assert.equal(new Set(models.map(r=>r.body.metadata.user_id)).size,1);
   }
  }
 }
 rows.push({case:c.name,exitCode:c.exitCode,successfulAppleDmiRead:dmi.length>0,
  platformLabelInFirstModelRequest:JSON.stringify(models[0].body).includes(marker),responseStatuses:statuses,
  modelToolCalls:false,eventRequestCount:eventRequests.length,telemetryApiEvents:diagnostics.map(e=>({
   name:e.name,environment:{platform:e.env.platform,arch:e.env.arch,distro:e.env.linux_distro_id,kernel:e.env.linux_kernel,deployment:e.env.deployment_environment},
   diagnostics:Object.fromEntries(Object.entries(e.metadata).filter(([k])=>/^(status|response_status|response_server|response_request_id_header|https_proxy|extra_ca_certs|gzipSkipReason|error_message_hash|error_stack_hash|error_top_frame|attempt|durationMs|durationMsIncludingRetries)$/.test(k)))})),
  internalStartupProbeAttempt:true});
}
for(const f of ['runtime.json','receipts.json','runner.py','platform-fixture.py'])hashes[f]=sha(await readFile(path.join(base,f)));
const afterBytes=await readFile(path.join(root,'hooks-errors-production-after.json')),after=JSON.parse(afterBytes);
assert.equal(after.environment.id,'ee85e6f8-043b-4d02-be6e-7a0683c4bde8');
assert.equal(after.environment.state,'running');assert.equal(after.environment.browserRunning,true);
assert.equal(after.environment.strict,true);assert.equal(after.environment.transparent,true);
assert.equal(after.protection.integrity,'verified');assert.deepEqual(after.protection.issues,[]);
for(const key of ['active','firewallActive','transparentActive','routingReady','dnsGuardActive','leaseActive'])assert.equal(after.protection[key],true);
const guestBytes=await readFile(path.join(root,'hooks-errors-guest-after.json')),guest=JSON.parse(guestBytes);
assert.equal(guest.binarySHA256,binaryHash);assert.equal(guest.productionClaudeInstalled,false);
assert.equal(guest.machineSHA256,'42193e80006e9b8015f4c246de94dfa9c6222d5e505e379120339c8781142fbf');
assert.deepEqual(guest.liveAuditProcesses,[]);
hashes['../hooks-errors-production-after.json']=sha(afterBytes);hashes['../hooks-errors-guest-after.json']=sha(guestBytes);
const report={checkedAt:new Date().toISOString(),recordedAt:runtime.recordedAt,version:'2.1.296',binarySHA256:binaryHash,
 evidenceChecksPassed:true,accountFree:true,paidCalls:0,observations:8,calibrations:1,folder,hashes,rows,
 productionPostCheck:{checkedAt:after.checkedAt,networkProtectionVerified:true,originalMachineIdMatchesPreRunObservation:true,liveAuditProcesses:[]},
 scope:'Self-authored SessionStart hook and synthetic 400 / first-500-then-200 API responses only. Unmodified native client, blank homes, isolated loopback network. Extra CA and response_server=other are deliberately caused by the local TLS fixture. No real subscription error-reporting service, account decision, general crash coverage, or installed production hook was tested.'};
await writeFile(path.join(root,'hooks-errors-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({evidenceChecksPassed:true,observations:8,calibrations:1,rows},null,2));
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
async function json(file){return JSON.parse(await readFile(path.join(base,file),'utf8'));}
function decode(value){return JSON.parse(Buffer.from(value,'base64').toString());}
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
