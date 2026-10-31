import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import type {WindowsConfig} from './config.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {RunOptions} from '../../process.ts';
import {AppError} from '../../errors.ts';
import {WINDOWS_COMPONENT_FILES_PYTHON} from './component-files.ts';
import {WINDOWS_DESKTOP_FRAME_BOOTSTRAP} from './desktop-component-transport.ts';

export const WINDOWS_DESKTOP_TASK_COMMON=WINDOWS_COMPONENT_FILES_PYTHON+String.raw`
import io,uuid,time,subprocess
PARTS=['run','mucodesandbox','desktop-component-jobs']
ALLOWED={'lock','descriptor.json','runner.py','attempted','cancelled'}
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'}
def boot_identity():
 with open('/proc/sys/kernel/random/boot_id','r',encoding='ascii') as source:value=source.read(80).strip()
 need(str(uuid.UUID(value))==value);return value
def metadata(token,app,boot,program_sha,runner_sha,runner_bytes):
 need(str(uuid.UUID(token))==token and uuid.UUID(token).version==4 and app in ['grok-bot','claude-desktop'])
 need(str(uuid.UUID(boot))==boot and re.fullmatch('[a-f0-9]{64}',program_sha) is not None and re.fullmatch('[a-f0-9]{64}',runner_sha) is not None)
 need(type(runner_bytes) is int and 0<runner_bytes<=32768)
 return dict(version=1,token=token,application=app,bootId=boot,programSha256=program_sha,runnerSha256=runner_sha,runnerBytes=runner_bytes,budgetSeconds=600,unit='mucodesandbox-desktop-component-'+token+'.service')
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')
def runner_path(meta):return '/'+('/'.join(PARTS+[meta['token'],'runner.py']))
def arguments(meta):return ['/usr/bin/python3','-I',runner_path(meta),meta['token'],meta['application'],meta['bootId'],meta['programSha256'],meta['runnerSha256'],str(meta['runnerBytes'])]
def description(meta):return 'MuCodeSandbox desktop component '+meta['token']+' '+meta['programSha256']
class Owner:
 def __init__(self,meta,create=False):
  self.meta=meta;self.pins=Pins();self.lock=None
  try:
   need(os.geteuid()==0 and boot_identity()==meta['bootId']);parent=self.pins.path(PARTS,create)
   if create:
    try:os.mkdir(meta['token'],0o700,dir_fd=parent);sync(parent)
    except FileExistsError:pass
   self.folder=self.pins.child(parent,meta['token']);need(stat.S_IMODE(os.fstat(self.folder).st_mode)==0o700)
   self.lock=os.open('lock',os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW|(os.O_CREAT if create else 0),0o600,dir_fd=self.folder)
   s=os.fstat(self.lock);regular(s,0);need(stat.S_IMODE(s.st_mode)==0o600 and s.st_size==0)
   deadline=time.monotonic()+0.5
   while True:
    try:fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
    except BlockingIOError:
     if time.monotonic()>=deadline:raise Refused('Task owner busy')
     time.sleep(0.01)
   need(set(os.listdir(self.folder))<=ALLOWED);self.pins.check()
  except BaseException:self.close();raise
 def close(self):
  if self.lock is not None:os.close(self.lock);self.lock=None
  self.pins.close()
 def write(self,name,raw):
  need(name in ALLOWED and name!='lock')
  fill(self.folder,name,io.BytesIO(raw),dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()),self.pins)
  fd=os.open(name,os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=self.folder)
  try:regular(os.fstat(fd),len(raw));os.fchmod(fd,0o600);sync(fd)
  finally:os.close(fd)
  self.check(name,len(raw),hashlib.sha256(raw).hexdigest())
 def check(self,name,size,digest):
  self.pins.check();read_exact(self.folder,name,dict(bytes=size,sha256=digest))
  fd=os.open(name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=self.folder)
  try:regular(os.fstat(fd),size);need(stat.S_IMODE(os.fstat(fd).st_mode)==0o600)
  finally:os.close(fd)
  self.pins.check()
 def verify(self):
  raw=encoded(self.meta);self.check('descriptor.json',len(raw),hashlib.sha256(raw).hexdigest());self.check('runner.py',self.meta['runnerBytes'],self.meta['runnerSha256'])
 def marker(self,name):
  raw=(hashlib.sha256(encoded(self.meta)).hexdigest()+'\n').encode('ascii')
  if not exists(self.folder,name):return False
  self.check(name,len(raw),hashlib.sha256(raw).hexdigest());return True
 def mark(self,name):self.write(name,(hashlib.sha256(encoded(self.meta)).hexdigest()+'\n').encode('ascii'))
def require_systemd():
 result=subprocess.run(['/usr/bin/systemctl','--version'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,env=ENV)
 need(result.returncode==0 and len(result.stdout)<=4096);words=result.stdout.decode('ascii').splitlines()[0].split();need(len(words)>=2 and words[0]=='systemd' and words[1].isdecimal() and 250<=int(words[1])<=9999)
KEYS=['Id','LoadState','ActiveState','MainPID','User','Group','Type','ExitType','KillMode','RuntimeMaxUSec','TimeoutStopUSec','Description','ControlGroup','ExecStart']
def show_service(meta):
 result=subprocess.run(['/usr/bin/systemctl','show',meta['unit'],'--all','--no-pager']+['--property='+key for key in KEYS],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,env=ENV)
 need(len(result.stdout)<=8192);values={}
 for line in result.stdout.decode('ascii').splitlines():
  key,sep,value=line.partition('=');need(sep and key in KEYS and key not in values);values[key]=value
 need(set(values)==set(KEYS) and values['Id']==meta['unit'] and values['MainPID'].isdecimal() and len(values['MainPID'])<=10)
 need(result.returncode==0 or values['LoadState']=='not-found');return values
def timespan(value):
 parts=re.findall(r'([0-9]+)(us|ms|s|min|h)',value);need(parts and ' '.join(n+u for n,u in parts)==value)
 units={'us':1,'ms':1000,'s':1000000,'min':60000000,'h':3600000000};return sum(int(n)*units[u] for n,u in parts)
def known_service(meta,values):
 need(values['LoadState']=='loaded' and values['User']=='root' and values['Group']=='root' and values['Type']=='exec' and values['ExitType']=='cgroup' and values['KillMode']=='control-group')
 need(values['Description']==description(meta) and values['ControlGroup']=='/system.slice/'+meta['unit'])
 need(timespan(values['RuntimeMaxUSec'])==600000000 and timespan(values['TimeoutStopUSec'])==2000000)
 commands=re.findall(r'^\{ path=/usr/bin/python3 ; argv\[\]=(.*?) ; ',values['ExecStart']);need(len(commands)==1 and values['ExecStart'].count('argv[]=')==1 and commands[0]==' '.join(arguments(meta)))
def cgroup_empty(meta):
 try:
  with open('/sys/fs/cgroup/system.slice/'+meta['unit']+'/cgroup.events','r',encoding='ascii') as source:raw=source.read(512)
 except FileNotFoundError:return True
 need(len(raw)<512);values={}
 for line in raw.splitlines():
  fields=line.split();need(len(fields)==2 and re.fullmatch('[a-z_]+',fields[0]) is not None and fields[1].isdecimal() and fields[0] not in values);values[fields[0]]=int(fields[1])
 need(values.get('populated') in [0,1]);return values['populated']==0
def stopped_service(meta,values):
 if values['LoadState']=='not-found':need(values['ActiveState']=='inactive' and values['MainPID']=='0' and not values['ControlGroup']);return cgroup_empty(meta)
 known_service(meta,values);return values['ActiveState'] in ['inactive','failed'] and values['MainPID']=='0' and cgroup_empty(meta)
def wait_stopped(meta):
 deadline=time.monotonic()+1
 while True:
  if stopped_service(meta,show_service(meta)):return
  need(time.monotonic()<deadline);time.sleep(0.05)
def own_cgroup(meta):
 with open('/proc/self/cgroup','r',encoding='ascii') as source:raw=source.read(4096)
 need(len(raw)<4096 and raw.strip()=='0::/system.slice/'+meta['unit'])
`;

export const WINDOWS_DESKTOP_TASK_RUNNER=WINDOWS_DESKTOP_TASK_COMMON+`
def payload_main(meta):
 sys.argv=['-c',meta['programSha256']]
 exec(compile(${JSON.stringify(WINDOWS_DESKTOP_FRAME_BOOTSTRAP)},'mu-desktop-frame','exec'),{'__name__':'__main__'})
def runner_main(meta):
 owner=Owner(meta)
 try:
  owner.verify();need(owner.marker('attempted') and not owner.marker('cancelled'));own_cgroup(meta)
 finally:owner.close()
 payload_main(meta)
try:
 need(len(sys.argv)==7);runner_main(metadata(sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],int(sys.argv[6])))
except BaseException:
 sys.stderr.write('Desktop component task could not continue\\n');raise SystemExit(78)
`;

export const WINDOWS_DESKTOP_TASK_OPERATIONS=WINDOWS_DESKTOP_TASK_COMMON+String.raw`
def reserve_task(meta,runner):
 require_systemd();need(len(runner)==meta['runnerBytes'] and hashlib.sha256(runner).hexdigest()==meta['runnerSha256']);pins=Pins()
 try:pins.path(['opt','mucodesandbox','windows'],True);pins.check()
 finally:pins.close()
 owner=Owner(meta,True)
 try:
  owner.write('descriptor.json',encoded(meta));owner.write('runner.py',runner);owner.verify();phase='cancelled' if owner.marker('cancelled') else 'reserved'
 finally:owner.close()
 return dict(version=1,token=meta['token'],bootId=meta['bootId'],unit=meta['unit'],phase=phase)
def launch_task(meta):
 owner=Owner(meta)
 try:
  owner.verify();need(not owner.marker('cancelled') and not owner.marker('attempted'));values=show_service(meta);need(stopped_service(meta,values) and values['LoadState']=='not-found');owner.mark('attempted')
 finally:owner.close()
 command=['/usr/bin/systemd-run','--quiet','--no-ask-password','--pipe','--wait','--collect','--service-type=exec','--unit='+meta['unit'],'--slice=system.slice','--description='+description(meta),
  '--property=User=root','--property=Group=root','--property=ExitType=cgroup','--property=KillMode=control-group','--property=RuntimeMaxSec=600','--property=TimeoutStopSec=2','--property=SendSIGKILL=yes','--property=WorkingDirectory=/',
  '--property=NoNewPrivileges=yes','--property=PrivateNetwork=yes','--property=ProtectHome=yes','--property=ProtectSystem=strict','--property=ReadWritePaths=/opt/mucodesandbox/windows /run/mucodesandbox/desktop-component-jobs','--property=ProtectControlGroups=yes','--property=CapabilityBoundingSet=',
  '--setenv=LANG=C.UTF-8','--setenv=LC_ALL=C.UTF-8','--']+arguments(meta)
 process=subprocess.Popen(command,stdin=sys.stdin.buffer,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV,start_new_session=True)
 try:output,error=process.communicate(timeout=605)
 except BaseException:
  try:process.kill()
  except ProcessLookupError:pass
  try:process.communicate(timeout=2)
  except BaseException:pass
  raise
 need(len(output)<=8192 and len(error)<=8192 and process.returncode==0);wait_stopped(meta);sys.stdout.write(output.decode('utf8'))
def cancel_task(meta):
 owner=Owner(meta)
 try:
  owner.verify();attempted=owner.marker('attempted');owner.mark('cancelled');values=show_service(meta)
  need(attempted or values['LoadState']=='not-found')
  if not stopped_service(meta,values):
   known_service(meta,values);subprocess.run(['/usr/bin/systemctl','--no-ask-password','stop',meta['unit']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,env=ENV)
  wait_stopped(meta)
 finally:owner.close()
 return dict(version=1,token=meta['token'],bootId=meta['bootId'],unit=meta['unit'],phase='cancelled')
`;

export interface WindowsDesktopTask {token:string;application:DesktopAppId;programSha256:string;runnerSha256:string;runnerBytes:number}
export function newWindowsDesktopTask(application:DesktopAppId,programSha256:string):WindowsDesktopTask{
 if(!['grok-bot','claude-desktop'].includes(application)||!/^[a-f0-9]{64}$/.test(programSha256))throw new AppError('桌面组件任务凭据无效',400,'DESKTOP_COMPONENT_TASK');
 return Object.freeze({token:randomUUID(),application,programSha256,runnerSha256:createHash('sha256').update(WINDOWS_DESKTOP_TASK_RUNNER).digest('hex'),runnerBytes:Buffer.byteLength(WINDOWS_DESKTOP_TASK_RUNNER)});
}

const taskReceipt=z.object({version:z.literal(1),token:z.uuid(),bootId:z.uuid(),unit:z.string().max(128),phase:z.enum(['reserved','cancelled'])}).strict();
export function parseWindowsDesktopTaskReceipt(text:string,task:WindowsDesktopTask,phase:'reserved'|'cancelled',bootId?:string){
 const value=taskReceipt.safeParse((()=>{try{return Buffer.byteLength(text)<=2048?JSON.parse(text):null;}catch{return null;}})());
 if(!value.success||value.data.token!==task.token||value.data.unit!=='mucodesandbox-desktop-component-'+task.token+'.service'||value.data.phase!==phase||bootId!==undefined&&value.data.bootId!==bootId)throw new AppError('桌面组件进程归属回执无法核对',502,'DESKTOP_COMPONENT_TASK_RECEIPT');return value.data;
}
export interface WindowsDesktopTaskContext {assertCurrent():void;current():boolean;failProtection(reason:string):Promise<void>}
export async function runWindowsDesktopOwnedComponent(runtime:Pick<HyperVRuntime,'management'>,profile:WindowsConfig,application:DesktopAppId,call:{programSha256:string;inputBytes:Uint8Array},context:WindowsDesktopTaskContext,options:RunOptions={}){
 options.signal?.throwIfAborted();context.assertCurrent();const task=newWindowsDesktopTask(application,call.programSha256);
 const reserved=await runtime.management(profile,['sudo','-n','/usr/bin/python3','-I','-'],{...options,input:windowsDesktopTaskProgram(task,'reserve'),inputBytes:undefined,onOutput:undefined,timeoutMs:10000,maxBytes:2048});
 const receipt=parseWindowsDesktopTaskReceipt(reserved,task,'reserved');let cleanup:Promise<void>|undefined,attempted=false;
 const cancel=()=>{if(!cleanup&&context.current())cleanup=Promise.resolve().then(async()=>{if(!context.current())return;const text=await runtime.management(profile,['sudo','-n','/usr/bin/python3','-I','-'],{input:windowsDesktopTaskProgram(task,'cancel',receipt.bootId),timeoutMs:12000,maxBytes:2048});parseWindowsDesktopTaskReceipt(text,task,'cancelled',receipt.bootId);});if(cleanup)void cleanup.catch(()=>{});};
 const abort=()=>cancel();options.signal?.addEventListener('abort',abort,{once:true});
 try{
  context.assertCurrent();options.signal?.throwIfAborted();const program=windowsDesktopTaskProgram(task,'launch',receipt.bootId);if(program.length>24000)throw new AppError('桌面组件任务程序超过限定大小',500,'DESKTOP_COMPONENT_TASK');attempted=true;
  const text=await runtime.management(profile,['sudo','-n','/usr/bin/python3','-I','-c',program],{...options,input:undefined,inputBytes:call.inputBytes,onOutput:undefined,timeoutMs:610000,maxBytes:2048});
  context.assertCurrent();options.signal?.throwIfAborted();return text;
 }catch(error){
  if(attempted||options.signal?.aborted)cancel();
  throw error;
 }finally{
  options.signal?.removeEventListener('abort',abort);
  if(cleanup)try{await cleanup;}catch(error){if(context.current()){try{await context.failProtection('桌面组件准备进程停止尚未确认');}catch{/* Preserve the ownership/stop failure. */}const failure=new AppError('桌面组件准备进程停止尚未确认，环境访问已撤销',409,'DESKTOP_COMPONENT_STOP_UNCONFIRMED');failure.cause=error;throw failure;}}
 }
}
export function windowsDesktopTaskProgram(task:WindowsDesktopTask,mode:'reserve'|'launch'|'cancel',bootId?:string){
 if(!z.uuid().safeParse(task.token).success||!['grok-bot','claude-desktop'].includes(task.application)||!/^[a-f0-9]{64}$/.test(task.programSha256)||task.runnerSha256!==createHash('sha256').update(WINDOWS_DESKTOP_TASK_RUNNER).digest('hex')||task.runnerBytes!==Buffer.byteLength(WINDOWS_DESKTOP_TASK_RUNNER)||!['reserve','launch','cancel'].includes(mode)||mode!=='reserve'&&!z.uuid().safeParse(bootId).success)throw new AppError('桌面组件任务凭据无效',400,'DESKTOP_COMPONENT_TASK');
 const boot=mode==='reserve'?'boot_identity()':JSON.stringify(bootId),meta=`metadata(${JSON.stringify(task.token)},${JSON.stringify(task.application)},${boot},${JSON.stringify(task.programSha256)},${JSON.stringify(task.runnerSha256)},${task.runnerBytes})`;
 const body=mode==='reserve'?`print(json.dumps(reserve_task(meta,${JSON.stringify(WINDOWS_DESKTOP_TASK_RUNNER)}.encode('utf8')),sort_keys=True))`:mode==='cancel'?'print(json.dumps(cancel_task(meta),sort_keys=True))':'launch_task(meta)';
 return WINDOWS_DESKTOP_TASK_OPERATIONS+`\n# MU_OWNED_COMPONENT_ENTRY\ntry:\n meta=${meta}\n ${body}\nexcept BaseException:\n sys.stderr.write('Desktop component task ownership could not be verified\\n');raise SystemExit(78)\n`;
}
