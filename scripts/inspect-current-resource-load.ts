import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';

const label=process.argv[2]??'current';
if(!/^[a-z0-9-]{1,48}$/.test(label))throw new Error('Invalid observation label');
const root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'});
const cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
const api=async(suffix:string)=>{
 const response=await fetch(`${info.url}/api/${suffix}`,{headers});
 if(!response.ok)throw new Error(`Inspection failed: ${response.status}`);
 return response.json() as Promise<any>;
};
const snapshot=await api('snapshot');
const environment=snapshot.environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');
if(environment?.state!=='running')throw new Error('Existing selected environment unavailable');
const protection=await api(`environments/${environment.id}/network/protection`);
if(!protection.active||protection.integrity!=='verified'||!protection.leaseActive)throw new Error('Guard is not verified');
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const query=`import json,pathlib,time
p=pathlib.Path('/proc')
def sample():
 memory={}
 for line in (p/'meminfo').read_text().splitlines():
  key,value=line.split(':',1)
  if key in ['MemTotal','MemAvailable','SwapTotal','SwapFree']:memory[key+'KiB']=int(value.split()[0])
 vm={line.split()[0]:int(line.split()[1]) for line in (p/'vmstat').read_text().splitlines()}
 pressure={}
 for kind in ['cpu','memory','io']:
  q=p/'pressure'/kind
  if q.exists():pressure[kind]=[{key:float(value) for key,value in (field.split('=',1) for field in line.split()[1:])} for line in q.read_text().splitlines()]
 cpu=[int(v) for v in (p/'stat').read_text().splitlines()[0].split()[1:]]
 return {'at':time.time(),'memory':memory,'oomKillsSinceBoot':vm.get('oom_kill'),'cpuTicks':cpu,'pressure':pressure}
samples=[]
for index in range(5):
 samples.append(sample())
 if index<4:time.sleep(2)
displays=[]
for entry in p.iterdir():
 if not entry.name.isdigit():continue
 try:
  name=(entry/'comm').read_text().strip()
  if name not in ('Xtigervnc','Xvnc'):continue
  args=(entry/'cmdline').read_bytes().decode().split('\\0')
  displays.append({'pid':int(entry.name),'server':name,'frameRate':[v for v in args if v.startswith('-FrameRate=')],'encodingThreads':int(args[args.index('-nthreads')+1]) if '-nthreads' in args else None})
 except (FileNotFoundError,PermissionError):pass
print(json.dumps({'samples':samples,'displays':displays}))`;
const startedAt=new Date().toISOString();
const guest=JSON.parse(await runtime.management(environment,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','python3','-c',query],{timeoutMs:14000,maxBytes:12000}));
for(let i=1;i<guest.samples.length;i++){
 const previous=guest.samples[i-1].cpuTicks,current=guest.samples[i].cpuTicks;
 const delta=current.slice(0,8).map((v:number,j:number)=>v-previous[j]);
 const total=delta.reduce((a:number,b:number)=>a+b,0);
 guest.samples[i].cpuBusyPercent=total>0?Math.round((total-delta[3]-delta[4])/total*1000)/10:null;
}
const run=promisify(execFile);
const hostVm=(await run('/usr/bin/vm_stat',[],{timeout:4000,maxBuffer:16384})).stdout;
const hostSwap=(await run('/usr/sbin/sysctl',['vm.swapusage','hw.memsize'],{timeout:4000,maxBuffer:2048})).stdout;
const after=await api('snapshot');
const afterEnvironment=after.environments.find((e:any)=>e.id===environment.id);
const afterProtection=await api(`environments/${environment.id}/network/protection`);
const report={startedAt,finishedAt:new Date().toISOString(),label,application:snapshot.system.application,
 environmentId:environment.id,resources:{cpus:environment.cpus,memoryGiB:environment.memoryGiB,diskGiB:environment.diskGiB},
 scope:'Read-only eight-second memory/CPU/pressure/OOM counters and host memory statistics during manually observed application use. No artificial stress, model call, identifiers, process arguments or configuration changes. This does not prove large-repository or long-running capacity.',
 guest,host:{vmStat:hostVm,swapAndPhysicalMemory:hostSwap},
 after:{state:afterEnvironment?.state,lastError:afterEnvironment?.lastError,active:afterProtection.active,integrity:afterProtection.integrity,leaseActive:afterProtection.leaseActive,
 firewallUnchanged:protection.firewallHash===afterProtection.firewallHash,tunnelUnchanged:protection.tunnelConfigHash===afterProtection.tunnelConfigHash}};
const directory=path.join(root,'test-results/current-resource-load');
await mkdir(directory,{recursive:true});
const file=path.join(directory,`${startedAt.replaceAll(':','-')}-${label}.json`);
await writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({file,resources:report.resources,displays:guest.displays,guest:guest.samples.map((s:any)=>({at:s.at,memory:s.memory,oomKillsSinceBoot:s.oomKillsSinceBoot,cpuBusyPercent:s.cpuBusyPercent})),after:report.after},null,2));
