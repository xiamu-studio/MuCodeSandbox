// Independent verification of intentionally requested, read-only local tool cases.
// A permission rule test is not evidence that a provider silently runs that query.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const folder='runtime-indirect',base=path.join(root,folder);
const expectedBinary='f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa';
const runtime=await json('runtime.json'),receipts=await json('receipts.json');
const marker='Apple Virtualization Generic Platform';
assert.equal(runtime.sha256,expectedBinary);
assert.equal(sha(await readFile(path.join(root,'packages/2.1.296/claude'))),expectedBinary);
assert.equal(runtime.accountFree,true);assert.equal(runtime.paidCalls,0);
assert.equal(runtime.firstpartyHostnameFixture,true);assert.equal(runtime.intentionalReadOnlyFixture,true);
assert.deepEqual(runtime.namespace.interfaces,['lo']);
assert.notEqual(runtime.namespace.hostNetwork,runtime.namespace.testNetwork);
assert.ok(runtime.namespace.originalHomesMasked&&runtime.namespace.resolverIpcMasked);
assert.equal(runtime.namespace.routes.some(v=>v.dst==='default'),false);
assert.equal(runtime.namespace.clientUid,502);
assert.equal(runtime.runnerSHA256,sha(await readFile(path.join(base,'runner.py'))));
assert.equal(runtime.platformFixtureSHA256,sha(await readFile(path.join(base,'platform-fixture.py'))));
assert.equal(runtime.receiptCount,receipts.length);
assert.equal(runtime.cases.length,8);
const hashes={},rows=[];
const expectations={
 'indirect-cat-read-denied':{error:true,dmi:false,marker:false},
 'indirect-python-read-denied':{error:false,dmi:true,marker:true},
 'indirect-command-absolute-denied':{error:false,dmi:true,marker:false},
 'indirect-bash-disabled':{error:true,dmi:false,marker:false},
 'indirect-mcp-allowed':{error:false,dmi:true,marker:true},
 'indirect-mcp-denied':{error:true,dmi:false,marker:false},
 'indirect-mcp-startup-denied':{error:true,dmi:true,marker:false},
};
assert.deepEqual(runtime.cases.map(c=>c.name),['trace-calibration',...Object.keys(expectations)]);
for(const c of runtime.cases){
 const traceBytes=await readFile(path.join(base,c.name+'.strace'));
 const outputBytes=await readFile(path.join(base,c.name+'.output'));
 hashes[c.name+'.strace']=sha(traceBytes);hashes[c.name+'.output']=sha(outputBytes);
 assert.equal(traceBytes.length,c.traceBytes);assert.equal(outputBytes.length,c.outputBytes);
 assert.equal(c.exitCode,0);assert.equal(c.timedOut,false);
 const trace=joinSyscalls(traceBytes.toString());
 // Require a successful kernel read with the actual data, not a path occurrence or failed open.
 const dmiLines=trace.split('\n').filter(line=>/read\([^\n]*<\/sys\/devices\/virtual\/dmi\/id\/product_name>,\s*"Apple Virtualization Generic Platform\\n"/.test(line)&&/= 38\s*$/.test(line));
 const dmiPids=[...new Set(dmiLines.map(line=>Number(line.match(/^\d+/)[0])))];
 if(c.name==='trace-calibration'){
  assert.ok(dmiLines.length>0);assert.match(outputBytes.toString(),/^apple\s*$/);continue;
 }
 const expected=expectations[c.name];
 const requests=receipts.filter(r=>r.case===c.name&&/^\/v1\/messages(?:\?|$)/.test(r.path));
 assert.equal(requests.length,2);
 const blocks=requests.flatMap(r=>r.body.messages).flatMap(m=>Array.isArray(m.content)?m.content:[]);
 const toolCalls=blocks.filter(b=>b.type==='tool_use'&&b.id==='tool_mu_indirect');
 assert.ok(toolCalls.length>0);
 assert.deepEqual({name:toolCalls[0].name,input:toolCalls[0].input},c.fixtureToolRequest);
 const result=blocks.filter(b=>b.type==='tool_result'&&b.tool_use_id==='tool_mu_indirect').at(-1);
 assert.ok(result);
 const resultText=typeof result.content==='string'?result.content:result.content.map(v=>v.text??'').join('\n');
 assert.equal(result.is_error===true,expected.error);
 assert.equal(dmiLines.length>0,expected.dmi);
 assert.equal(resultText.includes(marker),expected.marker);
 const rawEvents=await readFile(path.join(base,c.name+'.fixture-events.jsonl'));
 hashes[c.name+'.fixture-events.jsonl']=sha(rawEvents);
 const events=rawEvents.toString().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 assert.deepEqual(events,c.fixtureEvents);
 assert.ok(events.every(event=>event.uid===runtime.namespace.clientUid));
 const starts=events.filter(e=>e.event==='process-start');
 const reads=events.filter(e=>['indirect-read','mcp-tool-read','mcp-startup-read'].includes(e.event));
 for(const event of reads){
  assert.equal(event.value,marker);assert.ok(dmiPids.includes(event.pid));
  assert.ok(starts.some(s=>s.pid===event.pid));
  assert.ok(trace.split('\n').some(line=>line.startsWith(event.pid+' ')&&line.includes('execve(')&&line.includes('platform-fixture.py')));
 }
 if(c.name==='indirect-cat-read-denied'){
  assert.match(resultText,/has been denied/);assert.ok(c.argv.includes('Read(//sys/**)'));
 }
 if(c.name==='indirect-python-read-denied'){
  assert.equal(reads.length,1);assert.equal(reads[0].event,'indirect-read');
  assert.ok(c.argv.includes('Read(//sys/**)'));assert.equal(c.fixtureToolRequest.name,'Bash');
 }
 if(c.name==='indirect-command-absolute-denied'){
  assert.match(resultText,/^apple\s/);assert.ok(c.argv.includes('Bash(systemd-detect-virt *)'));
  assert.equal(c.fixtureToolRequest.input.command,'/usr/bin/systemd-detect-virt --vm');
  assert.match(trace,/execve\("\/usr\/bin\/systemd-detect-virt"/);
 }
 if(c.name==='indirect-bash-disabled'){
  assert.match(resultText,/No such tool available: Bash/);assert.equal(events.length,0);
 }
 const rpcToolCalls=events.filter(e=>e.event==='rpc'&&e.method==='tools/call').length;
 if(c.name.startsWith('indirect-mcp-')){
  assert.equal(starts.length,1);assert.equal(starts[0].mode,'mcp');
  assert.ok(events.some(e=>e.event==='rpc'&&e.method==='initialize'));
  assert.ok(events.some(e=>e.event==='rpc'&&e.method==='tools/list'));
  assert.ok(c.argv.includes('Read(//sys/**)')&&c.argv.includes('Bash'));
  const denied=c.name.endsWith('denied');assert.equal(rpcToolCalls,denied?0:1);
  if(denied)assert.match(resultText,/No such tool available: mcp__mu_audit__read_platform/);
 }
 if(c.name==='indirect-mcp-startup-denied'){
  assert.equal(reads.length,1);assert.equal(reads[0].event,'mcp-startup-read');
  assert.ok(events.findIndex(e=>e.event==='mcp-startup-read')<events.findIndex(e=>e.event==='rpc'&&e.method==='initialize'));
  assert.equal(receipts.filter(r=>r.case===c.name).some(r=>JSON.stringify(r.body).includes(marker)),false);
 }
 assert.ok(trace.includes('/sys/hypervisor/uuid'));
 rows.push({case:c.name,toolError:result.is_error===true,successfulAppleDmiRead:expected.dmi,
  appleLabelInToolResult:expected.marker,appleShortNameInToolResult:/^apple\s/.test(resultText),
  mcpProcessStarted:starts.some(e=>e.mode==='mcp'),mcpToolCalls:rpcToolCalls,
  startupRead:reads.some(e=>e.event==='mcp-startup-read'),dmiReadPids:dmiPids,
  startupVmProbeAttempt:true,modelRequests:requests.length,
  appleLabelInAnyReceivedBody:receipts.filter(r=>r.case===c.name).some(r=>JSON.stringify(r.body).includes(marker))});
}
for(const file of ['runtime.json','receipts.json','runner.py','platform-fixture.py'])hashes[file]=sha(await readFile(path.join(base,file)));
const afterBytes=await readFile(path.join(root,'indirect-production-after.json'));
const after=JSON.parse(afterBytes);
assert.equal(after.environment.id,'ee85e6f8-043b-4d02-be6e-7a0683c4bde8');
assert.equal(after.environment.state,'running');assert.equal(after.environment.browserRunning,true);
assert.equal(after.environment.strict,true);assert.equal(after.environment.transparent,true);
assert.equal(after.protection.integrity,'verified');assert.deepEqual(after.protection.issues,[]);
for(const key of ['active','firewallActive','transparentActive','routingReady','dnsGuardActive','leaseActive'])assert.equal(after.protection[key],true);
const guestBytes=await readFile(path.join(root,'indirect-guest-after.json')),guest=JSON.parse(guestBytes);
assert.equal(guest.binarySHA256,expectedBinary);
assert.equal(guest.machineSHA256,'42193e80006e9b8015f4c246de94dfa9c6222d5e505e379120339c8781142fbf');
assert.equal(guest.productionClaudeInstalled,false);assert.deepEqual(guest.liveAuditProcesses,[]);
hashes['../indirect-production-after.json']=sha(afterBytes);hashes['../indirect-guest-after.json']=sha(guestBytes);
const report={checkedAt:new Date().toISOString(),recordedAt:runtime.recordedAt,
 version:'2.1.296',binarySHA256:expectedBinary,evidenceChecksPassed:true,
 accountFree:true,paidCalls:0,observations:8,calibrations:1,folder,hashes,rows,
 productionPostCheck:{checkedAt:after.checkedAt,networkProtectionVerified:true,originalMachineIdHashMatchesPreRunObservation:true,
  productionClaudeInstalled:false,liveAuditProcesses:[]},
 scope:'Intentional read-only local fixture requests, unmodified native client, UID 502, blank homes and private loopback-only namespace. No real provider or account. Read / Bash rules and a self-authored local stdio MCP were tested. MCP startup reads were observed locally and were not found in received request bodies; this does not prove all plugins, all request paths, or provider ban policy.',
 remaining:['Process-wide filesystem enforcement is separate from tool permissions','Hooks, other plugin and MCP implementations, Remote Control and authenticated paths remain untested','Future client versions require their own audit']};
await writeFile(path.join(root,'indirect-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({evidenceChecksPassed:true,observations:8,calibrations:1,rows},null,2));
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
