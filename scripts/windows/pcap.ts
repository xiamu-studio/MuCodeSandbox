export interface CapturedFrame {data:Buffer;interfaceId:number;linkType:number;timestamp:bigint}

// Strict bounded readers for the Ethernet records used by the isolated lab.
// pcapng follows draft-ietf-opsawg-pcapng (SHB, IDB, EPB); malformed/truncated
// blocks are errors, never silently interpreted as an empty successful capture.
export function readPcapng(bytes:Buffer):CapturedFrame[]{
 let offset=0,little=true,section=false;let interfaces:number[]=[];const result:CapturedFrame[]=[];
 const u32=(at:number)=>little?bytes.readUInt32LE(at):bytes.readUInt32BE(at),u16=(at:number)=>little?bytes.readUInt16LE(at):bytes.readUInt16BE(at);
 while(offset<bytes.length){
  if(bytes.length-offset<12)throw Error('Truncated pcapng block');
  if(bytes.readUInt32LE(offset)===0x0a0d0d0a){if(bytes.length-offset<28)throw Error('Truncated pcapng section');const magic=bytes.readUInt32LE(offset+8);if(![0x1a2b3c4d,0x4d3c2b1a].includes(magic))throw Error('Invalid pcapng byte order');little=magic===0x1a2b3c4d;section=true;interfaces=[];}
  if(!section)throw Error('pcapng section header required');
  const kind=u32(offset),size=u32(offset+4);if(size<12||size%4||size>bytes.length-offset||u32(offset+size-4)!==size)throw Error('Invalid pcapng block length');
  if(kind===0x0a0d0d0a&&(size<28||u16(offset+12)!==1))throw Error('Unsupported pcapng section header');
  if(kind===1){if(size<20)throw Error('Truncated pcapng interface');interfaces.push(u16(offset+8));}
  if(kind===6){
   if(size<32)throw Error('Truncated pcapng packet');const id=u32(offset+8),captured=u32(offset+20),original=u32(offset+24);
   if(interfaces[id]===undefined||captured>original||28+Math.ceil(captured/4)*4>size-4)throw Error('Invalid pcapng packet bounds');
   result.push({data:bytes.subarray(offset+28,offset+28+captured),interfaceId:id,linkType:interfaces[id],timestamp:(BigInt(u32(offset+12))<<32n)|BigInt(u32(offset+16))});
  }
  offset+=size;
 }
 if(!section)throw Error('Empty pcapng capture');return result;
}
export function readPcap(bytes:Buffer):CapturedFrame[]{
 if(bytes.length<24)throw Error('Truncated pcap header');const magic=bytes.readUInt32LE(0);if(![0xa1b2c3d4,0xd4c3b2a1].includes(magic))throw Error('Unsupported pcap format');const little=magic===0xa1b2c3d4,u32=(at:number)=>little?bytes.readUInt32LE(at):bytes.readUInt32BE(at),linkType=u32(20),frames:CapturedFrame[]=[];let offset=24;
 while(offset<bytes.length){if(bytes.length-offset<16)throw Error('Truncated pcap record');const captured=u32(offset+8),original=u32(offset+12);if(captured>original||captured>bytes.length-offset-16)throw Error('Invalid pcap record bounds');frames.push({data:bytes.subarray(offset+16,offset+16+captured),interfaceId:0,linkType,timestamp:BigInt(u32(offset))*1000000n+BigInt(u32(offset+4))});offset+=16+captured;}
 return frames;
}
export function ethernet(frame:CapturedFrame){if(frame.linkType!==1||frame.data.length<14)throw Error('Ethernet packet required');return {source:frame.data.subarray(6,12).toString('hex'),destination:frame.data.subarray(0,6).toString('hex'),type:frame.data.readUInt16BE(12)};}
