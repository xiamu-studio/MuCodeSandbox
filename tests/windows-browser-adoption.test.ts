import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsBrowserAdoptionProgram,windowsBrowserAdoptionInput,WINDOWS_BROWSER_ADOPTION_PYTHON,type WindowsBrowserAdoptionAction} from '../server/platform/windows/browser-adoption.ts';
import {WINDOWS_BROWSER_PROFILE_WORKER} from '../server/platform/windows/browser-profile-worker.ts';
import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from '../server/platform/windows/component-package.ts';
import {WINDOWS_BROWSER_RESET_HELPERS} from '../server/platform/windows/browser-reset.ts';
import {WINDOWS_BROWSER_REPAIR_PYTHON} from '../server/platform/windows/browser-repair.ts';
import {LEASE_HELPER} from '../server/guest-lease.ts';
import {WINDOWS_BROWSER_PROFILE_INSPECT} from '../server/platform/windows/browser-profile.ts';

test('Profile adoption accepts fixed operations and exact epochs, with bounded stdin programs',async()=>{
 const epoch='1'.repeat(32),programs:string[]=[];
 for(const action of ['status','begin','trial','commit','recover'] as WindowsBrowserAdoptionAction[]){
  const id=['trial','commit','recover'].includes(action)?epoch:undefined,binding=action==='commit'?'2'.repeat(64):undefined,program=windowsBrowserAdoptionProgram(action,id,binding),input=windowsBrowserAdoptionInput(action,id,binding),size=input.readUInt32BE();
  assert.equal(size,Buffer.byteLength(program));assert.ok(size<262144);assert.equal(input.length,size+4);assert.equal(input.subarray(4).toString(),program);assert.ok(program.includes(WINDOWS_BROWSER_ADOPTION_PYTHON));assert.ok(program.includes(JSON.stringify(WINDOWS_BROWSER_PROFILE_WORKER)));programs.push(program);
 }
 for(const action of ['','exec','begin();print(1)'])assert.throws(()=>windowsBrowserAdoptionProgram(action as WindowsBrowserAdoptionAction),{code:'BROWSER_ADOPTION_ACTION'});
 for(const epoch of ['', '../outside','A'.repeat(32),'f'.repeat(33),null,1,{toString:()=> 'f'.repeat(32)}])assert.throws(()=>windowsBrowserAdoptionProgram('commit',epoch as string),{code:'BROWSER_ADOPTION_ID'});
 for(const action of ['trial','commit'] as const)assert.throws(()=>windowsBrowserAdoptionProgram(action),{code:'BROWSER_ADOPTION_ID'});
 for(const action of ['status','begin'] as const)assert.throws(()=>windowsBrowserAdoptionProgram(action,epoch),{code:'BROWSER_ADOPTION_ID'});
 assert.throws(()=>windowsBrowserAdoptionProgram('commit',epoch),{code:'BROWSER_ADOPTION_ACCEPTANCE'});
 for(const binding of ['','A'.repeat(64),'0'.repeat(65)])assert.throws(()=>windowsBrowserAdoptionProgram('commit',epoch,binding),{code:'BROWSER_ADOPTION_ACCEPTANCE'});
 // These programs exceed Windows argv limits. Compile the exact bytes over stdin.
 const result=await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
  const child=spawn(process.platform==='win32'?'python':'python3',['-I','-c',"import json,sys; values=json.load(sys.stdin); [compile(p,'profile-adoption','exec') for p in values]; print(len(values))"],{windowsHide:true});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify([...programs,WINDOWS_BROWSER_PROFILE_WORKER]));
 });assert.equal(result.code,0,result.err);assert.equal(result.out.trim(),'6');
});

test('Profile adoption uses real host data and killed processes to recover compatible data and preserve committed decisions',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-browser-adoption-'));
 try{
  const names=['component','reset','repair','adoption','worker','lease'],values=[WINDOWS_COMPONENT_PACKAGE_PYTHON,WINDOWS_BROWSER_RESET_HELPERS,WINDOWS_BROWSER_REPAIR_PYTHON,WINDOWS_BROWSER_ADOPTION_PYTHON,WINDOWS_BROWSER_PROFILE_WORKER,LEASE_HELPER],files=names.map(name=>path.join(root,name+'.py')),cases=path.join(root,'cases');await mkdir(cases);
  await Promise.all(files.map((file,index)=>writeFile(file,values[index])));
  await writeFile(path.join(root,'selected-profile.py'),WINDOWS_BROWSER_PROFILE_INSPECT);
  const output=await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-adoption.py'),...files,cases],{windowsHide:true,timeout:180000,maxBuffer:2097152}),result=JSON.parse(output.stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,74);assert.equal(result.realProcessKills,30);assert.equal(result.actualHostFiles,true);assert.equal(result.realSqliteCookies,true);assert.equal(result.realLinux,false);assert.equal(result.realVm,false);assert.equal(result.browserExecuted,false);
  for(const check of result.checks)await t.test(check.case,()=>assert.equal(check.passed,true));
  console.log(JSON.stringify({...result,diagnostic:'windows-browser-profile-adoption'}));
 }finally{
  assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-browser-adoption-/);await rm(root,{recursive:true,force:true});
 }
});
