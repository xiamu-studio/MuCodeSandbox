import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';
import type {Environment} from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be',results=path.join(root,'test-results/headline-latency');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:object){const response=await fetch(info.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+config.token,Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw new Error(value.error??JSON.stringify(value));return value;}
const snapshot=await api('/api/snapshot'),e=snapshot.environments.find((e:Environment)=>e.id===id) as Environment;assert.ok(e?.state==='running'&&e.network.strict&&e.network.transparent);
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const report:any={passed:false,checkedAt:new Date().toISOString(),version:snapshot.system.version,build:snapshot.system.application,environmentId:id,accountLogin:false,paidModelCalls:0,scope:'Current guard and two HTTPS receipts from the same ordinary guest user as managed clients; not remote proof of each client connection or service-side cloud task egress'};
try{
 const before=await api(`/api/environments/${id}/network/protection`);assert.ok(before.active&&before.integrity==='verified'&&before.leaseActive);
 const identity=JSON.parse(await runtime.management(e,['sudo','python3','-c',`import json,subprocess,pathlib
uid=int(subprocess.check_output(['id','-u','dev']))
result={'developmentUid':uid,'clients':[]}
for name in ['grok-bot','claude-desktop']:
 unit='mucodesandbox-desktop-'+name+'.service'
 values=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',unit,'-p','User','-p','MainPID','-p','ActiveState']).decode().splitlines() if '=' in line)
 pid=int(values.get('MainPID','0'));actual_uid=None
 if pid>0:
  status=dict(line.split(':',1) for line in (pathlib.Path('/proc')/str(pid)/'status').read_text().splitlines() if ':' in line)
  actual_uid=int(status['Uid'].split()[1])
 result['clients'].append({'id':name,'configuredUser':values.get('User'),'active':values.get('ActiveState')=='active','pid':pid,'actualUid':actual_uid})
print(json.dumps(result))`],{timeoutMs:10000,maxBytes:8192}));
 for(const client of identity.clients){assert.equal(client.configuredUser,'dev');if(client.active)assert.equal(client.actualUid,identity.developmentUid);}
 const receipts=[];
 for(const [provider,url] of [['ipify','https://api.ipify.org'],['icanhazip','https://ipv4.icanhazip.com']]){
  // No explicit application proxy or inherited proxy variables. The VM's
  // transparent route and firewall must carry this ordinary dev TCP connection.
  const ip=(await runtime.management(e,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','/usr/bin/curl','-q','--ipv4','--fail','--silent','--show-error','--proto','=https','--cacert','/etc/ssl/certs/ca-certificates.crt','--proxy','','--noproxy','*','--connect-timeout','8','--max-time','12',url],{timeoutMs:16000,maxBytes:2048})).trim();
  assert.equal(ip,'166.88.36.199');receipts.push({provider,ip,checkedAt:new Date().toISOString()});
 }
 const approved=await api(`/api/environments/${id}/network/test`,{});assert.equal(approved.ip,'166.88.36.199');
 const after=await api(`/api/environments/${id}/network/protection`);assert.ok(after.active&&after.integrity==='verified'&&after.leaseActive);assert.equal(after.firewallHash,before.firewallHash);assert.equal(after.tunnelConfigHash,before.tunnelConfigHash);
 Object.assign(report,{identity,receipts,approved:{ip:approved.ip,country:approved.country,source:approved.source},protection:{active:after.active,integrity:after.integrity,leaseActive:after.leaseActive,firewallUnchanged:true,tunnelUnchanged:true},passed:true});
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{await mkdir(results,{recursive:true});await writeFile(path.join(results,'egress-current.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
