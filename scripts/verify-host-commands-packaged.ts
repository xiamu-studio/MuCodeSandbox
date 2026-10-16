import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { SING_BOX_ARCHIVE, SING_BOX_SHA256 } from '../server/transparent-network.ts';
import type { BridgeGrant, Environment } from '../shared/types.ts';

const root=path.resolve(import.meta.dirname,'..'),owned=await mkdtemp(path.join(homedir(),'.mu-hcp-'));
const dataDir=path.join(owned,'private'),bundle=path.join(root,'release/boot-capture-candidate/mac-arm64/MuCodeSandbox.app'),appRoot=path.join(bundle,'Contents/Resources/app');
const artifacts=path.join(root,'test-results',`host-commands-packaged-${Date.now()}`);await mkdir(artifacts,{mode:0o700});
const project=path.join(owned,'project');await mkdir(project);
process.env.MU_LIMA_PATH??=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const runtime=new LimaRuntime(dataDir),hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const report:Record<string,any>={passed:false,startedAt:new Date().toISOString(),accountFree:true,paidModelCalls:0,actualVmTested:true,actualElectronPackageTested:true,freshDataDirectory:true,
  scope:'Actual Electron package UI/API, fresh strict VM, packaged native bridge/profile, real guest Unix-socket client and active-command application shutdown; no arbitrary shell or whole-project acceptance',
  package:{bundle},artifactsDirectory:artifacts,stages:[],captures:[]};
let application:ElectronApplication|undefined,page:Page|undefined,current:Environment|undefined,capturing=false;
const errors:string[]=[];
async function until(check:()=>boolean|Promise<boolean>,timeout=30_000){const end=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<end,'Packaged host command observation timed out');await delay(100);}}
async function stage(name:string){report.stages.push({name,at:new Date().toISOString()});console.log(name);}
async function api(endpoint:string,method='GET',body?:unknown):Promise<any>{return page!.evaluate(async({endpoint,method,body})=>{const response=await fetch(`/api${endpoint}`,{method,headers:{Authorization:`Bearer ${(window as any).__MU_CONFIG__.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});const value=await response.json();if(!response.ok)throw new Error(value.error);return value;},{endpoint,method,body});}
async function finish(job:{id:string}){let result:any;await until(async()=>{const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>80*2**30);result=(await api('/snapshot')).jobs.find((item:any)=>item.id===job.id);return result&&result.status!=='running';},950_000);assert.equal(result.status,'succeeded',result.message);current=(await api('/snapshot')).environments.find((item:Environment)=>item.id===current!.id);}
const guest=(args:string[])=>runtime.guest(current!,args,{timeoutMs:25_000});
const admin=(args:string[])=>runtime.management(current!,args,{timeoutMs:30_000,maxBytes:32_000_000});
const grants=()=>api(`/environments/${current!.id}/bridge`) as Promise<BridgeGrant[]>;
async function captureStart(){await admin(['sudo','systemd-run','--quiet','--unit=mu-host-command-package-capture','/usr/bin/tcpdump','--immediate-mode','-ni','any','-Q','out','-U','-s','128','-w','/run/mu-host-command-package.pcap']);capturing=true;}
async function decodeCapture(name:string,bytes:Buffer,allowProxy=true){
  const file=path.join(artifacts,`${name}.pcap`);await writeFile(file,bytes,{mode:0o600});
  const gateway=(await admin(['ip','-4','route','show','default'])).match(/default via (\S+)/)![1];
  const decoded=await run('/usr/sbin/tcpdump',['-nn','-r',file,'ifindex 2 and outbound and (ip or ip6)']);
  const physical=decoded.split('\n').filter(line=>/^\d\d:\d\d:\d\d\.\d+\s/.test(line));assert.ok(physical.length>0);
  const bad=physical.filter(line=>/\sIP6\s/.test(line)||!(line.includes(`.22 > ${gateway}.`)||/\.68 > [0-9.]+\.67:/.test(line)||(allowProxy&&line.includes(` > ${gateway}.9:`))));assert.deepEqual(bad,[]);
  const approvedProxy=physical.filter(line=>line.includes(` > ${gateway}.9:`)).length;
  report.captures.push({name,bytes:bytes.length,sha256:hash(bytes),gateway,physicalPackets:physical.length,approvedProxy,allowProxy,proxyPort:9,unapproved:0});
}
async function captureStop(name:string){await admin(['sudo','systemctl','stop','mu-host-command-package-capture.service']);capturing=false;await decodeCapture(name,Buffer.from((await admin(['sudo','base64','-w0','/run/mu-host-command-package.pcap'])).trim(),'base64'));}
async function screenshot(name:string){
  const value=await application!.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setOpacity(0);window.showInactive();try{await new Promise(resolve=>setTimeout(resolve,150));const image=await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Native capture timed out')),15_000))]);const bitmap=image.toBitmap(),colors=new Set<number>();for(let i=0;i<bitmap.length;i+=4)colors.add(bitmap.readUInt32LE(i));return {png:image.toPNG().toString('base64'),size:image.getSize(),colors:colors.size};}finally{window.hide();window.setOpacity(1);}});
  assert.ok(value.colors>32);await writeFile(path.join(artifacts,`${name}.png`),Buffer.from(value.png,'base64'),{mode:0o600});return {size:value.size,colors:value.colors};
}
async function processes(){return (await run('/bin/ps',['-axo','pid=,ppid=,pgid=,comm='])).split('\n').map(line=>line.trim().split(/\s+/)).map(parts=>({pid:Number(parts[0]),parent:Number(parts[1]),group:Number(parts[2]),command:parts.slice(3).join(' ')}));}
try{
  const disk=await statfs(owned);assert.ok(disk.bavail*disk.bsize>100*2**30);
  await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);const signature=await run('/usr/bin/codesign',['-d','--verbose=4',bundle]);assert.match(signature,/Signature=adhoc/);report.package.cdHash=signature.match(/^CDHash=(.+)$/m)?.[1];assert.equal(report.package.cdHash,'b0cd06dd921a9ba759336fb39c8cb6e40e22fde4');
  assert.ok(process.env.MU_TEST_SING_BOX_CACHE,'Provide the existing verified proxy cache to avoid repeat downloads');assert.equal(hash(await readFile(process.env.MU_TEST_SING_BOX_CACHE)),SING_BOX_SHA256);const cache=path.join(dataDir,'tools/sing-box');await mkdir(cache,{recursive:true});await copyFile(process.env.MU_TEST_SING_BOX_CACHE,path.join(cache,SING_BOX_ARCHIVE));report.verifiedProxyCacheReused=true;
  await stage('Testing actual packaged native bridge and sandbox profile');
  const nativeTests=await run(process.execPath,['--test',path.join(root,'tests/host-commands.test.ts'),path.join(root,'tests/bridge.test.ts')],{env:{...process.env,MU_TEST_HOST_COMMAND_ROOT:appRoot},timeoutMs:30_000});await writeFile(path.join(artifacts,'packaged-native-tests.txt'),nativeTests,{mode:0o600});report.packagedNativeTestsPassed=true;
  const git='/Library/Developer/CommandLineTools/usr/bin/git',env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'},command=(args:string[])=>run(git,['-C',project,...args],{env});
  await command(['-c','init.templateDir=','init','-q']);await writeFile(path.join(project,'notes.txt'),'MU_PACKAGED_HOST_ORIGINAL\n');await command(['add','notes.txt']);await command(['-c','user.name=Mu test','-c','user.email=mu@example.invalid','commit','--no-gpg-sign','-qm','MU_PACKAGED_HOST_COMMIT']);await writeFile(path.join(project,'notes.txt'),'MU_PACKAGED_HOST_CHANGED\n');
  application=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/MuCodeSandbox'),args:[],chromiumSandbox:true,env:{...process.env,MU_DATA_DIR:dataDir,MU_DESKTOP_USER_DATA_DIR:path.join(owned,'desktop'),MU_TEST_CLAUDE:'0'},timeout:60_000});
  const hide=()=>void application!.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.webContents.setBackgroundThrottling(false);window.hide();}}).catch(()=>{});application.on('window',hide);hide();page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.getByRole('heading',{name:'MuCodeSandbox',exact:true}).waitFor();
  report.application=await application.evaluate(({app})=>({packaged:app.isPackaged,appPath:app.getAppPath(),pid:process.pid,renderers:app.getAppMetrics().filter(item=>item.type==='Tab').map(item=>({pid:item.pid,sandboxed:item.sandboxed}))}));assert.ok(report.application.packaged&&report.application.renderers.length>0&&report.application.renderers.every((item:any)=>item.sandboxed));
  report.network={mode:'http',host:'127.0.0.1',port:9,strict:true,transparent:false,noProxy:''};
  current=await api('/environments','POST',{name:'Packaged host command acceptance',cpus:2,memoryGiB:2,diskGiB:10,network:report.network});
  for(const [key,value] of Object.entries(report.network))assert.equal((current!.network as any)[key],value);
  await stage('Checking actual native command controls before starting VM');await page.getByRole('button',{name:'Packaged host command acceptance Linux 沙箱',exact:true}).click();await page.getByRole('button',{name:'宿主授权',exact:true}).click();for(const name of ['Git 状态','Git 文件差异','Git 最近提交'])assert.equal(await page.getByRole('checkbox',{name,exact:true}).isChecked(),false);
  await stage('Starting fresh strict VM through the actual package');await finish(await api(`/environments/${current!.id}/actions/start`,'POST'));
  const before=await api(`/environments/${current!.id}/network/protection`);assert.ok(before.active&&before.integrity==='verified');report.before=before;
  await decodeCapture('first-boot',Buffer.from((await admin(['sudo','base64','-w0','/var/log/mucodesandbox/boot-network.pcap'])).trim(),'base64'),true);await captureStart();
  await page.getByRole('textbox',{name:'授权的本机目录'}).fill(project);await page.getByRole('checkbox',{name:'Git 状态',exact:true}).check();await page.getByRole('checkbox',{name:'Git 文件差异',exact:true}).check();const granting=page.waitForResponse(value=>new URL(value.url()).pathname===`/api/environments/${current!.id}/bridge`&&value.request().method()==='POST');await page.getByRole('button',{name:'授权目录',exact:true}).click();const response=await granting;assert.equal(response.status(),202);await finish(await response.json());
  const grant=(await grants())[0];assert.deepEqual(grant.commands,['git-status','git-diff']);assert.equal(grant.writable,false);assert.ok(grant.guestReady);await until(async()=>await page!.getByText(project,{exact:true}).count()>0);
  const listing=JSON.parse(await guest(['mu-host',grant.id,'list']));assert.ok(listing.some((item:any)=>item.name==='notes.txt'));
  assert.deepEqual(JSON.parse(await guest(['mu-host',grant.id,'list'])),listing);
  await writeFile(path.join(project,'added.txt'),'MU_PACKAGED_ADDED');
  assert.ok(JSON.parse(await guest(['mu-host',grant.id,'list'])).some((item:any)=>item.name==='added.txt'));report.repeatedDirectoryListings=true;
  await stage('Executing real guest-to-packaged-host commands and rejecting additional authority');
  const status=JSON.parse(await guest(['mu-host',grant.id,'command','git-status'])),diff=JSON.parse(await guest(['mu-host',grant.id,'command','git-diff']));assert.equal(status.exitCode,0,status.output);assert.match(status.output,/ M notes.txt/);assert.equal(diff.exitCode,0,diff.output);assert.match(diff.output,/MU_PACKAGED_HOST_CHANGED/);
  await assert.rejects(guest(['mu-host',grant.id,'command','git-log']),/未授权/);await assert.rejects(guest(['mu-host',grant.id,'command','git-status','--help']),/Usage/);
  const extra=await guest(['python3','-c',`import sys,os,json,socket,http.client
with open(os.path.expanduser('~/.config/mucodesandbox/bridge-'+sys.argv[1]+'.json')) as f: c=json.load(f)
class Connection(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(10);self.sock.connect(c['socket'])
h=Connection(c['host']);h.request('POST','/capability',json.dumps({'operation':'command','command':'git-status','args':['--help']}),{'Authorization':'Bearer '+c['token'],'Content-Type':'application/json'});print(h.getresponse().status)`,grant.id]);assert.equal(extra.trim(),'400');
  report.commands={status,diff,unapprovedRejected:true,extraArgumentsRejected:true,hostSchemaRejected:true};
  const after=await api(`/environments/${current!.id}/network/protection`);assert.ok(after.active&&after.integrity==='verified');assert.equal(after.firewallHash,before.firewallHash);report.after=after;
  report.desktopScreenshot=await screenshot('desktop-commands');
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(390,600);window.setContentSize(390,844);});await until(async()=>await page!.evaluate(()=>innerWidth===390));report.mobileBounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(report.mobileBounds.scroll<=report.mobileBounds.width);report.mobileScreenshot=await screenshot('mobile-commands');
  await page.getByRole('button',{name:'撤销目录授权',exact:true}).click();await until(async()=>(await grants()).length===0);await assert.rejects(guest(['mu-host',grant.id,'command','git-status']));report.uiRevocationRejectedOldToken=true;
  await finish(await api(`/environments/${current!.id}/bridge`,'POST',{root:project,writable:false,minutes:1,commands:['git-log']}));const second=(await grants())[0];assert.equal(JSON.parse(await guest(['mu-host',second.id,'command','git-log'])).exitCode,0);
  await captureStop('commands');await finish(await api(`/environments/${current!.id}/actions/stop`,'POST'));assert.deepEqual(await grants(),[]);report.environmentStopRevokedCommands=true;
  await stage('Closing the package while a real host Git command is blocked');await finish(await api(`/environments/${current!.id}/actions/start`,'POST'));await captureStart();
  await finish(await api(`/environments/${current!.id}/bridge`,'POST',{root:project,writable:false,minutes:1,commands:['git-status']}));const blockedGrant=(await grants())[0];
  const audit=JSON.stringify(await api(`/logs?environmentId=${current!.id}`));assert.ok(!audit.includes('MU_PACKAGED_HOST_CHANGED')&&!audit.includes('MU_PACKAGED_HOST_COMMIT'));report.auditContainsNoOutput=true;
  await rm(path.join(project,'.git/index'));await run('/usr/bin/mkfifo',[path.join(project,'.git/index')]);
  const helper=(await processes()).find(item=>item.parent===report.application.pid&&item.command.endsWith('/native/bin/mu-host-bridge'));assert.ok(helper&&helper.pid===helper.group);
  const outcome=guest(['mu-host',blockedGrant.id,'command','git-status']).then(value=>({value,error:undefined}),error=>({value:undefined,error:String(error)}));let members:any[]=[];
  await until(async()=>{members=(await processes()).filter(item=>item.group===helper.group);return members.some(item=>item.command.endsWith('/git'));});
  const closingAt=Date.now();await application.close();application=undefined;const elapsedMs=Date.now()-closingAt,result=await outcome;assert.ok(result.error);assert.ok(elapsedMs<30_000);await until(async()=>!(await processes()).some(item=>item.group===helper.group));
  report.activeCommandShutdown={completed:true,elapsedMs,helper,members,guestCommandRejected:true};await captureStop('shutdown');assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=(error as Error).stack;process.exitCode=1;}
finally{
  if(capturing)await admin(['sudo','systemctl','stop','mu-host-command-package-capture.service']).catch(()=>{});
  await application?.close().catch(error=>{report.closeError=String(error);report.passed=false;process.exitCode=1;});
  try{for(const row of await runtime.list()){if(row.status==='Running')await runtime.command(['stop',row.name],{timeoutMs:120_000});await runtime.command(['delete',row.name],{timeoutMs:120_000});}assert.deepEqual(await runtime.list(),[]);await rm(owned,{recursive:true});report.testResourcesRemoved=true;}
  catch(error){report.cleanupError=String(error);report.retainedTestRoot=owned;report.passed=false;process.exitCode=1;}
  report.uiErrors=errors;report.sources=Object.fromEntries(await Promise.all(['scripts/verify-host-commands-packaged.ts','tests/host-commands.test.ts','tests/bridge.test.ts','server/host-bridge.ts','server/bridge-guest.ts','server/service.ts','shared/types.ts','src/BridgePanel.tsx','native/BridgeHelper.swift','native/probes/host-command-boundary.c','native/host-command.sb'].map(async file=>[file,hash(await readFile(path.join(root,file)))])));
  report.package.modules=Object.fromEntries(await Promise.all(['dist-server/server/host-bridge.js','dist-server/server/bridge-guest.js','dist-server/server/service.js','dist-server/shared/types.js','native/bin/mu-host-bridge','native/bin/host-command.sb'].map(async file=>[file,hash(await readFile(path.join(appRoot,file)))])));
  report.artifacts=Object.fromEntries(await Promise.all((await readdir(artifacts)).map(async file=>[file,hash(await readFile(path.join(artifacts,file)))])));report.finishedAt=new Date().toISOString();await writeFile(path.join(root,'test-results/host-commands-packaged.json'),JSON.stringify(report,null,2),{mode:0o600});await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,error:report.error,captures:report.captures,shutdown:report.activeCommandShutdown?.elapsedMs,cleanup:report.testResourcesRemoved},null,2));
}
