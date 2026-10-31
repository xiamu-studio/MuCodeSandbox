import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm,symlink,unlink,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveBuildReceipt,pruneWindowsBuilds} from '../scripts/windows/build-retention.ts';
import {finalizeWindowsPackage} from '../scripts/windows/package-finalize.ts';
import {buildInventory,captureBuildTree,removeRecordedBuildTree} from '../scripts/windows/build-inventory.ts';
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'mu-build-retention-'));await mkdir(path.join(root,'release'));await mkdir(path.join(root,'.mu-data'));return root;}
async function cleanup(root:string){assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('mu-build-retention-'));await rm(root,{recursive:true,force:true});}
async function build(root:string,day:number,icon?:Buffer,publish=true){const id=randomUUID(),output=path.join(root,'release','windows-preview-'+id),stage=path.join(root,'.mu-data','windows-package-'+id);await mkdir(path.join(stage,'app/empty'),{recursive:true});await mkdir(path.join(output,'win-unpacked/resources/app'),{recursive:true});await writeFile(path.join(stage,'app/package.json'),JSON.stringify({name:'mucodesandbox-windows-preview',version:'0.4.66-preview.'+day}));await writeFile(path.join(stage,'app/runtime.js'),'synthetic runtime');await writeFile(path.join(output,'win-unpacked/resources/app/runtime.js'),'synthetic emitted runtime');if(icon){await mkdir(path.join(output,'.icon-ico'));await writeFile(path.join(output,'.icon-ico/icon.ico'),icon);}const exe=path.join(output,'setup.exe');await writeFile(exe,'Synthetic disposable package');if(!publish)return {output,stage};const receipt=await saveBuildReceipt(output,stage,'0.4.66-preview.'+day,[exe]);receipt.completedAt=`2026-10-${String(day).padStart(2,'0')}T00:00:00Z`;await writeFile(path.join(output,'build-receipt.json'),JSON.stringify(receipt));return {output,stage};}
test('Build retention keeps two releases and current stage while preserving unrelated data and unreceipted builds',async()=>{
 const root=await fixture();try{const a=await build(root,1),b=await build(root,2),c=await build(root,3),unknown=path.join(root,'release','windows-preview-'+randomUUID()),backup=path.join(root,'.mu-data','backups');await mkdir(unknown);await mkdir(backup);await writeFile(path.join(backup,'keep.mucwin'),'untouched');
  const result=await pruneWindowsBuilds(root,c.output,c.stage,[]);assert.deepEqual(new Set(result.removed),new Set([a.stage,b.stage,a.output]));for(const retained of [b.output,c.output,c.stage,unknown,backup])await access(retained);assert.equal(await readFile(path.join(backup,'keep.mucwin'),'utf8'),'untouched');
 }finally{await cleanup(root);}
});

test('A candidate awaiting independent review publishes its receipt without removing any previous release or stage',async()=>{
 const root=await fixture();try{
  const old=await build(root,1),previous=await build(root,2),current=await build(root,3,undefined,false),before=await Promise.all([old.output,old.stage,previous.output,previous.stage].map(target=>captureBuildTree(target)));
  const result=await finalizeWindowsPackage(root,current.output,current.stage,'0.4.66-preview.3',[path.join(current.output,'setup.exe')],true);
  assert.equal(result.deferred,true);assert.deepEqual(result.removed,[]);assert.deepEqual(result.skipped,[]);
  for(const [index,target]of [old.output,old.stage,previous.output,previous.stage].entries())assert.deepEqual(await captureBuildTree(target),before[index]);
  const receipt=JSON.parse(await readFile(path.join(current.output,'build-receipt.json'),'utf8'));assert.equal(receipt.format,2);assert.equal(receipt.version,'0.4.66-preview.3');assert.deepEqual(await captureBuildTree(current.output,true),receipt.inventory.output);assert.deepEqual(await captureBuildTree(current.stage),receipt.inventory.stage);
 }finally{await cleanup(root);}
});
test('Changed artifacts, live references and directory junctions block cleanup without touching their targets',async()=>{
 const root=await fixture();try{const a=await build(root,1),b=await build(root,2),c=await build(root,3);await writeFile(path.join(a.output,'setup.exe'),'changed');await pruneWindowsBuilds(root,c.output,c.stage,[b.stage]);await access(a.output);await access(a.stage);await access(b.stage);
  const outside=path.join(root,'source');await mkdir(outside);await writeFile(path.join(outside,'source.ts'),'keep source');assert.equal(path.dirname(path.resolve(b.stage)),path.resolve(root,'.mu-data'));await rm(b.stage,{recursive:true});await symlink(outside,b.stage,process.platform==='win32'?'junction':'dir');const result=await pruneWindowsBuilds(root,c.output,c.stage,[]);assert.ok(result.skipped.some(item=>item.path===b.stage&&item.reason.includes('reparse')));assert.equal(await readFile(path.join(outside,'source.ts'),'utf8'),'keep source');
 }finally{await cleanup(root);}
});

test('A later nested file in an old staged package is preserved with its whole tree',async()=>{
 const root=await fixture();try{const old=await build(root,1);await build(root,2);const current=await build(root,3),note=path.join(old.stage,'app','user-note.txt');await writeFile(note,'Not generated by the package build');const result=await pruneWindowsBuilds(root,current.output,current.stage,[]);assert.equal(await readFile(note,'utf8'),'Not generated by the package build');assert.ok(result.skipped.some(item=>item.path===old.stage));await access(path.join(old.stage,'app/package.json'));}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});

test('Nested output additions, changed bytes and empty directories preserve the complete old output',async t=>{
 for(const kind of ['file','changed','directory'])await t.test(kind,async()=>{const root=await fixture();try{const old=await build(root,1);await build(root,2);const current=await build(root,3),app=path.join(old.output,'win-unpacked/resources/app');if(kind==='file')await writeFile(path.join(app,'user.txt'),'keep nested file');if(kind==='changed')await writeFile(path.join(app,'runtime.js'),'user replacement');if(kind==='directory')await mkdir(path.join(app,'user-empty'));const result=await pruneWindowsBuilds(root,current.output,current.stage,[]);assert.ok(result.skipped.some(item=>item.path===old.output&&item.reason.includes('inventory')));await access(path.join(old.output,'setup.exe'));await access(path.join(app,'runtime.js'));if(kind==='file')assert.equal(await readFile(path.join(app,'user.txt'),'utf8'),'keep nested file');if(kind==='directory')await access(path.join(app,'user-empty'));}finally{await cleanup(root);}});
});

test('File identity and content are checked even when a known filename is reused',async t=>{
 for(const kind of ['replace','same-metadata'])await t.test(kind,async()=>{const root=await fixture();try{const directory=path.join(root,'recorded');await mkdir(directory);const file=path.join(directory,'runtime.js');await writeFile(file,'AAAA');const stamp=new Date('2026-10-20T01:02:03.000Z');await utimes(file,stamp,stamp);const inventory=await captureBuildTree(directory);if(kind==='replace'){await unlink(file);await writeFile(file,'AAAA');}else await writeFile(file,'BBBB');await utimes(file,stamp,stamp);await assert.rejects(removeRecordedBuildTree(directory,inventory),/inventory changed/);assert.equal(await readFile(file,'utf8'),kind==='replace'?'AAAA':'BBBB');}finally{await cleanup(root);}});
});

test('Old receipts without full inventories and future formats never authorize automatic cleanup',async t=>{
 for(const format of [1,3])await t.test(String(format),async()=>{const root=await fixture();try{const old=await build(root,1);await build(root,2);const current=await build(root,3),file=path.join(old.output,'build-receipt.json'),receipt=JSON.parse(await readFile(file,'utf8'));receipt.format=format;delete receipt.inventory;await writeFile(file,JSON.stringify(receipt));const result=await pruneWindowsBuilds(root,current.output,current.stage,[]);await access(old.output);await access(old.stage);assert.ok(result.skipped.some(item=>item.path===(format===1?old.stage:old.output)));}finally{await cleanup(root);}});
});

test('Inventory paths cannot escape, duplicate entries, omit parents or add unrecognized fields',async()=>{
 const root=await fixture();try{const directory=path.join(root,'recorded');await mkdir(directory);await writeFile(path.join(directory,'file'),'keep');const inventory=await captureBuildTree(directory);for(const relative of ['../source','C:/source','/absolute','one\\two','file:stream','a/../b','a//b','trailing.']){const changed=structuredClone(inventory);changed[1].path=relative;assert.throws(()=>buildInventory(changed));}const duplicated=structuredClone(inventory);duplicated.push({...duplicated[1],path:'FILE'});assert.throws(()=>buildInventory(duplicated));const missingParent=structuredClone(inventory);missingParent[1].path='missing/file';assert.throws(()=>buildInventory(missingParent));const extra=structuredClone(inventory) as (typeof inventory[number]&{unexpected?:boolean})[];extra[1].unexpected=true;assert.throws(()=>buildInventory(extra));assert.equal(await readFile(path.join(directory,'file'),'utf8'),'keep');}finally{await cleanup(root);}
});

test('A nested junction is preserved and its external target never enters inventory deletion',async()=>{
 const root=await fixture();try{const old=await build(root,1);await build(root,2);const current=await build(root,3),outside=path.join(root,'unrelated');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'untouched');await symlink(outside,path.join(old.stage,'app/attached'),process.platform==='win32'?'junction':'dir');const result=await pruneWindowsBuilds(root,current.output,current.stage,[]);assert.ok(result.skipped.some(item=>item.path===old.stage&&item.reason.includes('reparse')));assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'untouched');}finally{await cleanup(root);}
});

test('Receipt publication refuses overwrite and saves the exact stage and output inventories',async()=>{
 const root=await fixture();try{const current=await build(root,1),file=path.join(current.output,'build-receipt.json'),receipt=JSON.parse(await readFile(file,'utf8'));assert.equal(receipt.format,2);assert.deepEqual(await captureBuildTree(current.output,true),receipt.inventory.output);assert.deepEqual(await captureBuildTree(current.stage),receipt.inventory.stage);await assert.rejects(saveBuildReceipt(current.output,current.stage,'0.4.66-preview.1',[path.join(current.output,'setup.exe')]),{code:'EEXIST'});assert.equal((JSON.parse(await readFile(file,'utf8'))).completedAt,receipt.completedAt);}finally{await cleanup(root);}
});

test('Receipt publication rejects empty, duplicate and alternate-stream artifact lists',async()=>{
 const root=await fixture();try{const current=await build(root,1),exe=path.join(current.output,'setup.exe');for(const artifacts of [[],[exe,exe],[exe+':extra.exe']])await assert.rejects(saveBuildReceipt(current.output,current.stage,'0.4.66-preview.1',artifacts),/artifact list rejected/);}finally{await cleanup(root);}
});
test('Receipt-owned icon caches are removed while changed icons and added cache files remain',async t=>{
 for(const kind of ['same','changed','extra'])await t.test(kind,async()=>{
  const root=await fixture();try{const old=await build(root,1,Buffer.from([0,0,1,0,1,0,11,12]));await build(root,2);const current=await build(root,3,Buffer.from([0,0,1,0,1,0,21,22]));if(kind==='changed')await writeFile(path.join(old.output,'.icon-ico/icon.ico'),Buffer.from([0,0,1,0,1,0,21,22]));if(kind==='extra')await writeFile(path.join(old.output,'.icon-ico/user-note.txt'),'keep');
   const result=await pruneWindowsBuilds(root,current.output,current.stage,[]);if(kind==='same')assert.ok(result.removed.includes(old.output));else{await access(old.output);assert.ok(result.skipped.some(value=>value.path===old.output));if(kind==='extra')assert.equal(await readFile(path.join(old.output,'.icon-ico/user-note.txt'),'utf8'),'keep');}
  }finally{await cleanup(root);}
 });
});
