import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from '../server/platform/windows/component-package.ts';
import {WINDOWS_BROWSER_REPAIR_PYTHON,windowsBrowserRepairProgram,windowsBrowserRepairInput,WINDOWS_BROWSER_REPAIR_BOOTSTRAP} from '../server/platform/windows/browser-repair.ts';
import {WINDOWS_BROWSER_CANDIDATE} from '../server/platform/windows/browser-releases.ts';

test('Windows component recovery survives real process kills and preserves unclaimed files and browser data',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-browser-repair-'));
 try{
  const component=path.join(root,'component.py'),repair=path.join(root,'repair.py'),cases=path.join(root,'cases');await writeFile(component,WINDOWS_COMPONENT_PACKAGE_PYTHON);await writeFile(repair,WINDOWS_BROWSER_REPAIR_PYTHON);await mkdir(cases);
  const output=await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-repair.py'),component,repair,cases],{windowsHide:true,timeout:60000,maxBuffer:1048576});const result=JSON.parse(output.stdout);
  assert.equal(result.complete,true);assert.equal(result.checks.length,30);assert.equal(result.realProcessKills,18);assert.ok(result.checks.every((c:any)=>c.passed&&c.profilePreserved));assert.equal(result.realLinux,false);assert.equal(result.realVm,false);assert.equal(result.actualKernelLockContention,true);assert.equal(result.actualDirectoryLink,true);console.log(JSON.stringify({...result,diagnostic:'windows-browser-component-recovery'}));
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-browser-repair-/);await rm(root,{recursive:true,force:true});}
});

test('Windows repair rename adapter waits only for a bounded real sharing denial and preserves an appearing destination',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-browser-repair-sharing-'));
 try{const output=await promisify(execFile)('python',['-I',path.resolve('tests/fixtures/windows-browser-repair.py'),'rename-adapter-test',root],{windowsHide:true,timeout:10000,maxBuffer:65536}),result=JSON.parse(output.stdout);assert.equal(result.complete,true);assert.equal(result.actualWindowsSharingHandles,true);assert.equal(result.originalProgramChanged,false);assert.equal(result.checks.length,4);assert.ok(result.checks.every((value:any)=>value.passed));}
 finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});

test('Selected candidate component repair survives actual process kills while preserving its selector and profile',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-browser-repair-selected-'));
 try{
  const component=path.join(root,'component.py'),repair=path.join(root,'repair.py'),cases=path.join(root,'cases');await writeFile(component,WINDOWS_COMPONENT_PACKAGE_PYTHON);await writeFile(repair,WINDOWS_BROWSER_REPAIR_PYTHON);await mkdir(cases);
  const output=await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-repair.py'),component,repair,cases],{windowsHide:true,timeout:60000,maxBuffer:1048576,env:{...process.env,MU_BROWSER_REPAIR_FIXTURE_VERSION:WINDOWS_BROWSER_CANDIDATE.version}}),result=JSON.parse(output.stdout);
  assert.equal(result.complete,true);assert.equal(result.version,WINDOWS_BROWSER_CANDIDATE.version);assert.equal(result.checks.length,30);assert.equal(result.realProcessKills,18);assert.ok(result.checks.every((c:any)=>c.passed&&c.profilePreserved));assert.equal(result.realLinux,false);assert.equal(result.realVm,false);assert.equal(result.syntheticRecipe,true);console.log(JSON.stringify({...result,diagnostic:'windows-browser-selected-component-recovery'}));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-browser-repair-selected-/);await rm(root,{recursive:true,force:true});}
});

test('Selected component mutations reject changed choices and repair epochs before component writes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-browser-repair-policy-'));
 try{const component=path.join(root,'component.py'),repair=path.join(root,'repair.py'),cases=path.join(root,'cases');await mkdir(cases);await writeFile(component,WINDOWS_COMPONENT_PACKAGE_PYTHON);await writeFile(repair,WINDOWS_BROWSER_REPAIR_PYTHON);const result=JSON.parse((await promisify(execFile)(process.platform==='win32'?'python':'python3',['-I',path.resolve('tests/fixtures/windows-browser-repair.py'),component,repair,cases],{windowsHide:true,timeout:30000,maxBuffer:1048576,env:{...process.env,MU_BROWSER_REPAIR_FIXTURE_VERSION:WINDOWS_BROWSER_CANDIDATE.version,MU_BROWSER_REPAIR_FIXTURE_POLICY_ONLY:'1'}})).stdout);assert.equal(result.complete,true);assert.equal(result.checks.length,8);assert.equal(result.realProcessKills,3);assert.equal(result.rootMutationEpochPinned,true);assert.equal(result.realLinux,false);for(const check of result.checks)await t.test(check.case,()=>assert.equal(check.passed,true));console.log(JSON.stringify({...result,diagnostic:'windows-browser-repair-selected-policy'}));
 }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-browser-repair-policy-/);await rm(root,{recursive:true,force:true});}
});

test('Windows component repair uses a short fixed bootstrap and bounded trusted stdin program',()=>{
 for(const begin of [true,false]){const program=windowsBrowserRepairProgram(begin),archive=Buffer.from('synthetic archive'),input=windowsBrowserRepairInput(archive,begin),size=input.readUInt32BE();assert.equal(size,Buffer.byteLength(program));assert.equal(input.subarray(4,4+size).toString(),program);assert.deepEqual(input.subarray(4+size),archive);assert.ok(size<262144);assert.ok(program.includes(WINDOWS_COMPONENT_PACKAGE_PYTHON));assert.ok(program.includes(WINDOWS_BROWSER_REPAIR_PYTHON));assert.ok(program.includes(begin?'sys.stdin.buffer,True':'sys.stdin.buffer,False'));}
 assert.ok(Buffer.byteLength(WINDOWS_BROWSER_REPAIR_BOOTSTRAP)<1024);assert.ok(WINDOWS_BROWSER_REPAIR_BOOTSTRAP.includes('size>262144'));
});

test('The actual Python bootstrap enforces framing and leaves binary archive bytes intact',async()=>{
 const invoke=(input:Uint8Array)=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const process=spawn(globalThis.process.platform==='win32'?'python':'python3',['-I','-c',WINDOWS_BROWSER_REPAIR_BOOTSTRAP],{windowsHide:true,timeout:5000});let stdout='',stderr='';process.stdout.on('data',value=>stdout+=value);process.stderr.on('data',value=>stderr+=value);process.on('error',reject);process.on('close',code=>resolve({code,stdout,stderr}));process.stdin.on('error',()=>{});process.stdin.end(input);});
 const program=Buffer.from("import hashlib,json\nprint(json.dumps({'sha256':hashlib.sha256(stream.read()).hexdigest()}))\n"),archive=Buffer.from([0,26,10,13,255,65]),header=Buffer.alloc(4);header.writeUInt32BE(program.length);
 const valid=await invoke(Buffer.concat([header,program,archive]));assert.equal(valid.code,0);assert.equal(JSON.parse(valid.stdout).sha256,createHash('sha256').update(archive).digest('hex'));
 for(const input of [Buffer.alloc(0),Buffer.from([0,0]),Buffer.from([0,4,0,1]),Buffer.concat([header,program.subarray(0,4)])]){const rejected=await invoke(input);assert.notEqual(rejected.code,0);assert.equal(rejected.stdout,'');assert.match(rejected.stderr,/RuntimeError/);}
 const compiler=Buffer.from("compile(stream.read(),'generated-component-recovery','exec');print('compiled')"),compilerHeader=Buffer.alloc(4);compilerHeader.writeUInt32BE(compiler.length);const compiled=await invoke(Buffer.concat([compilerHeader,compiler,Buffer.from(windowsBrowserRepairProgram())]));assert.equal(compiled.code,0,compiled.stderr);assert.equal(compiled.stdout.trim(),'compiled');console.log(JSON.stringify({diagnostic:'windows-browser-repair-bootstrap',actualPython:true,generatedProgramCompiled:true,binaryBytesPreserved:true,invalidFrames:4,realLinux:false}));
});
