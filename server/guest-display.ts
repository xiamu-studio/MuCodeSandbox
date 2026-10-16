import type { DisplayRequest } from '../shared/guest-display.ts';
import { displayPixels } from '../shared/guest-display.ts';

export function dpiScript(request:DisplayRequest) {
  const value=displayPixels(request),factor=Math.max(1,Math.floor(value.scaleFactor));
  return `import os,pathlib,pwd,signal,tempfile
root=pathlib.Path('/run/mu-browser');user=pwd.getpwnam('dev')
if root.is_symlink() or root.stat().st_uid!=user.pw_uid:raise RuntimeError('Invalid display directory')
file=root/'xsettings.pid'
if file.is_symlink() or file.stat().st_uid!=user.pw_uid:raise RuntimeError('Invalid display process record')
pid=int(file.read_text())
if pid<=1:raise RuntimeError('Invalid display process')
process=pathlib.Path('/proc')/str(pid)
if process.joinpath('exe').readlink()!=pathlib.Path('/usr/bin/xsettingsd'):raise RuntimeError('Wrong display process')
if 'mucodesandbox-display.service' not in process.joinpath('cgroup').read_text():raise RuntimeError('Unowned display process')
with tempfile.NamedTemporaryFile(mode='w',dir=root,prefix='.dpi-',delete=False) as temporary:
 temporary.write('Xft/DPI ${Math.round(value.scaleFactor*96*1024)}\\nGdk/WindowScalingFactor ${factor}\\nGdk/UnscaledDPI ${Math.round(value.scaleFactor/factor*96*1024)}\\n')
 temporary.flush();os.fsync(temporary.fileno());name=temporary.name
os.replace(name,root/'xsettings.conf')
os.kill(pid,signal.SIGHUP)
`;
}
