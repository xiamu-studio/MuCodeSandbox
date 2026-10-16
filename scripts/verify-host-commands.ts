import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { createService } from '../server/service.ts';
import { run } from '../server/process.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-host-commands-run-'));
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const artifacts=path.join(root,'test-results',`host-commands-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
const project=path.join(owned,'project');await mkdir(project);
const service=await createService({rootDir:root,dataDir:path.join(owned,'private'),port:0});
const {manager,bridge}=service;
const browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),accountFree:true,paidModelCalls:0,actualVmTested:true,actualElectronPackageTested:false,
  scope:'Source service, actual web UI directory/command authorization, fresh strict Linux VM and real mu-host Unix-socket transport; not Electron package or arbitrary host commands',artifactsDirectory:artifacts,stages:[]};
let current:Environment|undefined,capturing=false;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function until(check:()=>boolean|Promise<boolean>,timeout=30_000){const end=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<end,'Host command acceptance timed out');await delay(100);}}
const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
async function api(endpoint:string,method='GET',body?:unknown){const response=await fetch(`${service.url}/api${endpoint}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,value.error);return value;}
async function finish(job:{id:string}){await until(()=>manager.store.jobs().some(row=>row.id===job.id&&row.status!=='running'),950_000);const done=manager.store.jobs().find(row=>row.id===job.id)!;assert.equal(done.status,'succeeded',done.message);}
async function stage(name:string){report.stages.push({name,at:new Date().toISOString()});console.log(name);}
const guest=(args:string[])=>manager.runtime.guest(manager.store.get(current!.id),args,{timeoutMs:20_000});
const admin=(args:string[])=>manager.runtime.management(manager.store.get(current!.id),args,{timeoutMs:30_000,maxBytes:32_000_000});
try{
  const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>100*2**30);
  if(process.env.MU_TEST_SING_BOX_CACHE){
    assert.equal(hash(await readFile(process.env.MU_TEST_SING_BOX_CACHE)),SING_BOX_SHA256);
    const cache=path.join(owned,'private/tools/sing-box');await mkdir(cache,{recursive:true});
    await copyFile(process.env.MU_TEST_SING_BOX_CACHE,path.join(cache,SING_BOX_ARCHIVE));report.verifiedProxyCacheReused=true;
  }
  await stage('Verifying native command boundaries and actual process cleanup');
  const nativeTests=await run(process.execPath,['--test',path.join(root,'tests/host-commands.test.ts')],{timeoutMs:30_000});
  await writeFile(path.join(artifacts,'native-tests.txt'),nativeTests,{mode:0o600});report.nativeBoundaryTestsPassed=true;
  const git='/Library/Developer/CommandLineTools/usr/bin/git',env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
  const command=(args:string[])=>run(git,['-C',project,...args],{env});
  await command(['-c','init.templateDir=','init','-q']);await writeFile(path.join(project,'notes.txt'),'MU_HOST_COMMAND_ORIGINAL\n');
  await command(['add','notes.txt']);await command(['-c','user.name=Mu test','-c','user.email=mu@example.invalid','commit','--no-gpg-sign','-qm','MU_HOST_COMMAND_COMMIT']);
  await writeFile(path.join(project,'notes.txt'),'MU_HOST_COMMAND_CHANGED\n');
  await page.goto(service.launchUrl());
  current=await api('/environments','POST',{name:'Host command acceptance',cpus:2,memoryGiB:2,diskGiB:10,network:{mode:'http',host:'127.0.0.1',port:9,strict:true,transparent:false,noProxy:''}});
  await stage('Checking separate command controls before starting VM');
  await page.getByRole('button',{name:'Host command acceptance Linux 沙箱',exact:true}).click();await page.getByRole('button',{name:'宿主授权',exact:true}).click();
  for(const name of ['Git 状态','Git 文件差异','Git 最近提交'])assert.equal(await page.getByRole('checkbox',{name,exact:true}).isChecked(),false);
  await stage('Starting fresh strict VM');await finish(await api(`/environments/${current!.id}/actions/start`,'POST'));
  const before=await manager.runtime.networkProtection(manager.store.get(current!.id));assert.ok(before.active&&before.integrity==='verified');report.before=before;
  await admin(['sudo','systemd-run','--quiet','--unit=mu-host-command-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-host-command.pcap']);capturing=true;
  await page.getByRole('textbox',{name:'授权的本机目录'}).fill(project);await page.getByRole('checkbox',{name:'Git 状态',exact:true}).check();await page.getByRole('checkbox',{name:'Git 文件差异',exact:true}).check();
  const granting=page.waitForResponse(value=>new URL(value.url()).pathname===`/api/environments/${current!.id}/bridge`&&value.request().method()==='POST');
  await page.getByRole('button',{name:'授权目录',exact:true}).click();const granted=await granting;assert.equal(granted.status(),202);await finish(await granted.json());
  const grant=bridge.list(current!.id)[0];assert.deepEqual(grant.commands,['git-status','git-diff']);assert.equal(grant.writable,false);assert.ok(grant.guestReady);
  await until(async()=>await page.getByText(project,{exact:true}).count()>0);
  await stage('Executing actual guest-to-host commands and rejecting unapproved capabilities');
  const status=JSON.parse(await guest(['mu-host',grant.id,'command','git-status'])),diff=JSON.parse(await guest(['mu-host',grant.id,'command','git-diff']));
  assert.equal(status.exitCode,0,status.output);assert.match(status.output,/ M notes.txt/);assert.equal(diff.exitCode,0,diff.output);assert.match(diff.output,/MU_HOST_COMMAND_CHANGED/);
  await assert.rejects(guest(['mu-host',grant.id,'command','git-log']),/未授权/);await assert.rejects(guest(['mu-host',grant.id,'command','git-status','--help']),/Usage/);
  const token=bridge.grants.get(grant.id)!.token;
  const extra=await fetch(`http://127.0.0.1:${bridge.port}/capability`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation:'command',command:'git-status',args:['--help']})});assert.equal(extra.status,400);
  const after=await manager.runtime.networkProtection(manager.store.get(current!.id));assert.ok(after.active&&after.integrity==='verified');assert.equal(after.firewallHash,before.firewallHash);
  report.after=after;report.commands={status,diff,unapprovedRejected:true,extraArgumentsRejected:true,hostSchemaRejected:true};
  await page.screenshot({path:path.join(artifacts,'desktop-commands.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'mobile-commands.png'),fullPage:true});
  report.mobileBounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(report.mobileBounds.scroll<=report.mobileBounds.width);
  await page.getByRole('button',{name:'撤销目录授权',exact:true}).click();await until(()=>bridge.list(current!.id).length===0);await assert.rejects(guest(['mu-host',grant.id,'command','git-status']));report.uiRevocationRejectedOldToken=true;
  await stage('Checking raw guest traffic and environment-stop revocation');
  await admin(['sudo','systemctl','stop','mu-host-command-capture.service']);capturing=false;
  const bytes=Buffer.from((await admin(['sudo','base64','-w0','/run/mu-host-command.pcap'])).trim(),'base64');await writeFile(path.join(artifacts,'commands.pcap'),bytes,{mode:0o600});
  const gateway=(await admin(['ip','-4','route','show','default'])).match(/default via (\S+)/)![1];
  const decoded=await run('/usr/sbin/tcpdump',['-nn','-r',path.join(artifacts,'commands.pcap'),'ifindex 2 and outbound and (ip or ip6)']);
  const physical=decoded.split('\n').filter(line=>/^\d\d:\d\d:\d\d\.\d+\s/.test(line));assert.ok(physical.length>0);
  const bad=physical.filter(line=>/\sIP6\s/.test(line)||!(line.includes(`.22 > ${gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)));assert.deepEqual(bad,[]);
  report.capture={bytes:bytes.length,sha256:hash(bytes),gateway,physicalPackets:physical.length,unapproved:0};
  const second=await bridge.create(manager.store.get(current!.id),project,false,1,true,{},['git-log']);assert.equal(JSON.parse(await guest(['mu-host',second.id,'command','git-log'])).exitCode,0);
  await finish(await api(`/environments/${current!.id}/actions/stop`,'POST'));assert.deepEqual(bridge.list(current!.id),[]);report.environmentStopRevokedCommands=true;
  const audit=JSON.stringify(manager.store.logs(current!.id));assert.ok(!audit.includes('MU_HOST_COMMAND_CHANGED')&&!audit.includes('MU_HOST_COMMAND_COMMIT'));report.auditContainsNoOutput=true;
  assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=(error as Error).stack;process.exitCode=1;}
finally{
  if(capturing)await admin(['sudo','systemctl','stop','mu-host-command-capture.service']).catch(()=>{});
  await browser.close();await service.close();
  try{for(const row of await manager.runtime.list()){if(row.status==='Running')await manager.runtime.command(['stop',row.name],{timeoutMs:120_000});await manager.runtime.command(['delete',row.name],{timeoutMs:120_000});}assert.deepEqual(await manager.runtime.list(),[]);await rm(owned,{recursive:true});report.testResourcesRemoved=true;}
  catch(error){report.cleanupError=String(error);report.retainedTestRoot=owned;report.passed=false;process.exitCode=1;}
  report.uiErrors=errors;report.sources=Object.fromEntries(await Promise.all(['scripts/verify-host-commands.ts','tests/host-commands.test.ts','server/host-bridge.ts','server/bridge-guest.ts','server/service.ts','shared/types.ts','src/BridgePanel.tsx','native/BridgeHelper.swift','native/probes/host-command-boundary.c','native/host-command.sb','native/bin/mu-host-bridge','native/bin/host-command.sb'].map(async file=>[file,hash(await readFile(path.join(root,file)))])));
  report.artifacts=Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file=>[file,hash(await readFile(path.join(artifacts,file)))])));report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,'test-results/host-commands.json'),JSON.stringify(report,null,2),{mode:0o600});await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,error:report.error,capture:report.capture,cleanup:report.testResourcesRemoved},null,2));
}
