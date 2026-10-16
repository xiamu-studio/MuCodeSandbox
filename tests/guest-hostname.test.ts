import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CONFIGURE_GUEST_HOSTNAME_SCRIPT, GUEST_HOSTNAME_HELPER_SOURCE, configureGuestHostnameScript, validateGuestHostname } from '../server/guest-hostname.ts';

const fixtureSource = String.raw`
import os, pathlib, shutil, tempfile
namespace = {'__name__': 'mu_hostname_fixture'}
exec(source, namespace)
Paths, install, configure = [namespace[name] for name in ('Paths', 'install', 'configure')]
def rejects(callback, fragment):
    try:
        callback()
    except (ValueError, FileNotFoundError) as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError('Unsafe fixture was accepted: ' + fragment)
with tempfile.TemporaryDirectory(prefix='mu-hostname-unit-') as directory:
    root = pathlib.Path(directory)
    for folder in ['etc/mucodesandbox', 'etc/cloud/cloud.cfg.d', 'etc/systemd/system', 'usr/local/libexec', 'var/lib/cloud/data']:
        (root / folder).mkdir(parents=True, exist_ok=True, mode=0o755)
    paths = Paths(root, os.getuid(), os.getgid())
    paths.identity.write_text('iid-lima-fixture-a\n')
    paths.hostname.write_text('lima-mu-fixture\n')
    paths.machine_id.write_text('a' * 32 + '\n')
    original_hosts = '127.0.0.1 localhost\n127.0.1.1 lima-mu-fixture local-alias # local comment\n::1 localhost ip6-localhost ip6-loopback\n192.168.5.2 host.lima.internal host.lima.internal.test # gateway\n203.0.113.10 service.test\n'
    paths.hosts.write_text(original_hosts)
    names = []
    def apply(requested=None):
        return install(source, requested, paths, names.append)
`;
function pythonFixture(program: string) {
  const script = `import sys\nsource = sys.stdin.read()\n${fixtureSource}${program.split('\n').map(line => `    ${line}`).join('\n')}\n`;
  const result = spawnSync('/usr/bin/python3', ['-c', script], { input: GUEST_HOSTNAME_HELPER_SOURCE, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('ordinary selected names are strict DNS labels; unsafe or resolver-reserved values are rejected before generation', () => {
  for (const name of ['desktop-83ab91cd', 'workstation', 'a', `a${'b'.repeat(62)}`]) {
    assert.equal(validateGuestHostname(name), name);
    assert.ok(configureGuestHostnameScript(name).includes(JSON.stringify(name)));
  }
  for (const name of ['', 'localhost', 'ip6-localhost', 'localdomain', '-desktop', 'desktop-', 'Desktop', '1234', 'desktop.local', 'a b', 'x\nroot', 'x;touch /tmp/no', 'a'.repeat(64)]) {
    assert.throws(() => validateGuestHostname(name));
    assert.throws(() => configureGuestHostnameScript(name));
  }
  assert.equal(CONFIGURE_GUEST_HOSTNAME_SCRIPT, configureGuestHostnameScript());
});

test('first migration assigns a name once, repairs only local aliases and installs protected persistent files', () => pythonFixture(String.raw`
state = apply()
assert state['source'] == 'generated'
assert __import__('re').fullmatch(r'desktop-[0-9a-f]{8}', state['hostname'])
assert paths.hostname.read_text() == state['hostname'] + '\n'
assert names == [state['hostname']]
hosts = paths.hosts.read_text()
assert 'lima-mu-fixture' not in hosts and 'local-alias # local comment' in hosts
assert '192.168.5.2 host.lima.internal host.lima.internal.test # gateway\n' in hosts
assert '203.0.113.10 service.test\n' in hosts and '127.0.0.1 localhost\n' in hosts
assert '127.0.1.1\t' + state['hostname'] + '\n' in hosts
for file, mode in [(paths.state, 0o600), (paths.hostname, 0o644), (paths.hosts, 0o644), (paths.policy, 0o644), (paths.unit, 0o644), (paths.helper, 0o755)]:
    assert __import__('stat').S_IMODE(file.stat().st_mode) == mode
    assert file.stat().st_uid == os.getuid() and file.stat().st_gid == os.getgid()
assert paths.policy.read_text() == 'preserve_hostname: true\nmanage_etc_hosts: false\n'
assert 'After=local-fs.target cloud-init.service' in paths.unit.read_text()
assert 'Before=cloud-config.service cloud-final.service' in paths.unit.read_text()
`));

test('preparation and simulated reboot reuse the saved name without new randomization or file churn', () => pythonFixture(String.raw`
first = apply()
files = [paths.state, paths.hostname, paths.hosts, paths.policy, paths.unit, paths.helper]
before = [(file.read_bytes(), file.stat().st_mtime_ns) for file in files]
namespace['secrets'].token_hex = lambda count: (_ for _ in ()).throw(AssertionError('Unexpected hostname regeneration'))
assert apply() == first
assert configure(paths, set_kernel=names.append) == first
assert [(file.read_bytes(), file.stat().st_mtime_ns) for file in files] == before
assert names == [first['hostname']] * 3
`));

test('a clone with a new real machine identity receives a distinct saved name and then reuses it', () => pythonFixture(String.raw`
first = apply()
paths.identity.write_text('iid-lima-fixture-b\n')
paths.machine_id.write_text('b' * 32 + '\n')
namespace['secrets'].token_hex = lambda count: 'bead1234'
second = configure(paths, set_kernel=names.append)
assert second['hostname'] == 'desktop-bead1234' and second['hostname'] != first['hostname']
assert second['instanceIdSha256'] != first['instanceIdSha256']
assert first['hostname'] not in paths.hosts.read_text()
namespace['secrets'].token_hex = lambda count: (_ for _ in ()).throw(AssertionError('Unexpected hostname regeneration'))
assert configure(paths, set_kernel=names.append) == second
`));

test('a Lima start with a changed instance-id and unchanged real machine-id preserves name and source', () => pythonFixture(String.raw`
first = apply('studio-desktop')
before = [paths.hostname.read_bytes(), paths.hosts.read_bytes(), paths.machine_id.read_bytes()]
paths.identity.write_text('iid-lima-fixture-next-start\n')
namespace['secrets'].token_hex = lambda count: (_ for _ in ()).throw(AssertionError('Unexpected hostname regeneration'))
second = configure(paths, set_kernel=names.append)
assert second['hostname'] == first['hostname'] and second['source'] == first['source']
assert second['machineIdSha256'] == first['machineIdSha256']
assert second['instanceIdSha256'] != first['instanceIdSha256']
assert namespace['load_state'](paths) == second
assert [paths.hostname.read_bytes(), paths.hosts.read_bytes(), paths.machine_id.read_bytes()] == before
assert names == [first['hostname'], first['hostname']]
`));

test('same-second cloud-init identities still produce independent clone names when real machine-id changes', () => pythonFixture(String.raw`
first = apply()
paths.machine_id.write_text('b' * 32 + '\n')
namespace['secrets'].token_hex = lambda count: 'face1234'
second = configure(paths, set_kernel=names.append)
assert second['instanceIdSha256'] == first['instanceIdSha256']
assert second['machineIdSha256'] != first['machineIdSha256']
assert second['hostname'] == 'desktop-face1234' and second['hostname'] != first['hostname']
assert configure(paths, set_kernel=names.append) == second
`));

test('an existing ordinary manual name is adopted and explicit selection remains stable after boot', () => pythonFixture(String.raw`
paths.hostname.write_text('studio-desktop\n')
first = apply()
assert first['hostname'] == 'studio-desktop' and first['source'] == 'adopted'
second = apply('workstation')
assert second['hostname'] == 'workstation' and second['source'] == 'selected'
assert 'studio-desktop' not in paths.hosts.read_text()
assert configure(paths, set_kernel=names.append) == second
`));

test('post-cloud-init application repairs overwritten kernel/hostname/hosts from saved state', () => pythonFixture(String.raw`
first = apply()
paths.hostname.write_text('lima-mu-overwritten\n')
paths.hosts.write_text(original_hosts + '127.0.1.1 lima-mu-overwritten\n')
namespace['secrets'].token_hex = lambda count: (_ for _ in ()).throw(AssertionError('Unexpected hostname regeneration'))
assert configure(paths, set_kernel=names.append) == first
assert names[-1] == first['hostname'] and paths.hostname.read_text().strip() == first['hostname']
assert 'lima-mu-overwritten' not in paths.hosts.read_text()
assert '192.168.5.2 host.lima.internal host.lima.internal.test # gateway' in paths.hosts.read_text()
`));

test('interruption while applying a kernel name retains state and retries with exactly the same name', () => pythonFixture(String.raw`
def fail(name):
    raise RuntimeError('simulated interrupted kernel apply')
try:
    install(source, None, paths, fail)
except RuntimeError:
    pass
else:
    raise AssertionError('Interrupted application was accepted')
saved = namespace['load_state'](paths)
namespace['secrets'].token_hex = lambda count: (_ for _ in ()).throw(AssertionError('Unexpected hostname regeneration'))
assert configure(paths, set_kernel=names.append) == saved
assert names == [saved['hostname']]
`));

test('corrupt saved state is rejected rather than replaced or causing a new name', () => pythonFixture(String.raw`
apply()
paths.state.write_text('{"version":true,"hostname":"desktop-bad"}\n')
before = [(file, file.read_bytes()) for file in [paths.state, paths.hostname, paths.hosts, paths.policy, paths.helper, paths.unit]]
rejects(apply, 'Invalid saved guest hostname state')
assert all(file.read_bytes() == content for file, content in before)
`));

test('missing, generic or malformed cloud-init identity fails before overwriting a saved hostname', () => pythonFixture(String.raw`
apply()
before = paths.state.read_bytes()
for value in ['', 'iid-datasource-none', 'iid-local01', 'iid-None', 'None', 'iid-with\nnewline', 'x' * 513]:
    paths.identity.write_text(value)
    rejects(apply, 'Cloud-init instance identity')
    assert paths.state.read_bytes() == before
paths.identity.unlink()
rejects(apply, 'instance-id')
assert paths.state.read_bytes() == before
`));

test('missing or uninitialized machine identity cannot reset a saved name', () => pythonFixture(String.raw`
apply()
before = paths.state.read_bytes()
for value in ['', 'uninitialized', '0' * 32, 'G' * 32, 'a' * 31]:
    paths.machine_id.write_text(value)
    rejects(apply, 'Guest machine identity')
    assert paths.state.read_bytes() == before
paths.machine_id.unlink()
rejects(apply, 'machine-id')
assert paths.state.read_bytes() == before
`));

test('symlink and hardlink files never redirect privileged writes', () => pythonFixture(String.raw`
apply()
for target in [paths.state, paths.identity, paths.machine_id, paths.hostname, paths.hosts, paths.policy, paths.helper, paths.unit]:
    original = target.read_bytes()
    victim = root / ('victim-' + target.name)
    victim.write_bytes(original)
    target.unlink()
    target.symlink_to(victim)
    rejects(apply, 'symlink or special file')
    assert victim.read_bytes() == original
    target.unlink()
    target.write_bytes(original)
    os.link(target, victim.with_suffix('.hardlink'))
    rejects(apply, 'unsafe links or size')
    victim.with_suffix('.hardlink').unlink()
`));

test('symlinked parent directories are rejected even when their destination is owned safely', () => pythonFixture(String.raw`
apply()
original = paths.state.parent
moved = root / 'safe-looking-state'
original.rename(moved)
original.symlink_to(moved, target_is_directory=True)
rejects(apply, 'symlink or special file')
assert (moved / paths.state.name).exists()
`));

test('group/world-writable state, helpers, parent directories and wrong owners are rejected', () => pythonFixture(String.raw`
apply()
for target in [paths.state, paths.hostname, paths.hosts, paths.policy, paths.helper, paths.unit, paths.identity, paths.machine_id, paths.state.parent]:
    old_mode = __import__('stat').S_IMODE(target.stat().st_mode)
    for writable in [0o020, 0o002]:
        target.chmod(old_mode | writable)
        rejects(apply, 'unsafe ownership or permissions')
        target.chmod(old_mode)
wrong_owner = Paths(root, os.getuid() + 1, os.getgid())
rejects(lambda: configure(wrong_owner, set_kernel=names.append), 'unsafe ownership or permissions')
`));

test('non-loopback collision with a selected name is rejected before changing hostname state', () => pythonFixture(String.raw`
apply()
paths.hosts.write_text(paths.hosts.read_text() + '203.0.113.11 chosen-desktop peer-alias # preserve\n')
before = [file.read_bytes() for file in [paths.state, paths.hostname, paths.hosts]]
rejects(lambda: configure(paths, 'chosen-desktop', names.append), 'non-loopback hosts mapping')
assert [file.read_bytes() for file in [paths.state, paths.hostname, paths.hosts]] == before
`));

test('the root helper exposes no alternate-root or owner-bypass arguments and grants no development sudo access', () => {
  assert.ok(GUEST_HOSTNAME_HELPER_SOURCE.includes("sys.argv[1:] != ['apply']"));
  assert.ok(GUEST_HOSTNAME_HELPER_SOURCE.includes('os.geteuid() != 0'));
  assert.ok(CONFIGURE_GUEST_HOSTNAME_SCRIPT.includes('systemctl enable mucodesandbox-hostname.service'));
  assert.doesNotMatch(CONFIGURE_GUEST_HOSTNAME_SCRIPT, /sudoers|NOPASSWD|set-hostname|systemsetup|scutil/);
});
