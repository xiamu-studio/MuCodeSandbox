import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WINDOWS_DESKTOP_COMPONENT_PYTHON,windowsDesktopComponentProgram} from '../server/platform/windows/desktop-component.ts';
import {WINDOWS_GROK_DESKTOP,WINDOWS_CLAUDE_DESKTOP,windowsDesktopAsset} from '../server/platform/windows/desktop-assets.ts';

test('Desktop component catalog pins AMD64 files and refuses an unreviewed client',()=>{
 assert.equal(WINDOWS_GROK_DESKTOP.architecture,'amd64');assert.equal(Object.keys(WINDOWS_GROK_DESKTOP.files).length,102);
 assert.equal(Object.values(WINDOWS_GROK_DESKTOP.files).reduce((n,v)=>n+v.bytes,0),360284243);
 assert.equal(windowsDesktopAsset('grok-bot'),WINDOWS_GROK_DESKTOP);
 assert.equal(Reflect.set(WINDOWS_GROK_DESKTOP,'architecture','arm64'),false);
 assert.equal(Reflect.set(WINDOWS_GROK_DESKTOP.files['grok-bot'],'sha256','0'.repeat(64)),false);
 assert.equal(windowsDesktopAsset('claude-desktop'),WINDOWS_CLAUDE_DESKTOP);
 assert.equal(Object.keys(WINDOWS_CLAUDE_DESKTOP.files).length,3908);
 assert.equal(Object.values(WINDOWS_CLAUDE_DESKTOP.files).reduce((n,v)=>n+v.bytes,0),604781623);
 assert.equal(Reflect.set(WINDOWS_CLAUDE_DESKTOP.files['claude-desktop'],'sha256','0'.repeat(64)),false);
 assert.throws(()=>windowsDesktopAsset('unreviewed-client' as 'grok-bot'),{code:'DESKTOP_COMPONENT_UNAVAILABLE'});
 assert.throws(()=>windowsDesktopComponentProgram('grok-bot','arbitrary' as 'install'));
 assert.ok(windowsDesktopComponentProgram('grok-bot','install').includes(WINDOWS_GROK_DESKTOP.sha256));
});

for(const id of ['grok-bot','claude-desktop'] as const)test(`Desktop preparation verifies recursive fixed ${id} files and resumes interruptions without running a client or package script`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-component-'));
 try{
  const script=path.join(root,'component.py'),generated=path.join(root,'generated.py'),cases=path.join(root,'cases');await writeFile(script,WINDOWS_DESKTOP_COMPONENT_PYTHON);await writeFile(generated,windowsDesktopComponentProgram(id,'inspect'));await mkdir(cases);
  const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-desktop-component.py'),script,cases,generated],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,31);assert.equal(result.executedClient,false);assert.equal(result.executedPackageScript,false);assert.equal(result.projectAndCredentialSentinelsPreserved,true);
  console.log(JSON.stringify({diagnostic:'windows-desktop-component',...result}));
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-desktop-component-/);await rm(root,{recursive:true,force:true});}
});
