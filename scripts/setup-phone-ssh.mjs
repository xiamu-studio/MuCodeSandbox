import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const relayDir = '/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199';
const privateDir = path.join(relayDir, 'mobile-shadowrocket');
const credentialsPath = path.join(privateDir, 'credentials.json');
const host = '166.88.36.199';
const username = 'mu-phone';
const scriptPath = fileURLToPath(import.meta.url);
const sshOptions = ['-F', 'none', '-4', '-o', `UserKnownHostsFile=${relayDir}/known_hosts`,
  '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10'];

if (process.argv[2] === '--askpass') {
  if (!process.argv[3]?.includes(`${username}@${host}`) || !process.argv[3]?.includes('password')) process.exit(1);
  process.stdout.write(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).password);
  process.exit(0);
}

fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(privateDir, 0o700);
let credentials;
if (fs.existsSync(credentialsPath)) {
  credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (credentials.username !== username || credentials.host !== host ||
      !/^[A-Za-z0-9_-]{43}$/.test(credentials.password)) throw new Error('Unexpected saved phone credentials.');
} else {
  credentials = { host, port: 22, username, password: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() };
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
fs.chmodSync(credentialsPath, 0o600);

const keyPath = path.join(privateDir, 'phone_ed25519');
if (!fs.existsSync(keyPath)) {
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'MuCodeSandbox-phone-only', '-f', keyPath], { stdio: 'pipe' });
}
fs.chmodSync(keyPath, 0o600);
const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ MuCodeSandbox-phone-only$/.test(publicKey)) throw new Error('Unexpected phone public key.');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

try {
  execFileSync('/usr/bin/ssh', ['-F', 'none', '-S', `${relayDir}/admin.sock`, '-O', 'check', `root@${host}`], { stdio: 'pipe' });
} catch {
  console.error('The VPS administrator connection has expired. Run connect-admin.command again first.');
  process.exit(2);
}

// Only this account's SSH policy and IPv6 rule are installed; the Mac relay remains separate.
const deploy = `set -euo pipefail
umask 077
test "$(id -u)" = 0
marker=/etc/mucodesandbox/phone-ssh-managed
created=0
committed=0
backup=$(mktemp -d /root/mu-phone-setup.XXXXXX)
cp -a /etc/ssh/sshd_config "$backup/sshd_config"
rollback() {
  if [ "$committed" = 0 ]; then
    cp -a "$backup/sshd_config" /etc/ssh/sshd_config
    /usr/sbin/sshd -t && systemctl reload sshd || true
    if [ "$created" = 1 ]; then
      systemctl disable --now mucodesandbox-phone-network.service >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/mucodesandbox-phone-network.service /usr/local/libexec/mucodesandbox-phone-network "$marker"
      userdel --remove mu-phone >/dev/null 2>&1 || true
      systemctl daemon-reload
    fi
  fi
}
trap rollback EXIT
if id mu-phone >/dev/null 2>&1; then
  test -f "$marker" || { echo 'Existing unmanaged phone account; refusing.' >&2; exit 1; }
else
  test ! -e /home/mu-phone || { echo 'Existing phone home; refusing.' >&2; exit 1; }
  useradd --create-home --shell /usr/sbin/nologin mu-phone
  created=1
fi
test "$(getent passwd mu-phone | cut -d: -f6)" = /home/mu-phone
test "$(getent passwd mu-phone | cut -d: -f7)" = /usr/sbin/nologin
test "$(id -G mu-phone | wc -w)" = 1
printf '%s\\n' ${quote(`${username}:${credentials.password}`)} | chpasswd
install -d -m 700 -o mu-phone -g mu-phone /home/mu-phone/.ssh
printf '%s\\n' ${quote(`restrict,port-forwarding ${publicKey}`)} > /home/mu-phone/.ssh/authorized_keys
chown mu-phone:mu-phone /home/mu-phone/.ssh/authorized_keys
chmod 600 /home/mu-phone/.ssh/authorized_keys
if ! grep -q '^# BEGIN MUCODESANDBOX PHONE$' /etc/ssh/sshd_config; then
  cat >> /etc/ssh/sshd_config <<'CONF'

# BEGIN MUCODESANDBOX PHONE
Match User mu-phone
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    MaxSessions 0
    PasswordAuthentication yes
    PubkeyAuthentication yes
    AuthenticationMethods any
    ForceCommand /usr/sbin/nologin
Match all
# END MUCODESANDBOX PHONE
CONF
fi
/usr/sbin/sshd -t
install -d -m 755 /usr/local/libexec
cat > /usr/local/libexec/mucodesandbox-phone-network <<'GUARD'
#!/bin/bash
set -euo pipefail
phone_uid="$(id -u mu-phone)"
case "$1" in
start|stop)
  while /usr/sbin/ip6tables -C OUTPUT -m owner --uid-owner "$phone_uid" -m comment --comment mu-phone-ipv4-only -j REJECT 2>/dev/null; do
    /usr/sbin/ip6tables -D OUTPUT -m owner --uid-owner "$phone_uid" -m comment --comment mu-phone-ipv4-only -j REJECT
  done
  if [ "$1" = start ]; then
    /usr/sbin/ip6tables -I OUTPUT 1 -m owner --uid-owner "$phone_uid" -m comment --comment mu-phone-ipv4-only -j REJECT
  fi
  ;;
*) exit 2 ;;
esac
GUARD
chmod 755 /usr/local/libexec/mucodesandbox-phone-network
cat > /etc/systemd/system/mucodesandbox-phone-network.service <<'UNIT'
[Unit]
Description=Phone SSH relay IPv4 egress only
After=network-pre.target
Before=sshd.service
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/mucodesandbox-phone-network start
ExecStop=/usr/local/libexec/mucodesandbox-phone-network stop
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable mucodesandbox-phone-network.service >/dev/null
systemctl restart mucodesandbox-phone-network.service
systemctl reload sshd
install -d -m 700 /etc/mucodesandbox
printf '%s\\n' 'Managed phone-only SSH forwarding account' > "$marker"
committed=1
/usr/sbin/sshd -T -C user=mu-phone,host=localhost,addr=127.0.0.1 | grep -E '^(allowtcpforwarding|passwordauthentication|pubkeyauthentication|authenticationmethods|forcecommand|maxsessions|permittty|allowagentforwarding|x11forwarding|gatewayports) '
/usr/sbin/ip6tables -C OUTPUT -m owner --uid-owner "$(id -u mu-phone)" -m comment --comment mu-phone-ipv4-only -j REJECT
echo MU_PHONE_ACCOUNT_READY
`;

const deployment = execFileSync('/usr/bin/ssh', [...sshOptions, '-S', `${relayDir}/admin.sock`, '-o', 'ControlMaster=no',
  '-o', 'BatchMode=yes', '-T', `root@${host}`, 'bash -s'], { input: deploy, encoding: 'utf8', timeout: 45000 });
console.log(deployment.trim());
if (!deployment.includes('MU_PHONE_ACCOUNT_READY')) throw new Error('The server did not confirm phone account setup.');

const askpassPath = path.join(privateDir, 'phone-password-askpass.command');
fs.writeFileSync(askpassPath, `#!/bin/zsh\nexec ${quote(process.execPath)} ${quote(scriptPath)} --askpass "$@"\n`, { mode: 0o700 });
fs.chmodSync(askpassPath, 0o700);
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const tunnel = spawn('/usr/bin/ssh', [...sshOptions, '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
  '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password', '-o', 'NumberOfPasswordPrompts=1',
  '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
  '-N', '-D', `127.0.0.1:${port}`, `${username}@${host}`], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, SSH_ASKPASS: askpassPath, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':99' },
});
let tunnelError = '';
tunnel.stderr.on('data', data => { tunnelError += data.toString(); });
const receipts = [];
try {
  let connected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (tunnel.exitCode !== null) throw new Error(`Phone authentication failed: ${tunnelError}`);
    connected = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!connected) throw new Error('Phone SSH tunnel did not become ready.');
  for (const url of ['https://api.ipify.org', 'https://icanhazip.com']) {
    const result = execFileSync('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--proxy', `socks5h://127.0.0.1:${port}`,
      '--connect-timeout', '5', '--max-time', '15', url], { encoding: 'utf8', timeout: 16000 }).trim();
    receipts.push({ url, ip: result, at: new Date().toISOString() });
    if (result !== host) throw new Error('Phone test returned an unexpected public IP.');
  }
} finally {
  tunnel.kill('SIGTERM');
  await new Promise(resolve => { if (tunnel.exitCode !== null) resolve(); else tunnel.once('exit', resolve); });
}

const uri = new URL(`ssh://${host}:22`);
uri.username = username;
uri.password = credentials.password;
fs.writeFileSync(path.join(privateDir, 'ssh-link.txt'), uri.href + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(privateDir, 'clash-ssh.json'), JSON.stringify({ proxies: [{ name: 'US-VPS-Phone', type: 'ssh',
  server: host, port: 22, username, password: credentials.password }] }, null, 2) + '\n', { mode: 0o600 });
const qrPath = path.join(privateDir, 'ssh-qr.png');
execFileSync('/usr/bin/swift', [path.join(path.dirname(scriptPath), 'make-private-qr.swift'),
  path.join(privateDir, 'ssh-link.txt'), qrPath], { encoding: 'utf8', timeout: 60000 });
const report = { createdAt: new Date().toISOString(), host, username, receipts, passwordAuthenticationVerified: true,
  qrContentVerified: true, phoneScannerImportVerified: false, qrPath, accountPolicy: deployment.trim(),
  uriFormatSource: 'User-provided test SSH export; credentials test/test at 127.0.0.1:22' };
fs.writeFileSync(path.join(privateDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log('Password authentication and two independent public IP receipts passed.');
console.log(`QR image: ${qrPath}`);
console.log('MU_PHONE_READY');
