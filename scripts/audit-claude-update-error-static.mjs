import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const receipt=JSON.parse(await readFile(path.join(root,'packages/2.1.296/receipt.json'),'utf8'));
const bytes=await readFile(path.join(root,'packages/2.1.296',receipt.binary));
const hash=createHash('sha256').update(bytes).digest('hex');
assert.equal(hash,receipt.sha256);
assert.equal(hash,'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa');
const specs=[
 ['trafficMode','function ADt(){if(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',900],
 ['autoUpdaterGate','function qAe(){return rA(Fe(process.env.DISABLE_AUTOUPDATER))}',700],
 ['updateThrottle','function zZe(){let e=ne(),r=Date.now();',850],
 ['updateRestoreState','function LGe(){return ne().updateRestoreFailure}',1250],
 ['errorRecorder','function c(t){let e=W(t);try{if(Fe(process.env.CLAUDE_CODE_USE_BEDROCK)',850],
 ['errorReportingGate','function Qbs(){if(process.env.DISABLE_ERROR_REPORTING)',1600],
 ['errorForwarder','function JDe(e,r="logError"){if(!Qbs())return;',600],
 ['uncaughtAndRejectedHandlers','process.on("uncaughtException",(r)=>{if(this.uncaughtBreakerTripped)',3100],
];
const points=specs.map(([name,needle,length])=>{
 const offset=bytes.indexOf(needle,200000000);
 assert.ok(offset>=0,`${name} missing from version-bound executable`);
 const end=offset+length;
 return{name,needle,offset,end,excerpt:bytes.subarray(offset,end).toString()};
});
const find=name=>points.find(p=>p.name===name).excerpt;
assert.match(find('autoUpdaterGate'),/DISABLE_UPDATES.*DISABLE_AUTOUPDATER/);
assert.match(find('autoUpdaterGate'),/autoUpdates===!1/);
assert.match(find('errorRecorder'),/DISABLE_ERROR_REPORTING\|\|Tt\(\)/);
assert.match(find('errorReportingGate'),/Oe\(\)!=="firstParty"\|\|!vi\(\)/);
assert.match(find('errorForwarder'),/hfo\(t\)/);
assert.match(find('uncaughtAndRejectedHandlers'),/JDe\(r,"uncaught_exception"\)/);
assert.match(find('uncaughtAndRejectedHandlers'),/process\.on\("unhandledRejection"/);
const report={checkedAt:new Date().toISOString(),version:'2.1.296',binarySHA256:hash,points,
 observations:{
  updateGateRecognizesDisableFlagsAndSettings:true,
  updateCheckHasPerProcessThrottle:true,
  updateRestoreFailureStateExists:true,
  errorRecorderRecognizesNonessentialAndErrorOptOut:true,
  errorForwardingHasFirstPartyEligibilityAndPolicyGates:true,
  javascriptUncaughtExceptionAndUnhandledRejectionHandlersPresent:true,
 },
 limits:[
  'Version-bound static excerpts in the original executable; no CLI invocation or network request.',
  'An eligible branch is not proof of execution, acceptance of a payload, or observed data transmission.',
  'JavaScript exception handlers do not prove native segmentation-fault, SIGKILL, Bun crash or uploader coverage.',
  'No real account, crash, update, binary replacement, policy change, telemetry opt-out or profile mutation was performed.',
 ],
};
await mkdir(path.join(root,'static'),{recursive:true,mode:0o700});
const file=path.join(root,'static/update-error-paths-2.1.296.json');
await writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({file,version:report.version,binarySHA256:hash,points:points.map(({name,offset})=>({name,offset})),observations:report.observations,limits:report.limits},null,2));
