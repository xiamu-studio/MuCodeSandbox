import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server/service.ts';
import { ensureGuestBrowser, inspectGuestBrowserSandbox } from '../server/guest-browser-runtime.ts';
import { APPROVED_BROWSER_RELEASES, CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { beginBrowserUpgradeScript, commitBrowserUpgradeScript, RECOVER_BROWSER_UPGRADE_SCRIPT } from '../server/browser-profile-transaction.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { Environment, Job } from '../shared/types.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { backupBrowserFixture, backupBrowserReceipt, validateBackupBrowser } from './backup-browser-fixture.ts';

const root=path.resolve(import.meta.dirname,'..');
const owned=await mkdtemp(path.join(homedir(),'.mu-browser-upgrade-test-'));
const artifacts=path.join(root,'test-results',`browser-upgrade-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const website=backupBrowserFixture('http://203.0.113.81');
const server=createServer(website.handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const fixture=await createClaudeLocalFixture({browserPort:(server.address() as {port:number}).port});
const service=await createService({rootDir:root,port:0,dataDir:owned});
const {manager,guestBrowser}=service,runtime=manager.runtime;
const originalManagement=runtime.management.bind(runtime);
const previous=APPROVED_BROWSER_RELEASES[0],candidate=CURRENT_BROWSER_RELEASE;
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),accountFree:true,paidModelCalls:0,
  sourceRuntimeTested:true,electronPackageTested:false,actualVersionUpgradeTested:true,
  versions:{previous:previous.version,candidate:candidate.version},artifactsDirectory:artifacts,stages:[]};
let current:Environment|undefined,capturing=false;
const admin=(args:string[],input?:string)=>originalManagement(current!,args,{input,timeoutMs:120_000});
async function finish(job:Job,expected:'succeeded'|'failed'='succeeded'){
  await manager.tasks.get(job.id)?.promise;const row=manager.store.jobs().find(item=>item.id===job.id)!;
  assert.equal(row.status,expected,row.message);current=manager.store.get(current!.id);return row;
}
async function stage(name:string){
  const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>80*2**30);
  report.progress={name,at:new Date().toISOString()};console.log(name);
  await writeFile(path.join(root,'test-results/browser-upgrade.json'),JSON.stringify(report,null,2),{mode:0o600});
}
async function collectCapture(name:string){
  await admin(['sudo','systemctl','stop','mu-browser-upgrade-capture.service']);capturing=false;
  const bytes=Buffer.from((await admin(['sudo','base64','-w0','/run/mu-browser-upgrade.pcap'])).trim(),'base64');
  await writeFile(path.join(artifacts,`${name}.pcap`),bytes,{mode:0o600});
  const text=await admin(['sudo','tcpdump','-nn','-r','/run/mu-browser-upgrade.pcap']);await writeFile(path.join(artifacts,`${name}-network.txt`),text,{mode:0o600});
  const gateway=(await admin(['ip','-4','route','show','default'])).match(/default via (\S+)/)![1];
  const physical=text.split('\n').filter(line=>/\seth0\s+Out\s+IP6?\s/.test(line));
  const proxy=physical.filter(line=>line.includes(` > ${gateway}.${fixture.proxyPort}:`));
  const bad=physical.filter(line=>/\sIP6\s/.test(line)||!(line.includes(` > ${gateway}.${fixture.proxyPort}:`)||line.includes(`.22 > ${gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)));
  assert.ok(proxy.length>0);assert.deepEqual(bad,[]);
  report.captures??=[];report.captures.push({name,bytes:bytes.length,sha256:hash(bytes),gateway,proxyPort:fixture.proxyPort,physicalPackets:physical.length,approvedProxy:proxy.length,unapproved:bad.length});
}
async function verify(name:string,version:string,first=false){
  if(!guestBrowser.running(current!.id))await finish(await manager.openBrowser(current!.id));
  const {receipt,entry,session}=await backupBrowserReceipt(service,current!.id);validateBackupBrowser(receipt);
  if(!first)assert.deepEqual(receipt.before,receipt.after);
  const product=await entry.tools!.send('Browser.getVersion');assert.equal(product.product.split('/').at(-1),version);
  const identity=await guestBrowser.inspect(current!.id);assert.ok(identity.matchesConfiguration);
  const sandbox=await inspectGuestBrowserSandbox(runtime,current!,{},version),protection=await runtime.networkProtection(current!);
  assert.ok(protection.active&&protection.integrity==='verified');
  const screenshot=await entry.tools!.send('Page.captureScreenshot',{format:'png'},session);
  await writeFile(path.join(artifacts,`${name}.png`),Buffer.from(screenshot.data,'base64'),{mode:0o600});
  report.stages.push({name,product,receipt,identity,sandbox,protection,version:await guestBrowser.versionStatus(current!)});
  assert.equal(website.evidence.loginRequests,1);await manager.closeBrowser(current!.id);
}
async function mutateCandidate(){
  const entry=guestBrowser.entries.get(current!.id)!;assert.ok(entry.tools&&!entry.ready);
  await assert.rejects(Promise.resolve().then(()=>guestBrowser.issue(current!.id)),/尚未就绪/);
  const session=[...entry.sessions.values()][0];assert.ok(session);
  const product=await entry.tools.send('Browser.getVersion');assert.equal(product.product.split('/').at(-1),candidate.version);
  await entry.tools.send('Page.navigate',{url:'http://203.0.113.81/read'},session);
  let receipt:any;
  for(let i=0;i<100;i++){
    const result=await entry.tools.send('Runtime.evaluate',{expression:'window.__MU_BACKUP_RESULT__??null',awaitPromise:true,returnByValue:true},session);
    if(result.result.value){receipt=result.result.value;break;}await delay(100);
  }
  validateBackupBrowser(receipt);
  const changed=await entry.tools.send('Runtime.evaluate',{expression:`(async()=>{localStorage.setItem('mu-backup-owner','new-version-mutated');const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mu-backup-browser',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put('new-version-mutated','owner');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});const stored=await new Promise((resolve,reject)=>{const r=db.transaction('state','readonly').objectStore('state').get('owner');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return {localStorage:localStorage.getItem('mu-backup-owner'),indexedDB:stored};})()`,awaitPromise:true,returnByValue:true},session);
  assert.deepEqual(changed.result.value,{localStorage:'new-version-mutated',indexedDB:'new-version-mutated'});
  const cookie=await entry.tools.send('Network.setCookie',{url:'http://203.0.113.81',name:'synthetic',value:'new-version-mutated',httpOnly:true,sameSite:'Lax',path:'/'},session);assert.ok(cookie.success);
  const cookies=await entry.tools.send('Network.getCookies',{urls:['http://203.0.113.81']},session);
  assert.equal(cookies.cookies.find((cookie:any)=>cookie.name==='synthetic')?.value,'new-version-mutated');
  await runtime.guest(current!,['touch','/home/dev/.local/share/mucodesandbox/browser/new-version-only'],{timeoutMs:15_000});
  return {product,receipt,changedLocalStorage:changed.result.value.localStorage,changedIndexedDB:changed.result.value.indexedDB,cookieChanged:cookie.success,cookieReadback:cookies.cookies.find((cookie:any)=>cookie.name==='synthetic')?.value,viewerRejected:true};
}
try{
  const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>100*2**30);
  const cache=path.join(owned,'tools/guest-browser');await mkdir(cache,{recursive:true});
  for(const release of APPROVED_BROWSER_RELEASES){
    const archive=`/tmp/mu-chromium-${release.version}-arm64.zip`;assert.equal(hash(await readFile(archive)),release.sha256);
    await copyFile(archive,path.join(cache,`chrome-${release.version}-linux-arm64.zip`));
  }
  if(process.env.MU_TEST_SING_BOX_CACHE){assert.equal(hash(await readFile(process.env.MU_TEST_SING_BOX_CACHE)),SING_BOX_SHA256);const cache=path.join(owned,'tools/sing-box');await mkdir(cache,{recursive:true});await copyFile(process.env.MU_TEST_SING_BOX_CACHE,path.join(cache,SING_BOX_ARCHIVE));}
  current=await manager.create({name:'Official browser upgrade acceptance',cpus:2,memoryGiB:2,diskGiB:10,
    browserUrl:'http://203.0.113.81/write',identity:{timezone:'Asia/Tokyo',locale:'ja-JP'},
    network:{mode:'http',host:'127.0.0.1',port:fixture.proxyPort,username:'mu',password:'tui-fixture',strict:true,transparent:true,noProxy:''}});
  await stage('Starting fresh protected VM and installing previous official version');await finish(await manager.lifecycle(current.id,'start'));
  await ensureGuestBrowser(runtime,current,{},previous.version);await verify('previous-initial',previous.version,true);
  await finish(await manager.lifecycle(current.id,'stop'));
  const {id:_id,instanceName:_instance,state:_state,lastError:_error,createdAt:_created,updatedAt:_updated,browserRunning:_browser,...config}=current;
  const {passwordConfigured:_configured,...network}=config.network;
  current=await manager.update(current.id,{...config,network:{...network,password:'tui-fixture'},browserUrl:'http://203.0.113.81/read'});
  await finish(await manager.lifecycle(current.id,'start'));fixture.restrictToLocalFixture();
  await admin(['sudo','systemd-run','--quiet','--unit=mu-browser-upgrade-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-browser-upgrade.pcap']);capturing=true;
  assert.equal((await guestBrowser.versionStatus(current)).updateAvailable,true);
  await stage('Rejecting adoption after new version changes actual site data');
  runtime.management=async(e,args,options)=>{
    if(options?.input===commitBrowserUpgradeScript(candidate)){
      report.failedAdoptionCandidate=await mutateCandidate();throw new Error('MU_TEST_ADOPTION_FAILURE');
    }
    return originalManagement(e,args,options);
  };
  const failed=await finish(await manager.maintainBrowser(current.id,'update'),'failed');assert.match(failed.message,/MU_TEST_ADOPTION_FAILURE/);
  runtime.management=originalManagement;
  assert.equal((await guestBrowser.versionStatus(current)).installedVersion,previous.version);
  await assert.rejects(runtime.guest(current,['test','-e','/home/dev/.local/share/mucodesandbox/browser/new-version-only']));
  await verify('previous-restored',previous.version);report.failedAdoptionRestoredProfile=true;
  await stage('Killing the upgrade checkpoint process before next-operation recovery');
  const checkpoint=beginBrowserUpgradeScript(candidate);
  const instrumented=checkpoint.replace("print('MU_BROWSER_UPGRADE_STAGE checkpointed', flush=True)","print('MU_BROWSER_UPGRADE_STAGE checkpointed', flush=True)\n    print('MU_TEST_UPGRADE_PID', os.getpid(), flush=True)\n    os.kill(os.getpid(), 19)");assert.notEqual(instrumented,checkpoint);
  let output='',pid:number|undefined;
  const pending=originalManagement(current,['bash','-s'],{input:instrumented,timeoutMs:120_000,onOutput:value=>{output+=value;const match=output.match(/MU_TEST_UPGRADE_PID (\d+)/);if(match)pid=Number(match[1]);}});
  const outcome=pending.then(()=>({succeeded:true}),error=>({error:String(error)}));
  try{
    const deadline=Date.now()+60_000;while(!pid){assert.ok(Date.now()<deadline,'Upgrade checkpoint timed out');await delay(100);}
    const processState=await admin(['sudo','python3','-c',`import pathlib,json;p=pathlib.Path('/proc/${pid}');print(json.dumps({'exe':str((p/'exe').readlink()),'status':(p/'status').read_text()}))`]);
    const parsed=JSON.parse(processState);assert.match(parsed.exe,/python3/);assert.match(parsed.status,/State:\s+T/);
    const journal=JSON.parse(await admin(['sudo','cat','/var/lib/mucodesandbox/browser-upgrade.json']));assert.equal(journal.committed,false);
    await admin(['sudo','kill','-KILL',String(pid)]);const result=await outcome;assert.ok('error' in result);
    assert.equal((await guestBrowser.versionStatus(current)).recoveryRequired,true);
    await verify('previous-after-kill',previous.version);
    assert.equal((await guestBrowser.versionStatus(current)).recoveryRequired,false);
    report.actualCheckpointProcessKilled={pid,processState:parsed,journal,outcome:result};
  }finally{if(pid)await admin(['sudo','kill','-KILL',String(pid)]).catch(()=>{});await outcome;}
  await stage('Adopting the new official version after production acceptance checks');
  await finish(await manager.maintainBrowser(current.id,'update'));
  await verify('candidate-adopted',candidate.version);
  const status=await guestBrowser.versionStatus(current);assert.equal(status.installedVersion,candidate.version);assert.equal(status.recoveryRequired,false);assert.equal(status.updateAvailable,false);
  await assert.rejects(admin(['sudo','test','-e','/var/lib/mucodesandbox/browser-upgrade/profile.tar']));
  await collectCapture('upgrade');
  await stage('Restarting the VM and confirming adopted site data');
  await finish(await manager.lifecycle(current.id,'restart'));
  await admin(['sudo','systemd-run','--quiet','--unit=mu-browser-upgrade-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-browser-upgrade.pcap']);capturing=true;
  await verify('candidate-after-restart',candidate.version);
  report.checkpointReleasedAfterAdoption=true;report.passed=true;
}catch(error){runtime.management=originalManagement;report.error=(error as Error).stack;report.logs=current?manager.store.logs(current.id).slice(-20):[];process.exitCode=1;}
finally{
  if(capturing){try{await collectCapture('after-restart');}catch(error){report.captureError=String(error);report.passed=false;process.exitCode=1;}}
  report.browserEvidence=website.evidence;
  await service.close();await fixture.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  try{for(const row of await runtime.list()){if(row.status==='Running')await runtime.command(['stop',row.name],{timeoutMs:120_000});await runtime.command(['delete',row.name],{timeoutMs:120_000});}assert.deepEqual(await runtime.list(),[]);await rm(owned,{recursive:true});report.testResourcesRemoved=true;}
  catch(error){report.cleanupError=String(error);report.retainedTestRoot=owned;report.passed=false;process.exitCode=1;}
  report.sources=Object.fromEntries(await Promise.all(['scripts/verify-browser-upgrade.ts','server/browser-releases.ts','server/browser-profile-transaction.ts','server/guest-browser-runtime.ts','server/guest-browser.ts'].map(async file=>[file,hash(await readFile(path.join(root,file)))])));
  report.artifacts=Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file=>[file,hash(await readFile(path.join(artifacts,file)))])));
  report.finishedAt=new Date().toISOString();await writeFile(path.join(root,'test-results/browser-upgrade.json'),JSON.stringify(report,null,2),{mode:0o600});await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({passed:report.passed,error:report.error,captures:report.captures,cleanup:report.testResourcesRemoved,stages:report.stages.map((s:any)=>s.name)},null,2));
}
