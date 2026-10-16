/** Read current VM browser metadata. No navigation, account access, or profile writes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {DevTools} from '../server/guest-browser.ts';
import {CURRENT_BROWSER_RELEASE} from '../server/browser-releases.ts';

const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const dataDir='/Users/staff/.mucodesandbox',instance='mu-ee85e6f8043b4d02',id='ee85e6f8-043b-4d02-be6e-7a0683c4bde8';
const output=path.join(root,'test-results/browser-observable-audit');
await mkdir(output,{recursive:true,mode:0o700});
const runId=randomUUID(),file=path.join(output,runId+'.json');
const info=JSON.parse(await readFile(path.join(dataDir,'service-info.json'),'utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('Desktop session unavailable');
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const headers={Authorization:`Bearer ${config.token}`};
async function get(route:string){const response=await fetch(info.url+route,{headers});if(!response.ok)throw new Error('Read-only desktop request failed: '+response.status);return response.json();}
const snapshot=await get('/api/snapshot'),environment=snapshot.environments.find((e:any)=>e.id===id);
assert.ok(environment?.state==='running'&&environment.browserRunning);
const before=await get(`/api/environments/${id}/network/protection`);
assert.ok(before.active&&before.integrity==='verified');
// Identify only the existing tunnel for this VM; never print process command lines or URLs.
const ps=(await exec('/bin/ps',['-ax','-o','pid=','-o','command='],{maxBuffer:2*1024*1024})).stdout;
const transports=ps.split('\n').filter(line=>line.includes(`${dataDir}/lima/${instance}/ssh.config`)&&line.includes('/usr/bin/ssh '));
const sockets=transports.map(line=>line.match(/-L\s+(\/tmp\/mu-view-[^\s:]+\/cdp\.sock):127\.0\.0\.1:9222\b/)?.[1]).filter(Boolean) as string[];
assert.equal(new Set(sockets).size,1,'One existing VM browser tunnel required');
const socketPath=sockets[0],directory=await stat(path.dirname(socketPath)),socket=await stat(socketPath);
assert.equal(directory.uid,process.getuid!());assert.equal(directory.mode&0o777,0o700);
assert.equal(socket.uid,process.getuid!());assert.equal(socket.mode&0o777,0o700);

const guestScript=String.raw`import pathlib,hashlib,json,os,subprocess
rows=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  exe=(p/'exe').resolve();args=(p/'cmdline').read_bytes().decode(errors='replace').split(chr(0))
  # Chromium child processes may put the entire process title in argv[0].
  # Select the real browser by its explicit debugging-port argument, not merely missing --type argv entries.
  if str(exe).startswith('/opt/mucodesandbox/chromium-') and exe.name=='chrome' and any(a.startswith('--remote-debugging-port=') for a in args) and not any('--type=' in a for a in args):
   uid=int(next(l for l in (p/'status').read_text().splitlines() if l.startswith('Uid:')).split()[1])
   digest=hashlib.sha256()
   with exe.open('rb') as f:
    header=f.read(20);digest.update(header)
    for chunk in iter(lambda:f.read(1048576),b''):digest.update(chunk)
   rows.append({'pid':int(p.name),'uid':uid,'binarySHA256':digest.hexdigest(),'elfMachine':int.from_bytes(header[18:20],'little'),
     'version':subprocess.check_output([str(exe),'--version'],text=True).strip(),
     'flagNames':sorted({a.split('=')[0] for a in args if a.startswith('--')}),
     'remoteDebugPort':next((a.split('=',1)[1] for a in args if a.startswith('--remote-debugging-port=')),None),
     'customAutomationSuppression':any(a.startswith('--disable-blink-features=') and 'AutomationControlled' in a for a in args),
     'userAgentOverride':any(a.startswith('--user-agent=') for a in args)})
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
print(json.dumps({'checkedAtUtc':__import__('time').strftime('%Y-%m-%dT%H:%M:%SZ',__import__('time').gmtime()),'unameMachine':os.uname().machine,'processes':rows}))`;
const guest=JSON.parse((await exec(path.join(dataDir,'tools/lima/bin/limactl'),['shell',instance,'sudo','python3','-c',guestScript],
 {env:{...process.env,LIMA_HOME:path.join(dataDir,'lima')},timeout:20000,maxBuffer:1024*1024})).stdout);
assert.equal(guest.processes.length,1);
const binary=guest.processes[0];assert.equal(binary.uid,502);
const expression=`(async()=>{
 const fields=['webdriver','platform','userAgent','language','languages','hardwareConcurrency','deviceMemory'];
 const descriptors=Object.fromEntries(fields.map(k=>{let p=navigator,d;while(p&&!d){d=Object.getOwnPropertyDescriptor(p,k);p=Object.getPrototypeOf(p);}
 return [k,{own:Object.prototype.hasOwnProperty.call(navigator,k),getter:d?.get?Function.prototype.toString.call(d.get):null}];}));
 let hints=null,hintsError=null;try{hints=navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList','model','wow64']):null;}catch(e){hintsError=String(e?.name??'Error');}
 return {webdriver:navigator.webdriver,platform:navigator.platform,userAgent:navigator.userAgent,language:navigator.language,languages:[...navigator.languages],
 timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory??null,
 clientHints:hints,hintsError,screen:{width:screen.width,height:screen.height,devicePixelRatio:devicePixelRatio},descriptors};
})()`;
const tools=await DevTools.open(socketPath),pages:any[]=[];
let version:any,targetCountBefore=0,targetCountAfter=0;
try{
 version=await tools.send('Browser.getVersion');
 const targets=await tools.send('Target.getTargets'),pageTargets=targets.targetInfos.filter((t:any)=>t.type==='page');
 targetCountBefore=pageTargets.length;assert.ok(pageTargets.length>0&&pageTargets.length<=8,'Bounded existing pages only');
 for(const target of pageTargets){
  const attached=await tools.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  try{
   const frame=(await tools.send('Page.getFrameTree',{},attached.sessionId)).frameTree.frame.id;
   const world=await tools.send('Page.createIsolatedWorld',{frameId:frame,worldName:'MuReadOnlyAudit-'+runId},attached.sessionId);
   const observed:any={index:pages.length+1};
   for(const [name,context] of [['page',undefined],['isolated',world.executionContextId]] as const){
    const result=await tools.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:false,...(context?{contextId:context}:{})},attached.sessionId);
    if(result.exceptionDetails)throw new Error('Metadata sample exception');
    observed[name]=result.result.value;
   }
   pages.push(observed);
  }finally{await tools.send('Target.detachFromTarget',{sessionId:attached.sessionId}).catch(()=>{});}
 }
 targetCountAfter=(await tools.send('Target.getTargets')).targetInfos.filter((t:any)=>t.type==='page').length;
}finally{tools.close();}
const after=await get(`/api/environments/${id}/network/protection`),afterSnapshot=await get('/api/snapshot');
const afterEnvironment=afterSnapshot.environments.find((e:any)=>e.id===id);
const report={checkedAt:new Date().toISOString(),runId,app:{pid:info.pid,version:snapshot.system.version,buildId:snapshot.system.application?.buildId},
 environment:{id,name:environment.name,identity:environment.identity},guest,
 browser:{product:version.product,revision:version.revision,userAgent:version.userAgent,jsVersion:version.jsVersion},pages,
 counts:{pagesBefore:targetCountBefore,pagesAfter:targetCountAfter,sampled:pages.length},
 protection:{before:{active:before.active,integrity:before.integrity,firewallHash:before.firewallHash},after:{active:after.active,integrity:after.integrity,firewallHash:after.firewallHash,leaseActive:after.leaseActive,dnsGuardActive:after.dnsGuardActive}},
 browserStillRunning:afterEnvironment?.browserRunning===true,
 approvedArchive:{version:CURRENT_BROWSER_RELEASE.version,sha256:CURRENT_BROWSER_RELEASE.sha256},
 scriptSHA256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
 expression,readOnlyScope:'Existing pages only; read navigator, Client Hints, screen and metadata in default / isolated JS worlds. No navigation, account data, page titles, URLs, cookies, network interception, DOM modification, fingerprint spoofing, new tabs or browser launch. Fresh isolated JS world creation is diagnostic only; this session was detached.'};
await writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
await writeFile(path.join(output,'latest.json'),JSON.stringify({file:path.basename(file),runId}),{mode:0o600});
console.log(JSON.stringify({file,product:report.browser.product,pages:pages.map(p=>({index:p.index,webdriver:p.isolated.webdriver,
 platform:p.isolated.platform,hints:p.isolated.clientHints,language:p.isolated.language,timezone:p.isolated.timezone})),guest:report.guest,
 protection:report.protection,browserStillRunning:report.browserStillRunning},null,2));
