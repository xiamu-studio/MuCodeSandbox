import { approvedBrowserRelease } from './browser-releases.ts';

// Shared by the installer and its next-operation recovery; all paths stay in root-owned guest directories.
export const BROWSER_INSTALL_TRANSACTION_PYTHON = String.raw`
import contextlib, fcntl, hashlib, json, os, pathlib, re, shutil, stat, subprocess, tempfile
ROOT = pathlib.Path('/opt/mucodesandbox')
STATE = pathlib.Path('/var/lib/mucodesandbox')
JOURNAL = STATE / 'browser-install-transaction.json'
RECIPE = STATE / 'browser-recipe'
POLICY = pathlib.Path('/etc/apparmor.d/mucodesandbox-chromium')

def protected_directory(directory, create=False):
    current = pathlib.Path('/')
    for part in directory.parts[1:]:
        current = current / part
        if create and not current.exists(): current.mkdir(mode=0o755)
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Browser installation directory is not root-controlled: ' + str(current))

def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def atomic_write(file, data, mode=0o600):
    protected_directory(file.parent, True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as out:
            temporary = pathlib.Path(out.name)
            os.fchmod(out.fileno(), mode)
            out.write(data); out.flush(); os.fsync(out.fileno())
        os.replace(temporary, file); temporary = None
        sync_directory(file.parent)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)

def read_controlled(file):
    try: info = file.lstat()
    except FileNotFoundError: return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 32768:
        raise RuntimeError('Unsafe browser installation state: ' + str(file))
    return file.read_text()

def remove_tree(directory):
    if directory.is_symlink(): raise RuntimeError('Browser installation path must not be a symlink')
    if directory.exists(): shutil.rmtree(directory); sync_directory(directory.parent)

def apply_policy(content):
    if content is None:
        if POLICY.exists():
            if shutil.which('apparmor_parser'): subprocess.run(['apparmor_parser', '-R', str(POLICY)], check=True)
            POLICY.unlink(); sync_directory(POLICY.parent)
    else:
        atomic_write(POLICY, content.encode(), 0o644)
        if shutil.which('apparmor_parser'): subprocess.run(['apparmor_parser', '-r', str(POLICY)], check=True)

def record(data): atomic_write(JOURNAL, json.dumps(data, sort_keys=True).encode())

def recover():
    raw = read_controlled(JOURNAL)
    if raw is None: return
    data = json.loads(raw)
    fields = {'version', 'target', 'stage', 'backup', 'hadTarget', 'priorRecipe', 'priorPolicy', 'committed'}
    if set(data) != fields or type(data['version']) is not int or data['version'] != 1 or type(data['hadTarget']) is not bool or type(data['committed']) is not bool:
        raise RuntimeError('Invalid browser installation transaction')
    if not isinstance(data['target'], str) or not re.fullmatch(r'chromium-[0-9]+(?:\.[0-9]+){3}', data['target']):
        raise RuntimeError('Invalid browser installation target')
    if data['stage'] != data['target'] + '.mu-next' or data['backup'] != data['target'] + '.mu-previous':
        raise RuntimeError('Invalid browser installation recovery paths')
    for field in ['priorRecipe', 'priorPolicy']:
        if data[field] is not None and (not isinstance(data[field], str) or len(data[field]) > 16384):
            raise RuntimeError('Invalid browser installation prior state')
    protected_directory(ROOT); protected_directory(STATE)
    target, stage, backup = (ROOT / data[key] for key in ['target', 'stage', 'backup'])
    for directory in [target, stage, backup]:
        if directory.is_symlink(): raise RuntimeError('Unsafe browser installation recovery symlink')
    if data['committed'] and not target.is_dir(): raise RuntimeError('Committed browser installation is unavailable')
    if not data['committed']:
        subprocess.run(['systemctl', 'stop', 'mucodesandbox-browser.service'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if backup.exists():
            remove_tree(target); os.replace(backup, target); sync_directory(ROOT)
        elif not data['hadTarget']: remove_tree(target)
        elif not target.is_dir(): raise RuntimeError('Browser installation backup is unavailable')
        apply_policy(data['priorPolicy'])
        if data['priorRecipe'] is None:
            RECIPE.unlink(missing_ok=True); sync_directory(STATE)
        else: atomic_write(RECIPE, data['priorRecipe'].encode())
    remove_tree(stage); remove_tree(backup)
    JOURNAL.unlink(); sync_directory(STATE)

@contextlib.contextmanager
def installation_lock():
    protected_directory(STATE, True)
    fd = os.open(STATE / 'browser-install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe browser installation lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(fd)
`;

export const RECOVER_BROWSER_INSTALL_SCRIPT = `set -euo pipefail
sudo python3 - <<'MU_BROWSER_RECOVER'
${BROWSER_INSTALL_TRANSACTION_PYTHON}
with installation_lock():
    recover()
    prior = read_controlled(RECIPE)
    if prior is not None: print(prior.strip())
MU_BROWSER_RECOVER
`;

export function browserInstallTransactionScript(version: string, recipe: string, archive: string, format?: 'zip' | 'deb') {
  if (!/^\d+(?:\.\d+){3}$/.test(version) || !/^[0-9.]+:[a-f0-9]{64}:\d+$/.test(recipe) || recipe.split(':')[0] !== version) throw new Error('Invalid approved browser release');
  const release = approvedBrowserRelease(version);
  if (recipe !== release.recipe || format !== undefined && format !== release.format) throw new Error('Browser recipe or format is not approved for this release');
  format = release.format;
  if (archive !== `/var/lib/mucodesandbox/browser-install/archive.${format}`) throw new Error('Invalid browser archive path');
  return `sudo python3 - <<'MU_BROWSER_INSTALL'
${BROWSER_INSTALL_TRANSACTION_PYTHON}
with installation_lock():
    recover()
    protected_directory(ROOT, True)
    target = ROOT / ${JSON.stringify(`chromium-${version}`)}
    stage = ROOT / (target.name + '.mu-next')
    backup = ROOT / (target.name + '.mu-previous')
    if target.is_symlink() or target.exists() and not target.is_dir() or stage.is_symlink() or backup.exists() or backup.is_symlink():
        raise RuntimeError('Unexpected browser installation recovery path')
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'mucodesandbox-browser.service']).returncode == 0:
        raise RuntimeError('Close the browser before updating its installation')
    remove_tree(stage); stage.mkdir(mode=0o755)
    try:
        private_archive = stage / ${JSON.stringify(`.approved-archive.${format}`)}
        shutil.copyfile(${JSON.stringify(archive)}, private_archive)
        os.chmod(private_archive, 0o600)
        with private_archive.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != ${JSON.stringify(recipe.split(':')[1])}:
                raise RuntimeError('Browser archive checksum mismatch')
        ${format === 'zip' ? "subprocess.run(['unzip', '-q', str(private_archive), '-d', str(stage)], check=True)" : String.raw`# Extract only the signed browser payload. Never run Debian maintainer scripts,
        # install a system updater, or publish the package's desktop integration.
        import tarfile
        output = stage / 'chrome-linux-arm64'
        output.mkdir(mode=0o755)
        process = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(private_archive)], stdout=subprocess.PIPE)
        count, total, names = 0, 0, set()
        try:
            with tarfile.open(fileobj=process.stdout, mode='r|') as payload:
                for item in payload:
                    name = pathlib.PurePosixPath(item.name)
                    if name.is_absolute() or '..' in name.parts: raise RuntimeError('Unsafe Debian payload path')
                    parts = name.parts
                    if parts[:3] != ('opt', 'google', 'chrome'): continue
                    relative = pathlib.PurePosixPath(*parts[3:])
                    if not relative.parts: continue
                    if not (item.isfile() or item.isdir()): raise RuntimeError('Unsupported browser payload link or device')
                    if str(relative) in names: raise RuntimeError('Duplicate browser payload path')
                    names.add(str(relative)); count += 1; total += item.size
                    if count > 20000 or total > 1024*1024*1024: raise RuntimeError('Browser payload exceeds approved bounds')
                    destination = output / relative
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                    if item.isdir(): destination.mkdir(exist_ok=True, mode=0o755)
                    else:
                        with payload.extractfile(item) as source, destination.open('xb') as target_file:
                            shutil.copyfileobj(source, target_file)
                        os.chmod(destination, item.mode & 0o755)
            if process.wait() != 0: raise RuntimeError('Debian payload decompression failed')
        except BaseException:
            process.kill(); process.wait(); raise
        # The runtime uses one helper path for both approved distributions.
        (output / 'chrome-sandbox').rename(output / 'chrome_sandbox')`}
        private_archive.unlink()
        executable = stage / 'chrome-linux-arm64/chrome'
        helper = stage / 'chrome-linux-arm64/chrome_sandbox'
        if not executable.is_file() or executable.is_symlink() or not helper.is_file() or helper.is_symlink():
            raise RuntimeError('Official browser archive is incomplete')
        for base, dirs, files in os.walk(stage, followlinks=False):
            for name in dirs + files:
                file = pathlib.Path(base) / name
                if file.is_symlink(): raise RuntimeError('Unexpected link in the approved browser archive')
                os.chown(file, 0, 0); os.chmod(file, file.stat().st_mode & ~0o022)
        os.chmod(executable, 0o755); os.chmod(helper, 0o4755)
        actual = subprocess.check_output([str(executable), '--version'], text=True).strip()
        if actual.split()[-1] != ${JSON.stringify(version)}: raise RuntimeError('Browser executable version mismatch')
        # Persist extracted contents before publishing the directory or recovery journal.
        for base, dirs, files in os.walk(stage):
            for name in files:
                fd = os.open(pathlib.Path(base) / name, os.O_RDONLY | os.O_NOFOLLOW)
                try: os.fsync(fd)
                finally: os.close(fd)
            sync_directory(base)
        data = {'version':1, 'target':target.name, 'stage':stage.name, 'backup':backup.name,
            'hadTarget':target.exists(), 'priorRecipe':read_controlled(RECIPE), 'priorPolicy':read_controlled(POLICY), 'committed':False}
        record(data)
        print('MU_BROWSER_INSTALL_STAGE prepared', flush=True)
        if target.exists(): os.replace(target, backup); sync_directory(ROOT)
        print('MU_BROWSER_INSTALL_STAGE backed-up', flush=True)
        os.replace(stage, target); sync_directory(ROOT)
        print('MU_BROWSER_INSTALL_STAGE switched', flush=True)
        policy = 'abi <abi/4.0>,\\ninclude <tunables/global>\\n' + str(target / 'chrome-linux-arm64/chrome') + ' flags=(unconfined) {\\n  userns,\\n}\\n'
        apply_policy(policy)
        atomic_write(RECIPE, (${JSON.stringify(recipe)} + '\\n').encode())
        print('MU_BROWSER_INSTALL_STAGE configured', flush=True)
        data['committed'] = True; record(data)
        print('MU_BROWSER_INSTALL_STAGE committed', flush=True)
        recover()
    except BaseException:
        # SIGKILL and power loss are recovered by the next operation instead.
        if JOURNAL.exists(): recover()
        else: remove_tree(stage)
        raise
MU_BROWSER_INSTALL
`;
}
