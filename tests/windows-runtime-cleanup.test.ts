import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

const windows={skip:process.platform!=='win32'};
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'mu-runtime-cleanup-')),id=randomUUID(),directory=path.join(root,'mu-win-'+id.replaceAll('-',''));await mkdir(directory);return {root,id,directory,close:()=>rm(root,{recursive:true,force:true})};}
const clean=(root:string,id:string,reset=false)=>run(powershellPath(),powershellArgs(`& '${path.resolve('scripts/windows/clean-runtime-metadata.ps1').replaceAll("'","''")}'`),{input:JSON.stringify({root,id,reset}),timeoutMs:30000});

test('Metadata reset removes only an unfinished allocation and keeps its sibling data',windows,async()=>{
 const f=await fixture();try{await mkdir(path.join(f.directory,'seed'));await writeFile(path.join(f.directory,'seed/user-data'),'synthetic');await writeFile(path.join(f.directory,'management'),'synthetic key');await writeFile(path.join(f.root,'sibling.txt'),'keep');await clean(f.root,f.id,true);assert.deepEqual(await readdir(f.directory),[]);assert.equal(await readFile(path.join(f.root,'sibling.txt'),'utf8'),'keep');}finally{await f.close();}
});
test('Existing manifests and unexpected user files prevent a reset before any file is removed',windows,async()=>{
 for(const name of ['manifest.json','personal.txt']){const f=await fixture();try{await writeFile(path.join(f.directory,'management'),'keep');await writeFile(path.join(f.directory,name),'keep');await assert.rejects(clean(f.root,f.id,true));assert.equal(await readFile(path.join(f.directory,'management'),'utf8'),'keep');assert.equal(await readFile(path.join(f.directory,name),'utf8'),'keep');}finally{await f.close();}}
});
test('Cleanup rejects descendant and ancestor junctions without touching their external targets',windows,async()=>{
 const f=await fixture();try{
  const outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'user-data'),'external sentinel');await writeFile(path.join(f.directory,'management'),'keep');
  const junction=path.join(f.directory,'seed');await symlink(outside,junction,'junction');await assert.rejects(clean(f.root,f.id));assert.equal(await readFile(path.join(outside,'user-data'),'utf8'),'external sentinel');assert.equal(await readFile(path.join(f.directory,'management'),'utf8'),'keep');await rm(junction);
  const alias=path.join(f.root,'alias');await symlink(f.root,alias,'junction');await assert.rejects(clean(alias,f.id));assert.equal(await readFile(path.join(f.directory,'management'),'utf8'),'keep');await rm(alias);
 }finally{await f.close();}
});
test('Removing metadata unlinks a hard link without changing the original and rejects noncanonical IDs',windows,async()=>{
 const f=await fixture();try{const outside=path.join(f.root,'original');await writeFile(outside,'keep original');await link(outside,path.join(f.directory,'management'));await clean(f.root,f.id);await assert.rejects(readdir(f.directory),{code:'ENOENT'});assert.equal(await readFile(outside,'utf8'),'keep original');await assert.rejects(clean(f.root,'../outside'));await clean(f.root,f.id);}finally{await f.close();}
});

test('Allocation recovery propagates provider failures instead of treating them as VM absence',windows,async()=>{
 const file=path.resolve('scripts/windows/hyperv.ps1').replaceAll("'","''");
 const script=`$ErrorActionPreference='Continue'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'AllocationVM'},$true)
. ([ScriptBlock]::Create($definition.Extent.Text))
function Get-VM { [CmdletBinding()]param(); Write-Error 'Synthetic VM provider unavailable' }
$c=[pscustomobject]@{brokerResourceLimit=$true;name='mu-win-12345678123442348234123456789012';expectedPlatformId=$null}
$rejected=$false;try{AllocationVM | Out-Null}catch{$rejected=$_.Exception.Message -like '*Synthetic VM provider unavailable*'}
if(-not $rejected){throw 'Provider failure was interpreted as VM absence'}`;
 await run(powershellPath(),powershellArgs(script),{timeoutMs:10000});
});
