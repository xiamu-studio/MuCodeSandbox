import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { DescriptorBridge, HostBridge, bridgeRequestSchema } from '../server/host-bridge.ts';
import { Manager } from '../server/manager.ts';
import { run } from '../server/process.ts';
import { HOST_COMMANDS, type HostCommand } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..'),git='/Library/Developer/CommandLineTools/usr/bin/git';
const nativeRoot=path.resolve(process.env.MU_TEST_HOST_COMMAND_ROOT??root);
async function fixture(commands:HostCommand[]=[...HOST_COMMANDS]){
  const directory=await mkdtemp(path.join(homedir(),'.mu-command-test-')),project=path.join(directory,'project');await mkdir(project);
  const manager=new Manager(path.join(directory,'private')),bridge=new HostBridge(manager.store,manager.runtime,nativeRoot);
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
  const command=(args:string[])=>run(git,['-C',project,...args],{env});
  await command(['-c','init.templateDir=','init','-q']);await writeFile(path.join(project,'notes.txt'),'MU_PRIVATE_CONTENT\n');
  await command(['add','notes.txt']);await command(['-c','user.name=Mu test','-c','user.email=mu@example.invalid','commit','--no-gpg-sign','-qm','MU_COMMIT_SUBJECT']);
  const environment=await manager.create({name:'Host command synthetic'}),grant=await bridge.create(environment,project,false,1,false,{},commands);
  return {directory,project,manager,bridge,environment,grant,command,
    close:async()=>{await bridge.close();await manager.close();await rm(directory,{recursive:true,force:true});}};
}
async function until(check:()=>boolean|Promise<boolean>,timeout=5000){const end=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<end,'Host command observation timed out');await delay(25);}}
async function groupPids(group:number){return (await run('/bin/ps',['-axo','pid=,pgid=,comm='])).split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>Number(parts[1])===group).map(parts=>({pid:Number(parts[0]),command:parts.slice(2).join(' ')}));}

test('An exit-time group signal denial checks actual membership and finishes cleanup',async t=>{
  const helper=new DescriptorBridge(path.join(nativeRoot,'native/bin/mu-host-bridge'));
  await once(helper.child,'spawn');const group=helper.child.pid!,kill=process.kill;let denials=0;
  t.mock.method(process,'kill',((pid:number,signal:NodeJS.Signals|number)=>{
    if(pid===-group&&signal==='SIGKILL'){denials++;throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});}
    return kill(pid,signal);
  }) as typeof process.kill);
  try{await helper.close();assert.ok(denials>0);assert.deepEqual(await groupPids(group),[]);}
  finally{t.mock.restoreAll();try{kill(-group,'SIGKILL');}catch{}await helper.finished;}
});

test('A denied group termination with a live native helper fails within a bound',async t=>{
  const helper=new DescriptorBridge(path.join(nativeRoot,'native/bin/mu-host-bridge'));
  await once(helper.child,'spawn');const group=helper.child.pid!,kill=process.kill;
  t.mock.method(process,'kill',((pid:number,signal:NodeJS.Signals|number)=>{
    if(pid===-group)throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});
    return kill(pid,signal);
  }) as typeof process.kill);
  try{await assert.rejects(helper.close(),/无法确认宿主命令已停止/);assert.ok((await groupPids(group)).some(item=>item.pid===group));}
  finally{t.mock.restoreAll();try{kill(-group,'SIGKILL');}catch{}await helper.finished;}
});

test('Host commands require separate exact capabilities and ignore hostile Git helpers/configuration',async()=>{
  const f=await fixture(['git-status','git-diff','git-log']);
  try{
    await writeFile(path.join(f.project,'notes.txt'),'MU_CHANGED_CONTENT\n');
    const marker=path.join(f.project,'UNAPPROVED_HELPER');
    await f.command(['config','core.fsmonitor',`/bin/sh -c 'touch ${marker}'`]);
    await f.command(['config','diff.external',`/bin/sh -c 'touch ${marker}'`]);
    await f.command(['config','diff.hostile.textconv',`/bin/sh -c 'touch ${marker}'`]);
    await writeFile(path.join(f.project,'.gitattributes'),'notes.txt diff=hostile\n');
    for(const command of HOST_COMMANDS){const result=await f.bridge.perform(f.grant.id,{operation:'command',command}) as {exitCode:number;output:string};assert.equal(result.exitCode,0,result.output);assert.match(result.output,command==='git-log'?/MU_COMMIT_SUBJECT/:/notes.txt/);}
    await assert.rejects(readFile(marker));
    for(const input of [{operation:'command',command:'shell'},{operation:'command',command:'git-status',args:['--help']},{operation:'command',command:'git-status',path:'/'}])assert.throws(()=>bridgeRequestSchema.parse(input));
    const noCommands=await f.bridge.create(f.environment,f.project,true,1,false);
    await assert.rejects(f.bridge.perform(noCommands.id,{operation:'command',command:'git-status'}),/未授权/);
    const statusOnly=await f.bridge.create(f.environment,f.project,false,1,false,{},['git-status']);
    await assert.rejects(f.bridge.perform(statusOnly.id,{operation:'command',command:'git-diff'}),/未授权/);
  }finally{await f.close();}
});

test('Command directory descriptors stay pinned, repeated inspections reject outside hard links, and output is bounded',async()=>{
  const f=await fixture();
  try{
    const moved=f.project+'-original';await rename(f.project,moved);await mkdir(f.project);await writeFile(path.join(f.project,'replacement.txt'),'NOT_APPROVED');
    const first=await f.bridge.perform(f.grant.id,{operation:'command',command:'git-log'}) as {exitCode:number;output:string};assert.equal(first.exitCode,0,first.output);assert.match(first.output,/MU_COMMIT_SUBJECT/);
    const secret=path.join(f.directory,'secret.txt');await writeFile(secret,'HOST_SECRET');await link(secret,path.join(moved,'hard-link'));
    await assert.rejects(f.bridge.perform(f.grant.id,{operation:'command',command:'git-status'}),/Hard-linked/);assert.deepEqual(f.bridge.list(f.environment.id),[]);
    await rm(path.join(moved,'hard-link'));await writeFile(path.join(moved,'notes.txt'),Array.from({length:12000},(_,i)=>`MU_LARGE_DIFF_${i}`).join('\n'));
    const grant=await f.bridge.create(f.environment,moved,false,1,false,{},['git-diff']);
    await assert.rejects(f.bridge.perform(grant.id,{operation:'command',command:'git-diff'}),/output limit/);assert.deepEqual(f.bridge.list(f.environment.id),[]);
    assert.ok(!JSON.stringify(f.manager.store.logs(f.environment.id)).includes('MU_LARGE_DIFF_'));
  }finally{await f.close();}
});

for(const mode of ['revoke','expire','timeout'] as const)test(`A ${mode} ends an actual blocked Git and its native helper process group`,{timeout:15_000},async()=>{
  const f=await fixture(['git-status']);
  try{
    await rm(path.join(f.project,'.git/index'));await run('/usr/bin/mkfifo',[path.join(f.project,'.git/index')]);
    const group=f.bridge.grants.get(f.grant.id)!.helper.child.pid!;
    const outcome=f.bridge.perform(f.grant.id,{operation:'command',command:'git-status'}).then(value=>({value,error:undefined}),error=>({value:undefined,error:String(error)}));
    let children:{pid:number;command:string}[]=[];
    await until(async()=>{children=await groupPids(group);return children.some(item=>item.command.endsWith('/git'));});
    await assert.rejects(f.bridge.perform(f.grant.id,{operation:'command',command:'git-status'}),/正在执行/);
    if(mode==='revoke')await f.bridge.revoke(f.grant.id);
    if(mode==='expire')f.bridge.grants.get(f.grant.id)!.public.expiresAt=new Date(Date.now()-1).toISOString();
    const result=await outcome;assert.ok(result.error);assert.equal(result.value,undefined);
    await until(async()=>(await groupPids(group)).length===0);
    await until(()=>f.bridge.list(f.environment.id).length===0);
    assert.ok(children.some(item=>item.pid!==group));
  }finally{await f.close();}
});

test('The actual command sandbox denies outside reads, project writes, IPv4/IPv6/UDP, exec and child network with positive controls',async()=>{
  const directory=await mkdtemp(path.join(homedir(),'.mu-command-policy-')),project=path.join(directory,'project');await mkdir(project);
  const probe=path.join(directory,'probe'),secret=path.join(directory,'outside-secret'),target=path.join(project,'file');
  await writeFile(secret,'PRIVATE_OUTSIDE');await writeFile(target,'UNCHANGED\n');
  let v4=0,v6=0,datagrams=0;
  const ipv4=createServer(socket=>{v4++;socket.end();}),ipv6=createServer(socket=>{v6++;socket.end();}),udp=createSocket('udp4');udp.on('message',()=>datagrams++);
  await new Promise<void>(resolve=>ipv4.listen(0,'127.0.0.1',resolve));await new Promise<void>(resolve=>ipv6.listen(0,'::1',resolve));await new Promise<void>(resolve=>udp.bind(0,'127.0.0.1',resolve));
  try{
    await run('/usr/bin/xcrun',['clang','-O2',path.join(root,'native/probes/host-command-boundary.c'),'-o',probe]);
    const args=[secret,target,String((ipv4.address() as {port:number}).port),String((ipv6.address() as {port:number}).port),String(udp.address().port)];
    const positive=JSON.parse(await run(probe,args));assert.ok(Object.values(positive).every(value=>value===1));
    await until(()=>v4===2&&v6===1&&datagrams===1);await writeFile(target,'UNCHANGED\n');
    const protectedResult=JSON.parse(await run('/usr/bin/sandbox-exec',['-D',`ROOT=${project}`,'-D',`PROGRAM=${probe}`,'-f',path.join(nativeRoot,'native/bin/host-command.sb'),probe,...args]));
    assert.ok(Object.values(protectedResult).every(value=>value===0));await delay(50);assert.equal(v4,2);assert.equal(v6,1);assert.equal(datagrams,1);assert.equal(await readFile(target,'utf8'),'UNCHANGED\n');
    await symlink(secret,path.join(project,'escape'));
    const symlinkResult=JSON.parse(await run('/usr/bin/sandbox-exec',['-D',`ROOT=${project}`,'-D',`PROGRAM=${probe}`,'-f',path.join(nativeRoot,'native/bin/host-command.sb'),probe,path.join(project,'escape'),...args.slice(1)]));assert.equal(symlinkResult.outsideRead,0);
  }finally{await new Promise<void>(resolve=>ipv4.close(()=>resolve()));await new Promise<void>(resolve=>ipv6.close(()=>resolve()));udp.close();await rm(directory,{recursive:true,force:true});}
});
