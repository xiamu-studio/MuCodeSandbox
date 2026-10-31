import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WindowsOverviewReadings,parseWindowsMetrics,parseWindowsBrowserVersion} from '../server/platform/windows/overview-readings.ts';
import {WINDOWS_CHROME} from '../server/platform/windows/browser-assets.ts';
import {WINDOWS_BROWSER_CANDIDATE} from '../server/platform/windows/browser-releases.ts';
import {WINDOWS_BROWSER_OBSERVATION_SCRIPT} from '../server/platform/windows/overview-readings.ts';
import type {WindowsManager} from '../server/platform/windows/manager.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
const metrics={cpuPercent:8,memoryUsedMiB:512,memoryTotalMiB:4096,diskUsedGiB:7,diskTotalGiB:30,uptimeSeconds:5040};
test('Guest metrics reject impossible, nonfinite and extra host readings',()=>{
 assert.deepEqual(parseWindowsMetrics(JSON.stringify(metrics)),metrics);
 for(const value of [{...metrics,cpuPercent:101},{...metrics,memoryUsedMiB:4097},{...metrics,diskTotalGiB:0},{...metrics,uptimeSeconds:-1},{...metrics,hostCpus:16}])assert.throws(()=>parseWindowsMetrics(JSON.stringify(value)));
 assert.throws(()=>parseWindowsMetrics('host warning\n'+JSON.stringify(metrics)));
});
test('Browser version confirms the installation data and never trusts an unverified executable version',()=>{
 const valid={version:1,state:'verified',issue:null,recordedVersion:WINDOWS_CHROME.version};assert.equal(parseWindowsBrowserVersion(JSON.stringify(valid)).recoveryRequired,false);
 for(const [state,issue] of [['missing','missing'],['untrusted','record'],['untrusted','unsafe'],['untrusted','changed'],['untrusted','unapproved'],['untrusted','unreadable']]){const value=parseWindowsBrowserVersion(JSON.stringify({version:1,state,issue,recordedVersion:'154.0.1.2'}));assert.equal(value.installedVersion,null);assert.equal(value.recordedVersion,'154.0.1.2');assert.equal(value.installationState,state);assert.equal(value.recoveryRequired,true);assert.equal(value.updateAvailable,false);assert.ok(value.installationIssue);}
 for(const value of [{...valid,recordedVersion:'154.0.1.2'},{...valid,issue:'changed'},{...valid,extra:true},{...valid,version:'1'},{...valid,recordedVersion:'155.0.1.2<script>'},{...valid,state:'missing'},{...valid,state:'untrusted'},'Google Chrome '+WINDOWS_CHROME.version])assert.throws(()=>parseWindowsBrowserVersion(typeof value==='string'?value:JSON.stringify(value)),{code:'BROWSER_VERSION_UNREADABLE'});
});

test('Browser installation detection uses a bounded Python read and never runs the browser',async()=>{
 const session={state:'active'},sessions=new Map([['id',session]]);let executed=0;const manager={sessions,assertAccess:async()=>({id:'id'}),profile:async()=>({})} as unknown as WindowsManager;
 const guest=(async(_config,command,options)=>{executed++;assert.deepEqual(command,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_OBSERVATION_SCRIPT]);assert.equal(options?.timeoutMs,20000);assert.equal(options?.maxBytes,16384);return JSON.stringify({version:1,state:'missing',issue:'missing',recordedVersion:null})+'\n'+JSON.stringify({version:1,state:'unrecorded',selectedVersion:WINDOWS_CHROME.version,recordedVersion:null,issue:null});}) as HyperVRuntime['guest'];
 const result=await new WindowsOverviewReadings(manager,guest).browserVersion('id');assert.equal(executed,1);assert.equal(result.installedVersion,null);assert.equal(result.installationState,'missing');assert.equal(result.profileCompatibility?.state,'unrecorded');
});

test('A replaced protection session cannot publish a late browser installation result',async()=>{
 const session={state:'active'},sessions=new Map([['id',session]]);let finish!:(v:string)=>void;const manager={sessions,assertAccess:async()=>({id:'id'}),profile:async()=>({})} as unknown as WindowsManager;
 const guest=(async()=>new Promise<string>(resolve=>{finish=resolve;})) as HyperVRuntime['guest'];const reading=new WindowsOverviewReadings(manager,guest).browserVersion('id');while(!finish)await new Promise(resolve=>setImmediate(resolve));sessions.set('id',{state:'active'});finish(JSON.stringify({version:1,state:'verified',issue:null,recordedVersion:WINDOWS_CHROME.version}));await assert.rejects(reading,{code:'CONFIGURATION_CHANGED'});
});
test('Overview discards an in-flight guest result after the guard session is retired or replaced',async()=>{
 for(const replace of [false,true]){
  const session={state:'active'},sessions=new Map([['id',session]]);let finish!:(value:string)=>void;
  const manager={sessions,assertAccess:async()=>({id:'id'}),profile:async()=>({})} as unknown as WindowsManager;
  const guest=(async()=>new Promise<string>(resolve=>{finish=resolve;})) as HyperVRuntime['guest'];
  const reading=new WindowsOverviewReadings(manager,guest).metrics('id');while(!finish)await new Promise(resolve=>setImmediate(resolve));
  if(replace)sessions.set('id',{state:'active'});else session.state='failed';finish(JSON.stringify(metrics));
  await assert.rejects(reading,/环境已变化/);
 }
});
test('A denied guard never executes a guest read or substitutes host metrics',async()=>{
 let executed=false;const manager={assertAccess:async()=>{throw Error('guard unavailable');}} as unknown as WindowsManager;
 const guest=(async()=>{executed=true;return JSON.stringify(metrics);}) as HyperVRuntime['guest'];
 await assert.rejects(new WindowsOverviewReadings(manager,guest).metrics('id'),/guard unavailable/);assert.equal(executed,false);
});
test('A single guarded observation distinguishes approved installation from incompatible restored data',async()=>{
 const session={state:'active'},sessions=new Map([['id',session]]),manager={sessions,assertAccess:async()=>({id:'id'}),profile:async()=>({})} as unknown as WindowsManager;
 const binary={version:1,state:'verified',issue:null,recordedVersion:WINDOWS_CHROME.version},profile={version:1,state:'newer',selectedVersion:WINDOWS_CHROME.version,recordedVersion:'156.0.0.0',issue:null};let calls=0,reply=JSON.stringify(binary)+'\n'+JSON.stringify(profile);
 const reader=new WindowsOverviewReadings(manager,(async(_c,command)=>{calls++;assert.deepEqual(command,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_OBSERVATION_SCRIPT]);return reply;}) as HyperVRuntime['guest']);const value=await reader.browserVersion('id');assert.equal(calls,1);assert.equal(value.installedVersion,WINDOWS_CHROME.version);assert.equal(value.profileCompatibility?.state,'newer');
 for(const invalid of [JSON.stringify(binary),reply+'\nprivate extra output',JSON.stringify(binary)+'\n'+JSON.stringify({...profile,privatePath:'/private'})]){reply=invalid;await assert.rejects(reader.browserVersion('id'),{code:'BROWSER_PROFILE_RECEIPT'});}
});
test('A revoked final guard cannot publish component/profile results from the same read',async()=>{
 const session={state:'active'},sessions=new Map([['id',session]]);let authorizations=0;const manager={sessions,assertAccess:async()=>{if(++authorizations===2)throw Error('Retired guard');return {id:'id'};},profile:async()=>({})} as unknown as WindowsManager;
 const guest=(async()=>JSON.stringify({version:1,state:'verified',issue:null,recordedVersion:WINDOWS_CHROME.version})+'\n'+JSON.stringify({version:1,state:'compatible',selectedVersion:WINDOWS_CHROME.version,recordedVersion:WINDOWS_CHROME.version,issue:null})) as HyperVRuntime['guest'];await assert.rejects(new WindowsOverviewReadings(manager,guest).browserVersion('id'),/Retired guard/);
});
test('Combined observations must bind component and profile to the same selected version',async()=>{
 const session={state:'active'},manager={sessions:new Map([['id',session]]),assertAccess:async()=>({id:'id'}),profile:async()=>({})} as unknown as WindowsManager,candidate=WINDOWS_BROWSER_CANDIDATE.version;
 let reply=JSON.stringify({version:1,state:'verified',issue:null,recordedVersion:WINDOWS_CHROME.version})+'\n'+JSON.stringify({version:1,state:'compatible',issue:null,selectedVersion:candidate,recordedVersion:candidate});const reader=new WindowsOverviewReadings(manager,(async()=>reply) as HyperVRuntime['guest']);await assert.rejects(reader.browserVersion('id'),{code:'BROWSER_SELECTION_CHANGED'});
 reply=JSON.stringify({version:1,state:'verified',issue:null,selectedVersion:candidate,recordedVersion:candidate})+'\n'+JSON.stringify({version:1,state:'compatible',issue:null,selectedVersion:candidate,recordedVersion:candidate});const result=await reader.browserVersion('id');assert.equal(result.installedVersion,candidate);assert.equal(result.profileCompatibility?.selectedVersion,candidate);assert.equal(result.updateAvailable,false);
});
