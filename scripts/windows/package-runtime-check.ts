import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {run} from '../../server/process.ts';

// These private modules ship inside dependencies without package.json files. The
// electron-builder dependency collector omits them, although Node needs them.
export const WINDOWS_PRIVATE_DEPENDENCY_PATHS=['node_modules/stun/src/node_modules','node_modules/binary-data/src/node_modules'] as const;
export function windowsPrivateDependencyResources(app:string){
 return WINDOWS_PRIVATE_DEPENDENCY_PATHS.map(relative=>({from:path.join(app,relative),to:'app/'+relative,filter:['**/*']}));
}

// Load the real static import graph with the bundled Node, without an IPC owner
// or a start message. Reaching the no-owner guard must precede initialization;
// this requests no broker, VM or service and writes no application state.
export async function verifyWindowsWorkerImports(node:string,app:string){
 const require=createRequire(import.meta.url),{workerEnvironment}=require('../../desktop/windows/policy.cjs');
 const worker=pathToFileURL(path.join(app,'dist-server/server/platform/windows/desktop-worker.js')).href;
 const source=`try { await import(${JSON.stringify(worker)}); throw Error('Worker accepted a missing IPC owner'); } catch(error) { if(error?.message!=='Windows desktop worker requires its owning IPC channel') throw error; } console.log(JSON.stringify({complete:true,node:process.version,workerImports:true,started:false}));`;
 const output=await run(node,['--input-type=module'],{input:source,cwd:app,env:workerEnvironment(process.env,{}),timeoutMs:30000,maxBytes:65536});
 const result=JSON.parse(output.trim());
 if(result.complete!==true||result.workerImports!==true||result.started!==false)throw Error('Windows worker import validation failed');
 return result as {complete:true;node:string;workerImports:true;started:false};
}
