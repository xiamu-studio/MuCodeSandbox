import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {LimaRuntime} from '../server/runtime.ts';
import {ensureDisplayEncoder,DISPLAY_ENCODER_EXECUTABLE,DISPLAY_ENCODER_BINARY_SHA256} from '../server/guest-display-encoder.ts';

const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const cfg=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(suffix:string){const r=await fetch(info.url+'/api/'+suffix,{headers:{Authorization:'Bearer '+cfg.token}});assert.ok(r.ok);return r.json();}
const snapshot=await api('snapshot'),e=snapshot.environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');
assert.equal(e.state,'running');const before=await api('environments/'+e.id+'/network/protection');assert.ok(before.active&&before.integrity==='verified'&&before.leaseActive);
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const inspect=`import pathlib,hashlib,json,subprocess
p=pathlib.Path('${DISPLAY_ENCODER_EXECUTABLE}');launcher=pathlib.Path('/usr/local/libexec/mu-guest-display')
print(json.dumps({'binarySha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None,'inode':p.stat().st_ino if p.exists() else None,'uid':p.stat().st_uid if p.exists() else None,'mode':oct(p.stat().st_mode&0o7777) if p.exists() else None,'notice':p.parent.parent.joinpath('LICENSE.txt').is_file(),'launcherSha256':hashlib.sha256(launcher.read_bytes()).hexdigest(),'productionActive':subprocess.run(['systemctl','is-active','--quiet','mucodesandbox-display.service']).returncode==0}))`;
async function state(){return JSON.parse(await runtime.management(e,['sudo','python3','-c',inspect],{timeoutMs:10000,maxBytes:2048}));}
const original=await state();const report:any={at:new Date().toISOString(),scope:'Pinned server-only component installation, repeat installation and checksum repair while the existing production display remains unchanged. No user profiles or external account pages.',before:original,passed:false};
let recoveryNeeded=false;
try{
 await ensureDisplayEncoder(runtime,e,{onOutput:text=>process.stdout.write(text)});
 const installed=await state();assert.equal(installed.binarySha256,DISPLAY_ENCODER_BINARY_SHA256);assert.equal(installed.uid,0);assert.equal(installed.mode,'0o755');assert.ok(installed.notice);
 await ensureDisplayEncoder(runtime,e);const repeated=await state();assert.equal(installed.inode,repeated.inode);report.idempotent=true;
 await runtime.management(e,['sudo','python3','-c',`import pathlib,shutil
p=pathlib.Path('${DISPLAY_ENCODER_EXECUTABLE}');backup=pathlib.Path('/var/cache/mucodesandbox-display/.verification-original')
assert not backup.exists()
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:assert entry.joinpath('exe').readlink()!=p,'The test component must not be running'
 except (FileNotFoundError,PermissionError):pass
shutil.copy2(p,backup);p.write_bytes(b'owned integrity fault fixture')`],{timeoutMs:10000,maxBytes:1024});recoveryNeeded=true;
 assert.notEqual((await state()).binarySha256,DISPLAY_ENCODER_BINARY_SHA256);
 await ensureDisplayEncoder(runtime,e);const repaired=await state();assert.equal(repaired.binarySha256,DISPLAY_ENCODER_BINARY_SHA256);report.corruptionRepaired=true;
 assert.equal(repaired.launcherSha256,original.launcherSha256);assert.equal(repaired.productionActive,original.productionActive);report.productionDisplayUnchanged=true;
 const after=await api('environments/'+e.id+'/network/protection');assert.ok(after.active&&after.integrity==='verified'&&after.leaseActive);assert.equal(after.firewallHash,before.firewallHash);assert.equal(after.tunnelConfigHash,before.tunnelConfigHash);report.guardUnchanged=true;report.after=repaired;report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 if(recoveryNeeded)await runtime.management(e,['sudo','python3','-c',`import pathlib,hashlib,os
p=pathlib.Path('${DISPLAY_ENCODER_EXECUTABLE}');backup=pathlib.Path('/var/cache/mucodesandbox-display/.verification-original')
assert hashlib.sha256(backup.read_bytes()).hexdigest()=='${DISPLAY_ENCODER_BINARY_SHA256}'
if hashlib.sha256(p.read_bytes()).hexdigest()!='${DISPLAY_ENCODER_BINARY_SHA256}':os.replace(backup,p)
else:backup.unlink()`],{timeoutMs:10000,maxBytes:1024});
 await writeFile('test-results/local-scroll-performance/display-encoder-install.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}
