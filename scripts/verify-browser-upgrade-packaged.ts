import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { APPROVED_BROWSER_RELEASES, CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { ensureGuestBrowser, inspectGuestBrowserSandbox } from '../server/guest-browser-runtime.ts';
import { beginBrowserUpgradeScript, RECOVER_BROWSER_UPGRADE_SCRIPT } from '../server/browser-profile-transaction.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import { createClaudeLocalFixture } from './claude-local-fixture.ts';
import { backupBrowserFixture, validateBackupBrowser } from './backup-browser-fixture.ts';
import type { Environment } from '../shared/types.ts';
import { packetLines, readPacketCapture } from './packet-capture.ts';

const root=path.resolve(import.meta.dirname,'..');
const bridgeOwner=process.argv.includes('--bridge-owner');
const reportName=bridgeOwner?'browser-upgrade-bridge-owner':'browser-upgrade-packaged';
const owned=await mkdtemp(path.join(homedir(),'.mu-upgrade-packaged-vm-')),directory=path.join(owned,'private');
const bundle=path.join(root,`release/${bridgeOwner?'bridge-owner-candidate':'browser-upgrade-shutdown-candidate'}/mac-arm64/MuCodeSandbox.app`);
const artifacts=path.join(root,'test-results',`${reportName}-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const runtime=new LimaRuntime(directory),previous=APPROVED_BROWSER_RELEASES[0],candidate=CURRENT_BROWSER_RELEASE;
const website=backupBrowserFixture('http://203.0.113.81'),server=createServer(website.handler);
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const fixture=await createClaudeLocalFixture({browserPort:(server.address() as {port:number}).port});
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),accountFree:true,paidModelCalls:0,
  actualElectronPackageTested:true,actualVmUpgradeTested:true,freshDataDirectory:true,bridgeOwnerPackageTested:bridgeOwner,
  scope:'Actual signed Electron package, fresh VM, UI recovery/update, profile fault rejection, real official version upgrade and reboot; previous-version preparation uses source installer',
  package:{bundle},versions:{previous:previous.version,candidate:candidate.version},artifactsDirectory:artifacts,stages:[],observations:[],captures:[]};
let application:ElectronApplication|undefined,page:Page|undefined,current:Environment|undefined,capturing=false;
const sourceFiles=['scripts/verify-browser-upgrade-packaged.ts','server/guest-browser-runtime.ts','server/browser-profile-transaction.ts','scripts/backup-browser-fixture.ts',...(bridgeOwner?['scripts/claude-local-fixture.ts','scripts/packet-capture.ts','server/browser-releases.ts']:[])];
let moduleFiles:string[]=[];
const errors:string[]=[];
const admin=(args:string[],input?:string)=>runtime.management(current!,args,{input,timeoutMs:120_000,maxBytes:128_000_000});
async function until(check:()=>boolean|Promise<boolean>,timeoutMs=30_000){const end=Date.now()+timeoutMs;while(!await check()){assert.ok(Date.now()<end,'Packaged upgrade observation timed out');await delay(150);}}
async function api(endpoint:string,method='GET',body?:unknown):Promise<any>{
  return page!.evaluate(async({endpoint,method,body})=>{const response=await fetch(`/api${endpoint}`,{method,
    headers:{Authorization:`Bearer ${(window as any).__MU_CONFIG__.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error);return result;},{endpoint,method,body});
}
async function finish(job:{id:string},expected='succeeded'){
  let result:any;await until(async()=>{const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>80*2**30);
    result=(await api('/snapshot')).jobs.find((item:any)=>item.id===job.id);return result&&result.status!=='running';},950_000);
  assert.equal(result.status,expected,result.message);current=(await api('/snapshot')).environments.find((item:Environment)=>item.id===current!.id);return result;
}
async function stage(name:string){report.stages.push({name,at:new Date().toISOString()});console.log(name);await writeFile(path.join(root,`test-results/${reportName}.json`),JSON.stringify(report,null,2),{mode:0o600});}
async function action(name:string){await finish(await api(`/environments/${current!.id}/actions/${name}`,'POST'));}
async function uiJob(action:'update'|'recover',expected='succeeded'){
  const response=page!.waitForResponse(value=>new URL(value.url()).pathname===`/api/environments/${current!.id}/browser/${action}`&&value.request().method()==='POST');
  await page!.getByRole('button',{name:action==='update'?'更新浏览器':'恢复浏览器',exact:true}).click();
  const received=await response;assert.equal(received.status(),202);return finish(await received.json(),expected);
}
async function screenshot(name:string){
  const result=await application!.evaluate(async({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0];window.setOpacity(0);window.showInactive();
    try{await new Promise(resolve=>setTimeout(resolve,150));const image=await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Native capture timed out')),15_000))]);
      const bitmap=image.toBitmap(),colors=new Set<number>();for(let offset=0;offset<bitmap.length;offset+=4)colors.add(bitmap.readUInt32LE(offset));return {png:image.toPNG().toString('base64'),colors:colors.size,size:image.getSize()};
    }finally{window.hide();window.setOpacity(1);}
  });assert.ok(result.colors>32);await writeFile(path.join(artifacts,`${name}.png`),Buffer.from(result.png,'base64'),{mode:0o600});return {colors:result.colors,size:result.size};
}
async function browser(name:string,version:string,first=false,receiptBaseline?:number){
  const alreadyOpen=receiptBaseline!==undefined,baseline=receiptBaseline??website.evidence.receipts.length;
  if(!alreadyOpen)await finish(await api(`/environments/${current!.id}/browser/open`,'POST'));
  await until(()=>website.evidence.receipts.length>baseline);
  const receipt=website.evidence.receipts[baseline];validateBackupBrowser(receipt);
  if(!first)assert.deepEqual(receipt.before,receipt.after);assert.equal(website.evidence.loginRequests,1);
  await until(()=>application!.windows().some(window=>new URL(window.url()||'about:blank').searchParams.get('guestBrowser')===current!.id));
  const viewer=application!.windows().find(window=>new URL(window.url()||'about:blank').searchParams.get('guestBrowser')===current!.id)!;
  await viewer.getByRole('status').filter({hasText:'已连接'}).waitFor();
  const canvas=viewer.locator('.guest-browser-canvas canvas');await canvas.waitFor();
  let rendered:any;await until(async()=>{rendered=await canvas.evaluate((canvas:HTMLCanvasElement)=>{const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data,colors=new Set<string>();for(let i=0;i<data.length;i+=400)colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);return {width:canvas.width,height:canvas.height,colors:colors.size};});return rendered.width===1280&&rendered.height===800&&rendered.colors>20;});
  const state=await api(`/environments/${current!.id}/browser/version`);assert.equal(state.installedVersion,version);assert.equal(state.recoveryRequired,false);
  const actual=(await admin(['sudo',`/opt/mucodesandbox/chromium-${version}/chrome-linux-arm64/chrome`,'--version'])).trim();assert.equal(actual.split(' ').at(-1),version);
  const sandbox=await inspectGuestBrowserSandbox(runtime,current!,{},version),identity=await api(`/environments/${current!.id}/browser/inspect`),protection=await api(`/environments/${current!.id}/network/protection`);
  assert.ok(identity.matchesConfiguration&&protection.active&&protection.integrity==='verified');
  // Read the actual VNC canvas directly; hidden-window scroll stability can block locator screenshots.
  const png=await canvas.evaluate((canvas:HTMLCanvasElement)=>canvas.toDataURL('image/png').split(',')[1]);
  await writeFile(path.join(artifacts,`${name}.png`),Buffer.from(png,'base64'),{mode:0o600});
  report.observations.push({name,receipt,receiptBaseline:baseline,receiptCount:website.evidence.receipts.length,rendered,state,actual,sandbox,identity,protection});
  await api(`/environments/${current!.id}/browser/close`,'POST');await until(()=>viewer.isClosed());
}
async function captureStart(){await admin(['sudo','systemd-run','--quiet','--unit=mu-upgrade-package-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-upgrade-package.pcap']);capturing=true;}
async function captureStop(name:string){
  await admin(['sudo','systemctl','stop','mu-upgrade-package-capture.service']);capturing=false;
  const bytes=Buffer.from((await admin(['sudo','base64','-w0','/run/mu-upgrade-package.pcap'])).trim(),'base64');await writeFile(path.join(artifacts,`${name}.pcap`),bytes,{mode:0o600});
  report.captures.push(await decodeCapture(name,bytes,true));
}
async function decodeCapture(name:string,bytes:Buffer,requireBusiness=false){
  assert.equal((await admin(['cat','/sys/class/net/eth0/ifindex'])).trim(),'2');
  const gateway=(await admin(['ip','-4','route','show','default'])).match(/default via (\S+)/)![1];
  const file=path.join(artifacts,`${name}.pcap`),physical=(await packetLines(file,'ifindex 2 and outbound and (ip or ip6)')).length;
  const proxy=(await packetLines(file,`ifindex 2 and outbound and tcp and dst host ${gateway} and dst port ${fixture.proxyPort}`)).length;
  const ssh=(await packetLines(file,`ifindex 2 and outbound and tcp and src port 22 and dst host ${gateway}`)).length;
  const allowed=`(tcp and src port 22 and dst host ${gateway}) or (udp and src port 68 and dst port 67)${bridgeOwner?'':` or (tcp and dst host ${gateway} and dst port ${fixture.proxyPort})`}`;
  const bad=await packetLines(file,`ifindex 2 and outbound and (ip6 or (ip and not (${allowed})))`);
  assert.ok(physical>0);assert.deepEqual(bad,[]);if(requireBusiness)assert.ok((bridgeOwner?ssh:proxy)>0);
  if(bridgeOwner)assert.equal(proxy,0);
  await writeFile(path.join(artifacts,`${name}-network.txt`),await readPacketCapture(file,'ifindex 2 and outbound and (ip or ip6)'),{mode:0o600});
  return {name,bytes:bytes.length,sha256:hash(bytes),gateway,proxyPort:fixture.proxyPort,physicalPackets:physical,approvedProxy:proxy,approvedSsh:ssh,unapproved:0};
}
try{
  const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>100*2**30);
  await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);const signature=await run('/usr/bin/codesign',['-d','--verbose=4',bundle]);report.package.cdHash=signature.match(/^CDHash=(.+)$/m)?.[1];assert.match(report.package.cdHash,/^[a-f0-9]{40}$/);
  if(bridgeOwner){
    assert.equal(report.package.cdHash,'9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3');
    const modules=(await readdir(path.join(bundle,'Contents/Resources/app/dist-server/server'))).filter(file=>file.endsWith('.js')).sort();assert.equal(modules.length,45);
    moduleFiles=['desktop/main.cjs',...modules.map(file=>`dist-server/server/${file}`)];
    report.package.modules=Object.fromEntries(await Promise.all(moduleFiles.map(async file=>[file,hash(await readFile(path.join(bundle,'Contents/Resources/app',file)))])));
    report.sources=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(root,file)))])));
    for(const file of sourceFiles)await copyFile(path.join(root,file),path.join(artifacts,`source-${path.basename(file)}`));
  }
  const cache=path.join(directory,'tools/guest-browser');await mkdir(cache,{recursive:true});for(const release of APPROVED_BROWSER_RELEASES){const source=`/tmp/mu-chromium-${release.version}-arm64.zip`;assert.equal(hash(await readFile(source)),release.sha256);await copyFile(source,path.join(cache,`chrome-${release.version}-linux-arm64.zip`));}
  if(process.env.MU_TEST_SING_BOX_CACHE){assert.equal(hash(await readFile(process.env.MU_TEST_SING_BOX_CACHE)),SING_BOX_SHA256);const cache=path.join(directory,'tools/sing-box');await mkdir(cache,{recursive:true});await copyFile(process.env.MU_TEST_SING_BOX_CACHE,path.join(cache,SING_BOX_ARCHIVE));}
  application=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/MuCodeSandbox'),args:[],chromiumSandbox:true,env:{...process.env,MU_DATA_DIR:directory,MU_DESKTOP_USER_DATA_DIR:path.join(owned,'desktop'),MU_TEST_CLAUDE:'0'},timeout:60_000});
  const hide=()=>void application!.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.webContents.setBackgroundThrottling(false);window.hide();}}).catch(()=>{});application.on('window',hide);hide();
  page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.getByRole('heading',{name:'MuCodeSandbox',exact:true}).waitFor();
  report.application=await application.evaluate(({app})=>({packaged:app.isPackaged,appPath:app.getAppPath(),renderers:app.getAppMetrics().filter(item=>item.type==='Tab').map(item=>({pid:item.pid,sandboxed:item.sandboxed}))}));assert.ok(report.application.packaged&&report.application.renderers.every((item:any)=>item.sandboxed));
  current=await api('/environments','POST',{name:'Packaged official browser upgrade',cpus:2,memoryGiB:2,diskGiB:10,browserUrl:'http://203.0.113.81/write',identity:{timezone:'Asia/Tokyo',locale:'ja-JP'},network:{mode:'http',host:'127.0.0.1',port:fixture.proxyPort,username:'mu',password:'tui-fixture',strict:true,transparent:true,noProxy:''}});
  await stage('Starting fresh VM through actual Electron package');await action('start');
  const boot=Buffer.from((await admin(['sudo','base64','-w0','/var/log/mucodesandbox/boot-network.pcap'])).trim(),'base64');
  await writeFile(path.join(artifacts,'first-boot.pcap'),boot,{mode:0o600});
  report.firstBoot=await decodeCapture('first-boot',boot);
  if(bridgeOwner){
    const bootId=(await admin(['cat','/proc/sys/kernel/random/boot_id'])).trim(),capturedBootId=(await admin(['sudo','cat','/var/log/mucodesandbox/boot-network.boot-id'])).trim();
    assert.match(bootId,/^[a-f0-9-]{36}$/);assert.equal(capturedBootId,bootId);
    const activeState=(await admin(['sudo','systemctl','show','--property=ActiveState','--value','mucodesandbox-boot-capture.service'])).trim();
    const subState=(await admin(['sudo','systemctl','show','--property=SubState','--value','mucodesandbox-boot-capture.service'])).trim();assert.equal(activeState,'active');assert.equal(subState,'exited');
    Object.assign(report.firstBoot,{bootId,capturedBootId,activeState,subState});
  }
  await stage('Preparing approved previous version then opening through actual package');await ensureGuestBrowser(runtime,current!,{},previous.version);await browser('previous-initial',previous.version,true);
  await action('stop');
  const {id:_id,instanceName:_instance,state:_state,lastError:_error,createdAt:_created,updatedAt:_updated,browserRunning:_browser,...config}=current!;
  const {passwordConfigured:_configured,...network}=config.network;
  current=await api(`/environments/${current!.id}`,'PUT',{...config,network:{...network,password:'tui-fixture'},browserUrl:'http://203.0.113.81/read'});await action('start');fixture.restrictToLocalFixture();await captureStart();
  await page.getByRole('button',{name:`${current!.name} Linux 沙箱`,exact:true}).click();await page.getByRole('button',{name:'浏览器',exact:true}).click();await page.getByText(previous.version,{exact:true}).waitFor();
  await stage('Rejecting symlink profile entries before any upgrade mutation');
  await runtime.guest(current!,['ln','-s','/etc/passwd','/home/dev/.local/share/mucodesandbox/browser/forbidden-profile-link']);
  const rejected=await uiJob('update','failed');assert.match(rejected.message,/Unsupported browser profile checkpoint entry/);
  await runtime.guest(current!,['rm','/home/dev/.local/share/mucodesandbox/browser/forbidden-profile-link']);report.profileLinkRejected=true;
  await browser('previous-after-rejection',previous.version);
  await stage('Rejecting a damaged checkpoint and displaying explicit recovery');
  await admin(['bash','-s'],beginBrowserUpgradeScript(candidate));
  const journal=await admin(['sudo','cat','/var/lib/mucodesandbox/browser-upgrade.json']);
  await admin(['sudo','cp','/var/lib/mucodesandbox/browser-upgrade.json','/var/lib/mucodesandbox/browser-upgrade.saved']);
  await admin(['sudo','cp','/var/lib/mucodesandbox/browser-upgrade/profile.tar','/var/lib/mucodesandbox/browser-profile.saved']);
  await admin(['sudo','python3','-c',"from pathlib import Path;p=Path('/var/lib/mucodesandbox/browser-upgrade/profile.tar');f=p.open('r+b');f.seek(1024);b=f.read(1);f.seek(1024);f.write(bytes([b[0]^1]));f.close()"]);
  await page.getByRole('button',{name:'检测浏览器版本',exact:true}).click();await page.getByText('等待恢复',{exact:true}).waitFor();
  const damaged=await uiJob('recover','failed');assert.match(damaged.message,/checksum mismatch/);
  assert.equal(await admin(['sudo','cat','/var/lib/mucodesandbox/browser-upgrade.json']),journal);
  assert.equal((await api(`/environments/${current!.id}/browser/version`)).recoveryRequired,true);report.corruptCheckpointRejected=true;
  await admin(['sudo','cp','/var/lib/mucodesandbox/browser-profile.saved','/var/lib/mucodesandbox/browser-upgrade/profile.tar']);
  await stage('Rejecting a malformed upgrade journal without deleting the valid checkpoint');
  await admin(['sudo','python3','-c',"import json,pathlib;p=pathlib.Path('/var/lib/mucodesandbox/browser-upgrade.json');d=json.loads(p.read_text());d['priorRecipe']='../../unapproved';p.write_text(json.dumps(d))"]);
  await assert.rejects(admin(['bash','-s'],RECOVER_BROWSER_UPGRADE_SCRIPT),/Unapproved browser upgrade version/);await admin(['sudo','test','-s','/var/lib/mucodesandbox/browser-upgrade/profile.tar']);
  await admin(['sudo','cp','/var/lib/mucodesandbox/browser-upgrade.saved','/var/lib/mucodesandbox/browser-upgrade.json']);report.malformedJournalRejected=true;
  await uiJob('recover');await page.getByText('可更新',{exact:true}).waitFor();await browser('previous-after-ui-recovery',previous.version);
  await stage('Upgrading official browser using the actual Electron update button');
  const beforeUpdate=website.evidence.receipts.length;
  await uiJob('update');await page.getByText('当前版本',{exact:true}).waitFor();await browser('candidate-after-ui-update',candidate.version,false,beforeUpdate);
  await page.getByRole('heading',{name:'浏览器版本',exact:true}).evaluate(node=>node.closest('section')!.scrollIntoView({block:'center'}));report.versionUiScreenshot=await screenshot('version-updated');
  await assert.rejects(admin(['sudo','test','-e','/var/lib/mucodesandbox/browser-upgrade/profile.tar']));await captureStop('upgrade');
  await stage('Restarting adopted browser environment through the package');await action('restart');await captureStart();await browser('candidate-after-restart',candidate.version);await captureStop('restart');
  report.uiJobs=(await api('/snapshot')).jobs.filter((job:any)=>['browser-update','browser-recover'].includes(job.action)).map((job:any)=>({action:job.action,status:job.status,message:job.message}));
  await stage('Closing actual application with an active browser viewer');
  await finish(await api(`/environments/${current!.id}/browser/open`,'POST'));
  const closingAt=Date.now();await application.close();application=undefined;report.activeViewerShutdown={elapsedMs:Date.now()-closingAt,completed:true};
  assert.ok(report.activeViewerShutdown.elapsedMs<30_000);await assert.rejects(admin(['sudo','systemctl','is-active','--quiet','mucodesandbox-browser.service']));
  assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=(error as Error).stack;process.exitCode=1;}
finally{
  if(capturing)await captureStop('failure').catch(error=>{report.captureError=String(error);report.passed=false;process.exitCode=1;});
  report.browserEvidence=website.evidence;report.uiErrors=errors;report.proxyDecisions=fixture.decisions;
  await application?.close().catch(error=>{report.closeError=String(error);report.passed=false;process.exitCode=1;});await fixture.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  try{for(const row of await runtime.list()){if(row.status==='Running')await runtime.command(['stop',row.name],{timeoutMs:120_000});await runtime.command(['delete',row.name],{timeoutMs:120_000});}assert.deepEqual(await runtime.list(),[]);await rm(owned,{recursive:true});report.testResourcesRemoved=true;}
  catch(error){report.cleanupError=String(error);report.retainedTestRoot=owned;report.passed=false;process.exitCode=1;}
  if(bridgeOwner){
    for(const [file,digest] of Object.entries(report.sources??{}))assert.equal(hash(await readFile(path.join(root,file))),digest,'Source changed during upgrade acceptance');
    for(const [file,digest] of Object.entries(report.package.modules??{}))assert.equal(hash(await readFile(path.join(bundle,'Contents/Resources/app',file))),digest,'Package changed during upgrade acceptance');
  }else{
    report.sources=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(root,file)))])));
    report.package.modules=Object.fromEntries(await Promise.all(['browser-releases','browser-profile-transaction','browser-install-transaction','guest-browser-runtime','guest-browser','manager','service'].map(async name=>{const file=`dist-server/server/${name}.js`;return [file,hash(await readFile(path.join(bundle,'Contents/Resources/app',file)))];})));
  }
  report.artifacts=Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file=>[file,hash(await readFile(path.join(artifacts,file)))])));report.finishedAt=new Date().toISOString();
  await writeFile(path.join(root,`test-results/${reportName}.json`),JSON.stringify(report,null,2),{mode:0o600});await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,error:report.error,captures:report.captures,cleanup:report.testResourcesRemoved,observations:report.observations.map((item:any)=>item.name)},null,2));
}
