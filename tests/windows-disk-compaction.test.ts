import {test} from 'node:test';
import path from 'node:path';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Offline compaction admits only a verified detached disk and never reports uncertain outcomes as success',{skip:process.platform!=='win32'},async()=>{
 const fixture=path.resolve('tests/fixtures/windows-disk-compaction.ps1').replaceAll("'","''");
 const source=path.resolve('scripts/windows/hyperv.ps1').replaceAll("'","''");
 await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText('${fixture}'))) -Source '${source}'`),{timeoutMs:20000});
});
test('Protected native transaction persists a fence before compact and retains it on failures',{skip:process.platform!=='win32'},async()=>{
 const fixture=path.resolve('tests/fixtures/windows-disk-compaction-broker.ps1').replaceAll("'","''");
 const source=path.resolve('native/windows/DiskGrowth.cs').replaceAll("'","''");
 await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText('${fixture}'))) -Source '${source}'`),{timeoutMs:20000});
});
