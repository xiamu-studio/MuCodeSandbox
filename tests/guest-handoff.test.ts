import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,symlink,mkdir,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {GuestLinks,parseGuestLink,LINK_HELPER_PYTHON,READ_LINKS_PYTHON,installGuestLinksScript} from '../server/guest-links.ts';
import {GuestDesktop} from '../server/guest-desktop.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {Manager} from '../server/manager.ts';
import {createService} from '../server/service.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
function env():Environment{return {...environmentSchema.parse({name:'Handoff fixture',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true}}),id:randomUUID(),instanceName:'mu-handoff-fixture',state:'running',lastError:null,browserRunning:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}

test('Guest links accept web URLs and actual installed client schemes, never credentials, file, scripts or extra controls',()=>{
 for(const url of ['https://accounts.example.test/auth?state=fake&code_challenge=demo','http://127.0.0.1:31552/callback?code=FAKE'])assert.equal(parseGuestLink(url).application,null);
 assert.equal(parseGuestLink('grokbot://auth?code=FAKE').application,'grok-bot');assert.equal(parseGuestLink('sand://auth?code=FAKE').application,'grok-bot');assert.equal(parseGuestLink('claude://claude.ai/new?surface=chat').application,'claude-desktop');
 for(const input of ['file:///etc/passwd','javascript:alert(1)','data:text/html,hello','ssh://root@server','https://name:secret@example.test/','https://example.test/\ncommand','--profile-directory=other','https://'+ 'a'.repeat(8192), 'unknown://app'])assert.throws(()=>parseGuestLink(input),{code:'INVALID_GUEST_LINK'});
});

test('Actual guest helper and queue reader keep requests private, expire old files and refuse symbolic links',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-link-queue-')),target=path.join(root,'outside-marker');
 const queue=path.join(root,'queue');await import('node:fs/promises').then(f=>f.mkdir(queue,{mode:0o700}));
 const helper=LINK_HELPER_PYTHON.replaceAll('/run/mucodesandbox-links',queue);
 const reader=READ_LINKS_PYTHON.replaceAll('/run/mucodesandbox-links',queue).replace("pwd.getpwnam('dev').pw_uid",'os.getuid()');
 try{
  execFileSync('python3',['-c',helper,'https://provider.test/auth?state=FAKE_SECRET']);
  const files=await readdir(queue);assert.equal(files.length,1);
  const value=JSON.parse(await readFile(path.join(queue,files[0]),'utf8'));
  assert.match(value.id,/^[a-f0-9]{32}$/);assert.equal(value.url,'https://provider.test/auth?state=FAKE_SECRET');
  await writeFile(target,'KEEP');await symlink(target,path.join(queue,'a'.repeat(32)+'.json'));
  await writeFile(path.join(queue,'b'.repeat(32)+'.json'),JSON.stringify({id:'b'.repeat(32),url:'https://expired.test',created:-300}));
  const rows=JSON.parse(execFileSync('python3',['-c',reader]).toString());assert.equal(rows.length,1);assert.equal(rows[0].id,value.id);
  assert.equal(await readFile(target,'utf8'),'KEEP');assert.equal((await readdir(queue)).length,1);
  assert.throws(()=>execFileSync('python3',['-c',helper,'file:///etc/passwd'],{stdio:'pipe'}));
  assert.throws(()=>execFileSync('python3',['-c',reader.replace('uid=os.getuid()','uid=os.getuid()+1')],{stdio:'pipe'}));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Client-created duplicate MIME entries are normalized without deleting other defaults',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mu-link-defaults-')));const config=path.join(root,'.config');await mkdir(config);
 const file=path.join(config,'mimeapps.list');await writeFile(file,'[Default Applications]\nx-scheme-handler/grokbot = old.desktop;\nx-scheme-handler/grokbot=client.desktop;\ntext/plain=keep.desktop;\n');
 const python=installGuestLinksScript().split("<<'MU_LINK_DEFAULTS'\n")[1].split('\nMU_LINK_DEFAULTS')[0].replaceAll('/home/dev',root);
 try{execFileSync('python3',['-c',python]);execFileSync('python3',['-c',python]);const text=await readFile(file,'utf8');assert.equal(text.match(/x-scheme-handler\/grokbot/g)?.length,1);assert.ok(text.includes('x-scheme-handler/grokbot=mucodesandbox-links.desktop;'));assert.ok(text.includes('text/plain=keep.desktop;'));}
 finally{await rm(root,{recursive:true,force:true});}
});

test('Starting a second client preserves the first; only a starting client is exempt from transient renderer readiness',async()=>{
 const runtime=new LimaRuntime('/unused'),desktop=new GuestDesktop(runtime),e=env(),calls:string[]=[];
 let broken=false;
 runtime.management=async(_e,args,options)=>{
  if(args[0]==='python3')return JSON.stringify({supported:true,displaySharedWithBrowser:true,accountTested:false,apps:[{id:'grok-bot',installed:true,installedVersion:'0.68.1',running:true,pid:42,profile:'/home/dev/.local/share/mucodesandbox/desktop-clients/grok-bot',rendererProtected:!broken,issue:''},{id:'claude-desktop',installed:false,installedVersion:null,running:false,pid:0,profile:'/home/dev/.local/share/mucodesandbox/desktop-clients/claude-desktop',rendererProtected:null,issue:''}]});
  calls.push(options?.input??args.join(' '));return '';
 };
 await desktop.start(e,'grok-bot');assert.equal(calls.length,0,'An already-running client must not restart');
 await desktop.start(e,'claude-desktop');assert.equal(calls.length,1);assert.ok(!calls[0].includes('systemctl stop'));
 desktop.tracked.add(e.id);await desktop.assertProtected(e);broken=true;await assert.rejects(desktop.assertProtected(e),{code:'DESKTOP_SANDBOX_FAILED'});
 desktop.finishStart(e.id,'claude-desktop');assert.ok(!desktop.starting.has(e.id));
});

test('Web handoff uses the managed browser and never records authorization parameters, including on failure',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-handoff-manager-')),runtime=new LimaRuntime(root),urls:string[]=[];
 const secret='FAKE_LOGIN_PARAMETER';let fail=false;
 const manager=new Manager(root,{...browser,openLink:async(_e,url,options)=>{assert.equal(options?.onOutput,undefined);urls.push(url);if(fail)throw new Error(url);}},runtime);clearInterval(manager.protectionTimer);
 manager.assertAccess=async()=>undefined;
 try{
  const e=env();manager.store.save(e);const url='https://provider.test/auth?state='+secret;
  const good=await manager.openExternalLink(e.id,url);await manager.tasks.get(good.id)?.promise;assert.equal(manager.store.jobs().find(j=>j.id===good.id)?.status,'succeeded');
  fail=true;const bad=await manager.openExternalLink(e.id,url);await manager.tasks.get(bad.id)?.promise;const result=manager.store.jobs().find(j=>j.id===bad.id)!;assert.equal(result.status,'failed');assert.ok(!result.message?.includes(secret));assert.ok(!JSON.stringify(manager.store.logs(e.id)).includes(secret));assert.equal(urls.length,2);
  await assert.rejects(manager.openExternalLink(e.id,'file:///etc/passwd'),{code:'INVALID_GUEST_LINK'});assert.equal(urls.length,2);
 }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

test('An authenticated viewer can attach while a startup job is busy, but revoked protection still rejects it',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-busy-viewer-')),service=await createService({rootDir:path.resolve(import.meta.dirname,'..'),dataDir:root,port:0,browser});clearInterval(service.manager.protectionTimer);
 const e=env();service.manager.store.save(e);const job=service.manager.store.newJob(e.id,'open-browser');service.manager.active.set(e.id,job.id);
 const calls:boolean[]=[];let deny=false;
 service.manager.assertAccess=async(_id,allowBusy)=>{calls.push(!!allowBusy);if(deny)throw new Error('fixture permission revoked');return undefined;};
 service.guestBrowser.issue=()=>({ticket:'fixture-ticket',password:'abcdefgh'});
 const url=service.url+'/api/environments/'+e.id+'/guest-browser-ticket',headers={Authorization:'Bearer '+service.token,'Content-Type':'application/json'};
 try{
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,200);assert.deepEqual(calls,[true]);
  deny=true;assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,500);assert.deepEqual(calls,[true,true]);
 }finally{service.manager.active.clear();await service.close();await rm(root,{recursive:true,force:true});}
});

test('Busy queues retain the same pending request and stopped environments never dispatch it',async()=>{
 const e=env(),calls:string[]=[];let busy=true,active=true;
 const runtime=new LimaRuntime('/unused');runtime.management=async(_e,args)=>{calls.push(args.join(' '));return JSON.stringify([{id:'a'.repeat(32),url:'https://provider.test/'}]);};
 const links=new GuestLinks(runtime,()=>active?e:undefined,()=>busy,async()=>{calls.push('handled');});links.tracked.add(e.id);clearInterval(links.timer);
 try{await links.poll();assert.equal(calls.length,0);busy=false;await links.poll();assert.ok(calls.includes('handled'));assert.ok(calls.some(v=>v.includes('/run/mucodesandbox-links/')));calls.length=0;active=false;await links.poll();assert.equal(calls.length,0);}finally{await links.close();}
});
