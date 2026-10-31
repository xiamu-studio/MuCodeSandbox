import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import {windowsPrivateDependencyResources,verifyWindowsWorkerImports} from '../scripts/windows/package-runtime-check.ts';
import {captureBuildTree,removeRecordedBuildTree} from '../scripts/windows/build-inventory.ts';

test('The runtime import gate loads real STUN private modules and refuses an omitted internal request module',async()=>{
 const root=path.resolve('.mu-data','windows-package-import-test-'+randomUUID());
 await mkdir(root,{recursive:true});
 try{
  for(const missing of ['none','stun','binary-data']){
   const app=path.join(root,missing);
   await mkdir(path.join(app,'dist-server/server/platform/windows'),{recursive:true});
   await writeFile(path.join(app,'package.json'),JSON.stringify({type:'module'}));
   for(const name of ['stun','binary-data'])await cp(path.resolve('node_modules',name),path.join(app,'node_modules',name),{recursive:true,filter:source=>missing!==name||path.relative(path.resolve('node_modules',name),source).replaceAll('\\','/')!==(name==='stun'?'src/node_modules/message/request.js':'src/node_modules/lib/binary-stream.js')});
   // The actual dependency must encode and decode before the no-owner guard.
   // Other mandatory dependency packages resolve from this repository's parent
   // node_modules; stun's own private modules resolve inside this exact copy.
   await writeFile(path.join(app,'dist-server/server/platform/windows/desktop-worker.js'),"import stun from 'stun'; const packet=stun.encode(stun.createMessage(stun.constants.STUN_BINDING_REQUEST)); const message=stun.decode(packet); if(message.type!==stun.constants.STUN_BINDING_REQUEST)throw Error('STUN roundtrip failed'); if(!process.connected)throw Error('Windows desktop worker requires its owning IPC channel');");
   if(missing==='none')assert.deepEqual(await verifyWindowsWorkerImports(process.execPath,app),{complete:true,node:process.version,workerImports:true,started:false});
   else await assert.rejects(verifyWindowsWorkerImports(process.execPath,app),missing==='stun'?/Cannot find module 'message\/request'/:/Cannot find module 'lib\/binary-stream'/);
  }
 }finally{
  assert.equal(path.dirname(root),path.resolve('.mu-data'));
  assert.match(path.basename(root),/^windows-package-import-test-[a-f0-9-]{36}$/);
  await removeRecordedBuildTree(root,await captureBuildTree(root));
 }
});

test('Unrelated import errors and an entry that never enforces an IPC owner cannot pass the import gate',async()=>{
 const root=path.resolve('.mu-data','windows-package-import-test-'+randomUUID());
 await mkdir(path.join(root,'dist-server/server/platform/windows'),{recursive:true});
 try{
  await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module'}));
  const entry=path.join(root,'dist-server/server/platform/windows/desktop-worker.js');
  await writeFile(entry,"throw Error('synthetic import failure');");
  await assert.rejects(verifyWindowsWorkerImports(process.execPath,root),/synthetic import failure/);
  await writeFile(entry,'export const loaded=true;');
  await assert.rejects(verifyWindowsWorkerImports(process.execPath,root),/Worker accepted a missing IPC owner/);
 }finally{
  assert.equal(path.dirname(root),path.resolve('.mu-data'));
  assert.match(path.basename(root),/^windows-package-import-test-[a-f0-9-]{36}$/);
  await removeRecordedBuildTree(root,await captureBuildTree(root));
 }
});

test('Private STUN modules are explicit resources at their original Node resolution location',()=>{
 const app=path.resolve('synthetic-staged-app');
 assert.deepEqual(windowsPrivateDependencyResources(app),['stun','binary-data'].map(name=>({from:path.join(app,'node_modules',name,'src/node_modules'),to:'app/node_modules/'+name+'/src/node_modules',filter:['**/*']})));
});
