// Uses the live desktop service for access authorization; never opens a production Store.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';
import {GuestDesktop,desktopAppSchema,DESKTOP_RECIPES} from '../server/guest-desktop.ts';
import type {Environment} from '../shared/types.ts';

const app=desktopAppSchema.parse(process.argv[2]??'claude-desktop'),id='76c193f7-09a2-4544-83b8-4852445ab2be',root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown){const r=await fetch(info.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
const snapshot=await api('/api/snapshot'),e=snapshot.environments.find((e:Environment)=>e.id===id) as Environment;
assert.ok(e&&e.state==='running'&&e.network.strict&&e.network.transparent);
await api(`/api/environments/${id}/network/test`,{});
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),app,recipe:DESKTOP_RECIPES[app],accountLogin:false,paidModelCalls:0};
try {
  const runtime=new LimaRuntime('/Users/staff/.mucodesandbox'),desktop=new GuestDesktop(runtime);
  console.log('Installing '+app+' from its pinned official ARM64 package, with rate-limited download and existing exit protection.');
  await desktop.install(e,app,{onOutput:s=>console.log(s),timeoutMs:240_000});
  report.apps=await desktop.status(e);report.egress=await api(`/api/environments/${id}/network/test`,{});assert.equal(report.egress.ip,'166.88.36.199');
  report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(root,`test-results/${app}-installation.json`),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,app,error:report.error}));}
