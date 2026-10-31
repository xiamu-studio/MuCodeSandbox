import path from 'node:path';
import {lstat,readFile,readdir,writeFile} from 'node:fs/promises';
import {fileHash,powershellPath,powershellArgs} from '../../server/platform/windows/runtime.ts';
import {run} from '../../server/process.ts';
import {buildInventory,captureBuildTree,plainBuildAncestors,removeRecordedBuildTree,type BuildTreeEntry} from './build-inventory.ts';

export interface BuildReceipt{format:1|2;kind:'MuCodeSandboxWindowsBuild';id:string;version:string;completedAt:string;stage:string;artifacts:{name:string;sha256:string}[];inventory?:{output:BuildTreeEntry[];stage:BuildTreeEntry[]}}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function artifactName(value:unknown):value is string{return typeof value==='string'&&value===path.basename(value)&&!/[\\/:<>"|?*\x00-\x1f]/.test(value)&&/\.(exe|blockmap)$/.test(value);}
function ownedPath(parent:string,prefix:string,id:string){if(!uuid.test(id))throw Error('Build ID rejected');const value=path.resolve(parent,prefix+id);if(path.dirname(value)!==path.resolve(parent))throw Error('Build cleanup absolute boundary rejected');return value;}
export async function pruneWindowsBuilds(root:string,keepOutput:string,keepStage:string,livePaths?:string[]){
 const release=path.resolve(root,'release'),data=path.resolve(root,'.mu-data'),removed:string[]=[],skipped:{path:string;reason:string}[]=[],records:{directory:string;receipt:BuildReceipt;receiptSha256:string}[]=[];
 await plainBuildAncestors(release);await plainBuildAncestors(data);
 for(const entry of await readdir(release,{withFileTypes:true})){
  if(!entry.isDirectory()||!entry.name.startsWith('windows-preview-')||!uuid.test(entry.name.slice(16)))continue;
  const directory=path.join(release,entry.name);
  try{const receiptPath=path.join(directory,'build-receipt.json');await plainBuildAncestors(receiptPath);const info=await lstat(receiptPath);if(!info.isFile()||info.size>32*1024*1024)throw Error('Build receipt file rejected');const receiptSha256=await fileHash(receiptPath),receipt=JSON.parse(await readFile(receiptPath,'utf8')) as BuildReceipt;
   if(![1,2].includes(receipt.format)||receipt.kind!=='MuCodeSandboxWindowsBuild'||receipt.id!==entry.name.slice(16)||!Number.isFinite(Date.parse(receipt.completedAt))||receipt.stage!==ownedPath(data,'windows-package-',receipt.id)||!Array.isArray(receipt.artifacts)||!receipt.artifacts.length||receipt.artifacts.length>16||new Set(receipt.artifacts.map(item=>item.name?.toLowerCase())).size!==receipt.artifacts.length)throw Error('Build receipt rejected');
   if(receipt.format===2){buildInventory(receipt.inventory?.output);buildInventory(receipt.inventory?.stage);}
   for(const artifact of receipt.artifacts){if(!artifactName(artifact.name)||!/^[a-f0-9]{64}$/.test(artifact.sha256)||await fileHash(path.join(directory,artifact.name))!==artifact.sha256)throw Error('Build artifact changed');}
   if(await fileHash(receiptPath)!==receiptSha256)throw Error('Build receipt changed during verification');records.push({directory,receipt,receiptSha256});
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')skipped.push({path:directory,reason:(error as Error).message});}
 }
 if(!records.length)return {removed,skipped};
 if(!livePaths){
  try{const json=await run(powershellPath(),powershellArgs("@(Get-CimInstance Win32_Process|ForEach-Object{if($_.ExecutablePath){$_.ExecutablePath};if($_.CommandLine){$_.CommandLine}})|ConvertTo-Json -Compress"),{timeoutMs:15000,maxBytes:4*1024*1024});livePaths=JSON.parse(json);}catch{return {removed,skipped:[...skipped,{path:release,reason:'Running-process references could not be checked'}]};}
 }
 if(!livePaths||!Array.isArray(livePaths)||livePaths.some(value=>typeof value!=='string'))return {removed,skipped:[...skipped,{path:release,reason:'Running-process references were incomplete'}]};
 const references=livePaths;
 records.sort((a,b)=>Date.parse(b.receipt.completedAt)-Date.parse(a.receipt.completedAt));
 const retain=new Set([path.resolve(keepOutput),...records.slice(0,2).map(record=>record.directory)]);
 for(const {directory,receipt,receiptSha256} of records){
  const stage=ownedPath(data,'windows-package-',receipt.id);
  for(const target of [stage,...(retain.has(directory)?[]:[directory])]){
   if(path.resolve(target)===path.resolve(keepStage))continue;
   try{
    try{await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(references.some(value=>value.toLowerCase().includes(target.toLowerCase())))throw Error('A running process still references this build');
    if(receipt.format!==2||!receipt.inventory)throw Error('Legacy build receipt has no complete inventory; preserved for separate review');
    await plainBuildAncestors(target);
    const receiptPath=path.join(directory,'build-receipt.json');await plainBuildAncestors(receiptPath);if(await fileHash(receiptPath)!==receiptSha256)throw Error('Build receipt changed before cleanup');
    if(target===stage){const pkg=JSON.parse(await readFile(path.join(target,'app/package.json'),'utf8'));if(pkg.name!=='mucodesandbox-windows-preview'||pkg.version!==receipt.version)throw Error('Staged package identity changed');}
    if(target!==ownedPath(target===stage?data:release,target===stage?'windows-package-':'windows-preview-',receipt.id))throw Error('Final cleanup boundary changed');
    await removeRecordedBuildTree(target,target===stage?receipt.inventory.stage:receipt.inventory.output,target===stage?undefined:{path:receiptPath,sha256:receiptSha256});removed.push(target);
   }catch(error){skipped.push({path:target,reason:(error as Error).message});}
  }
 }
 return {removed,skipped};
}
export async function saveBuildReceipt(output:string,stage:string,version:string,artifacts:string[]){
 const id=path.basename(stage).replace(/^windows-package-/,'');if(output!==ownedPath(path.dirname(output),'windows-preview-',id))throw Error('Build output receipt boundary rejected');
 if(path.basename(path.dirname(output))!=='release'||stage!==ownedPath(path.join(path.dirname(path.dirname(output)),'.mu-data'),'windows-package-',id))throw Error('Build stage receipt boundary rejected');
 if(!artifacts.length||artifacts.length>16||artifacts.some(file=>!artifactName(path.basename(file)))||new Set(artifacts.map(file=>file.toLowerCase())).size!==artifacts.length)throw Error('Build artifact list rejected');
 const receipt:BuildReceipt={format:2,kind:'MuCodeSandboxWindowsBuild',id,version,completedAt:new Date().toISOString(),stage,artifacts:await Promise.all(artifacts.map(async file=>{if(path.dirname(file)!==output)throw Error('Artifact output boundary rejected');return {name:path.basename(file),sha256:await fileHash(file)};})),inventory:{output:await captureBuildTree(output,true),stage:await captureBuildTree(stage)}};
 for(const artifact of receipt.artifacts){const entry=receipt.inventory!.output.find(item=>item.path===artifact.name);if(entry?.kind!=='file'||entry.sha256!==artifact.sha256)throw Error('Build artifact and inventory do not agree');}
 const text=JSON.stringify(receipt,null,2);if(Buffer.byteLength(text)>32*1024*1024)throw Error('Build receipt inventory exceeds its size limit');await writeFile(path.join(output,'build-receipt.json'),text,{flag:'wx'});return receipt;
}
