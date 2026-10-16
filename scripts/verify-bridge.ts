import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Manager } from '../server/manager.ts';
import { HostBridge } from '../server/host-bridge.ts';
import type { Job } from '../shared/types.ts';
const root=path.resolve(import.meta.dirname,'..');
const directory=await mkdtemp(path.join(homedir(),'.mu-bridge-verification-'));
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const manager=new Manager(path.join(directory,'private')),bridge=new HostBridge(manager.store,manager.runtime,root);
manager.onBeforeStop=id=>bridge.revokeEnvironment(id);
const report:Record<string,unknown>={passed:false,accountFree:true};
const project=path.join(directory,'project'),outside=path.join(directory,'outside');await mkdir(project);await mkdir(outside);await writeFile(path.join(project,'fixture.txt'),'MU_BRIDGE_GUEST_OK');await writeFile(path.join(outside,'secret.txt'),'NOT_GRANTED');await symlink(outside,path.join(project,'escape'));
const e=await manager.create({name:'Bridge account-free verification',cpus:2,memoryGiB:2,diskGiB:10});
async function finish(job:Job){await manager.tasks.get(job.id)?.promise;const done=manager.store.jobs().find(j=>j.id===job.id)!;assert.equal(done.status,'succeeded',done.message);}
const guest=(args:string[],input?:string)=>manager.runtime.guest(manager.store.get(e.id),args,{input,timeoutMs:20_000});
try{
  await finish(await manager.lifecycle(e.id,'start'));await finish(await manager.lifecycle(e.id,'prepare-network'));
  await manager.update(e.id,{name:e.name,cpus:2,memoryGiB:2,diskGiB:10,network:{mode:'http',host:'127.0.0.1',port:9,username:'',noProxy:'',strict:true}});await finish(await manager.lifecycle(e.id,'start'));
  const before=await manager.runtime.networkProtection(manager.store.get(e.id));assert.equal(before.active,true);
  const grant=await bridge.create(manager.store.get(e.id),project,false);
  assert.equal((await guest(['mu-host',grant.id,'read','fixture.txt'])).trim(),'MU_BRIDGE_GUEST_OK');report.guestReadsExplicitlyGrantedHostFile=true;
  await assert.rejects(guest(['mu-host',grant.id,'read','escape/secret.txt']));await assert.rejects(guest(['mu-host',grant.id,'read','../outside/secret.txt']));await assert.rejects(guest(['mu-host',grant.id,'write','no.txt'],'DENIED'));report.traversalSymlinkAndUnapprovedWritesDenied=true;
  const after=await manager.runtime.networkProtection(manager.store.get(e.id));assert.equal(after.active,true);assert.equal(after.firewallHash,before.firewallHash);report.sshUnixBridgeNeedsNoExtraNetworkException=true;
  await bridge.revoke(grant.id);await assert.rejects(guest(['mu-host',grant.id,'read','fixture.txt']));report.revocationEndsGuestAccess=true;
  const writeGrant=await bridge.create(manager.store.get(e.id),project,true);await guest(['mu-host',writeGrant.id,'write','result.txt'],'MU_BRIDGE_WRITE_OK');assert.equal(await readFile(path.join(project,'result.txt'),'utf8'),'MU_BRIDGE_WRITE_OK');report.authorizedAtomicWriteWorks=true;
  await finish(await manager.lifecycle(e.id,'stop'));assert.deepEqual(bridge.list(e.id),[]);report.stopRevokesAllGrants=true;report.passed=true;
}catch(error){report.error=(error as Error).message;report.logs=manager.store.logs(e.id).slice(-8);process.exitCode=1;}
finally{await bridge.close();await manager.lifecycle(e.id,'delete').then(finish).catch(error=>report.cleanupError=String(error));await manager.close();if(!report.cleanupError)await rm(directory,{recursive:true,force:true});else report.retainedDataDir=directory;await mkdir(path.join(root,'test-results'),{recursive:true});await writeFile(path.join(root,'test-results/host-bridge.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
