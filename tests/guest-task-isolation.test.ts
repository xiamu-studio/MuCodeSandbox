import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,access,unlink,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {GUEST_TASK_RUN,GUEST_TASK_CANCEL} from '../server/guest-task.ts';import {LimaRuntime} from '../server/runtime.ts';import {HyperVRuntime} from '../server/platform/windows/runtime.ts';import {AppError} from '../server/errors.ts';import type {Environment} from '../shared/types.ts';import type {WindowsConfig} from '../server/platform/windows/config.ts';
const execute=promisify(execFile);
test('Windows cancels the corresponding guest task when SSH output handling fails',async()=>{
 const calls:string[][]=[];const runtime=Object.assign(Object.create(HyperVRuntime.prototype),{management:async(_c:WindowsConfig,args:string[])=>{calls.push(args);if(calls.length===1)throw new AppError('Output failed',500,'PROCESS_OUTPUT_HANDLER_FAILED');return '';}});
 await assert.rejects(runtime.guest({timezone:'UTC'} as WindowsConfig,['echo','fixture']),{code:'PROCESS_OUTPUT_HANDLER_FAILED'});
 assert.equal(calls.length,2);const run=calls[0].indexOf(GUEST_TASK_RUN),cancel=calls[1].indexOf(GUEST_TASK_CANCEL);assert.ok(run>=0&&cancel>=0);assert.equal(calls[0][run+1],calls[1][cancel+1]);
});
test('Mac runtime cancels the corresponding guest task when output handling fails',async()=>{
 const calls:string[][]=[];const runtime=Object.assign(Object.create(LimaRuntime.prototype),{guestArgs:(_e:Environment,args:string[])=>args,command:async(args:string[])=>{calls.push(args);if(calls.length===1)throw new AppError('Output failed',500,'PROCESS_OUTPUT_HANDLER_FAILED');return '';}});
 await assert.rejects(runtime.guest({state:'running'} as Environment,['echo','fixture']),{code:'PROCESS_OUTPUT_HANDLER_FAILED'});
 assert.equal(calls.length,2);const run=calls[0].indexOf(GUEST_TASK_RUN),cancel=calls[1].indexOf(GUEST_TASK_CANCEL);assert.ok(run>=0&&cancel>=0);assert.equal(calls[0][run+1],calls[1][cancel+1]);
});
async function failedPython(args:string[],cwd:string){try{await execute(process.platform==='win32'?'python':'python3',args,{cwd,windowsHide:true,timeout:10000,maxBuffer:65536});throw Error('Invalid UUID fixture unexpectedly reached task execution');}catch(error){const e=error as {code:unknown;stderr:string};assert.equal(e.code,1);return e.stderr;}}
test('An isolated supervisor and cancel helper ignore a real workspace module that the old invocation loads',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-task-isolation-'));try{const marker=path.join(root,'imported.marker');await writeFile(path.join(root,'socket.py'),"open('imported.marker','w').write('synthetic workspace module executed')\nraise RuntimeError('SYNTHETIC_WORKSPACE_IMPORT')\n");
  for(const [name,source,args] of [['run',GUEST_TASK_RUN,['not-a-uuid','1000','not-executed']],['cancel',GUEST_TASK_CANCEL,['not-a-uuid']]] as const){const before=await failedPython(['-c',source,...args],root);assert.match(before,/SYNTHETIC_WORKSPACE_IMPORT/);await access(marker);await unlink(marker);const after=await failedPython(['-I','-c',source,...args],root);assert.match(after,/ValueError/);assert.doesNotMatch(after,/SYNTHETIC_WORKSPACE_IMPORT/);await assert.rejects(access(marker),{code:'ENOENT'});console.log(JSON.stringify({diagnostic:'guest-task-import-isolation',helper:name,beforeWorkspaceModuleExecuted:true,afterWorkspaceModuleIgnored:true,realPython:true,invalidUuidStoppedBeforeSocketOrChild:true,realLinuxTask:false}));}
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-task-isolation-/);await rm(root,{recursive:true,force:true});}
});
for(const backend of ['mac','windows'])test(`${backend} runtime isolates internal helpers and preserves the user command and cancellation token`,async()=>{
 const payload=['python3','-c','import socket; print(socket.__file__)'];
 for(const outcome of ['success','timeout']){const calls:string[][]=[];const command=async(args:string[])=>{calls.push(args);if(outcome==='timeout'&&calls.length===1)throw new AppError('Synthetic deadline',504,'TIMEOUT');return 'captured';};
  const mac=Object.assign(Object.create(LimaRuntime.prototype),{guestArgs:(_e:Environment,args:string[])=>args,command});const windows=Object.assign(Object.create(HyperVRuntime.prototype),{management:async(_c:WindowsConfig,args:string[])=>command(args)});
  const request=backend==='mac'?mac.guest({state:'running'} as Environment,payload,{timeoutMs:1000}):windows.guest({timezone:'UTC'} as WindowsConfig,payload,{timeoutMs:1000});if(outcome==='timeout')await assert.rejects(request,{code:'TIMEOUT'});else assert.equal(await request,'captured');
  const run=calls[0],at=run.indexOf(GUEST_TASK_RUN);assert.ok(at>=2);assert.deepEqual(run.slice(at-3,at),['/usr/bin/python3','-I','-c']);assert.deepEqual(run.slice(at+3),payload);assert.equal(run[at+2],'1000');
  if(backend==='windows'){const trampoline=run.indexOf('cd /workspace && exec "$@"');assert.ok(trampoline>=2);assert.equal(run[trampoline-2],'/bin/bash');}
  if(outcome==='timeout'){assert.equal(calls.length,2);const cancel=calls[1],point=cancel.indexOf(GUEST_TASK_CANCEL);assert.ok(point>=3);assert.deepEqual(cancel.slice(point-3,point),['/usr/bin/python3','-I','-c']);assert.equal(cancel[point+1],run[at+1]);}else assert.equal(calls.length,1);
 }
 console.log(JSON.stringify({diagnostic:'guest-task-runtime-isolation',backend,actualRuntimeMethods:true,scenarios:2,supervisorIsolated:true,cancellationIsolated:true,systemInterpreterPinned:true,userPayloadUnchanged:true,realVm:false}));
});
