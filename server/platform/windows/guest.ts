import { stringify } from 'yaml';
import { randomUUID } from 'node:crypto';
import type { Environment } from '../../../shared/types.ts';
import { firewallRules, INSTALL_GUARD_SCRIPT, applyGuardScript, guestEnvironment, shellQuote } from '../../network-guard.ts';
import { leaseFiles, leaseRules, LEASE_HELPER_PATH } from '../../guest-lease.ts';
import { transparentConfig, startTransparentScript, SING_BOX_VERSION } from '../../transparent-network.ts';
import { CONFIGURE_NETWORKD_SCRIPT } from '../../guest-networkd.ts';
import { NET_UID, PROBE_UID, PROBE_PORT, RELAY_PORT, vmIdentity, type WindowsConfig } from './config.ts';
import { GUEST_CHANNEL, GUEST_CHANNEL_UNIT } from './channel.ts';

export const WINDOWS_CLOUD_AGENT_UNITS=['walinuxagent.service','waagent.service'] as const;
// Local NoCloud guests have no Azure fabric. The inherited agent otherwise
// waits 1800 seconds and then adds a DHCP broadcast route to the tunnel NIC.
export const WINDOWS_LOCAL_GUEST_SERVICES=`set -eu
for unit in ${WINDOWS_CLOUD_AGENT_UNITS.join(' ')}; do
  state=$(sudo systemctl is-active "$unit" 2>/dev/null || true)
  case "$state" in
    active|activating|deactivating|reloading) sudo systemctl stop "$unit" ;;
    inactive|failed|unknown) ;;
    *) printf '%s\\n' 'Unexpected cloud agent state; business permission remains closed.' >&2; exit 1 ;;
  esac
  sudo systemctl mask "$unit" >/dev/null
  test "$(sudo systemctl is-enabled "$unit" 2>/dev/null || true)" = masked
  state=$(sudo systemctl show --property=ActiveState --value "$unit")
  case "$state" in inactive|failed) ;; *) exit 1 ;; esac
  test "$(sudo systemctl show --property=MainPID --value "$unit")" = 0
done
`;

export function windowsEnvironment(c: WindowsConfig): Environment {
  return { id:c.id, instanceName:vmIdentity(c.id).name, name:'Windows preview', description:'', kind:'vm', color:'blue',
    cpus:c.cpus,memoryGiB:c.memoryGiB,diskGiB:c.diskGiB,mounts:[],ports:[],browserUrl:'about:blank',
    identity:{timezone:c.timezone,locale:'en-US'},state:'running',lastError:null,browserRunning:false,createdAt:'',updatedAt:'',
    network:{mode:c.proxy.mode,host:'127.0.0.1',port:RELAY_PORT,username:c.proxy.username,password:c.proxy.password,
      strict:true,transparent:true,noProxy:'',egressLock:{expectedIp:c.expectedIp},...(c.dns?{dns:c.dns}:{}),
      ...(c.proxy.mode==='https'?{tls:{serverName:c.proxy.serverName!}}:{})} };
}

export function cloudInit(c: WindowsConfig, publicKey: string, hostPrivate: string, hostPublic: string) {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey.trim()) || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(hostPublic.trim())) throw Error('Invalid SSH key');
  const n=vmIdentity(c.id);
  const userData = '#cloud-config\n'+stringify({
    hostname:'mu-linux',manage_etc_hosts:true,timezone:c.timezone,ssh_pwauth:false,disable_root:true,
    ssh_deletekeys:true,ssh_keys:{ed25519_private:hostPrivate.replaceAll('\r\n','\n'),ed25519_public:hostPublic.trim()},
    users:[{name:'mu',uid:2000,lock_passwd:true,shell:'/bin/bash',sudo:'ALL=(ALL) NOPASSWD:ALL',ssh_authorized_keys:[publicKey.trim()]},
      {name:'dev',uid:2001,lock_passwd:true,shell:'/bin/bash',sudo:null},
      {name:'mu-net',uid:NET_UID,system:true,no_create_home:true,shell:'/usr/sbin/nologin'},
      {name:'mu-probe',uid:PROBE_UID,system:true,no_create_home:true,shell:'/usr/sbin/nologin'}],
    write_files:[
      {path:'/etc/ssh/sshd_config.d/90-mucodesandbox.conf',owner:'root:root',permissions:'0600',content:'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers mu\nAllowAgentForwarding no\nX11Forwarding no\nGatewayPorts no\n'},
      {path:'/etc/sysctl.d/90-mucodesandbox.conf',owner:'root:root',permissions:'0644',content:'net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\nnet.ipv4.ip_forward=0\n'},
      {path:'/usr/local/libexec/mu-hv-ssh',owner:'root:root',permissions:'0700',content:GUEST_CHANNEL},
      {path:'/etc/systemd/system/mu-hv-ssh.service',owner:'root:root',permissions:'0644',content:GUEST_CHANNEL_UNIT},
    ],
    // No package downloads on boot. Hyper-V ACLs already restrict the NIC to
    // management SSH before the first instruction executes in this VM.
    runcmd:[WINDOWS_LOCAL_GUEST_SERVICES,['chmod','0700','/home/mu','/home/dev'],['sysctl','--system'],['systemctl','daemon-reload'],['systemctl','enable','--now','mu-hv-ssh.service']],
  });
  return {'user-data':userData,'meta-data':stringify({'instance-id':c.id,'local-hostname':'mu-linux','dsmode':'local'}),
    'network-config':stringify({version:2,ethernets:{management:{match:{macaddress:n.mac.match(/../g)!.join(':').toLowerCase()},'set-name':'eth0',dhcp4:false,dhcp6:false,'accept-ra':false,addresses:[`${n.guest}/30`],optional:true}}})};
}

// Package installation uses only the explicitly configured SSH-forwarded
// upstream. There is no guest default route or host NAT as a fallback.
export const BOOTSTRAP_IP_STACK=`# glibc AI_ADDRCONFIG excludes loopback when the isolated NIC has no address.
# A host-scoped dummy address enables IPv4 resolution for the loopback-only
# package proxy. It has no peer/default route and is removed before export.
sudo ip link add mu-bootstrap type dummy
trap 'sudo ip link del mu-bootstrap >/dev/null 2>&1 || true' EXIT
sudo ip addr add 169.254.254.254/32 dev mu-bootstrap scope host noprefixroute
sudo ip link set mu-bootstrap up
`;
export function bootstrapScript(c: WindowsConfig) {
  const url = new URL(`${c.proxy.mode==='socks5'?'socks5h':c.proxy.mode}://127.0.0.1:${RELAY_PORT}`);
  url.username=c.proxy.username;url.password=c.proxy.password;
  return `set -euo pipefail
if ! sudo cloud-init status --wait >/dev/null; then
  printf '%s\n' 'Guest initialization failed; business permission remains closed.' >&2
  sudo cloud-init status --long >&2 || true
  exit 1
fi
printf 'datasource_list: [NoCloud]\\n' | sudo tee /etc/cloud/cloud.cfg.d/99-mucodesandbox-datasource.cfg >/dev/null
${WINDOWS_LOCAL_GUEST_SERVICES}
${BOOTSTRAP_IP_STACK}
sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::ForceIPv4=true -o APT::Update::Error-Mode=any -o Acquire::http::Proxy=${shellQuote(url.href)} -o Acquire::https::Proxy=${shellQuote(url.href)} -o Acquire::Retries=0 update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Proxy=${shellQuote(url.href)} -o Acquire::https::Proxy=${shellQuote(url.href)} -o Acquire::Retries=0 install -y --no-install-recommends nftables curl ca-certificates python3 iproute2 locales
${CONFIGURE_NETWORKD_SCRIPT}
${INSTALL_GUARD_SCRIPT}
sudo install -d -m 0700 /etc/mucodesandbox
sudo install -d -o dev -g dev -m 0700 /workspace
sudo usermod -G '' dev
sudo rm -f /etc/sudoers.d/90-cloud-init-users-dev
! sudo -l -U dev 2>/dev/null | grep -q NOPASSWD
`;
}

export function installAmd64TunnelScript(archive: string) {
  return `set -euo pipefail
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -xzf ${shellQuote(archive)} -C "$stage"
sudo install -m 0755 "$stage/sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box" /usr/local/bin/mu-sing-box
sudo tee /etc/systemd/system/mucodesandbox-tunnel.service >/dev/null <<'MU_UNIT'
[Unit]
Description=MuCodeSandbox Windows preview guest tunnel
Requires=mucodesandbox-egress.service
After=mucodesandbox-egress.service systemd-resolved.service
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
`;
}

export function configureWindowsGuard(c: WindowsConfig, session = randomUUID()) {
  const n=vmIdentity(c.id),e=windowsEnvironment(c);
  const rules=firewallRules(['127.0.0.1'],RELAY_PORT,[],n.host,NET_UID,0,undefined,RELAY_PORT,{port:PROBE_PORT,uid:PROBE_UID});
  const lease=leaseFiles(leaseRules(n.host,NET_UID,PROBE_UID,NET_UID));
  const tunnel=transparentConfig(e,'127.0.0.1',NET_UID,[n.subnet],PROBE_PORT);
  const script=`set -euo pipefail
${WINDOWS_LOCAL_GUEST_SERVICES}
# Management and approved forwarding use Hyper-V sockets. Waiting for an
# ordinary IP network is unnecessary on this intentionally isolated VM.
sudo systemctl mask --now systemd-networkd-wait-online.service >/dev/null
# First SSH readiness can precede cloud-init's final writes. A resource or
# network fence may force power-off immediately after admission, so finish
# initialization and persist its management identity before opening business.
sudo cloud-init status --wait >/dev/null
test "$(id -u mu-net)" = '${NET_UID}'
test "$(id -u mu-probe)" = '${PROBE_UID}'
test "$(id -u dev)" = '2001'
${applyGuardScript(rules,['127.0.0.1:'+RELAY_PORT],guestEnvironment(e),true)}
sudo install -d -m 0700 /run/mucodesandbox-lease
sudo install -d -m 0755 /etc/systemd/system/mucodesandbox-egress.service.d
${Object.entries(lease).map(([file,content])=>`printf '%s' ${shellQuote(content)} | sudo tee ${file} >/dev/null\nsudo chown root:root ${file}\nsudo chmod ${file===LEASE_HELPER_PATH?'0700':'0600'} ${file}`).join('\n')}
sudo nft --check -f /etc/mucodesandbox/lease.nft
sudo systemctl daemon-reload
sudo systemctl enable mucodesandbox-lease.service >/dev/null
sudo systemctl restart mucodesandbox-lease.service
sudo /usr/bin/python3 -I -c ${shellQuote(`import json,os\nwith open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()\nwith open('/run/mucodesandbox-lease/state','w') as f: json.dump({'session':'${session}','boot':boot,'state':'pending','deadline':0},f)\nos.chmod('/run/mucodesandbox-lease/state',0o600)`)}
${startTransparentScript(tunnel)}
# Includes cloud-init host keys/cache and the persistent closed boot rules.
# This must finish successfully before configure returns an activation token.
sudo sync
`;
  return {session,script};
}

// nftables' expiring element is intentionally removed from the integrity
// digest. Chain/rule changes and all other tables remain part of the digest.
export const INSPECT_WINDOWS_GUARD = `sudo /usr/bin/python3 -I - <<'MU_INSPECT'
import hashlib,json,subprocess,os,stat
def cmd(*a): return subprocess.run(a,check=True,capture_output=True,text=True).stdout
tables=[]
for name in ['mu_egress','mu_lease']:
 data=json.loads(cmd('nft','-j','list','table','inet',name))
 for item in data['nftables']:
  if 'metainfo' in item: continue
  if name=='mu_lease' and 'set' in item and item['set'].get('family')=='inet' and item['set'].get('table')=='mu_lease' and item['set'].get('name')=='permit': item['set'].pop('elem',None)
  def clean(v):
   if isinstance(v,dict):
    return {k:clean(x) for k,x in v.items() if k not in ['handle','packets','bytes','expires']}
   if isinstance(v,list): return [clean(x) for x in v]
   return v
  tables.append(clean(item))
files={}
for f in ['/etc/mucodesandbox/network.nft','/etc/mucodesandbox/lease.nft','/etc/mucodesandbox/tunnel.json','/usr/local/libexec/mu-network-lease','/etc/systemd/system/mucodesandbox-egress.service','/etc/systemd/system/mucodesandbox-egress.service.d/lease.conf','/etc/systemd/system/mucodesandbox-lease.service','/etc/systemd/system/mucodesandbox-tunnel.service','/etc/systemd/resolved.conf.d/mucodesandbox.conf','/etc/systemd/networkd.conf.d/99-mucodesandbox.conf']:
 s=os.lstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode & 0o022: raise RuntimeError('Unsafe guard file ownership')
 with open(f,'rb') as h: files[f]=hashlib.sha256(h.read()).hexdigest()
def check_masked_services(units):
 output=cmd('systemctl','show','--property=Id','--property=UnitFileState','--property=ActiveState','--property=MainPID',*units)
 seen=set()
 for block in output.strip().split('\\n\\n'):
  properties={}
  for line in block.splitlines():
   key,sep,value=line.partition('=')
   if not sep or key not in ['Id','UnitFileState','ActiveState','MainPID'] or key in properties: raise RuntimeError('Invalid cloud agent status')
   properties[key]=value
  if set(properties)!=set(['Id','UnitFileState','ActiveState','MainPID']): raise RuntimeError('Incomplete cloud agent status')
  if properties['Id'] not in units or properties['Id'] in seen: raise RuntimeError('Unexpected cloud agent identity')
  seen.add(properties['Id'])
  if properties['UnitFileState']!='masked': raise RuntimeError('Cloud agent is not masked')
  if properties['ActiveState'] not in ['inactive','failed'] or properties['MainPID']!='0': raise RuntimeError('Cloud agent remains active')
 if seen!=set(units): raise RuntimeError('Incomplete cloud agent status')
cloud_agents=${JSON.stringify(WINDOWS_CLOUD_AGENT_UNITS)}
for unit in cloud_agents:
 f='/etc/systemd/system/'+unit
 s=os.lstat(f)
 if not stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or os.readlink(f)!='/dev/null': raise RuntimeError('Cloud agent mask changed')
 files[f]=hashlib.sha256(os.readlink(f).encode()).hexdigest()
check_masked_services(cloud_agents)
def check_network_services(services):
 active=cmd('systemctl','is-active',*services).splitlines()
 enabled=cmd('systemctl','is-enabled',*services).splitlines()
 if len(active)!=len(services) or any(value!='active' for value in active): raise RuntimeError('Network service is not active')
 if len(enabled)!=len(services) or any(value not in ['enabled','enabled-runtime'] for value in enabled): raise RuntimeError('Network service is not enabled')
check_network_services(['mucodesandbox-egress','mucodesandbox-lease','mucodesandbox-tunnel'])
cmd('ip','link','show','mu_tun')
cmd('systemctl','is-active','systemd-resolved')
dns=cmd('resolvectl','dns');domains=cmd('resolvectl','domain')
def check_controlled_dns(dns,domains):
 def global_values(output):
  rows=[line.partition(':')[2].split() for line in output.splitlines() if line.partition(':')[0].strip()=='Global']
  if len(rows)!=1: raise RuntimeError('Controlled DNS global status missing or duplicated')
  return rows[0]
 if global_values(dns)!=['172.19.0.2'] or global_values(domains)!=['~.']: raise RuntimeError('Controlled DNS configuration changed')
check_controlled_dns(dns,domains)
if os.path.realpath('/etc/resolv.conf')!='/run/systemd/resolve/stub-resolv.conf': raise RuntimeError('Controlled DNS configuration changed')
def ordered(value): return sorted(value,key=lambda x:json.dumps(x,sort_keys=True))
network={'rules':ordered(json.loads(cmd('ip','-j','rule','show'))),'routes':ordered(json.loads(cmd('ip','-j','route','show','table','all'))),'dns':dns,'domains':domains}
lease=json.loads(cmd('/usr/local/libexec/mu-network-lease','status'))
digest=hashlib.sha256(json.dumps([tables,files,network],sort_keys=True,separators=(',',':')).encode()).hexdigest()
def component(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
components={'tables':component(tables),'files':component(files),'networkRules':component(network['rules']),'networkRoutes':component(network['routes']),'networkDns':component(network['dns']),'networkDomains':component(network['domains'])}
print(json.dumps({'digest':digest,'leaseActive':lease['active'],'remainingMs':lease['remainingMs'],'components':components}))
MU_INSPECT`;
