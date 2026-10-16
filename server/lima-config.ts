import { stringify } from 'yaml';
import type { Environment } from '../shared/types.ts';
import { proxyUrl } from './validation.ts';
import { CONTROL_UID } from './guest-privileges.ts';
import { sharedMountBootScript } from './guest-mounts.ts';

export const UBUNTU_IMAGE = {
  location: 'https://cloud-images.ubuntu.com/minimal/releases/noble/release-20260716/ubuntu-24.04-minimal-cloudimg-arm64.img',
  arch: 'aarch64',
  digest: 'sha256:7e938df669e3b1923595eeda97aa28569350c5283e05a835cc912a2486a54934',
};

export function limaPortForwards(e: Pick<Environment, 'ports'>) {
  return [
    ...e.ports.map(p => ({ guestPort: p.guestPort, hostPort: p.hostPort, hostIP: '127.0.0.1', proto: 'tcp', guestIP: '0.0.0.0', guestIPMustBeZero: false })),
    // Lima otherwise skips an ignore rule for wildcard listeners and applies
    // its default automatic forward. Match all guest addresses explicitly.
    { guestPortRange: [1, 65535], proto: 'any', guestIP: '0.0.0.0', guestIPMustBeZero: false, ignore: true },
  ];
}

export function buildLimaConfig(e: Environment) {
  const proxy = e.network.transparent ? '' : proxyUrl(e.network, true);
  return stringify({
    minimumLimaVersion: '2.0.0',
    vmType: 'vz',
    arch: 'aarch64',
    images: [UBUNTU_IMAGE],
    cpus: e.cpus,
    memory: `${e.memoryGiB}GiB`,
    disk: `${e.diskGiB}GiB`,
    timezone: e.identity.timezone,
    mountType: 'virtiofs',
    mounts: e.mounts.map(m => ({ location: m.hostPath, mountPoint: m.guestPath, writable: m.writable })),
    user: { name: 'mu', home: '/home/mu', shell: '/bin/bash', uid: CONTROL_UID },
    ssh: { loadDotSSHPubKeys: false, forwardAgent: false },
    containerd: { system: false, user: false },
    propagateProxyEnv: false,
    env: proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: e.network.noProxy } : {},
    portForwards: limaPortForwards(e),
    provision: [
      ...(e.mounts.length ? [{ mode: 'boot', script: sharedMountBootScript(e) }] : []),
      { mode: 'system', script: '#!/bin/bash\nset -eu\ninstall -d -o mu -g mu -m 0755 /workspace\n' },
    ],
  });
}

export const METRICS_SCRIPT = `set -eu
export LC_ALL=C
read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
total1=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle1=$((idle+iowait))
sleep 0.3
read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
total2=$((user+nice+system+idle+iowait+irq+softirq+steal)); idle2=$((idle+iowait))
cpu=$(awk -v t=$((total2-total1)) -v i=$((idle2-idle1)) 'BEGIN { printf "%.1f", (t>0 ? (t-i)*100/t : 0) }')
memtotal=$(awk '/MemTotal:/{printf "%.0f",$2/1024}' /proc/meminfo)
memavailable=$(awk '/MemAvailable:/{printf "%.0f",$2/1024}' /proc/meminfo)
disk=$(df -B1 / | awk 'NR==2{printf "%.2f %.2f",$3/1073741824,$2/1073741824}')
read -r used total <<< "$disk"
uptime=$(cut -d. -f1 /proc/uptime)
printf '{"cpuPercent":%s,"memoryUsedMiB":%s,"memoryTotalMiB":%s,"diskUsedGiB":%s,"diskTotalGiB":%s,"uptimeSeconds":%s}\\n' "$cpu" "$((memtotal-memavailable))" "$memtotal" "$used" "$total" "$uptime"
`;

export const INSTALL_AGENT_SCRIPT = `set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
echo '[1/3] Installing development dependencies'
sudo --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY apt-get update -qq
sudo --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY apt-get install -y -qq git curl ca-certificates xz-utils python3
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]; then
  echo '[2/3] Installing Node.js 24.15.0'
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  archive=node-v24.15.0-linux-arm64.tar.xz
  curl --fail --location --retry 2 --max-time 300 "https://nodejs.org/dist/v24.15.0/$archive" -o "$stage/$archive"
  curl --fail --location --retry 2 --max-time 60 https://nodejs.org/dist/v24.15.0/SHASUMS256.txt -o "$stage/SHASUMS256.txt"
  (cd "$stage"; grep " $archive$" SHASUMS256.txt | sha256sum -c -)
  sudo tar -xJf "$stage/$archive" -C /usr/local --strip-components=1 --no-same-owner
fi
echo '[3/3] Installing Claude Code'
mkdir -p "$HOME/.local/bin"
sudo -H -u dev --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY /usr/bin/env PATH=/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin bash -s <<'MU_AGENT'
mkdir -p "$HOME/.local/bin"
npm install --global --prefix "$HOME/.local" --no-audit --no-fund @anthropic-ai/claude-code
grep -q 'MuCodeSandbox PATH' "$HOME/.profile" 2>/dev/null || printf '\\n# MuCodeSandbox PATH\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$HOME/.profile"
claude --version
MU_AGENT
`;
