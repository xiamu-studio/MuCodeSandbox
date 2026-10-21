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
 [CmdletBinding()]param([switch]$Online,[string]$Name,[switch]$NoRestart)
 if(-not $Online -or -not $NoRestart -or $Name -ne 'OpenSSH.Client~~~~0.0.1.0'){throw 'Unexpected servicing operation'}
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
