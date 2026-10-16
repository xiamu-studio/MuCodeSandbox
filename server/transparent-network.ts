import { isIPv4 } from 'node:net';
import type { Environment } from '../shared/types.ts';
import { shellQuote } from './network-guard.ts';

export const SING_BOX_VERSION = '1.14.3';
export const SING_BOX_SHA256 = '29dae24d76bea3bc62d07dd3e60cfc12003de7debbd6b768df9be9c68360174e';
export const SING_BOX_ARCHIVE = `sing-box-${SING_BOX_VERSION}-linux-arm64.tar.gz`;
export const SING_BOX_URL = `https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/${SING_BOX_ARCHIVE}`;
export const TUN_INTERFACE = 'mu_tun';

export function transparentConfig(e: Environment, proxyIP: string, serviceUid: number, connectedRoutes: string[], probePort?: number) {
  if (!e.network.strict || !e.network.transparent || ['direct','wireguard'].includes(e.network.mode) || !isIPv4(proxyIP) || !Number.isInteger(serviceUid) || serviceUid < 1 || connectedRoutes.some(r => { const [ip, prefix] = r.split('/'); return !isIPv4(ip) || !/^\d+$/.test(prefix ?? '') || Number(prefix) < 0 || Number(prefix) > 32; })) throw new Error('Invalid transparent network configuration');
  if(e.network.mode==='https'&&!e.network.tls?.serverName)throw new Error('Encrypted upstream requires a certificate server name');
  if (probePort !== undefined && (!e.network.egressLock || proxyIP !== '127.0.0.1' || !Number.isInteger(probePort) || probePort < 1 || probePort > 65535 || probePort === e.network.port)) throw new Error('Invalid exit probe listener');
  const upstream = { type: e.network.mode === 'socks5' ? 'socks' : 'http', tag: 'upstream', server: proxyIP, server_port: e.network.port, username: e.network.username, password: e.network.password ?? '', ...(e.network.mode === 'socks5' ? { version: '5', network: 'tcp' } : {}), ...(e.network.mode==='https'?{tls:{enabled:true,server_name:e.network.tls!.serverName,min_version:'1.2',alpn:['http/1.1'],...(e.network.tls!.certificate?{certificate:[e.network.tls!.certificate]}:{})}}:{}) };
  const dns = e.network.dns ?? { address: '1.1.1.1', serverName: 'cloudflare-dns.com', port: 443, path: '/dns-query' };
  return {
    log: { disabled: false, level: 'info', timestamp: false },
    dns: { servers: [{ type: 'https', tag: 'remote-dns', server: dns.address, server_port: dns.port, path: dns.path, tls: { enabled: true, server_name: dns.serverName }, detour: 'upstream' }], final: 'remote-dns', strategy: 'ipv4_only' },
    inbounds: [{ type: 'tun', tag: 'mu-tun', interface_name: TUN_INTERFACE, stack:'system', address: ['172.19.0.1/30'], mtu: 1500, auto_route: true, auto_redirect: false, strict_route: true, dns_mode: 'disabled', exclude_uid: [serviceUid], route_exclude_address: [...new Set([...connectedRoutes, `${proxyIP}/32`])] },
      ...(probePort ? [{ type: 'socks', tag: 'exit-probe', listen: '127.0.0.1', listen_port: probePort }] : [])],
    outbounds: [upstream],
    route: { rules: [...(probePort ? [
      { inbound: ['exit-probe'], network: 'udp', action: 'reject' },
      { inbound: ['exit-probe'], action: 'resolve', server: 'remote-dns', strategy: 'ipv4_only' },
    ] : []), { port: 53, action: 'hijack-dns' }, { network: 'udp', action: 'reject' }, { ip_version: 6, action: 'reject' }], final: 'upstream' },
  };
}

export function installTransparentScript(archive: string) {
  return `set -euo pipefail
stage=$(mktemp -d)
trap 'rm -rf "$stage" ${shellQuote(archive)}' EXIT
tar -xzf ${shellQuote(archive)} -C "$stage"
sudo install -m 0755 "$stage/sing-box-${SING_BOX_VERSION}-linux-arm64/sing-box" /usr/local/bin/mu-sing-box
sudo install -d -m 0755 /usr/local/share/doc/mu-sing-box
sudo install -m 0644 "$stage/sing-box-${SING_BOX_VERSION}-linux-arm64/LICENSE" /usr/local/share/doc/mu-sing-box/LICENSE
id mu-net >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin mu-net
sudo tee /etc/systemd/system/mucodesandbox-tunnel.service >/dev/null <<'MU_UNIT'
[Unit]
Description=MuCodeSandbox transparent guest network
Requires=mucodesandbox-egress.service
After=network-online.target mucodesandbox-egress.service systemd-resolved.service
Wants=network-online.target

[Service]
User=mu-net
Group=mu-net
ExecStart=/usr/local/bin/mu-sing-box run -c /etc/mucodesandbox/tunnel.json
Restart=on-failure
RestartSec=3
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
UMask=0077

[Install]
WantedBy=multi-user.target
MU_UNIT
sudo systemctl daemon-reload
/usr/local/bin/mu-sing-box version | head -n 1
`;
}

export function startTransparentScript(config: ReturnType<typeof transparentConfig>) {
  return `set -euo pipefail
sudo install -d -m 0755 /etc/systemd/system/mucodesandbox-tunnel.service.d /etc/systemd/journald@mucodesandbox-network.conf.d
sudo tee /etc/systemd/system/mucodesandbox-tunnel.service.d/observations.conf >/dev/null <<'MU_LOG_UNIT'
[Service]
LogNamespace=mucodesandbox-network
LogRateLimitIntervalSec=30s
LogRateLimitBurst=2000
MU_LOG_UNIT
sudo tee /etc/systemd/journald@mucodesandbox-network.conf.d/limits.conf >/dev/null <<'MU_LOG_LIMITS'
[Journal]
Storage=volatile
RuntimeMaxUse=8M
RuntimeMaxFileSize=1M
MaxRetentionSec=7day
MU_LOG_LIMITS
sudo chmod 0644 /etc/systemd/system/mucodesandbox-tunnel.service.d/observations.conf /etc/systemd/journald@mucodesandbox-network.conf.d/limits.conf
sudo systemctl daemon-reload
printf '%s' ${shellQuote(JSON.stringify(config))} | sudo tee /etc/mucodesandbox/tunnel.json.next >/dev/null
sudo chown root:mu-net /etc/mucodesandbox/tunnel.json.next
sudo chmod 0640 /etc/mucodesandbox/tunnel.json.next
sudo -u mu-net /usr/local/bin/mu-sing-box check -c /etc/mucodesandbox/tunnel.json.next
sudo mv /etc/mucodesandbox/tunnel.json.next /etc/mucodesandbox/tunnel.json
sudo systemctl enable mucodesandbox-tunnel.service >/dev/null
sudo systemctl restart mucodesandbox-tunnel.service
for attempt in $(seq 1 40); do
  if systemctl is-active --quiet mucodesandbox-tunnel.service && ip link show ${TUN_INTERFACE} >/dev/null 2>&1; then break; fi
  sleep 0.25
done
systemctl is-active --quiet mucodesandbox-tunnel.service
ip link show ${TUN_INTERFACE} >/dev/null
sudo install -d -m 0755 /etc/systemd/resolved.conf.d
sudo tee /etc/systemd/resolved.conf.d/mucodesandbox.conf >/dev/null <<'MU_DNS'
[Resolve]
DNS=172.19.0.2
FallbackDNS=
Domains=~.
LLMNR=no
MulticastDNS=no
MU_DNS
sudo systemctl restart systemd-resolved
echo 'Transparent TCP and proxy DNS enabled'
`;
}

export const STOP_TRANSPARENT_SCRIPT = `set -euo pipefail
if [ -f /etc/systemd/system/mucodesandbox-tunnel.service ]; then
  sudo systemctl disable --now mucodesandbox-tunnel.service >/dev/null
  sudo rm -f /etc/mucodesandbox/tunnel.json /etc/mucodesandbox/tunnel.json.next
fi
if [ -f /etc/systemd/resolved.conf.d/mucodesandbox.conf ]; then
  sudo rm -f /etc/systemd/resolved.conf.d/mucodesandbox.conf
  sudo systemctl restart systemd-resolved
fi
`;
