// Narrow static call-chain evidence; code presence is not runtime transmission.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const bytes=await readFile(path.join(root,'packages/2.1.296/claude'));
const hash=createHash('sha256').update(bytes).digest('hex');
assert.equal(hash,'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa');
const specs=[
 ['cryptoImports','import{randomBytes as vf,randomUUID as nH}',200000000,100,260],
 ['remoteIdGenerator','function LGs(e){return re().remoteControlMachineIdOnceFrom',200000000,80,700],
 ['remoteIdExport','LGs as getOrCreateRemoteControlMachineId',200000000,80,200],
 ['hostnameImport','import{hostname as Ir}from"os"',231600000,40,150],
 ['registrationArguments','st=Ir(),{getOrCreateRemoteControlMachineId:Et}',231720000,120,450],
 ['registrationPayload','let g={machine_name:r.machineName',231640000,40,850],
 ['profileCollector','async function rFr(n){try{let e=H()',231600000,40,1050],
 ['profileFields','async function oFr({includeMcpServers:n',231600000,40,1800],
];
const points=specs.map(([name,needle,from,before,after])=>{
 const offset=bytes.indexOf(needle,from);assert.ok(offset>=0,name+' missing');
 return{name,needle,offset,start:offset-before,end:offset+after,excerpt:bytes.subarray(offset-before,offset+after).toString()};
});
const generator=points.find(p=>p.name==='remoteIdGenerator').excerpt;
assert.ok(generator.includes('remoteControlMachineId')&&generator.includes('let r=nH()')&&generator.includes('wf('));
const payload=points.find(p=>p.name==='registrationPayload').excerpt;
assert.ok(payload.includes('/v1/environments/bridge')&&payload.includes('host:r.hostProfile')&&payload.includes('machine_id:r.machineId'));
const report={checkedAt:new Date().toISOString(),version:'2.1.296',binarySHA256:hash,points,
 findings:{separateRemoteControlUuidCodePath:true,bridgeMachineNameUsesOsHostname:true,
  bridgePayloadCanContainMachineIdAndHostProfile:true,hostProfileHasPlatformArchOsAndTools:true},
 scope:'Literal bounded source fragments in the verified native ELF. Remote Control eligibility and profile policy control execution; this does not prove these fields were read or sent in the live unauthenticated run.'};
await writeFile(path.join(root,'static/feature-paths.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({version:report.version,binarySHA256:hash,points:points.map(p=>({name:p.name,offset:p.offset})),findings:report.findings}));
