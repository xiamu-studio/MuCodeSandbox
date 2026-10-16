import { BROWSER_PROFILE_TRANSACTION_PYTHON } from './browser-profile-transaction.ts';
import { APPROVED_BROWSER_RELEASES } from './browser-releases.ts';

// A durable intent always finishes toward the empty profile. It never rolls back
// website data after the user has confirmed a reset.
export const BROWSER_RESET_PYTHON = `${BROWSER_PROFILE_TRANSACTION_PYTHON}\n` + String.raw`
RESET = STATE / 'browser-reset.json'
RESET_PRIVATE = STATE / 'browser-reset'

def reset_parent():
    account = pwd.getpwnam('dev')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(PROFILE_PARENT.parts[1:]):
            try: next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if index < 2: raise
                os.mkdir(part, 0o700, dir_fd=fd)
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.fchown(next_fd, account.pw_uid, account.pw_gid); os.fsync(fd)
            os.close(fd); fd = next_fd
        return fd
    except BaseException:
        os.close(fd); raise

def reset_state():
    raw = read_controlled(RESET)
    if raw is None: return None
    data = json.loads(raw)
    if type(data.get('schema')) is not int or data != {'schema':1, 'intent':'empty-profile'}:
        raise RuntimeError('Invalid browser reset intent')
    return data

def reset_step(name):
    print('MU_BROWSER_RESET_STAGE ' + name, flush=True)

def recover_reset():
    if reset_state() is None: return
    subprocess.run(['systemctl', 'stop', 'mucodesandbox-browser.service'], check=True)
    protected_directory(RESET_PRIVATE)
    if RESET_PRIVATE.stat().st_mode & 0o077:
        raise RuntimeError('Browser reset state must be private')
    private_fd = os.open(RESET_PRIVATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parent_fd = reset_parent()
    try:
        account = pwd.getpwnam('dev')
        def present(name, fd):
            try: return os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError: return None
        candidate = present('next', private_fd)
        current = present('browser', parent_fd)
        old = present('old', private_fd)
        for info in [candidate, current, old]:
            if info is not None and (not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid):
                raise RuntimeError('Unsafe browser reset directory')
        if candidate is not None:
            if old is not None and current is not None:
                raise RuntimeError('Browser profile was recreated during reset')
            if current is not None:
                os.rename('browser', 'old', src_dir_fd=parent_fd, dst_dir_fd=private_fd)
                os.fsync(parent_fd); os.fsync(private_fd)
            reset_step('detached')
            os.rename('next', 'browser', src_dir_fd=private_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd); os.fsync(private_fd)
            reset_step('published')
        elif current is None:
            raise RuntimeError('Reset profile is missing')
        # fd-relative, no-follow deletion is required. Never follow a dev-owned link.
        if not shutil.rmtree.avoids_symlink_attacks:
            raise RuntimeError('Safe profile deletion is unavailable')
        if present('old', private_fd) is not None:
            shutil.rmtree('old', dir_fd=private_fd); os.fsync(private_fd)
        reset_step('cleaned')
    finally:
        os.close(parent_fd); os.close(private_fd)
    RESET.unlink(); sync_directory(STATE)
    remove_tree(RESET_PRIVATE)

def begin_reset():
    recover(); recover_upgrade(); recover_reset()
    subprocess.run(['systemctl', 'stop', 'mucodesandbox-browser.service'], check=True)
    parent_fd = reset_parent()
    try:
        try:
            info = os.stat('browser', dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != pwd.getpwnam('dev').pw_uid:
                raise RuntimeError('Unsafe browser profile')
        except FileNotFoundError: pass
    finally: os.close(parent_fd)
    if RESET_PRIVATE.exists(): protected_directory(RESET_PRIVATE); remove_tree(RESET_PRIVATE)
    RESET_PRIVATE.mkdir(mode=0o700); sync_directory(STATE)
    candidate = RESET_PRIVATE / 'next'; candidate.mkdir(mode=0o700)
    account = pwd.getpwnam('dev'); os.chown(candidate, account.pw_uid, account.pw_gid)
    sync_directory(candidate); sync_directory(RESET_PRIVATE)
    atomic_write(RESET, b'{"schema":1,"intent":"empty-profile"}')
    reset_step('intent')
    recover_reset()
`;

function script(command: string) {
  return `set -euo pipefail\nsudo python3 - <<'MU_BROWSER_RESET'\n${BROWSER_RESET_PYTHON}\nAPPROVED_RECIPES = ${JSON.stringify(APPROVED_BROWSER_RELEASES.map(r => r.recipe))}\nwith installation_lock():\n    ${command}\nMU_BROWSER_RESET\n`;
}
export const RESET_BROWSER_PROFILE_SCRIPT = script('begin_reset()');
export const RECOVER_BROWSER_RESET_SCRIPT = script('recover_reset()');
