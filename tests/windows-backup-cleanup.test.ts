import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm,link,symlink,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Store} from '../server/store.ts';
import {WindowsBackupCleanupRegistry} from '../server/platform/windows/backup-cleanup.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
import {cleanWindowsEnvironment} from '../server/platform/windows/broker.ts';
import {run} from '../server/process.ts';

const windows={skip:process.platform!=='win32',timeout:60000};
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'mu-backup-cleanup-')),runtime=path.join(root,'runtime'),app=path.join(root,'app'),key=randomBytes(32);await mkdir(runtime);let store=new Store(app,key);const children:ChildProcess[]=[];
 const registry=()=>new WindowsBackupCleanupRegistry(store,runtime);
 const next=async()=>{const id=randomUUID(),directory=path.join(runtime,'backup-work-'+id);await mkdir(directory);return{id,directory,owner:await registry().begin(directory)};};
 return{root,runtime,app,key,children,get store(){return store;},registry,next,reopen:()=>{store.close();store=new Store(app,key);},close:async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}}store.close();key.fill(0);const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.match(path.basename(target),/^mu-backup-cleanup-/);await rm(target,{recursive:true,force:true});}};
}
async function lock(file:string,children:ChildProcess[]){
 const script=`$ErrorActionPreference='Stop';$f=[IO.File]::Open('${file.replaceAll("'","''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}`;
 const child=spawn(powershellPath(),powershellArgs(script),{env:cleanWindowsEnvironment(),stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);
 await new Promise<void>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Synthetic read lock did not initialize')),10000);child.stdout!.on('data',bytes=>{text+=bytes;if(text.includes('LOCKED')){clearTimeout(timer);resolve();}});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Synthetic lock ended before ready'));});});
 return async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.stdin!.end('\n');await done;};
}
async function sealed(f:Awaited<ReturnType<typeof fixture>>){const work=await f.next();await work.owner.write('disk.vhdx',Buffer.from('synthetic sensitive disk'));const release=await lock(path.join(work.directory,'disk.vhdx'),f.children);await assert.rejects(work.owner.close(),{code:'BACKUP_CLEANUP_PENDING'});return{...work,release};}

test('Restore cleanup tracks original writes, ignores published claims, and removes only its exact private tree',windows,async()=>{
 const f=await fixture();try{const work=await f.next(),writer=await work.owner.open('disk.vhdx');assert.deepEqual(f.registry().issues(),[]);await Promise.all([writer.write(Buffer.from('first')),writer.write(Buffer.from('second'))]);await writer.sync();await writer.close();
  const relative='mu-win-'+randomUUID().replaceAll('-','');await work.owner.mkdir(relative);await work.owner.write(relative+'/management',Buffer.from('synthetic identity'));const published=path.join(f.root,'published');await rename(path.join(work.directory,relative),published);
  await work.owner.close();await assert.rejects(lstat(work.directory),{code:'ENOENT'});assert.equal(await readFile(path.join(published,'management'),'utf8'),'synthetic identity');assert.deepEqual(f.registry().issues(),[]);await work.owner.close();
 }finally{await f.close();}
});

test('Unknown additions are never adopted into a deletion receipt, even after reopening the encrypted store',windows,async()=>{
 const f=await fixture();try{const work=await f.next();await work.owner.write('disk.vhdx',Buffer.from('original synthetic disk'));await writeFile(path.join(work.directory,'personal.txt'),'unrelated user addition');await assert.rejects(work.owner.close(),{code:'BACKUP_CLEANUP_PENDING'});
  f.reopen();const registry=f.registry(),issue=registry.issues()[0];assert.equal(issue.id,work.id);assert.equal(issue.retryable,false);assert.match(issue.message,/明文/);await assert.rejects(registry.retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(work.directory,'personal.txt'),'utf8'),'unrelated user addition');assert.equal(await readFile(path.join(work.directory,'disk.vhdx'),'utf8'),'original synthetic disk');
 }finally{await f.close();}
});

test('Replaced and modified producer files are retained instead of being recaptured as disposable',windows,async()=>{
 for(const mode of ['replaced','modified']){const f=await fixture();try{const work=await f.next(),file=path.join(work.directory,'disk.vhdx');await work.owner.write('disk.vhdx',Buffer.from('original synthetic disk'));if(mode==='replaced')await rename(file,path.join(f.root,'original.vhdx'));await writeFile(file,'user data must remain');await assert.rejects(work.owner.close(),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(f.registry().issues()[0].retryable,false);await assert.rejects(f.registry().retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(file,'utf8'),'user data must remain');}finally{await f.close();}}
});

test('Hard links and junction replacements cannot extend cleanup authority to their external targets',windows,async()=>{
 for(const mode of ['hardlink','junction']){const f=await fixture();try{const work=await f.next(),outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'sentinel'),'outside user data');
   if(mode==='hardlink'){await work.owner.write('disk.vhdx',Buffer.from('own data'));await rename(path.join(work.directory,'disk.vhdx'),path.join(f.root,'old.vhdx'));await link(path.join(outside,'sentinel'),path.join(work.directory,'disk.vhdx'));}
   else{const relative='mu-win-'+randomUUID().replaceAll('-','');await work.owner.mkdir(relative);await rename(path.join(work.directory,relative),path.join(f.root,'old-directory'));await symlink(outside,path.join(work.directory,relative),'junction');}
   await assert.rejects(work.owner.close(),{code:'BACKUP_CLEANUP_PENDING'});await assert.rejects(f.registry().retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(outside,'sentinel'),'utf8'),'outside user data');
  }finally{await f.close();}}
});

test('A sealed read-lock failure survives restart, cancellation preserves it, and an explicit retry releases only its work',windows,async()=>{
 const f=await fixture();try{const work=await sealed(f);const row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(work.id) as {payload:string};assert.ok(row.payload.startsWith('enc:'));assert.equal(row.payload.includes(work.directory),false);assert.equal(row.payload.includes('synthetic sensitive disk'),false);
  await work.release();f.reopen();const registry=f.registry();assert.equal(registry.issues()[0].retryable,true);const cancelled=new AbortController();cancelled.abort();await assert.rejects(registry.retry(work.id,cancelled.signal),{name:'AbortError'});assert.equal(registry.issues().length,1);await registry.retry(work.id);assert.deepEqual(registry.issues(),[]);await assert.rejects(lstat(work.directory),{code:'ENOENT'});
 }finally{await f.close();}
});

test('A sealed receipt refuses foreign additions while allowing missing original files on a later retry',windows,async()=>{
 const f=await fixture();try{const work=await sealed(f);await work.release();const extra=path.join(work.directory,'personal.txt');await writeFile(extra,'preserve');const registry=f.registry();await assert.rejects(registry.retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(extra,'utf8'),'preserve');assert.equal(await readFile(path.join(work.directory,'disk.vhdx'),'utf8'),'synthetic sensitive disk');await rm(extra);await rm(path.join(work.directory,'disk.vhdx'));await registry.retry(work.id);assert.deepEqual(registry.issues(),[]);await assert.rejects(lstat(work.directory),{code:'ENOENT'});}finally{await f.close();}
});

test('Corrupt encrypted index rows expose an index issue and block every retry without throwing from issues',windows,async()=>{
 const f=await fixture();try{const work=await sealed(f);await work.release();f.store.db.prepare('INSERT INTO windows_backup_cleanup VALUES(?,?)').run(randomUUID(),'enc:not-an-authenticated-record');const registry=f.registry();assert.doesNotThrow(()=>registry.issues());assert.match(registry.issue??'',/索引/);await assert.rejects(registry.retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(work.directory,'disk.vhdx'),'utf8'),'synthetic sensitive disk');}finally{await f.close();}
});

test('Copying an index with the same key into a different Store directory cannot adopt the original work',windows,async()=>{
 const f=await fixture();let other:Store|undefined;try{const work=await f.next();await work.owner.write('disk.vhdx',Buffer.from('original work'));const row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(work.id) as {payload:string};other=new Store(path.join(f.root,'copied-app'),f.key);const registry=new WindowsBackupCleanupRegistry(other,f.runtime);other.db.prepare('INSERT INTO windows_backup_cleanup VALUES(?,?)').run(work.id,row.payload);assert.deepEqual(registry.issues(),[]);assert.match(registry.issue??'',/索引/);await assert.rejects(registry.retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(work.directory,'disk.vhdx'),'utf8'),'original work');await work.owner.close();}finally{other?.close();await f.close();}
});

test('Runtime root replacement cannot redirect cleanup into a new directory with the same work basename',windows,async()=>{
 const f=await fixture();try{const work=await sealed(f);await work.release();await rename(f.runtime,path.join(f.root,'old-runtime'));await mkdir(f.runtime);await mkdir(work.directory);await writeFile(path.join(work.directory,'disk.vhdx'),'replacement user data');await assert.rejects(f.registry().retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(work.directory,'disk.vhdx'),'utf8'),'replacement user data');assert.equal(await readFile(path.join(f.root,'old-runtime',path.basename(work.directory),'disk.vhdx'),'utf8'),'synthetic sensitive disk');}finally{await f.close();}
});

test('A live different creator blocks a sealed retry until its exact OS process has exited',windows,async()=>{
 const f=await fixture();try{const work=await sealed(f);await work.release();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore'],windowsHide:true});f.children.push(child);await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);});const started=(await run(powershellPath(),powershellArgs(`[Console]::Write([Diagnostics.Process]::GetProcessById(${child.pid}).StartTime.ToUniversalTime().Ticks.ToString())`),{env:cleanWindowsEnvironment(),timeoutMs:10000})).trim();
  const row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(work.id) as {payload:string},value=JSON.parse(f.store.decrypt(row.payload));value.owner={pid:child.pid,started};f.store.db.prepare('UPDATE windows_backup_cleanup SET payload=? WHERE id=?').run(f.store.encrypt(JSON.stringify(value)),work.id);await assert.rejects(f.registry().retry(work.id),{code:'BACKUP_CLEANUP_PENDING'});const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await stopped;await f.registry().retry(work.id);assert.deepEqual(f.registry().issues(),[]);
 }finally{await f.close();}
});

test('An actual producer process exit before sealing leaves a persistent warning but never grants deletion authority',windows,async()=>{
 for(const operation of ['restore','snapshot-identity']){const f=await fixture();try{const id=randomUUID(),directory=path.join(f.runtime,'backup-work-'+id),name=operation==='restore'?'disk.vhdx':'management-check';await mkdir(directory);const code=`import{Store}from ${JSON.stringify(pathToFileURL(path.resolve('server/store.ts')).href)};import{WindowsBackupCleanupRegistry}from ${JSON.stringify(pathToFileURL(path.resolve('server/platform/windows/backup-cleanup.ts')).href)};const data=JSON.parse(await new Promise(resolve=>{let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>resolve(text));}));const store=new Store(data.app,Buffer.from(data.key,'hex'));const owner=await new WindowsBackupCleanupRegistry(store,data.runtime).begin(data.directory,data.operation);const writer=await owner.open(data.name);await writer.write(Buffer.from('interrupted synthetic plaintext'));await writer.sync();console.log('PRODUCER_READY');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe'],windowsHide:true});f.children.push(child);child.stdin.end(JSON.stringify({app:f.app,key:f.key.toString('hex'),runtime:f.runtime,directory,operation,name}));await new Promise<void>((resolve,reject)=>{let text='',errors='';const timer=setTimeout(()=>reject(Error('Synthetic producer did not reach its boundary: '+errors)),15000);child.stderr.on('data',bytes=>errors+=bytes);child.stdout.on('data',bytes=>{text+=bytes;if(text.includes('PRODUCER_READY')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Synthetic producer exited early: '+errors));});child.once('error',error=>{clearTimeout(timer);reject(error);});});const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await stopped;f.reopen();const registry=f.registry(),issue=registry.issues()[0];assert.equal(issue.id,id);assert.equal(issue.retryable,false);assert.equal(registry.snapshotIssues().length,operation==='restore'?0:1);await assert.rejects(registry.retry(id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(directory,name),'utf8'),'interrupted synthetic plaintext');
 }finally{await f.close();}}
});

test('The encrypted index capacity rejects a new owner before it may write plaintext',windows,async()=>{
 const f=await fixture();try{const work=await f.next(),row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(work.id) as {payload:string},base=JSON.parse(f.store.decrypt(row.payload));for(let i=1;i<64;i++){const id=randomUUID(),value={...base,id,directory:path.join(f.runtime,'backup-work-'+id)};f.store.db.prepare('INSERT INTO windows_backup_cleanup VALUES(?,?)').run(id,f.store.encrypt(JSON.stringify(value)));}const next=path.join(f.runtime,'backup-work-'+randomUUID());await mkdir(next);await assert.rejects(f.registry().begin(next),{code:'BACKUP_CLEANUP_PENDING'});assert.deepEqual(await readdir(next),[]);await work.owner.close();}finally{await f.close();}
});

test('An explicitly created export workspace retains its private-key warning across reopen without adopting restore files',windows,async()=>{
 const f=await fixture();let release:(()=>Promise<void>)|undefined;
 try{
  const id=randomUUID(),directory=path.join(f.runtime,'backup-work-'+id);await mkdir(directory);const owner=await f.registry().begin(directory,'export'),file=path.join(directory,'management-check'),secret=Buffer.from('synthetic private export verification material');
  await owner.write('management-check',secret);await assert.rejects(owner.open('disk.vhdx'),{code:'BACKUP_CLEANUP_PENDING'});await assert.rejects(owner.mkdir('mu-win-'+randomUUID().replaceAll('-','')),{code:'BACKUP_CLEANUP_PENDING'});assert.deepEqual(await readdir(directory),['management-check']);
  release=await lock(file,f.children);await assert.rejects(owner.close(),{code:'BACKUP_CLEANUP_PENDING'});const row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(id) as {payload:string};assert.equal(JSON.parse(f.store.decrypt(row.payload)).kind,'windows-backup-export-work');assert.equal(row.payload.includes(secret.toString()),false);assert.equal(row.payload.includes(directory),false);assert.deepEqual(await readFile(file),secret);
  await release();f.reopen();const registry=f.registry(),issue=registry.issues()[0];assert.equal(issue.id,id);assert.equal(issue.retryable,true);assert.equal(issue.sensitiveDataMayRemain,true);await registry.retry(id);assert.deepEqual(registry.issues(),[]);await assert.rejects(lstat(directory),{code:'ENOENT'});
 }finally{await release?.();await f.close();}
});

test('Snapshot identity cleanup is limited to the two verification keys and cannot adopt another producer purpose',windows,async()=>{
 const f=await fixture();let release:(()=>Promise<void>)|undefined;
 try{
  const id=randomUUID(),directory=path.join(f.runtime,'backup-work-'+id);await mkdir(directory);const owner=await f.registry().begin(directory,'snapshot-identity');
  for(const name of ['disk.vhdx','seed.iso','management','management-check/extra','../host-check','host-check:extra'])await assert.rejects(owner.open(name),{code:'BACKUP_CLEANUP_PENDING'});await assert.rejects(owner.mkdir('mu-win-'+randomUUID().replaceAll('-','')),{code:'BACKUP_CLEANUP_PENDING'});
  await owner.write('management-check',Buffer.from('synthetic snapshot verification key'));release=await lock(path.join(directory,'management-check'),f.children);await assert.rejects(owner.close(),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(f.registry().snapshotIssues()[0].id,id);assert.equal(f.registry().issues()[0].id,id);
  const row=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(id) as {payload:string},record=JSON.parse(f.store.decrypt(row.payload));assert.equal(record.kind,'windows-snapshot-identity-work');record.kind='windows-backup-export-work';f.store.db.prepare('UPDATE windows_backup_cleanup SET payload=? WHERE id=?').run(f.store.encrypt(JSON.stringify(record)),id);assert.deepEqual(f.registry().snapshotIssues(),[]);assert.equal(f.registry().issues()[0].id,id);f.store.db.prepare('UPDATE windows_backup_cleanup SET payload=? WHERE id=?').run(row.payload,id);
  await release();release=undefined;f.reopen();await f.registry().retry(id);await assert.rejects(lstat(directory),{code:'ENOENT'});
  const restore=await f.next();await restore.owner.write('disk.vhdx',Buffer.from('synthetic restore disk'));const original=f.store.db.prepare('SELECT payload FROM windows_backup_cleanup WHERE id=?').get(restore.id) as {payload:string},foreign=JSON.parse(f.store.decrypt(original.payload));foreign.kind='windows-snapshot-identity-work';f.store.db.prepare('UPDATE windows_backup_cleanup SET payload=? WHERE id=?').run(f.store.encrypt(JSON.stringify(foreign)),restore.id);const invalid=f.registry();assert.deepEqual(invalid.snapshotIssues(),[]);assert.ok(invalid.issue);await assert.rejects(invalid.retry(restore.id),{code:'BACKUP_CLEANUP_PENDING'});assert.equal(await readFile(path.join(restore.directory,'disk.vhdx'),'utf8'),'synthetic restore disk');f.store.db.prepare('UPDATE windows_backup_cleanup SET payload=? WHERE id=?').run(original.payload,restore.id);await restore.owner.close();
 }finally{await release?.();await f.close();}
});
