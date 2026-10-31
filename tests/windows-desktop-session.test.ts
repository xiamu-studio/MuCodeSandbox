import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WINDOWS_DESKTOP_SESSION_CHECK,WINDOWS_DESKTOP_SESSION_START} from '../server/platform/windows/desktop-session.ts';
import {windowsDisplayLauncher} from '../server/platform/windows/browser-guest.ts';
import {windowsDisplayReadyProgram} from '../server/platform/windows/display-guest.ts';

test('Shared display supervises a private session and portals while the existing browser launcher keeps its separate session',()=>{
 const shared=windowsDisplayLauncher('fixture8',2,true),browser=windowsDisplayLauncher('fixture8',2);
 assert.ok(shared.includes(WINDOWS_DESKTOP_SESSION_START));assert.equal(browser.includes(WINDOWS_DESKTOP_SESSION_START),false);
 assert.ok(shared.includes('wait -n "$xvfb_pid" "$settings_pid" "$pulse_pid" "$wm_pid" "$bus_pid" "$portal_gtk_pid" "$portal_pid"'));
 assert.ok(shared.includes('for child in "$portal_pid" "$portal_gtk_pid" "$bus_pid"'));
 assert.ok(windowsDisplayReadyProgram(2).includes(WINDOWS_DESKTOP_SESSION_CHECK));
 assert.ok(shared.indexOf('wmctrl -m >/dev/null')<shared.indexOf(WINDOWS_DESKTOP_SESSION_START));
});

test('Unchanged session inspector rejects foreign, changed and malformed bus/portal ownership with read-only synthetic files',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-session-'));
 try{
  const script=path.join(root,'session.py'),cases=path.join(root,'cases');await writeFile(script,WINDOWS_DESKTOP_SESSION_CHECK);await mkdir(cases);
  const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-desktop-session.py'),script,cases],{windowsHide:true,timeout:20000,maxBuffer:1048576})).stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,33);assert.equal(result.actualBus,false);assert.equal(result.actualPortal,false);assert.equal(result.clientExecuted,false);
  console.log(JSON.stringify({diagnostic:'windows-desktop-session',...result}));
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-desktop-session-/);await rm(root,{recursive:true,force:true});}
});

test('Generated shared and ordinary display launchers parse with real Bash without starting guest services',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-session-shell-'));
 try{
  for(const shared of [false,true]){
   const file=path.join(root,shared?'shared.sh':'ordinary.sh');await writeFile(file,windowsDisplayLauncher('fixture8',2,shared));
   await promisify(execFile)(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash',['--noprofile','--norc','-n',file],{windowsHide:true,timeout:10000});
  }
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-session-shell-/);await rm(root,{recursive:true,force:true});}
});
