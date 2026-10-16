import { createHash } from 'node:crypto';
import type { Environment } from '../shared/types.ts';
import { shellQuote } from './network-guard.ts';
import { wireguardSchema, wireguardSetconf, WIREGUARD_INTERFACE, WIREGUARD_MARK } from './wireguard.ts';

export const WG_UNIT_PATH = '/etc/systemd/system/mucodesandbox-wireguard.service';
export const WG_HELPER_PATH = '/usr/local/libexec/mu-wireguard';
export const WG_SECRET_PATH = '/etc/mucodesandbox/wireguard.conf';
export const WG_PUBLIC_PATH = '/etc/mucodesandbox/wireguard.json';
export const WG_DNS_DEPENDENCY_PATH = '/etc/systemd/system/mucodesandbox-tunnel.service.d/wireguard.conf';
export const WG_TABLE = 51821;
export const WG_DNS_ADDRESS = '127.0.0.55';

export function environmentWireguard(e: Environment) {
  if (e.kind !== 'vm' || e.network.mode !== 'wireguard' || !e.network.strict || !e.network.transparent) throw new Error('Invalid packet tunnel environment');
  return wireguardSchema.parse({ ...e.network.wireguard, endpoint: { address: e.network.host, port: e.network.port } });
}

export const WG_HELPER = `#!/usr/bin/python3
import json, os, subprocess, sys
ROOT = '/run/mucodesandbox-wireguard'
IFACE = '${WIREGUARD_INTERFACE}'
TABLE = '${WG_TABLE}'
def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout
def stop():
    if not os.path.exists(ROOT + '/state'): return
    with open(ROOT + '/state') as f: state = json.load(f)
    for priority in ['17100', '17101']:
        subprocess.run(['ip', '-4', 'rule', 'del', 'priority', priority], capture_output=True)
    subprocess.run(['ip', '-4', 'route', 'flush', 'table', TABLE], capture_output=True)
    subprocess.run(['ip', 'link', 'del', IFACE], capture_output=True)
    with open('/proc/sys/net/ipv4/conf/all/src_valid_mark', 'w') as f: f.write(state['srcValidMark'])
    os.unlink(ROOT + '/state')
if os.geteuid() != 0: sys.exit(77)
os.umask(0o077)
if sys.argv[1:] == ['stop']: stop(); sys.exit(0)
if sys.argv[1:] != ['start']: sys.exit(64)
if os.path.exists(ROOT + '/state'): raise RuntimeError('Packet tunnel already owns routing state')
if subprocess.run(['ip', 'link', 'show', IFACE], capture_output=True).returncode == 0: raise RuntimeError('Packet tunnel interface is already in use')
rules = json.loads(run('ip', '-j', '-4', 'rule', 'show'))
if any(r.get('priority') in [17100,17101] or str(r.get('table')) == TABLE for r in rules): raise RuntimeError('Packet tunnel routing priorities are already in use')
routes = subprocess.run(['ip','-4','route','show','table',TABLE],capture_output=True,text=True)
if routes.stdout.strip(): raise RuntimeError('Packet tunnel routing table is already in use')
with open('${WG_PUBLIC_PATH}') as f: config = json.load(f)
os.makedirs(ROOT, mode=0o700, exist_ok=True)
with open('/proc/sys/net/ipv4/conf/all/src_valid_mark') as f: old = f.read().strip()
with open(ROOT + '/state', 'x') as f: json.dump({'srcValidMark':old},f)
try:
    run('ip','link','add',IFACE,'type','wireguard')
    run('wg','setconf',IFACE,'${WG_SECRET_PATH}')
    run('ip','address','add',config['address'],'dev',IFACE)
    run('ip','link','set','dev',IFACE,'mtu',str(config['mtu']),'up')
    with open('/proc/sys/net/ipv4/conf/all/src_valid_mark','w') as f: f.write('1')
    run('ip','-4','route','add','default','dev',IFACE,'table',TABLE)
    run('ip','-4','rule','add','priority','17100','lookup','main','suppress_prefixlength','0')
    run('ip','-4','rule','add','priority','17101','not','fwmark','${WIREGUARD_MARK}','lookup',TABLE)
except Exception:
    stop()
    raise
`;

export const WG_UNIT = `[Unit]
Description=MuCodeSandbox kernel packet tunnel
Requires=mucodesandbox-egress.service mucodesandbox-lease.service
After=network-online.target mucodesandbox-egress.service mucodesandbox-lease.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${WG_HELPER_PATH} start
ExecStop=${WG_HELPER_PATH} stop
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
ProtectKernelModules=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
`;
export const WG_DNS_DEPENDENCY = `[Unit]
Requires=mucodesandbox-wireguard.service
After=mucodesandbox-wireguard.service
`;

export function wireguardFiles(e: Environment) {
  const c = environmentWireguard(e);
  return { [WG_SECRET_PATH]: wireguardSetconf(c), [WG_PUBLIC_PATH]: JSON.stringify({ address: c.address, mtu: c.mtu }), [WG_HELPER_PATH]: WG_HELPER, [WG_UNIT_PATH]: WG_UNIT, [WG_DNS_DEPENDENCY_PATH]: WG_DNS_DEPENDENCY };
}
export function wireguardBootHash(e: Environment) {
  return createHash('sha256').update(JSON.stringify(Object.values(wireguardFiles(e)).map(value => createHash('sha256').update(value).digest('hex')))).digest('hex');
}

export function wireguardDnsConfig(e: Environment) {
  environmentWireguard(e);
  const dns = e.network.dns ?? { address: '1.1.1.1', serverName: 'cloudflare-dns.com', port: 443, path: '/dns-query' };
  return {
    log: { disabled: true },
    dns: { servers: [{ type: 'https', tag: 'remote-dns', server: dns.address, server_port: dns.port, path: dns.path, tls: { enabled: true, server_name: dns.serverName }, detour: 'packet-dns' }], final: 'remote-dns', strategy: 'ipv4_only' },
    inbounds: [{ type: 'direct', tag: 'dns-in', listen: WG_DNS_ADDRESS, listen_port: 53 }],
    outbounds: [{ type: 'direct', tag: 'packet-dns', bind_interface: WIREGUARD_INTERFACE }],
    route: { rules: [{ inbound: ['dns-in'], action: 'hijack-dns' }, { action: 'reject' }] },
  };
}

/** Secret bytes are passed on stdin, never a process argument or output callback. */
export function startWireguardScript(e: Environment) {
  const files = wireguardFiles(e), dns = JSON.stringify(wireguardDnsConfig(e));
  return `set -euo pipefail
command -v wg >/dev/null
sudo install -d -m 0755 /etc/mucodesandbox /usr/local/libexec /etc/systemd/system/mucodesandbox-tunnel.service.d
${Object.entries(files).map(([file, content]) => `sudo rm -f ${file}.next\nsudo install -o root -g root -m ${file === WG_HELPER_PATH ? '0700' : '0600'} /dev/null ${file}.next\nprintf '%s' ${shellQuote(content)} | sudo tee ${file}.next >/dev/null\nsudo mv ${file}.next ${file}`).join('\n')}
printf '%s' ${shellQuote(dns)} | sudo tee /etc/mucodesandbox/tunnel.json.next >/dev/null
sudo chown root:mu-net /etc/mucodesandbox/tunnel.json.next
sudo chmod 0640 /etc/mucodesandbox/tunnel.json.next
sudo -u mu-net /usr/local/bin/mu-sing-box check -c /etc/mucodesandbox/tunnel.json.next
sudo mv /etc/mucodesandbox/tunnel.json.next /etc/mucodesandbox/tunnel.json
sudo systemctl daemon-reload
sudo systemctl enable mucodesandbox-wireguard.service mucodesandbox-tunnel.service >/dev/null
sudo systemctl restart mucodesandbox-wireguard.service
sudo systemctl restart mucodesandbox-tunnel.service
sudo install -d -m 0755 /etc/systemd/resolved.conf.d
printf '[Resolve]\\nDNS=${WG_DNS_ADDRESS}\\nFallbackDNS=\\nDomains=~.\\nLLMNR=no\\nMulticastDNS=no\\n' | sudo tee /etc/systemd/resolved.conf.d/mucodesandbox.conf >/dev/null
sudo systemctl restart systemd-resolved
for attempt in $(seq 1 60); do
  if sudo wg show ${WIREGUARD_INTERFACE} latest-handshakes | awk '$2 > 0 { found=1 } END { exit !found }'; then
    systemctl is-active --quiet mucodesandbox-tunnel.service
    echo 'Kernel packet tunnel peer handshake established'
    exit 0
  fi
  sleep 0.5
done
echo 'Packet tunnel handshake did not complete' >&2
exit 1
`;
}

export const STOP_WIREGUARD_SCRIPT = `set -euo pipefail
if [ -f ${WG_UNIT_PATH} ]; then
  sudo systemctl disable --now mucodesandbox-wireguard.service >/dev/null
  sudo ${WG_HELPER_PATH} stop
fi
sudo rm -f ${WG_SECRET_PATH} ${WG_PUBLIC_PATH} ${WG_DNS_DEPENDENCY_PATH}
sudo systemctl daemon-reload
`;

// The inspector never requests wg's dump or private-key output.
export const INSPECT_WIREGUARD_PYTHON = `
result.update({'wireguardStateHash':'','wireguardBootHash':'','wireguardHandshakeAge':-1})
if command(['ip','link','show','${WIREGUARD_INTERFACE}']).returncode == 0:
    result['transparentActive'] = False
    result['routingReady'] = False
    result['dnsGuardActive'] = False
    try:
        paths = ${JSON.stringify([WG_SECRET_PATH, WG_PUBLIC_PATH, WG_HELPER_PATH, WG_UNIT_PATH, WG_DNS_DEPENDENCY_PATH])}
        safe = True
        for file in paths:
            s = os.lstat(file)
            safe = safe and stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and not s.st_mode & 0o077
        if safe: result['wireguardBootHash'] = hashlib.sha256(json.dumps([file_hash(file) for file in paths],separators=(',',':')).encode()).hexdigest()
        def wg(field):
            r = command(['sudo','wg','show','${WIREGUARD_INTERFACE}',field])
            if r.returncode != 0: raise ValueError('WireGuard unavailable')
            return r.stdout.strip()
        peer = wg('peers')
        def peer_value(field):
            fields = wg(field).split()
            if len(fields) != 2 or fields[0] != peer: raise ValueError('Unexpected peers')
            return fields[1]
        link = json.loads(command(['ip','-j','address','show','dev','${WIREGUARD_INTERFACE}']).stdout)[0]
        addresses = link['addr_info']
        if len(addresses) != 1 or addresses[0]['family'] != 'inet': raise ValueError('Unexpected tunnel addresses')
        state = {'publicKey':wg('public-key'),'peerPublicKey':peer,'endpoint':peer_value('endpoints'),'address':addresses[0]['local']+'/'+str(addresses[0]['prefixlen']),'listenPort':int(wg('listen-port')),'mtu':link['mtu'],'mark':int(wg('fwmark'),0),'allowedIPs':peer_value('allowed-ips'),'keepalive':int(peer_value('persistent-keepalive'))}
        result['wireguardStateHash'] = hashlib.sha256(json.dumps(state,separators=(',',':')).encode()).hexdigest()
        handshake = int(peer_value('latest-handshakes'))
        if handshake > 0: result['wireguardHandshakeAge'] = max(0,int(datetime.datetime.now().timestamp())-handshake)
        dependencies = command(['systemctl','show','mucodesandbox-wireguard.service','-p','Requires','--value']).stdout.split()
        dns_dependencies = command(['systemctl','show','mucodesandbox-tunnel.service','-p','Requires','--value']).stdout.split()
        result['transparentActive'] = command(['systemctl','is-active','mucodesandbox-wireguard.service']).returncode == 0 and command(['systemctl','is-active','mucodesandbox-tunnel.service']).returncode == 0 and all(dep in dependencies for dep in ['mucodesandbox-egress.service','mucodesandbox-lease.service']) and 'mucodesandbox-wireguard.service' in dns_dependencies and 'UP' in link['flags']
        rules = json.loads(command(['ip','-j','-4','rule','show']).stdout)
        owned = [r for r in rules if r.get('priority') in [17100,17101] or str(r.get('table')) == '${WG_TABLE}']
        expected = [{'priority':17100,'src':'all','table':'main','suppress_prefixlen':0},{'priority':17101,'not':None,'src':'all','fwmark':'${'0x' + WIREGUARD_MARK.toString(16)}','table':'${WG_TABLE}'}]
        for r in owned:
            r.pop('protocol',None)
            if 'table' in r: r['table'] = str(r['table'])
        inner = command(['ip','-4','route','get','198.51.100.1','uid',str(os.getuid())])
        outer = command(['ip','-4','route','get',state['endpoint'].split(':')[0],'mark',str(${WIREGUARD_MARK})])
        mark = command(['cat','/proc/sys/net/ipv4/conf/all/src_valid_mark']).stdout.strip()
        table = json.loads(command(['ip','-j','-4','route','show','table','${WG_TABLE}']).stdout)
        result['wireguardRoutingRules'] = owned
        result['routingReady'] = owned == expected and mark == '1' and inner.returncode == 0 and 'dev ${WIREGUARD_INTERFACE}' in inner.stdout and outer.returncode == 0 and 'dev ${WIREGUARD_INTERFACE}' not in outer.stdout and len(table) == 1 and table[0].get('dst') == 'default' and table[0].get('dev') == '${WIREGUARD_INTERFACE}'
        dns = command(['resolvectl','dns']).stdout.splitlines()
        domains = command(['resolvectl','domain']).stdout.splitlines()
        result['dnsGuardActive'] = 'Global: ${WG_DNS_ADDRESS}' in dns and 'Global: ~.' in domains and command(['systemctl','is-active','systemd-resolved']).returncode == 0 and os.path.realpath('/etc/resolv.conf') == '/run/systemd/resolve/stub-resolv.conf'
    except (OSError,ValueError,KeyError,TypeError): pass
`;
