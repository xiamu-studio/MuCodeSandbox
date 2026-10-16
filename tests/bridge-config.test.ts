import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { GUEST_BRIDGE_CONFIG_PYTHON } from '../server/bridge-guest.ts';
import { run } from '../server/process.ts';

test('Guest bridge creates private writable config parents and rejects linked directories and existing config files', async () => {
  const directory = await mkdtemp(path.join(homedir(), '.mu-bridge-config-'));
  try {
    await run('/usr/bin/python3', ['-c', `${GUEST_BRIDGE_CONFIG_PYTHON}
import pathlib, sys
root = pathlib.Path(sys.argv[1])
uid, gid = os.getuid(), os.getgid()
home = root / 'home'; home.mkdir()
configuration = {'socket':'/run/test.sock', 'host':'127.0.0.1:42', 'token':'synthetic'}
install_bridge_config(str(home), uid, gid, 'bridge-test.json', configuration)
for component in ['.config', '.config/mucodesandbox']:
    info = (home / component).stat()
    assert info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700
# A browser must be able to create its sibling configuration after bridge setup.
(home / '.config/browser').mkdir()
file = home / '.config/mucodesandbox/bridge-test.json'
assert json.loads(file.read_text()) == configuration
assert stat.S_IMODE(file.stat().st_mode) == 0o600
outside = root / 'outside'; outside.mkdir()
secret = outside / 'secret'; secret.write_text('UNCHANGED')
for position in ['parent', 'child']:
    candidate = root / position; candidate.mkdir()
    if position == 'parent': (candidate / '.config').symlink_to(outside)
    else:
        (candidate / '.config').mkdir()
        (candidate / '.config/mucodesandbox').symlink_to(outside)
    try: install_bridge_config(str(candidate), uid, gid, 'bridge-test.json', configuration)
    except OSError: pass
    else: raise AssertionError('Linked configuration directory accepted')
for existing in ['symlink', 'hardlink', 'regular']:
    target = home / '.config/mucodesandbox' / ('bridge-' + existing + '.json')
    if existing == 'symlink': target.symlink_to(secret)
    elif existing == 'hardlink': os.link(secret, target)
    else: target.write_text('UNCHANGED')
    try: install_bridge_config(str(home), uid, gid, target.name, configuration)
    except FileExistsError: pass
    else: raise AssertionError('Existing capability configuration overwritten')
    assert target.read_text() == 'UNCHANGED'
assert secret.read_text() == 'UNCHANGED'
assert list(outside.iterdir()) == [secret]
`, directory], { timeoutMs: 10_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
