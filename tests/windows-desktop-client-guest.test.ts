import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import {shellQuote} from '../server/network-guard.ts';
import {WINDOWS_DESKTOP_PROFILE_PYTHON,WINDOWS_DESKTOP_CLIENT_INSPECT,windowsDesktopClientSpec,windowsDesktopClientInspectProgram,parseWindowsDesktopClientInspection} from '../server/platform/windows/desktop-client-guest.ts';
const environment={...environmentSchema.parse({name:'合成客户端',network:{mode:'http',host:'127.0.0.1',port:7897,strict:true,transparent:true}}),state:'running'} as Environment;
test('Fixed client specs bind private profiles, immutable token units and the shared desktop session',()=>{
 for(const app of ['grok-bot','claude-desktop'] as const){const spec=windowsDesktopClientSpec(environment,app,randomUUID());assert.ok(spec.launcher.includes('exec /usr/bin/env -i'));assert.ok(spec.launcher.includes('--user-data-dir='+spec.profile+'/profile'));assert.ok(spec.unitText.includes('ConditionPathExists=!'+spec.job+'/cancelled'));assert.ok(spec.unitText.includes('User=dev\nGroup=dev'));assert.ok(spec.unitText.includes('KillMode=control-group'));assert.equal(spec.launcher.includes('dbus-run-session'),false);assert.equal(spec.launcher.includes('--no-sandbox'),false);assert.equal(spec.argv[0],spec.executable);assert.equal(Reflect.set(spec.environment,'HTTP_PROXY','untrusted'),false);assert.ok(['sudo','-n','python3','-I','-c',windowsDesktopClientInspectProgram(spec)].map(shellQuote).join(' ').length<30000);}
 for(const e of [{...environment,state:'stopped'},{...environment,kind:'browser'},{...environment,network:{...environment.network,strict:false}},{...environment,identity:{...environment.identity,timezone:'UTC\nINJECT'}},{...environment,identity:{...environment.identity,locale:'__proto__'}}])assert.throws(()=>windowsDesktopClientSpec(e as Environment,'grok-bot',randomUUID()),{code:'DESKTOP_CLIENT_SPEC'});
 assert.throws(()=>windowsDesktopClientSpec(environment,'grok-bot','ffffffff-ffff-1fff-8fff-ffffffffffff'),{code:'DESKTOP_CLIENT_SPEC'});
});
for(const app of ['grok-bot','claude-desktop'] as const)test(`Production ${app} profile and process helpers preserve data and refuse unsafe ownership`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-client-'));
 try{
  const profile=path.join(root,'profile.py'),inspect=path.join(root,'inspect.py'),params=path.join(root,'spec.json'),cases=path.join(root,'cases'),spec=windowsDesktopClientSpec(environment,app,randomUUID());await writeFile(profile,WINDOWS_DESKTOP_PROFILE_PYTHON);await writeFile(inspect,WINDOWS_DESKTOP_CLIENT_INSPECT);await writeFile(params,JSON.stringify(spec));await mkdir(cases);
  const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-desktop-client.py'),profile,inspect,cases,params],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout);assert.equal(result.complete,true);assert.equal(result.checks.length,53);assert.equal(result.clientExecuted,false);assert.equal(result.actualLinux,false);console.log(JSON.stringify({diagnostic:'desktop-client-guest',app,...result}));
  const launcher=path.join(root,'launcher.sh');await writeFile(launcher,spec.launcher);await promisify(execFile)(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash',['--noprofile','--norc','-n',launcher],{windowsHide:true,timeout:10000});
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-desktop-client-/);await rm(root,{recursive:true,force:true});}
});
test('Client receipts cannot retire tracking without a complete stopped receipt or claim protection without renderers',()=>{
 const spec=windowsDesktopClientSpec(environment,'grok-bot',randomUUID()),base={version:1,application:spec.application,token:spec.token,unit:spec.unit,state:'running',pid:2222,renderers:1,rendererProtected:true};assert.equal(parseWindowsDesktopClientInspection(JSON.stringify(base),spec).state,'running');
 for(const wrong of [{...base,token:randomUUID()},{...base,unit:'foreign.service'},{...base,state:'stopped'},{...base,renderers:0},{...base,rendererProtected:false},{...base,unexpected:true},{}])assert.throws(()=>parseWindowsDesktopClientInspection(JSON.stringify(wrong),spec),{code:'DESKTOP_CLIENT_RECEIPT'});
 const stopped={...base,state:'stopped',pid:0,renderers:0,rendererProtected:null};assert.equal(parseWindowsDesktopClientInspection(JSON.stringify(stopped),spec).state,'stopped');
});
