import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { retainedFrameUpdatesSource } from './retained-frame-updates.ts';
import { nativeFrameEncodingSource } from './native-frame-encoding.ts';
import {WINDOWS_RUNTIME_SCRIPTS,WINDOWS_RUNTIME_SOURCES} from './windows/runtime-files.ts';
const root=path.resolve(import.meta.dirname,'..');
const codecSource=path.join(root,'desktop/third-party-source/novnc-1.7.0/core/base64.js');
await mkdir(path.dirname(codecSource),{recursive:true});
await writeFile(codecSource,nativeFrameEncodingSource(await readFile(path.join(root,'node_modules/@novnc/novnc/core/base64.js'),'utf8')));
await writeFile(path.join(path.dirname(codecSource),'rfb.js'),retainedFrameUpdatesSource(await readFile(path.join(root,'node_modules/@novnc/novnc/core/rfb.js'),'utf8')));
async function walk(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())out.push(...await walk(file));else if(entry.isFile())out.push(file);}return out;}
const files=[...await walk(path.join(root,'dist')),...await walk(path.join(root,'dist-server')),...await walk(path.join(root,'desktop')),
  ...WINDOWS_RUNTIME_SCRIPTS.map(file=>path.join(root,'scripts/windows',file)),
  ...WINDOWS_RUNTIME_SOURCES.map(file=>path.join(root,'native/windows',file))].sort();
const digest=createHash('sha256');for(const file of files){digest.update(path.relative(root,file));digest.update(await readFile(file));}
const info={buildId:digest.digest('hex').slice(0,16),builtAt:new Date().toISOString(),channel:'local-test'};
await writeFile(path.join(root,'build-info.json'),JSON.stringify(info,null,2));console.log(`Local build ${info.buildId}`);
