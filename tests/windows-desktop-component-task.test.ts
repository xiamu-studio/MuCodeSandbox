import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {shellQuote} from '../server/network-guard.ts';
import {AppError} from '../server/errors.ts';
import type {WindowsConfig} from '../server/platform/windows/config.ts';
import type {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {newWindowsDesktopTask,windowsDesktopTaskProgram,WINDOWS_DESKTOP_TASK_OPERATIONS,WINDOWS_DESKTOP_TASK_RUNNER,runWindowsDesktopOwnedComponent,parseWindowsDesktopTaskReceipt} from '../server/platform/windows/desktop-component-task.ts';

const boot='12345678-1234-4234-8234-123456789abc',call={programSha256:'a'.repeat(64),inputBytes:Buffer.from('SYNTHETIC COMPONENT FRAME')};
async function temporary(work:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-owned-'));try{await work(root);}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-desktop-owned-/);await rm(root,{recursive:true,force:true});}}
function invocation(command:string[],options:{input?:string}){
 const script=options.input??command.at(-1)!,entry=script.split('# MU_OWNED_COMPONENT_ENTRY\n')[1];assert.ok(entry);const match=entry.match(/ meta=metadata\((.*)\)\n/);assert.ok(match);const [token,application,bootId,programSha]=JSON.parse('['+match[1].replace('boot_identity()',JSON.stringify(boot))+']');
 const mode=entry.includes('print(json.dumps(reserve_task(')?'reserve':entry.includes('print(json.dumps(cancel_task(')?'cancel':'launch';return {mode,token,application,bootId,programSha,unit:'mucodesandbox-desktop-component-'+token+'.service'};
}
function host(){
 let active=true,failures=0,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;}),calls:string[]=[];const hooks:{reserve?:(value:ReturnType<typeof invocation>)=>Promise<string>|string;launch?:()=>Promise<string>|string;cancel?:(value:ReturnType<typeof invocation>)=>Promise<string>|string}={};
 const runtime:Pick<HyperVRuntime,'management'>={management:async(_profile,command,options={})=>{const value=invocation(command,options);calls.push(value.mode);assert.equal(options.onOutput,undefined);if(value.mode==='launch'){assert.deepEqual(command.slice(0,5),['sudo','-n','/usr/bin/python3','-I','-c']);assert.ok(command.map(shellQuote).join(' ').length<30000);assert.equal(options.inputBytes,call.inputBytes);started();if(hooks.launch)return hooks.launch();return '{"version":1,"state":"verified"}';}assert.deepEqual(command,['sudo','-n','/usr/bin/python3','-I','-']);assert.equal(options.inputBytes,undefined);const phase=value.mode==='reserve'?'reserved':'cancelled',reply={version:1,token:value.token,bootId:value.bootId,unit:value.unit,phase};return (value.mode==='reserve'?hooks.reserve?.(value):hooks.cancel?.(value))??JSON.stringify(reply);}};
 const context={assertCurrent:()=>{if(!active)throw new AppError('Synthetic replacement',409,'CONFIGURATION_CHANGED');},current:()=>active,failProtection:async()=>{failures++;active=false;}};
 return {runtime,context,hooks,calls,began,active:(value:boolean)=>{active=value;},failures:()=>failures};
}

test('Owned task programs compile as Python data and the launch argument remains within Windows limits',async()=>temporary(async root=>{
 const task=newWindowsDesktopTask('grok-bot',call.programSha256),files=[];for(const mode of ['reserve','launch','cancel'] as const){const source=windowsDesktopTaskProgram(task,mode,boot),file=path.join(root,mode+'.py');if(mode==='launch')assert.ok(['sudo','-n','/usr/bin/python3','-I','-c',source].map(shellQuote).join(' ').length<30000);await writeFile(file,source);files.push(file);}const runner=path.join(root,'runner.py');await writeFile(runner,WINDOWS_DESKTOP_TASK_RUNNER);files.push(runner);
 const result=await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I','-c','import ast,pathlib,sys;[ast.parse(pathlib.Path(p).read_text(encoding="utf8")) for p in sys.argv[1:]];print("compiled")',...files],{windowsHide:true,timeout:5000});assert.equal(result.stdout.trim(),'compiled');
}));

test('Production owned-task registry and unit policy fence late starts and refuse foreign authority on ordinary Windows files',async()=>temporary(async root=>{
 const source=path.join(root,'operations.py'),runner=path.join(root,'runner.py'),parameters=path.join(root,'parameters.json'),cases=path.join(root,'cases');await writeFile(source,WINDOWS_DESKTOP_TASK_OPERATIONS);await writeFile(runner,WINDOWS_DESKTOP_TASK_RUNNER);await writeFile(parameters,JSON.stringify(newWindowsDesktopTask('grok-bot',call.programSha256)));await mkdir(cases);
 const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-desktop-component-task.py'),source,cases,runner,parameters],{windowsHide:true,timeout:30000,maxBuffer:1048576})).stdout);assert.equal(result.complete,true);assert.equal(result.checks.length,25);assert.equal(result.actualSystemd,false);assert.equal(result.clientExecuted,false);assert.equal(result.projectAndCredentialSentinelsPreserved,true);console.log(JSON.stringify({diagnostic:'owned-desktop-component-task',...result}));
}));

test('Root task receipts bind the exact token, boot, unit and phase and refuse extra fields',()=>{
 const task=newWindowsDesktopTask('claude-desktop',call.programSha256),value={version:1,token:task.token,bootId:boot,unit:'mucodesandbox-desktop-component-'+task.token+'.service',phase:'reserved'};assert.equal(parseWindowsDesktopTaskReceipt(JSON.stringify(value),task,'reserved').bootId,boot);
 for(const wrong of [{...value,unit:'foreign.service'},{...value,phase:'cancelled'},{...value,path:'unexpected'},{...value,token:newWindowsDesktopTask('grok-bot',call.programSha256).token}])assert.throws(()=>parseWindowsDesktopTaskReceipt(JSON.stringify(wrong),task,'reserved'),{code:'DESKTOP_COMPONENT_TASK_RECEIPT'});
 assert.throws(()=>parseWindowsDesktopTaskReceipt(JSON.stringify({...value,phase:'cancelled'}),task,'cancelled','22345678-1234-4234-8234-123456789abc'),{code:'DESKTOP_COMPONENT_TASK_RECEIPT'});
});

test('Successful ownership launch forwards the binary frame but emits no unnecessary stop request',async()=>{const f=host();assert.equal(await runWindowsDesktopOwnedComponent(f.runtime,{} as WindowsConfig,'grok-bot',call,f.context),'{"version":1,"state":"verified"}');assert.deepEqual(f.calls,['reserve','launch']);assert.equal(f.failures(),0);});

test('Cancellation between reservation and launch sends the original fenced cancel without launching a unit',async()=>{const f=host(),abort=new AbortController();f.hooks.reserve=value=>{queueMicrotask(()=>abort.abort());return JSON.stringify({version:1,token:value.token,unit:value.unit,bootId:boot,phase:'reserved'});};await assert.rejects(runWindowsDesktopOwnedComponent(f.runtime,{} as WindowsConfig,'grok-bot',call,f.context,{signal:abort.signal}),{name:'AbortError'});assert.deepEqual(f.calls,['reserve','cancel']);assert.equal(f.failures(),0);});

test('Launch cancellation awaits an independently confirmed original-task stop',async()=>{const f=host(),abort=new AbortController();f.hooks.launch=()=>new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}));const pending=runWindowsDesktopOwnedComponent(f.runtime,{} as WindowsConfig,'grok-bot',call,f.context,{signal:abort.signal}),cancelled=assert.rejects(pending,{name:'AbortError'});await f.began;abort.abort();await cancelled;assert.deepEqual(f.calls,['reserve','launch','cancel']);assert.equal(f.failures(),0);});

test('Unknown stop receipts revoke the original environment instead of claiming cancellation succeeded',async()=>{const f=host(),abort=new AbortController();f.hooks.launch=()=>new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}));f.hooks.cancel=value=>JSON.stringify({version:1,token:value.token,unit:'foreign.service',bootId:boot,phase:'cancelled'});const pending=runWindowsDesktopOwnedComponent(f.runtime,{} as WindowsConfig,'grok-bot',call,f.context,{signal:abort.signal}),failed=assert.rejects(pending,{code:'DESKTOP_COMPONENT_STOP_UNCONFIRMED'});await f.began;abort.abort();await failed;assert.equal(f.failures(),1);});

test('A replaced environment is never targeted by a late old cancellation',async()=>{const f=host(),abort=new AbortController();f.hooks.launch=()=>new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(abort.signal.reason),{once:true}));const pending=runWindowsDesktopOwnedComponent(f.runtime,{} as WindowsConfig,'grok-bot',call,f.context,{signal:abort.signal}),cancelled=assert.rejects(pending,{name:'AbortError'});await f.began;f.active(false);abort.abort();await cancelled;assert.deepEqual(f.calls,['reserve','launch']);assert.equal(f.failures(),0);});

test('Failed launch transport is fenced before preserving its original error; pre-aborted calls create no reservation',async()=>{const f=host(),original=new AppError('Synthetic SSH failure',502,'PROCESS_FAILED');f.hooks.launch=()=>{throw original;};await assert.rejects(runWindowsDesktopOwnedComponent(f.runtime,{} as WindowsConfig,'grok-bot',call,f.context),error=>error===original);assert.deepEqual(f.calls,['reserve','launch','cancel']);const empty=host(),abort=new AbortController();abort.abort();await assert.rejects(runWindowsDesktopOwnedComponent(empty.runtime,{} as WindowsConfig,'grok-bot',call,empty.context,{signal:abort.signal}),{name:'AbortError'});assert.deepEqual(empty.calls,[]);});
