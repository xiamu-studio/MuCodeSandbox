// Authorized no-account desktop compatibility test in the existing protected VM.
// The package is installed separately from its official download, not by this script.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';

const id='76c193f7-09a2-4544-83b8-4852445ab2be',root=path.resolve(import.meta.dirname,'..');
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
assert.equal(new URL(info.url).hostname,'127.0.0.1');
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string,body?:unknown) {
  const response=await fetch(info.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
}
const snapshot=await api('/api/snapshot'),e=snapshot.environments.find((e:any)=>e.id===id);
assert.ok(e&&e.state==='running'&&e.network.strict&&e.network.transparent);
assert.equal(e.identity.timezone,'America/Los_Angeles');assert.equal(e.identity.locale,'en-US');
await api(`/api/environments/${id}/network/test`,{});
const job=await api(`/api/environments/${id}/browser/open`,{showWindow:true});
let finished=false;for(let i=0;i<120;i++){
  const state=await api('/api/snapshot'),j=state.jobs.find((j:any)=>j.id===job.id);
  if(j&&['succeeded','failed','cancelled'].includes(j.status)){assert.equal(j.status,'succeeded',j.message);finished=true;break;}
  await new Promise(r=>setTimeout(r,500));
}assert.ok(finished,'Display opening exceeded 60 seconds');
const script=`set -euo pipefail
sudo install -d -o dev -g dev -m 0700 /home/dev/.local/share/mucodesandbox/desktop-tests /home/dev/.local/share/mucodesandbox/desktop-tests/grok-bot
sudo tee /etc/systemd/system/mucodesandbox-desktop-grok-test.service >/dev/null <<'MU_DESKTOP'
[Unit]
Description=MuCodeSandbox Grok Bot no-account desktop test
BindsTo=mucodesandbox-browser.service
After=mucodesandbox-browser.service
PartOf=mucodesandbox-browser.service
[Service]
Type=simple
User=dev
Group=dev
WorkingDirectory=/home/dev
UMask=0077
Environment=HOME=/home/dev USER=dev LOGNAME=dev PATH=/usr/local/bin:/usr/bin:/bin
Environment=DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
Environment=TZ=America/Los_Angeles LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
Environment=LP_NUM_THREADS=0 GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/usr/bin/grok-bot --user-data-dir=/home/dev/.local/share/mucodesandbox/desktop-tests/grok-bot --force-device-scale-factor=2 --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --use-gl=angle --use-angle=gl
KillMode=control-group
TimeoutStopSec=10
Restart=no
MU_DESKTOP
sudo chmod 0644 /etc/systemd/system/mucodesandbox-desktop-grok-test.service
sudo systemctl daemon-reload
sudo systemctl start mucodesandbox-desktop-grok-test.service
systemctl show mucodesandbox-desktop-grok-test.service --property=ActiveState --property=MainPID --property=ControlGroup
`;
const state=await run('/Users/staff/.mucodesandbox/tools/lima/bin/limactl',['shell',e.instanceName,'bash','-s'],{env:{...process.env,LIMA_HOME:'/Users/staff/.mucodesandbox/lima'},input:script,timeoutMs:30_000});
const report={preparedAt:new Date().toISOString(),environmentId:id,application:'Grok Bot',version:'0.68.1',architecture:'arm64',officialUrl:'https://downloads.cursor.com/grokbot/stable/33103062f95061ccf9c81c5b365d37ab152c3b66/linux/arm64/grok-bot_0.68.1_arm64.deb',packageSha256:'3f85fbe2ba3c1d122aa16f8be672076bc19146e07e9d431f37a93b85fa75a93f',downloadBytes:99336432,installedAdditionalMB:367,profile:'/home/dev/.local/share/mucodesandbox/desktop-tests/grok-bot',serviceState:state,accountLogin:false,paidModelCalls:0,newVmCreated:false,scope:'Desktop client startup test; Grok Bot cloud execution and account workflows not tested'};
await writeFile(path.join(root,'test-results/grok-desktop-preparation.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
