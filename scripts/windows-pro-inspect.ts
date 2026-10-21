// Read-only diagnostic inspection of the fixed, verified Windows Pro media.
// Format reference: https://github.com/ebiggers/wimlib/blob/master/include/wimlib/header.h
// The image is not deployed and no privileged DISM or disk operation is run.
import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {run} from '../server/process.ts';
import {fileHash,powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';
const index=JSON.parse(await readFile('.mu-data/windows-run/windows-pro-inspection.json','utf8')),directory=path.resolve(index.directory);
assert.equal(path.dirname(directory),path.resolve('.mu-data/windows-pro-assets'));assert.match(path.basename(directory),/^inspection-[a-f0-9]{32}$/);
const wim=path.join(directory,'sources/install.wim');
// Extracted from the ISO whose complete vendor-published digest was verified.
// This second pin is a local extraction digest, not a separately published hash.
const wimSha256=await fileHash(wim);
assert.equal(wimSha256,'35ed45902d2cca36e203896e4c234689214b3f4038e0c5d3ade27716aa7785c1');
const stream=await open(wim,'r');
async function exact(length:number,offset:number){const b=Buffer.alloc(length);let done=0;while(done<length){const r=await stream.read(b,done,length-done,offset+done);assert.ok(r.bytesRead);done+=r.bytesRead;}return b;}
let xml:string,count:number;
try{
 const h=await exact(208,0);assert.equal(h.subarray(0,8).toString('hex'),'4d5357494d000000');assert.equal(h.readUInt32LE(8),208);assert.equal(h.readUInt16LE(40),1);assert.equal(h.readUInt16LE(42),1);count=h.readUInt32LE(44);assert.ok(count>=1&&count<=64);
 // WIM resource layout, checked against the primary wimlib format definitions.
 const size=Number(h.readBigUInt64LE(72)&0xffffffffffffffn),flags=h[79],offset=Number(h.readBigUInt64LE(80)),original=Number(h.readBigUInt64LE(88));
 assert.equal(flags&0xfd,0);assert.equal(size,original);assert.ok(size>=2&&size<=1048576&&Number.isSafeInteger(offset));assert.ok(offset>=208&&offset+size<=(await stream.stat()).size);
 const bytes=await exact(size,offset);assert.equal(bytes.readUInt16LE(0),0xfeff);xml=bytes.subarray(2).toString('utf16le');assert.doesNotMatch(xml,/<!DOCTYPE|<!ENTITY/i);
}finally{await stream.close();}
const xmlFile=path.join(directory,'images.xml');await writeFile(xmlFile,xml);
const source="$ErrorActionPreference='Stop';$settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing='Prohibit';$settings.XmlResolver=$null;$reader=[Xml.XmlReader]::Create($env:MU_WIM_XML,$settings);try{$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;$doc.Load($reader);$images=@($doc.WIM.IMAGE|ForEach-Object{@{index=[int]$_.INDEX;name=[string]$_.NAME;edition=[string]$_.WINDOWS.EDITIONID;architecture=[int]$_.WINDOWS.ARCH;build=[int]$_.WINDOWS.VERSION.BUILD;revision=[int]$_.WINDOWS.VERSION.SPBUILD;language=[string]$_.WINDOWS.LANGUAGES.DEFAULT}});[Console]::Write((ConvertTo-Json -InputObject $images -Compress))}finally{$reader.Dispose()}";
const images=JSON.parse(await run(powershellPath(),powershellArgs(source),{env:{...process.env,MU_WIM_XML:xmlFile}}));assert.equal(images.length,count!);const pro=images.filter((i:{edition:string})=>i.edition==='Professional');assert.equal(pro.length,1);assert.equal(pro[0].architecture,9);assert.equal(pro[0].build,26300);assert.equal(pro[0].revision,9457);assert.equal(pro[0].language,'zh-CN');
const report={complete:true,scope:'read-only-vendor-wim-metadata',directory,wim,wimSha256,images,pro:pro[0],xmlSha256:await fileHash(xmlFile),isoSha256:'b795b52d598bf8fdea5975844731f4a50c5713876cefc513884354272b023af0',hostDiskOrVmOperations:0};
await writeFile('.mu-data/windows-run/windows-pro-editions.json',JSON.stringify(report,null,2));console.log(JSON.stringify({complete:true,images,pro:pro[0]}));
