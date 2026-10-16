import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentSchema, proxyUrl } from '../server/validation.ts';
import { transparentConfig } from '../server/transparent-network.ts';
import { Store } from '../server/store.ts';
import { editConfig } from '../src/api.ts';
import type { Environment } from '../shared/types.ts';

let directory: string;
let ca: string;
let leaf: string;
let privateKey: string;
before(async () => {
  directory=await mkdtemp(path.join(tmpdir(),'mu-tls-unit-'));
  for(const [name,isCA] of [['ca',true],['leaf',false]] as const){
    const config=path.join(directory,`${name}.cnf`);
    await writeFile(config,`[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=Mu test ${name}\n[v3]\nbasicConstraints=critical,CA:${isCA?'TRUE':'FALSE'}\nkeyUsage=critical,${isCA?'keyCertSign,cRLSign':'digitalSignature,keyEncipherment'}\n`);
    await promisify(execFile)('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','2','-config',config,'-keyout',path.join(directory,`${name}.key`),'-out',path.join(directory,`${name}.pem`)],{timeout:10_000});
  }
  ca=await readFile(path.join(directory,'ca.pem'),'utf8');
  leaf=await readFile(path.join(directory,'leaf.pem'),'utf8');
  privateKey=await readFile(path.join(directory,'ca.key'),'utf8');
});
after(async () => {if(directory)await rm(directory,{recursive:true,force:true});});

const input=()=>({name:'Encrypted upstream',network:{mode:'https',host:'127.0.0.1',port:8443,username:'synthetic-user',password:'synthetic-password',strict:true,transparent:true,tls:{serverName:'proxy.test',certificate:ca}}});
const environment=():Environment=>({...environmentSchema.parse(input()),id:randomUUID(),instanceName:'mu-tls-unit',state:'stopped',lastError:null,browserRunning:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});

test('Encrypted proxy accepts explicit CA and rejects unsafe or unsupported TLS settings',()=>{
  const accepted=environmentSchema.parse(input());
  assert.equal(accepted.network.tls?.certificate,ca.trim());
  assert.equal(new URL(proxyUrl(accepted.network,true)).protocol,'https:');
  assert.equal(new URL(proxyUrl(accepted.network,true)).hostname,'host.lima.internal');
  assert.throws(()=>environmentSchema.parse({...input(),kind:'browser'}));
  for(const network of [
    {...input().network,strict:false},
    {...input().network,transparent:false},
    {...input().network,tls:undefined},
    {...input().network,tls:{serverName:''}},
    {...input().network,tls:{serverName:'proxy.test',insecure:true}},
    {...input().network,tls:{serverName:'proxy.test',certificate:leaf}},
    {...input().network,tls:{serverName:'proxy.test',certificate:privateKey}},
    {...input().network,tls:{serverName:'proxy.test',certificate:ca+ca}},
    {...input().network,tls:{serverName:'proxy.test',certificate:'invalid'}},
    {...input().network,mode:'http'},
  ])assert.throws(()=>environmentSchema.parse({name:'Invalid TLS',network}));
  assert.ok(environmentSchema.parse({...input(),network:{...input().network,tls:{serverName:'proxy.test'}}}));
});

test('Transparent HTTPS upstream verifies its separate server identity without direct or plaintext fallback',()=>{
  const e=environment();
  const config=transparentConfig(e,'192.0.2.4',999,[]);
  assert.deepEqual(config.outbounds.map(outbound=>outbound.type),['http']);
  assert.equal(config.outbounds[0].server,'192.0.2.4');
  assert.deepEqual(config.outbounds[0].tls,{enabled:true,server_name:'proxy.test',min_version:'1.2',alpn:['http/1.1'],certificate:[ca.trim()]});
  assert.equal(config.route.final,'upstream');
  assert.equal(config.dns.servers[0].detour,'upstream');
  assert.equal('insecure' in config.outbounds[0].tls!,false);
  e.network.tls=undefined;
  assert.throws(()=>transparentConfig(e,'192.0.2.4',999,[]));
});

test('Saved and edited TLS settings retain trust configuration while keeping the password private',()=>{
  const store=new Store(path.join(directory,'state'));
  try{
    const e=environment();store.save(e);
    const visible=store.public(store.get(e.id));
    assert.equal(visible.network.password,undefined);
    assert.equal(visible.network.passwordConfigured,true);
    const editable=editConfig(visible);
    assert.deepEqual(editable.network.tls,e.network.tls);
    assert.equal((editable.network as {password?:string}).password,undefined);
    assert.deepEqual(environmentSchema.parse(editable).network.tls,e.network.tls);
    const raw=store.db.prepare('SELECT config FROM environments WHERE id=?').get(e.id) as {config:string};
    assert.ok(!raw.config.includes('synthetic-password'));
    assert.deepEqual(store.get(e.id).network.tls,e.network.tls);
  }finally{store.close();}
});
