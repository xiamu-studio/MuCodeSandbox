import type { Environment } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { shellQuote } from './network-guard.ts';
import type { RunOptions } from './process.ts';
import type { LimaRuntime } from './runtime.ts';
import { ensureGuestAudio, GUEST_AUDIO_LAUNCHER_START } from './guest-audio.ts';
import { ensureDisplayEncoder, DISPLAY_ENCODER_EXECUTABLE, DISPLAY_ENCODER_BINARY_SHA256 } from './guest-display-encoder.ts';

export const GUEST_DISPLAY_SERVICE = 'mucodesandbox-display.service';
export const ENSURE_DISPLAY_COMPONENTS = `set -eu
if ! command -v Xtigervnc >/dev/null || ! command -v xsettingsd >/dev/null || ! command -v xauth >/dev/null || ! command -v x11vnc >/dev/null || ! command -v xdpyinfo >/dev/null || ! command -v openbox >/dev/null || ! command -v wmctrl >/dev/null || ! command -v xclip >/dev/null; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y -qq --no-install-recommends tigervnc-standalone-server xsettingsd xauth x11vnc x11-utils openbox wmctrl xclip
fi
command -v Xtigervnc >/dev/null
command -v xsettingsd >/dev/null
# Existing browser recipes skip their dependency installer. Repair the shared
# desktop fonts too, without reinstalling Chrome or touching its profile.
if ! dpkg-query -W -f='\${db:Status-Status}' fonts-noto-cjk 2>/dev/null | grep -qx installed; then
  sudo env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y -qq --no-install-recommends --no-remove -o APT::Sandbox::User=dev fonts-noto-cjk
fi
`;

export function guestDisplayLaunchScript(password: string, threads = 4) {
  if (!/^[A-Za-z0-9_-]{8}$/.test(password)) throw new AppError('显示连接密码格式无效', 400);
  if (!Number.isInteger(threads) || threads < 1 || threads > 4) throw new AppError('显示资源配置无效', 400);
  const launcher = `#!/bin/bash
set -euo pipefail
export HOME=/home/dev USER=dev LOGNAME=dev PATH=/usr/local/bin:/usr/bin:/bin
export DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
umask 077
printf '%s  %s\\n' '${DISPLAY_ENCODER_BINARY_SHA256}' '${DISPLAY_ENCODER_EXECUTABLE}' | sha256sum --check --status
touch "$XAUTHORITY"
chmod 0600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add :99 . "$(mcookie)"
xvfb_pid= settings_pid= pulse_pid= wm_pid=
cleanup() {
  trap - EXIT TERM INT
  for child in "$wm_pid" "$settings_pid" "$xvfb_pid" "$pulse_pid"; do
    if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; fi
  done
  wait || true
}
trap cleanup EXIT TERM INT
${DISPLAY_ENCODER_EXECUTABLE} :99 -geometry 3200x2000 -depth 24 -dpi 192 -nolisten tcp -auth "$XAUTHORITY" -noreset -interface 127.0.0.1 -rfbport 5900 -securitytypes vnc -rfbauth /run/mucodesandbox-browser-secret/vnc -alwaysshared -noclipboardrecv -noclipboardsend -noprimarysync -deferupdate 1 -nthreads ${threads} -dridir /usr/lib/aarch64-linux-gnu/dri &
xvfb_pid=$!
for attempt in $(seq 1 100); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  kill -0 "$xvfb_pid"
  sleep 0.1
done
cat > /run/mu-browser/xsettings.conf <<'MU_DPI'
Xft/DPI 196608
Gdk/WindowScalingFactor 2
Gdk/UnscaledDPI 98304
MU_DPI
xsettingsd --config=/run/mu-browser/xsettings.conf &
settings_pid=$!
printf '%s' "$settings_pid" > /run/mu-browser/xsettings.pid
${GUEST_AUDIO_LAUNCHER_START}
openbox --sm-disable &
wm_pid=$!
wm_ready=no
for wm_attempt in $(seq 1 100); do
  if wmctrl -m >/dev/null 2>&1; then wm_ready=yes;break;fi
  kill -0 "$wm_pid"
  sleep .05
done
if [ "$wm_ready" != yes ];then echo 'Guest window manager did not become ready' >&2;exit 1;fi
wait -n "$xvfb_pid" "$settings_pid" "$pulse_pid" "$wm_pid"
`;
  return `set -euo pipefail
# Migrate a former combined browser/display service; never remove profile data.
for unit in mucodesandbox-desktop-grok-bot.service mucodesandbox-desktop-claude-desktop.service mucodesandbox-browser.service ${GUEST_DISPLAY_SERVICE}; do
  sudo systemctl stop "$unit" 2>/dev/null || true
done
sudo install -d -m 0755 /usr/local/libexec
sudo install -d -o root -g dev -m 0750 /run/mucodesandbox-browser-secret
sudo x11vnc -storepasswd ${shellQuote(password)} /run/mucodesandbox-browser-secret/vnc >/dev/null
sudo chown root:dev /run/mucodesandbox-browser-secret/vnc
sudo chmod 0640 /run/mucodesandbox-browser-secret/vnc
printf '%s' ${shellQuote(launcher)} | sudo tee /usr/local/libexec/mu-guest-display >/dev/null
sudo chown root:root /usr/local/libexec/mu-guest-display
sudo chmod 0755 /usr/local/libexec/mu-guest-display
sudo tee /etc/systemd/system/${GUEST_DISPLAY_SERVICE} >/dev/null <<'MU_DISPLAY_UNIT'
[Unit]
Description=MuCodeSandbox Linux display and output audio
After=network.target
[Service]
Type=simple
User=dev
Group=dev
WorkingDirectory=/home/dev
RuntimeDirectory=mu-browser
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=/usr/local/libexec/mu-guest-display
KillMode=control-group
TimeoutStopSec=15
Restart=no
MU_DISPLAY_UNIT
sudo systemctl daemon-reload
sudo systemctl start ${GUEST_DISPLAY_SERVICE}
python3 - <<'MU_DISPLAY_READY'
import socket,time,subprocess
for attempt in range(150):
    try:
        assert subprocess.run(['systemctl','is-active','--quiet','${GUEST_DISPLAY_SERVICE}']).returncode==0
        with socket.create_connection(('127.0.0.1',5900),timeout=1) as vnc:
            assert vnc.recv(12).startswith(b'RFB ')
        break
    except (OSError,AssertionError):
        if attempt==149: raise
        time.sleep(.2)
print('Linux display ready; no browser launched.')
MU_DISPLAY_READY
`;
}

export async function startGuestDisplay(runtime: LimaRuntime, e: Environment, password: string, options: RunOptions = {}) {
  if (e.kind !== 'vm' || e.state !== 'running') throw new AppError('请先启动 Linux 环境', 409);
  const launch = guestDisplayLaunchScript(password, Math.min(4, e.cpus));
  try {
    await runtime.management(e, ['bash', '-s'], { ...options, input: ENSURE_DISPLAY_COMPONENTS, timeoutMs: 300_000 });
    await ensureDisplayEncoder(runtime, e, options);
    await ensureGuestAudio(runtime, e, options);
    await runtime.management(e, ['bash', '-s'], { ...options, input: launch, timeoutMs: 60_000 });
  } catch (error) {
    await stopGuestDisplay(runtime, e).catch(() => {});
    throw error;
  }
}

export async function stopGuestDisplay(runtime: LimaRuntime, e: Environment) {
  await runtime.management(e, ['bash', '-s'], { timeoutMs: 30_000, input: `set -eu
sudo systemctl stop ${GUEST_DISPLAY_SERVICE} mucodesandbox-browser.service mucodesandbox-desktop-grok-bot.service mucodesandbox-desktop-claude-desktop.service 2>/dev/null || true
sudo rm -rf /run/mucodesandbox-browser-secret
` });
}
