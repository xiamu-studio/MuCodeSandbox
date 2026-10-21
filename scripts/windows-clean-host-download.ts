import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
import {downloadVerifiedAsset} from '../server/platform/windows/download.ts';
// Microsoft Evaluation Center, refreshed x64 media. The vendor PDF still lists
// a different digest; this refresh is pinned to independent original download
// observations, not represented as a Microsoft-published checksum.
const asset={url:'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso',sha256:'2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29'};
const directory=path.resolve('.mu-data/windows-clean-host-assets');await mkdir(directory,{recursive:true});const image=path.join(directory,'windows11-iot-enterprise-ltsc-eval-x64.iso');let last=0;
await downloadVerifiedAsset(asset,image,{maxBytes:10*1024**3,onProgress:(done,total)=>{if(Date.now()-last>10000){last=Date.now();console.log(`Official evaluation media: ${Math.floor(done/1048576)}/${Math.ceil(total/1048576)} MiB`);}}});
await writeFile(path.join(directory,'verified-iso.json'),JSON.stringify({image,imageSha256:asset.sha256,source:asset.url,hashSource:'https://github.com/ventoy/Ventoy/issues/3194',hashCorroboration:'https://github.com/rgl/windows-vagrant/blob/master/windows-evaluation-isos.json',vendorHashDocumentMismatch:'https://learn.microsoft.com/en-us/answers/questions/2181328/issue-broken-windows-11-iot-hashes-pdf-link',vendorPublishedChecksum:false},null,2));console.log('Refreshed Microsoft evaluation media matches the independently pinned SHA-256.');
