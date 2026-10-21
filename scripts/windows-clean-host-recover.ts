// Reassemble only the completed, rejected old-PDF download after independently
// pinning the exact refreshed release. Retain the original metadata and reject
// marker as evidence. This does not alter the production download verifier.
import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,access,rename} from 'node:fs/promises';import {createReadStream,createWriteStream} from 'node:fs';import {Readable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
const directory=path.resolve('.mu-data/windows-clean-host-assets'),target=path.join(directory,'windows11-iot-enterprise-ltsc-eval-x64.iso'),parts=target+'.parts';
const oldDigest='8abf91c9cd408368dc73aab3425d5e3c02dae74900742072eb5c750fc637c195',digest='2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29';
assert.equal(path.dirname(parts),directory);await assert.rejects(access(path.join(parts,'owner.json')),{code:'ENOENT'});await assert.rejects(access(target),{code:'ENOENT'});
const metadata=JSON.parse(await readFile(path.join(parts,'asset.json'),'utf8')),rejected=JSON.parse(await readFile(path.join(parts,'invalid.json'),'utf8'));
assert.equal(metadata.sha256,oldDigest);assert.equal(rejected.sha256,oldDigest);assert.equal(metadata.total,5060020224);assert.equal(metadata.chunk,8388608);
assert.equal(metadata.url,'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso');
const sha=createHash('sha256'),next=path.join(directory,'verified-'+randomUUID()+'.next');let bytes=0;
const blocks=async function*(){for(let i=0;i<Math.ceil(metadata.total/metadata.chunk);i++)for await(const block of createReadStream(path.join(parts,i+'.part')))yield block;};
await pipeline(Readable.from(blocks()),new Transform({transform(block,_encoding,done){sha.update(block);bytes+=block.length;done(null,block);}}),createWriteStream(next,{flags:'wx'}));
assert.equal(bytes,metadata.total);assert.equal(sha.digest('hex'),digest,'Refreshed-media pin mismatch; do not use this ISO');await rename(next,target);
const retained=path.join(directory,'old-document-rejection-'+randomUUID());assert.equal(path.dirname(retained),directory);assert.match(path.basename(retained),/^old-document-rejection-[a-f0-9-]{36}$/);await rename(parts,retained);
await writeFile(path.join(directory,'document-mismatch-evidence.json'),JSON.stringify({oldExpectedDigest:oldDigest,refreshedDigest:digest,originalRangeMetadata:metadata,originalRejectionMarker:rejected,retained,bytes,observations:['https://github.com/ventoy/Ventoy/issues/3194','https://github.com/rgl/windows-vagrant/blob/master/windows-evaluation-isos.json'],vendorDiscussion:'https://learn.microsoft.com/en-us/answers/questions/2181328/issue-broken-windows-11-iot-hashes-pdf-link',vendorPublishedChecksum:false},null,2));
console.log('Existing bytes match the independently pinned refresh; old rejection evidence retained.');
