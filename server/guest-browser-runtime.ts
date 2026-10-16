import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Environment } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { linuxLocales } from './network-guard.ts';
import type { RunOptions } from './process.ts';
import type { LimaRuntime } from './runtime.ts';
import { assertGuestBrowserSandbox, INSPECT_GUEST_BROWSER_SANDBOX } from './guest-browser-sandbox.ts';
import { browserInstallTransactionScript, RECOVER_BROWSER_INSTALL_SCRIPT } from './browser-install-transaction.ts';
import { approvedBrowserRelease, browserReleaseFromRecipe, compareBrowserVersions, CURRENT_BROWSER_RELEASE } from './browser-releases.ts';
import { browserHomeInstallScript, GUEST_HOME_URL } from './browser-startpage.ts';
import { browserProfileCompatibilityScript } from './browser-profile-version.ts';
import { LINK_HELPER } from './guest-links.ts';
import { GUEST_AUDIO_ENV } from './guest-audio.ts';

// Approved official stable package for new profiles. Existing recipes stay explicit.
export const GUEST_CHROMIUM_VERSION = CURRENT_BROWSER_RELEASE.version;
export const GUEST_CHROMIUM_SHA256 = CURRENT_BROWSER_RELEASE.sha256;
export const GUEST_CHROMIUM_URL = CURRENT_BROWSER_RELEASE.url;
export const GUEST_BROWSER_SERVICE = 'mucodesandbox-browser.service';
const packages = [
  'xvfb', 'x11vnc', 'xauth', 'x11-utils', 'unzip', 'fonts-noto-color-emoji', 'fonts-noto-cjk', 'fonts-unifont',
  'libfontconfig1', 'libfreetype6', 'xfonts-cyrillic', 'xfonts-scalable',
  'fonts-liberation', 'fonts-ipafont-gothic', 
  'fonts-tlwg-loma-otf', 'fonts-freefont-ttf', 'libasound2t64',
  'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64', 'libcairo2',
  'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libgbm1', 'libgl1', 'libegl1', 'libgl1-mesa-dri', 'libglib2.0-0t64',
  'libnspr4', 'libnss3', 'libpango-1.0-0', 'libgtk-3-0t64', 'libvulkan1',
  'libcurl4t64', 'libexpat1', 'libudev1', 'xdg-utils', 'libx11-6', 'libxcb1',
  'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2',
] as const;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const DISPLAY_COMPONENT_SCRIPT=`set -eu
if ! command -v Xtigervnc >/dev/null || ! command -v xsettingsd >/dev/null; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tigervnc-standalone-server xsettingsd
fi
command -v Xtigervnc >/dev/null
command -v xsettingsd >/dev/null
`;
async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function assertNetwork(e: Environment) {
  if (e.state !== 'running') throw new AppError('请先启动 Linux 环境', 409, 'ENVIRONMENT_STOPPED');
  if (e.network.mode !== 'direct' && !e.network.transparent)
    throw new AppError('Linux 浏览器使用系统网络，请为代理环境启用透明代理', 409, 'BROWSER_REQUIRES_TRANSPARENT');
}

export async function ensureGuestBrowser(runtime: LimaRuntime, e: Environment, options: RunOptions = {}, requestedVersion?: string) {
  assertNetwork(e);
  if (requestedVersion) approvedBrowserRelease(requestedVersion);
  const marker = await runtime.management(e, ['bash', '-s'], { ...options, input: RECOVER_BROWSER_INSTALL_SCRIPT, timeoutMs: 30_000 });
  const release = requestedVersion ? approvedBrowserRelease(requestedVersion) : marker.trim() ? browserReleaseFromRecipe(marker) : CURRENT_BROWSER_RELEASE;
  if (marker.trim() && compareBrowserVersions(browserReleaseFromRecipe(marker).version,release.version)>0)
    throw new AppError('旧版本不能直接替换当前浏览器并读取资料，请新建空白环境',409,'BROWSER_FRESH_PROFILE_REQUIRED');
  // Check before selecting/replacing binaries, then recheck immediately at launch.
  await runtime.management(e,['bash','-s'],{...options,input:browserProfileCompatibilityScript(release.version),timeoutMs:15_000});
  const { version, sha256: checksum, url, recipe: browserRecipe } = release;
  const browserExecutable = `/opt/mucodesandbox/chromium-${version}/chrome-linux-arm64/chrome`;
  if (marker.trim() === browserRecipe) {
    const present = await runtime.management(e, ['bash', '-c', `sudo test -x ${shellQuote(browserExecutable)} && command -v Xvfb && command -v x11vnc && command -v xauth`], { ...options, timeoutMs: 15_000 }).catch(() => '');
    if (present.trim()) return release;
  }
  const cache = path.join(runtime.dataDir, 'tools', 'guest-browser');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const archive = path.join(cache, `chrome-${version}-linux-arm64.${release.format}`);
  const cached = await sha256(archive).catch(() => '');
  if (cached !== checksum) {
    const next = `${archive}.${randomUUID()}.tmp`;
    try {
      options.onOutput?.(`Downloading official Linux ${release.channel === 'stable' ? 'Chrome stable' : 'Chrome for Testing'} ${version}; pinned SHA-256 required.\n`);
      await runtime.runner('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--max-time', '600', '--output', next, url], { ...options, env: runtime.env(), timeoutMs: 630_000 });
      if (await sha256(next) !== checksum) throw new AppError('Linux 浏览器下载校验失败', 500, 'CHECKSUM_MISMATCH');
      await rename(next, archive);
    } finally { await rm(next, { force: true }); }
  }
  const guestArchive = `/tmp/mu-browser-${randomUUID()}.${release.format}`;
  const controlledArchive = `/var/lib/mucodesandbox/browser-install/archive.${release.format}`;
  await runtime.command(['copy', archive, `${e.instanceName}:${guestArchive}`], { ...options, timeoutMs: 90_000 });
  // A root-owned copy closes the verification/extraction race with guest processes.
  const script = `set -euo pipefail
sudo install -d -m 0700 /var/lib/mucodesandbox/browser-install
sudo install -m 0600 ${shellQuote(guestArchive)} ${controlledArchive}
sudo rm -f ${shellQuote(guestArchive)}
printf '%s  %s\\n' '${checksum}' ${controlledArchive} | sudo sha256sum --check --status
if ! python3 - <<'MU_BROWSER_DEPENDENCIES'
import subprocess
packages = ${JSON.stringify(packages)}
result = subprocess.run(['dpkg-query', '-W', '-f=' + '$' + '{db:Status-Status}\\n'] + packages, capture_output=True, text=True)
raise SystemExit(0 if result.returncode == 0 and result.stdout.splitlines() == ['installed'] * len(packages) else 1)
MU_BROWSER_DEPENDENCIES
then
sudo -E env DEBIAN_FRONTEND=noninteractive apt-get update -qq
# Package postinst scripts must not restart the active network boundary mid-install.
sudo -E env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y --no-install-recommends ${packages.join(' ')}
fi
${browserInstallTransactionScript(version, browserRecipe, controlledArchive, release.format)}
sudo rm -rf /var/lib/mucodesandbox/browser-install
echo 'Root-owned Linux browser installed; Chromium sandbox remains enabled. Deferred system service updates take effect after the next VM restart.'
`;
  try {
    await runtime.management(e, ['bash', '-s'], { ...options, input: script, timeoutMs: 600_000 });
  } catch (error) {
    try {
      // A cancelled SSH/install must not also cancel the bounded recovery attempt.
      await runtime.management(e, ['bash', '-s'], { input: RECOVER_BROWSER_INSTALL_SCRIPT, timeoutMs: 30_000 });
    } catch (recoveryError) {
      const failure = new AppError('浏览器安装失败且自动恢复未完成，请重试修复后再启动', 500, 'BROWSER_INSTALL_RECOVERY_FAILED');
      failure.cause = new AggregateError([error, recoveryError], 'Browser installation and recovery failed');
      throw failure;
    }
    throw error;
  }
  return release;
}

export async function startGuestBrowser(runtime: LimaRuntime, e: Environment, password: string, options: RunOptions = {}, version = GUEST_CHROMIUM_VERSION) {
  assertNetwork(e);
  approvedBrowserRelease(version);
  const browserRoot = `/opt/mucodesandbox/chromium-${version}`;
  const browserExecutable = `${browserRoot}/chrome-linux-arm64/chrome`;
  if (!/^[A-Za-z0-9_-]{8}$/.test(password)) throw new AppError('浏览器连接密码格式无效', 400);
  const locale = linuxLocales[e.identity.locale];
  if (!locale) throw new AppError('浏览器语言无效', 400);
  await runtime.management(e,['bash','-s'],{...options,input:browserProfileCompatibilityScript(version),timeoutMs:15_000});
  await runtime.management(e,['systemctl','is-active','--quiet','mucodesandbox-display.service'],{...options,timeoutMs:8000});
  const command = [
    browserExecutable,
    '--user-data-dir=/home/dev/.local/share/mucodesandbox/browser',
    '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // llvmpipe's helper threads prevent Chromium's normal GPU sandbox startup.
    // The launcher disables those threads before initializing the tested GL backend.
    '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist',
    '--disable-accelerated-2d-canvas',
    // This VM uses llvmpipe. CPU composition avoids serializing ordinary page
    // scrolling through its single-threaded GL compositor; WebGL stays enabled.
    '--disable-gpu-compositing',
    '--password-store=basic', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222', '--window-position=0,0', '--window-size=1280,800',
    '--start-maximized', `--lang=${e.identity.locale}`, 'about:blank',
  ];
  const launcher = `#!/bin/bash
set -euo pipefail
export HOME=/home/dev USER=dev LOGNAME=dev
export PATH=/usr/local/bin:/usr/bin:/bin
export DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
export BROWSER=${LINK_HELPER} XDG_CURRENT_DESKTOP=Openbox
export TZ=${shellQuote(e.identity.timezone)} LANG=${shellQuote(locale)} LC_ALL=${shellQuote(locale)}
export LP_NUM_THREADS=0 GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1 MESA_SHADER_CACHE_DISABLE=true
export CHROME_DEVEL_SANDBOX=${shellQuote(`${browserRoot}/chrome-linux-arm64/chrome_sandbox`)}
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
mkdir -p /home/dev/.local/share/mucodesandbox/browser
chmod 0700 /home/dev/.local/share/mucodesandbox /home/dev/.local/share/mucodesandbox/browser
export PULSE_SERVER=${shellQuote(GUEST_AUDIO_ENV.PULSE_SERVER)} PULSE_COOKIE=${shellQuote(GUEST_AUDIO_ENV.PULSE_COOKIE)} PULSE_SINK=mu_browser
exec /usr/bin/dbus-run-session -- ${command.map(shellQuote).join(' ')}
`;
  const unit = `[Unit]
Description=MuCodeSandbox Linux browser
BindsTo=mucodesandbox-display.service
After=mucodesandbox-display.service
PartOf=mucodesandbox-display.service
[Service]
Type=simple
User=dev
Group=dev
WorkingDirectory=/home/dev
UMask=0077
ExecStart=/usr/local/libexec/mu-guest-browser
KillMode=control-group
TimeoutStopSec=15
Restart=no
[Install]
WantedBy=multi-user.target
`;
  const script = `set -euo pipefail
sudo systemctl stop ${GUEST_BROWSER_SERVICE} 2>/dev/null || true
${await browserHomeInstallScript()}
sudo -H -u dev -- python3 - ${shellQuote(e.identity.locale)} <<'MU_PREFERENCES'
import json, os, pathlib, sys, tempfile
profile = pathlib.Path('/home/dev/.local/share/mucodesandbox/browser/Default')
profile.mkdir(mode=0o700, parents=True, exist_ok=True)
preferences = profile / 'Preferences'
data = json.loads(preferences.read_text()) if preferences.exists() else {}
locale = sys.argv[1]
languages = list(dict.fromkeys([locale, locale.split('-')[0]]))
data.setdefault('intl', {})['accept_languages'] = ','.join(languages)
data['intl']['selected_languages'] = ','.join(languages)
data.setdefault('translate', {})['enabled'] = False
data['homepage'] = ${JSON.stringify(GUEST_HOME_URL)}
data['homepage_is_newtabpage'] = False
data.setdefault('browser', {})['show_home_button'] = True
# The manager authorizes and selects the startup page after native protection checks.
# An upstream default that resumes old tabs would navigate before that decision.
data.setdefault('session', {})['restore_on_startup'] = 5
with tempfile.NamedTemporaryFile(mode='w', dir=profile, prefix='.mu-preferences-', delete=False) as temporary:
    json.dump(data, temporary, ensure_ascii=True)
    temporary.flush()
    os.fsync(temporary.fileno())
    temporary_path = temporary.name
os.replace(temporary_path, preferences)
MU_PREFERENCES
printf '%s' ${shellQuote(launcher)} | sudo tee /usr/local/libexec/mu-guest-browser >/dev/null
sudo chown root:root /usr/local/libexec/mu-guest-browser
sudo chmod 0755 /usr/local/libexec/mu-guest-browser
printf '%s' ${shellQuote(unit)} | sudo tee /etc/systemd/system/${GUEST_BROWSER_SERVICE} >/dev/null
sudo chown root:root /etc/systemd/system/${GUEST_BROWSER_SERVICE}
sudo chmod 0644 /etc/systemd/system/${GUEST_BROWSER_SERVICE}
sudo systemctl daemon-reload
sudo systemctl start ${GUEST_BROWSER_SERVICE}
python3 - <<'MU_READY'
import json, time, urllib.request
for attempt in range(150):
    try:
        with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1) as result:
            assert json.load(result)['webSocketDebuggerUrl']
        break
    except (OSError, AssertionError, KeyError):
        if attempt == 149: raise
        time.sleep(0.2)
print('Linux browser ready: loopback VNC and CDP; no host website process.')
MU_READY
`;
  try {
    await runtime.management(e, ['bash', '-s'], { ...options, input: script, timeoutMs: 60_000 });
    let failure: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await inspectGuestBrowserSandbox(runtime, e, options, version); failure = undefined; break;
      } catch (error) {
        failure = error;
        if (options.signal?.aborted) throw error;
        if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (failure) throw failure;
    options.onOutput?.('Linux renderer and graphics sandbox verified before website navigation.\n');
  } catch (error) {
    await stopGuestBrowser(runtime, e).catch(() => {});
    throw error;
  }
}

export async function inspectGuestBrowserSandbox(runtime: LimaRuntime, e: Environment, options: RunOptions = {}, version = GUEST_CHROMIUM_VERSION) {
  approvedBrowserRelease(version);
  const browserExecutable = `/opt/mucodesandbox/chromium-${version}/chrome-linux-arm64/chrome`;
  const result = await runtime.management(e, ['sudo', 'python3', '-', browserExecutable], { ...options, input: INSPECT_GUEST_BROWSER_SANDBOX, timeoutMs: 10_000 });
  return assertGuestBrowserSandbox(JSON.parse(result));
}

export async function stopGuestBrowser(runtime: LimaRuntime, e: Environment, waitForGracefulExit=false) {
  await runtime.management(e, ['bash', '-s'], { timeoutMs: 30_000, input: `set -euo pipefail
${waitForGracefulExit?`# CDP can disconnect before Chromium finishes saving its profile.
for attempt in $(seq 1 100); do
  if ! systemctl is-active --quiet ${GUEST_BROWSER_SERVICE}; then break; fi
  sleep 0.1
done
`:''}
sudo systemctl stop ${GUEST_BROWSER_SERVICE} 2>/dev/null || true
` });
}
