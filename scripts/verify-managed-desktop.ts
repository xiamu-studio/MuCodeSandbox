import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {run} from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown){const r=await fetch(info.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
async function finish(job:any){for(let i=0;i<150;i++){const s=await api('/api/snapshot'),j=s.jobs.find((j:any)=>j.id===job.id);if(j&&j.status!=='running'){assert.equal(j.status,'succeeded',j.message);return;}await new Promise(r=>setTimeout(r,500));}throw Error('Operation exceeded 75 seconds');}
const initial=await api('/api/snapshot');assert.equal(initial.system.version,'0.4.10');
const environment=initial.environments.find((e:any)=>e.id===id);assert.ok(environment);
const vmArgs=['shell',environment.instanceName];
async function guest(args:string[],input?:string){return run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',[...vmArgs,...args],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},input,timeoutMs:20_000,maxBytes:65_536});}
async function files(app:string){return JSON.parse(await guest(['sudo','python3','-c',`import pathlib,json,hashlib
p=pathlib.Path('/home/dev/.local/share/mucodesandbox/desktop-clients/${app}')
files=[]
for directory in ['profile','config']:
    for f in (p/directory).rglob('*'):
        try:
            if not f.is_symlink() and f.is_file() and f.stat().st_size<2097152:
                files.append({'path':str(f.relative_to(p)),'bytes':f.stat().st_size,'sha256':hashlib.file_digest(f.open('rb'),'sha256').hexdigest()})
        except (FileNotFoundError,PermissionError): continue
print(json.dumps(files[:300]))`]));}
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),version:initial.system.version,build:initial.system.application,accountLogin:false,paidModelCalls:0,nativeVisualVerification:'pending manual Mac unlock',clients:[]};
try {
  if(environment.state!=='running')await finish(await api(`/api/environments/${id}/actions/start`,{}));
  for(const app of ['grok-bot','claude-desktop']){
    await finish(await api(`/api/environments/${id}/desktop-apps/${app}/start`,{}));
    const status=await api(`/api/environments/${id}/desktop-apps`),active=status.apps.find((a:any)=>a.id===app);
    assert.ok(active?.running&&active.rendererProtected===true);
    const receipt=await api(`/api/environments/${id}/network/test`,{});assert.equal(receipt.ip,'166.88.36.199');
    const first=await files(app);assert.ok(first.length>0,'Official client did not create profile files');
    const variables=JSON.parse(await guest(['sudo','python3','-c',`import pathlib,json
raw=pathlib.Path('/proc/${active.pid}/environ').read_bytes().split(bytes([0]))
env=dict(v.decode(errors='replace').split('=',1) for v in raw if b'=' in v)
print(json.dumps({k:env.get(k) for k in ['HOME','SSH_CONNECTION','SSH_AUTH_SOCK','DYLD_INSERT_LIBRARIES']}))`]));
    // The main process is dbus-run-session; its systemd HOME is /home/dev and it
    // never inherits host SSH/loader variables. App-specific TZ is in its launcher.
    assert.equal(variables.HOME,'/home/dev');assert.equal(variables.SSH_CONNECTION,null);assert.equal(variables.SSH_AUTH_SOCK,null);assert.equal(variables.DYLD_INSERT_LIBRARIES,null);
    await finish(await api(`/api/environments/${id}/desktop-apps/${app}/stop`,{}));
    assert.ok(!(await api(`/api/environments/${id}/desktop-apps`)).apps.find((a:any)=>a.id===app).running);
    const closed=await files(app);assert.ok(closed.length>0);
    await finish(await api(`/api/environments/${id}/desktop-apps/${app}/start`,{}));
    await finish(await api(`/api/environments/${id}/desktop-apps/${app}/stop`,{}));
    const reopened=await files(app);
    const stable=closed.filter((f:any)=>['Preferences','Local State'].some(n=>f.path.endsWith(n))).filter((f:any)=>reopened.some((r:any)=>r.path===f.path&&r.sha256===f.sha256));
    assert.ok(stable.length>0,'No real client state remained stable through ordinary close/reopen');
    report.clients.push({id:app,status:active,receipt,initialFileCount:first.length,closedFileCount:closed.length,reopenedFileCount:reopened.length,stableStateFiles:stable,hostVariables:variables});
  }
  report.protection=await api(`/api/environments/${id}/network/protection`);assert.ok(report.protection.active&&report.protection.integrity==='verified'&&report.protection.leaseActive);
  report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await mkdir(path.join(root,'test-results/managed-desktop'),{recursive:true});await writeFile(path.join(root,'test-results/managed-desktop/actual.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,version:report.version,clients:report.clients.map((c:any)=>({id:c.id,protected:c.status.rendererProtected,ip:c.receipt.ip,stableFiles:c.stableStateFiles.length})),error:report.error}));}
