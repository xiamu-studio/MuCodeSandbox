import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {run} from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),id='76c193f7-09a2-4544-83b8-4852445ab2be';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Cookie:cookie,Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
async function request(route:string,body?:object){const r=await fetch(info.url+'/api/environments/'+id+route,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const value=await r.json();assert.ok(r.ok,value.error);return value;}
const marker=randomUUID(),name='mu-exchange-fixture-'+marker+'.txt',text='MU_ACCOUNT_FREE_TEXT '+marker+' 中文',bytes=Buffer.from(text+'\n\0binary-marker');
const report:any={passed:false,scope:'Installed native application service and actual VM: manual guest text and selected-file byte roundtrip; no user files, accounts or host clipboard read',checkedAt:new Date().toISOString()};
let uploadedPath='';
try{
 const upload=await fetch(info.url+'/api/environments/'+id+'/transfer-files?name='+encodeURIComponent(name),{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes});const saved=await upload.json();assert.ok(upload.ok,saved.error);uploadedPath=saved.path;assert.equal(saved.bytes,bytes.length);
 const files=await request('/transfer-files');assert.ok(files.some((f:any)=>f.name===name&&f.bytes===bytes.length));
 const downloaded=await fetch(info.url+'/api/environments/'+id+'/transfer-download',{method:'POST',headers,body:JSON.stringify({zone:'incoming',name})});assert.ok(downloaded.ok);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);report.file={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sameBytes:true};
 await request('/clipboard/write',{text});const received=await request('/clipboard/read',{});assert.equal(received.text,text);report.clipboard={unicodeReturned:true,hostClipboardRead:false,automaticSync:false};
 const snap=await(await fetch(info.url+'/api/snapshot',{headers})).json();const env=snap.environments.find((e:any)=>e.id===id);assert.ok(env);
 const details=JSON.parse(await run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',env.instanceName,'sudo','python3','-c',`import pathlib,subprocess,json
fonts=subprocess.check_output(['fc-list',':','family'],text=True)
units={}
for app in ['grok-bot','claude-desktop']:
 unit='mucodesandbox-desktop-'+app+'.service';pid=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip()
 args=(pathlib.Path('/proc')/pid/'cmdline').read_bytes().replace(bytes([0]),b' ').decode()
 units[app]={'running':int(pid)>1,'basicPasswordStore':'--password-store=basic' in args}
print(json.dumps({'clients':units,'wenQuanYiPresent':'WenQuanYi' in fonts,'chineseFallback':subprocess.check_output(['fc-match',':lang=zh-cn','-f','%{family}'],text=True)}))`],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},timeoutMs:8000,maxBytes:8192}));
 assert.equal(details.wenQuanYiPresent,false);for(const client of Object.values(details.clients) as any[])assert.ok(client.running&&client.basicPasswordStore);report.details=details;
 const guard=await request('/network/protection');assert.ok(guard.active&&guard.integrity==='verified'&&guard.leaseActive);report.guard={active:true,verified:true};report.passed=true;
}catch(error){report.error=(error as Error).stack;process.exitCode=1;}
finally{
 // Delete only the unique disposable fixture created by this script. No user
 // file or whole transfer folder is removed.
 if(uploadedPath==='/home/dev/Transfers/Incoming/'+name)await run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell','mu-76c193f709a24544','sudo','-H','-u','dev','--','rm','-f',uploadedPath],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},timeoutMs:6000}).catch(()=>{});
 const dir=path.join(root,'test-results/guest-workspace-handoff');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'exchange-actual.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
