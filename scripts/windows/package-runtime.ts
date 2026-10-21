import {cp,mkdir,readFile,writeFile,readdir,lstat,copyFile,access} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileHash,powershellPath,powershellArgs} from '../../server/platform/windows/runtime.ts';
import {run} from '../../server/process.ts';
import {WINDOWS_SOURCE_VERSION,windowsRelease} from '../../shared/windows-release.ts';

export const WINDOWS_NODE={version:'24.15.0',archive:'node-v24.15.0-win-x64.zip',sha256:'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62',url:'https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip'};
const root=path.resolve(import.meta.dirname,'../..');
export async function prepareWindowsPackage(options:{version?:string}={}){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows AMD64 packaging is required');
 const archive=path.join(root,'.mu-data/tools',WINDOWS_NODE.archive);await access(archive);if(await fileHash(archive)!==WINDOWS_NODE.sha256)throw Error('Official Node distribution checksum mismatch');
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
 const release=windowsRelease(options.version??WINDOWS_SOURCE_VERSION);
 const directory=path.join(root,'.mu-data','windows-package-'+randomUUID()),app=path.join(directory,'app'),node=path.join(directory,'node-runtime');await mkdir(app,{recursive:true});await mkdir(node);
 const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead('${archive.replaceAll("'","''")}');try{foreach($name in @('node.exe','LICENSE')){$entry=$zip.GetEntry('node-v${WINDOWS_NODE.version}-win-x64/'+$name);if(-not $entry){throw 'Node archive entry missing'};$inputStream=$entry.Open();try{$outputStream=[IO.File]::Open((Join-Path '${node.replaceAll("'","''")}' $name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$inputStream.CopyTo($outputStream)}finally{$outputStream.Dispose()}}finally{$inputStream.Dispose()}}}finally{$zip.Dispose()}`;
 await run(powershellPath(),powershellArgs(script),{timeoutMs:30000});
 const dependencyNames=Object.fromEntries(Object.entries(pkg.dependencies).filter(([name])=>name!=='node-pty-electron'));
 const stagePackage={name:'mucodesandbox-windows-preview',productName:'MuCodeSandbox Windows Preview',version:release.version,shortVersionWindows:release.fileVersion,private:true,type:'module',main:'desktop/windows/main.cjs',description:'Independent Hyper-V Linux environments for Windows.',author:'MuCodeSandbox',license:'UNLICENSED',dependencies:dependencyNames};
 await writeFile(path.join(app,'package.json'),JSON.stringify(stagePackage,null,2));
 const skip=(source:string)=>{const relative=path.relative(root,source).replaceAll('\\','/');if(relative.split('/').some(part=>['test','tests','__tests__','__mocks__','example','examples','.jest-cache','.cache','coverage','.nyc_output','.git','.github'].includes(part))||relative.endsWith('.pdb')||/\/third_party\/conpty\/[^/]+\/win10-(?!x64)[^/]+/.test(relative))return false;const match=/\/prebuilds\/([^/]+)/.exec(relative);return !match||match[1]==='win32-x64';};
 const modules=Object.entries(lock.packages as Record<string,{dev?:boolean}>).filter(([name,item])=>name.startsWith('node_modules/')&&!item.dev&&!name.startsWith('node_modules/node-pty-electron')).map(([name])=>name).sort((a,b)=>a.length-b.length);
 const copied:string[]=[];
 for(const name of modules){if(copied.some(parent=>name.startsWith(parent+'/')))continue;const source=path.join(root,name);try{await access(source);}catch{continue;}await cp(source,path.join(app,name),{recursive:true,filter:skip});copied.push(name);}
 await cp(path.join(root,'desktop/windows'),path.join(app,'desktop/windows'),{recursive:true});await cp(path.join(root,'dist'),path.join(app,'dist'),{recursive:true});await cp(path.join(root,'dist-server'),path.join(app,'dist-server'),{recursive:true});
 await writeFile(path.join(app,'dist-server/windows-release.json'),JSON.stringify({format:1,version:release.version,fileVersion:release.fileVersion},null,2));
 await mkdir(path.join(app,'dist-server/scripts/windows'),{recursive:true});await mkdir(path.join(app,'dist-server/native/windows'),{recursive:true});
 for(const file of ['hyperv.ps1','host-components.ps1','seed-iso.ps1','build-channel.ps1','build-broker.ps1','install-broker.ps1','clean-runtime-metadata.ps1'])await copyFile(path.join(root,'scripts/windows',file),path.join(app,'dist-server/scripts/windows',file));
 for(const file of ['HyperVBroker.cs','SealedBases.cs','HostComponents.cs','ProtectedLedger.cs','ImageCache.cs','ResourceMetrics.cs','Resources.cs','Recovery.cs','RecoveryPermissions.cs','PowerWatch.cs','PowerProtection.cs','HyperVChannel.cs','RuntimeMetadataCleanup.cs'])await copyFile(path.join(root,'native/windows',file),path.join(app,'dist-server/native/windows',file));
 for(const file of ['THIRD_PARTY_NOTICES.md','build-info.json'])await copyFile(path.join(root,file),path.join(app,file));
 await mkdir(path.join(app,'assets'));await copyFile(path.join(root,'assets/icon.png'),path.join(app,'assets/icon.png'));
 const nodeInfo={version:WINDOWS_NODE.version,sha256:await fileHash(path.join(node,'node.exe')),archiveSha256:WINDOWS_NODE.sha256,source:WINDOWS_NODE.url};
 const manifest=path.join(directory,'windows-runtime-manifest.json');await writeFile(manifest,JSON.stringify({format:1,channel:'unsigned-windows-preview',release:{version:release.version,fileVersion:release.fileVersion},node:nodeInfo,electron:{version:pkg.devDependencies.electron}},null,2));
 const audit=async(folder:string)=>{for(const entry of await readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if((await lstat(file)).isSymbolicLink())throw Error('Package must not include reparse entries');if(entry.isDirectory())await audit(file);else if(/\.(vhdx?|qcow2|sqlite|pem|key|pcapng?|etl)$/i.test(entry.name)||entry.name==='credentials.dpapi')throw Error('Private runtime data in Windows package');}};await audit(app);
 return {directory,app,node,nodeExe:path.join(node,'node.exe'),manifest,nodeInfo,release,electronVersion:pkg.devDependencies.electron,electron:path.join(root,'node_modules/electron/dist/electron.exe')};
}
