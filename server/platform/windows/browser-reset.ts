import {BROWSER_RESET_PYTHON} from '../../browser-reset.ts';
import {AppError} from '../../errors.ts';

// Read only, even when reset is disabled: a later launch must never silently
// reopen old website data while an earlier confirmed clearing is unfinished.
export const INSPECT_WINDOWS_BROWSER_RESET_SCRIPT=`set -euo pipefail
sudo /usr/bin/python3 -I - <<'MU_WINDOWS_BROWSER_RESET_STATE'
import os,pathlib,stat
current=pathlib.Path('/')
for part in ['var','lib','mucodesandbox']:
 current=current/part
 try: info=current.lstat()
 except FileNotFoundError:
  print('none');raise SystemExit(0)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
  raise RuntimeError('Browser reset state is not root-controlled')
print('pending' if any(os.path.lexists(current/name) for name in ['browser-reset.json','browser-reset']) else 'none')
MU_WINDOWS_BROWSER_RESET_STATE
`;
export function windowsBrowserResetState(value:string):'none'|'pending'{const state=value.trim();if(state==='none'||state==='pending')return state;throw new AppError('无法确认浏览器资料重置状态，请保持浏览器关闭并检查操作记录',409,'BROWSER_RESET_STATE_INVALID');}

// The same fixed profile, durable intent and forward recovery as Mac. Windows
// uses sealed AMD64 components, never the Mac binary-install/upgrade journal.
export const WINDOWS_BROWSER_RESET_HELPERS=String.raw`
def windows_reset_preflight():
    if subprocess.check_output(['dpkg', '--print-architecture'], text=True, timeout=10).strip() != 'amd64':
        raise RuntimeError('Windows browser reset requires the AMD64 guest')
    for file in [JOURNAL, UPGRADE]:
        if read_controlled(file) is not None:
            raise RuntimeError('Unexpected browser installation transaction; original data preserved')
    if PRIVATE.exists() or PRIVATE.is_symlink():
        raise RuntimeError('Unexpected browser upgrade directory; original data preserved')
    # Component publication shares installation_lock(). Reset may never proceed
    # across a pending Windows component replacement, even with its gate off.
    current=pathlib.Path('/')
    for part in ['opt','mucodesandbox','windows']:
        current=current/part
        try:info=current.lstat()
        except FileNotFoundError:break
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise RuntimeError('Unsafe Windows browser component directory')
    else:
        if os.path.lexists(current/'.browser-adoption'):
            raise RuntimeError('Browser version adoption must finish before resetting profile data')
        if os.path.lexists(current/'.browser-repair'):
            raise RuntimeError('Browser component recovery must finish before resetting profile data')

def windows_stop_browser():
    # Transient candidates use their exact transaction epoch as unit identity.
    transient=pathlib.Path('/run/systemd/transient');candidates=[]
    if transient.exists():
        current=pathlib.Path('/')
        for part in transient.parts[1:]:
            current=current/part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe candidate service registry')
        for count,file in enumerate(transient.iterdir()):
            if count>=2048:raise RuntimeError('Candidate service registry exceeds its bound')
            match=re.fullmatch(r'mucodesandbox-browser-trial-([a-f0-9]{32})\.service',file.name)
            if not match:continue
            try:info=file.lstat()
            except FileNotFoundError:continue
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1:raise RuntimeError('Unknown candidate service preserved')
            if len(candidates)>=32:raise RuntimeError('Too many candidate services require recovery')
            candidates.append((file.name,match[1]))
    for unit_name,epoch in candidates:
        load=subprocess.check_output(['/usr/bin/systemctl','show','--property=LoadState','--value',unit_name],text=True,timeout=10).strip()
        if load=='not-found':continue
        transient_value=subprocess.check_output(['/usr/bin/systemctl','show','--property=Transient','--value',unit_name],text=True,timeout=10).strip()
        description=subprocess.check_output(['/usr/bin/systemctl','show','--property=Description','--value',unit_name],text=True,timeout=10).strip()
        if load!='loaded' or transient_value!='yes' or description!='MuCodeSandbox Windows candidate trial '+epoch:raise RuntimeError('Unknown candidate service preserved')
        subprocess.run(['/usr/bin/systemctl','stop',unit_name],check=True,timeout=30)
    unit = subprocess.run(['systemctl', 'show', '--property=LoadState', '--value', 'mucodesandbox-browser.service'],
        capture_output=True, text=True, timeout=10)
    state = unit.stdout.strip()
    if state == 'loaded' and unit.returncode == 0:
        subprocess.run(['systemctl', 'stop', 'mucodesandbox-browser.service'], check=True, timeout=25)
    elif state != 'not-found' or unit.returncode not in [0, 1, 4]:
        raise RuntimeError('Browser service state could not be verified')
    # A never-opened browser has no unit or data. It is safe to reset its empty
    # profile, but not while an unmanaged browser still uses the managed path.
    profile = b'/home/dev/.local/share/mucodesandbox/browser'
    for process in pathlib.Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try:
            executable = os.readlink(process / 'exe')
            arguments = (process / 'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError, ProcessLookupError): continue
        if executable.startswith('/opt/mucodesandbox/windows/chrome-') or b'--user-data-dir=' + profile in arguments or any(
            value == b'--user-data-dir' and index + 1 < len(arguments) and arguments[index + 1] == profile
            for index, value in enumerate(arguments)):
            raise RuntimeError('A browser still uses the managed profile; close it before resetting')
`;

const originalStop="subprocess.run(['systemctl', 'stop', 'mucodesandbox-browser.service'], check=True)";
const boundary=BROWSER_RESET_PYTHON.indexOf("\nRESET = STATE / 'browser-reset.json'");
if(boundary<0||BROWSER_RESET_PYTHON.slice(boundary).split(originalStop).length!==3)throw Error('Shared browser reset stop contract changed');
const windowsResetPython=BROWSER_RESET_PYTHON.slice(0,boundary)+BROWSER_RESET_PYTHON.slice(boundary).replaceAll(originalStop,'windows_stop_browser()');
function script(command:'begin_reset()'|'recover_reset()'){
 return `set -euo pipefail\nsudo /usr/bin/python3 -I - <<'MU_WINDOWS_BROWSER_RESET'\n${windowsResetPython}\n${WINDOWS_BROWSER_RESET_HELPERS}\nAPPROVED_RECIPES = []\nwith installation_lock():\n    windows_reset_preflight()\n    ${command}\nMU_WINDOWS_BROWSER_RESET\n`;
}
export const RESET_WINDOWS_BROWSER_PROFILE_SCRIPT=script('begin_reset()');
export const RECOVER_WINDOWS_BROWSER_RESET_SCRIPT=script('recover_reset()');
