import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPcap,readPcapng,ethernet} from '../scripts/windows/pcap.ts';
import {run} from '../server/process.ts';
import {powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
import path from 'node:path';
import {internetChecksum,validateSyntheticFrame} from '../scripts/windows/packet-validation.ts';

const frame=Buffer.concat([Buffer.from('02112233445500155d11223388b5','hex'),Buffer.from('synthetic frame')]);
function capture(little=true,packet=frame){
 const put=(bytes:Buffer,value:number,offset:number)=>little?bytes.writeUInt32LE(value,offset):bytes.writeUInt32BE(value,offset);
 const block=(kind:number,body:Buffer)=>{const size=12+body.length,bytes=Buffer.alloc(size);put(bytes,kind,0);put(bytes,size,4);body.copy(bytes,8);put(bytes,size,size-4);return bytes;};
 const sh=Buffer.alloc(16);put(sh,0x1a2b3c4d,0);if(little)sh.writeUInt16LE(1,4);else sh.writeUInt16BE(1,4);sh.fill(255,8);
 const id=Buffer.alloc(8);if(little)id.writeUInt16LE(1);else id.writeUInt16BE(1);put(id,256,4);
 const body=Buffer.alloc(20+Math.ceil(packet.length/4)*4);put(body,1,8);put(body,packet.length,12);put(body,packet.length,16);packet.copy(body,20);
 return {bytes:Buffer.concat([block(0x0a0d0d0a,sh),block(1,id),block(6,body)]),put};
}
test('Packet evidence reads both pcapng byte orders and preserves Ethernet payloads',()=>{
 for(const little of [true,false]){const frames=readPcapng(capture(little).bytes);assert.equal(frames.length,1);assert.deepEqual(frames[0].data,frame);assert.deepEqual(ethernet(frames[0]),{source:'00155d112233',destination:'021122334455',type:0x88b5});}
});
test('Truncated pcapng, inconsistent trailers and missing interfaces cannot become empty successful evidence',()=>{
 const {bytes,put}=capture();const badTrailer=Buffer.from(bytes);put(badTrailer,0,badTrailer.length-4);for(const invalid of [Buffer.alloc(0),bytes.subarray(0,bytes.length-1),badTrailer])assert.throws(()=>readPcapng(invalid));
 const missing=Buffer.from(bytes);put(missing,1,56);assert.throws(()=>readPcapng(missing));
 const short=Buffer.alloc(16);put(short,0x0a0d0d0a,0);put(short,16,4);put(short,0x1a2b3c4d,8);put(short,16,12);assert.throws(()=>readPcapng(short));
});
test('Classic receiver captures reject partial records and retain raw packet bytes',()=>{
 const header=Buffer.alloc(24);header.writeUInt32LE(0xa1b2c3d4);header.writeUInt16LE(2,4);header.writeUInt16LE(4,6);header.writeUInt32LE(256,16);header.writeUInt32LE(1,20);const record=Buffer.alloc(16);record.writeUInt32LE(frame.length,8);record.writeUInt32LE(frame.length,12);const bytes=Buffer.concat([header,record,frame]);assert.deepEqual(readPcap(bytes)[0].data,frame);assert.throws(()=>readPcap(bytes.subarray(0,bytes.length-1)));assert.throws(()=>readPcap(Buffer.alloc(0)));
});
test('Internet checksum matches the independent RFC 1071 example and rejects malformed synthetic headers',()=>{
 assert.equal(internetChecksum(Buffer.from('0001f203f4f5f6f7','hex')),0x220d);assert.throws(()=>validateSyntheticFrame({data:frame,interfaceId:0,linkType:1,timestamp:0n},'v4-tcp'));validateSyntheticFrame({data:frame,interfaceId:0,linkType:1,timestamp:0n},'l2-link');
});
test('Packet monitor state parsing refuses an existing session/filter in both supported locales',{skip:process.platform!=='win32'},async()=>{
 const file=path.resolve('scripts/windows/packet-observer.ps1').replaceAll("'","''");
 const script=`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
foreach($name in @('Idle','EmptyFilters')){$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true);. ([ScriptBlock]::Create($definition.Extent.Text))}
$zh=(-join ([char[]](0x6570,0x636e,0x5305,0x7b5b,0x9009,0x5668)))+':'+[char]10+'    '+[char]0x65e0
if(-not (EmptyFilters $zh) -or -not (EmptyFilters "Packet Filters:\n    None") -or (EmptyFilters "Packet Filters:\n    SomeFilter")){throw 'Unsafe filter-state interpretation'}
$idleText=-join ([char[]](0x6ca1,0x6709,0x8fd0,0x884c))
if(-not (Idle $idleText) -or -not (Idle 'Packet monitor is not running.') -or (Idle 'Packet monitor is running.')){throw 'Unsafe capture-state interpretation'}`;
 await run(powershellPath(),powershellArgs(script),{timeoutMs:10000});
});
