import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {run} from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:object){const response=await fetch(info.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+config.token,Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error??JSON.stringify(result));return result;}
async function finish(job:any){for(let n=0;n<180;n++){const state=(await api('/api/snapshot')).jobs.find((j:any)=>j.id===job.id);if(state.status==='succeeded')return;if(state.status!=='running')throw new Error(state.message);await new Promise(r=>setTimeout(r,500));}throw new Error('Desktop job timeout');}
const snapshot=await api('/api/snapshot');assert.equal(snapshot.system.version,'0.4.15');
const e=snapshot.environments.find((e:any)=>e.id===id);assert.ok(e);
async function inspectUnits(){return JSON.parse(await run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',e.instanceName,'sudo','python3','-c',`import subprocess,json,pathlib
units=['mucodesandbox-display.service','mucodesandbox-browser.service','mucodesandbox-desktop-grok-bot.service','mucodesandbox-desktop-claude-desktop.service']
result={}
for unit in units:
 data=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',unit,'--property=ActiveState','--property=MainPID']).decode().splitlines() if '=' in line)
 result[unit]=data
chrome=[]
for proc in pathlib.Path('/proc').iterdir():
 if not proc.name.isdigit(): continue
 try:
  exe=str((proc/'exe').readlink())
  if exe.startswith('/opt/mucodesandbox/chromium-'):chrome.append(int(proc.name))
 except (OSError,PermissionError):pass
result['chromePids']=chrome
print(json.dumps(result))`],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},timeoutMs:15000,maxBytes:16384}));}
const report:any={passed:false,version:snapshot.system.version,build:snapshot.system.application,accountLogin:false,paidModelCalls:0,startedAt:new Date().toISOString()};
try{
 if(e.state!=='running')await finish(await api(`/api/environments/${id}/actions/start`,{}));
 await api(`/api/environments/${id}/browser/close`,{});
 for(const app of ['grok-bot','claude-desktop'])await finish(await api(`/api/environments/${id}/desktop-apps/${app}/stop`,{}));
 await finish(await api(`/api/environments/${id}/desktop-apps/grok-bot/start`,{}));
 const before=await inspectUnits();assert.equal(before['mucodesandbox-browser.service'].ActiveState,'inactive');assert.deepEqual(before.chromePids,[]);assert.equal(before['mucodesandbox-display.service'].ActiveState,'active');
 const status=await api(`/api/environments/${id}/desktop-apps`);assert.equal(status.apps.find((a:any)=>a.id==='grok-bot').rendererProtected,true);
 assert.equal((await api('/api/snapshot')).environments.find((e:any)=>e.id===id).browserRunning,false);
 assert.equal((await api(`/api/environments/${id}/guest-browser`)).ready,true);report.desktopOnly={units:before,status};
 await finish(await api(`/api/environments/${id}/browser/open`,{showWindow:false}));
 const together=await inspectUnits();assert.equal(together['mucodesandbox-browser.service'].ActiveState,'active');assert.ok(together.chromePids.length>0,'Process detector requires a positive Chrome control');assert.equal(together['mucodesandbox-desktop-grok-bot.service'].MainPID,before['mucodesandbox-desktop-grok-bot.service'].MainPID);report.together=together;
 await api(`/api/environments/${id}/browser/close`,{});
 const after=await inspectUnits();assert.equal(after['mucodesandbox-browser.service'].ActiveState,'inactive');assert.deepEqual(after.chromePids,[]);assert.equal(after['mucodesandbox-display.service'].ActiveState,'active');assert.equal(after['mucodesandbox-desktop-grok-bot.service'].MainPID,before['mucodesandbox-desktop-grok-bot.service'].MainPID);report.browserClosePreservesClient=after;
 await finish(await api(`/api/environments/${id}/desktop-apps/grok-bot/stop`,{}));
 await finish(await api(`/api/environments/${id}/desktop-apps/claude-desktop/start`,{}));
 const claude=await inspectUnits();assert.equal(claude['mucodesandbox-browser.service'].ActiveState,'inactive');assert.deepEqual(claude.chromePids,[]);
 const clients=await api(`/api/environments/${id}/desktop-apps`);assert.equal(clients.apps.find((a:any)=>a.id==='claude-desktop').rendererProtected,true);report.claudeDesktopOnly={units:claude,status:clients};
 const protection=await api(`/api/environments/${id}/network/protection`);assert.equal(protection.active,true);report.protection=protection;
 report.passed=true;report.finishedAt=new Date().toISOString();
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{const results=path.join(root,'test-results/desktop-display-separation');await mkdir(results,{recursive:true});await writeFile(path.join(results,'actual.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
