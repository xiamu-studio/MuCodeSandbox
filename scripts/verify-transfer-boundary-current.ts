import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {VERSION} from '../shared/version.ts';
import {LimaRuntime} from '../server/runtime.ts';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Cookie:cookie,Authorization:'Bearer '+config.token};
const id='76c193f7-09a2-4544-83b8-4852445ab2be';
async function get(route:string){const r=await fetch(info.url+'/api'+route,{headers});assert.ok(r.ok);return r.json();}
async function authorized(){const s=await get('/snapshot');const e=s.environments.find((v:any)=>v.id===id);assert.equal(e?.state,'running');const g=await get('/environments/'+id+'/network/protection');assert.ok(g.active&&g.integrity==='verified'&&g.leaseActive);return e;}
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
assert.equal(config.version,VERSION,'Run only after installing the current version');
const exchange={
 async upload(_id:string,name:string,data:Buffer){const r=await fetch(info.url+'/api/environments/'+id+'/transfer-files?name='+encodeURIComponent(name),{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:new Uint8Array(data)});const v=await r.json();assert.ok(r.ok,v.error);return v;},
 async list(_id:string){return get('/environments/'+id+'/transfer-files');},
 async download(_id:string,zone:string,name:string){const r=await fetch(info.url+'/api/environments/'+id+'/transfer-download',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({zone,name})});assert.ok(r.ok,await (r.ok?Promise.resolve(''):r.text()));return Buffer.from(await r.arrayBuffer());}
};
const name='mu-boundary-'+randomUUID()+'.bin',data=Buffer.alloc(25*1024*1024,0xa7);
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const report:any={checkedAt:new Date().toISOString(),version:config.version,scope:'Installed application API and actual guarded VM. Synthetic 25 MiB bytes only; no website or account access.',passed:false};
let saved:any;
try {
 await authorized();let start=performance.now();saved=await exchange.upload(id,name,data);report.uploadMs=Math.round(performance.now()-start);
 assert.equal(saved.bytes,data.length);assert.ok((await exchange.list(id)).some((f:any)=>f.name===name&&f.bytes===data.length));
 start=performance.now();const result=await exchange.download(id,'incoming',name);report.downloadMs=Math.round(performance.now()-start);
 assert.equal(hash(result),hash(data));report.bytes=data.length;report.sha256=hash(data);report.guardAfter=!!(await authorized());report.passed=true;
} catch(e){report.error=String(e);process.exitCode=1;}
finally {
 if(saved?.path==='/home/dev/Transfers/Incoming/'+name){try{await runtime.guest(await authorized(),['rm','--',saved.path],{timeoutMs:6000});report.fixtureRemoved=true;}catch{report.fixtureRemoved=false;}}
 const directory='/Users/staff/Documents/AIbox/AI/AIbeng/MuCodeSandbox/test-results/native-file-drag';await mkdir(directory,{recursive:true});await writeFile(directory+'/boundary-installed.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
