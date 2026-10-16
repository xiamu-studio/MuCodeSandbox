// Destructive operations are limited to the disposable environments created here.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {run} from '../server/process.ts';

const root=path.resolve(import.meta.dirname,'..'),data='/Users/staff/.mucodesandbox';
const info=JSON.parse(await readFile(data+'/service-info.json','utf8'));const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown){const r=await fetch(info.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
async function finish(job:any){for(let i=0;i<300;i++){const s=await api('/api/snapshot'),j=s.jobs.find((j:any)=>j.id===job.id);if(j&&j.status!=='running'){assert.equal(j.status,'succeeded',j.message);return;}await new Promise(r=>setTimeout(r,500));}throw Error('Operation exceeded 150 seconds');}
async function command(e:any,code:string){return run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',e.instanceName,'sudo','python3','-c',code],{env:{...process.env,LIMA_HOME:data+'/lima'},timeoutMs:20_000,maxBytes:32_768});}
const marker='MU_DISPOSABLE_'+randomUUID(),owned:string[]=[];
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),scope:'Actual disposable VM and snapshot cleanup, synthetic markers only; no user environment reset',ownedIds:owned};
try {
  const before=await api('/api/snapshot');report.userEnvironments=before.environments.map((e:any)=>({id:e.id,name:e.name}));
  const old=await api('/api/environments',{name:'临时 · 客户端清理验收',kind:'vm',cpus:2,memoryGiB:2,diskGiB:10,mounts:[],ports:[],network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true,egressLock:{expectedIp:'166.88.36.199'}},identity:{locale:'en-US',timezone:'America/Los_Angeles'}});owned.push(old.id);
  await finish(await api(`/api/environments/${old.id}/actions/start`,{}));
  const paths=['/home/dev/.config/Claude/mu-marker','/home/dev/.local/share/mucodesandbox/desktop-clients/claude-desktop/profile/mu-marker','/home/dev/.local/share/mucodesandbox/desktop-clients/grok-bot/cache/mu-marker','/home/dev/.local/share/keyrings/mu-marker','/home/dev/.claude/mu-marker','/root/.cache/mu-client-marker','/tmp/mu-client-marker','/opt/Claude/mu-client-marker'];
  report.oldIdentity=JSON.parse(await command(old,`import pathlib,json
paths=${JSON.stringify(paths)}
for value in paths:
    p=pathlib.Path(value);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(${JSON.stringify(marker)})
print(json.dumps({'machineId':pathlib.Path('/etc/machine-id').read_text().strip(),'markers':len(paths)}))`));
  await finish(await api(`/api/environments/${old.id}/actions/stop`,{}));
  await finish(await api(`/api/environments/${old.id}/snapshots`,{name:'无账号清理验证'}));
  for(const directory of ['browsers','imports','disk-recovery','restore']){await mkdir(path.join(data,directory,old.id),{recursive:true,mode:0o700});await writeFile(path.join(data,directory,old.id,'owned-synthetic-marker'),marker,{mode:0o600});}
  const reset=await api(`/api/environments/${old.id}/rebuild-clean`,{confirm:'erase-entire-environment'});owned.push(reset.replacementEnvironmentId);await finish(reset.job);
  const snapshot=await api('/api/snapshot');assert.ok(!snapshot.environments.some((e:any)=>e.id===old.id));const fresh=snapshot.environments.find((e:any)=>e.id===reset.replacementEnvironmentId);assert.ok(fresh);assert.notEqual(fresh.instanceName,old.instanceName);assert.deepEqual(fresh.mounts,[]);assert.deepEqual(fresh.ports,[]);
  for(const directory of ['browsers','snapshots','imports','disk-recovery','restore'])await assert.rejects(access(path.join(data,directory,old.id)));
  await assert.rejects(access(path.join(data,'lima',old.instanceName)));report.oldOwnedCopiesRemoved=true;
  await finish(await api(`/api/environments/${fresh.id}/actions/start`,{}));
  report.freshIdentity=JSON.parse(await command(fresh,`import pathlib,json
paths=${JSON.stringify(paths)}
print(json.dumps({'machineId':pathlib.Path('/etc/machine-id').read_text().strip(),'remaining':[p for p in paths if pathlib.Path(p).exists()],'claudeDesktopInstalled':pathlib.Path('/usr/bin/claude-desktop').exists(),'grokInstalled':pathlib.Path('/usr/bin/grok-bot').exists()}))`));
  assert.notEqual(report.oldIdentity.machineId,report.freshIdentity.machineId);assert.deepEqual(report.freshIdentity.remaining,[]);assert.equal(report.freshIdentity.claudeDesktopInstalled,false);assert.equal(report.freshIdentity.grokInstalled,false);
  const receipt=await api(`/api/environments/${fresh.id}/network/test`,{});assert.equal(receipt.ip,'166.88.36.199');report.freshExit=receipt;
  report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally {
  report.cleanup=[];
  for(const id of [...owned].reverse()){try{const s=await api('/api/snapshot');if(s.environments.some((e:any)=>e.id===id))await finish(await api(`/api/environments/${id}/actions/delete`,{}));report.cleanup.push({id,removed:true});}catch(error){report.cleanup.push({id,removed:false,error:String(error)});report.passed=false;process.exitCode=1;}}
  report.finishedAt=new Date().toISOString();await mkdir(path.join(root,'test-results/managed-desktop'),{recursive:true});await writeFile(path.join(root,'test-results/managed-desktop/clean-rebuild.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,oldCopiesRemoved:report.oldOwnedCopiesRemoved,markerCount:report.oldIdentity?.markers,remaining:report.freshIdentity?.remaining,cleanup:report.cleanup,error:report.error}));
}
