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
const prefix='mu-page-'+randomUUID()+'-';
const names=Array.from({length:53},(_,i)=>prefix+String(i).padStart(3,'0')+'.txt');
const report:any={checkedAt:new Date().toISOString(),version:config.version,passed:false,scope:'Installed application API and actual protected VM; synthetic file metadata, no websites.'};
const fixture=String.raw`import json,sys,os
r=json.load(sys.stdin)
fd=os.open('/home/dev/Transfers/Incoming',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for name in r['names']:
  if r['action']=='create':
   leaf=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)
   with os.fdopen(leaf,'wb') as f:f.write(b'MU_PAGE_FIXTURE')
  else:
   try:os.unlink(name,dir_fd=fd)
   except FileNotFoundError:pass
finally:os.close(fd)
`;
try {
 await runtime.guest(await authorized(),['python3','-c',fixture],{input:JSON.stringify({names,action:'create'}),timeoutMs:10000});
 const seen=new Set<string>();let cursor:string|null=null;let pages=0;const start=performance.now();
 do{
  const result=await get('/environments/'+id+'/transfer-files?paged=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  assert.ok(result.files.length<=50);assert.ok(result.total>=names.length);
  for(const f of result.files){const key=f.zone+'/'+f.name;assert.ok(!seen.has(key));seen.add(key);}
  cursor=result.nextCursor;pages++;assert.ok(pages<100);
 }while(cursor);
 for(const name of names)assert.ok(seen.has('incoming/'+name));
 report.pages=pages;report.fixtureCount=names.length;report.elapsedMs=Math.round(performance.now()-start);
 const bad=await fetch(info.url+'/api/environments/'+id+'/transfer-files?paged=1&cursor=invalid',{headers});assert.equal(bad.status,400);
 report.invalidCursorRejected=true;report.guardAfter=!!(await authorized());report.passed=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 try{await runtime.guest(await authorized(),['python3','-c',fixture],{input:JSON.stringify({names,action:'remove'}),timeoutMs:10000});report.fixtureRemoved=true;}catch{report.fixtureRemoved=false;}
 await mkdir('test-results/file-pagination',{recursive:true});await writeFile('test-results/file-pagination/installed.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
