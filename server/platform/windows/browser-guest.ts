import type {Environment} from '../../../shared/types.ts';
import {shellQuote,linuxLocales} from '../../network-guard.ts';
import {GUEST_AUDIO_LAUNCHER_START,GUEST_AUDIO_ENV} from '../../guest-audio.ts';
import {WINDOWS_CHROME,WINDOWS_DISPLAY,WINDOWS_CHROME_ROOT,WINDOWS_CHROME_EXECUTABLE,WINDOWS_DISPLAY_ROOT,WINDOWS_DISPLAY_EXECUTABLE} from './browser-assets.ts';

export const VERIFY_WINDOWS_DESKTOP=`sudo python3 - <<'MU_COMPONENTS'
import pathlib,json,os,stat,hashlib,subprocess
assert subprocess.check_output(['dpkg','--print-architecture'],text=True).strip()=='amd64'
for executable in ['xkbcomp','xauth','x11vnc','xsettingsd','openbox','wmctrl','pactl']:
 if subprocess.run(['which',executable],stdout=subprocess.DEVNULL).returncode!=0:raise RuntimeError('Missing display prerequisite: '+executable)
for folder,expected,relative in ${JSON.stringify([[WINDOWS_CHROME_ROOT,WINDOWS_CHROME,'chrome'],[WINDOWS_DISPLAY_ROOT,WINDOWS_DISPLAY,'bin/Xvnc']])}:
 root=pathlib.Path(folder);current=pathlib.Path('/')
 for part in root.parts[1:]:
  current=current/part;info=current.lstat()
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe component directory')
 record=root/'.mu-component.json';info=record.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_size>4096:raise RuntimeError('Unsafe component record')
 value=json.loads(record.read_text());main=root/relative;info=main.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1:raise RuntimeError('Unsafe component executable')
 if value['archiveSha256']!=expected['sha256'] or value['architecture']!='amd64' or value['version']!=expected['version']:raise RuntimeError('Unapproved component')
 with main.open('rb') as source:
  if hashlib.file_digest(source,'sha256').hexdigest()!=value['binarySha256']:raise RuntimeError('Component executable changed')
 if relative=='bin/Xvnc' and value['binarySha256']!=expected['binarySha256']:raise RuntimeError('Unapproved display executable')
 if 'not found' in subprocess.check_output(['ldd',str(main)],text=True):raise RuntimeError('Missing component dependencies')
helper=pathlib.Path('${WINDOWS_CHROME_ROOT}/chrome-sandbox');info=helper.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o4755 or info.st_nlink!=1:raise RuntimeError('Unsafe browser sandbox helper')
print('Verified AMD64 browser and display components')
MU_COMPONENTS
`;

export function startWindowsDisplay(password:string,cpus:number){
 if(!/^[A-Za-z0-9_-]{8}$/.test(password))throw Error('Invalid VNC password');
 const threads=Math.min(4,Math.max(1,Math.floor(cpus)));
 const launcher=`#!/bin/bash
set -euo pipefail
export HOME=/home/dev USER=dev LOGNAME=dev PATH=/usr/local/bin:/usr/bin:/bin DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
umask 077
touch "$XAUTHORITY"; chmod 0600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add :99 . "$(mcookie)"
xvfb_pid= settings_pid= pulse_pid= wm_pid=
cleanup(){ trap - EXIT TERM INT; for child in "$wm_pid" "$settings_pid" "$xvfb_pid" "$pulse_pid"; do if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; fi; done; wait || true; }
trap cleanup EXIT TERM INT
printf '%s  %s\\n' '${WINDOWS_DISPLAY.binarySha256}' '${WINDOWS_DISPLAY_EXECUTABLE}' | sha256sum --check --status
${WINDOWS_DISPLAY_EXECUTABLE} :99 -geometry 3200x2000 -depth 24 -dpi 192 -nolisten tcp -auth "$XAUTHORITY" -noreset -interface 127.0.0.1 -rfbport 5900 -securitytypes vnc -rfbauth /run/mucodesandbox-browser-secret/vnc -alwaysshared -noclipboardrecv -noclipboardsend -noprimarysync -deferupdate 1 -nthreads ${threads} -dridir /usr/lib/x86_64-linux-gnu/dri &
xvfb_pid=$!
for attempt in $(seq 1 100); do if xdpyinfo >/dev/null 2>&1; then break; fi; kill -0 "$xvfb_pid"; sleep .1; done
printf 'Xft/DPI 196608\\nGdk/WindowScalingFactor 2\\nGdk/UnscaledDPI 98304\\n' > /run/mu-browser/xsettings.conf
xsettingsd --config=/run/mu-browser/xsettings.conf &
settings_pid=$!; printf '%s' "$settings_pid" > /run/mu-browser/xsettings.pid
${GUEST_AUDIO_LAUNCHER_START}
openbox --sm-disable &
wm_pid=$!
for attempt in $(seq 1 100); do if wmctrl -m >/dev/null 2>&1; then break; fi; kill -0 "$wm_pid"; sleep .05; done
wmctrl -m >/dev/null
wait -n "$xvfb_pid" "$settings_pid" "$pulse_pid" "$wm_pid"
`;
 return `set -euo pipefail
sudo systemctl stop mucodesandbox-browser.service mucodesandbox-display.service 2>/dev/null || true
sudo install -d -m 0755 /usr/local/libexec
sudo install -d -o root -g dev -m 0750 /run/mucodesandbox-browser-secret
sudo x11vnc -storepasswd ${shellQuote(password)} /run/mucodesandbox-browser-secret/vnc </dev/null >/dev/null
sudo test "$(sudo stat -c %s /run/mucodesandbox-browser-secret/vnc)" = 8
sudo chown root:dev /run/mucodesandbox-browser-secret/vnc; sudo chmod 0640 /run/mucodesandbox-browser-secret/vnc
printf '%s' ${shellQuote(launcher)} | sudo tee /usr/local/libexec/mu-windows-display >/dev/null
sudo chmod 0755 /usr/local/libexec/mu-windows-display; sudo chown root:root /usr/local/libexec/mu-windows-display
sudo tee /etc/systemd/system/mucodesandbox-display.service >/dev/null <<'MU_UNIT'
[Unit]
Description=MuCodeSandbox Windows guest display
After=network.target
[Service]
Type=simple
User=dev
Group=dev
WorkingDirectory=/home/dev
RuntimeDirectory=mu-browser
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=/usr/local/libexec/mu-windows-display
KillMode=control-group
TimeoutStopSec=15
Restart=no
MU_UNIT
sudo systemctl daemon-reload
sudo systemctl start mucodesandbox-display.service
sudo -H -u dev -- env -i HOME=/home/dev PATH=/usr/bin:/bin DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority bash -c 'for i in $(seq 1 100); do if xdpyinfo >/dev/null 2>&1 && wmctrl -m >/dev/null 2>&1; then exit 0; fi; sleep .1; done; exit 1'
`;
}

export function startWindowsChrome(e:Environment){
 const locale=linuxLocales[e.identity.locale];if(!locale)throw Error('Invalid browser locale');
 const command=[WINDOWS_CHROME_EXECUTABLE,'--user-data-dir=/home/dev/.local/share/mucodesandbox/browser','--no-first-run','--no-default-browser-check','--disable-dev-shm-usage','--disable-quic',
 '--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist','--disable-accelerated-2d-canvas','--disable-gpu-compositing',
 '--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--metrics-recording-only','--disable-breakpad',
 '--disable-features=MediaRouter,OptimizationHints,Translate','--password-store=basic','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222','--window-position=0,0','--window-size=1600,1000','--start-maximized',`--lang=${e.identity.locale}`,'about:blank'];
 const launcher=`#!/bin/bash
set -euo pipefail
export HOME=/home/dev USER=dev LOGNAME=dev PATH=/usr/local/bin:/usr/bin:/bin DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
export TZ=${shellQuote(e.identity.timezone)} LANG=${shellQuote(locale)} LC_ALL=${shellQuote(locale)}
export LP_NUM_THREADS=0 GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1 MESA_SHADER_CACHE_DISABLE=true
export CHROME_DEVEL_SANDBOX=${shellQuote(WINDOWS_CHROME_ROOT+'/chrome-sandbox')}
export PULSE_SERVER=${shellQuote(GUEST_AUDIO_ENV.PULSE_SERVER)} PULSE_COOKIE=${shellQuote(GUEST_AUDIO_ENV.PULSE_COOKIE)} PULSE_SINK=mu_browser
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
exec /usr/bin/dbus-run-session -- ${command.map(shellQuote).join(' ')}
`;
 return `set -euo pipefail
sudo systemctl is-active --quiet mucodesandbox-display.service
sudo localedef -i ${shellQuote(locale.split('.')[0])} -f UTF-8 ${shellQuote(locale)}
sudo tee /etc/apparmor.d/mucodesandbox-windows-chromium >/dev/null <<'MU_POLICY'
abi <abi/4.0>,
include <tunables/global>
${WINDOWS_CHROME_EXECUTABLE} flags=(unconfined) {
 userns,
}
MU_POLICY
sudo apparmor_parser -r /etc/apparmor.d/mucodesandbox-windows-chromium
sudo -H -u dev -- python3 - <<'MU_PREFS'
import os,pathlib,stat,json,re,uuid
current=pathlib.Path('/home/dev')
for name in ['.local','share','mucodesandbox','browser','Default']:
 current=current/name;current.mkdir(mode=0o700,exist_ok=True);info=current.lstat()
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid():raise RuntimeError('Unsafe browser profile directory')
record=current.parent/'Last Version'
if record.exists() or record.is_symlink():
 info=record.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>256 or info.st_uid!=os.getuid():raise RuntimeError('Unsafe profile version')
 version=record.read_text().strip()
 if not re.fullmatch(r'[0-9]+(?:\\.[0-9]+){3}',version) or tuple(map(int,version.split('.')))>tuple(map(int,'${WINDOWS_CHROME.version}'.split('.'))):raise RuntimeError('Newer profile requires a newer approved browser')
file=current/'Preferences';data={}
if file.exists() or file.is_symlink():
 info=file.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid() or info.st_size>16*1024*1024:raise RuntimeError('Unsafe browser preferences')
 data=json.loads(file.read_text())
locale=${JSON.stringify(e.identity.locale)};languages=list(dict.fromkeys([locale,locale.split('-')[0]]))
data.setdefault('intl',{})['accept_languages']=','.join(languages);data['intl']['selected_languages']=','.join(languages)
data.setdefault('session',{})['restore_on_startup']=5;data.setdefault('translate',{})['enabled']=False
data.setdefault('download',{}).update(default_directory='/home/dev/Downloads',prompt_for_download=False)
folder=pathlib.Path('/home/dev/Downloads');folder.mkdir(mode=0o700,exist_ok=True)
if folder.is_symlink() or folder.stat().st_uid!=os.getuid():raise RuntimeError('Unsafe download directory')
temp=current/('.preferences-'+uuid.uuid4().hex)
try:
 with temp.open('x') as out:os.chmod(temp,0o600);json.dump(data,out);out.flush();os.fsync(out.fileno())
 os.replace(temp,file)
finally:temp.unlink(missing_ok=True)
MU_PREFS
printf '%s' ${shellQuote(launcher)} | sudo tee /usr/local/libexec/mu-windows-browser >/dev/null
sudo chmod 0755 /usr/local/libexec/mu-windows-browser; sudo chown root:root /usr/local/libexec/mu-windows-browser
sudo tee /etc/systemd/system/mucodesandbox-browser.service >/dev/null <<'MU_UNIT'
[Unit]
Description=MuCodeSandbox Windows guest browser
BindsTo=mucodesandbox-display.service
After=mucodesandbox-display.service
PartOf=mucodesandbox-display.service
[Service]
Type=simple
User=dev
Group=dev
WorkingDirectory=/home/dev
UMask=0077
ExecStart=/usr/local/libexec/mu-windows-browser
KillMode=control-group
TimeoutStopSec=15
Restart=no
MU_UNIT
sudo systemctl daemon-reload
sudo systemctl start mucodesandbox-browser.service
`;
}

export const STOP_WINDOWS_DISPLAY='sudo systemctl stop mucodesandbox-browser.service mucodesandbox-display.service';
