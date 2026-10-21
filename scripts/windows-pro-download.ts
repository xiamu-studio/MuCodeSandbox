import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {downloadVerifiedAsset} from '../server/platform/windows/download.ts';

// The expiring download URL is obtained through Microsoft's visible download
// form and remains private. Pin the language/build and vendor-published digest.
const directory=path.resolve('.mu-data/windows-pro-assets'),request=JSON.parse(await readFile(path.join(directory,'request.json'),'utf8'));
const sha256='b795b52d598bf8fdea5975844731f4a50c5713876cefc513884354272b023af0';
const url=new URL(request.url);
assert.equal(url.protocol,'https:');assert.equal(url.hostname,'software.download.prss.microsoft.com');
assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.port,'');
assert.equal(url.pathname,'/dbazure/Windows11_Client_x64_zh-cn_26300_9457.iso');
assert.equal(request.sha256,sha256);
await mkdir(directory,{recursive:true});const image=path.join(directory,'windows11-client-x64-zh-cn-26300.9457.iso');let last=0;
await downloadVerifiedAsset({url:url.href,sha256},image,{maxBytes:12*1024**3,onProgress:(done,total)=>{if(Date.now()-last>10000){last=Date.now();console.log(JSON.stringify({phase:'download',completedMiB:Math.floor(done/1048576),totalMiB:Math.ceil(total/1048576)}));}}});
await writeFile(path.join(directory,'verified-iso.json'),JSON.stringify({image,imageSha256:sha256,source:url.origin+url.pathname,hashSource:'https://www.microsoft.com/en-us/software-download/windows11',vendorPublishedChecksum:true,language:'zh-CN',build:'26300.9457',multiEdition:true,verifiedAt:new Date().toISOString()},null,2));
console.log('Official Chinese Windows 11 media matches the vendor-published SHA-256. Edition contents still require offline inspection.');
