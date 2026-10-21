import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {HyperVRuntime,powershellPath,powershellArgs} from '../../server/platform/windows/runtime.ts';
import {installedBrokerPath,startBroker,cleanWindowsEnvironment} from '../../server/platform/windows/broker.ts';
import {windowsConfigSchema} from '../../server/platform/windows/config.ts';
import {run} from '../../server/process.ts';
import {LAB_EXIT,LAB_DNS} from './local-fixtures.ts';

// Bake a trust root into one new synthetic fixture image. The production worker
// and packaged application receive no probe overrides or test-only entry points.
export async function desktopFixtureBase(directory:string,base:{image:string;imageSha256:string},certificate:string){
 const root=path.join(directory,'builder-runtime');await mkdir(root);const broker=await startBroker(await installedBrokerPath()),runtime=new HyperVRuntime(root,undefined,broker),c=windowsConfigSchema.parse({version:1,id:randomUUID(),...base,cpus:1,memoryGiB:2,diskGiB:32,proxy:{mode:'http',address:'127.0.0.1',port:1},expectedIp:LAB_EXIT,dns:LAB_DNS}),createdAt=new Date().toISOString();
 try{
  await runtime.create(c);await runtime.start(c);
  await runtime.management(c,['sudo','tee','/usr/local/share/ca-certificates/mu-desktop-fixture.crt'],{input:certificate});await runtime.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
  await runtime.management(c,['sudo','-H','-u','dev','--','python3','-c',"import pathlib,sys,os;p=pathlib.Path('/home/dev/.pki');p.mkdir(mode=0o700,exist_ok=True);(p/'nssdb').mkdir(mode=0o700,exist_ok=True);f=p/'mu-desktop-fixture.crt';f.write_bytes(sys.stdin.buffer.read());os.chmod(f,0o600)"],{input:certificate});
  await runtime.management(c,['sudo','-H','-u','dev','--','bash','-c',"if ! test -f /home/dev/.pki/nssdb/cert9.db;then certutil -N -d sql:/home/dev/.pki/nssdb --empty-password;fi;certutil -A -d sql:/home/dev/.pki/nssdb -n MuDesktopFixture -t 'C,,' -a -i /home/dev/.pki/mu-desktop-fixture.crt"]);
  const platformId=(await runtime.state(c)).platformId;let blocked=false;try{await runtime.freezeBase(c);}catch(error){if((error as {code?:string}).code!=='BROKER_EXPORT_UNAVAILABLE')throw error;blocked=true;}if(!blocked)throw Error('Unexpected fixture export path');
  const file=path.join(directory,'export-fixture.json');await writeFile(file,JSON.stringify({ownerPid:process.pid,id:c.id,platformId,createdAt}));const body=`& '${path.resolve('scripts/windows/export-desktop-lab-base.ps1').replaceAll("'","''")}' -LabConfigPath '${file.replaceAll("'","''")}'`,encoded=Buffer.from(body,'utf16le').toString('base64');
  await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$p=Start-Process -FilePath '${powershellPath().replaceAll("'","''")}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Synthetic fixture export failed'}`),{env:cleanWindowsEnvironment(),timeoutMs:120000});return JSON.parse(await readFile(path.join(directory,'fixture-base.json'),'utf8')) as {image:string;imageSha256:string};
 }finally{try{await runtime.remove(c);}finally{await broker.call('shutdown').catch(()=>{});}}
}
