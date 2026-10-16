import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';
import {EGRESS_RECEIVERS,measureEgress,egressErrorChecks,checkFailure,parseEgressProbeOutput} from '../server/egress.ts';
import {AppError} from '../server/errors.ts';

const root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'});
const cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
const api=async(suffix:string)=>{const response=await fetch(`${info.url}/api/${suffix}`,{headers});if(!response.ok)throw new Error(`Inspection failed: ${response.status}`);return response.json() as Promise<any>;};
const snapshot=await api('snapshot');
const environment=snapshot.environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');
if(environment?.state!=='running'||environment.network.egressLock?.expectedIp!=='166.88.36.199')throw new Error('Existing approved environment unavailable');
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const management=runtime.management.bind(runtime);
const before=await api(`environments/${environment.id}/network/protection`);
if(!before.active||before.integrity!=='verified'||!before.leaseActive)throw new Error('Existing guard is not verified');
const port=Number((await management(environment,['sudo','python3','-c',`import json,pathlib
config=json.loads(pathlib.Path('/etc/mucodesandbox/tunnel.json').read_text())
probes=[v for v in config['inbounds'] if v.get('tag')=='exit-probe']
if len(probes)!=1 or probes[0].get('type')!='socks' or probes[0].get('listen')!='127.0.0.1':raise RuntimeError('Existing probe listener mismatch')
print(probes[0]['listen_port'])`],{timeoutMs:8000,maxBytes:256})).trim());
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid existing probe listener');
// This diagnostic process has no ownership of the application's live transport.
// Inspect its existing listener; never create another route or mutate its guard.
runtime.egressProbeProxy=()=>`socks5h://127.0.0.1:${port}`;
let current:any[]=[];
const pending=new Set<Promise<string>>();
runtime.management=(e,args,options={})=>{
 const receiver=EGRESS_RECEIVERS.find(value=>value.url===args.at(-1));
 if(!receiver)return management(e,args,options);
 const started=performance.now(),at=new Date().toISOString(),rows=current;
 const work=(async()=>{
  let output='',failure:unknown;
  try{output=await management(e,args,{...options,onOutput:undefined});}catch(error){failure=error;output=error instanceof Error?error.message:'';}
  let timing:any=null;
  try{
   timing=parseEgressProbeOutput(output).diagnostics??null;
  }catch{}
  rows.push({receiver:receiver.receiver,at,commandMs:Math.round(performance.now()-started),status:failure?checkFailure(failure):'success',timing,
   interpretation:!timing?'No completed curl timing':timing.tlsHandshakeMs>0?'TLS handshake completed':timing.tcpConnectMs>0?'TCP to proxy completed; destination/SOCKS/TLS progress not separable':'TCP and TLS not confirmed'});
  if(failure)throw failure;
  return output;
 })();
 pending.add(work);void work.finally(()=>pending.delete(work)).catch(()=>{});
 return work;
};
const report:any={at:new Date().toISOString(),version:snapshot.system.version,build:snapshot.system.application,environmentId:environment.id,
 scope:'Six bounded current guest quorum measurements via the inspected existing listener with curl stage timings. Guard/approved exit, timeout, TLS verification, routing and profiles unchanged; no business traffic contents.',beforeProtection:{integrity:before.integrity,firewallHash:before.firewallHash,tunnelConfigHash:before.tunnelConfigHash},previousEvents:await api(`environments/${environment.id}/protection-events`),rounds:[]};
const directory=path.join(root,'test-results/egress-diagnosis');await mkdir(directory,{recursive:true});
const output=path.join(directory,`${report.at.replaceAll(':','-')}.json`);
try{
 for(let round=0;round<6;round++){
  const now=await api('snapshot');if(now.environments.find((e:any)=>e.id===environment.id)?.state!=='running'){report.stopped=true;break;}
  current=[];const row:any={round:round+1,at:new Date().toISOString()};
  try{const result=await measureEgress(runtime,environment);row.result=result;row.success=true;}catch(error){row.success=false;row.checks=egressErrorChecks(error);row.code=error instanceof AppError?error.code:'ERROR';row.message=error instanceof Error?error.message:'Measurement failed';}
  await Promise.allSettled([...pending]);row.probes=current;report.rounds.push(row);
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({round:row.round,success:row.success,probes:current}));
  if(round<5)await new Promise(resolve=>setTimeout(resolve,15000));
 }
 report.currentEgress=await api(`environments/${environment.id}/network/egress`);
 report.eventsAfter=await api(`environments/${environment.id}/protection-events`);
 const after=await api(`environments/${environment.id}/network/protection`);
 report.afterProtection={active:after.active,integrity:after.integrity,leaseActive:after.leaseActive,firewallUnchanged:before.firewallHash===after.firewallHash,tunnelUnchanged:before.tunnelConfigHash===after.tunnelConfigHash};
}finally{report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({file:output,rounds:report.rounds.length,successes:report.rounds.filter((r:any)=>r.success).length,finishedAt:report.finishedAt}));}
