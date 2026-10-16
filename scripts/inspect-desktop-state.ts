import { readFile } from 'node:fs/promises';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'});
const cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop UI session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const snapshot=await(await fetch(`${info.url}/api/snapshot`,{headers:{Authorization:`Bearer ${config.token}`}})).json() as any;
console.log(JSON.stringify({pid:info.pid,version:snapshot.system.version,application:snapshot.system.application,
  environments:snapshot.environments.map((e:any)=>({id:e.id,name:e.name,state:e.state,kind:e.kind,cpus:e.cpus,memoryGiB:e.memoryGiB,diskGiB:e.diskGiB,
    network:{mode:e.network.mode,host:e.network.host,port:e.network.port,strict:e.network.strict,transparent:e.network.transparent},identity:e.identity,browserRunning:e.browserRunning,lastError:e.lastError})),
  activeJobs:snapshot.jobs.filter((j:any)=>j.status==='running').map((j:any)=>({id:j.id,environmentId:j.environmentId,action:j.action,status:j.status})),
  recentJobs:snapshot.jobs.slice(0,3).map((j:any)=>({id:j.id,action:j.action,status:j.status,message:j.message}))},null,2));
