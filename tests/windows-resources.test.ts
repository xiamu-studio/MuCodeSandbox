import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
for(const [mode,name] of Object.entries({disk:'Disk admission accounts for existing growth, transient copies and the exact floor',memory:'Memory admission enforces configuration, available RAM and the host reserve',quota:'Virtual disk reservations stop exactly at the per-user limit without overflow',metrics:'Windows metrics resolve the actual volume and allocated file bytes'}))test(name,{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-resource-'));
 try{await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText('${path.resolve('tests/fixtures/windows-resources.ps1').replaceAll("'","''")}'))) -Directory '${directory.replaceAll("'","''")}' -Native '${path.resolve('native/windows').replaceAll("'","''")}' -Case '${mode}'`),{timeoutMs:20000});}
 finally{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-resource-/);await rm(target,{recursive:true,force:true});}
});
