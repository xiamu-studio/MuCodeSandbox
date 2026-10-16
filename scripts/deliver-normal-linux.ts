// Run only after the user approves updating the installed app. Use its authenticated API;
// never construct a production Store/Manager or open a new browser against a newer profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),installed='/Users/staff/Applications/MuCodeSandbox.app',app=path.join(installed,'Contents/Resources/app');
const expected=JSON.parse(await readFile(path.join(root,'build-info.json'),'utf8'));
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
assert.notEqual(info.pid,86474);assert.equal(new URL(info.url).hostname,'127.0.0.1');
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown,method?:string){const response=await fetch(info.url+route,{method:method??(body===undefined?'GET':'POST'),headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});const value=await response.json() as any;if(!response.ok)throw new Error(value.error);return value;}
const snapshot=await api('/api/snapshot');assert.equal(snapshot.system.version,'0.4.6');assert.equal(snapshot.system.application.buildId,expected.buildId);
const id='ee85e6f8-043b-4d02-be6e-7a0683c4bde8',e=snapshot.environments.find((e:any)=>e.id===id);assert.ok(e&&e.kind==='vm');
const report:Record<string,any>={passed:false,checkedAt:new Date().toISOString(),installed,pid:info.pid,build:expected,accountFree:true,paidModelCalls:0,userApprovedUpdate:true};
async function finish(job:any){for(let i=0;i<180;i++){const state=await api('/api/snapshot');const done=state.jobs.find((item:any)=>item.id===job.id);if(done&&done.status!=='running'){assert.equal(done.status,'succeeded',done.message);return;}await new Promise(r=>setTimeout(r,500));}throw new Error('Desktop operation exceeded bounded wait');}
try{
  await run('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
  report.cdHash=(await run('/usr/bin/codesign',['-d','--verbose=4',installed])).match(/^CDHash=(\S+)/m)![1];
  const binding:Record<string,string>={};
  for(const file of(await readdir(path.join(root,'dist-server/server'))).filter(file=>file.endsWith('.js'))){const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');binding[file]=digest(await readFile(path.join(app,'dist-server/server',file)));assert.equal(binding[file],digest(await readFile(path.join(root,'dist-server/server',file))));}
  report.modules=binding;
  console.log('Updating the existing VM to the authorized 4 CPU / 4 GiB resources; keeping its line and profile.');
  await finish(await api(`/api/environments/${id}/actions/stop`,{}));
  const network=Object.fromEntries(['mode','host','port','username','noProxy','strict','transparent','dns','tls','wireguard','egressLock'].filter(key=>e.network[key]!==undefined).map(key=>[key,e.network[key]]));
  const payload={name:e.name,description:e.description,kind:e.kind,color:e.color,cpus:4,memoryGiB:4,diskGiB:e.diskGiB,mounts:e.mounts,ports:e.ports,network,identity:e.identity,browserUrl:e.browserUrl};
  await api(`/api/environments/${id}`,payload,'PUT');
  await finish(await api(`/api/environments/${id}/actions/start`,{}));
  report.beforeBrowserVersion=await api(`/api/environments/${id}/browser/version`);
  console.log('Opening the compatible existing browser inside the updated desktop app.');
  await finish(await api(`/api/environments/${id}/browser/open`,{showWindow:false}));
  report.version=await api(`/api/environments/${id}/browser/version`);assert.equal(report.version.installedVersion,'156.0.8078.4');assert.equal(report.version.requiresFreshProfile,true);
  report.inspection=await api(`/api/environments/${id}/browser/inspect`);assert.equal(report.inspection.hardwareConcurrency,4);assert.equal(report.inspection.deviceMemoryGiB,4);assert.ok(report.inspection.matchesConfiguration);
  report.display=await api(`/api/environments/${id}/guest-browser/display`,{mode:'fixed',cssWidth:1600,cssHeight:1000,scaleFactor:2});assert.ok(report.display.matched);
  report.protection=await api(`/api/environments/${id}/network/protection`);assert.ok(report.protection.active&&report.protection.integrity==='verified'&&report.protection.leaseActive);
  const final=await api('/api/snapshot'),live=final.environments.find((x:any)=>x.id===id);assert.ok(live.state==='running'&&live.browserRunning);assert.equal(live.cpus,4);assert.equal(live.memoryGiB,4);assert.equal(live.network.port,e.network.port);assert.deepEqual(live.identity,e.identity);
  assert.equal(final.environments.find((x:any)=>x.id==='69716f45-c7b5-4020-bf84-8f8e6a616ea0').state,'stopped');
  report.environment={id:live.id,name:live.name,cpus:live.cpus,memoryGiB:live.memoryGiB,identity:live.identity,network:{mode:live.network.mode,host:live.network.host,port:live.network.port},browserRunning:true};report.originalVmStopped=true;report.oldProfileKeptCompatible=true;report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(root,'test-results/normal-linux/installed.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,pid:report.pid,buildId:expected.buildId,error:report.error}));}
