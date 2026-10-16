import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(path.join(homedir(),'.mu-native-lab-'));
const application=await electron.launch({args:[root],env:{...process.env,MU_DATA_DIR:path.join(temporary,'data'),MU_DESKTOP_USER_DATA_DIR:path.join(temporary,'desktop')}});
const window=await application.firstWindow();
const report={passed:false,accountFree:true,paidModelCalls:0,measurements:[]};
async function request(endpoint,method='GET',body){return window.evaluate(async({endpoint,method,body})=>{const r=await fetch('/api'+endpoint,{method,headers:{Authorization:'Bearer '+window.__MU_CONFIG__.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw new Error(v.error);return v},{endpoint,method,body})}
async function waitJob(job){for(let i=0;i<60;i++){const j=(await request('/snapshot')).jobs.find(j=>j.id===job.id);if(j.status!=='running'){assert.equal(j.status,'succeeded',j.message);return}await new Promise(resolve=>setTimeout(resolve,500))}throw new Error('Job timed out')}
try{
 await window.getByRole('heading',{name:'MuCodeSandbox',exact:true}).waitFor();
 const lab=await request('/lab/start','POST');
 for(const identity of [{locale:'en-US',timezone:'America/New_York'},{locale:'ja-JP',timezone:'Asia/Tokyo'}]){
  const e=await request('/environments','POST',{name:'检测 '+identity.locale,kind:'browser',browserUrl:lab.url,identity});
  await waitJob(await request('/environments/'+e.id+'/browser/open','POST'));
  const result=await application.evaluate(async({BrowserWindow},{id})=>{
   const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('browser='+id));
   const v=w.contentView.children.find(v=>v.webContents);
   for(let i=0;i<80;i++){const value=await v.webContents.executeJavaScript('({result:window.__MU_PROBE__,error:window.__MU_PROBE_ERROR__})');if(value.error)throw new Error(value.error);if(value.result)return value.result;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Probe timed out');
  },{id:e.id});
  report.measurements.push(result);
  assert.equal(result.page.language,identity.locale);
  assert.equal(result.page.timezone,identity.timezone);
  assert.deepEqual(result.mismatches,[]);
  assert.ok(result.page.clientHints.brands.length>0);
  assert.ok(result.headers.acceptLanguage.startsWith(identity.locale));
  assert.equal(result.headers.userAgent,result.page.userAgent);
  await waitJob(await request('/environments/'+e.id+'/actions/delete','POST'));
 }
 report.consistent=report.measurements.every(r=>r.mismatches.length===0);
 await request('/lab/stop','POST');
 report.passed=true;
}catch(error){report.error=error.message;report.logs=await request('/logs');process.exitCode=1;}
finally{await application.close();await rm(temporary,{recursive:true,force:true});await mkdir(path.join(root,'test-results'),{recursive:true});await writeFile(path.join(root,'test-results/native-lab.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,measurements:report.measurements.map(r=>({timezone:r.page.timezone,language:r.page.language,mismatches:r.mismatches}))},null,2));}
