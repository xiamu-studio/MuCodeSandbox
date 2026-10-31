// Observes a failed installed API export on its original stopped VM.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.env.COMPUTERNAME,'MU-CLEAN-LAB');
const caseId=process.argv[2];assert.match(caseId,/^[a-f0-9]{32}$/);
const root='C:/MuLab/public/backup-preview14-'+caseId,meta=JSON.parse(await readFile(root+'/case.json','utf8')),app=meta.installed.replaceAll('\\','/')+'/resources/app';
assert.equal(meta.caseId,caseId);assert.equal(meta.version,'0.4.66-preview.16');
assert.equal(process.execPath.toLowerCase().replaceAll('\\','/'),(meta.installed.replaceAll('\\','/')+'/resources/node/node.exe').toLowerCase());
const load=name=>import(pathToFileURL(app+'/dist-server/server/platform/windows/'+name+'.js').href);
const {HyperVBrokerClient,brokerSourceDigest}=await load('broker'),{HyperVRuntime}=await load('runtime'),{createWindowsService}=await load('service');
const nonce=randomBytes(32).toString('hex'),client=new HyperVBrokerClient(nonce),calls=[];
let service,observed,complete=false,error,status,id;
const describe=e=>({name:e.name,code:e.code??null,message:String(e.message).slice(0,2000),issues:e.issues?.map(i=>({code:i.code,path:i.path,message:i.message}))});
await writeFile(root+'/diagnostic-owner.json',JSON.stringify({caseId,pid:process.pid,nonce}));
try{
 const until=performance.now()+120000;for(;;){try{assert.equal((await client.hello()).sourceDigest,await brokerSourceDigest());break;}catch(e){if(e.code!=='BROKER_UNAVAILABLE'||performance.now()>until)throw e;await delay(250);}}
 const broker={call:async(action,args,options)=>{calls.push({action});try{return await client.call(action,args,options);}catch(e){calls.at(-1).error=describe(e);throw e;}}};
 const runtime=new HyperVRuntime(root+'/source-runtime',undefined,broker);service=await createWindowsService({rootDir:app,runtimeRoot:root+'/source-runtime',dataDir:root+'/source-app',runtime});
 const environments=service.manager.store.list();assert.equal(environments.length,1);id=environments[0].id;assert.equal(environments[0].state,'stopped');
 const original=service.manager.runMaintenance.bind(service.manager);service.manager.runMaintenance=(action,work)=>original(action,async signal=>{try{return await work(signal);}catch(e){observed=describe(e);throw e;}});
 const response=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=response.headers.get('set-cookie').split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),token=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)[1]).token;
 const exported=await fetch(service.url+'/api/windows/backups/export',{method:'POST',headers:{Cookie:cookie,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id,path:root+'/diagnostic-export.mucwin',password:'synthetic-export-diagnostic-'+caseId,passwordConfirmation:'synthetic-export-diagnostic-'+caseId,confirmation:environments[0].name})});assert.equal(exported.status,202);const job=await exported.json();await service.manager.wait(job.id);status=await(await fetch(service.url+'/api/windows/backups',{headers:{Cookie:cookie,Authorization:'Bearer '+token}})).json();
 // The service's public state remains redacted; this private fixture observes only the thrown error.
 complete=true;
}catch(e){error=describe(e);}
finally{await service?.close().catch(e=>{complete=false;error??=describe(e);});await client.call('shutdown').catch(()=>{});await writeFile(root+'/diagnostic-result.json',JSON.stringify({caseId,pid:process.pid,nonce,complete,id,observed,error,calls,status},null,2));}
if(!complete)process.exitCode=1;
