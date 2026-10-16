import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, link, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DescriptorBridge, bridgeRequestSchema, HostBridge } from '../server/host-bridge.ts';
import { Manager } from '../server/manager.ts';
const root=path.resolve(import.meta.dirname,'..');
const nativeRoot=path.resolve(process.env.MU_TEST_HOST_COMMAND_ROOT??root);

test('Native bridge denies traversal, symlinks, hard links and oversized files; pinned roots survive replacement',async()=>{
  const directory=await mkdtemp(path.join(homedir(),'.mu-bridge-test-'));
  const helper=new DescriptorBridge(path.join(nativeRoot,'native/bin/mu-host-bridge'));
  try{
    const project=path.join(directory,'project'),outside=path.join(directory,'outside');await mkdir(project);await mkdir(outside);await mkdir(path.join(project,'nested'));
    await writeFile(path.join(project,'original.txt'),'MU_HOST_OK');await writeFile(path.join(outside,'secret.txt'),'OUTSIDE_SECRET');
    await helper.send({root:project,writable:true});
    const listing=await helper.send({operation:'list',path:''});
    assert.deepEqual(await helper.send({operation:'list',path:''}),listing);
    await writeFile(path.join(project,'added.txt'),'MU_ADDED');
    const updated=await helper.send({operation:'list',path:''}) as {name:string}[];
    assert.ok(updated.some(item=>item.name==='added.txt'));
    assert.equal((await helper.send({operation:'read',path:'original.txt'}) as {data:string}).data,Buffer.from('MU_HOST_OK').toString('base64'));
    assert.equal(await helper.send({operation:'sha256',path:'original.txt'}),createHash('sha256').update('MU_HOST_OK').digest('hex'));
    await helper.send({operation:'write',path:'nested/result.txt',data:Buffer.from('MU_WRITE_OK').toString('base64')});assert.equal(await readFile(path.join(project,'nested/result.txt'),'utf8'),'MU_WRITE_OK');
    await symlink(outside,path.join(project,'escape'));await symlink(path.join(outside,'secret.txt'),path.join(project,'linked.txt'));await link(path.join(outside,'secret.txt'),path.join(project,'hard.txt'));
    for(const relative of ['../outside/secret.txt','/etc/passwd','escape/secret.txt','linked.txt','hard.txt'])await assert.rejects(helper.send({operation:'read',path:relative}));
    await assert.rejects(helper.send({operation:'write',path:'linked.txt',data:Buffer.from('OVERWRITE').toString('base64')}));assert.equal(await readFile(path.join(outside,'secret.txt'),'utf8'),'OUTSIDE_SECRET');
    await writeFile(path.join(project,'large.txt'),Buffer.alloc(1_048_577));await assert.rejects(helper.send({operation:'read',path:'large.txt'}));
    await rename(project,project+'-original');await symlink(outside,project);
    const pinned=await helper.send({operation:'list',path:''}) as {name:string}[];
    assert.ok(pinned.some(item=>item.name==='original.txt')&&!pinned.some(item=>item.name==='secret.txt'));
    assert.deepEqual(await helper.send({operation:'list',path:''}),pinned);
    assert.equal((await helper.send({operation:'read',path:'original.txt'}) as {data:string}).data,Buffer.from('MU_HOST_OK').toString('base64'));
    await assert.rejects(helper.send({operation:'read',path:'secret.txt'}));
    for(const value of ['../x','x/../y','/x','x//y','x\0y'])assert.throws(()=>bridgeRequestSchema.parse({operation:'read',path:value}));
  }finally{await helper.close();await rm(directory,{recursive:true,force:true});}
});

test('Read-only grants, bearer scope, origin rejection, expiration and revocation are enforced',async()=>{
  const directory=await mkdtemp(path.join(homedir(),'.mu-bridge-test-'));
  const manager=new Manager(path.join(directory,'private'));const bridge=new HostBridge(manager.store,manager.runtime,nativeRoot);
  try{
    const project=path.join(directory,'project');await mkdir(project);await writeFile(path.join(project,'file.txt'),'CONTENT_NEVER_IN_AUDIT');
    const e=await manager.create({name:'Bridge synthetic'});const grant=await bridge.create(e,project,false,1,false);
    await assert.rejects(bridge.perform(grant.id,{operation:'write',path:'file.txt',data:''}));
    const endpoint=`http://127.0.0.1:${bridge.port}/capability`;
    assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'read',path:'file.txt'})})).status,401);
    const token=bridge.grants.get(grant.id)!.token;
    const call=(headers:Record<string,string>={})=>fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify({operation:'read',path:'file.txt'})});
    assert.equal((await call({Origin:'https://foreign.test'})).status,403);
    assert.equal((await call()).status,200);
    assert.ok(!JSON.stringify(manager.store.logs(e.id)).includes('CONTENT_NEVER_IN_AUDIT'));
    bridge.grants.get(grant.id)!.public.expiresAt=new Date(Date.now()-1).toISOString();assert.equal((await call()).status,401);
    await bridge.revoke(grant.id);assert.equal((await call()).status,401);await assert.rejects(bridge.perform(grant.id,{operation:'read',path:'file.txt'}));
    assert.deepEqual(bridge.list(e.id),[]);
  }finally{await bridge.close();await manager.close();await rm(directory,{recursive:true,force:true});}
});
