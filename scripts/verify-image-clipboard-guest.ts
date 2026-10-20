import {readFile,writeFile,mkdir} from 'node:fs/promises';import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';
import {LimaRuntime} from '../server/runtime.ts';import {imageClipboardSetupScript,IMAGE_CLIPBOARD_SEND} from '../server/guest-image-clipboard.ts';import {fixturePng} from './clipboard-image-fixture.ts';
// Separate synthetic X display/units: never touch the user's production clipboard.
const dataDir='/Users/staff/.mucodesandbox',id='76c193f7-09a2-4544-83b8-4852445ab2be',out='test-results/image-clipboard';await mkdir(out,{recursive:true});
const info=JSON.parse(await readFile(dataDir+'/service-info.json','utf8'));const launch=await fetch(info.launchUrl,{redirect:'manual'});const cookie=launch.headers.get('set-cookie')!.split(';')[0];const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();const cfg=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const api=async(path:string)=>{const r=await fetch(info.url+'/api'+path,{headers:{Cookie:cookie,Authorization:'Bearer '+cfg.token}});assert.ok(r.ok);return r.json();};const snapshot=await api('/snapshot'),e=snapshot.environments.find((v:any)=>v.id===id);assert.equal(e.state,'running');assert.equal((await api('/environments/'+id+'/network/protection')).active,true);
const runtime=new LimaRuntime(dataDir),tag='mu-image-fixture-'+randomBytes(4).toString('hex'),directory='/run/'+tag,display=':198',unit=tag+'-display.service',helper='/usr/local/libexec/'+tag;
const run=(script:string)=>runtime.management(e,['bash','-s'],{input:script,timeoutMs:15000,maxBytes:8000,onOutput:undefined});
const png=fixturePng(),expected=createHash('sha256').update(png).digest('hex');let report:any={passed:false,tag,scope:'Synthetic PNG on a separate X display; production image/text clipboard untouched'};
try{
 await run(`set -eu
test ! -e /tmp/.X11-unix/X198
sudo install -d -o dev -g dev -m 0700 ${directory}
sudo -H -u dev python3 - <<'AUTH'
import subprocess,secrets,pathlib
p=pathlib.Path('${directory}/auth');p.touch(mode=0o600)
subprocess.run(['xauth','-f',str(p),'add','${display}','.',secrets.token_hex(16)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
AUTH
sudo tee /etc/systemd/system/${unit} >/dev/null <<'UNIT'
[Service]
User=dev
Group=dev
ExecStart=/usr/bin/Xvfb ${display} -screen 0 64x48x24 -nolisten tcp -auth ${directory}/auth
KillMode=control-group
UNIT
sudo systemctl daemon-reload
sudo systemctl start ${unit}
for i in $(seq 1 30); do if sudo -u dev env DISPLAY=${display} XAUTHORITY=${directory}/auth xdpyinfo >/dev/null 2>&1; then exit 0; fi; sleep .1; done
exit 1
`);
 const setup=imageClipboardSetupScript().replaceAll('mucodesandbox-display.service',unit).replaceAll('mucodesandbox-image-clipboard',tag).replaceAll('mucodesandbox-clipboard.service',tag+'-unused.service').replaceAll('/run/mucodesandbox-clipboard',directory).replaceAll('/usr/local/libexec/mu-image-clipboard',helper).replaceAll('DISPLAY=:99','DISPLAY='+display).replaceAll('/run/mu-browser/Xauthority',directory+'/auth');
 await run(setup);
 const sender=IMAGE_CLIPBOARD_SEND.replaceAll('/run/mucodesandbox-clipboard',directory);
 const result=JSON.parse(await runtime.management(e,['sudo','-H','-u','dev','--','python3','-c',sender],{input:JSON.stringify({data:png.toString('base64')}),timeoutMs:20000,maxBytes:1000,onOutput:undefined}));assert.equal(result.ok,true);
 const verify=`import subprocess,hashlib,json,pathlib,os\ndata=subprocess.check_output(['xclip','-selection','clipboard','-out','-target','image/png'],timeout=3)\nprint(json.dumps({'sha256':hashlib.sha256(data).hexdigest(),'files':sorted(p.name for p in pathlib.Path('${directory}').iterdir())}))`;
 const actual=JSON.parse(await runtime.management(e,['sudo','-H','-u','dev','--','env','DISPLAY='+display,'XAUTHORITY='+directory+'/auth','python3','-c',verify],{timeoutMs:5000,maxBytes:1000,onOutput:undefined}));assert.equal(actual.sha256,expected);assert.deepEqual(actual.files,['auth','image.sock']);
 await run('sudo systemctl stop '+unit);
 await run(`test ! -S ${directory}/image.sock\n! systemctl is-active --quiet ${tag}.socket`);
 assert.equal((await api('/environments/'+id+'/network/protection')).active,true);
 report={...report,passed:true,pngRoundtripSha256:expected,noImageFileCreated:true,stoppingDisplayRemovedSocket:true,productionProtectionActive:true};
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 await run(`sudo systemctl stop '${tag}@*.service' ${tag}.socket ${unit} 2>/dev/null || true
sudo rm -f /etc/systemd/system/${tag}.socket /etc/systemd/system/${tag}@.service /etc/systemd/system/${unit} ${helper}
sudo rm -f ${directory}/auth
sudo rmdir ${directory} 2>/dev/null || true
sudo systemctl daemon-reload`).catch(()=>{});
 await writeFile(out+'/guest.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
