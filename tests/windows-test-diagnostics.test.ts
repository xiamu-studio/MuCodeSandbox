import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import windowsTestDiagnostics,{diagnosticEvent,diagnosticValue} from '../scripts/windows-test-diagnostics.mjs';

test('Diagnostic reporter retains hidden Error fields and bounded causes without invoking getters',()=>{
 const error=new Error('Synthetic child failure',{cause:Object.assign(new Error('Process exited'),{exitCode:23,signal:null,failureType:'subtestsFailed'})});
 let getterCalled=false;Object.defineProperty(error,'privateGetter',{get(){getterCalled=true;throw Error('Must not execute');}});
 const value=diagnosticValue(error);assert.equal(getterCalled,false);assert.equal(value.message,error.message);assert.equal(value.cause.exitCode,23);assert.equal(value.cause.signal,null);assert.equal(value.privateGetter,'[accessor omitted]');
 const circular:Record<string,unknown>={};circular.self=circular;assert.equal(diagnosticValue(circular).self,'[circular]');
 const long=diagnosticValue('x'.repeat(20000));assert.equal(long.text.length,16384);assert.equal(long.truncatedCharacters,3616);
 const proto=JSON.parse('{"__proto__":{"fixture":true}}');assert.deepEqual(JSON.parse(JSON.stringify(diagnosticValue(proto))),proto);assert.equal(({} as {fixture?:boolean}).fixture,undefined);
});
test('Diagnostic events mark oversized records and preserve Unicode and line boundaries',()=>{
 const small=diagnosticEvent({type:'test:stderr',data:{message:'合成诊断\nsecond line'}},1);assert.equal(small.split('\n').length,2);assert.equal(JSON.parse(small).data.message,'合成诊断\nsecond line');
 const large=JSON.parse(diagnosticEvent({type:'test:fail',data:Object.fromEntries(Array.from({length:100},(_,i)=>['key'+i,'x'.repeat(20000)]))},2));assert.equal(large.truncated,true);assert.ok(large.originalBytes>128*1024);assert.ok(large.preview.length<=16384);
});
test('Diagnostic reporter records scheduling and terminal summaries while leaving pass events to the human reporter',async()=>{
 async function* source(){yield {type:'test:dequeue',data:{file:'合成.test.ts'}};yield {type:'test:pass',data:{name:'Passed'}};yield {type:'test:summary',data:{success:true}};}
 const lines=[];for await(const line of windowsTestDiagnostics(source()))lines.push(JSON.parse(line));assert.deepEqual(lines.map(line=>line.type),['test:dequeue','test:summary']);assert.deepEqual(lines.map(line=>line.sequence),[1,2]);
});
test('Actual Node runner retains child exit code and stderr beside a failing TAP result',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-test-diagnostics-')),fixture=path.join(directory,'合成 child.test.mjs'),tap=path.join(directory,'human.tap'),events=path.join(directory,'events.ndjson'),reporter=path.resolve(import.meta.dirname,'../scripts/windows-test-diagnostics.mjs');
 try{
  await writeFile(fixture,"process.stderr.write('synthetic-child-exit-diagnostic\\n');process.exit(23);\n");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-reporter='+pathToFileURL(reporter).href,'--test-reporter-destination='+tap,'--test-reporter-destination='+events,fixture],{env,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(run.status,1,run.stderr||run.stdout);assert.equal(run.error,undefined);assert.match(await readFile(tap,'utf8'),/not ok/);
  const captured=(await readFile(events,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),failure=captured.find(event=>event.type==='test:fail');assert.ok(failure);assert.equal(failure.data.details.error.exitCode,23);assert.equal(failure.data.details.error.failureType,'testCodeFailure');
  assert.ok(captured.some(event=>event.type==='test:stderr'&&event.data.message.includes('synthetic-child-exit-diagnostic')));
 }finally{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.match(path.basename(directory),/^mu-test-diagnostics-/);await rm(directory,{recursive:true,force:true});}
});
