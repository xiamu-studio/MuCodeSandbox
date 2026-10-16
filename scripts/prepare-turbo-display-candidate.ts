import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {LimaRuntime} from '../server/runtime.ts';

const sha256='ad2448cd80997174c47b507e058fc385716aa9bd71c04e149f8da5a98fa77a9b';
const archive=await readFile('/tmp/mu-turbovnc-candidate/turbovnc_3.3.1_arm64.deb');
assert.equal(createHash('sha256').update(archive).digest('hex'),sha256);
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const cfg=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const snapshot=await(await fetch(info.url+'/api/snapshot',{headers:{Authorization:'Bearer '+cfg.token}})).json() as any;
const environment=snapshot.environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');assert.equal(environment.state,'running');
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const result=JSON.parse(await runtime.management(environment,['sudo','python3','-c',`import base64,hashlib,pathlib,sys,tempfile,subprocess,os,json
data=base64.b64decode(sys.stdin.read(),validate=True)
assert hashlib.sha256(data).hexdigest()=='${sha256}'
folder=pathlib.Path(tempfile.mkdtemp(prefix='mu-turbo-candidate.'));folder.chmod(0o755)
archive=folder/'package.deb';archive.write_bytes(data);archive.chmod(0o600)
subprocess.run(['dpkg-deb','-x',str(archive),str(folder/'root')],check=True)
(folder/'root').chmod(0o755)
binary=folder/'root/opt/TurboVNC/bin/Xvnc';assert binary.is_file() and not binary.is_symlink() and binary.stat().st_uid==0 and not binary.stat().st_mode&0o6022
print(json.dumps({'directory':str(folder),'executable':str(binary)}))`],{input:archive.toString('base64'),timeoutMs:60000,maxBytes:2048}));
const report={version:'3.3.1',expectedSha256:sha256,...result,scope:'Official hash-verified binary unpacked in an owned temporary directory. No maintainer scripts, system package installation, service replacement or guest profile access.'};
await writeFile('test-results/local-scroll-performance/turbo-candidate.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
