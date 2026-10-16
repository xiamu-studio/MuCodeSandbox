import { isIPv4 } from 'node:net';
import type { Environment } from '../shared/types.ts';
import { NETWORKD_POLICY_PATH } from './guest-networkd.ts';
import { INSPECT_LEASE_PYTHON } from './guest-lease.ts';
import { validateWireguardTransport, WIREGUARD_INTERFACE, WIREGUARD_MARK, type WireguardTransport } from './wireguard.ts';

export const GUARD_VERSION = 5;
export const linuxLocales = { 'en-US': 'en_US.UTF-8', 'zh-CN': 'zh_CN.UTF-8', 'zh-TW': 'zh_TW.UTF-8', 'ja-JP': 'ja_JP.UTF-8', 'de-DE': 'de_DE.UTF-8' } as const;
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function firewallRules(proxyIPs: string[], proxyPort: number, replyPorts: number[], gateway: string, transparentUid?: number, networkUid = 0, wireguard?: WireguardTransport, relayPort?: number, probe?: { port: number; uid: number }) {
  if (!isIPv4(gateway) || proxyIPs.some(ip => !isIPv4(ip)) || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535 || replyPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535) || (transparentUid !== undefined && (!Number.isInteger(transparentUid) || transparentUid < 1)) || !Number.isInteger(networkUid) || networkUid < 0) throw new Error('Invalid firewall endpoint');
  const ports = [...new Set(replyPorts)].join(', ');
  if (wireguard) validateWireguardTransport(wireguard);
  if (wireguard && (proxyIPs.length || transparentUid)) throw new Error('Packet tunnels cannot use a connection proxy exception');
  if (relayPort !== undefined && (!transparentUid || wireguard || !Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535 || proxyPort !== relayPort || proxyIPs.length !== 1 || proxyIPs[0] !== '127.0.0.1')) throw new Error('Invalid private proxy relay');
  if (probe && (!relayPort || !Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535 || probe.port === relayPort || !Number.isInteger(probe.uid) || probe.uid < 1 || probe.uid === transparentUid)) throw new Error('Invalid private exit probe');
  return `add table inet mu_egress
delete table inet mu_egress
table inet mu_egress {
  counter blocked { }
  ${wireguard ? `chain transport_mark {
    type filter hook prerouting priority mangle; policy accept;
    ip saddr ${wireguard.endpoint.address} udp sport ${wireguard.endpoint.port} udp dport ${wireguard.listenPort} meta mark set ${WIREGUARD_MARK}
  }` : ''}
  chain output {
    type filter hook output priority 0; policy drop;
    ${relayPort ? `oifname "lo" ip daddr 127.0.0.1 tcp dport ${relayPort} meta skuid != ${transparentUid} counter name blocked drop` : ''}
    ${probe ? `oifname "lo" ip daddr 127.0.0.1 tcp dport ${probe.port} meta skuid != ${probe.uid} counter name blocked drop` : ''}
    oifname "lo" accept
    meta skuid 0 ip daddr ${gateway} tcp sport 22 accept
    ${ports ? `tcp sport { ${ports} } ct state established ct direction reply accept` : ''}
    meta skuid { 0${networkUid ? `, ${networkUid}` : ''} } ip daddr { 255.255.255.255, ${gateway} } udp sport 68 udp dport 67 accept
    ${transparentUid ? 'oifname "mu_tun" meta nfproto ipv4 meta l4proto tcp accept\n    oifname "mu_tun" meta nfproto ipv4 udp dport 53 accept' : ''}
    ${wireguard ? `oifname "${WIREGUARD_INTERFACE}" meta nfproto ipv4 meta l4proto tcp tcp dport != 53 accept
    meta mark ${WIREGUARD_MARK} ip daddr ${wireguard.endpoint.address} udp sport ${wireguard.listenPort} udp dport ${wireguard.endpoint.port} accept` : ''}
    ${proxyIPs.length ? `${transparentUid ? `meta skuid ${transparentUid} ` : ''}ip daddr { ${proxyIPs.join(', ')} } tcp dport ${proxyPort} accept` : ''}
    counter name blocked drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    counter name blocked drop
  }
}
`;
}

export const INSTALL_GUARD_SCRIPT = `set -euo pipefail
if ! command -v nft >/dev/null || [ ! -d /usr/share/i18n/locales ]; then
  sudo --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY apt-get update -qq
  sudo --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY apt-get install -y -qq nftables locales
fi
sudo install -d -m 0755 /etc/mucodesandbox /usr/local/libexec
sudo tee /usr/local/bin/mu-proxy-run >/dev/null <<'MU_WRAPPER'
#!/bin/bash
set -euo pipefail
set -a
. /etc/mucodesandbox/environment
set +a
exec "$@"
MU_WRAPPER
sudo chmod 0755 /usr/local/bin/mu-proxy-run
sudo tee /etc/systemd/system/mucodesandbox-egress.service >/dev/null <<'MU_UNIT'
[Unit]
Description=MuCodeSandbox guest egress guard
DefaultDependencies=no
After=local-fs.target nftables.service
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/mucodesandbox/network.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
MU_UNIT
sudo systemctl daemon-reload
echo 'Network guard components installed'
`;

export function identityScript(e: Environment) {
  const locale = linuxLocales[e.identity.locale];
  const language = locale.split('.')[0];
  return `set -euo pipefail
if ! locale -a | grep -qi '^${language}\\.utf8$'; then
  if [ ! -d /usr/share/i18n/locales ]; then
    sudo --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY apt-get update -qq
    sudo --preserve-env=http_proxy,https_proxy,all_proxy,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY apt-get install -y -qq locales
  fi
sudo localedef -i ${shellQuote(language)} -f UTF-8 ${shellQuote(locale)}
fi
sudo update-locale LANG=${shellQuote(locale)} LC_ALL=${shellQuote(locale)}
sudo ln -snf ${shellQuote(`/usr/share/zoneinfo/${e.identity.timezone}`)} /etc/localtime
printf '%s\\n' ${shellQuote(e.identity.timezone)} | sudo tee /etc/timezone >/dev/null
echo 'Timezone and locale applied'
`;
}

export function applyGuardScript(rules: string, endpoints: string[], environment: string, enabled: boolean) {
  return `set -euo pipefail
sudo install -d -m 0755 /etc/mucodesandbox
printf '%s' ${shellQuote(environment)} | sudo tee /etc/mucodesandbox/environment >/dev/null
sudo chown root:dev /etc/mucodesandbox/environment
sudo chmod 0640 /etc/mucodesandbox/environment
sudo tee /etc/profile.d/99-mucodesandbox.sh >/dev/null <<'MU_PROFILE'
if [ -r /etc/mucodesandbox/environment ]; then
  set -a
  . /etc/mucodesandbox/environment
  set +a
fi
MU_PROFILE
sudo chmod 0644 /etc/profile.d/99-mucodesandbox.sh
printf '%s' ${shellQuote(JSON.stringify(endpoints))} | sudo tee /etc/mucodesandbox/proxy-endpoints.json >/dev/null
printf '%s' ${shellQuote(rules)} | sudo tee /etc/mucodesandbox/network.nft.next >/dev/null
sudo chmod 0600 /etc/mucodesandbox/network.nft.next
${enabled ? `sudo nft --check -f /etc/mucodesandbox/network.nft.next
sudo nft -f /etc/mucodesandbox/network.nft.next
sudo mv /etc/mucodesandbox/network.nft.next /etc/mucodesandbox/network.nft
sudo install -d -m 0755 /etc/systemd/system/systemd-networkd.service.d
printf '[Unit]\\nRequires=mucodesandbox-egress.service\\nAfter=mucodesandbox-egress.service\\n' | sudo tee /etc/systemd/system/systemd-networkd.service.d/mucodesandbox.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable mucodesandbox-egress.service >/dev/null
sudo systemctl restart mucodesandbox-egress.service
echo 'Guest egress is restricted'` : `sudo systemctl disable mucodesandbox-egress.service >/dev/null
sudo nft delete table inet mu_egress 2>/dev/null || true
sudo rm -f /etc/systemd/system/systemd-networkd.service.d/mucodesandbox.conf
sudo systemctl daemon-reload
sudo rm -f /etc/mucodesandbox/network.nft.next
echo 'Guest egress uses the configured application policy'`}
`;
}

export function guestEnvironment(e: Environment, proxy = '') {
  if (e.network.transparent) proxy = '';
  const values: Record<string, string> = { TZ: e.identity.timezone, LANG: linuxLocales[e.identity.locale], LC_ALL: linuxLocales[e.identity.locale] };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) values[name] = proxy;
  values.NO_PROXY = values.no_proxy = e.network.strict ? 'localhost,127.0.0.1,::1' : e.network.noProxy;
  return Object.entries(values).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n') + '\n';
}

export const INSPECT_GUARD_SCRIPT = `python3 - <<'MU_STATUS'
import json, os, subprocess, datetime, hashlib, configparser, stat
def command(args):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env={**os.environ,'LC_ALL':'C','LANG':'C'})
ready = os.path.exists('/usr/local/bin/mu-proxy-run') and os.path.exists('/usr/sbin/nft')
result = {'prepared': ready, 'bootArmed': False, 'active': False, 'firewallActive': False, 'transparentReady': os.path.exists('/usr/local/bin/mu-sing-box'), 'transparentActive': False, 'proxyEndpoints': [], 'blockedPackets': 0, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'firewallHash': '', 'bootFileHash': '', 'tunnelConfigHash': '', 'routingReady': False, 'dnsGuardActive': False}
def file_hash(file):
    r = command(['sudo', 'sha256sum', file])
    return r.stdout.split()[0] if r.returncode == 0 else ''
def stable(value):
    if isinstance(value, dict): return {k: stable(v) for k,v in value.items() if k not in ['handle','packets','bytes']}
    if isinstance(value, list): return [stable(v) for v in value]
    return value
result['transparentActive'] = command(['systemctl', 'is-active', 'mucodesandbox-tunnel.service']).returncode == 0 and command(['ip', 'link', 'show', 'mu_tun']).returncode == 0
networkd_policy_hash = ''
try:
    policy_stat = os.lstat('${NETWORKD_POLICY_PATH}')
    merged = command(['systemd-analyze', 'cat-config', 'systemd/networkd.conf'])
    settings = configparser.ConfigParser(strict=False, interpolation=None)
    settings.read_string(merged.stdout)
    if merged.returncode == 0 and stat.S_ISREG(policy_stat.st_mode) and policy_stat.st_uid == 0 and policy_stat.st_gid == 0 and not policy_stat.st_mode & 0o022 and not settings.getboolean('Network', 'ManageForeignRoutingPolicyRules', fallback=True) and not settings.getboolean('Network', 'ManageForeignRoutes', fallback=True):
        networkd_policy_hash = file_hash('${NETWORKD_POLICY_PATH}')
except (OSError, ValueError, configparser.Error): pass
result['bootFileHash'] = hashlib.sha256(json.dumps([file_hash('/etc/mucodesandbox/network.nft'), networkd_policy_hash], separators=(',', ':')).encode()).hexdigest()
result['tunnelConfigHash'] = file_hash('/etc/mucodesandbox/tunnel.json')
route = command(['ip','-4','route','get','198.51.100.1','uid',str(os.getuid())])
result['routingReady'] = route.returncode == 0 and 'dev mu_tun' in route.stdout
dns = command(['resolvectl', 'dns']).stdout.splitlines()
domains = command(['resolvectl', 'domain']).stdout.splitlines()
result['dnsGuardActive'] = 'Global: 172.19.0.2' in dns and 'Global: ~.' in domains and command(['systemctl','is-active','systemd-resolved']).returncode == 0 and os.path.realpath('/etc/resolv.conf') == '/run/systemd/resolve/stub-resolv.conf'
if ready:
    dependencies = command(['systemctl','show','systemd-networkd.service','-p','Requires','--value']).stdout.split()
    result['bootArmed'] = command(['systemctl', 'is-enabled', 'mucodesandbox-egress.service']).returncode == 0 and 'mucodesandbox-egress.service' in dependencies
    r = command(['sudo', 'nft', '-j', 'list', 'table', 'inet', 'mu_egress'])
    if r.returncode == 0:
        objects = json.loads(r.stdout).get('nftables', [])
        approved = [stable(x) for x in objects if 'metainfo' not in x]
        result['firewallHash'] = hashlib.sha256(json.dumps(approved,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        chains = [x['chain'] for x in objects if 'chain' in x]
        result['active'] = all(any(c.get('name') == name and c.get('hook') == name and c.get('policy') == 'drop' for c in chains) for name in ['output','forward'])
        result['firewallActive'] = result['active']
        counters = [x['counter'] for x in objects if 'counter' in x and x['counter'].get('name') == 'blocked']
        result['blockedPackets'] = sum(c.get('packets',0) for c in counters)
    try:
        with open('/etc/mucodesandbox/proxy-endpoints.json') as f: result['proxyEndpoints'] = json.load(f)
    except FileNotFoundError: pass
${INSPECT_LEASE_PYTHON}
# MU_PACKET_STATUS
print(json.dumps(result))
MU_STATUS
`;
