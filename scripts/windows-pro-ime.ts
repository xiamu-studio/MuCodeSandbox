import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {build} from 'vite';
import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {fileHash,powershellArgs,powershellPath} from '../server/platform/windows/runtime.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {run} from '../server/process.ts';
const index=JSON.parse(await readFile('.mu-data/windows-run/pro-host-lab.json','utf8')),directory=path.resolve(index.directory);
assert.equal(path.dirname(directory),path.resolve(windowsRuntimeDirectory()));assert.match(path.basename(directory),/^pro-host-[a-f0-9-]{36}$/);
const pro=JSON.parse(await readFile(path.join(directory,'config.json'),'utf8')),support=JSON.parse(await readFile(path.join(directory,'image-inputs.json'),'utf8'));
const caseId=randomUUID().replaceAll('-',''),folder=path.join(directory,'ime-payload-'+caseId),source=path.join(folder,'files'),ui=path.join(source,'ui'),zip=path.join(folder,'payload.zip');
await secureWindowsDirectory(folder);await mkdir(ui,{recursive:true});
// This bundle uses the unmodified production input components. Only the layout
// and local receivers are fixtures; no events or user gestures are synthesized.
await build({configFile:false,root:process.cwd(),logLevel:'error',build:{outDir:ui,emptyOutDir:false,lib:{entry:path.resolve('scripts/windows/pro-ime-ui.tsx'),formats:['es'],fileName:()=> 'fixture.js',cssFileName:'fixture'}},define:{'process.env.NODE_ENV':'"production"'}});
await writeFile(path.join(ui,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mu Windows IME 验收</title><link rel="stylesheet" href="/fixture.css"><link rel="stylesheet" href="/layout.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
await writeFile(path.join(ui,'layout.css'),'body{margin:8px;background:#f6f8f7}header{display:flex;gap:8px}.windows-browser-canvas{height:60px!important;min-height:60px!important}.terminal-tool{height:240px!important}.terminal-container{height:70px!important;min-height:50px!important;flex:none!important}.windows-terminal-input textarea{height:70px;min-height:70px}.windows-terminal-input{margin:8px 0}.windows-address{display:none}.section-heading{margin:4px 0}');
await copyFile('scripts/windows/pro-ime-electron.cjs',path.join(source,'pro-ime-electron.cjs'));
const files:Record<string,string>={};async function inventory(current:string){for(const entry of await readdir(current,{withFileTypes:true})){const file=path.join(current,entry.name);if(entry.isDirectory())await inventory(file);else{assert.ok(entry.isFile());files[path.relative(source,file).replaceAll('\\','/')]=await fileHash(file);}}}await inventory(source);
await run(powershellPath(),powershellArgs('Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($env:MU_IME_SOURCE,$env:MU_IME_ZIP)'),{env:{...process.env,MU_IME_SOURCE:source,MU_IME_ZIP:zip},timeoutMs:120000});
const sourceHashes:Record<string,string>={};for(const name of ['src/TerminalPanel.tsx','src/windows/WindowsBrowserView.tsx','src/windows/text-input.ts','src/terminal-input.ts'])sourceHashes[name]=await fileHash(name);
const meta={format:1,caseId,proNonce:pro.nonce,supportCase:support.caseId,electronSha256:await fileHash('node_modules/electron/dist/electron.exe'),zip,zipSha256:await fileHash(zip),files,sourceHashes};
await writeFile(path.join(directory,'ime-inputs.json'),JSON.stringify(meta,null,2));console.log('Native IME fixture prepared with local synthetic receivers.');
