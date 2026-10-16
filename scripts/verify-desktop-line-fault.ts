import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {run} from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be';
const plist='/Users/staff/Library/LaunchAgents/local.mucodesandbox.relay-dedione-lax.plist',domain=`gui/${process.getuid!()}`;
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));const l=await fetch(info.launchUrl,{redirect:'manual'}),cookie=l.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown){const r=await fetch(info.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
async function finish(job:any){for(let i=0;i<150;i++){const s=await api('/api/snapshot'),j=s.jobs.find((j:any)=>j.id===job.id);if(j&&j.status!=='running'){assert.equal(j.status,'succeeded',j.message);return;}await new Promise(r=>setTimeout(r,500));}throw Error('Operation exceeded 75 seconds');}
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),scope:'Actual dedicated VPS tunnel cut while a no-account managed client is running; no global Mac network changes',accountLogin:false,paidModelCalls:0};let cut=false;
try {
  await finish(await api(`/api/environments/${id}/desktop-apps/claude-desktop/start`,{}));
  const before=await api(`/api/environments/${id}/desktop-apps`);assert.ok(before.apps.find((a:any)=>a.id==='claude-desktop').running);report.before=before;
  await run('/bin/launchctl',['bootout',domain,plist],{timeoutMs:10_000});cut=true;
  try{await run('/usr/bin/curl',['-q','--fail','--silent','--show-error','--max-time','5','--proxy','socks5h://127.0.0.1:24898','https://api.ipify.org/'],{timeoutMs:7000});throw Error('Cut tunnel unexpectedly connected');}
  catch(error){assert.ok(!String(error).includes('unexpectedly connected'));report.hostSocksFailed=true;}
  let stopped=false;
  for(let i=0;i<120;i++){const s=await api('/api/snapshot'),e=s.environments.find((e:any)=>e.id===id);if(e&&e.state==='error'&&!e.browserRunning){report.after={state:e.state,browserRunning:e.browserRunning,lastError:e.lastError};stopped=true;break;}await new Promise(r=>setTimeout(r,500));}
  assert.ok(stopped,'Environment did not enter quarantine within 60 seconds');
  report.quarantineCompleted=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally {
  if(cut){await run('/bin/launchctl',['bootstrap',domain,plist],{timeoutMs:10_000});report.dedicatedLineRestored=true;}
  try {
    await new Promise(r=>setTimeout(r,2000));await finish(await api(`/api/environments/${id}/actions/start`,{}));
    report.restoredExit=await api(`/api/environments/${id}/network/test`,{});assert.equal(report.restoredExit.ip,'166.88.36.199');
    const apps=await api(`/api/environments/${id}/desktop-apps`);assert.ok(apps.apps.every((a:any)=>!a.running));report.clientsStoppedAfterQuarantine=true;
    report.passed=!report.error&&report.quarantineCompleted&&report.hostSocksFailed;
  }catch(error){report.restoreError=String(error);report.passed=false;process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await writeFile(path.join(root,'test-results/managed-desktop/line-fault.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,quarantine:report.quarantineCompleted,restored:report.dedicatedLineRestored,exit:report.restoredExit?.ip,error:report.error,restoreError:report.restoreError}));
}
