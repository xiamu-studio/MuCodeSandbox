import {ethernet,type CapturedFrame} from './pcap.ts';

export function internetChecksum(bytes:Buffer){let value=0;for(let i=0;i<bytes.length;i+=2)value+=bytes[i]*256+(bytes[i+1]??0);while(value>65535)value=(value%65536)+Math.floor(value/65536);return 65535-value;}

// A separate decoder checks the emitted bytes, not the sender's assertions.
export function validateSyntheticFrame(frame:CapturedFrame,label:string){
 const addresses=ethernet(frame),bytes=frame.data;
 if(label==='l2-link'){if(addresses.type!==0x88b5)throw Error('Synthetic link type mismatch');return;}
 const match=/^v([46])-(tcp|udp|icmp)$/.exec(label);if(!match)throw Error('Unknown synthetic protocol');const family=Number(match[1]),kind=match[2];let transport:Buffer,pseudo:Buffer,protocol:number;
 if(family===4){
  if(addresses.type!==0x0800||bytes.length<34||(bytes[14]>>4)!==4)throw Error('IPv4 header required');const header=(bytes[14]&15)*4,total=bytes.readUInt16BE(16);
  if(header<20||total<header||14+total>bytes.length||bytes.readUInt16BE(20)&0x3fff||internetChecksum(bytes.subarray(14,14+header))!==0)throw Error('Invalid synthetic IPv4 header');
  protocol=bytes[23];transport=bytes.subarray(14+header,14+total);pseudo=Buffer.alloc(12);bytes.copy(pseudo,0,26,34);pseudo[9]=protocol;pseudo.writeUInt16BE(transport.length,10);
 }else{
  if(addresses.type!==0x86dd||bytes.length<54||(bytes[14]>>4)!==6)throw Error('IPv6 header required');const size=bytes.readUInt16BE(18);if(54+size>bytes.length)throw Error('Truncated IPv6 payload');protocol=bytes[20];transport=bytes.subarray(54,54+size);pseudo=Buffer.alloc(40);bytes.copy(pseudo,0,22,54);pseudo.writeUInt32BE(size,32);pseudo[39]=protocol;
 }
 const expected=kind==='tcp'?6:kind==='udp'?17:family===4?1:58;if(protocol!==expected)throw Error('Synthetic protocol mismatch');
 if(kind==='tcp'&&(transport.length<20||(transport[12]>>4)*4<20||(transport[12]>>4)*4>transport.length))throw Error('Invalid TCP header');
 if(kind==='udp'&&(transport.length<8||transport.readUInt16BE(4)!==transport.length))throw Error('Invalid UDP length');
 if(kind==='icmp'&&transport.length<8)throw Error('Invalid ICMP header');
 if(internetChecksum(kind==='icmp'&&family===4?transport:Buffer.concat([pseudo,transport]))!==0)throw Error('Synthetic transport checksum is invalid');
}
