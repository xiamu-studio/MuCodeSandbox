import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsConfig} from './config.ts';
import {WINDOWS_DESKTOP_CLIENT_INSPECT,assertWindowsDesktopClientSpec,parseWindowsDesktopClientInspection,type WindowsDesktopClientSpec} from './desktop-client-guest.ts';
import {WINDOWS_DESKTOP_COMPONENT_PYTHON} from './desktop-component.ts';
import {WINDOWS_CLIENT_RUNTIME_PYTHON} from './desktop-runtime.ts';
import {windowsDesktopAsset} from './desktop-assets.ts';
import {frameWindowsDesktopProgram} from './desktop-component-transport.ts';

// Immutable root registry and exact fixed-unit operations. Only reserve checks
// local component/package prerequisites; no vendor script or client runs there.
export const WINDOWS_DESKTOP_CLIENT_OPERATIONS=WINDOWS_DESKTOP_CLIENT_INSPECT+String.raw`
import io,uuid,time,signal
CLIENT_ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'}
def client_boot():
 with open('/proc/sys/kernel/random/boot_id','r',encoding='ascii') as source:value=source.read(80).strip()
 need(str(uuid.UUID(value))==value);return value
def client_encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')
def client_deadline(seconds):
 def expired(signum,frame):raise Refused('Desktop control deadline exceeded')
 signal.signal(signal.SIGALRM,expired);signal.alarm(seconds)
def client_systemd():
 result=subprocess.run(['/usr/bin/systemctl','--version'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,env=CLIENT_ENV);need(result.returncode==0 and len(result.stdout)<=4096);words=result.stdout.decode('ascii').splitlines()[0].split();need(len(words)>=2 and words[0]=='systemd' and words[1].isdecimal() and 250<=int(words[1])<=9999)
def client_meta(spec,boot):
 need(str(uuid.UUID(spec['token']))==spec['token'] and uuid.UUID(spec['token']).version==4 and spec['application'] in ['grok-bot','claude-desktop'] and str(uuid.UUID(boot))==boot)
 need(spec['job']=='/run/mucodesandbox/desktop-client-jobs/'+spec['token'] and spec['unit']=='mucodesandbox-desktop-'+spec['application']+'-'+spec['token']+'.service')
 return dict(version=1,bootId=boot,application=spec['application'],token=spec['token'],unit=spec['unit'],job=spec['job'],description=spec['description'],files=spec['files'],argv=spec['argv'],executable=spec['executable'],apparmorSha256=hashlib.sha256(spec['apparmor'].encode()).hexdigest())
class ClientOwner:
 def __init__(self,meta,create=False):
  self.meta=meta;self.pins=Pins();self.lock=None
  try:
   need(os.geteuid()==0 and client_boot()==meta['bootId']);parent=self.pins.path(['run','mucodesandbox','desktop-client-jobs'],create)
   if create:
    try:os.mkdir(meta['token'],0o755,dir_fd=parent);sync(parent)
    except FileExistsError:pass
   self.folder=self.pins.child(parent,meta['token']);need(stat.S_IMODE(os.fstat(self.folder).st_mode)==0o755)
   self.lock=os.open('lock',os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW|(os.O_CREAT if create else 0),0o600,dir_fd=self.folder);s=os.fstat(self.lock);regular(s,0);need(s.st_size==0 and stat.S_IMODE(s.st_mode)==0o600)
   deadline=time.monotonic()+0.5
   while True:
    try:fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
    except BlockingIOError:
     need(time.monotonic()<deadline);time.sleep(0.01)
   need(set(os.listdir(self.folder))<={'lock','descriptor.json','launcher','attempted','cancelled'});self.pins.check()
  except BaseException:self.close();raise
 def close(self):
  if self.lock is not None:os.close(self.lock);self.lock=None
  self.pins.close()
 def check(self,name,raw,mode):
  self.pins.check();read_exact(self.folder,name,dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()));need(stat.S_IMODE(os.stat(name,dir_fd=self.folder,follow_symlinks=False).st_mode)==mode);self.pins.check()
 def write(self,name,raw,mode=0o600):
  fill(self.folder,name,io.BytesIO(raw),dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()),self.pins,mode==0o755)
  fd=os.open(name,os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=self.folder)
  try:os.fchmod(fd,mode);sync(fd)
  finally:os.close(fd)
  self.check(name,raw,mode)
 def descriptor(self):self.check('descriptor.json',client_encoded(self.meta),0o600)
 def launcher(self):
  item=self.meta['files'][self.meta['job']+'/launcher'];read_exact(self.folder,'launcher',item);need(stat.S_IMODE(os.stat('launcher',dir_fd=self.folder,follow_symlinks=False).st_mode)==0o755);self.pins.check()
 def mark(self,name):self.write(name,(hashlib.sha256(client_encoded(self.meta)).hexdigest()+'\n').encode())
 def marked(self,name):
  if not exists(self.folder,name):return False
  self.check(name,(hashlib.sha256(client_encoded(self.meta)).hexdigest()+'\n').encode(),0o600);return True
def client_publish(name,raw,token,mode=0o644):
 parts=name.split('/');pins=Pins()
 try:
  parent=pins.path(parts[1:-1]);item=dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
  if exists(parent,parts[-1]):read_exact(parent,parts[-1],item);need(stat.S_IMODE(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False).st_mode)==mode);pins.check();return
  stage='.'+parts[-1]+'.'+token+'.preparing';fill(parent,stage,io.BytesIO(raw),item,pins);need(mode==0o644);pins.check()
  try:rename_exclusive(parent,stage,parts[-1])
  except FileExistsError:
   # A cancelled reserve can finish publishing the same fixed policy while a
   # replacement reserve is preparing it. Adopt only exact protected bytes;
   # every other error or unknown destination remains a refusal.
   pins.check();read_exact(parent,parts[-1],item);need(stat.S_IMODE(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False).st_mode)==mode)
   read_exact(parent,stage,item);pins.check();os.unlink(stage,dir_fd=parent)
  sync(parent);read_exact(parent,parts[-1],item);need(stat.S_IMODE(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False).st_mode)==mode);pins.check()
 finally:pins.close()
def client_phase(meta,phase):return dict(version=1,application=meta['application'],token=meta['token'],unit=meta['unit'],bootId=meta['bootId'],phase=phase)
def client_stopped(meta):
 value=client_unit(meta);need(value['ActiveState'] in ['inactive','failed'] and value['MainPID']=='0' and value['ControlGroup'] in ['', '/system.slice/'+meta['unit']] and client_group_empty(meta));return value
def client_prerequisites(spec):
 raise Refused('Fixed desktop prerequisite verifier missing')
def reserve_client(spec,boot):
 client_systemd();meta=client_meta(spec,boot);owner=ClientOwner(meta,True)
 try:
  before=client_unit(meta)
  if before['LoadState']!='not-found':owner.descriptor();owner.launcher()
  need(before['ActiveState'] in ['inactive','failed'] and before['MainPID']=='0' and client_group_empty(meta))
  owner.write('descriptor.json',client_encoded(meta));owner.write('launcher',spec['launcher'].encode(),0o755);owner.descriptor();owner.launcher();need(not owner.marked('attempted'))
  if owner.marked('cancelled'):return client_phase(meta,'cancelled')
 finally:owner.close()
 # Expensive local verification is outside the registry lock so cancel can fence
 # the operation immediately, even before a unit file has been published.
 client_prerequisites(spec)
 owner=ClientOwner(meta)
 try:
  owner.descriptor();owner.launcher()
  if owner.marked('cancelled'):return client_phase(meta,'cancelled')
  client_publish('/run/systemd/system/'+meta['unit'],spec['unitText'].encode(),meta['token'])
 finally:owner.close()
 subprocess.run(['/usr/bin/systemctl','daemon-reload'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=True,env=CLIENT_ENV)
 owner=ClientOwner(meta)
 try:
  owner.descriptor();owner.launcher();client_stopped(meta);return client_phase(meta,'cancelled' if owner.marked('cancelled') else 'reserved')
 finally:owner.close()
def launch_client(spec,boot):
 meta=client_meta(spec,boot);owner=ClientOwner(meta)
 try:
  owner.descriptor();owner.launcher()
  if owner.marked('cancelled'):return client_phase(meta,'cancelled')
  need(not owner.marked('attempted'));before=client_stopped(meta);need(before['LoadState']=='loaded');owner.mark('attempted')
 finally:owner.close()
 # The PID1 ConditionPathExists gate remains effective if this RPC is delayed
 # after releasing the lock and cancellation has already returned.
 subprocess.run(['/usr/bin/systemctl','--no-ask-password','start',meta['unit']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=True,env=CLIENT_ENV)
 owner=ClientOwner(meta)
 try:
  owner.descriptor();owner.launcher()
  if owner.marked('cancelled'):return client_phase(meta,'cancelled')
  value=client_unit(meta);need(value['ActiveState']=='active' and value['MainPID'].isdecimal() and int(value['MainPID'])>1 and value['ControlGroup']=='/system.slice/'+meta['unit']);return client_phase(meta,'started')
 finally:owner.close()
def cancel_client(spec,boot):
 meta=client_meta(spec,boot);owner=ClientOwner(meta,True)
 try:
  # A cancel may arrive before the delayed reserve RPC. Publish the same fixed
  # descriptor/launcher as a tombstone, never adopting unknown existing bytes.
  if not exists(owner.folder,'descriptor.json'):owner.write('descriptor.json',client_encoded(meta))
  if not exists(owner.folder,'launcher'):owner.write('launcher',spec['launcher'].encode(),0o755)
  owner.descriptor();owner.mark('cancelled');owner.launcher();attempted=owner.marked('attempted');value=client_unit(meta)
  need(attempted or value['LoadState']=='not-found' or value['ActiveState'] in ['inactive','failed'] and value['MainPID']=='0')
  need(not value['ControlGroup'] or value['ControlGroup']=='/system.slice/'+meta['unit'])
  if value['LoadState']!='not-found':subprocess.run(['/usr/bin/systemctl','--no-ask-password','stop',meta['unit']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=True,env=CLIENT_ENV)
  client_stopped(meta);return client_phase(meta,'cancelled')
 finally:owner.close()
def inspect_owned_client(spec,boot):
 meta=client_meta(spec,boot);owner=ClientOwner(meta)
 try:owner.descriptor();owner.launcher()
 finally:owner.close()
 value=inspect_client(meta);need(client_boot()==meta['bootId']);return value

def focus_owned_client(spec,boot):
 meta=client_meta(spec,boot)
 def receipt(focused):return dict(version=1,application=meta['application'],token=meta['token'],unit=meta['unit'],bootId=boot,focused=focused)
 def current():
  owner=ClientOwner(meta)
  try:owner.descriptor();owner.launcher();cancelled=owner.marked('cancelled')
  finally:owner.close()
  if cancelled:return False
  return inspect_owned_client(spec,boot)['state']=='running'
 def command(args):
  # X11 operations run as dev with a fixed display, never as root and never
  # with a caller-supplied command, window id, PID or environment.
  value=subprocess.run(['/usr/bin/sudo','-n','-H','-u','dev','--','/usr/bin/env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority']+args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,check=True,env=CLIENT_ENV)
  need(len(value.stdout)<=262144);return value.stdout.decode('utf-8',errors='replace')
 def windows():
  lines=command(['/usr/bin/wmctrl','-lp']).splitlines();need(len(lines)<=4096);result=[]
  for line in lines:
   fields=line.split(None,4);need(len(fields)>=4 and re.fullmatch(r'0x[0-9a-fA-F]{1,8}',fields[0]) and fields[2].isdecimal())
   if fields[2] in members:result.append((fields[0],fields[2]))
  return result
 if not current():return receipt(False)
 members=client_processes(meta);starts={pid:client_start(pathlib.Path('/proc')/pid) for pid in members}
 def original():
  return current() and members==client_processes(meta) and all(start==client_start(pathlib.Path('/proc')/pid) for pid,start in starts.items())
 candidates=windows()
 if not candidates:return receipt(False)
 window,pid=candidates[-1]
 if not original() or (window,pid) not in windows():return receipt(False)
 command(['/usr/bin/wmctrl','-ir',window,'-b','add,maximized_vert,maximized_horz'])
 if not original() or (window,pid) not in windows():return receipt(False)
 command(['/usr/bin/wmctrl','-ia',window])
 for attempt in range(10):
  active=command(['/usr/bin/xprop','-root','_NET_ACTIVE_WINDOW']);match=re.fullmatch(r'_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[0-9a-fA-F]{1,8})\s*',active)
  if match and int(match.group(1),16)==int(window,16):return receipt(original() and (window,pid) in windows())
  if attempt<9:time.sleep(0.05)
 return receipt(False)
`;

function prerequisiteProgram(spec:WindowsDesktopClientSpec){
 const asset=windowsDesktopAsset(spec.application),policy='/etc/apparmor.d/mucodesandbox-windows-desktop-'+asset.id+'-'+asset.version;
 return WINDOWS_DESKTOP_COMPONENT_PYTHON+'\n'+WINDOWS_CLIENT_RUNTIME_PYTHON+'\n'+`def client_prerequisites(spec):
 need(main(json.loads(${JSON.stringify(JSON.stringify(asset))}),'inspect')['state']=='verified')
 assert_desktop_runtime(${JSON.stringify(asset.id)})
 subprocess.run(['/usr/bin/localedef','-i',${JSON.stringify(spec.environment.LANG.split('.')[0])},'-f','UTF-8',${JSON.stringify(spec.environment.LANG)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=True,env=CLIENT_ENV)
 client_publish(${JSON.stringify(policy)},spec['apparmor'].encode(),spec['token'])
 subprocess.run(['/usr/sbin/apparmor_parser','-r',${JSON.stringify(policy)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=True,env=CLIENT_ENV)
`;
}
export function windowsDesktopClientControlProgram(spec:WindowsDesktopClientSpec,mode:'reserve'|'launch'|'cancel'|'inspect',bootId?:string){
 assertWindowsDesktopClientSpec(spec);if(!['reserve','launch','cancel','inspect'].includes(mode)||bootId!==undefined&&!z.uuid().safeParse(bootId).success||['launch','inspect'].includes(mode)&&bootId===undefined)throw new AppError('桌面客户端操作凭据无效',400,'DESKTOP_CLIENT_SPEC');
 const data={application:spec.application,token:spec.token,unit:spec.unit,job:spec.job,description:spec.description,files:spec.files,argv:spec.argv,executable:spec.executable,launcher:spec.launcher,unitText:spec.unitText,apparmor:spec.apparmor};
 return WINDOWS_DESKTOP_CLIENT_OPERATIONS+(mode==='reserve'?'\n'+prerequisiteProgram(spec):'')+`\n# MU_CLIENT_CONTROL_ENTRY\nclient_deadline(${mode==='reserve'?120:30})\nspec=json.loads(${JSON.stringify(JSON.stringify(data))})\nprint(json.dumps(${mode==='reserve'?'reserve_client':mode==='launch'?'launch_client':mode==='inspect'?'inspect_owned_client':'cancel_client'}(spec,${bootId===undefined?'client_boot()':JSON.stringify(bootId)}),sort_keys=True))\n`;
}
const controlReceipt=z.object({version:z.literal(1),application:z.enum(['grok-bot','claude-desktop']),token:z.uuid(),unit:z.string().max(128),bootId:z.uuid(),phase:z.enum(['reserved','started','cancelled'])}).strict();
export function windowsDesktopClientFocusProgram(spec:WindowsDesktopClientSpec,bootId:string){
 const program=windowsDesktopClientControlProgram(spec,'inspect',bootId);
 return program.replace('# MU_CLIENT_CONTROL_ENTRY\nclient_deadline(30)\n','# MU_CLIENT_FOCUS_ENTRY\nclient_deadline(10)\n').replace('print(json.dumps(inspect_owned_client(spec,','print(json.dumps(focus_owned_client(spec,');
}
const focusReceipt=z.object({version:z.literal(1),application:z.enum(['grok-bot','claude-desktop']),token:z.uuid(),unit:z.string().max(128),bootId:z.uuid(),focused:z.boolean()}).strict();
export function parseWindowsDesktopClientFocus(text:string,spec:WindowsDesktopClientSpec,bootId:string){
 assertWindowsDesktopClientSpec(spec);let value:unknown;try{value=Buffer.byteLength(text)<=2048?JSON.parse(text):null;}catch{value=null;}const result=focusReceipt.safeParse(value);
 if(!result.success||result.data.application!==spec.application||result.data.token!==spec.token||result.data.unit!==spec.unit||result.data.bootId!==bootId)throw new AppError('客户端窗口状态无法核对',502,'DESKTOP_CLIENT_FOCUS_RECEIPT');return result.data;
}
export function parseWindowsDesktopClientControl(text:string,spec:WindowsDesktopClientSpec,phase:'reserved'|'started'|'cancelled',bootId?:string){
 assertWindowsDesktopClientSpec(spec);let value:unknown;try{value=Buffer.byteLength(text)<=2048?JSON.parse(text):null;}catch{value=null;}const result=controlReceipt.safeParse(value);
 if(!result.success||result.data.application!==spec.application||result.data.token!==spec.token||result.data.unit!==spec.unit||bootId!==undefined&&result.data.bootId!==bootId||result.data.phase!==phase&&!(result.data.phase==='cancelled'&&phase!=='cancelled'))throw new AppError('桌面客户端操作回执无法核对',502,'DESKTOP_CLIENT_CONTROL_RECEIPT');return result.data;
}
export function createWindowsDesktopClientGuestDriver(runtime:Pick<HyperVRuntime,'management'>){
 const call=async(config:WindowsConfig,program:string,options:RunOptions,timeoutMs:number)=>{options.signal?.throwIfAborted();const frame=frameWindowsDesktopProgram(program);return runtime.management(config,['sudo','-n',...frame.command],{...options,input:undefined,inputBytes:frame.inputBytes,onOutput:undefined,timeoutMs,maxBytes:2048});};
 return {
  reserve:async(config:WindowsConfig,spec:WindowsDesktopClientSpec,options:RunOptions={})=>parseWindowsDesktopClientControl(await call(config,windowsDesktopClientControlProgram(spec,'reserve'),options,140000),spec,'reserved'),
  launch:async(config:WindowsConfig,spec:WindowsDesktopClientSpec,bootId:string,options:RunOptions={})=>parseWindowsDesktopClientControl(await call(config,windowsDesktopClientControlProgram(spec,'launch',bootId),options,40000),spec,'started',bootId),
  cancel:async(config:WindowsConfig,spec:WindowsDesktopClientSpec,bootId?:string)=>parseWindowsDesktopClientControl(await call(config,windowsDesktopClientControlProgram(spec,'cancel',bootId),{},40000),spec,'cancelled',bootId),
  inspect:async(config:WindowsConfig,spec:WindowsDesktopClientSpec,bootId:string,options:RunOptions={})=>parseWindowsDesktopClientInspection(await call(config,windowsDesktopClientControlProgram(spec,'inspect',bootId),options,15000),spec),
  focus:async(config:WindowsConfig,spec:WindowsDesktopClientSpec,bootId:string,options:RunOptions={})=>parseWindowsDesktopClientFocus(await call(config,windowsDesktopClientFocusProgram(spec,bootId),options,12000),spec,bootId),
 };
}
