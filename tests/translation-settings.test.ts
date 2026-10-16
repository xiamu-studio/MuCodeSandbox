import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile,chmod,symlink,link,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {TranslationSettings,translationApiKey} from '../server/translation-settings.ts';
import {Store} from '../server/store.ts';
import {createService} from '../server/service.ts';
const key='sk-local-fixture-not-a-real-key';

test('Key is encrypted, owner-only, reloadable and never returned by status or environment storage',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mu-translation-settings-'));const store=new Store(dir),settings=new TranslationSettings(store);
 try{assert.equal(settings.status().configured,false);assert.throws(()=>settings.credential(),/Key/);settings.save(key);
  const file=path.join(dir,'translation-provider.json'),raw=await readFile(file,'utf8');assert.ok(!raw.includes(key));assert.ok(raw.includes('enc:'));assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal(new TranslationSettings(store).credential().apiKey,key);assert.ok(!JSON.stringify(settings.status()).includes(key));assert.equal(store.list().length,0);assert.ok(!JSON.stringify(store.logs(null)).includes(key));
  assert.equal((await readdir(dir)).some(p=>p.startsWith('.translation-')),false);settings.clear();assert.equal(settings.status().configured,false);
 }finally{store.db.close();await rm(dir,{recursive:true,force:true});}
});
test('Unsafe links, permissions, malformed/corrupt ciphertext and header injection are rejected',async()=>{
 for(const value of ['abc',key+'\nAuthorization: x',key+'"',key+' ',key+'\0'])if(value!==key+' ')assert.equal(translationApiKey.safeParse(value).success,false);
 const dir=await mkdtemp(path.join(tmpdir(),'mu-translation-settings-')),store=new Store(dir),settings=new TranslationSettings(store),file=path.join(dir,'translation-provider.json');
 try{settings.save(key);await chmod(file,0o644);assert.throws(()=>settings.status(),/安全读取/);assert.throws(()=>settings.save(key),/安全读取/);await chmod(file,0o600);await rm(file);
  const outside=path.join(dir,'other');await writeFile(outside,'do not change',{mode:0o600});await symlink(outside,file);assert.throws(()=>settings.clear(),/安全读取/);await rm(file);assert.equal(await readFile(outside,'utf8'),'do not change');
  await link(outside,file);assert.throws(()=>settings.status(),/安全读取/);await rm(file);await writeFile(file,JSON.stringify({version:1,encryptedKey:'enc:not-valid'}),{mode:0o600});assert.throws(()=>settings.credential(),/无法解密/);
 }finally{store.db.close();await rm(dir,{recursive:true,force:true});}
});
test('Settings endpoints require authority and never return Key; invalid endpoint/model fields cannot redirect secrets',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mu-translation-api-'));const browser={native:false,available:async()=>true,running:()=>false,open:async()=>{},close:async()=>{},clear:async()=>{},dispose:async()=>{}};
 const service=await createService({dataDir:dir,rootDir:path.resolve(import.meta.dirname,'..'),port:0,browser});const url=service.url+'/api/translation-settings';const headers={Authorization:'Bearer '+service.token,'Content-Type':'application/json'};
 try{assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify({apiKey:key})})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({apiKey:key,endpoint:'https://untrusted.example'})})).status,400);
  let r=await fetch(url,{method:'POST',headers,body:JSON.stringify({apiKey:key})});assert.equal(r.status,200);const result=await r.text();assert.ok(result.includes('true')&&!result.includes(key));
  r=await fetch(url,{headers});assert.ok(!(await r.text()).includes(key));r=await fetch(url,{method:'DELETE',headers});assert.equal((await r.json()).configured,false);
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
