// Independent evidence checks. This does not turn finite tests into an invisibility guarantee.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const receipt=await json('packages/2.1.296/receipt.json');
assert.equal(receipt.signatureVerified,true);
const executable=await readFile(path.join(root,'packages/2.1.296',receipt.binary));
assert.equal(sha(executable),receipt.sha256);
assert.equal(receipt.sha256,'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa');
const findings=[],runs=[];
for(const folder of ['runtime-local-final','runtime-firstparty-final','runtime-extra-final','runtime-product-final']){
 const runtime=await json(folder+'/runtime.json'),requests=await json(folder+'/receipts.json');
 assert.equal(runtime.sha256,receipt.sha256);assert.equal(runtime.accountFree,true);assert.equal(runtime.paidCalls,0);
 assert.deepEqual(runtime.namespace.interfaces,['lo']);assert.notEqual(runtime.namespace.hostNetwork,runtime.namespace.testNetwork);
 assert.ok(runtime.namespace.originalHomesMasked&&runtime.namespace.resolverIpcMasked);
 assert.equal(runtime.namespace.routes.some(r=>r.dst==='default'),false);
 assert.equal(runtime.runnerSHA256,sha(await readFile(path.join(root,folder,'runner.py'))));
 assert.equal(runtime.receiptCount,requests.length);
 const hashes={};
 for(const c of runtime.cases){
  const trace=await readFile(path.join(root,folder,c.name+'.strace'));
  assert.equal(trace.length,c.traceBytes);hashes[c.name+'.strace']=sha(trace);
  const output=await readFile(path.join(root,folder,c.name+'.output'));assert.equal(output.length,c.outputBytes);hashes[c.name+'.output']=sha(output);
  const text=trace.toString('utf8');
  const payloads=requests.filter(r=>r.case===c.name),messages=payloads.filter(r=>r.path.startsWith('/v1/messages?'));
  const vmProbeAttempt=text.includes('/sys/hypervisor/uuid');
  const machineIdRead=/read\([^\n]*<\/etc\/machine-id>/.test(text);
  const appleDmiRead=/read\([^\n]*<\/sys\/devices\/virtual\/dmi\/id\/product_name>/.test(text);
  const toolResults=messages.flatMap(r=>r.body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result');
  const explicitVmToolResult=toolResults.some(b=>!b.is_error&&/^apple\s/.test(b.content));
  const eventRequests=payloads.filter(r=>r.path.startsWith('/api/event_logging/'));
  const envValues=eventRequests.flatMap(r=>r.body?.events??[]).map(e=>e.event_data?.env).filter(Boolean);
  const modelHeaders=messages[0]?.headers??{};
  const modelBody=messages[0]?JSON.stringify(messages[0].body):'';
  const caseResult={name:c.name,exitCode:c.exitCode,timedOut:c.timedOut,requests:payloads.length,modelRequests:messages.length,
   vmProbeAttempt,machineIdRead,appleDmiRead,explicitVmToolResult,
   telemetryRequests:eventRequests.length,deploymentValues:[...new Set(envValues.map(v=>v.deployment_environment).filter(Boolean))],
   telemetryEnvFields:[...new Set(envValues.flatMap(v=>Object.keys(v)))],
   requestHeaders:{os:modelHeaders['X-Stainless-OS'],arch:modelHeaders['X-Stainless-Arch'],runtime:modelHeaders['X-Stainless-Runtime'],runtimeVersion:modelHeaders['X-Stainless-Runtime-Version']},
   deviceIdInModelRequest:messages.length?!!JSON.parse(messages[0].body.metadata?.user_id??'{}').device_id:false,
   kernelVersionInModelRequest:modelBody.includes('6.8.0-134-generic'),
   rawAppleLabelInModelRequest:modelBody.includes('Apple Virtualization Generic Platform'),
   interactiveTaskSent:c.taskSent??false,interactiveResponseObserved:c.taskResponseObserved??false};
  findings.push(caseResult);
  if(c.name==='trace-calibration'){assert.equal(c.exitCode,0);assert.ok(appleDmiRead&&text.includes('Apple Virtualization Generic Platform'));}
  if(['local-default','local-optout','local-demo','firstparty-default','firstparty-optout','firstparty-demo','product-default','product-optout'].includes(c.name)){
   assert.equal(c.exitCode,0);assert.equal(c.timedOut,false);assert.ok(messages.length>0);
   assert.equal(modelHeaders['X-Stainless-OS'],'Linux');assert.equal(modelHeaders['X-Stainless-Arch'],'arm64');
   assert.ok(caseResult.deviceIdInModelRequest&&caseResult.kernelVersionInModelRequest);
   assert.ok(vmProbeAttempt&&machineIdRead);assert.equal(appleDmiRead,false);
  }
  if(['firstparty-default','product-default'].includes(c.name)){assert.ok(eventRequests.length>0);assert.ok(caseResult.deploymentValues.includes('unknown-linux'));}
  if(['firstparty-optout','product-optout'].includes(c.name)){assert.equal(eventRequests.length,0);assert.ok(vmProbeAttempt);}
  if(c.name==='firstparty-vm-tool'){assert.ok(explicitVmToolResult&&appleDmiRead);assert.equal(eventRequests.length,0);}
  if(c.name==='firstparty-interactive-demo'){assert.ok(c.taskSent&&c.taskResponseObserved);assert.ok(messages.length>0);}
 }
 runs.push({folder,recordedAt:runtime.recordedAt,runnerSHA256:runtime.runnerSHA256,hashes,namespace:runtime.namespace,
  rawReceiptsSHA256:sha(await readFile(path.join(root,folder,'receipts.json')))});
}
const report={checkedAt:new Date().toISOString(),version:receipt.version,executableSHA256:receipt.sha256,
 evidenceChecksPassed:true,accountFree:true,paidModelCalls:0,runs,findings,
 scope:'Version-bound finite unauthenticated tests of the real unmodified native client. First-party hostnames route only to an isolated local TLS fixture. Tool probe was explicitly requested and authorized in the fixture. No claim about real authenticated provider traffic, all features, ban decisions, or VM invisibility.',
 remaining:['Authenticated real-provider and subscription-specific paths not exercised','Remote Control, plugins, custom MCP, updates, crashes and future versions require separate coverage','No proof of service-side enforcement decisions','Continuous rechecks remain active']};
await writeFile(path.join(root,'verified-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({evidenceChecksPassed:true,version:report.version,cases:findings.length,
 nativeEnvironmentReads:findings.filter(c=>c.vmProbeAttempt).map(c=>c.name),
 defaultDeployment:findings.find(c=>c.name==='firstparty-default')?.deploymentValues,
 explicitVmToolResult:findings.find(c=>c.name==='firstparty-vm-tool')?.explicitVmToolResult}));
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
async function json(file){return JSON.parse(await readFile(path.join(root,file),'utf8'));}
