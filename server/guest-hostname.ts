/** A Linux guest name, never the Mac name or a fabricated hardware identity. */
export function validateGuestHostname(value: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(value) || value.endsWith('-')
    || ['localhost', 'localhost6', 'ip6-localhost', 'ip6-loopback', 'localdomain'].includes(value)) {
    throw new Error('Guest hostname must be a lowercase DNS label of 1–63 characters, starting with a letter');
  }
  return value;
}

// The same helper is exercised against temporary directories in unit tests.
// Its installed entry point has no alternate-root or ownership-bypass flags.
export const GUEST_HOSTNAME_HELPER_SOURCE = String.raw`#!/usr/bin/python3
import hashlib, json, os, re, secrets, stat, subprocess, sys, tempfile
from pathlib import Path

POLICY = 'preserve_hostname: true\nmanage_etc_hosts: false\n'
UNIT = '''[Unit]
Description=Restore the saved MuCodeSandbox guest hostname
After=local-fs.target cloud-init.service
Before=cloud-config.service cloud-final.service

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/mu-guest-hostname apply
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
'''
RESERVED = {'localhost', 'localhost6', 'ip6-localhost', 'ip6-loopback', 'localdomain'}

def valid_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', value) or value.endswith('-') or value in RESERVED:
        raise ValueError('Invalid guest hostname')
    return value

class Paths:
    def __init__(self, root=Path('/'), uid=0, gid=0):
        self.root, self.uid, self.gid = Path(root), uid, gid
        self.state = self.root / 'etc/mucodesandbox/guest-hostname.json'
        self.identity = self.root / 'var/lib/cloud/data/instance-id'
        self.machine_id = self.root / 'etc/machine-id'
        self.hostname = self.root / 'etc/hostname'
        self.hosts = self.root / 'etc/hosts'
        self.policy = self.root / 'etc/cloud/cloud.cfg.d/99-mucodesandbox-hosts.cfg'
        self.helper = self.root / 'usr/local/libexec/mu-guest-hostname'
        self.unit = self.root / 'etc/systemd/system/mucodesandbox-hostname.service'

    def check(self, target, directory=False, missing=False):
        target = Path(target)
        if not target.is_absolute() or not target.is_relative_to(self.root):
            raise ValueError('Guest hostname path is outside its root')
        components = [self.root]
        for part in target.relative_to(self.root).parts:
            components.append(components[-1] / part)
        for index, item in enumerate(components):
            try:
                info = item.lstat()
            except FileNotFoundError:
                if missing and index == len(components) - 1:
                    return None
                raise
            want_directory = index < len(components) - 1 or directory
            if (stat.S_ISDIR(info.st_mode) if want_directory else stat.S_ISREG(info.st_mode)) is False:
                raise ValueError('Guest hostname path must not be a symlink or special file: ' + str(item))
            if info.st_uid != self.uid or info.st_gid != self.gid or info.st_mode & 0o022:
                raise ValueError('Guest hostname path has unsafe ownership or permissions: ' + str(item))
            if not want_directory and (info.st_nlink != 1 or info.st_size > 1048576):
                raise ValueError('Guest hostname file has unsafe links or size: ' + str(item))
        return info

    def directory(self, target):
        if target == self.root:
            self.check(target, directory=True)
            return
        self.directory(target.parent)
        if self.check(target, directory=True, missing=True) is None:
            target.mkdir(mode=0o755)
        self.check(target, directory=True)

    def read(self, target, missing=False):
        if self.check(target, missing=missing) is None:
            return None
        with open(target, 'r', encoding='utf-8') as handle:
            return handle.read()

    def write(self, target, value, mode):
        self.check(target, missing=True)
        self.check(target.parent, directory=True)
        if target.exists() and self.read(target) == value and stat.S_IMODE(target.lstat().st_mode) == mode:
            return
        descriptor, temporary = tempfile.mkstemp(prefix='.' + target.name + '.', dir=target.parent)
        try:
            os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
            self.check(target, missing=True)
            os.replace(temporary, target)
            directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)

def instance_digest(paths):
    value = paths.read(paths.identity).strip()
    if not value or len(value) > 512 or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise ValueError('Cloud-init instance identity is invalid; the saved hostname will not be replaced')
    # Reject generic datasource fallbacks that cannot distinguish cloned VMs.
    if value in {'iid-datasource-none', 'iid-local01', 'iid-None', 'None'}:
        raise ValueError('Cloud-init instance identity is not unique')
    return hashlib.sha256(value.encode('ascii')).hexdigest()

def machine_digest(paths):
    value = paths.read(paths.machine_id).strip()
    if not re.fullmatch('[0-9a-f]{32}', value) or value == '0' * 32:
        raise ValueError('Guest machine identity is invalid; the saved hostname will not be replaced')
    return hashlib.sha256(value.encode('ascii')).hexdigest()

def load_state(paths):
    raw = paths.read(paths.state, missing=True)
    if raw is None:
        return None
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'version', 'instanceIdSha256', 'machineIdSha256', 'hostname', 'source'}
        or type(value['version']) is not int or value['version'] != 1
        or not isinstance(value['instanceIdSha256'], str) or not re.fullmatch('[0-9a-f]{64}', value['instanceIdSha256'])
        or not isinstance(value['machineIdSha256'], str) or not re.fullmatch('[0-9a-f]{64}', value['machineIdSha256'])
        or not isinstance(value['source'], str) or value['source'] not in {'generated', 'selected', 'adopted'}):
        raise ValueError('Invalid saved guest hostname state; refusing to regenerate it')
    valid_name(value['hostname'])
    return value

def hosts_content(content, name, previous_names):
    names = set(previous_names) | {name}
    lines = []
    for line in content.splitlines():
        record, separator, comment = line.partition('#')
        fields = record.split()
        if len(fields) > 1 and name in fields[1:] and fields[0] not in {'127.0.0.1', '127.0.1.1', '::1'}:
            raise ValueError('Selected hostname already has a non-loopback hosts mapping')
        if len(fields) > 1 and fields[0] in {'127.0.0.1', '127.0.1.1', '::1'} and names.intersection(fields[1:]):
            aliases = [alias for alias in fields[1:] if alias not in names]
            if aliases:
                lines.append(fields[0] + '\t' + ' '.join(aliases) + (' #' + comment if separator else ''))
            elif separator:
                lines.append('#' + comment)
        else:
            lines.append(line)
    lines.append('127.0.1.1\t' + name)
    return '\n'.join(lines) + '\n'

def prepare(paths, requested=None):
    if requested is not None:
        valid_name(requested)
    # Validate every existing input before selecting or replacing any state.
    digest = instance_digest(paths)
    machine = machine_digest(paths)
    for file in (paths.hostname, paths.hosts, paths.policy, paths.helper, paths.unit):
        paths.check(file, missing=True)
    for directory in (paths.state.parent,):
        paths.directory(directory)
    saved = load_state(paths)
    old_name = (paths.read(paths.hostname, missing=True) or '').strip()
    content = paths.read(paths.hosts)
    if requested is not None:
        name, source = requested, 'selected'
    # Lima regenerates instance-id on start; it is audit metadata, not the
    # lifetime identity. The real machine-id stays stable across guest reboots
    # and is normally regenerated by the already-cleaned protected-base clone.
    elif saved and saved['machineIdSha256'] == machine:
        name, source = saved['hostname'], saved['source']
    else:
        # Preserve a pre-existing ordinary manual name only on first migration.
        try:
            ordinary_old = valid_name(old_name) if not old_name.startswith(('lima-', 'mu-')) else None
        except ValueError:
            ordinary_old = None
        name = ordinary_old if saved is None and ordinary_old else 'desktop-' + secrets.token_hex(4)
        source = 'adopted' if name == ordinary_old else 'generated'
    previous_names = {old_name}
    if saved:
        previous_names.add(saved['hostname'])
    next_hosts = hosts_content(content, name, previous_names - RESERVED)
    state = {'version': 1, 'instanceIdSha256': digest, 'machineIdSha256': machine, 'hostname': name, 'source': source}
    return state, next_hosts

def apply_prepared(paths, prepared, set_kernel=None):
    state, next_hosts = prepared
    name = state['hostname']
    # Save first: interruption after this point retries with the same name.
    paths.write(paths.state, json.dumps(state, sort_keys=True) + '\n', 0o600)
    paths.write(paths.hostname, name + '\n', 0o644)
    paths.write(paths.hosts, next_hosts, 0o644)
    if set_kernel is None:
        set_kernel = lambda value: subprocess.run(['/bin/hostname', value], check=True)
    set_kernel(name)
    return state

def configure(paths, requested=None, set_kernel=None):
    return apply_prepared(paths, prepare(paths, requested), set_kernel)

def install(source, requested=None, paths=None, set_kernel=None):
    paths = paths or Paths()
    if requested is not None:
        valid_name(requested)
    instance_digest(paths)
    machine_digest(paths)
    # Refuse unsafe pre-existing paths before installing root-executed content.
    for target in (paths.state, paths.hostname, paths.hosts, paths.policy, paths.helper, paths.unit):
        paths.directory(target.parent)
        paths.check(target, missing=True)
    prepared = prepare(paths, requested)
    paths.write(paths.helper, source, 0o755)
    paths.write(paths.policy, POLICY, 0o644)
    paths.write(paths.unit, UNIT, 0o644)
    return apply_prepared(paths, prepared, set_kernel)

if __name__ == '__main__':
    if os.geteuid() != 0 or sys.argv[1:] != ['apply']:
        raise SystemExit('Guest hostname helper requires root and the apply command')
    print(json.dumps(configure(Paths())))
`;

/** Optional names use the same strict validation in TypeScript and the guest. */
export function configureGuestHostnameScript(name?: string): string {
  if (name !== undefined) validateGuestHostname(name);
  return `set -eu
sudo /usr/bin/python3 - <<'MU_GUEST_HOSTNAME'
source = ${JSON.stringify(GUEST_HOSTNAME_HELPER_SOURCE)}
scope = {'__name__': 'mu_guest_hostname'}
exec(source, scope)
print(scope['json'].dumps(scope['install'](source, ${name === undefined ? 'None' : JSON.stringify(name)})))
MU_GUEST_HOSTNAME
sudo systemctl daemon-reload
sudo systemctl enable mucodesandbox-hostname.service >/dev/null
`;
}

export const CONFIGURE_GUEST_HOSTNAME_SCRIPT = configureGuestHostnameScript();
