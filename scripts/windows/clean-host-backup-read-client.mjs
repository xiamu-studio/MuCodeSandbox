// Actual read-only production backup and encrypted file round-trip. This is not
// a VM import/restore test: the original VM/disk is preserved for a later reopen.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {openProtectedBackupRead} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/backup-reader.js';
import {writeWindowsBackupArchive,readWindowsBackupArchive,windowsBackupManifest} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/backup-archive.js';
import {fileHash} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/runtime.js';
export async function backupReadAcceptance(client,nonce,pass,runtime,c,seed){
 await assert.rejects(client.call('backup-begin',{id:c.id,directory:'C:\\Windows'}),{code:'INVALID_REQUEST'});await assert.rejects(client.call('backup-begin',{id:randomUUID()}),{code:'DENIED'});pass('Backup cannot select caller paths or an allocation not registered to the ordinary user');
 await runtime.start(c);await runtime.configure(c);assert.equal((await runtime.inspectGuard(c)).leaseActive,false);
 try{await assert.rejects(client.call('backup-begin',{id:c.id},{timeoutMs:90000}),{code:'BROKER_FAILED'});pass('A real running Linux disk cannot open a backup read session');}finally{await runtime.stop(c);}
 let reader=await openProtectedBackupRead(client,c.id);const info=reader.info;assert.equal(info.platformId,seed.platformId);assert.equal(info.diskGiB,c.diskGiB);assert.ok(!JSON.stringify(info).includes('C:'));
 try{
  for(const [action,parameters] of [['start',{}],['delete',{}],['grow-disk',{targetGiB:40}],['prepare',{}],['channel',{}]])await assert.rejects(client.call(action,{id:c.id,...parameters}),{code:'BACKUP_BUSY'});
  assert.equal((await runtime.state(c)).state,'Off');pass('A stopped original disk is pinned and native VM start, delete, growth, rebuild and channel operations refuse until release');
  await assert.rejects(client.call('backup-read',{id:c.id,session:randomUUID(),offset:0}),{code:'DENIED'});await assert.rejects(client.call('backup-read',{id:c.id,session:info.session,offset:1}),{code:'INVALID_REQUEST'});await assert.rejects(client.call('backup-read',{id:c.id,session:info.session,offset:0}),{code:'BACKUP_EXPIRED'});pass('Foreign session tokens and skipped offsets refuse, and an invalid read closes its original source lease');
 }finally{await reader.close();}
 reader=await openProtectedBackupRead(client,c.id);let first=0;for await(const bytes of reader.read()){first=bytes.length;break;}assert.equal(first,32768);await assert.rejects(client.call('backup-read',{id:c.id,session:reader.info.session,offset:first}),{code:'BACKUP_EXPIRED'});pass('Cancelling actual disk iteration releases the source handle without continuing later offsets');
 reader=await openProtectedBackupRead(client,c.id);
 try{
  const endpoint=await client.call('backup-stream',{id:c.id,session:reader.info.session});assert.match(endpoint.pipeName,/^MuCodeSandbox-Backup-[a-f0-9]{32}$/);
  const code="import {connect} from 'node:net';let count=0;const socket=connect('\\\\\\\\.\\\\pipe\\\\'+"+JSON.stringify(endpoint.pipeName)+");socket.on('connect',()=>socket.write(Buffer.from([46])));socket.on('data',bytes=>count+=bytes.length);socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);process.stdout.write(String(count));});const timer=setTimeout(()=>{socket.destroy();process.exitCode=1;},10000);";
  const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.resume();const exit=await new Promise(resolve=>child.once('close',resolve));assert.equal(exit,0);assert.equal(output,'0');
  await assert.rejects(client.call('backup-read',{id:c.id,session:reader.info.session,offset:0}),{code:'BACKUP_EXPIRED'});pass('A real second ordinary-user process cannot read any bytes from the binary disk pipe even when it knows the endpoint');
 }finally{await reader.close();}
 const archive='C:/MuLab/public/backup-read-'+nonce+'.mucwin',staging='C:/MuLab/public/backup-read-'+nonce+'.vhdx',password='synthetic-encrypted-backup-'+nonce;
 let output,restored;
 try{
  reader=await openProtectedBackupRead(client,c.id);assert.equal(reader.info.sha256,info.sha256);assert.equal(reader.info.bytes,info.bytes);
  const manifest=windowsBackupManifest.parse({version:1,architecture:'x86_64',platform:'hyperv',imageSha256:info.imageSha256,disk:{bytes:info.bytes,sha256:info.sha256},config:{name:'合成原盘备份',cpus:c.cpus,memoryGiB:c.memoryGiB,diskGiB:c.diskGiB,identity:{timezone:c.timezone,locale:'en-US'},network:{mode:'http',host:'127.0.0.1',port:9,strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.90'}}}});
  output=await open(archive,'wx');try{await writeWindowsBackupArchive({write:async bytes=>{let offset=0;while(offset<bytes.length){const written=await output.write(bytes,offset,bytes.length-offset);assert.ok(written.bytesWritten>0);offset+=written.bytesWritten;}}},reader.stream(),manifest,password);await output.sync();}finally{await output.close();output=undefined;await reader.close();}
  pass('The actual pinned standalone VHDX is fully exported through the typed native reader into an authenticated encrypted archive');
  let leaked=0;await assert.rejects(readWindowsBackupArchive(createReadStream(archive),{write:async bytes=>{leaked+=bytes.length;}},'incorrect-synthetic-password'),{code:'WINDOWS_BACKUP_INTEGRITY'});assert.equal(leaked,0);pass('The actual archive refuses an incorrect password before writing any plaintext disk data');
  restored=await open(staging,'wx');try{const readBack=await readWindowsBackupArchive(createReadStream(archive),{write:async bytes=>{let offset=0;while(offset<bytes.length){const written=await restored.write(bytes,offset,bytes.length-offset);assert.ok(written.bytesWritten>0);offset+=written.bytesWritten;}}},password);assert.deepEqual(readBack,manifest);await restored.sync();}finally{await restored.close();restored=undefined;}
  assert.equal(await fileHash(staging),info.sha256);pass('A separate new staging file decrypts with the complete original VHDX SHA-256 and configuration after final authentication');
  reader=await openProtectedBackupRead(client,c.id);assert.equal(reader.info.sha256,info.sha256);assert.equal(reader.info.platformId,seed.platformId);await reader.close();assert.equal((await runtime.state(c)).state,'Off');pass('Independent reopening confirms the source disk identity and byte hash are unchanged and the original VM remains Off');
  return {id:c.id,platformId:seed.platformId,diskBytes:info.bytes,originalDiskUnchanged:true,encryptedRoundTrip:true,vmRestoreExercised:false};
 }finally{await reader?.close().catch(()=>{});await output?.close();await restored?.close();for(const file of [archive,staging])try{await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
