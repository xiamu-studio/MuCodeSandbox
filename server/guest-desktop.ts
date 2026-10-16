import { z } from 'zod';
import type { Environment } from '../shared/types.ts';
import type { DesktopAppId,DesktopAppsStatus } from '../shared/guest-desktop.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';
import { AppError } from './errors.ts';
import { shellQuote,linuxLocales } from './network-guard.ts';
import { GUEST_AUDIO_ENV } from './guest-audio.ts';
import { LINK_HELPER,parseGuestLink } from './guest-links.ts';

export const desktopAppSchema=z.enum(['grok-bot','claude-desktop']);
export const DESKTOP_RECIPES={
  'grok-bot':{version:'0.68.1',bytes:99336432,sha256:'3f85fbe2ba3c1d122aa16f8be672076bc19146e07e9d431f37a93b85fa75a93f',url:'https://downloads.cursor.com/grokbot/stable/33103062f95061ccf9c81c5b365d37ab152c3b66/linux/arm64/grok-bot_0.68.1_arm64.deb'},
  'claude-desktop':{version:'2.31226.1',bytes:174060344,sha256:'d2f57a38ffc73cfda660f8772a5f8bada05e6d74399948a268c6f5d53593ee8f',url:'https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_2.31226.1_arm64.deb'},
} as const;
export function desktopUnit(id:DesktopAppId){desktopAppSchema.parse(id);return `mucodesandbox-desktop-${id}.service`;}
export function desktopProfile(id:DesktopAppId){desktopAppSchema.parse(id);return `/home/dev/.local/share/mucodesandbox/desktop-clients/${id}`;}
export function desktopLaunchScript(e:Environment,id:DesktopAppId) {
  desktopAppSchema.parse(id);const locale=linuxLocales[e.identity.locale];
  if(e.kind!=='vm'||!e.network.strict||!e.network.transparent||!locale||!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z_+\d-]+)+)$/.test(e.identity.timezone))throw new AppError('桌面客户端只支持受保护的 Linux 透明代理环境',409);
  const profile=desktopProfile(id),unit=desktopUnit(id);
  const launcher=`#!/bin/bash
set -euo pipefail
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
export HOME=/home/dev USER=dev LOGNAME=dev PATH=/usr/local/bin:/usr/bin:/bin
export DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
export BROWSER=${LINK_HELPER} XDG_CURRENT_DESKTOP=Openbox
export TZ=${shellQuote(e.identity.timezone)} LANG=${shellQuote(locale)} LC_ALL=${shellQuote(locale)}
export XDG_CONFIG_HOME=${shellQuote(profile+'/config')} XDG_CACHE_HOME=${shellQuote(profile+'/cache')} XDG_DATA_HOME=${shellQuote(profile+'/data')}
export LP_NUM_THREADS=0 GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1
export PULSE_SERVER=${shellQuote(GUEST_AUDIO_ENV.PULSE_SERVER)} PULSE_COOKIE=${shellQuote(GUEST_AUDIO_ENV.PULSE_COOKIE)} PULSE_SINK=mu_browser
exec /usr/bin/dbus-run-session -- /usr/bin/${id} --user-data-dir=${shellQuote(profile+'/profile')} --password-store=basic --force-device-scale-factor=2 --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --use-gl=angle --use-angle=gl "$@"
`;
  return `set -euo pipefail
test -x /usr/bin/${id}
systemctl is-active --quiet mucodesandbox-display.service
sudo -u dev python3 - <<'MU_PATHS'
import pathlib
p=pathlib.Path(${JSON.stringify(profile)})
for part in [p,*p.parents]:
    if part.is_symlink(): raise RuntimeError('Desktop data path must not contain a symlink')
for child in [p,*[p/name for name in ['profile','config','cache','data']]]:
    child.mkdir(mode=0o700,parents=True,exist_ok=True)
    if child.is_symlink(): raise RuntimeError('Desktop data directory must not be a symlink')
    child.chmod(0o700)
MU_PATHS
sudo install -d -m 0755 /usr/local/libexec
printf '%s' ${shellQuote(launcher)} | sudo tee /usr/local/libexec/mu-desktop-${id} >/dev/null
sudo chown root:root /usr/local/libexec/mu-desktop-${id}
sudo chmod 0755 /usr/local/libexec/mu-desktop-${id}
sudo tee /etc/systemd/system/${unit} >/dev/null <<'MU_UNIT'
[Unit]
Description=MuCodeSandbox managed ${id}
BindsTo=mucodesandbox-display.service
After=mucodesandbox-display.service
PartOf=mucodesandbox-display.service
[Service]
Type=simple
User=dev
Group=dev
WorkingDirectory=/home/dev
UMask=0077
ExecStart=/usr/local/libexec/mu-desktop-${id}
KillMode=control-group
TimeoutStopSec=15
Restart=no
MU_UNIT
sudo systemctl daemon-reload
sudo systemctl start ${unit}
systemctl is-active --quiet ${unit}
`;
}

export const DESKTOP_ARGUMENTS_PYTHON=`def desktop_arguments(raw):
    return raw.replace(bytes([0]),b' ').split()
`;
export const INSPECT_DESKTOP_SCRIPT=DESKTOP_ARGUMENTS_PYTHON+String.raw`
import json,pathlib,subprocess
apps=[]
dev_uid=int(subprocess.check_output(['id','-u','dev']))
for name in ['grok-bot','claude-desktop']:
    try:
        package=subprocess.check_output(['dpkg-query','-W','-f='+'$'+'{db:Status-Status}:'+'$'+'{Version}',name],stderr=subprocess.DEVNULL).decode().strip()
        version=package.split(':',1)[1] if package.startswith('installed:') else None
    except subprocess.CalledProcessError: version=None
    unit='mucodesandbox-desktop-'+name+'.service'
    data=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',unit,'--property=ActiveState','--property=MainPID','--property=ControlGroup'],stderr=subprocess.DEVNULL).decode().splitlines() if '=' in line)
    pid=int(data.get('MainPID','0')); running=data.get('ActiveState')=='active' and pid>1
    protected=True;renderers=0;issues=[]
    if running:
        cgroup=data.get('ControlGroup','')
        if cgroup!='/system.slice/'+unit: raise RuntimeError('Invalid desktop control group')
        for process in pathlib.Path('/sys/fs/cgroup'+cgroup+'/cgroup.procs').read_text().split():
            root=pathlib.Path('/proc')/process
            try:
                args=desktop_arguments((root/'cmdline').read_bytes())
                if b'--no-sandbox' in args:
                    protected=False
                    issues.append('pid='+process+' no-sandbox')
                if b'--type=renderer' not in args: continue
                renderers+=1
                for thread in (root/'task').iterdir():
                    values=dict(line.split(':',1) for line in (thread/'status').read_text().splitlines() if ':' in line)
                    failed=[]
                    if int(values.get('Seccomp','0'))!=2: failed.append('seccomp')
                    if int(values.get('NoNewPrivs','0'))!=1: failed.append('no-new-privileges')
                    if int(values.get('CapEff','0'),16)!=0: failed.append('capabilities')
                    if int(values['Uid'].split()[1])!=dev_uid: failed.append('uid')
                    if failed:
                        protected=False
                        issues.append('pid='+process+' tid='+thread.name+' '+','.join(failed))
            except FileNotFoundError: continue
    if running and renderers==0: issues.append('no-renderer')
    apps.append({'id':name,'installed':bool(version),'installedVersion':version,'running':running,'pid':pid,'profile':'/home/dev/.local/share/mucodesandbox/desktop-clients/'+name,'rendererProtected':protected and renderers>0 if running else None,'issue':'; '.join(issues[:4])})
print(json.dumps({'supported':True,'apps':apps,'displaySharedWithBrowser':True,'accountTested':False}))
`;

export class GuestDesktop {
  tracked=new Set<string>();
  starting=new Map<string,Set<DesktopAppId>>();
  readonly runtime:LimaRuntime;
  constructor(runtime:LimaRuntime){this.runtime=runtime;}
  async assertProtected(e:Environment){
    if(!this.tracked.has(e.id))return;
    const apps=(await this.status(e)).apps.filter(a=>a.running&&!this.starting.get(e.id)?.has(a.id));
    if(!apps.length){if(!this.starting.get(e.id)?.size)this.tracked.delete(e.id);return;}
    const failed=apps.find(a=>a.rendererProtected!==true);
    if(failed)throw new AppError(`运行中的桌面客户端渲染保护未通过（${failed.id}：${failed.issue||'unknown'}）`,409,'DESKTOP_SANDBOX_FAILED');
  }
  async status(e:Environment):Promise<DesktopAppsStatus> {
    if(e.kind!=='vm'||e.state!=='running')return {supported:e.kind==='vm',apps:[],displaySharedWithBrowser:true,accountTested:false};
    return JSON.parse(await this.runtime.management(e,['python3','-c',INSPECT_DESKTOP_SCRIPT],{timeoutMs:8000,maxBytes:16_384}));
  }
  async install(e:Environment,id:DesktopAppId,options:RunOptions={}) {
    desktopAppSchema.parse(id);const recipe=DESKTOP_RECIPES[id];
    if((await this.status(e)).apps.some(app=>app.id===id&&app.installed))return;
    const cache=`/home/dev/.cache/mucodesandbox-desktop/${id}.deb`;
    await this.runtime.guest(e,['bash','-s'],{...options,timeoutMs:240_000,input:`set -euo pipefail
umask 077
mkdir -p /home/dev/.cache/mucodesandbox-desktop
test ! -L /home/dev/.cache/mucodesandbox-desktop
test ! -L ${cache}
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --limit-rate 2M --connect-timeout 10 --max-time 210 --max-filesize ${recipe.bytes+1024} --output ${cache} ${shellQuote(recipe.url)}
`});
    await this.runtime.management(e,['bash','-s'],{...options,timeoutMs:240_000,input:`set -euo pipefail
stage=$(sudo mktemp -d /var/tmp/mu-desktop-install-XXXXXXXX)
trap 'sudo rm -rf "$stage"' EXIT
sudo chmod 0755 "$stage"
sudo cp --no-dereference ${cache} "$stage/package.deb"
sudo python3 - "$stage/package.deb" <<'MU_PACKAGE'
import pathlib,hashlib,sys,subprocess
p=pathlib.Path(sys.argv[1])
if p.is_symlink() or not p.is_file() or p.stat().st_size!=${recipe.bytes} or hashlib.file_digest(p.open('rb'),'sha256').hexdigest()!=${JSON.stringify(recipe.sha256)}: raise RuntimeError('Official desktop package hash/size mismatch')
for field,expected in [('Package',${JSON.stringify(id)}),('Version',${JSON.stringify(recipe.version)}),('Architecture','arm64')]:
    if subprocess.check_output(['dpkg-deb','--field',str(p),field]).decode().strip()!=expected: raise RuntimeError('Desktop package identity mismatch')
MU_PACKAGE
sudo chmod 0444 "$stage/package.deb"
sudo env DEBIAN_FRONTEND=noninteractive apt-get -y --no-install-recommends -o APT::Sandbox::User=dev -o Acquire::http::Dl-Limit=2048 -o Acquire::https::Dl-Limit=2048 install "$stage/package.deb" gnome-keyring gnupg libglib2.0-bin
${id==='claude-desktop'?`sudo python3 - "$stage" <<'MU_KEY'
import subprocess,sys,pathlib
home=pathlib.Path(sys.argv[1])/'gnupg';home.mkdir(mode=0o700)
out=subprocess.check_output(['gpg','--batch','--homedir',str(home),'--with-colons','--show-keys','/usr/share/keyrings/claude-desktop-archive-keyring.asc'],stderr=subprocess.DEVNULL).decode()
fingerprints=[line.split(':')[9] for line in out.splitlines() if line.startswith('fpr:')]
if not fingerprints or fingerprints[0]!='31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE': raise RuntimeError('Claude apt signing key fingerprint mismatch')
MU_KEY` : ''}
dpkg-query -W ${id}
`});
    await this.runtime.guest(e,['rm','-f',cache],{...options,timeoutMs:8000});
  }
  async start(e:Environment,id:DesktopAppId,options:RunOptions={}){
    if((await this.status(e)).apps.some(app=>app.id===id&&app.running))return;
    const starting=this.starting.get(e.id)??new Set<DesktopAppId>();starting.add(id);this.starting.set(e.id,starting);
    await this.runtime.management(e,['bash','-s'],{...options,timeoutMs:30_000,input:desktopLaunchScript(e,id)});
  }
  finishStart(id:string,app:DesktopAppId){const value=this.starting.get(id);value?.delete(app);if(!value?.size)this.starting.delete(id);}
  async deliverLink(e:Environment,id:DesktopAppId,url:string,options:RunOptions={}){
    if(parseGuestLink(url).application!==id)throw new AppError('客户端返回协议不匹配',400);
    try{await this.runtime.management(e,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/local/bin:/usr/bin:/bin',`/usr/local/libexec/mu-desktop-${id}`,url],{...options,onOutput:undefined,timeoutMs:15000,maxBytes:4096});}
    catch{throw new AppError('客户端返回链接未能交付，请重试',409,'CLIENT_HANDOFF_FAILED');}
  }
  async stop(e:Environment,id:DesktopAppId,options:RunOptions={}){desktopAppSchema.parse(id);await this.runtime.management(e,['sudo','systemctl','stop',desktopUnit(id)],{...options,timeoutMs:25_000});}
  async stopAll(e:Environment,options:RunOptions={}) {
    if(e.kind!=='vm')return;
    await this.runtime.management(e,['bash','-s'],{...options,timeoutMs:30_000,input:`set -e
for unit in mucodesandbox-desktop-grok-bot.service mucodesandbox-desktop-claude-desktop.service mucodesandbox-desktop-grok-test.service; do
  if systemctl is-active --quiet "$unit"; then sudo systemctl stop "$unit"; fi
done
`});
    this.tracked.delete(e.id);this.starting.delete(e.id);
  }
}
