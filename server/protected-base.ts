import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Environment } from '../shared/types.ts';
import { identityScript } from './network-guard.ts';
import { CONFIGURE_GUEST_HOSTNAME_SCRIPT } from './guest-hostname.ts';
import { CONFIGURE_NETWORKD_SCRIPT } from './guest-networkd.ts';

export const CONFIGURE_BOOT_CAPTURE_SCRIPT = `set -euo pipefail
if ! sudo test -x /usr/bin/tcpdump; then
  echo '此旧环境缺少启动抓包工具，不能提供启动阶段的抓包验证。' >&2
  exit 0
fi
sudo install -d -m 0700 /var/log/mucodesandbox
sudo tee /etc/systemd/system/mucodesandbox-boot-capture.service >/dev/null <<'MU_CAPTURE'
[Unit]
Description=MuCodeSandbox bounded boot validation capture
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target mucodesandbox-egress.service
ConditionPathExists=/etc/mucodesandbox/capture-boots

[Service]
Type=simple
RemainAfterExit=yes
ExecStartPre=/bin/rm -f /var/log/mucodesandbox/boot-network.pcap
ExecStartPre=/bin/sh -c 'cat /proc/sys/kernel/random/boot_id > /var/log/mucodesandbox/boot-network.boot-id'
ExecStart=/usr/bin/tcpdump -U -n -Q out -i any -s 96 -c 1000 -w /var/log/mucodesandbox/boot-network.pcap
ExecStartPost=/bin/bash -c 'for n in $(seq 1 100); do test -s /var/log/mucodesandbox/boot-network.pcap && exit 0; sleep 0.05; done; exit 1'
UMask=0077
Restart=no

[Install]
WantedBy=multi-user.target
MU_CAPTURE
sudo install -d -m 0755 /etc/mucodesandbox
sudo touch /etc/mucodesandbox/capture-boots
sudo install -d -m 0755 /etc/systemd/system/systemd-networkd.service.d
printf '[Unit]\\nRequires=mucodesandbox-boot-capture.service\\nAfter=mucodesandbox-boot-capture.service\\n' | sudo tee /etc/systemd/system/systemd-networkd.service.d/mucodesandbox-capture.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable mucodesandbox-boot-capture.service >/dev/null
`;

export const FINISH_BOOT_CAPTURE_SCRIPT = `set -euo pipefail
${CONFIGURE_BOOT_CAPTURE_SCRIPT}
sudo rm -f /etc/mucodesandbox/capture-first-boot
if sudo test -x /usr/bin/tcpdump; then
  mu_live_boot=$(cat /proc/sys/kernel/random/boot_id)
  mu_capture_boot=$(sudo cat /var/log/mucodesandbox/boot-network.boot-id 2>/dev/null || true)
  if [ "$mu_live_boot" != "$mu_capture_boot" ]; then
    echo '启动记录机制已升级。环境将安全停止，请再次启动；旧抓包不会作为本次启动的验证依据。' >&2
    exit 75
  fi
  # Keep the required unit active after tcpdump exits, so networkd stays running.
  sudo systemctl kill --kill-whom=main --signal=SIGINT mucodesandbox-boot-capture.service 2>/dev/null || true
  for n in $(seq 1 100); do
    [ "$(sudo systemctl show --property=SubState --value mucodesandbox-boot-capture.service)" = exited ] && break
    sleep 0.05
  done
  sudo systemctl is-active --quiet mucodesandbox-boot-capture.service
  test "$(sudo systemctl show --property=SubState --value mucodesandbox-boot-capture.service)" = exited
  sudo systemctl is-active --quiet systemd-networkd.service
fi
`;

export const PREPARE_BASE_SCRIPT = `set -euo pipefail
${CONFIGURE_GUEST_HOSTNAME_SCRIPT}
${CONFIGURE_NETWORKD_SCRIPT}
sudo apt-get update -qq
sudo apt-get install -y -qq tcpdump
${CONFIGURE_BOOT_CAPTURE_SCRIPT}
sudo touch /etc/mucodesandbox/capture-first-boot
sudo rm -f /home/mu/.bash_history
`;

export const CLEAN_BASE_SCRIPT = `set -euo pipefail
sudo cloud-init clean --logs --machine-id
`;

export function allBaseLocales(e: Environment) {
  return (['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'de-DE'] as const).map(locale => identityScript({ ...e, identity: { timezone: 'UTC', locale } })).join('\n');
}
export async function baseDiskHash(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) hash.update(bytes);
  return hash.digest('hex');
}
