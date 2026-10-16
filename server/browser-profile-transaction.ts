import { APPROVED_BROWSER_RELEASES, approvedBrowserRelease, type BrowserRelease } from './browser-releases.ts';
import { BROWSER_INSTALL_TRANSACTION_PYTHON } from './browser-install-transaction.ts';

// Profile contents are always read and extracted as dev, never with root file privileges.
export const BROWSER_PROFILE_TRANSACTION_PYTHON = `${BROWSER_INSTALL_TRANSACTION_PYTHON}\n` + String.raw`
import pwd, tarfile
UPGRADE = STATE / 'browser-upgrade.json'
PRIVATE = STATE / 'browser-upgrade'
ARCHIVE = PRIVATE / 'profile.tar'
RESTORE = PRIVATE / 'restore'
DISCARD = PRIVATE / 'discard'
PROFILE_PARENT = pathlib.Path('/home/dev/.local/share/mucodesandbox')

def open_profile_parent():
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in PROFILE_PARENT.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        return fd
    except BaseException:
        os.close(fd); raise

def dev_command(args, directory_fd, **kwargs):
    account = pwd.getpwnam('dev')
    return subprocess.run(args, check=True, user=account.pw_uid, group=account.pw_gid, extra_groups=[],
        pass_fds=(directory_fd,), preexec_fn=lambda: os.fchdir(directory_fd),
        env={'PATH':'/usr/bin:/bin', 'LANG':'C', 'LC_ALL':'C', 'HOME':'/home/dev'}, **kwargs)

def profile_archive_digest():
    info = ARCHIVE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError('Unsafe browser profile checkpoint')
    with ARCHIVE.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

def validate_archive():
    # Reject link/device entries before extraction, including links outside the profile.
    with tarfile.open(ARCHIVE, 'r:') as archive:
        for item in archive:
            path = pathlib.PurePosixPath(item.name)
            if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):
                raise RuntimeError('Unsupported browser profile checkpoint entry')

def upgrade_data():
    raw = read_controlled(UPGRADE)
    if raw is None: return None
    data = json.loads(raw)
    fields = {'schema', 'priorRecipe', 'priorPolicy', 'candidateRecipe', 'profileSha256', 'committed'}
    if set(data) != fields or type(data['schema']) is not int or data['schema'] != 1 or type(data['committed']) is not bool:
        raise RuntimeError('Invalid browser upgrade state')
    if data['priorRecipe'] not in APPROVED_RECIPES or data['candidateRecipe'] not in APPROVED_RECIPES or data['priorRecipe'] == data['candidateRecipe']:
        raise RuntimeError('Unapproved browser upgrade version')
    if not isinstance(data['priorPolicy'], str) or len(data['priorPolicy']) > 16384 or not isinstance(data['profileSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', data['profileSha256']):
        raise RuntimeError('Invalid browser upgrade checkpoint')
    protected_directory(PRIVATE)
    if PRIVATE.stat().st_mode & 0o077: raise RuntimeError('Browser checkpoint directory is not private')
    return data

def finish_upgrade_cleanup():
    # Remove the journal first: a committed cleanup can be retried without requiring a deleted archive.
    UPGRADE.unlink(); sync_directory(STATE)
    remove_tree(PRIVATE)

def recover_upgrade():
    data = upgrade_data()
    if data is None:
        if PRIVATE.exists(): protected_directory(PRIVATE); remove_tree(PRIVATE)
        return
    if data['committed']:
        if read_controlled(RECIPE).strip() != data['candidateRecipe']:
            raise RuntimeError('Committed browser upgrade version is missing')
        finish_upgrade_cleanup(); return
    subprocess.run(['systemctl', 'stop', 'mucodesandbox-browser.service'], check=True)
    previous = ROOT / ('chromium-' + data['priorRecipe'].split(':')[0]) / 'chrome-linux-arm64/chrome'
    protected_directory(previous.parent)
    if not previous.is_file() or previous.is_symlink(): raise RuntimeError('Previous browser is unavailable')
    if profile_archive_digest() != data['profileSha256']: raise RuntimeError('Browser profile checkpoint checksum mismatch')
    validate_archive()
    remove_tree(RESTORE); remove_tree(DISCARD)
    RESTORE.mkdir(mode=0o700)
    account = pwd.getpwnam('dev'); os.chown(RESTORE, account.pw_uid, account.pw_gid)
    restore_fd = os.open(RESTORE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with ARCHIVE.open('rb') as stream:
            dev_command(['tar', '--extract', '--file=-', '--no-same-owner', '--no-same-permissions'], restore_fd, stdin=stream)
        for base, dirs, files in os.walk(RESTORE, followlinks=False):
            for name in files:
                fd = os.open(pathlib.Path(base) / name, os.O_RDONLY | os.O_NOFOLLOW)
                try: os.fsync(fd)
                finally: os.close(fd)
            sync_directory(base)
        parent_fd = open_profile_parent()
        try:
            try: os.rename('browser', DISCARD, src_dir_fd=parent_fd)
            except FileNotFoundError: pass
            os.rename(RESTORE, 'browser', dst_dir_fd=parent_fd)
            os.fsync(parent_fd); sync_directory(PRIVATE)
        finally: os.close(parent_fd)
    finally: os.close(restore_fd)
    apply_policy(data['priorPolicy'])
    atomic_write(RECIPE, (data['priorRecipe'] + '\n').encode())
    print('MU_BROWSER_UPGRADE_STAGE restored', flush=True)
    # Keep the archive until both compatible binary selection and profile are durable.
    finish_upgrade_cleanup()

def begin_upgrade(candidate):
    recover(); recover_upgrade()
    prior = read_controlled(RECIPE)
    if prior is None or prior.strip() not in APPROVED_RECIPES: raise RuntimeError('Approved previous browser is required')
    prior = prior.strip()
    if prior == candidate: raise RuntimeError('Browser is already current')
    if tuple(map(int, prior.split(':')[0].split('.'))) > tuple(map(int, candidate.split(':')[0].split('.'))):
        raise RuntimeError('Older browser requires a fresh profile; in-place downgrade is forbidden')
    policy = read_controlled(POLICY)
    if policy is None: raise RuntimeError('Previous browser policy is unavailable')
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'mucodesandbox-browser.service']).returncode == 0:
        raise RuntimeError('Close the browser before checkpointing its profile')
    remove_tree(PRIVATE); PRIVATE.mkdir(mode=0o700)
    parent_fd = open_profile_parent()
    try:
        profile_fd = os.open('browser', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            with ARCHIVE.open('xb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                dev_command(['tar', '--create', '--file=-', '--one-file-system', '--hard-dereference',
                    '--exclude=./SingletonLock', '--exclude=./SingletonSocket', '--exclude=./SingletonCookie', '.'], profile_fd, stdout=stream)
                stream.flush(); os.fsync(stream.fileno())
        finally: os.close(profile_fd)
    finally: os.close(parent_fd)
    validate_archive(); sync_directory(PRIVATE)
    data = {'schema':1, 'priorRecipe':prior, 'priorPolicy':policy, 'candidateRecipe':candidate,
        'profileSha256':profile_archive_digest(), 'committed':False}
    atomic_write(UPGRADE, json.dumps(data, sort_keys=True).encode())
    print('MU_BROWSER_UPGRADE_STAGE checkpointed', flush=True)

def commit_upgrade(candidate):
    data = upgrade_data()
    if data is None or data['candidateRecipe'] != candidate or read_controlled(RECIPE).strip() != candidate:
        raise RuntimeError('Browser upgrade candidate changed before acceptance')
    data['committed'] = True
    atomic_write(UPGRADE, json.dumps(data, sort_keys=True).encode())
    print('MU_BROWSER_UPGRADE_STAGE accepted', flush=True)
    recover_upgrade()
`;

function script(command: string) {
  return `set -euo pipefail\nsudo python3 - <<'MU_BROWSER_PROFILE_TRANSACTION'\n${BROWSER_PROFILE_TRANSACTION_PYTHON}\nAPPROVED_RECIPES = ${JSON.stringify(APPROVED_BROWSER_RELEASES.map(release => release.recipe))}\nwith installation_lock():\n    ${command}\nMU_BROWSER_PROFILE_TRANSACTION\n`;
}
export const RECOVER_BROWSER_UPGRADE_SCRIPT = script('recover(); recover_upgrade()');
export const BROWSER_UPGRADE_STATUS_SCRIPT = script("data = upgrade_data(); print(json.dumps({'recipe':read_controlled(RECIPE), 'pending': data is not None and not data['committed']}))");
export function beginBrowserUpgradeScript(release: BrowserRelease) {
  return script(`begin_upgrade(${JSON.stringify(approvedBrowserRelease(release.version).recipe)})`);
}
export function commitBrowserUpgradeScript(release: BrowserRelease) {
  return script(`commit_upgrade(${JSON.stringify(approvedBrowserRelease(release.version).recipe)})`);
}
