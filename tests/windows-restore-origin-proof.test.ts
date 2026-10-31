import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {run} from '../server/process.ts';
import {powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
test('Native standalone restore origin policy rejects forged provenance and binds lifecycle transitions',{skip:process.platform!=='win32'},async()=>{
 const q=(value:string)=>"'"+path.resolve(value).replaceAll("'","''")+"'";
 const body=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${q('tests/fixtures/windows-restore-origin-proof.ps1')}))) -Source ${q('native/windows/RestoreOriginProof.cs')} -Harness ${q('tests/fixtures/windows-restore-origin-proof.cs')}`;
 const result=JSON.parse(await run(powershellPath(),powershellArgs(body),{timeoutMs:20000}));
 assert.equal(result.complete,true);assert.equal(result.realHyperV,false);assert.equal(result.realStorage,false);assert.ok(result.checks.length>=70);assert.ok(result.checks.every((item:{passed:boolean})=>item.passed));
 console.log(JSON.stringify({diagnostic:'restore-origin-policy',checks:result.checks.length,scope:result.scope,realHyperV:false,realStorage:false}));
});
