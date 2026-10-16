import { createHash } from 'node:crypto';

export const NETWORKD_POLICY_PATH = '/etc/systemd/networkd.conf.d/99-mucodesandbox.conf';
export const NETWORKD_POLICY = `[Network]
ManageForeignRoutingPolicyRules=no
ManageForeignRoutes=no
`;
export const NETWORKD_POLICY_SHA256 = createHash('sha256').update(NETWORKD_POLICY).digest('hex');

export function networkdBootFingerprint(firewallFileHash: string) {
  return createHash('sha256').update(JSON.stringify([firewallFileHash, NETWORKD_POLICY_SHA256])).digest('hex');
}

export const CONFIGURE_NETWORKD_SCRIPT = `sudo install -d -m 0755 /etc/systemd/networkd.conf.d
if [ -L ${NETWORKD_POLICY_PATH} ]; then echo 'Network protection policy must not be a symlink' >&2; exit 1; fi
mu_networkd_changed=0
if ! printf '%s' '${NETWORKD_POLICY}' | sudo cmp -s - ${NETWORKD_POLICY_PATH}; then
  printf '%s' '${NETWORKD_POLICY}' | sudo tee ${NETWORKD_POLICY_PATH}.next >/dev/null
  sudo chown root:root ${NETWORKD_POLICY_PATH}.next
  sudo chmod 0644 ${NETWORKD_POLICY_PATH}.next
  sudo mv ${NETWORKD_POLICY_PATH}.next ${NETWORKD_POLICY_PATH}
  mu_networkd_changed=1
fi
sudo chown root:root ${NETWORKD_POLICY_PATH}
sudo chmod 0644 ${NETWORKD_POLICY_PATH}
if [ "$mu_networkd_changed" = 1 ]; then
  # A new clone already inherits this policy, so its first-boot capture is not restarted.
  if [ -e /etc/mucodesandbox/capture-first-boot ]; then
    echo '网络防护设置已升级。为保留首次开机记录，环境将安全停止；请再次启动以加载设置，用户数据不会被删除。' >&2
    exit 75
  fi
  sudo systemctl restart systemd-networkd.service
  sudo systemctl is-active --quiet systemd-networkd.service
fi
`;
