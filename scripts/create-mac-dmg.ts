import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,mkdtemp,rm,symlink,copyFile,stat,access} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {run} from '../server/process.ts';
const root=path.resolve(import.meta.dirname,'..'),app=path.resolve(process.env.MU_DMG_APP??path.join(root,'release/distribution-candidate/mac-arm64/MuCodeSandbox.app')),appRoot=path.join(app,'Contents/Resources/app');
const pkg=JSON.parse(await readFile(path.join(appRoot,'package.json'),'utf8')),build=JSON.parse(await readFile(path.join(appRoot,'build-info.json'),'utf8'));
const verified=JSON.parse(await readFile(path.join(root,'test-results/mac-distribution/verification.json'),'utf8'));assert.equal(verified.passed,true);assert.equal(verified.version,pkg.version);assert.equal(verified.build,build.buildId);
const output=path.join(root,'release/distribution',pkg.version);await mkdir(output,{recursive:true});const file=path.join(output,`MuCodeSandbox-${pkg.version}-mac-arm64.dmg`);await assert.rejects(access(file));
const owned=await mkdtemp(path.join(tmpdir(),'mu-dmg-package-')),stage=path.join(owned,'image'),mount=path.join(owned,'mounted');await mkdir(stage);await mkdir(mount);let mounted=false;
const report:Record<string,unknown>={passed:false,version:pkg.version,build:build.buildId,signature:'adhoc',notarized:false,secondMacTested:false,olderMacosTested:false};
try{
 await run('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeoutMs:60000});
 await run('/usr/bin/ditto',[app,path.join(stage,'MuCodeSandbox.app')],{timeoutMs:120000});await symlink('/Applications',path.join(stage,'Applications'));
 const note=path.join(root,'packaging/安装说明.txt');await copyFile(note,path.join(stage,'安装说明.txt'));await copyFile(note,path.join(output,'安装说明.txt'));
 await run('/usr/bin/hdiutil',['create','-volname',`MuCodeSandbox ${pkg.version}`,'-srcfolder',stage,'-format','UDZO','-imagekey','zlib-level=9',file],{timeoutMs:240000,onOutput:value=>process.stdout.write(value)});
 await run('/usr/bin/hdiutil',['verify',file],{timeoutMs:60000});
 await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,file],{timeoutMs:60000});mounted=true;
 const restored=path.join(mount,'MuCodeSandbox.app');await run('/usr/bin/codesign',['--verify','--deep','--strict',restored],{timeoutMs:60000});
 assert.equal(JSON.parse(await readFile(path.join(restored,'Contents/Resources/app/build-info.json'),'utf8')).buildId,build.buildId);assert.equal(await readFile(path.join(mount,'安装说明.txt'),'utf8'),await readFile(note,'utf8'));
 const hash=createHash('sha256').update(await readFile(file)).digest('hex');await writeFile(file+'.sha256',hash+'  '+path.basename(file)+'\n');report.sha256=hash;report.file=file;report.bytes=(await stat(file)).size;report.imageChecksumVerified=true;report.containedAppSignatureVerified=true;report.installationInstructionsIncluded=true;report.passed=true;
}catch(e){report.error=e instanceof Error?e.stack:String(e);process.exitCode=1;}finally{if(mounted)await run('/usr/bin/hdiutil',['detach',mount],{timeoutMs:60000});await rm(owned,{recursive:true,force:true});await writeFile(path.join(root,'test-results/mac-distribution/dmg.json'),JSON.stringify(report,null,2));if(report.passed)await writeFile(path.join(output,'安装包信息.json'),JSON.stringify({...report,file:path.basename(file)},null,2));console.log(JSON.stringify(report));}
