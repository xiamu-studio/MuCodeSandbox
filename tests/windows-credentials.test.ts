import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {openWindowsStore,protectCurrentUser,secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {Store} from '../server/store.ts';
import {run} from '../server/process.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Windows stores use DPAPI without writing a plaintext master key',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-dpapi-'));let store:Store|undefined;
 try{
  store=await openWindowsStore(directory);const ciphertext=store.encrypt('fixture-credential-only');const key=Buffer.from(store.key);store.close();store=undefined;
  const disk=await readFile(path.join(directory,'credentials.dpapi'));assert.ok(!disk.includes(key));assert.ok(!(await readdir(directory)).includes('credentials.key'));
  store=await openWindowsStore(directory);assert.equal(store.decrypt(ciphertext),'fixture-credential-only');assert.deepEqual(store.key,key);key.fill(0);
  const corrupted=Buffer.from(disk);corrupted[corrupted.length-1]^=0xff;await assert.rejects(protectCurrentUser(corrupted,'unprotect'));
 }finally{store?.close();await rm(directory,{recursive:true,force:true});}
});
test('Default Store retains its existing file key behavior',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-default-store-'));const store=new Store(directory);
 try{assert.deepEqual(await readFile(path.join(directory,'credentials.key')),store.key);}finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('Windows data ACL removes an existing explicit Everyone grant',{skip:process.platform!=='win32'},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mu-acl-'));
 try{
  await run('icacls.exe',[directory,'/grant','*S-1-1-0:(OI)(CI)F']);await secureWindowsDirectory(directory);
  const result=await run(powershellPath(),powershellArgs(`$acl=[IO.Directory]::GetAccessControl('${directory.replaceAll("'","''")}'); $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); [Console]::Write(($rules | ForEach-Object {$_.IdentityReference.Value}) -join ',')`));
  assert.ok(!result.split(',').includes('S-1-1-0'));assert.ok(result.split(',').includes('S-1-5-18'));
 }finally{await rm(directory,{recursive:true,force:true});}
});
