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
import type {WindowsConfig} from '../server/platform/windows/config.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {shellQuote} from '../server/network-guard.ts';
import {windowsDesktopClientSpec} from '../server/platform/windows/desktop-client-guest.ts';
import {WINDOWS_DESKTOP_CLIENT_OPERATIONS,windowsDesktopClientControlProgram,windowsDesktopClientFocusProgram,parseWindowsDesktopClientFocus,parseWindowsDesktopClientControl,createWindowsDesktopClientGuestDriver} from '../server/platform/windows/desktop-client-task.ts';
import {WINDOWS_DESKTOP_FRAME_BOOTSTRAP} from '../server/platform/windows/desktop-component-transport.ts';
const boot='12345678-1234-4234-8234-123456789abc',environment={...environmentSchema.parse({name:'合成受管理客户端',network:{mode:'http',host:'127.0.0.1',port:7897,strict:true,transparent:true}}),state:'running'} as Environment;
for(const app of ['grok-bot','claude-desktop'] as const)test(`Production ${app} root control operations fence cancellation and refuse foreign units`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-client-task-'));
 try{
  const script=path.join(root,'operations.py'),params=path.join(root,'spec.json'),cases=path.join(root,'cases'),spec=windowsDesktopClientSpec(environment,app,randomUUID());await writeFile(script,WINDOWS_DESKTOP_CLIENT_OPERATIONS);await writeFile(params,JSON.stringify(spec));await mkdir(cases);
  const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-desktop-client-task.py'),script,cases,params],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout);assert.equal(result.complete,true);assert.equal(result.checks.length,51);assert.equal(result.actualSystemd,false);assert.equal(result.clientExecuted,false);console.log(JSON.stringify({diagnostic:'desktop-client-task',app,...result}));
  const programs=[];for(const mode of ['reserve','launch','cancel','inspect'] as const){const file=path.join(root,mode+'.py');await writeFile(file,windowsDesktopClientControlProgram(spec,mode,boot));programs.push(file);}
  const focus=path.join(root,'focus.py');await writeFile(focus,windowsDesktopClientFocusProgram(spec,boot));programs.push(focus);
  await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I','-c','import ast,pathlib,sys;[ast.parse(pathlib.Path(p).read_text(encoding="utf8")) for p in sys.argv[1:]]',...programs],{windowsHide:true,timeout:10000});
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-client-task-/);await rm(root,{recursive:true,force:true});}
});
test('Control receipts bind exact boot/token/unit and permit a fenced cancellation instead of false start success',()=>{
 const spec=windowsDesktopClientSpec(environment,'grok-bot',randomUUID()),value={version:1,application:spec.application,token:spec.token,unit:spec.unit,bootId:boot,phase:'reserved'};
 assert.equal(parseWindowsDesktopClientControl(JSON.stringify(value),spec,'reserved').phase,'reserved');assert.equal(parseWindowsDesktopClientControl(JSON.stringify({...value,phase:'cancelled'}),spec,'started',boot).phase,'cancelled');
 for(const wrong of [{...value,token:randomUUID()},{...value,unit:'foreign.service'},{...value,bootId:randomUUID()},{...value,extra:true}])assert.throws(()=>parseWindowsDesktopClientControl(JSON.stringify(wrong),spec,'reserved',boot),{code:'DESKTOP_CLIENT_CONTROL_RECEIPT'});
 assert.throws(()=>windowsDesktopClientControlProgram({...spec},'reserve'),{code:'DESKTOP_CLIENT_SPEC'});
 assert.throws(()=>windowsDesktopClientControlProgram(spec,'inspect'),{code:'DESKTOP_CLIENT_SPEC'});
});

test('Window focus receipts preserve a confirmed false and reject foreign identities or injected window arguments',()=>{
 const spec=windowsDesktopClientSpec(environment,'grok-bot',randomUUID()),value={version:1,application:spec.application,token:spec.token,unit:spec.unit,bootId:boot,focused:false};
 assert.equal(parseWindowsDesktopClientFocus(JSON.stringify(value),spec,boot).focused,false);
 assert.equal(parseWindowsDesktopClientFocus(JSON.stringify({...value,focused:true}),spec,boot).focused,true);
 for(const wrong of [{...value,token:randomUUID()},{...value,application:'claude-desktop'},{...value,unit:'foreign.service'},{...value,bootId:randomUUID()},{...value,focused:'true'},{...value,window:'0x1234'},{...value,pid:1234}])assert.throws(()=>parseWindowsDesktopClientFocus(JSON.stringify(wrong),spec,boot),{code:'DESKTOP_CLIENT_FOCUS_RECEIPT'});
 assert.throws(()=>windowsDesktopClientFocusProgram({...spec},boot),{code:'DESKTOP_CLIENT_SPEC'});
 assert.throws(()=>windowsDesktopClientFocusProgram(spec,'foreign-boot'),{code:'DESKTOP_CLIENT_SPEC'});
 assert.match(windowsDesktopClientFocusProgram(spec,boot),/# MU_CLIENT_FOCUS_ENTRY\nclient_deadline\(10\)/);
 assert.match(windowsDesktopClientFocusProgram(spec,boot),/print\(json.dumps\(focus_owned_client\(spec,/);
});
test('Driver transports complete fixed programs outside Windows argv and sends cancellation without the aborted launch signal',async()=>{
 const spec=windowsDesktopClientSpec(environment,'claude-desktop',randomUUID()),calls:{mode:string;signal?:AbortSignal}[]=[],controller=new AbortController();
 const runtime:Pick<HyperVRuntime,'management'>={management:async(_config,command,options={})=>{
  assert.deepEqual(command.slice(0,6),['sudo','-n','/usr/bin/python3','-I','-c',WINDOWS_DESKTOP_FRAME_BOOTSTRAP]);assert.ok(command.map(shellQuote).join(' ').length<6000);assert.equal(options.input,undefined);assert.equal(options.onOutput,undefined);assert.equal(options.maxBytes,2048);
  const frame=Buffer.from(options.inputBytes!);assert.equal(frame.subarray(0,8).toString(),'MUCDSK01');const length=frame.readUInt32BE(8),program=frame.subarray(16,16+length).toString('utf8');assert.equal(frame.readUInt32BE(12),0);assert.equal(frame.length,16+length);
  const entry=program.split(/# MU_CLIENT_(?:CONTROL|FOCUS)_ENTRY\n/)[1],mode=entry.includes('focus_owned_client(')?'focus':entry.includes('reserve_client(')?'reserve':entry.includes('launch_client(')?'launch':entry.includes('inspect_owned_client(')?'inspect':'cancel';calls.push({mode,signal:options.signal});return JSON.stringify(mode==='focus'?{version:1,application:spec.application,token:spec.token,unit:spec.unit,bootId:boot,focused:true}:mode==='inspect'?{version:1,application:spec.application,token:spec.token,unit:spec.unit,state:'running',pid:2222,renderers:1,rendererProtected:true}:{version:1,application:spec.application,token:spec.token,unit:spec.unit,bootId:boot,phase:mode==='reserve'?'reserved':mode==='launch'?'started':'cancelled'});
 }};
 const driver=createWindowsDesktopClientGuestDriver(runtime);await driver.reserve({} as WindowsConfig,spec,{signal:controller.signal});await driver.launch({} as WindowsConfig,spec,boot,{signal:controller.signal});await driver.inspect({} as WindowsConfig,spec,boot,{signal:controller.signal});await driver.focus({} as WindowsConfig,spec,boot,{signal:controller.signal});controller.abort();await driver.cancel({} as WindowsConfig,spec,boot);assert.deepEqual(calls.map(c=>c.mode),['reserve','launch','inspect','focus','cancel']);assert.equal(calls.at(-1)!.signal,undefined);await assert.rejects(driver.reserve({} as WindowsConfig,spec,{signal:controller.signal}),{name:'AbortError'});assert.equal(calls.length,5);
});
