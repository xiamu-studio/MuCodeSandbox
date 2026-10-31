import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createWindowsService,type WindowsServiceOptions} from '../server/platform/windows/service.ts';
import {backupFilePath,withBackupSource,validateBackupSourceHandle} from '../server/platform/windows/backup-service.ts';
const require=createRequire(import.meta.url),{createBackupDialogHandler}=require('../desktop/windows/backup-dialog.cjs');

test('Backup source close errors preserve the primary failure and cannot disguise a committed restore',async()=>{
 const closeError=Error('synthetic close failure'),primary=Error('synthetic restore failure');let warnings=0,closes=0;
 const handle={close:async()=>{closes++;throw closeError;}},warning=()=>{warnings++;};
 await assert.rejects(withBackupSource(handle,async()=>{throw primary;},true,warning),error=>error===primary);
 assert.equal(await withBackupSource(handle,async()=>'committed',true,warning),'committed');
 await assert.rejects(withBackupSource(handle,async()=>'reviewed',false,warning),error=>error===closeError);
 assert.equal(closes,3);assert.equal(warnings,2);
});
test('Opened backup identity is rechecked and failed checks close the handle without masking the original error',async()=>{
 const info={isFile:()=>true,nlink:1,ino:4,dev:2,size:100} as import('node:fs').Stats;let closed=0;
 const valid={stat:async()=>info,close:async()=>{closed++;}};assert.equal(await validateBackupSourceHandle(valid,info),valid);assert.equal(closed,0);
 const changed={stat:async()=>({...info,nlink:2}),close:async()=>{closed++;throw Error('synthetic close failure');}};
 await assert.rejects(validateBackupSourceHandle(changed,info),{code:'BACKUP_REVIEW_CHANGED'});assert.equal(closed,1);
 const statError=Error('synthetic stat failure'),failed={stat:async()=>{throw statError;},close:async()=>{closed++;throw Error('synthetic close failure');}};
 await assert.rejects(validateBackupSourceHandle(failed,info),error=>error===statError);assert.equal(closed,2);
});

test('Backup file selection requires a real gesture in the current focused main frame and invalidates navigation',async()=>{
 let gesture=true,focused=true,epoch=1,normal=true,calls=0,release:undefined|(()=>void),wait=false;
 const frame={url:'http://127.0.0.1:12345/',isDestroyed:()=>false},web={mainFrame:frame,executeJavaScriptInIsolatedWorld:async()=>gesture},window={webContents:web,isDestroyed:()=>false,isFocused:()=>focused},event={sender:web,senderFrame:frame};
 const dialog={showSaveDialog:async()=>{calls++;if(wait)await new Promise<void>(resolve=>release=resolve);return{canceled:false,filePath:'C:\\Backups\\synthetic.mucwin'};},showOpenDialog:async()=>{calls++;return{canceled:true,filePaths:[]};}};
 const handler=createBackupDialogHandler({dialog,getState:()=>({window,origin:'http://127.0.0.1:12345',epoch,normal})});
 for(const bad of ['foreign',{},null])await assert.rejects(handler(event,bad));
 await assert.rejects(handler({...event,sender:{}},'export'));focused=false;await assert.rejects(handler(event,'export'));focused=true;gesture=false;await assert.rejects(handler(event,'export'));gesture=true;normal=false;await assert.rejects(handler(event,'export'));normal=true;assert.equal(calls,0);
 assert.equal(await handler(event,'export'),'C:\\Backups\\synthetic.mucwin');assert.equal(await handler(event,'restore'),null);
 wait=true;const pending=handler(event,'export');while(!release)await new Promise(resolve=>setImmediate(resolve));await assert.rejects(handler(event,'export'));epoch++;release();await assert.rejects(pending,/已失效/);assert.equal(calls,3);
});
test('Backup paths reject UNC, device paths, alternate streams and nonarchives before touching disk',()=>{
 for(const input of ['\\\\server\\share\\backup.mucwin','\\\\?\\C:\\backup.mucwin','C:\\backup.mucwin:secret.mucwin','relative.mucwin','C:\\backup.vhdx','C:\\bad\0.mucwin'])assert.equal(backupFilePath.safeParse(input).success,false,input);
 assert.equal(backupFilePath.safeParse('D:\\备份\\合成.mucwin').success,true);
});
test('Backup API authenticates every endpoint and rejects mismatched passwords and extra fields',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-win-backup-api-'));await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<!-- MU_BOOTSTRAP -->');
 const runtime={info:async()=>({available:true,issues:[]}),fingerprint:async()=>'fixture',state:async()=>({state:'Off'}),stop:async()=>{}} as unknown as NonNullable<WindowsServiceOptions['runtime']>;
 const service=await createWindowsService({rootDir:root,dataDir:path.join(root,'app'),runtimeRoot:path.join(root,'runtime'),runtime});
 try{
  const launched=await fetch(service.launchUrl(),{redirect:'manual'}),cookie=launched.headers.get('set-cookie')!.split(';')[0],html=await(await fetch(service.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window\.__MU_CONFIG__=(\{.*?\});/)![1]);
  assert.equal(config.capabilities.backups,false);const headers={Cookie:cookie,Authorization:'Bearer '+config.token,'Content-Type':'application/json'},base=service.url+'/api/windows/backups';
  for(const endpoint of ['', '/export','/review','/restore','/cleanup','/output-cleanup','/discard']){const method=endpoint?'POST':'GET';assert.equal((await fetch(base+endpoint,{method,...(endpoint?{body:'{}'}:{})})).status,401);assert.equal((await fetch(base+endpoint,{method,headers:{...headers,Origin:'https://foreign.invalid'},...(endpoint?{body:'{}'}:{})})).status,403);}
  const post=(endpoint:string,body:unknown)=>fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)});
  for(const input of [{},{id:'../backup-work-test'},{id:'12345678-1234-4234-8234-123456789abc',path:'C:\\arbitrary'},{path:'C:\\arbitrary'}])for(const endpoint of ['/cleanup','/output-cleanup'])assert.equal((await post(endpoint,input)).status,400);
  for(const input of [{path:'C:\\backup.mucwin',password:'short'},{path:'\\\\foreign\\backup.mucwin',password:'synthetic-long-password'},{path:'C:\\backup.mucwin',password:'synthetic-long-password',unknown:true}])assert.equal((await post('/review',input)).status,400);
  assert.equal((await post('/export',{id:'12345678-1234-4234-8234-123456789abc',path:'C:\\backup.mucwin',password:'synthetic-long-password',passwordConfirmation:'different-long-password',confirmation:'Synthetic'})).status,400);
  assert.equal((await post('/review',{path:'C:\\backup.mucwin',password:'synthetic-long-password'})).status,409);
 }finally{await service.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
