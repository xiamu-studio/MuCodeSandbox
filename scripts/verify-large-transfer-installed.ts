import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';import path from 'node:path';
import {LimaRuntime} from '../server/runtime.ts';import {VERSION} from '../shared/version.ts';import type {Environment} from '../shared/types.ts';
const root=path.resolve(import.meta.dirname,'..'),info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8')),id='76c193f7-09a2-4544-83b8-4852445ab2be';
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
assert.equal(config.version,VERSION);assert.equal(VERSION,'0.4.62');
const headers={Cookie:cookie,Authorization:'Bearer '+config.token},runtime=new LimaRuntime('/Users/staff/.mucodesandbox'),base='/environments/'+id;
async function api(route:string,body?:object){const res=await fetch(info.url+'/api'+route,{method:body?'POST':'GET',headers:{...headers,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();assert.ok(res.ok,value.error);return value;}
const snapshot=await api('/snapshot'),e:Environment=snapshot.environments.find((v:Environment)=>v.id===id);assert.equal(e.state,'running');
const marker=randomUUID(),savedFiles:{name:string;path:string;hash:string}[]=[];
const report:any={passed:false,version:VERSION,scope:'Installed authenticated HTTP API and guarded Linux VM. Only unique generated binary files; no real documents, host clipboard, accounts or AI sites.',checkedAt:new Date().toISOString(),files:[]};
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
try{
 const guard=await api(base+'/network/protection');assert.ok(guard.active&&guard.integrity==='verified'&&guard.leaseActive);
 for(const mib of [39,150]){
  const bytes=Buffer.alloc(mib*1024*1024,0x39+mib%100),name=`mu-transfer-fixture-${marker}-${mib}.bin`,expected=hash(bytes),started=performance.now();
  const response=await fetch(info.url+'/api'+base+'/transfer-files?name='+encodeURIComponent(name),{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:new Uint8Array(bytes)}),saved=await response.json();assert.ok(response.ok,saved.error);assert.equal(saved.zone,'downloads');assert.equal(saved.bytes,bytes.length);assert.equal(saved.path,'/home/dev/Downloads/'+name);savedFiles.push({name,path:saved.path,hash:expected});
  const guestHash=(await runtime.guest(e,['sha256sum','--',saved.path],{timeoutMs:15000,maxBytes:1000,onOutput:undefined})).split(/\s+/)[0];assert.equal(guestHash,expected);
  const uploadMs=Math.round(performance.now()-started),readStart=performance.now(),download=await fetch(info.url+'/api'+base+'/transfer-download',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({zone:'downloads',name})});assert.ok(download.ok);assert.equal(hash(new Uint8Array(await download.arrayBuffer())),expected);
  report.files.push({mib,bytes:bytes.length,uploadMs,downloadMs:Math.round(performance.now()-readStart),sameBytes:true});
 }
 // Create a separate small legacy Incoming fixture, then use the new bounded move API.
 const moveName=`mu-transfer-fixture-${marker}-move.bin`,movePath='/home/dev/Transfers/Incoming/'+moveName;await runtime.guest(e,['python3','-c','import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);f=p.open("xb");f.write(b"synthetic move fixture");f.close()',movePath],{timeoutMs:10000,onOutput:undefined});savedFiles.push({name:moveName,path:movePath,hash:hash(Buffer.from('synthetic move fixture'))});
 const listing=await api(base+'/transfer-files?directory=1&paged=1&zone=incoming&path='),row=listing.files.find((v:any)=>v.name===moveName);assert.ok(row);const moved=await api(base+'/transfer-move',{zone:'incoming',name:moveName,revision:row.revision});assert.equal(moved.zone,'downloads');assert.equal(moved.path,'/home/dev/Downloads/'+moveName);savedFiles.at(-1)!.path=moved.path;assert.equal((await runtime.guest(e,['sha256sum','--',moved.path],{timeoutMs:10000,maxBytes:1000,onOutput:undefined})).split(/\s+/)[0],savedFiles.at(-1)!.hash);report.moveSucceeded=true;
 const projects=await api(base+'/transfer-projects');assert.deepEqual(projects,e.mounts.map(m=>({id:m.id,guestPath:m.guestPath,writable:m.writable})));report.originalProjectPermissionsPreserved=true;
 const opened=await api(base+'/transfer-folder/open',projects.length?{projectId:projects[0].id}:{zone:'downloads'});assert.equal(opened.ok,true);report.fileManagerStarted=true;
 const after=await api(base+'/network/protection');assert.ok(after.active&&after.integrity==='verified'&&after.leaseActive);report.guardAfter={active:true,integrity:'verified',leaseActive:true};report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 report.removedFixtures=[];
 for(const file of savedFiles){if(file.name.startsWith('mu-transfer-fixture-'+marker)&&['/home/dev/Downloads/'+file.name,'/home/dev/Transfers/Incoming/'+file.name].includes(file.path)){
  try{const actual=(await runtime.guest(e,['sha256sum','--',file.path],{timeoutMs:15000,maxBytes:1000,onOutput:undefined})).split(/\s+/)[0];if(actual===file.hash){await runtime.guest(e,['rm','--',file.path],{timeoutMs:10000,onOutput:undefined});report.removedFixtures.push(file.name);}}catch{report.cleanupPending=true;}
 }}
 await mkdir(path.join(root,'test-results/large-transfers'),{recursive:true});await writeFile(path.join(root,'test-results/large-transfers/installed-files.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
