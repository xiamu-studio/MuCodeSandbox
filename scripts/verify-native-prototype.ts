import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import path from 'node:path';
import {run} from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..');
const temporary=await realpath(await mkdtemp(path.join(tmpdir(),'mu-native-prototype-')));
const results=path.join(root,'test-results/native-prototype');
await mkdir(results,{recursive:true});
await writeFile(path.join(temporary,'.mu-native-prototype'),'owned-test-data\n',{mode:0o600});
const require=createRequire(import.meta.url);
const report:Record<string,unknown>={passed:false,scope:'Separate native Electron process, synthetic offline content and temporary profiles only. No account, VPS, real profile, system extension or system settings used.',systemNetworkProtection:false};
async function launch(environment:'first'|'second',action:'seed'|'inspect'){
  await run(require('electron'),[path.join(root,'native/prototype/runtime.cjs')],{timeoutMs:45000,env:{...process.env,MU_NATIVE_PROTOTYPE:JSON.stringify({root:temporary,environment,action})}});
  return JSON.parse(await readFile(path.join(temporary,environment,'result.json'),'utf8'));
}
try{
  const first=await launch('first','seed');
  assert.equal(first.before,null);assert.equal(first.note,'synthetic note');
  assert.equal(first.sandbox,true);assert.equal(first.contextIsolation,true);assert.equal(first.nodeIntegration,false);assert.equal(first.nodeAvailable,false);
  assert.equal(first.requestBlocked,true);assert.equal(first.canvas,true);
  const reopened=await launch('first','inspect');
  assert.equal(reopened.before,'synthetic note');assert.deepEqual(reopened.cookies,[{name:'synthetic',value:'retained'}]);
  const second=await launch('second','inspect');
  assert.equal(second.before,null);assert.deepEqual(second.cookies,[]);
  // Entire owned environment root, not just HTTP cache / cookies.
  await rm(path.join(temporary,'first'),{recursive:true});
  await assert.rejects(access(path.join(temporary,'first')));
  const reset=await launch('first','inspect');
  assert.equal(reset.before,null);assert.deepEqual(reset.cookies,[]);
  assert.equal((await launch('second','inspect')).before,null);
  Object.assign(report,{passed:true,first,reopened,second,reset,checks:['renderer sandbox and Node disabled','real renderer / GPU report','application-layer external request refusal (not OS enforcement)','same environment persists across process restart','new environment starts empty','reset removes owned runtime/profile/session/crash files','other environment unaffected']});
}catch(error){report.error=String(error);process.exitCode=1;}
finally{await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'offline.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));}
