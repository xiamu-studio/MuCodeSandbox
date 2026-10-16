import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { validateWireguardTransport, WIREGUARD_INTERFACE, WIREGUARD_MARK, type WireguardTransport } from './wireguard.ts';

export const LEASE_SECONDS = 45;
export const LEASE_HELPER_PATH = '/usr/local/libexec/mu-network-lease';
export const LEASE_RULES_PATH = '/etc/mucodesandbox/lease.nft';
export const LEASE_UNIT_PATH = '/etc/systemd/system/mucodesandbox-lease.service';
export const LEASE_DEPENDENCY_PATH = '/etc/systemd/system/mucodesandbox-egress.service.d/lease.conf';
const PROBE_MARK = '0x4d550001', TUNNEL_MARK = '0x4d550002';

export function leaseRules(gateway: string, networkUid: number, probeUid: number, tunnelUid?: number, wireguard?: WireguardTransport) {
  if (!isIPv4(gateway) || [networkUid,probeUid,...(tunnelUid !== undefined ? [tunnelUid] : [])].some(uid=>!Number.isSafeInteger(uid)||uid<1)) throw new Error('Invalid lease identity');
  if (wireguard) validateWireguardTransport(wireguard);
  if (wireguard && tunnelUid) throw new Error('Packet tunnels cannot exempt a userspace network service');
  return `add table inet mu_lease
delete table inet mu_lease
table inet mu_lease {
  set permit { type nf_proto; flags timeout; timeout ${LEASE_SECONDS}s; }
  counter blocked { }
  chain output {
    type filter hook output priority -10; policy drop;
    oifname "lo" meta l4proto { tcp, udp } th dport 53 meta nfproto @permit accept
    oifname "lo" meta l4proto { tcp, udp } th dport 53 counter name blocked drop
    oifname "lo" accept
    meta skuid 0 ip daddr ${gateway} tcp sport 22 accept
    meta skuid { 0, ${networkUid} } ip daddr { 255.255.255.255, ${gateway} } udp sport 68 udp dport 67 accept
    meta skuid ${probeUid} oifname "${wireguard ? WIREGUARD_INTERFACE : 'mu_tun'}" ct mark set ${PROBE_MARK} accept
    ${wireguard ? `meta mark ${WIREGUARD_MARK} ip daddr ${wireguard.endpoint.address} udp sport ${wireguard.listenPort} udp dport ${wireguard.endpoint.port} ct mark set ${TUNNEL_MARK} accept` : ''}
    ${tunnelUid ? `meta skuid ${tunnelUid} ct mark set ${TUNNEL_MARK} accept` : ''}
    meta nfproto @permit accept
    counter name blocked drop
  }
  chain input {
    type filter hook input priority -10; policy drop;
    iifname "lo" accept
    ip saddr ${gateway} tcp dport 22 accept
    ip saddr ${gateway} udp sport 67 udp dport 68 accept
    ct mark { ${PROBE_MARK}, ${TUNNEL_MARK} } accept
    meta nfproto @permit accept
    counter name blocked drop
  }
}
`;
}

export const LEASE_HELPER = `#!/usr/bin/python3
import fcntl, json, os, subprocess, sys, time
ROOT = '/run/mucodesandbox-lease'
def nft(*args):
    return subprocess.run(['/usr/sbin/nft', *args], check=True, capture_output=True, text=True)
def live():
    data = json.loads(nft('-j', 'list', 'set', 'inet', 'mu_lease', 'permit').stdout)
    return any(item.get('set', {}).get('elem') for item in data.get('nftables', []))
def save(state):
    with open(ROOT + '/state.next', 'w') as f:
        json.dump(state, f)
    os.chmod(ROOT + '/state.next', 0o600)
    os.replace(ROOT + '/state.next', ROOT + '/state')
def close(state):
    nft('flush', 'set', 'inet', 'mu_lease', 'permit')
    state['state'] = 'closed'
    state['deadline'] = 0
    save(state)
if os.geteuid() != 0: sys.exit(77)
os.umask(0o077)
action = sys.argv[1] if len(sys.argv) > 1 else ''
if action not in ['activate', 'renew', 'revoke', 'status']: sys.exit(64)
with open(ROOT + '/lock', 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    with open(ROOT + '/state') as f: state = json.load(f)
    with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
    now = time.clock_gettime(time.CLOCK_BOOTTIME)
    active = state.get('boot') == boot and state.get('state') == 'active' and state.get('deadline', 0) > now and live()
    if action == 'status':
        print(json.dumps({'active': active, 'remainingMs': max(0, int((state.get('deadline', 0) - now) * 1000)) if active else 0}))
        sys.exit(0)
    if len(sys.argv) != 3 or state.get('session') != sys.argv[2] or state.get('boot') != boot: sys.exit(77)
    if action == 'revoke': close(state); sys.exit(0)
    if (action == 'activate' and state.get('state') != 'pending') or (action == 'renew' and not active):
        close(state)
        sys.exit(75)
    # A single kernel transaction replaces the expiring element without an open gap.
    try:
        subprocess.run(['/usr/sbin/nft', '-f', '-'], input='flush set inet mu_lease permit\\nadd element inet mu_lease permit { ipv4 timeout ${LEASE_SECONDS}s }\\n', text=True, check=True, capture_output=True)
        state['state'] = 'active'
        state['deadline'] = now + ${LEASE_SECONDS}
        save(state)
    except Exception:
        # Closing the kernel permission must not depend on writable state storage.
        nft('flush', 'set', 'inet', 'mu_lease', 'permit')
        raise
    print(json.dumps({'active': True, 'remainingMs': ${LEASE_SECONDS * 1000}}))
`;

export const LEASE_UNIT = `[Unit]
Description=MuCodeSandbox expiring business network permission
DefaultDependencies=no
After=local-fs.target nftables.service
Before=network-pre.target mucodesandbox-egress.service

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f ${LEASE_RULES_PATH}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
export const LEASE_DEPENDENCY = `[Unit]
Requires=mucodesandbox-lease.service
After=mucodesandbox-lease.service
`;
export function leaseFiles(rules: string) {
  return { [LEASE_RULES_PATH]: rules, [LEASE_HELPER_PATH]: LEASE_HELPER, [LEASE_UNIT_PATH]: LEASE_UNIT, [LEASE_DEPENDENCY_PATH]: LEASE_DEPENDENCY };
}
export function leaseBootHash(rules: string) {
  return createHash('sha256').update(JSON.stringify(Object.values(leaseFiles(rules)).map(value=>createHash('sha256').update(value).digest('hex')))).digest('hex');
}
export const LEASE_RECIPE = createHash('sha256').update(LEASE_HELPER + LEASE_UNIT + LEASE_DEPENDENCY + leaseRules.toString()).digest('hex');

export const INSPECT_LEASE_PYTHON = `
result.update({'leasePrepared': False, 'leaseActive': False, 'leaseRemainingMs': 0, 'leaseRulesHash': '', 'leaseBootHash': ''})
try:
    paths = ${JSON.stringify([LEASE_RULES_PATH, LEASE_HELPER_PATH, LEASE_UNIT_PATH, LEASE_DEPENDENCY_PATH])}
    safe = True
    for file in paths:
        s = os.lstat(file)
        safe = safe and stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and not s.st_mode & 0o022
    dependencies = command(['systemctl', 'show', 'mucodesandbox-egress.service', '-p', 'Requires', '--value']).stdout.split()
    safe = safe and 'mucodesandbox-lease.service' in dependencies and command(['systemctl', 'is-enabled', 'mucodesandbox-lease.service']).returncode == 0
    if safe:
        result['leaseBootHash'] = hashlib.sha256(json.dumps([file_hash(file) for file in paths], separators=(',', ':')).encode()).hexdigest()
    objects = json.loads(command(['sudo', 'nft', '-j', 'list', 'table', 'inet', 'mu_lease']).stdout)['nftables']
    result['blockedPackets'] += sum(x['counter'].get('packets', 0) for x in objects if 'counter' in x and x['counter'].get('name') == 'blocked')
    structure = [stable(x) for x in objects if 'metainfo' not in x]
    for item in structure:
        if 'set' in item: item['set'].pop('elem', None)
    result['leaseRulesHash'] = hashlib.sha256(json.dumps(structure, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    status = command(['sudo', '${LEASE_HELPER_PATH}', 'status'])
    if status.returncode == 0:
        lease = json.loads(status.stdout)
        result['leaseActive'] = lease.get('active') is True
        result['leaseRemainingMs'] = lease.get('remainingMs', 0)
    result['leasePrepared'] = safe and bool(result['leaseRulesHash'])
except (OSError, ValueError, KeyError, TypeError): pass
`;
