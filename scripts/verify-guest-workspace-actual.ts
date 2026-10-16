import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {run} from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be',results=path.join(root,'test-results/guest-workspace-handoff');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:object){const response=await fetch(info.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+config.token,Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error??'API rejected fixture');return result;}
async function finish(job:any){for(let n=0;n<240;n++){const found=(await api('/api/snapshot')).jobs.find((j:any)=>j.id===job.id);if(found?.status==='succeeded')return found;if(found?.status!=='running')throw new Error(found?.message??'Missing job');await new Promise(r=>setTimeout(r,500));}throw new Error('Managed operation did not complete');}
let initial=await api('/api/snapshot');assert.equal(initial.system.version,'0.4.18');
// After a native app update the previous process has revoked its lease. Wait
// for the existing fail-closed reconciliation, then use the normal Start path.
for(let n=0;n<50;n++){
 const current=initial.environments.find((value:any)=>value.id===id);
 if(current?.state!=='running'&&!initial.jobs.some((j:any)=>j.environmentId===id&&j.status==='running'))break;
 const guard=await api(`/api/environments/${id}/network/protection`);
 if(guard.active&&guard.leaseActive)break;
 await new Promise(r=>setTimeout(r,300));initial=await api('/api/snapshot');
}
const e=initial.environments.find((e:any)=>e.id===id);assert.ok(e);
async function guest(args:string[],input?:string){return run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',e.instanceName,...args],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},input,timeoutMs:20000,maxBytes:16384});}
async function units(){return JSON.parse(await guest(['sudo','python3','-c',`import subprocess,json
result={}
for app in ['display','browser','desktop-grok-bot','desktop-claude-desktop']:
 unit='mucodesandbox-'+app+'.service'
 result[app]=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',unit,'-p','ActiveState','-p','MainPID']).decode().splitlines() if '=' in line)
print(json.dumps(result))`]));}
const fixture='/home/dev/.cache/mu-oauth-handoff-'+randomUUID().replaceAll('-',''),report:any={passed:false,startedAt:new Date().toISOString(),version:initial.system.version,build:initial.system.application,accountsUsed:false,paidCalls:0,scope:'Real installed VM and managed units, default xdg browser, local fake OAuth roundtrip and registered client URI; not real vendor account authentication'};
let fixturePid=0;
try{
 if(e.state!=='running')await finish(await api(`/api/environments/${id}/actions/start`,{}));
 await finish(await api(`/api/environments/${id}/desktop-apps/grok-bot/start`,{}));
 await finish(await api(`/api/environments/${id}/desktop-apps/claude-desktop/start`,{}));
 await finish(await api(`/api/environments/${id}/browser/open`,{showWindow:false}));
 const parallel=await units();for(const entry of Object.values(parallel) as any[])assert.equal(entry.ActiveState,'active');report.parallel=parallel;
 const desktop=await api(`/api/environments/${id}/desktop-apps`);for(const app of desktop.apps)assert.equal(app.rendererProtected,true);report.rendererProtected=desktop.apps.map((a:any)=>({id:a.id,protected:a.rendererProtected}));
 for(const target of ['browser','grok-bot','claude-desktop','browser','claude-desktop','grok-bot']){const focused=await api(`/api/environments/${id}/guest-focus`,{target});assert.equal(focused.focused,true,'Managed window not found: '+target);}
 assert.deepEqual(await units(),parallel,'Window switches must not restart programs');report.switchesPreservedPids=true;
 await api(`/api/environments/${id}/browser/close`,{});const browserClosed=await units();assert.equal(browserClosed.browser.ActiveState,'inactive');assert.equal(browserClosed['desktop-grok-bot'].MainPID,parallel['desktop-grok-bot'].MainPID);assert.equal(browserClosed['desktop-claude-desktop'].MainPID,parallel['desktop-claude-desktop'].MainPID);report.closeBrowserPreservesClients=browserClosed;
 const fixtureServer=String.raw`import http.server,json,pathlib,threading,subprocess,os,hashlib,time
root=pathlib.Path(__file__).parent
state='MU_LOCAL_OAUTH_STATE';code='MU_FAKE_AUTHORIZATION_CODE'
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  import urllib.parse
  url=urllib.parse.urlsplit(self.path)
  if url.path=='/authorize':
   body=('<!doctype html><title>MuCodeSandbox local OAuth fixture</title><h1>Account-free browser handoff</h1><script>document.cookie="mu_handoff_demo=1; SameSite=Lax; path=/callback";location.href="/callback?code='+code+'&state='+state+'";</script>').encode()
  elif url.path=='/callback':
   query=urllib.parse.parse_qs(url.query)
   result={'authorizationCodeMatches':query.get('code')==[code],'stateMatches':query.get('state')==[state],'browserCookieReturned':'mu_handoff_demo=1' in self.headers.get('Cookie',''),'remotePeerIsGuestLoopback':self.client_address[0]=='127.0.0.1'}
   (root/'receipt.json').write_text(json.dumps(result))
   body=b'<!doctype html><title>MuCodeSandbox mock callback received</title><h1>Local callback received; no real account used.</h1>'
   # A benign official desktop action exercises the registered return handler,
   # without submitting a fake code to any vendor authentication service.
   threading.Timer(.2,lambda:subprocess.run(['/usr/bin/xdg-open','claude://claude.ai/new?surface=chat&source=mu_local_handoff_test'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)).start()
  else:body=b'fixture'
  self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_port));(root/'pid').write_text(str(os.getpid()));server.serve_forever()
`;
 const preparation=`import pathlib,os,subprocess,json
p=pathlib.Path(${JSON.stringify(fixture)});p.mkdir(mode=0o700,parents=True)
(p/'server.py').write_text(${JSON.stringify(fixtureServer)})
with (p/'output.log').open('wb') as log:
 child=subprocess.Popen(['/usr/bin/python3',str(p/'server.py')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={'HOME':'/home/dev','PATH':'/usr/local/bin:/usr/bin:/bin','DISPLAY':':99','XAUTHORITY':'/run/mu-browser/Xauthority','XDG_CURRENT_DESKTOP':'Openbox','BROWSER':'/usr/local/bin/mu-open-link'})
print(child.pid)
`;
 fixturePid=Number((await guest(['sudo','-H','-u','dev','--','python3','-c',preparation])).trim());assert.ok(fixturePid>1);
 let port=0;for(let n=0;n<50;n++){port=Number((await guest(['sudo','cat',fixture+'/port']).catch(()=>'' )).trim());if(port)break;await new Promise(r=>setTimeout(r,100));}assert.ok(port>0);
 const jobsBefore=new Set((await api('/api/snapshot')).jobs.map((j:any)=>j.id));
 await guest(['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/local/bin:/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority','XDG_CURRENT_DESKTOP=Openbox','BROWSER=/usr/local/bin/mu-open-link','/usr/bin/xdg-open',`http://127.0.0.1:${port}/authorize`]);
 let receipt:any;
 for(let n=0;n<150;n++){
  const text=await guest(['sudo','cat',fixture+'/receipt.json']).catch(()=>'' );if(text.trim()){receipt=JSON.parse(text);break;}
  await new Promise(r=>setTimeout(r,200));
 }
 assert.ok(receipt,'Default browser did not execute the local callback');for(const value of Object.values(receipt))assert.equal(value,true);report.mockOAuth=receipt;
 let handoffJobs:any[]=[];
 for(let n=0;n<100;n++){handoffJobs=(await api('/api/snapshot')).jobs.filter((j:any)=>j.action==='open-external-link'&&!jobsBefore.has(j.id));if(handoffJobs.length>=2&&handoffJobs.every(j=>j.status==='succeeded'))break;await new Promise(r=>setTimeout(r,200));}
 assert.ok(handoffJobs.length>=2&&handoffJobs.every(j=>j.status==='succeeded'),'Web and client return handoffs did not both complete');report.handoffJobs=handoffJobs.map(({id,action,status}:any)=>({id,action,status}));
 const after=await units();assert.equal(after.browser.ActiveState,'active','Closed browser must auto-open from xdg link');for(const name of ['desktop-grok-bot','desktop-claude-desktop'])assert.equal(after[name].MainPID,parallel[name].MainPID);report.automaticBrowserAndReturnPreserveClients=after;
 const guard=await api(`/api/environments/${id}/network/protection`);assert.ok(guard.active&&guard.integrity==='verified'&&guard.leaseActive);report.guard={active:guard.active,integrity:guard.integrity,leaseActive:guard.leaseActive};
 const network=await api(`/api/environments/${id}/network/test`,{});assert.equal(network.ip,'166.88.36.199');report.approvedExit=network.ip;
 report.passed=true;report.finishedAt=new Date().toISOString();
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{
 if(fixturePid>1)await guest(['sudo','-H','-u','dev','--','kill','-TERM',String(fixturePid)]).catch(()=>{});
 await guest(['sudo','-H','-u','dev','--','rm','-rf',fixture]).catch(()=>{});
 await mkdir(results,{recursive:true});await writeFile(path.join(results,'actual.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
