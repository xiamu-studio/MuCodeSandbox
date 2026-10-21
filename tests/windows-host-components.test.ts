import {test} from 'node:test';import assert from 'node:assert/strict';
import {WindowsHostComponents,hostReady,windowsHostStatusSchema} from '../server/platform/windows/host-components.ts';
import type {WindowsHostStatus} from '../shared/windows-host.ts';import type {HyperVBrokerClient} from '../server/platform/windows/broker.ts';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
const ready:WindowsHostStatus={edition:'Professional',build:'26200',architecture:'x64',supported:true,firmwareVirtualization:true,slat:true,hypervisorPresent:true,hyperV:'enabled',managementModule:true,vmmsRunning:true,sshCapability:'installed',sshClientPresent:true,restartRequired:false,ready:true,runtimeActive:true,canPrepare:true,operation:null};
test('Windows runtime readiness requires actual components, hardware state and an active VM session',()=>{
 assert.equal(hostReady(ready),true);for(const change of [{runtimeActive:false},{sshClientPresent:false},{hypervisorPresent:false},{managementModule:false},{vmmsRunning:false},{hyperV:'disabled' as const},{architecture:'arm64' as const},{supported:false},{restartRequired:true}])assert.equal(hostReady({...ready,...change}),false);
 assert.equal(hostReady({...ready,operation:{id:'bf7b763b-8b06-4d18-a603-98a3b0e4cfd9',status:'running',phase:'checking',changed:[],restartNeeded:false,errorCode:null}}),false);
});
test('The host UI contract strips private boot identifiers and rejects malformed status values',()=>{assert.equal((windowsHostStatusSchema.parse({...ready,bootId:'private local boot marker'}) as unknown as Record<string,unknown>).bootId,undefined);assert.equal(windowsHostStatusSchema.safeParse({...ready,hyperV:'guess'}).success,false);assert.equal(windowsHostStatusSchema.safeParse({...ready,firmwareVirtualization:'unknown'}).success,false);});
test('Host preparation sends only the fixed operation and never caller-selected features',async()=>{
 const calls:unknown[]=[],broker={call:async(action:string,parameters:unknown)=>{calls.push({action,parameters});return ready;}} as unknown as HyperVBrokerClient,host=new WindowsHostComponents(broker,()=>true);await host.prepare();assert.deepEqual(calls,[{action:'host-status',parameters:{}},{action:'prepare-host',parameters:{}}]);
});
test('An active managed guest blocks host servicing before any privileged request is sent',async()=>{let called=false;const host=new WindowsHostComponents({call:async()=>{called=true;return ready;}} as unknown as HyperVBrokerClient,()=>false);await assert.rejects(host.prepare(),{code:'HOST_PREPARATION_BUSY'});assert.equal(called,false);});
test('Pending reboots and unsupported requirements cannot trigger another component operation',async()=>{for(const status of [{...ready,restartRequired:true,canPrepare:false},{...ready,supported:false,canPrepare:false}]){const calls:string[]=[],host=new WindowsHostComponents({call:async(action:string)=>{calls.push(action);return status;}} as unknown as HyperVBrokerClient,()=>true);await assert.rejects(host.prepare(),{code:'HOST_REQUIREMENTS'});assert.deepEqual(calls,['host-status']);}});
test('Concurrent state refreshes share one actual privileged query',async()=>{let resolve!:(value:unknown)=>void,calls=0;const host=new WindowsHostComponents({call:async()=>{calls++;return new Promise(r=>{resolve=r;});}} as unknown as HyperVBrokerClient,()=>true),a=host.refresh(),b=host.refresh();resolve(ready);assert.deepEqual(await a,await b);assert.equal(calls,1);});

test('An underlying hypervisor does not start the newly installed Hyper-V service before its requested reboot',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-host-restart-')),task=path.join(directory,'host-components','job-'+randomUUID()+'.json');
 try{
  await mkdir(path.dirname(task));await mkdir(path.join(directory,'MuCodeSandbox-HyperVBroker-v1'));await writeFile(task,JSON.stringify({status:'starting',phase:'checking',processId:0,processStart:'',snapshot:null,changed:[],restartNeeded:false,bootId:'nested-boot',errorCode:null}));
  await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$env:ProgramData='${directory.replaceAll("'","''")}';$TaskFile='${task.replaceAll("'","''")}';$Action='prepare'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${path.resolve('scripts/windows/host-components.ps1').replaceAll("'","''")}',[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Invalid servicing source'}
$statements=@($ast.EndBlock.Statements);$start=-1;for($i=0;$i -lt $statements.Count;$i++){if($statements[$i].Extent.Text.StartsWith('if($Action -eq ''status'')')){$start=$i;break}};if($start -lt 0){throw 'Preparation entry missing'}
$script:queries=0
function Get-HostComponentStatus {$script:queries++;[ordered]@{supported=$true;firmwareVirtualization=$true;slat=$true;ready=$false;restartRequired=$false;hyperV=$(if($script:queries -eq 1){'disabled'}else{'enabled'});managementModule=$false;sshClientPresent=$true;hypervisorPresent=$true;vmmsRunning=$false;bootId='nested-boot'}}
function Enable-WindowsOptionalFeature {[CmdletBinding()]param([switch]$Online,[string]$FeatureName,[switch]$All,[switch]$NoRestart);if(-not $NoRestart -or $FeatureName -ne 'Microsoft-Hyper-V-All'){throw 'Unexpected feature request'};[pscustomobject]@{RestartNeeded=$true}}
function Set-Service {throw 'A not-yet-installed service must wait for reboot'}
function Start-Service {throw 'The underlying hypervisor cannot prove this service is ready'}
& ([ScriptBlock]::Create(($statements[$start..($statements.Count-1)] | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine))`),{timeoutMs:10000});
  const state=JSON.parse(await readFile(task,'utf8'));assert.equal(state.status,'completed');assert.equal(state.restartNeeded,true);assert.deepEqual(state.changed,['hyperv']);assert.equal(state.bootId,'nested-boot');
 }finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-host-restart-/);await rm(target,{recursive:true,force:true});}
});

test('A later SSH failure preserves completed Hyper-V changes and the pending reboot, even if the final status query fails',{skip:process.platform!=='win32'},async()=>{
 for(const queryFails of [false,true]){
  const directory=await mkdtemp(path.join(tmpdir(),'mu-host-job-')),task=path.join(directory,'host-components','job-'+randomUUID()+'.json');
  try{
   await mkdir(path.dirname(task));await mkdir(path.join(directory,'MuCodeSandbox-HyperVBroker-v1'));
   await writeFile(task,JSON.stringify({status:'starting',phase:'checking',processId:0,processStart:'',snapshot:null,changed:[],restartNeeded:false,bootId:'synthetic-boot',errorCode:null}));
   // Exercise the production preparation statements with fake servicing cmdlets.
   // The separate administrator entry check is outside this state-machine test.
   const script=`$ErrorActionPreference='Stop'
$env:ProgramData='${directory.replaceAll("'","''")}';$TaskFile='${task.replaceAll("'","''")}';$Action='prepare'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${path.resolve('scripts/windows/host-components.ps1').replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid production script'}
$statements=@($ast.EndBlock.Statements);$start=-1
for($i=0;$i -lt $statements.Count;$i++){if($statements[$i].Extent.Text.StartsWith('if($Action -eq ''status'')')){$start=$i;break}}
if($start -lt 0){throw 'Preparation entry not found'}
$script:queries=0
function Get-HostComponentStatus {
 $script:queries++;if($script:queries -gt 1 -and $${queryFails}){throw 'Synthetic status provider failure'}
 $pending=$script:queries -gt 1
 [ordered]@{supported=$true;firmwareVirtualization=$true;slat=$true;ready=$false;restartRequired=$pending;hyperV=$(if($pending){'pending'}else{'disabled'});managementModule=$false;sshClientPresent=$false;hypervisorPresent=$false;vmmsRunning=$false;bootId='synthetic-boot'}
}
function Enable-WindowsOptionalFeature {
 [CmdletBinding()]param([switch]$Online,[string]$FeatureName,[switch]$All,[switch]$NoRestart)
 if(-not $Online -or -not $All -or -not $NoRestart -or $FeatureName -ne 'Microsoft-Hyper-V-All'){throw 'Unexpected servicing operation'}
 [pscustomobject]@{RestartNeeded=$true}
}
function Add-WindowsCapability {
 [CmdletBinding()]param([switch]$Online,[string]$Name)
 if(-not $Online -or $Name -ne 'OpenSSH.Client~~~~0.0.1.0'){throw 'Unexpected servicing operation'}
 $saved=[IO.File]::ReadAllText($TaskFile) | ConvertFrom-Json
 [IO.File]::WriteAllText($TaskFile+'.before-ssh.json',($saved | ConvertTo-Json -Depth 8))
 throw [InvalidOperationException]::new('Synthetic SSH servicing failure')
}
& ([ScriptBlock]::Create(($statements[$start..($statements.Count-1)] | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine))`;
   await assert.rejects(run(powershellPath(),powershellArgs(script),{timeoutMs:10000}),{code:'PROCESS_FAILED'});
   const beforeSsh=JSON.parse(await readFile(task+'.before-ssh.json','utf8')),after=JSON.parse(await readFile(task,'utf8'));
   for(const state of [beforeSsh,after]){assert.deepEqual(state.changed,['hyperv']);assert.equal(state.restartNeeded,true);assert.equal(state.bootId,'synthetic-boot');}
   assert.equal(after.status,'failed');assert.equal(after.errorCode,-2146233079);
   if(!queryFails){assert.equal(after.snapshot.hyperV,'pending');assert.equal(after.snapshot.restartRequired,true);}
  }finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-host-job-/);await rm(target,{recursive:true,force:true});}
 }
});

test('Production servicing arguments exist on the installed Windows DISM cmdlets',{skip:process.platform!=='win32'},async()=>{
 await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${path.resolve('scripts/windows/host-components.ps1').replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid servicing source'}
$commands=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -in @('Enable-WindowsOptionalFeature','Add-WindowsCapability')},$true))
if($commands.Count -ne 2){throw 'Expected both fixed servicing operations'}
foreach($command in $commands){
 $metadata=Get-Command -Name $command.GetCommandName() -Module Dism -CommandType Cmdlet
 foreach($parameter in @($command.CommandElements | Where-Object {$_ -is [Management.Automation.Language.CommandParameterAst]})){
  if(-not $metadata.Parameters.ContainsKey($parameter.ParameterName)){throw ('Unsupported DISM argument: '+$metadata.Name+' -'+$parameter.ParameterName)}
 }
}`),{timeoutMs:15000});
});

test('A silent capability installation failure cannot produce a completed preparation receipt',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-host-incomplete-')),task=path.join(directory,'host-components','job-'+randomUUID()+'.json');
 try{
  await mkdir(path.dirname(task));await mkdir(path.join(directory,'MuCodeSandbox-HyperVBroker-v1'));
  await writeFile(task,JSON.stringify({status:'starting',phase:'checking',processId:0,processStart:'',snapshot:null,changed:[],restartNeeded:false,bootId:'unchanged-boot',errorCode:null}));
  await assert.rejects(run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$env:ProgramData='${directory.replaceAll("'","''")}';$TaskFile='${task.replaceAll("'","''")}';$Action='prepare'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${path.resolve('scripts/windows/host-components.ps1').replaceAll("'","''")}',[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Invalid servicing source'}
$statements=@($ast.EndBlock.Statements);$start=-1;for($i=0;$i -lt $statements.Count;$i++){if($statements[$i].Extent.Text.StartsWith('if($Action -eq ''status'')')){$start=$i;break}};if($start -lt 0){throw 'Preparation entry missing'}
function Get-HostComponentStatus {[ordered]@{supported=$true;firmwareVirtualization=$true;slat=$true;ready=$false;restartRequired=$false;hyperV='enabled';managementModule=$true;sshClientPresent=$false;sshCapability='missing';hypervisorPresent=$true;vmmsRunning=$true;bootId='unchanged-boot'}}
function Add-WindowsCapability {[CmdletBinding()]param([switch]$Online,[string]$Name);[pscustomobject]@{RestartNeeded=$false}}
& ([ScriptBlock]::Create(($statements[$start..($statements.Count-1)] | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine))`),{timeoutMs:10000}),{code:'PROCESS_FAILED'});
  const state=JSON.parse(await readFile(task,'utf8'));assert.equal(state.status,'failed');assert.equal(state.restartNeeded,false);assert.equal(state.snapshot.sshClientPresent,false);assert.equal(state.bootId,'unchanged-boot');
 }finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-host-incomplete-/);await rm(target,{recursive:true,force:true});}
});
