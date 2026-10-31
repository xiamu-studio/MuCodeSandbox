import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Environment} from '../../../shared/types.ts';
import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import {AppError} from '../../errors.ts';
import {linuxLocales,shellQuote} from '../../network-guard.ts';
import {GUEST_AUDIO_ENV} from '../../guest-audio.ts';
import {windowsDesktopAsset} from './desktop-assets.ts';
import {WINDOWS_COMPONENT_FILES_PYTHON} from './component-files.ts';
import {WINDOWS_DESKTOP_SESSION} from './desktop-session.ts';
const clientSpecs=new WeakSet<object>();

// Runs only as dev, never changes an existing directory's permissions or data.
export const WINDOWS_DESKTOP_PROFILE_PYTHON=String.raw`import os,stat
def prepare_desktop_profile(application):
 if application not in ['grok-bot','claude-desktop'] or os.geteuid()==0:raise RuntimeError('Invalid desktop profile owner')
 uid=os.geteuid();fds=[];bindings=[]
 def valid(value,private=False):
  if not stat.S_ISDIR(value.st_mode) or value.st_uid!=uid or value.st_mode&0o022 or private and stat.S_IMODE(value.st_mode)!=0o700:raise RuntimeError('Desktop profile directory unavailable')
 def opened(parent,name,private=False):
  fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent);fds.append(fd);value=os.fstat(fd);valid(value,private);bindings.append((parent,name,fd,(value.st_dev,value.st_ino),private));return fd
 def child(parent,name,private=False):
  try:os.mkdir(name,0o700,dir_fd=parent);os.fsync(parent)
  except FileExistsError:pass
  return opened(parent,name,private)
 try:
  home=os.open('/home/dev',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW);fds.append(home);valid(os.fstat(home));parent=home
  for name in ['.local','share','mucodesandbox','desktop-clients']:parent=child(parent,name)
  leaf=child(parent,application,True)
  for name in ['profile','config','cache','data']:child(leaf,name,True)
  for parent,name,fd,before,private in bindings:
   a=os.fstat(fd);b=os.stat(name,dir_fd=parent,follow_symlinks=False);valid(a,private);valid(b,private)
   if before!=(a.st_dev,a.st_ino) or before!=(b.st_dev,b.st_ino):raise RuntimeError('Desktop profile path changed')
  current=os.stat('/home/dev',follow_symlinks=False);valid(current)
  if (current.st_dev,current.st_ino)!=(os.fstat(home).st_dev,os.fstat(home).st_ino):raise RuntimeError('Desktop profile home changed')
 finally:
  for fd in reversed(fds):os.close(fd)
`;

export function windowsDesktopClientSpec(e:Environment,id:DesktopAppId,token:string){
 const asset=windowsDesktopAsset(id),locale=linuxLocales[e.identity.locale];
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)||!z.uuid().safeParse(token).success||e.kind!=='vm'||e.state!=='running'||!e.network.strict||!e.network.transparent||typeof locale!=='string'||!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z_+\d-]+)+)$/.test(e.identity.timezone))throw new AppError('桌面客户端启动参数无法核对',409,'DESKTOP_CLIENT_SPEC');
 const component='/opt/mucodesandbox/windows/desktop-'+id+'-'+asset.version,profile='/home/dev/.local/share/mucodesandbox/desktop-clients/'+id,job='/run/mucodesandbox/desktop-client-jobs/'+token,unit='mucodesandbox-desktop-'+id+'-'+token+'.service',executable=component+'/'+asset.executable;
 const environment=Object.freeze({HOME:'/home/dev',USER:'dev',LOGNAME:'dev',PATH:'/usr/local/bin:/usr/bin:/bin',DISPLAY:':99',XAUTHORITY:'/run/mu-browser/Xauthority',XDG_CURRENT_DESKTOP:'Openbox',XDG_RUNTIME_DIR:WINDOWS_DESKTOP_SESSION.directory,DBUS_SESSION_BUS_ADDRESS:WINDOWS_DESKTOP_SESSION.address,TZ:e.identity.timezone,LANG:locale,LC_ALL:locale,XDG_CONFIG_HOME:profile+'/config',XDG_CACHE_HOME:profile+'/cache',XDG_DATA_HOME:profile+'/data',LP_NUM_THREADS:'0',GALLIUM_DRIVER:'llvmpipe',LIBGL_ALWAYS_SOFTWARE:'1',MESA_SHADER_CACHE_DISABLE:'true',...GUEST_AUDIO_ENV,CHROME_DEVEL_SANDBOX:component+'/'+asset.sandbox});
 const argv=Object.freeze([executable,'--user-data-dir='+profile+'/profile','--password-store=basic','--force-device-scale-factor=2','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--use-gl=angle','--use-angle=gl']);
 const launcher=`#!/bin/bash\nset -euo pipefail\numask 077\n/usr/bin/python3 -I -c ${shellQuote(WINDOWS_DESKTOP_PROFILE_PYTHON+'\nprepare_desktop_profile('+JSON.stringify(id)+')\n')}\nexec /usr/bin/env -i ${Object.entries(environment).map(([key,value])=>shellQuote(key+'='+value)).join(' ')} ${argv.map(shellQuote).join(' ')}\n`;
 const description='MuCodeSandbox managed desktop '+id+' '+asset.version+' '+token;
 const unitText=`[Unit]\nDescription=${description}\nBindsTo=mucodesandbox-display.service\nAfter=mucodesandbox-display.service\nPartOf=mucodesandbox-display.service\nConditionPathExists=!${job}/cancelled\n[Service]\nType=exec\nUser=dev\nGroup=dev\nWorkingDirectory=/home/dev\nUMask=0077\nExecStart=${job}/launcher\nKillMode=control-group\nTimeoutStopSec=15\nSendSIGKILL=yes\nRestart=no\n`;
 const apparmor=`abi <abi/4.0>,\ninclude <tunables/global>\n${executable} flags=(unconfined) {\n userns,\n}\n`;
 const file=(bytes:string,mode:number)=>Object.freeze({bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex'),mode});
 const result=Object.freeze({application:id,token,version:asset.version,component,executable,profile,job,unit,description,environment,argv,launcher,unitText,apparmor,files:Object.freeze({['/run/systemd/system/'+unit]:file(unitText,0o644),[job+'/launcher']:file(launcher,0o755)})});clientSpecs.add(result);return result;
}
export type WindowsDesktopClientSpec=ReturnType<typeof windowsDesktopClientSpec>;
export function assertWindowsDesktopClientSpec(spec:WindowsDesktopClientSpec){if(!clientSpecs.has(spec))throw new AppError('桌面客户端操作凭据无效',400,'DESKTOP_CLIENT_SPEC');}

export const WINDOWS_DESKTOP_CLIENT_INSPECT=WINDOWS_COMPONENT_FILES_PYTHON+String.raw`
import pathlib,subprocess
def client_group_empty(meta):
 try:raw=(pathlib.Path('/sys/fs/cgroup/system.slice')/meta['unit']/'cgroup.events').read_text()
 except FileNotFoundError:return True
 need(len(raw)<1024);values={}
 for line in raw.splitlines():
  fields=line.split();need(len(fields)==2 and fields[0] not in values and fields[1].isdecimal());values[fields[0]]=fields[1]
 need(values.get('populated') in ['0','1']);return values['populated']=='0'
def client_unit(meta):
 keys=['LoadState','ActiveState','MainPID','User','Group','ControlGroup','FragmentPath','DropInPaths','KillMode','Type','Description','BindsTo','PartOf']
 reply=subprocess.run(['/usr/bin/systemctl','show',meta['unit'],'--no-pager']+['--property='+k for k in keys],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5);need(len(reply.stdout)<=8192);values={}
 for line in reply.stdout.decode('ascii').splitlines():
  key,sep,value=line.partition('=');need(sep and key in keys and key not in values);values[key]=value
 need(set(values)==set(keys))
 if values['LoadState']=='not-found':need(values['ActiveState']=='inactive' and values['MainPID']=='0' and not values['ControlGroup']);return values
 need(reply.returncode==0 and values['LoadState']=='loaded' and values['User']=='dev' and values['Group']=='dev' and values['KillMode']=='control-group' and values['Type']=='exec' and values['Description']==meta['description'] and values['FragmentPath']=='/run/systemd/system/'+meta['unit'] and not values['DropInPaths'] and values['BindsTo'].split()==['mucodesandbox-display.service'] and values['PartOf'].split()==['mucodesandbox-display.service'])
 pins=Pins()
 try:
  for name,item in meta['files'].items():
   parts=name.split('/');parent=pins.path(parts[1:-1]);read_exact(parent,parts[-1],item);s=os.stat(parts[-1],dir_fd=parent,follow_symlinks=False);need(stat.S_IMODE(s.st_mode)==item['mode'])
  pins.check()
 finally:pins.close()
 return values
def client_start(root):return (root/'stat').read_text().rsplit(')',1)[1].split()[19]
def client_fields(root,uid,renderer=False):
 raw=(root/'status').read_text();need(len(raw)<16384);fields={}
 for line in raw.splitlines():
  key,sep,value=line.partition(':');need(sep and key not in fields);fields[key]=value
 ids=fields.get('Uid','').split();need(len(ids)==4 and all(int(v)==uid for v in ids) and int(fields.get('CapEff','1'),16)==0)
 if renderer:need(fields.get('Seccomp','').strip()=='2' and fields.get('NoNewPrivs','').strip()=='1' and all(int(fields.get(k,'1'),16)==0 for k in ['CapPrm','CapInh','CapAmb']))
def client_processes(meta):
 raw=(pathlib.Path('/sys/fs/cgroup/system.slice')/meta['unit']/'cgroup.procs').read_text();need(len(raw)<65536);pids=raw.split();need(len(pids)<=4096 and len(set(pids))==len(pids) and all(p.isdecimal() and 1<int(p)<=2147483647 for p in pids));return set(pids)
def inspect_client(meta):
 need(os.geteuid()==0);values=client_unit(meta);result=dict(version=1,application=meta['application'],token=meta['token'],unit=meta['unit'],state='stopped',pid=0,renderers=0,rendererProtected=None)
 if values['ActiveState'] in ['inactive','failed']:
  need(values['MainPID']=='0' and values['ControlGroup'] in ['', '/system.slice/'+meta['unit']] and client_group_empty(meta));return result
 need(values['ActiveState']=='active' and values['MainPID'].isdecimal() and 1<int(values['MainPID'])<=2147483647 and values['ControlGroup']=='/system.slice/'+meta['unit'])
 uid=int(subprocess.check_output(['/usr/bin/id','-u','dev']));members=client_processes(meta);need(values['MainPID'] in members);observed={};renderers=0
 for pid in sorted(members):
  root=pathlib.Path('/proc')/pid;start=client_start(root);raw=(root/'cmdline').read_bytes();need(0<len(raw)<=262144 and raw[-1:]==bytes([0]));args=raw[:-1].split(bytes([0]))
  need(not any(arg.split(b'=',1)[0] in [b'--no-sandbox',b'--disable-setuid-sandbox',b'--disable-seccomp-filter-sandbox',b'--disable-gpu-sandbox',b'--single-process'] for arg in args));client_fields(root,uid)
  need((root/'cgroup').read_text().strip()=='0::/system.slice/'+meta['unit'])
  if pid==values['MainPID']:need(os.readlink(root/'exe')==meta['executable'] and args==[v.encode() for v in meta['argv']])
  if b'--type=renderer' in args:
   need(os.readlink(root/'exe')==meta['executable']);threads=list((root/'task').iterdir());need(0<len(threads)<=4096 and all(t.name.isdecimal() for t in threads))
   for thread in threads:client_fields(thread,uid,True)
   need({t.name for t in threads}=={t.name for t in (root/'task').iterdir()});renderers+=1
  need(start==client_start(root));observed[pid]=start
 need(members==client_processes(meta) and values==client_unit(meta))
 for pid,start in observed.items():need(start==client_start(pathlib.Path('/proc')/pid))
 result.update(state='running' if renderers else 'starting',pid=int(values['MainPID']),renderers=renderers,rendererProtected=renderers>0);return result
`;

export function windowsDesktopClientInspectProgram(spec:WindowsDesktopClientSpec){
 const meta={application:spec.application,token:spec.token,unit:spec.unit,description:spec.description,files:spec.files,argv:spec.argv,executable:spec.executable};
 return WINDOWS_DESKTOP_CLIENT_INSPECT+'\nprint(json.dumps(inspect_client(json.loads('+JSON.stringify(JSON.stringify(meta))+')),sort_keys=True))\n';
}
const clientReceipt=z.object({version:z.literal(1),application:z.enum(['grok-bot','claude-desktop']),token:z.uuid(),unit:z.string().max(128),state:z.enum(['running','starting','stopped']),pid:z.number().int().min(0).max(2147483647),renderers:z.number().int().min(0).max(4096),rendererProtected:z.boolean().nullable()}).strict();
export function parseWindowsDesktopClientInspection(text:string,spec:WindowsDesktopClientSpec){
 let parsed:unknown;try{parsed=Buffer.byteLength(text)<=2048?JSON.parse(text):null;}catch{parsed=null;}const result=clientReceipt.safeParse(parsed);
 if(!result.success||result.data.application!==spec.application||result.data.token!==spec.token||result.data.unit!==spec.unit||!(result.data.state==='stopped'?result.data.pid===0&&result.data.renderers===0&&result.data.rendererProtected===null:result.data.pid>1&&(result.data.state==='running'?result.data.renderers>0&&result.data.rendererProtected===true:result.data.renderers===0&&result.data.rendererProtected===false)))throw new AppError('桌面客户端进程状态无法核对',502,'DESKTOP_CLIENT_RECEIPT');
 return result.data;
}
