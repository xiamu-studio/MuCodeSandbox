import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {environmentSchema} from '../server/validation.ts';
import {GuestDesktop,desktopLaunchScript,desktopAppSchema,DESKTOP_RECIPES,DESKTOP_ARGUMENTS_PYTHON} from '../server/guest-desktop.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {Manager} from '../server/manager.ts';
import {createService} from '../server/service.ts';
import type {Environment} from '../shared/types.ts';

const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
function env():Environment{return {...environmentSchema.parse({name:'Desktop fixture',network:{mode:'socks5',host:'127.0.0.1',port:24898,strict:true,transparent:true},identity:{locale:'en-US',timezone:'America/Los_Angeles'}}),id:randomUUID(),instanceName:'mu-desktop-fixture',state:'running',browserRunning:false,lastError:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
function desktopReceipt(running=false,protectedRenderer=false){return {supported:true,apps:(['grok-bot','claude-desktop'] as const).map(id=>({id,installed:running&&id==='grok-bot',installedVersion:running&&id==='grok-bot'?'0.68.1':null,running:running&&id==='grok-bot',pid:running&&id==='grok-bot'?42:0,profile:'/home/dev/.local/share/mucodesandbox/desktop-clients/'+id,rendererProtected:running&&id==='grok-bot'?protectedRenderer:null,issue:''})),displaySharedWithBrowser:true,accountTested:false};}
async function wait(manager:Manager,id:string){const task=manager.tasks.get(id);if(task)await task.promise;return manager.store.jobs().find(j=>j.id===id)!;}

test('Desktop launch is fixed to ordinary guest identity, real locale and private data, not arbitrary commands or URLs',()=>{
  for(const app of ['grok-bot','claude-desktop'] as const){const script=desktopLaunchScript(env(),app);assert.match(script,/User=dev/);assert.match(script,/Group=dev/);assert.match(script,/BindsTo=mucodesandbox-display.service/);assert.match(script,/KillMode=control-group/);assert.match(script,/dbus-run-session/);assert.ok(script.includes('--password-store=basic'));assert.match(script,/XDG_CACHE_HOME/);assert.match(script,/TZ=.*America\/Los_Angeles/);assert.ok(!script.includes('--no-sandbox'));assert.ok(!script.includes('ignore-certificate-errors'));assert.ok(!script.includes('NODE_TLS_REJECT_UNAUTHORIZED'));assert.match(script,/sudo -u dev python3/);assert.ok(!script.includes('sudo install -d -o dev'));}
  assert.throws(()=>desktopAppSchema.parse('../../bin/sh'));assert.throws(()=>desktopLaunchScript({...env(),kind:'browser'},'grok-bot'));assert.throws(()=>desktopLaunchScript({...env(),network:{...env().network,strict:false}},'grok-bot'));assert.throws(()=>desktopLaunchScript({...env(),identity:{locale:'en-US',timezone:'America/LA\nrm -rf /'}},'grok-bot'));
});

test('Actual Python process inspection handles both NUL argv and Electron rewritten process titles',()=>{
  const payloads=[Buffer.from('/opt/app\0--type=renderer\0--no-sandbox\0'),Buffer.from('/opt/Grok Bot/grok-bot --type=renderer --user-data-dir=/home/dev/profile\0\0')].map(b=>b.toString('base64'));
  const code=DESKTOP_ARGUMENTS_PYTHON+`\nimport base64,json\nrows=${JSON.stringify(payloads)}\nprint(json.dumps([[v.decode() for v in desktop_arguments(base64.b64decode(s))] for s in rows]))`;
  const values=JSON.parse(execFileSync('python3',['-c',code]).toString());
  assert.ok(values[0].includes('--type=renderer'));assert.ok(values[0].includes('--no-sandbox'));
  assert.ok(values[1].includes('--type=renderer'));assert.ok(!values[1].includes('--no-sandbox'));
});

test('Desktop installation uses pinned official metadata and verifies copied bytes before privileged metadata changes',async()=>{
  const runtime=new LimaRuntime('/tmp/mu-desktop-test-unused'),seen:string[]=[];
  runtime.management=async(_e,args,options)=>{if(args[0]==='python3')return JSON.stringify(desktopReceipt());seen.push(options?.input??args.join(' '));return '';};
  runtime.guest=async(_e,args,options)=>{seen.push(options?.input??args.join(' '));return '';};
  await new GuestDesktop(runtime).install(env(),'claude-desktop');
  const text=seen.join('\n');assert.match(text,/--proto '=https'/);assert.match(text,/--limit-rate 2M/);assert.match(text,/--no-install-recommends/);assert.match(text,/gnome-keyring gnupg/);assert.match(text,/31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE/);assert.ok(text.includes(DESKTOP_RECIPES['claude-desktop'].sha256));assert.ok(text.indexOf('p.is_symlink()')<text.indexOf('sudo chmod 0444'));assert.ok(!text.includes('sudo chown root:root "$stage/package.deb"'));assert.ok(text.includes('rm -f /home/dev/.cache/mucodesandbox-desktop/claude-desktop.deb'));
});

test('Desktop renderer protection rejects an unsafe managed client and stops monitoring a normally closed client',async()=>{
  const runtime=new LimaRuntime('/tmp/mu-desktop-test-unused'),desktop=new GuestDesktop(runtime),e=env();desktop.tracked.add(e.id);
  runtime.management=async()=>JSON.stringify(desktopReceipt(true,false));await assert.rejects(desktop.assertProtected(e),/渲染保护未通过/);
  runtime.management=async()=>JSON.stringify(desktopReceipt());await desktop.assertProtected(e);assert.ok(!desktop.tracked.has(e.id));
});

test('Clean rebuild deletes the full VM and owned restore/snapshot copies, creates a new ID and never carries shares or client data',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-clean-rebuild-')),runtime=new LimaRuntime(root),manager=new Manager(root,browser,runtime);
  runtime.info=async()=>({available:true,path:'fixture',version:'fixture',error:null});runtime.list=async()=>[];
  let removed:string|undefined;runtime.remove=async e=>{removed=e.id;};
  try {
    const old=env();old.state='stopped';manager.store.save(old);
    const other=env();other.state='stopped';manager.store.save(other);
    for(const name of ['browsers','snapshots','imports','disk-recovery','restore']){await mkdir(path.join(root,name,old.id),{recursive:true});await writeFile(path.join(root,name,old.id,'synthetic-client-token'),'MU_FAKE_SECRET');}
    await mkdir(path.join(root,'restore',other.id),{recursive:true});await writeFile(path.join(root,'restore',other.id,'keep'),'OTHER_ENVIRONMENT');
    const result=await manager.cleanRebuild(old.id);assert.equal(manager.store.list().length,2,'Replacement cannot be used before old cleanup completes');
    const job=await wait(manager,result.job.id);assert.equal(job.status,'succeeded',job.message);assert.equal(removed,old.id);assert.throws(()=>manager.store.get(old.id));
    const fresh=manager.store.get(result.replacementEnvironmentId);assert.notEqual(fresh.id,old.id);assert.notEqual(fresh.instanceName,old.instanceName);assert.equal(fresh.state,'not_created');assert.deepEqual(fresh.mounts,[]);assert.deepEqual(fresh.ports,[]);assert.deepEqual(fresh.identity,old.identity);assert.deepEqual(fresh.network,old.network);
    for(const name of ['browsers','snapshots','imports','disk-recovery','restore'])await assert.rejects(access(path.join(root,name,old.id)));
    assert.equal(await readFile(path.join(root,'restore',other.id,'keep'),'utf8'),'OTHER_ENVIRONMENT');
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

test('A failed VM removal never publishes a replacement or falsely claims cleanup',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-clean-failure-')),runtime=new LimaRuntime(root),manager=new Manager(root,browser,runtime);
  runtime.info=async()=>({available:true,path:'fixture',version:'fixture',error:null});runtime.list=async()=>[];runtime.remove=async()=>{throw new Error('Cannot delete VM');};
  try{const old=env();old.state='stopped';manager.store.save(old);const result=await manager.cleanRebuild(old.id);assert.equal((await wait(manager,result.job.id)).status,'failed');assert.equal(manager.store.list().length,1);assert.throws(()=>manager.store.get(result.replacementEnvironmentId));}
  finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

test('Desktop API keeps authentication, restricts applications and requires explicit destructive confirmation',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-api-')),service=await createService({dataDir:root,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});
  const e=env();e.state='stopped';service.manager.store.save(e);const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  try {
    const base=service.url+'/api/environments/'+e.id;
    assert.equal((await fetch(base+'/desktop-apps')).status,401);
    assert.equal((await fetch(base+'/desktop-apps/other/start',{method:'POST',headers,body:'{}'})).status,400);
    assert.equal((await fetch(base+'/desktop-apps/grok-bot/start',{method:'POST',headers,body:'{"url":"https://untrusted.test"}'})).status,400);
    assert.equal((await fetch(base+'/desktop-apps/grok-bot/start',{method:'POST',headers,body:'{}'})).status,409);
    assert.equal((await fetch(base+'/rebuild-clean',{method:'POST',headers,body:'{}'})).status,400);
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
