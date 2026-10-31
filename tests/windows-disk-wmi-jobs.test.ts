import {test} from 'node:test';import path from 'node:path';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
test('Compaction job submission and observation reject ambiguous provider receipts',{skip:process.platform!=='win32'},async()=>{
 const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
 const fixture=path.resolve('tests/fixtures/windows-disk-wmi-jobs.ps1'),source=path.resolve('scripts/windows/hyperv.ps1');
 const root=await mkdtemp(path.join(tmpdir(),'mu-compact-receipt-'));try{await run(powershellPath(),powershellArgs(`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${quote(fixture)}))) -Source ${quote(source)} -ReceiptRoot ${quote(root)}`),{timeoutMs:20000});}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-compact-receipt-/);await rm(root,{recursive:true,force:true});}
});
