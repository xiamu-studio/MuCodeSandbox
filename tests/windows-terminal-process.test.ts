import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnWindowsTerminal} from '../server/platform/windows/terminal-process.ts';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Native ConPTY output and explicit stop finish their disposable owner processes',{skip:process.platform!=='win32',timeout:20000},async()=>{
 for(const mode of ['exit','stop']){
  const executable=path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const terminal=spawnWindowsTerminal(executable,['-NoLogo','-NoProfile','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine('MU_NATIVE_中文');Start-Sleep -Milliseconds ${mode==='exit'?300:10000}`],{cwd:process.cwd(),env:process.env,cols:80,rows:24,useConpty:true,useConptyDll:true});
  let output='';const exit=new Promise<number>(resolve=>terminal.onExit(({exitCode})=>resolve(exitCode)));
  terminal.onData(data=>{output+=data;if(data.includes('\x1b[c'))terminal.write('\x1b[?1;2c');if(mode==='stop'&&output.includes('MU_NATIVE_中文'))terminal.kill();});
  try{const code=await exit;assert.ok(output.includes('MU_NATIVE_中文'));if(mode==='exit')assert.equal(code,0);assert.throws(()=>process.kill(terminal.pid,0),{code:'ESRCH'});}
  finally{terminal.kill();}
 }
});

test('ConPTY owner loss closes its worker without leaving a terminal controller',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const owner=fork(fileURLToPath(new URL('./fixtures/windows-terminal-owner.ts',import.meta.url)),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 try{
  const [message]=await once(owner,'message');const workerPid=(message as {workerPid:number}).workerPid;assert.ok(workerPid>0);
  const processIds=(await run(powershellPath(),powershellArgs(`$ids=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${workerPid}' | Select-Object -ExpandProperty ProcessId); [Console]::Write(($ids -join ','))`))).trim().split(',').filter(Boolean).map(Number);assert.ok(processIds.length>0,'Native shell descendants were not observed');
  const exited=once(owner,'exit');owner.kill('SIGKILL');await exited;
  const deadline=Date.now()+5000;for(const pid of [workerPid,...processIds])for(;;){try{process.kill(pid,0);}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ESRCH');break;}assert.ok(Date.now()<deadline,'Native worker or shell survived its owner');await new Promise(resolve=>setTimeout(resolve,50));}
 }finally{owner.kill('SIGKILL');}
});
