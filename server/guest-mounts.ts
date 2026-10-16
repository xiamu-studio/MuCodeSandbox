import { createHash } from 'node:crypto';
import type { Environment } from '../shared/types.ts';
import { z } from 'zod';

export function parseSharedMountInspection(output: string) {
  const rows = output.split('\n').filter(line => line.startsWith('{'));
  if (rows.length !== 1) throw new Error('Shared mount inspection did not return one result');
  return z.object({ issues: z.array(z.string()) }).strict().parse(JSON.parse(rows[0]));
}

export function sharedMounts(e: Pick<Environment, 'mounts'>) {
  return e.mounts.map(m => ({ target: m.guestPath, writable: m.writable,
    // Lima 2.2.0 hashes both paths, including repeated host locations.
    tag: `lima-${createHash('sha256').update(`${m.hostPath}:${m.guestPath}`).digest('hex').slice(0, 16)}` }));
}

export function inspectSharedMountsScript(e: Pick<Environment, 'mounts'>, requireMounts = true) {
  return `python3 - <<'MU_SHARED_INSPECT'
import json, os, stat, subprocess
expected = json.loads(${JSON.stringify(JSON.stringify(sharedMounts(e)))})
require_mounts = ${requireMounts ? 'True' : 'False'}
def decode(s):
    for old, new in [('\\\\040',' '), ('\\\\011','\\t'), ('\\\\012','\\n'), ('\\\\134','\\\\')]: s = s.replace(old,new)
    return s
with open('/proc/self/mountinfo') as f: lines = [line.split() for line in f]
issues = []
for m in expected:
    rows = [r for r in lines if decode(r[4]) == m['target']]
    if require_mounts and len(rows) != 1:
        issues.append(m['target'] + ': missing or stacked mount'); continue
    if require_mounts:
        r = rows[0]; sep = r.index('-'); options = set(r[5].split(','))
        if r[sep+1] != 'virtiofs' or r[sep+2] != m['tag'] or not {'nosuid','nodev'}.issubset(options) or ('rw' if m['writable'] else 'ro') not in options:
            issues.append(m['target'] + ': unexpected source or unsafe options')
    unit = subprocess.check_output(['systemd-escape','--path','--suffix=mount',m['target']],text=True).strip()
    policy = '/etc/systemd/system/' + unit + '.d/mucodesandbox.conf'
    try:
        info = os.lstat(policy)
        with open(policy) as f: content = f.read()
        expected_policy = '[Mount]\\nOptions=' + ('rw' if m['writable'] else 'ro') + ',nosuid,nodev\\n'
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or content != expected_policy:
            issues.append(m['target'] + ': unsafe persistent mount policy')
    except OSError: issues.append(m['target'] + ': missing persistent mount policy')
print(json.dumps({'issues':issues}))
MU_SHARED_INSPECT
`;
}

export function installSharedMountPoliciesScript(e: Pick<Environment, 'mounts'>) {
  return `set -eu
sudo python3 - <<'MU_SHARED_MIGRATION'
import json, os, stat, subprocess, tempfile
expected = json.loads(${JSON.stringify(JSON.stringify(sharedMounts(e)))})
with open('/proc/self/mountinfo') as f: rows = [line.split() for line in f]
sources = [r[r.index('-')+2] for r in rows if r[r.index('-')+1] == 'virtiofs']
assert all(source == 'vz-rosetta' for source in sources), 'Maintenance must have no host project mounts'
for m in expected:
    unit = subprocess.check_output(['systemd-escape','--path','--suffix=mount',m['target']],text=True).strip()
    directory = '/etc/systemd/system/' + unit + '.d'
    os.makedirs(directory, mode=0o755, exist_ok=True)
    info = os.lstat(directory)
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
    content = '[Mount]\\nOptions=' + ('rw' if m['writable'] else 'ro') + ',nosuid,nodev\\n'
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as f:
            name = f.name; f.write(content); f.flush(); os.fchmod(f.fileno(),0o644); os.fsync(f.fileno())
        os.replace(name,directory + '/mucodesandbox.conf'); name = None
        fd = os.open(directory,os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if name is not None: os.unlink(name)
subprocess.run(['systemctl','daemon-reload'],check=True)
print(json.dumps({'maintenanceSources':sources,'policiesInstalled':len(expected)}))
MU_SHARED_MIGRATION
`;
}

export function sharedMountBootScript(e: Pick<Environment, 'mounts'>) {
  return `set -eu
python3 - <<'MU_SHARED_BOOT'
import json, os, subprocess
expected = json.loads(${JSON.stringify(JSON.stringify(sharedMounts(e)))})
observations = []
def decode(s):
    for old, new in [('\\\\040',' '), ('\\\\011','\\t'), ('\\\\012','\\n'), ('\\\\134','\\\\')]: s = s.replace(old,new)
    return s
subprocess.run(['modprobe', 'virtiofs'], check=True)
for m in expected:
    target = m['target']
    assert (target == '/workspace' or target.startswith('/workspace/')) and all(p not in ('', '.', '..') for p in target.split('/')[1:])
    # Hold each directory open without following guest-controlled symlinks.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in target.split('/')[1:]:
            try: os.mkdir(part, 0o755, dir_fd=fd)
            except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        unit = subprocess.check_output(['systemd-escape', '--path', '--suffix=mount', target], text=True).strip()
        directory = '/etc/systemd/system/' + unit + '.d'
        os.makedirs(directory, mode=0o755, exist_ok=True)
        options = ('rw' if m['writable'] else 'ro') + ',nosuid,nodev'
        # Override even a stale fstab on later boots, before cloud-init starts.
        with open(directory + '/mucodesandbox.conf', 'w') as f: f.write('[Mount]\\nOptions=' + options + '\\n')
        with open('/proc/self/mountinfo') as f: rows = [line.split() for line in f]
        matches = [r for r in rows if decode(r[4]) == target]
        assert len(matches) <= 1, 'Stacked mount rejected'
        observations.append({'target':target,'alreadyMounted':bool(matches),'previousOptions':matches[0][5] if matches else None})
        if matches:
            r = matches[0]; sep = r.index('-')
            assert r[sep+1] == 'virtiofs' and r[sep+2] == m['tag'], 'Unexpected existing mount source'
        subprocess.run(['mount','-t','virtiofs','-o',('remount,' if matches else '') + options,m['tag'],'/proc/self/fd/' + str(fd)], pass_fds=(fd,), check=True)
    finally: os.close(fd)
os.makedirs('/run/mucodesandbox-shares', mode=0o755, exist_ok=True)
with open('/run/mucodesandbox-shares/boot.json', 'w') as f: json.dump(observations,f)
subprocess.run(['systemctl','daemon-reload'], check=True)
MU_SHARED_BOOT
`;
}
