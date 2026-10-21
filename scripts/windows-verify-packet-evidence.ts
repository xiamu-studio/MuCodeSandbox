import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {readPcap,readPcapng} from './windows/pcap.ts';
import {validateSyntheticFrame} from './windows/packet-validation.ts';
import {fileHash} from '../server/platform/windows/runtime.ts';

const directory=path.resolve(process.argv[2]??'');if(!/^packet-lab-[a-f0-9-]{36}$/.test(path.basename(directory)))throw Error('Explicit packet lab directory required');
const profile=JSON.parse(await readFile(path.join(directory,'profile.json'),'utf8'));if(!/^[a-f0-9]{64}$/.test(profile.nonce))throw Error('Packet evidence nonce missing');
const files=['sink.pcap','trace-artifacts/flow.pcapng','trace-artifacts/drop.pcapng'],hashes:Record<string,string>={};let checked=0;
for(const file of files){const full=path.join(directory,file);if((await stat(full)).size>64*1024*1024)throw Error('Packet evidence exceeds analysis bounds');const bytes=await readFile(full);hashes[file]=await fileHash(full);const frames=file==='sink.pcap'?readPcap(bytes):readPcapng(bytes);
 for(const frame of frames){const marker=frame.data.indexOf(`MU_PKT|${profile.nonce}|`);if(marker<0)continue;const fields=frame.data.subarray(marker).toString('ascii').split('|');validateSyntheticFrame(frame,fields[3]);checked++;}
}
if(checked<21)throw Error('Too few synthetic frames for independent validation');const verifierFiles=['scripts/windows-verify-packet-evidence.ts','scripts/windows/packet-validation.ts','scripts/windows/pcap.ts'];const verifierHashes=Object.fromEntries(await Promise.all(verifierFiles.map(async file=>[file,await fileHash(file)])));
await writeFile(path.join(directory,'packet-byte-validation.json'),JSON.stringify({checked,artifactHashes:hashes,verifierHashes,checksumsValid:true},null,2));console.log(JSON.stringify({checked,checksumsValid:true}));
