// Runs only as the synthetic ordinary user in the disconnected Pro fixture.
import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,copyFile,access} from 'node:fs/promises';import {createReadStream} from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';
const phase=process.argv[2];assert.ok(['install','inventory','repair','uninstall'].includes(phase));
const config=JSON.parse(await readFile('C:/MuLab/approved/package-config.json','utf8'));assert.match(config.caseId,/^[a-f0-9]{32}$/);
const directory='C:/MuLab/public/package-'+config.caseId,installed=directory+"/程序 O'Brien $ 测试/MuCodeSandbox Windows Preview",data=directory+'/independent-data',exe=installed+'/MuCodeSandbox Windows Preview.exe',stateFile=directory+'/state.json',nonce=randomBytes(32).toString('hex');
const progressFile=directory+'/'+phase+'-progress.json';await mkdir(directory,{recursive:true});await writeFile('C:/MuLab/public/package-'+phase+'-owner.json',JSON.stringify({pid:process.pid,nonce,caseId:config.caseId}));
const hash=async(file)=>{const sha=createHash('sha256');for await(const bytes of createReadStream(file))sha.update(bytes);return sha.digest('hex');};
async function execute(file,args,options={}){
 const child=spawn(file,args,{windowsHide:true,shell:false,env:{...process.env,MU_WINDOWS_INSTALL_TRACE:directory+'/installer-trace.log'},...options,stdio:['pipe','pipe','pipe']});
 const ended=once(child,'exit');ended.catch(()=>{});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b.toString());child.stderr.on('data',b=>stderr+=b.toString());child.stdin.end();
 await writeFile(progressFile,JSON.stringify({phase,pid:process.pid,childPid:child.pid,executable:file,at:new Date().toISOString()}));
 const [code,signal]=await ended;return {code,signal,stdout,stderr};
}
const ps=async(source,env={})=>{
 const prefix="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
 const result=await execute(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prefix+source,'utf16le').toString('base64')],{env:{...process.env,...env}});
 assert.equal(result.code,0,result.stderr);return result.stdout.trim();
};
const inventory=async()=>JSON.parse(await ps("& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:MU_INVENTORY_SCRIPT)))",{MU_INVENTORY_SCRIPT:config.tools+'/pro-programs-inventory.ps1'}));
const install=()=>execute(config.installer,['/S','/currentuser','/D='+installed.replaceAll('/','\\')],{windowsVerbatimArguments:true});
const appHashes=async()=>Object.fromEntries(await Promise.all(['MuCodeSandbox Windows Preview.exe','resources/app/package.json','resources/windows-runtime-manifest.json'].map(async name=>[name,await hash(installed+'/'+name)])));
const dataHashes=async()=>Object.fromEntries(await Promise.all(['credentials.dpapi','state.sqlite','retained.bin'].map(async name=>[name,await hash(data+'/'+name)])));
const profile=async(operation,state)=>{const result=await execute(installed+'/resources/node/node.exe',['--no-warnings',config.tools+'/pro-retained-profile.mjs',operation,installed,data,state.id,state.secret]);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/SYNTHETIC_PROFILE_OK/);};
const checks=[],pass=name=>checks.push({name,passed:true});let complete=false,error,details;
try{
 const initial=await inventory();assert.equal(initial.elevated,false);assert.equal(initial.userSid,config.userSid);
 if(phase==='install'){
  assert.equal(initial.registryPresent,false);assert.equal(initial.shellMatches.length,0);await assert.rejects(access(stateFile),{code:'ENOENT'});
  assert.equal((await install()).code,0);await access(exe);
  const actual=await inventory();assert.equal(actual.registryPresent,true);assert.equal(actual.displayVersion,config.version);assert.ok(actual.uninstallString.toLowerCase().includes(installed.replaceAll('/','\\').toLowerCase()));pass('The actual NSIS preview installs under the ordinary Pro user into a Unicode and special-character directory');
  const state={caseId:config.caseId,installed,data,id:randomUUID(),secret:'synthetic-pro-'+randomUUID()};await mkdir(data,{recursive:true});await writeFile(data+'/retained.bin',Buffer.from('Synthetic retained Pro data\0中文'));await profile('create',state);await profile('verify',state);state.applicationHashes=await appHashes();state.dataHashes=await dataHashes();await writeFile(stateFile,JSON.stringify(state));pass('The installed bundled runtime creates and decrypts an independent original DPAPI/SQLite profile');
  details={inventory:actual};assert.equal(actual.shellMatches.length,1,'Programs and Features does not list the actual registered preview');pass('The Windows Programs and Features namespace lists the real per-user installation');
 }else{
  const state=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(state.caseId,config.caseId);assert.deepEqual(await appHashes(),state.applicationHashes);assert.deepEqual(await dataHashes(),state.dataHashes);
  if(phase==='inventory'){details={inventory:initial};pass('The registered application and original encrypted data remain intact');}
  if(phase==='repair'){
   const busy=spawn(installed+'/resources/node/node.exe',['-e',"console.log('READY');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','ignore']});try{
    await once(busy.stdout,'data');const denied=await install();assert.notEqual(denied.code,0);assert.equal(busy.exitCode,null);assert.deepEqual(await appHashes(),state.applicationHashes);assert.deepEqual(await dataHashes(),state.dataHashes);pass('A live installed runtime refuses replacement without being terminated or changing original data');
   }finally{if(busy.exitCode===null&&busy.signalCode===null){const ended=once(busy,'exit');busy.kill();await ended;}}
   assert.equal((await install()).code,0);assert.deepEqual(await appHashes(),state.applicationHashes);assert.deepEqual(await dataHashes(),state.dataHashes);await profile('verify',state);state.dataHashes=await dataHashes();await writeFile(stateFile,JSON.stringify(state));details={inventory:await inventory()};pass('Same-version repair preserves application bytes and the original decryptable Pro profile');assert.equal(details.inventory.shellMatches.length,1);pass('The real Programs and Features entry remains listed after repair');
  }
  if(phase==='uninstall'){
   const names=(await readdir(installed)).filter(n=>/^Uninstall .*\.exe$/.test(n));assert.equal(names.length,1);
   const external=directory+'/verified-uninstaller.exe';await copyFile(installed+'/'+names[0],external);assert.equal(await hash(external),await hash(installed+'/'+names[0]));
   const result=await execute(external,['/S','/currentuser','_?='+installed.replaceAll('/','\\')],{windowsVerbatimArguments:true});assert.equal(result.code,0,result.stderr);
   const until=performance.now()+30000;while(await access(exe).then(()=>true,()=>false)){assert.ok(performance.now()<until,'Uninstaller still has application files');await delay(100);}
   const actual=await inventory();assert.equal(actual.registryPresent,false);assert.equal(actual.shellMatches.length,0);assert.deepEqual(await dataHashes(),state.dataHashes);details={inventory:actual,guiUninstallVerified:false};pass('The actual silent uninstaller removes the system entry and retains original independent encrypted data');
  }
 }
 complete=true;
}catch(failure){error={message:failure.message,code:failure.code??null};}
finally{await writeFile('C:/MuLab/public/package-'+phase+'-result.json',JSON.stringify({phase,pid:process.pid,nonce,caseId:config.caseId,complete,checks,details,error,guiUninstallVerified:false,aiWebsitesVisited:0},null,2));}
if(!complete)process.exitCode=1;
