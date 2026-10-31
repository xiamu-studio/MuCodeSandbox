import {createHash} from 'node:crypto';
import {z} from 'zod';
import {setTimeout as delay} from 'node:timers/promises';
import {displayPixels} from '../../../shared/guest-display.ts';
import {dpiScript} from '../../guest-display.ts';
import {WINDOWS_NATIVE_DISPLAY_INSPECT,parseWindowsNativeDisplay} from './display-native.ts';
import {AppError} from '../../errors.ts';
import {resizeVncDisplayStream} from '../../vnc-display.ts';
import {WINDOWS_DISPLAY,WINDOWS_DISPLAY_ROOT,WINDOWS_DISPLAY_EXECUTABLE} from './browser-assets.ts';
import {startWindowsDisplay,windowsDisplayLauncher} from './browser-guest.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsDisplayDriver,WindowsPreparedDisplay} from './display-lifecycle.ts';
import {WINDOWS_DESKTOP_SESSION_CHECK} from './desktop-session.ts';

export const VERIFY_WINDOWS_DISPLAY_COMPONENTS=`sudo -n /usr/bin/python3 -I - <<'MU_DISPLAY_COMPONENTS'
import pathlib,os,stat,json,hashlib,subprocess,shutil
assert subprocess.check_output(['dpkg','--print-architecture'],text=True).strip()=='amd64'
for executable in ['xkbcomp','xauth','x11vnc','xsettingsd','dump_xsettings','xdpyinfo','openbox','wmctrl','pactl','dbus-daemon','gdbus','timeout']:
 if shutil.which(executable) is None:raise RuntimeError('Missing display prerequisite')
for executable in ['/usr/libexec/xdg-desktop-portal','/usr/libexec/xdg-desktop-portal-gtk']:
 if not os.access(executable,os.X_OK):raise RuntimeError('Missing desktop session prerequisite')
root=pathlib.Path(${JSON.stringify(WINDOWS_DISPLAY_ROOT)});current=pathlib.Path('/')
for part in root.parts[1:]:
 current=current/part;s=current.lstat()
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('Unsafe display directory')
for name,maximum,expected in [('.mu-component.json',4096,None),('bin/Xvnc',67108864,${JSON.stringify(WINDOWS_DISPLAY.binarySha256)})]:
 file=root/name;before=file.lstat()
 for parent in file.parents:
  s=parent.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('Unsafe display component parent')
 if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o022 or before.st_nlink!=1 or not 0<before.st_size<=maximum:raise RuntimeError('Unsafe display component')
 fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  opened=os.fstat(fd)
  if (opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino):raise RuntimeError('Display component changed')
  with os.fdopen(fd,'rb',closefd=False) as source:
   if name=='.mu-component.json':record=json.load(source)
   elif hashlib.sha256(source.read(maximum+1)).hexdigest()!=expected:raise RuntimeError('Display executable hash mismatch')
  after=os.fstat(fd);named=file.lstat()
  if any((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) for s in [after,named]):raise RuntimeError('Display component changed')
 finally:os.close(fd)
if record.get('architecture')!='amd64' or record.get('version')!=${JSON.stringify(WINDOWS_DISPLAY.version)} or record.get('archiveSha256')!=${JSON.stringify(WINDOWS_DISPLAY.sha256)} or record.get('binarySha256')!=${JSON.stringify(WINDOWS_DISPLAY.binarySha256)}:raise RuntimeError('Unapproved display component')
if 'not found' in subprocess.check_output(['ldd',${JSON.stringify(WINDOWS_DISPLAY_EXECUTABLE)}],text=True):raise RuntimeError('Missing display dependency')
MU_DISPLAY_COMPONENTS
`;

const displayReady=z.object({version:z.literal(1),state:z.literal('verified')}).strict();
export function parseWindowsDisplayReady(text:string){
 let value:unknown;try{if(Buffer.byteLength(text)>2048)throw Error('Oversized display receipt');value=JSON.parse(text);}catch{throw new AppError('显示服务状态无法核对',502,'DISPLAY_RECEIPT_INVALID');}
 if(!displayReady.safeParse(value).success)throw new AppError('显示服务状态无法核对',502,'DISPLAY_RECEIPT_INVALID');
}

export function windowsDisplayServiceProgram(cpus:number){
 const unit=startWindowsDisplay('fixture8',cpus,true).split("<<'MU_UNIT'\n")[1]?.split('\nMU_UNIT')[0]+'\n';
 if(!unit.startsWith('[Unit]'))throw Error('Display unit source unavailable');
 const expected={
  '/etc/systemd/system/mucodesandbox-display.service':{bytes:Buffer.byteLength(unit),sha256:createHash('sha256').update(unit).digest('hex')},
  '/usr/local/libexec/mu-windows-display':{bytes:Buffer.byteLength(windowsDisplayLauncher('fixture8',cpus,true)),sha256:createHash('sha256').update(windowsDisplayLauncher('fixture8',cpus,true)).digest('hex')},
 };
 return `import os,pathlib,stat,hashlib,json,subprocess
expected=${JSON.stringify(expected)}
for name,item in expected.items():
 file=pathlib.Path(name)
 for parent in file.parents:
  s=parent.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('Unsafe display service path')
 before=file.lstat()
 if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o022 or before.st_nlink!=1 or before.st_size!=item['bytes']:raise RuntimeError('Unsafe display service file')
 if name.endswith('/mu-windows-display') and stat.S_IMODE(before.st_mode)!=0o755:raise RuntimeError('Display launcher mode changed')
 fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  opened=os.fstat(fd)
  if (opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino):raise RuntimeError('Display service file changed')
  with os.fdopen(fd,'rb',closefd=False) as source:
   if hashlib.sha256(source.read(item['bytes']+1)).hexdigest()!=item['sha256']:raise RuntimeError('Display service content changed')
  after=os.fstat(fd);named=file.lstat()
  if any((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) for s in [after,named]):raise RuntimeError('Display service file changed')
 finally:os.close(fd)
unit='mucodesandbox-display.service'
command=['systemctl','show',unit,'--property=ActiveState','--property=MainPID','--property=User','--property=Group','--property=ControlGroup','--property=FragmentPath','--property=DropInPaths']
def properties():return dict(line.split('=',1) for line in subprocess.check_output(command,text=True).splitlines() if '=' in line)
value=properties();pid=value.get('MainPID','');group='/system.slice/'+unit
if value.get('ActiveState')!='active' or not pid.isdecimal() or int(pid)<2 or value.get('User')!='dev' or value.get('Group')!='dev' or value.get('ControlGroup')!=group or value.get('FragmentPath')!='/etc/systemd/system/'+unit or value.get('DropInPaths'):raise RuntimeError('Display unit identity unconfirmed')
process=pathlib.Path('/proc')/pid;before=(process/'stat').read_text().rsplit(')',1)[1].split()[19]
fields=dict(line.split(':',1) for line in (process/'status').read_text().splitlines() if ':' in line);uid=int(subprocess.check_output(['id','-u','dev'],text=True))
if any(int(v)!=uid for v in fields.get('Uid','').split()) or len(fields.get('Uid','').split())!=4 or int(fields.get('CapEff','1'),16)!=0 or '0::'+group not in (process/'cgroup').read_text().splitlines():raise RuntimeError('Display process identity unconfirmed')
if before!=(process/'stat').read_text().rsplit(')',1)[1].split()[19] or properties()!=value:raise RuntimeError('Display process changed')
`;
}
export function windowsDisplayReadyProgram(cpus:number){return windowsDisplayServiceProgram(cpus)+'\n'+WINDOWS_DESKTOP_SESSION_CHECK+'\nprint(json.dumps(dict(version=1,state="verified")))\n';}

export function createWindowsDisplayDriver(runtime:Pick<HyperVRuntime,'management'|'serviceStreamFactory'>):WindowsDisplayDriver{
 return {
  verify:async(entry,options)=>{await runtime.management(entry.config,['bash','-s'],{...options,input:VERIFY_WINDOWS_DISPLAY_COMPONENTS,timeoutMs:60000,maxBytes:4096});},
  start:async(entry,options)=>{await runtime.management(entry.config,['bash','-s'],{...options,input:startWindowsDisplay(entry.password,entry.environment.cpus,true),timeoutMs:60000,maxBytes:4096});},
  channel:async entry=>runtime.serviceStreamFactory(entry.config,'vnc'),
  resize:async(stream,password)=>{await resizeVncDisplayStream(stream,password,3200,2000);},
  check:async(entry,options)=>{const result=await runtime.management(entry.config,['sudo','-n','/usr/bin/python3','-I','-c',windowsDisplayReadyProgram(entry.environment.cpus)],{...options,timeoutMs:15000,maxBytes:2048});parseWindowsDisplayReady(result);},
  configure:async(entry,input,options)=>{
   const requested=displayPixels(input),command=['sudo','-n','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority','/usr/bin/python3','-I','-c'];
   options.assertCurrent();await runtime.management(entry.config,[...command,dpiScript(input)],{...options,timeoutMs:6000,maxBytes:2048});options.assertCurrent();
   if(!entry.vnc)throw new AppError('显示画面尚未连接',409,'DISPLAY_NOT_READY');
   const actual=await resizeVncDisplayStream(entry.vnc(),entry.password,requested.width,requested.height);options.assertCurrent();
   let measured:ReturnType<typeof parseWindowsNativeDisplay>|undefined;
   for(let attempt=0;attempt<12;attempt++){
    measured=parseWindowsNativeDisplay(await runtime.management(entry.config,[...command,WINDOWS_NATIVE_DISPLAY_INSPECT],{...options,timeoutMs:8000,maxBytes:2048}));options.assertCurrent();
    if(measured.width===actual.width&&measured.height===actual.height&&Math.abs(measured.dpi/98304-requested.scaleFactor)<.001)break;
    if(attempt<11)await delay(80,undefined,{signal:options.signal});
   }
   return {...requested,...actual,mode:requested.mode??'adaptive',browserScaleFactor:0,densitySource:'xsettings',nativeScaleFactor:measured!.dpi/98304,matched:measured!.width===requested.width&&measured!.height===requested.height&&actual.width===requested.width&&actual.height===requested.height&&Math.abs(measured!.dpi/98304-requested.scaleFactor)<.001};
  },
  stop:async(entry:WindowsPreparedDisplay)=>{await runtime.management(entry.config,['bash','-s'],{input:`set -euo pipefail
sudo -n systemctl stop mucodesandbox-display.service
for unit in mucodesandbox-display.service; do
 state=$(systemctl show "$unit" --property=ActiveState --value)
 case "$state" in inactive|failed) ;; *) exit 1;; esac
 test "$(systemctl show "$unit" --property=MainPID --value)" = 0
done
`,timeoutMs:30000,maxBytes:4096});},
 };
}
