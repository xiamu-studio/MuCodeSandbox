import type {Environment} from '../shared/types.ts';
import type {DesktopAppId} from '../shared/guest-desktop.ts';
import type {LimaRuntime} from './runtime.ts';
import type {RunOptions} from './process.ts';
import {desktopUnit} from './guest-desktop.ts';

export type GuestWindowTarget='browser'|DesktopAppId;
export function windowFocusPython(target:GuestWindowTarget){
  const unit=target==='browser'?'mucodesandbox-browser.service':desktopUnit(target);
  return `import pathlib,subprocess,time,os,json
unit=${JSON.stringify(unit)}
for attempt in range(20):
 data=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',unit,'-p','ActiveState','-p','ControlGroup']).decode().splitlines() if '=' in line)
 if data.get('ActiveState')!='active':print('false');raise SystemExit(0)
 group=data.get('ControlGroup')
 if group!='/system.slice/'+unit:raise RuntimeError('Unexpected application group')
 try:pids=set((pathlib.Path('/sys/fs/cgroup')/group.lstrip('/')/'cgroup.procs').read_text().split())
 except FileNotFoundError:print('false');raise SystemExit(0)
 windows=[]
 for line in subprocess.check_output(['wmctrl','-lp']).decode(errors='replace').splitlines():
  fields=line.split(None,4)
  if len(fields)>=3 and fields[2] in pids:windows.append(fields[0])
 if windows:
  window=windows[-1]
  subprocess.run(['wmctrl','-ir',window,'-b','add,maximized_vert,maximized_horz'],check=True)
  subprocess.run(['wmctrl','-ia',window],check=True)
  print('true');raise SystemExit(0)
 if attempt<19:time.sleep(.1)
print('false')
`;
}
export async function focusGuestWindow(runtime:LimaRuntime,e:Environment,target:GuestWindowTarget,options:RunOptions={}){
  const result=await runtime.management(e,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority','python3','-c',windowFocusPython(target)],{...options,onOutput:undefined,timeoutMs:8000,maxBytes:2048});
  return result.trim()==='true';
}
