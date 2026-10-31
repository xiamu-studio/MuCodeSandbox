"""Real host files and worker algorithms; explicit Linux uid/mode/dir-fd,
prctl, space reservation, network, DEB and service adapters. No VM/browser.
"""
import os as native,sys,pathlib,types,stat,json,hashlib,struct,io,tarfile,contextlib,ctypes,uuid,time,subprocess,tempfile,sqlite3,traceback
exclusive_rename=__import__('runpy').run_path(str(pathlib.Path(__file__).with_name('windows_exclusive_rename.py')))['exclusive_rename']
worker_mode=len(sys.argv)>1 and sys.argv[1]=='worker'
sources=[pathlib.Path(p) for p in sys.argv[2:8] if worker_mode] if worker_mode else [pathlib.Path(p) for p in sys.argv[1:7]]
physical=pathlib.Path(sys.argv[8] if worker_mode else sys.argv[7]).absolute()
root_parts=physical.parts;dirs={};files={};next_dir=[100000];namespace={};fault=sys.argv[11] if worker_mode else '-';occurrence=int(sys.argv[12]) if worker_mode else 1;seen={};virtual_cwd=[physical]
def step(name):
 seen[name]=seen.get(name,0)+1
 if name==fault and seen[name]==occurrence:
  print('FAULT_READY',flush=True)
  while True:time.sleep(1)
class FilePath(type(pathlib.Path())):
 def __new__(cls,*args):
  if args and str(args[0]).startswith('/'):
   args=(physical,*pathlib.PurePosixPath(str(args[0])).parts[1:],*args[1:])
  return super().__new__(cls,*args)
 @property
 def parts(self):
  values=super().parts
  return ('/',*values[len(root_parts):]) if values[:len(root_parts)]==root_parts else values
 @property
 def anchor(self):return '/' if super().parts[:len(root_parts)]==root_parts else super().anchor
 def lstat(self):return metadata(self)
def role(path):
 value=str(pathlib.Path(str(path)));prefix=str(physical)+native.sep
 return value[len(prefix):].replace(native.sep,'/') if value.startswith(prefix) else ''
def metadata(path,opened=None):
 path=pathlib.Path(str(path));info=path.lstat() if opened is None else native.fstat(opened);values={key:getattr(info,key) for key in dir(info) if key.startswith('st_')};relative=role(path);directory=stat.S_ISDIR(info.st_mode)
 dev=relative.startswith('home/dev') or '/restore' in relative or '/failed-profile' in relative
 mode=(0o700 if dev or '/.browser-' in relative or relative=='run/mucodesandbox-lease' else 0o755) if directory else (0o600 if info.st_mode&stat.S_IWRITE else 0o400)
 if path.name=='chrome':mode=0o755
 if path.name=='chrome-sandbox':mode=0o4755
 if path.name=='browser-selection.json':mode=0o644
 if path.name=='mu-network-lease':mode=0o700
 kind=stat.S_IFMT(info.st_mode)
 if getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',1024):kind=stat.S_IFLNK
 values.update(st_mode=kind|mode,st_uid=1000 if dev else 0,st_gid=1000 if dev else 0)
 if relative.startswith('home/dev/.local/share/mucodesandbox') and (physical/'different-profile-device').exists():values['st_dev']+=1
 if path.name=='reserve.bin' and not directory and info.st_size==16:
  raw=path.read_bytes()
  if raw[:8]==b'RESERVE\0':values['st_size']=struct.unpack('>Q',raw[8:])[0]
 return types.SimpleNamespace(**values)
FLAGS=0xf00000
def resolve(path,dir_fd=None):
 if dir_fd is not None:return dirs[dir_fd]/str(path)
 value=FilePath(path)
 return value if value.is_absolute() else FilePath(virtual_cwd[0])/value
def opening(path,flags,mode=0o777,dir_fd=None):
 path=resolve(path,dir_fd)
 if native.path.lexists(str(path)) and stat.S_ISLNK(path.lstat().st_mode):raise OSError('No-follow adapter rejects a link')
 if flags&0x400000:
  if not path.exists():raise FileNotFoundError(str(path))
  if not stat.S_ISDIR(path.lstat().st_mode):raise NotADirectoryError(str(path))
  fd=next_dir[0];next_dir[0]+=1;dirs[fd]=path;return fd
 fd=native.open(str(path),(flags&~FLAGS)|getattr(native,'O_BINARY',0),mode);files[fd]=path;return fd
def closing(fd):
 if fd in dirs:dirs.pop(fd)
 else:files.pop(fd,None);native.close(fd)
def fstat(fd):return metadata(dirs[fd]) if fd in dirs else metadata(files[fd],fd)
def fsync(fd):
 if fd in dirs:return
 try:native.fsync(fd)
 except OSError as error:
  if native.name!='nt' or error.errno!=9:raise
def fchmod(fd,mode):native.chmod(str(files[fd]),mode)
def named(name,dir_fd=None,follow_symlinks=True):
 assert not follow_symlinks;return resolve(name,dir_fd).lstat()
def mkdir(name,mode=0o777,dir_fd=None):return native.mkdir(str(resolve(name,dir_fd)),mode)
def duplicate(fd):
 if fd in dirs:value=next_dir[0];next_dir[0]+=1;dirs[value]=dirs[fd];return value
 value=native.dup(fd);files[value]=files[fd];return value
def writing(fd,raw):
 value=native.write(fd,raw)
 if fd in files and '/restore/' in role(files[fd]):step('restore-file-prefix')
 if fd in files and files[fd].name.startswith('.trial-preferences-'):step('preferences-file-prefix')
 return value
def reserve(fd,offset,length):
 if (physical/'reserve-fails').exists():raise OSError(28,'Synthetic rollback reserve full')
 assert offset==0;native.ftruncate(fd,16);native.lseek(fd,0,native.SEEK_SET);native.write(fd,b'RESERVE\0'+struct.pack('>Q',length))
def fchmod_time(fd,ns):native.utime(str(files[fd]),ns=ns)
def api(dev=False):
 values={name:getattr(native,name) for name in dir(native) if not name.startswith('__')};values.update(O_NOFOLLOW=0x200000,O_DIRECTORY=0x400000,O_CLOEXEC=0x100000,O_NONBLOCK=0x800000,open=opening,close=closing,fstat=fstat,stat=named,fsync=fsync,fchmod=fchmod,chown=lambda *a:None,posix_fallocate=reserve,geteuid=lambda:0,getuid=lambda:1000 if dev else 0,getgid=lambda:1000,dup=duplicate,mkdir=mkdir,write=writing,utime=fchmod_time,listdir=lambda fd:native.listdir(str(dirs[fd])) if isinstance(fd,int) else native.listdir(fd),fchdir=lambda fd:virtual_cwd.__setitem__(0,dirs[fd]),getppid=lambda:native.getpid())
 return types.SimpleNamespace(**values)
class Lock:
 LOCK_EX=1;LOCK_NB=2
 @staticmethod
 def flock(fd,mode):
  if native.name=='nt':
   import msvcrt
   msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
  else:
   import fcntl
   fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
def data_tar():
 output=io.BytesIO()
 with tarfile.open(fileobj=output,mode='w') as archive:
  for name,data in [('chrome',b'approved candidate binary'),('chrome-sandbox',b'approved sandbox helper'),('resources/a.pak',b'candidate resource')]:
   item=tarfile.TarInfo('opt/google/chrome/'+name);item.mode=0o755;item.size=len(data);archive.addfile(item,io.BytesIO(data))
 return output.getvalue()
DATA=data_tar();base='155.0.8059.84';candidate='156.0.8078.47'
expected=dict(version=candidate,packageVersion=candidate+'-1',architecture='amd64',bytes=len(DATA),sha256=hashlib.sha256(DATA).hexdigest(),binarySha256=hashlib.sha256(b'approved candidate binary').hexdigest(),sandboxSha256=hashlib.sha256(b'approved sandbox helper').hexdigest())
prior=dict(version=base,packageVersion=base+'-1',architecture='amd64',bytes=100,sha256=hashlib.sha256(b'approved base archive').hexdigest())
class Decoder:
 def __init__(self):self.stdout=io.BytesIO(DATA);self.done=False
 def poll(self):return 0 if self.done else None
 def wait(self,timeout=None):self.done=True;return 0
 def kill(self):self.done=True
class Capture:
 def __init__(self,output):self.output=output
 def write(self,data):
  result=self.output.write(data);self.output.flush();step('checkpoint-file-prefix');return result
 def __getattr__(self,name):return getattr(self.output,name)
class Process:
 def __init__(self,args,**options):
  assert args[:3]==['/usr/bin/python3','-I','-c'];assert options['user']==1000 and options['group']==1000 and options['extra_groups']==[] and options['pass_fds']==(int(args[5]),)
  source=options['stdin'];output=io.BytesIO();kind=args[4];fake_sys=types.SimpleNamespace(argv=['worker',*args[4:]],stdin=types.SimpleNamespace(buffer=source),stdout=types.SimpleNamespace(buffer=Capture(output) if kind=='capture' else output));worker_os=api(True)
  def importing(name,*a,**kw):
   if name=='os':return worker_os
   if name=='sys':return fake_sys
   if name=='ctypes':return types.SimpleNamespace(CDLL=lambda *a,**k:types.SimpleNamespace(prctl=lambda *a:0))
   if name=='signal':return types.SimpleNamespace(SIGKILL=9)
   return __import__(name,*a,**kw)
  import builtins
  safe=dict(vars(builtins));safe['__import__']=importing;worker=dict(__builtins__=safe,print=lambda value:output.write((str(value)+'\n').encode()))
  saved=virtual_cwd[0];self.code=0
  try:exec(compile(args[3],'<private-worker>','exec'),worker)
  except Exception as error:self.code=1;namespace['workerError']=str(error)
  finally:virtual_cwd[0]=saved
  self.stdout=tempfile.TemporaryFile();self.stdout.write(output.getvalue());self.stdout.seek(0);self.done=True
 def wait(self,timeout=None):return self.code
 def poll(self):return self.code
 def kill(self):self.done=True
def checked(args,text=False,timeout=None):
 if args in [['/usr/bin/dpkg','--print-architecture'],['dpkg','--print-architecture']]:return 'amd64\n'
 if args[:2]==['/usr/bin/dpkg-deb','-f']:return ('amd64' if args[-1]=='Architecture' else candidate+'-1')+'\n'
 if len(args)==2 and args[1]=='status' and str(args[0]).endswith('mu-network-lease'):
  control=json.loads((physical/'lease-fixture.json').read_text());return json.dumps(control).encode()
 raise AssertionError(args)
def popen(args,**options):
 if args[:2]==['/usr/bin/dpkg-deb','--fsys-tarfile']:return Decoder()
 return Process(args,**options)

def running(args,**options):
 assert args==['/usr/bin/sync'] and options==dict(check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if (physical/'sync-fails').exists():raise RuntimeError('Synthetic sync refused')
 step('sync-finished');return types.SimpleNamespace(returncode=0)

def preferences(descriptor=None,locale='zh-TW'):
 # Actual unmodified private program; only Linux uid/dirfd/prctl/renameat2
 # primitives are adapted. Every profile byte and rename is on the host.
 fd=descriptor if descriptor is not None else opening(FilePath('/home/dev/.local/share/mucodesandbox/browser'),0x400000)
 output=[];worker_os=api(True);worker_os.unlink=lambda name,dir_fd=None:native.unlink(str(resolve(name,dir_fd)))
 def renameat2(source,name,destination,target,flags):
  assert source==destination and flags==1
  first=resolve(native.fsdecode(name),source);last=resolve(native.fsdecode(target),destination)
  if (physical/'inject-preferences-destination').exists() and last.name=='Preferences':last.write_bytes(b'foreign preferences destination')
  if native.path.lexists(str(last)):return -1
  exclusive_rename(first,last)
  step('preferences-published' if last.name=='Preferences' else 'preferences-prior-retained');return 0
 fake_sys=types.SimpleNamespace(argv=['preferences',str(fd),str(native.getpid()),str(fstat(fd).st_dev),str(fstat(fd).st_ino),locale])
 def importing(name,*a,**kw):
  if name=='os':return worker_os
  if name=='sys':return fake_sys
  if name=='ctypes':return types.SimpleNamespace(CDLL=lambda *a,**k:types.SimpleNamespace(prctl=lambda *a:0,renameat2=renameat2))
  if name=='signal':return types.SimpleNamespace(SIGKILL=9)
  return __import__(name,*a,**kw)
 import builtins
 safe=dict(vars(builtins));safe['__import__']=importing
 try:exec(compile((sources[0].parent/'trial-preferences.py').read_text(encoding='utf-8'),'<unchanged-trial-preferences>','exec'),dict(__builtins__=safe,print=lambda value:output.append(json.loads(value))))
 finally:
  if descriptor is None:closing(fd)
 assert output==[dict(prepared=True)];return output[0]

def root_launch(ns,epoch):
 programs=json.loads((sources[0].parent/'trial-programs.json').read_text(encoding='utf-8'));source=programs['launch'].replace(programs['epoch'],epoch)
 assert source.startswith(programs['prelude']);tail=source[len(programs['prelude']):]
 calls=[];privileges=dict(uid=(0,0,0),gid=(0,0,0),groups=[1]);answer={};lockfd=[]
 class Launched(BaseException):pass
 def inheritable(fd,value):assert value is False;native.set_inheritable(fd,value);lockfd.append(fd)
 def uid(*args):calls.append('uid');privileges['uid']=args
 def gid(*args):calls.append('gid');privileges['gid']=args
 def groups(value):calls.append('groups');privileges['groups']=value
 def chdir(path):assert path=='/home/dev';virtual_cwd[0]=FilePath(path)
 def execute(file,args,env):
  assert len(lockfd)==1 and not native.get_inheritable(lockfd[0]);assert calls==['preferences','groups','gid','uid']
  assert privileges==dict(uid=(1000,)*3,gid=(1000,)*3,groups=[]);assert file=='/usr/bin/dbus-run-session' and args[:2]==[file,'--'];assert args[-1]=='about:blank'
  assert '--user-data-dir=/home/dev/.local/share/mucodesandbox/browser' in args and '/chrome-'+candidate+'/chrome' in args[2]
  assert env['HOME']=='/home/dev' and env['TZ']=='UTC' and env['LANG']=='zh_TW.UTF-8' and env['CHROME_DEVEL_SANDBOX'].endswith('/chrome-'+candidate+'/chrome-sandbox')
  answer.update(launched=True,droppedAllIds=True,lockCloexec=True,blankPage=True,actualGeneratedGate=True);raise Launched()
 def trial_run(args,**options):
  assert args[:3]==['/usr/bin/python3','-I','-c'] and args[3]==(sources[0].parent/'trial-preferences.py').read_text(encoding='utf-8')
  fd=int(args[4]);assert args[5]==str(native.getpid()) and args[6:8]==[str(fstat(fd).st_dev),str(fstat(fd).st_ino)] and args[8]=='zh-TW'
  assert options['user']==1000 and options['group']==1000 and options['extra_groups']==[] and options['pass_fds']==(fd,) and options['stdin']==subprocess.DEVNULL and options['capture_output'] is True
  if (physical/'preferences-fails').exists():return types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'')
  preferences(fd,'zh-TW');calls.append('preferences');return types.SimpleNamespace(returncode=0,stdout=b'{"prepared":true}',stderr=b'')
 ns['os'].set_inheritable=inheritable;ns['os'].setgroups=groups;ns['os'].setresgid=gid;ns['os'].setresuid=uid;ns['os'].getresuid=lambda:privileges['uid'];ns['os'].getresgid=lambda:privileges['gid'];ns['os'].getgroups=lambda:privileges['groups'];ns['os'].chdir=chdir;ns['os'].execve=execute;ns['subprocess'].run=trial_run
 try:exec(compile(tail,'<unchanged-generated-launch-gate>','exec'),ns)
 except Launched:return answer
 raise AssertionError('Candidate root gate did not exec')

def service_adapter(ns,epoch):
 unit='mucodesandbox-browser-trial-'+epoch+'.service';stopped=[]
 def property(unit_name,key):
  if unit_name==unit:
   if (physical/'trial-absent').exists():return 'not-found' if key=='LoadState' else ''
   return dict(LoadState='loaded',Transient='no' if (physical/'trial-persistent').exists() else 'yes',Description='foreign service' if (physical/'trial-foreign').exists() else 'MuCodeSandbox Windows candidate trial '+epoch,ActiveState='inactive' if unit in stopped else 'active')[key]
  assert unit_name=='mucodesandbox-display.service'
  return dict(LoadState='loaded',Description='foreign display' if (physical/'display-foreign').exists() else 'MuCodeSandbox Windows guest display',ActiveState='inactive' if unit_name in stopped else 'active')[key]
 def output(args,**options):
  if args[:2]==['/usr/bin/systemctl','show']:
   assert len(args)==5 and args[3]=='--value';return property(args[4],args[2].split('=',1)[1])+'\n'
  return checked(args,**options)
 def run_service(args,**options):
  if args==['systemctl','show','--property=LoadState','--value','mucodesandbox-browser.service']:return types.SimpleNamespace(returncode=4,stdout='not-found\n')
  assert args[:2]==['/usr/bin/systemctl','stop'] and len(args)==3 and args[2] in [unit,'mucodesandbox-display.service'];stopped.append(args[2]);return types.SimpleNamespace(returncode=0)
 ns['subprocess'].check_output=output;ns['subprocess'].run=run_service;return stopped

def root_stop(ns,epoch):
 programs=json.loads((sources[0].parent/'trial-programs.json').read_text(encoding='utf-8'));_,data=ns['adoption_load']();binding=ns['adoption_binding'](data);source=programs['stop'].replace(programs['epoch'],epoch).replace(programs['binding'],binding)
 if (physical/'wrong-binding').exists():source=source.replace(binding,'0'*64)
 assert source.startswith(programs['prelude']);stopped=service_adapter(ns,epoch);answers=[];ns['print']=lambda value:answers.append(json.loads(value));exec(compile(source[len(programs['prelude']):],'<unchanged-root-stop>','exec'),ns)
 assert answers==[dict(version=1,epoch=epoch,browserStopped=True,displayStopped=True)]
 assert stopped==(['mucodesandbox-display.service'] if (physical/'trial-absent').exists() else ['mucodesandbox-browser-trial-'+epoch+'.service','mucodesandbox-display.service']);return answers[0]
def move(source,name,destination,target,identity):
 first=dirs[source]/name;last=dirs[destination]/target
 assert namespace['repair_identity'](first.lstat())==identity
 if native.path.lexists(str(last)):raise FileExistsError(str(last))
 exclusive_rename(first,last,tuple(int(value) for value in identity));assert namespace['repair_identity'](last.lstat())==identity
def setup_namespace():
 global namespace
 root=FilePath('/opt/mucodesandbox/windows');state=FilePath('/var/lib/mucodesandbox');lease=sources[5].read_bytes()
 namespace=dict(os=api(),sys=sys,pathlib=types.SimpleNamespace(Path=FilePath,PurePosixPath=pathlib.PurePosixPath),hashlib=hashlib,subprocess=types.SimpleNamespace(check_output=checked,Popen=popen,run=running,PIPE=subprocess.PIPE,DEVNULL=subprocess.DEVNULL),tarfile=tarfile,shutil=__import__('shutil'),stat=stat,json=json,struct=struct,re=__import__('re'),uuid=uuid,contextlib=contextlib,ctypes=ctypes,fcntl=Lock,pwd=None,select=types.SimpleNamespace(select=lambda objects,*a:(objects,[],[])),time=time,ROOT=root,STATE=state,TARGET=root/('chrome-'+candidate),ACTIVE=root/('.browser-candidate-'+candidate),EXPECTED=expected,BASE=base,CANDIDATE=candidate,RELEASES={base:prior,candidate:expected},ACCOUNT=types.SimpleNamespace(pw_uid=1000,pw_gid=1000),REPAIR_LABEL='.browser-candidate-'+candidate,REPAIR_RETAINED='.browser-candidate-'+candidate+'-retained',REPAIR_NEW_ONLY=True,REPAIR_KEEP_ARCHIVE=True,REPAIR_STOP_BROWSER=False,REPAIR_ADOPTION_OWNER=True,LEASE_HELPER_SHA=hashlib.sha256(lease).hexdigest(),PROFILE_WORKER=sources[4].read_text(encoding='utf-8'))
 for file in sources[:4]:exec(compile(file.read_text(encoding='utf-8'),str(file),'exec'),namespace)
 namespace['adoption_step']=step;namespace['repair_step']=lambda name:None;namespace['repair_sync']=lambda path:None;namespace['adoption_move']=move
 def rename(source,target):
  if native.path.lexists(str(target)):raise FileExistsError(str(target))
  exclusive_rename(source,target)
 namespace['repair_rename']=rename
 stops=[]
 def stop():
  if (physical/'stop-fails').exists():raise RuntimeError('Synthetic service stop refused')
  stops.append(True)
 namespace['actual_windows_stop_browser']=namespace['windows_stop_browser'];namespace['windows_stop_browser']=stop;return namespace,stops
def seed(ns):
 physical.mkdir(parents=True,exist_ok=True)
 for value in ['/opt/mucodesandbox/windows','/var/lib/mucodesandbox','/home/dev/.local/share/mucodesandbox/browser/Default','/run/mucodesandbox-lease','/usr/local/libexec']:FilePath(value).mkdir(parents=True,exist_ok=True)
 (physical/'lease-fixture.json').write_text(json.dumps(dict(active=True,remainingMs=45000)))
 FilePath('/run/mucodesandbox-lease/state').write_text(json.dumps(dict(session='11111111-1111-4111-8111-111111111111',boot='22222222-2222-4222-8222-222222222222',state='active',deadline=12345)))
 FilePath('/usr/local/libexec/mu-network-lease').write_bytes(sources[5].read_bytes())
 old=FilePath('/opt/mucodesandbox/windows')/('chrome-'+base);old.mkdir();(old/'chrome').write_bytes(b'approved original binary');(old/'chrome-sandbox').write_bytes(b'approved original sandbox');(old/'.mu-component.json').write_bytes(ns['component_record'](prior,hashlib.sha256(b'approved original binary').hexdigest()))
 assert ns['repair_windows_browser'](io.BytesIO(DATA),True)['state']=='repaired'
 profile=FilePath('/home/dev/.local/share/mucodesandbox/browser');(profile/'Last Version').write_text(base+'\n');(profile/'Default/Local Storage').write_bytes(b'original localStorage');(profile/'Default/IndexedDB').write_bytes(b'original IDB');(profile/'read-only').write_bytes(b'original readonly content');native.chmod(str(profile/'read-only'),0o400)
 with sqlite3.connect(str(profile/'Default/Cookies')) as database:database.execute('CREATE TABLE cookies(value TEXT)');database.execute("INSERT INTO cookies VALUES ('synthetic-original-cookie')")
 (physical/'project.txt').write_bytes(b'original project outside profile')
if worker_mode:
 ns,stops=setup_namespace();action=sys.argv[9];epoch=None if sys.argv[10]=='-' else sys.argv[10]
 try:
  if action=='setup':seed(ns);answer=dict(setup=True)
  elif action=='status':answer=ns['adoption_status']()
  elif action=='consume-profile':
   def importing(name,*a,**kw):return api(True) if name=='os' else __import__(name,*a,**kw)
   import builtins
   safe=dict(vars(builtins));safe['__import__']=importing;answers=[];consumer=dict(__builtins__=safe,print=lambda value:answers.append(value));program=(sources[0].parent/'selected-profile.py').read_text(encoding='utf-8');boundary='\nprint(json.dumps(mu_profile_inspect(),sort_keys=True))\n';assert program.endswith(boundary);exec(compile(program[:-len(boundary)],'<unchanged-profile-consumer>','exec'),consumer)
   # Kernel fixtures use synthetic DEB recipes. Adapt only that catalog after
   # loading the unchanged reader; its algorithms and actual files stay intact.
   consumer['MU_SELECTION_RELEASES']={base:prior['sha256'],candidate:expected['sha256']};exec(compile(boundary,'<unchanged-profile-entry>','exec'),consumer);assert len(answers)==1;answer=json.loads(answers[0])
  elif action=='root-launch':answer=root_launch(ns,epoch)
  elif action=='root-stop':answer=root_stop(ns,epoch)
  elif action=='stop-registry':
   stopped=service_adapter(ns,epoch);ns['actual_windows_stop_browser']();answer=dict(stopped=stopped)
  else:
   with ns['repair_lock']():
    if action=='unowned-repair':ns['REPAIR_ADOPTION_OWNER']=False;ns['repair_preflight']();answer={}
    elif action=='base-repair-preflight':ns.update(REPAIR_ADOPTION_OWNER=False,REPAIR_NEW_ONLY=False,EXPECTED=prior);ns['repair_preflight']();answer={}
    elif action=='reset-preflight':
     ns.update(JOURNAL=FilePath('/var/lib/mucodesandbox/browser-install-transaction.json'),UPGRADE=FilePath('/var/lib/mucodesandbox/browser-upgrade.json'),PRIVATE=FilePath('/var/lib/mucodesandbox/browser-upgrade'),read_controlled=lambda path:None);ns['windows_reset_preflight']();answer={}
    elif action=='lock':step('lock-held');answer={}
    elif action=='preferences':answer=preferences()
    elif action in ['trial-receipt','trial-receipt-full']:answer=ns['adoption_trial_receipt'](epoch,action=='trial-receipt-full')
    elif action=='launch-gate':ns['adoption_require_trial'](epoch,True,True);answer={}
    elif action=='stop-fence':
     _,data=ns['adoption_load']();ns['adoption_stop_fence'](data);answer=dict(stopped=True)
    elif action in ['bound-commit','wrong-binding-commit','unfenced-bound-commit']:
     binding=ns['adoption_trial_receipt'](epoch)['binding'] if action=='bound-commit' else '0'*64
     if action=='unfenced-bound-commit':binding=ns['adoption_trial_receipt'](epoch)['binding']
     if action=='bound-commit':
      _,data=ns['adoption_load']();ns['adoption_stop_fence'](data)
     answer=ns['adoption_commit_bound'](epoch,binding)
    else:answer=ns['adoption_begin']() if action=='begin' else ns['adoption_trial'](epoch) if action=='trial' else ns['adoption_commit'](epoch) if action=='commit' else ns['adoption_recover'](epoch)
  assert not dirs and not files,(dirs,files);print(json.dumps(dict(ok=True,answer=answer,stops=len(stops))),flush=True)
 except Exception as error:
  assert not dirs and not files,(dirs,files)
  print(json.dumps(dict(ok=False,error=type(error).__name__,message=str(error),workerError=ns.get('workerError'),trace=traceback.format_exc())),flush=True);raise SystemExit(2)
 raise SystemExit(0)

# Each operation reopens the production authority on real host files. Linux
# primitives above remain explicit adapters; process death below is real.
import queue,threading
results=[];kills=0
def run(root,action,epoch=None,fault='-',occurrence=1):
 global kills
 command=[sys.executable,'-I',__file__,'worker',*[str(p) for p in sources],str(root),action,epoch or '-',fault,str(occurrence)]
 process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 if fault!='-':
  lines=queue.Queue()
  def reader():
   for line in process.stdout:lines.put(line)
   lines.put(None)
  thread=threading.Thread(target=reader,daemon=True);thread.start();observed=[]
  try:
   deadline=time.monotonic()+30
   while True:
    line=lines.get(timeout=max(.01,deadline-time.monotonic()));observed.append(line)
    if line is None:raise AssertionError((action,fault,observed,process.stderr.read()))
    if line.strip()=='FAULT_READY':break
   process.kill();process.wait(timeout=10);kills+=1;thread.join(timeout=5);assert not thread.is_alive()
   return None
  finally:
   if process.poll() is None:process.kill();process.wait(timeout=10)
   process.stdout.close();process.stderr.close()
 stdout,stderr=process.communicate(timeout=30)
 assert not stderr,(action,stderr)
 lines=stdout.strip().splitlines();assert len(lines)==1,(action,stdout)
 answer=json.loads(lines[0]);answer['exit']=process.returncode;return answer
def ok(root,action,epoch=None):
 answer=run(root,action,epoch);assert answer['ok'] is True,(action,answer);assert answer['exit']==0;return answer['answer']
def profile(root):return root/'home/dev/.local/share/mucodesandbox/browser'
def components(root):return root/'opt/mucodesandbox/windows'
def snapshot(folder,excluded=()):return {str(p.relative_to(folder)).replace(native.sep,'/'):(hashlib.sha256(p.read_bytes()).hexdigest(),bool(p.stat().st_mode&stat.S_IWRITE)) for p in folder.rglob('*') if p.is_file() and str(p.relative_to(folder)).replace(native.sep,'/') not in excluded}
def fixture(name):
 root=physical/name;ok(root,'setup');return root,snapshot(profile(root))
def changed(root):
 folder=profile(root);(folder/'Last Version').write_text(candidate+'\n');(folder/'Default/Local Storage').write_bytes(b'new trial localStorage');(folder/'Default/IndexedDB').write_bytes(b'new trial IDB');(folder/'trial-only').write_bytes(b'new data preserved if committed or quarantined')
 with sqlite3.connect(str(folder/'Default/Cookies')) as database:database.execute("UPDATE cookies SET value='synthetic-trial-cookie'")
 return snapshot(folder)
def old(root,before,epoch):
 assert snapshot(profile(root))==before
 with sqlite3.connect(str(profile(root)/'Default/Cookies')) as database:assert database.execute('SELECT value FROM cookies').fetchone()==('synthetic-original-cookie',)
 assert not (components(root)/'.browser-adoption').exists()
 assert (root/'project.txt').read_bytes()==b'original project outside profile'
 status=ok(root,'status');assert status['selectedVersion']==base and status['pending'] is None
 if epoch:assert any(p['epoch']==epoch and p['privateDataMayRemain'] for p in status['retained'])
def new(root,before):
 assert snapshot(profile(root))==before;status=ok(root,'status');assert status['selectedVersion']==candidate and status['pending'] is None
 assert (root/'project.txt').read_bytes()==b'original project outside profile'
def passed(name,**values):results.append(dict(case=name,passed=True,**values))
if (sources[0].parent/'trial-programs.json').exists():
 root,before=fixture('root-launch');epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);assert ok(root,'root-launch',epoch)==dict(launched=True,droppedAllIds=True,lockCloexec=True,blankPage=True,actualGeneratedGate=True);ok(root,'recover',epoch);old(root,before,epoch);passed('actual-generated-root-launch-drops-all-ids-under-checkpoint-lock')
 for mutation in ['wrong-epoch','ready-phase','expired-lease','changed-session','changed-profile','changed-candidate','changed-archive','preferences-failed']:
  root,before=fixture('root-launch-'+mutation);epoch=ok(root,'begin')['epoch']
  if mutation!='ready-phase':ok(root,'trial',epoch)
  if mutation=='wrong-epoch':epoch='f'*32
  elif mutation=='expired-lease':(root/'lease-fixture.json').write_text(json.dumps(dict(active=False,remainingMs=0)))
  elif mutation=='changed-session':(root/'run/mucodesandbox-lease/state').write_text(json.dumps(dict(session='33333333-3333-4333-8333-333333333333',boot='22222222-2222-4222-8222-222222222222',state='active',deadline=12345)))
  elif mutation=='changed-profile':native.rename(profile(root),root/'original-profile');profile(root).mkdir();(profile(root)/'foreign').write_bytes(b'foreign profile')
  elif mutation=='changed-candidate':(components(root)/('chrome-'+candidate)/'chrome').write_bytes(b'unknown executable')
  elif mutation=='changed-archive':(components(root)/'.browser-adoption/profile.tar').write_bytes(b'unknown archive')
  elif mutation=='preferences-failed':(root/'preferences-fails').touch()
  tree=snapshot(root);answer=run(root,'root-launch',epoch);assert not answer['ok'],(mutation,answer);assert snapshot(root)==tree;passed('root-launch-refuses-'+mutation,execRefused=True,originalBytesPreserved=True)
 for mutation in ['normal','absent','expired-lease','wrong-binding','wrong-boot','persistent','foreign','foreign-display']:
  root,before=fixture('root-stop-'+mutation);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);boot=root/'proc/sys/kernel/random';boot.mkdir(parents=True);(boot/'boot_id').write_text('22222222-2222-4222-8222-222222222222\n')
  if mutation=='absent':(root/'trial-absent').touch()
  elif mutation=='expired-lease':(root/'lease-fixture.json').write_text(json.dumps(dict(active=False,remainingMs=0)))
  elif mutation=='wrong-binding':(root/'wrong-binding').touch()
  elif mutation=='wrong-boot':(boot/'boot_id').write_text('33333333-3333-4333-8333-333333333333')
  elif mutation=='persistent':(root/'trial-persistent').touch()
  elif mutation=='foreign':(root/'trial-foreign').touch()
  elif mutation=='foreign-display':(root/'display-foreign').touch()
  # The root stop intentionally needs the original boot and checkpoint,
  # but must still run when the network lease is already expired.
  tree=snapshot(root);answer=run(root,'root-stop',epoch);expected=mutation in ['normal','absent','expired-lease'];assert answer['ok']==expected,(mutation,answer);assert snapshot(root,('opt/mucodesandbox/windows/.browser-adoption/trial-stop',))==tree;passed('root-stop-'+mutation,refused=not expected,profileBytesPreserved=True)
  if mutation=='normal':
   stopped_tree=snapshot(root);late=run(root,'root-launch',epoch);assert not late['ok'] and 'durably revoked' in late['message'];assert snapshot(root)==stopped_tree;passed('stopped-trial-refuses-late-generated-launch-before-any-profile-write')
 for mutation in ['normal','unrelated','hardlink','foreign','persistent','directory','too-many']:
  root,before=fixture('stop-registry-'+mutation);epoch='a'*32;registry=root/'run/systemd/transient';registry.mkdir(parents=True);unit=registry/('mucodesandbox-browser-trial-'+epoch+'.service');unit.write_bytes(b'synthetic transient unit');(root/'proc').mkdir()
  if mutation=='unrelated':(registry/'unrelated.service').write_bytes(b'foreign service')
  elif mutation=='hardlink':native.link(unit,root/'unit-link')
  elif mutation=='foreign':(root/'trial-foreign').touch()
  elif mutation=='persistent':(root/'trial-persistent').touch()
  elif mutation=='directory':unit.unlink();unit.mkdir()
  elif mutation=='too-many':
   for value in range(33):(registry/('mucodesandbox-browser-trial-'+format(value,'032x')+'.service')).write_bytes(b'synthetic')
  tree=snapshot(root);answer=run(root,'stop-registry',epoch);expected=mutation in ['normal','unrelated'];assert answer['ok']==expected,(mutation,answer);assert snapshot(root)==tree
  if expected:assert answer['answer']['stopped']==[unit.name]
  passed('actual-service-registry-'+mutation,refused=not expected,unknownFilesPreserved=True)
 print(json.dumps(dict(complete=True,checks=results,actualHostFiles=True,actualWorker=True,actualGeneratedGate=True,linuxUidModeDirfdPrctlRenameat2AndExecAdapters=True,realLinux=False,realVm=False,browserExecuted=False)));raise SystemExit(0)
if (sources[0].parent/'trial-preferences.py').exists():
 for mode in ['existing','absent','default-absent']:
  root,before=fixture('preferences-'+mode);folder=profile(root)
  original=dict(untouched=dict(marker='original synthetic preference'),session=dict(restore_on_startup=1,startup_urls=['https://example.invalid/synthetic']))
  if mode=='existing':(folder/'Default/Preferences').write_text(json.dumps(original))
  elif mode=='default-absent':
   # Move synthetic seeded data intact outside the trial profile, so the
   # actual child exercises creating an absent Default from scratch.
   native.rename(folder/'Default',root/'saved-default')
  unchanged=snapshot(folder);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);answer=ok(root,'preferences',epoch);assert answer['prepared']
  value=json.loads((folder/'Default/Preferences').read_bytes());assert value['session']['restore_on_startup']==5 and value['intl']['accept_languages']=='zh-TW,zh' and value['translate']['enabled'] is False and value['download']['default_directory']=='/home/dev/Downloads'
  if mode=='existing':assert value['untouched']==original['untouched'] and value['session']['startup_urls']==original['session']['startup_urls']
  assert not list((folder/'Default').glob('.trial-preferences-*'));assert (root/'home/dev/Downloads').is_dir()
  for name,content in unchanged.items():
   if name!='Default/Preferences':assert snapshot(folder)[name]==content
  ok(root,'recover',epoch)
  if mode=='default-absent':
   assert snapshot(folder)==unchanged;assert not (folder/'Default').exists();assert ok(root,'status')['selectedVersion']==base
   with sqlite3.connect(str(root/'saved-default/Cookies')) as database:assert database.execute('SELECT value FROM cookies').fetchone()==('synthetic-original-cookie',)
  else:old(root,unchanged,epoch)
  passed('preferences-'+mode,actualWorker=True,compatibleRollback=True)
 for mutation in ['malformed','duplicates','namespace-scalar','top-array','hardlink','oversize','default-file','downloads-file','foreign-destination']:
  root,before=fixture('preferences-'+mutation);folder=profile(root);pref=folder/'Default/Preferences';pref.write_text('{"keep":"original"}');epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch)
  if mutation=='malformed':pref.write_bytes(b'{')
  elif mutation=='duplicates':pref.write_bytes(b'{"session":{},"session":{}}')
  elif mutation=='namespace-scalar':pref.write_bytes(b'{"intl":false}')
  elif mutation=='top-array':pref.write_bytes(b'[]')
  elif mutation=='hardlink':native.link(pref,root/'preferences-link')
  elif mutation=='oversize':pref.write_bytes(b' '*(16777217))
  elif mutation=='default-file':native.rename(folder/'Default',folder/'Default-original');(folder/'Default').write_bytes(b'foreign default')
  elif mutation=='downloads-file':(root/'home/dev/Downloads').write_bytes(b'foreign downloads')
  elif mutation=='foreign-destination':(root/'inject-preferences-destination').touch()
  protected=snapshot(folder);answer=run(root,'preferences',epoch);assert not answer['ok'],(mutation,answer)
  if mutation=='foreign-destination':assert pref.read_bytes()==b'foreign preferences destination'
  else:assert snapshot(folder)==protected
  # The checkpoint predates these faults. Recovery preserves the failed
  # trial separately and reinstates the original compatible bytes.
  ok(root,'recover',epoch);assert snapshot(folder)=={**before,'Default/Preferences':(hashlib.sha256(b'{"keep":"original"}').hexdigest(),True)}
  passed('preferences-refuses-'+mutation,actualWorker=True,unknownBytesPreserved=True,compatibleRollback=True)
 for point in ['preferences-file-prefix','preferences-prior-retained','preferences-published']:
  root,before=fixture(point);folder=profile(root);(folder/'Default/Preferences').write_bytes(b'{"keep":"old"}');before=snapshot(folder);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);run(root,'preferences',epoch,point);ok(root,'recover',epoch);old(root,before,epoch);passed(point,realKilledProcess=True,actualWorker=True,compatibleRollback=True)
 print(json.dumps(dict(complete=True,checks=results,realProcessKills=kills,actualHostFiles=True,actualWorker=True,linuxUidModeDirfdPrctlRenameat2Adapters=True,realLinux=False,realVm=False,browserExecuted=False)));raise SystemExit(0)
root,before=fixture('rollback');times={str(p.relative_to(profile(root))):p.stat().st_mtime_ns for p in profile(root).rglob('*') if p.is_file()};epoch=ok(root,'begin')['epoch'];assert ok(root,'status')['pending']['phase']=='ready';ok(root,'trial',epoch);trial=changed(root);answer=ok(root,'recover',epoch);assert answer['state']=='restored' and answer['cleanupWarning'];old(root,before,epoch);assert snapshot(components(root)/('.browser-adoption-done-'+epoch)/'failed-profile')==trial;assert {str(p.relative_to(profile(root))):p.stat().st_mtime_ns for p in profile(root).rglob('*') if p.is_file()}==times
assert ok(root,'recover',epoch)['decision']=='restored';old(root,before,epoch);passed('trial-failure-restores-cookie-local-storage-and-readonly-files')
root,before=fixture('commit');epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);assert ok(root,'commit',epoch)['state']=='committed';new(root,trial);assert ok(root,'recover',epoch)['decision']=='committed';new(root,trial);passed('committed-data-survives-cleanup-reopen')
for name,point,occurrence in [('checkpoint-initial-frame','journal-half-written',1),('checkpoint-initialized','initialization-durable',1),('checkpoint-published','active-published',1),('checkpoint-prefix','checkpoint-file-prefix',1),('checkpoint-ready-frame','journal-half-written',2),('checkpoint-ready','checkpoint-ready',1)]:
 root,before=fixture(name);run(root,'begin',fault=point,occurrence=occurrence);status=ok(root,'status');epoch=status['pending']['epoch'] if status['pending'] else None
 if epoch:assert ok(root,'recover',epoch)['state']=='aborted'
 old(root,before,None);passed(name,realKilledProcess=True,freshProcessRecovery=True)
for name,point,occurrence in [('restore-prefix','restore-file-prefix',1),('restore-ready-frame','journal-half-written',2),('restore-ready','restore-ready',1),('original-retained','failed-profile-retained',1),('restore-published','restored-profile-published',1),('restore-final-frame','journal-half-written',3),('restore-durable','restore-durable',1),('restore-receipt','receipt-published',1),('restore-cleanup','checkpoint-removed',1)]:
 root,before=fixture(name);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);run(root,'recover',epoch,point,occurrence);answer=ok(root,'recover',epoch);assert answer.get('state') in ['restored','cleanup'];old(root,before,epoch);assert snapshot(components(root)/('.browser-adoption-done-'+epoch)/'failed-profile')==trial;passed(name,realKilledProcess=True,freshProcessRecovery=True)
for name,point,occurrence,committed in [('commit-half-frame','journal-half-written',1,False),('commit-durable','commit-durable',1,True),('commit-selection','selection-published',1,True),('commit-receipt','receipt-published',1,True),('commit-cleanup','checkpoint-removed',1,True)]:
 root,before=fixture(name);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);run(root,'commit',epoch,point,occurrence);ok(root,'recover',epoch)
 if committed:new(root,trial)
 else:old(root,before,epoch)
 passed(name,realKilledProcess=True,freshProcessRecovery=True,committedDecisionPreserved=committed)
root,before=fixture('explicit-prior-selection');selector=components(root)/'browser-selection.json';original=json.dumps(dict(schema=1,version=base,archiveSha256=prior['sha256'])).encode();selector.write_bytes(original);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);run(root,'commit',epoch,'prior-selection-retained');ok(root,'recover',epoch);new(root,trial);passed('prior-selector-two-rename-recovery',realKilledProcess=True)
for mutation in ['archive-changed','archive-replaced','archive-hardlink','profile-replaced','restore-replaced','restore-unknown','restore-prefix-changed','prior-binary','candidate-binary','selector-changed','journal-corrupt','journal-hardlink','stop-refused','foreign-profile-destination']:
 root,before=fixture(mutation);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);slot=components(root)/'.browser-adoption';retained=None
 if mutation=='archive-changed':(slot/'profile.tar').write_bytes(b'corrupted checkpoint')
 elif mutation=='archive-replaced':native.rename(slot/'profile.tar',root/'saved.tar');(slot/'profile.tar').write_bytes((root/'saved.tar').read_bytes())
 elif mutation=='archive-hardlink':native.link(slot/'profile.tar',root/'archive-link')
 elif mutation=='profile-replaced':native.rename(profile(root),root/'saved-profile');profile(root).mkdir();(profile(root)/'foreign').write_bytes(b'foreign profile')
 elif mutation=='restore-replaced':native.rename(slot/'restore',root/'saved-restore');(slot/'restore').mkdir()
 elif mutation=='restore-unknown':(slot/'restore/foreign').write_bytes(b'foreign restore data')
 elif mutation=='restore-prefix-changed':run(root,'recover',epoch,'restore-file-prefix');(slot/'restore/Default/Cookies').write_bytes(b'foreign partial bytes')
 elif mutation=='prior-binary':(components(root)/('chrome-'+base)/'chrome').write_bytes(b'changed old executable')
 elif mutation=='candidate-binary':
  (components(root)/('chrome-'+candidate)/'chrome').write_bytes(b'changed candidate executable')
 elif mutation=='selector-changed':(components(root)/'browser-selection.json').write_text('{}')
 elif mutation=='journal-corrupt':(slot/'journal.bin').write_bytes(b'x'*16384)
 elif mutation=='journal-hardlink':native.link(slot/'journal.bin',root/'journal-link')
 elif mutation=='stop-refused':(root/'stop-fails').touch()
 elif mutation=='foreign-profile-destination':
  run(root,'recover',epoch,'failed-profile-retained');profile(root).mkdir();(profile(root)/'foreign').write_bytes(b'foreign destination')
 protected=snapshot(profile(root));foreign={str(p):p.read_bytes() for p in [slot/'restore/foreign',slot/'restore/Default/Cookies',profile(root)/'foreign',slot/'profile.tar',root/'saved.tar'] if p.is_file()}
 operation='commit' if mutation=='candidate-binary' else 'recover';answer=run(root,operation,epoch);assert answer['ok'] is False and answer['exit']==2,(mutation,answer)
 assert snapshot(profile(root))==protected,(mutation,'profile changed')
 for name,raw in foreign.items():assert pathlib.Path(name).read_bytes()==raw,(mutation,name)
 assert (root/'project.txt').read_bytes()==b'original project outside profile';passed(mutation,refused=True,unknownBytesPreserved=True)
for name,change in [('lease-expired',lambda root:(root/'lease-fixture.json').write_text(json.dumps(dict(active=False,remainingMs=0)))),('lease-session-changed',lambda root:(root/'run/mucodesandbox-lease/state').write_text(json.dumps(dict(session='33333333-3333-4333-8333-333333333333',boot='22222222-2222-4222-8222-222222222222',state='active',deadline=12345))))]:
 root,before=fixture(name);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);change(root);answer=run(root,'commit',epoch);assert not answer['ok'];assert snapshot(profile(root))==trial;assert not (components(root)/'browser-selection.json').exists();ok(root,'recover',epoch);old(root,before,epoch);passed(name,commitRefused=True,compatibleRollback=True)
for name in ['version-missing','version-newer','reserve-full','stop-before-checkpoint']:
 root,before=fixture(name)
 if name=='version-missing':(profile(root)/'Last Version').unlink()
 elif name=='version-newer':(profile(root)/'Last Version').write_text('157.0.0.0')
 elif name=='reserve-full':(root/'reserve-fails').touch()
 elif name=='stop-before-checkpoint':(root/'stop-fails').touch()
 before=snapshot(profile(root));answer=run(root,'begin');assert not answer['ok'];assert snapshot(profile(root))==before
 (root/'stop-fails').unlink(missing_ok=True)
 pending=ok(root,'status')['pending']
 if pending:assert ok(root,'recover',pending['epoch'])['state']=='aborted'
 assert snapshot(profile(root))==before;passed(name,beginRefused=True,originalProfilePreserved=True)
root,before=fixture('stale-epoch');epoch=ok(root,'begin')['epoch'];tree=snapshot(root)
for action in ['trial','commit','recover']:
 answer=run(root,action,'f'*32);assert not answer['ok'];assert snapshot(root)==tree
ok(root,'recover',epoch);old(root,before,None);passed('stale-epoch-cannot-adopt-or-recover-another-transaction')
root,before=fixture('committed-unknown-cleanup');epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);run(root,'commit',epoch,'commit-durable');slot=components(root)/'.browser-adoption';(slot/'foreign').write_bytes(b'unknown retained private data');answer=ok(root,'recover',epoch);assert answer['cleanupWarning'];new(root,trial);done=components(root)/('.browser-adoption-done-'+epoch);assert (done/'foreign').read_bytes()==b'unknown retained private data';assert (done/'profile.tar').exists();answer=ok(root,'recover',epoch);assert answer['decision']=='committed' and answer['cleanupWarning'];new(root,trial);passed('committed-unknown-data-preserved-with-warning-never-rollback',realKilledProcess=True)
root,before=fixture('pending-fences');epoch=ok(root,'begin')['epoch'];tree=snapshot(root)
for action in ['unowned-repair','reset-preflight']:
 answer=run(root,action,epoch);assert not answer['ok'] and 'adoption' in answer['message'];assert snapshot(root)==tree
ok(root,'recover',epoch);old(root,before,None);passed('component-repair-and-profile-reset-refuse-pending-adoption')
root,before=fixture('retained-preparation-bound')
for value in ['a','b']:(components(root)/('.browser-adoption-prep-'+value*32)).mkdir()
status=ok(root,'status');assert len(status['retained'])==2 and all(not issue['trusted'] and issue['privateDataMayRemain'] for issue in status['retained']);tree=snapshot(root);answer=run(root,'begin');assert not answer['ok'] and 'review' in answer['message'];assert snapshot(root)==tree;passed('orphan-preparations-visible-and-retention-bounded')
root,before=fixture('actual-lock-contention');unlocked=snapshot(root);command=[sys.executable,'-I',__file__,'worker',*[str(p) for p in sources],str(root),'lock','-','lock-held','1'];holder=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);ready=queue.Queue();reader=threading.Thread(target=lambda:ready.put(holder.stdout.readline()),daemon=True);reader.start()
try:
 # Windows denies byte-range reads of the held lock itself. Compare every
 # other byte while held, then compare the complete tree after release.
 assert ready.get(timeout=10).strip()=='FAULT_READY';excluded=('var/lib/mucodesandbox/browser-install.lock',);tree=snapshot(root,excluded);answer=run(root,'begin');assert not answer['ok'] and answer['error'] in ['PermissionError','BlockingIOError'];assert snapshot(root,excluded)==tree;assert snapshot(profile(root))==before
finally:
 holder.kill();holder.wait(timeout=10);kills+=1;reader.join(timeout=5);holder.stdout.close();holder.stderr.close()
assert snapshot(root)==unlocked;epoch=ok(root,'begin')['epoch'];ok(root,'recover',epoch);old(root,before,None);passed('real-kernel-lock-refuses-overlapping-profile-operation',realKilledProcess=True)
root,before=fixture('committed-profile-consumer');epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);ok(root,'commit',epoch);new(root,trial);observed=ok(root,'consume-profile');assert observed['state']=='compatible' and observed['selectedVersion']==candidate and observed['recordedVersion']==candidate;tree=snapshot(root);answer=run(root,'base-repair-preflight');assert not answer['ok'] and 'downgrade' in answer['message'];assert snapshot(root)==tree;passed('committed-selector-consumed-by-unchanged-profile-reader-and-old-repair-refused')
root,before=fixture('rollback-profile-consumer');epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);changed(root);ok(root,'recover',epoch);old(root,before,epoch);observed=ok(root,'consume-profile');assert observed['state']=='compatible' and observed['selectedVersion']==base and observed['recordedVersion']==base;ok(root,'base-repair-preflight');passed('rolled-back-profile-consumed-by-unchanged-reader-and-original-repair-allowed')
root,before=fixture('cross-filesystem');(root/'different-profile-device').touch();tree=snapshot(root);answer=run(root,'begin');assert not answer['ok'] and 'one filesystem' in answer['message'];assert snapshot(root)==tree;assert not (components(root)/'.browser-adoption').exists();passed('cross-filesystem-refused-before-checkpoint-publication')
root,before=fixture('bound-acceptance');epoch=ok(root,'begin')['epoch'];tree=snapshot(root);answer=run(root,'trial-receipt',epoch);assert not answer['ok'];assert snapshot(root)==tree;ok(root,'trial',epoch)
receipt=ok(root,'trial-receipt-full',epoch);assert receipt['epoch']==epoch and receipt['priorVersion']==base and receipt['candidateVersion']==candidate and len(receipt['binding'])==64
assert receipt==ok(root,'trial-receipt',epoch);trial=changed(root);assert receipt==ok(root,'trial-receipt-full',epoch)
tree=snapshot(root)
for action,identity in [('trial-receipt','f'*32),('bound-commit','f'*32),('wrong-binding-commit',epoch)]:
 answer=run(root,action,identity);assert not answer['ok'];assert snapshot(root)==tree
assert ok(root,'bound-commit',epoch)['state']=='committed';new(root,trial);assert ok(root,'recover',epoch)['decision']=='committed';passed('bound-commit-requires-exact-trial-epoch-and-checkpoint-binding')
for mutation in ['old-version','newer-version','missing-version','empty-version','invalid-version','oversize-version','hardlinked-version','stop-refused','sync-refused','expired-lease','changed-session','changed-candidate','changed-archive']:
 root,before=fixture('bound-'+mutation);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);changed(root);last=profile(root)/'Last Version'
 if mutation=='old-version':last.write_text(base)
 elif mutation=='newer-version':last.write_text('157.0.0.0')
 elif mutation=='missing-version':last.unlink()
 elif mutation=='empty-version':last.write_bytes(b'')
 elif mutation=='invalid-version':last.write_bytes(b'156.0.8078.47\x00')
 elif mutation=='oversize-version':last.write_bytes(b'1'*257)
 elif mutation=='hardlinked-version':native.link(last,root/'last-version-link')
 elif mutation=='stop-refused':(root/'stop-fails').touch()
 elif mutation=='sync-refused':(root/'sync-fails').touch()
 elif mutation=='expired-lease':(root/'lease-fixture.json').write_text(json.dumps(dict(active=False,remainingMs=0)))
 elif mutation=='changed-session':(root/'run/mucodesandbox-lease/state').write_text(json.dumps(dict(session='33333333-3333-4333-8333-333333333333',boot='22222222-2222-4222-8222-222222222222',state='active',deadline=12345)))
 elif mutation=='changed-candidate':(components(root)/('chrome-'+candidate)/'chrome').write_bytes(b'unknown candidate')
 elif mutation=='changed-archive':(components(root)/'.browser-adoption/profile.tar').write_bytes(b'unknown checkpoint')
 unchanged=snapshot(profile(root));answer=run(root,'bound-commit',epoch);assert not answer['ok'],(mutation,answer);assert snapshot(profile(root))==unchanged;assert not (components(root)/'browser-selection.json').exists();assert ok(root,'status')['pending']['phase']=='trial'
 # Corrupt checkpoints remain retained for explicit review. All intact
 # checkpoints still restore through a fresh process without the candidate.
 if mutation!='changed-archive':
  (root/'stop-fails').unlink(missing_ok=True);ok(root,'recover',epoch);old(root,before,epoch)
 passed('bound-commit-refuses-'+mutation,compatibleRollback=mutation!='changed-archive',originalSelectionPreserved=True)
for point,committed in [('sync-finished',False),('commit-durable',True),('selection-published',True)]:
 root,before=fixture('bound-killed-'+point);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);run(root,'bound-commit',epoch,point);ok(root,'recover',epoch)
 if committed:new(root,trial)
 else:old(root,before,epoch)
 passed('bound-commit-process-killed-'+point,realKilledProcess=True,committedDecisionPreserved=committed)
for mutation in ['missing-stop','partial-stop','foreign-stop','hardlinked-stop']:
 root,before=fixture(mutation);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);trial=changed(root);marker=components(root)/'.browser-adoption/trial-stop'
 if mutation!='missing-stop':ok(root,'stop-fence',epoch)
 if mutation=='partial-stop':marker.write_bytes(b'{"version":')
 elif mutation=='foreign-stop':value=json.loads(marker.read_bytes());value['binding']='0'*64;marker.write_text(json.dumps(value,sort_keys=True,separators=(',',':')))
 elif mutation=='hardlinked-stop':native.link(marker,root/'stop-link')
 raw=marker.read_bytes() if marker.exists() else None;answer=run(root,'unfenced-bound-commit',epoch);assert not answer['ok'];assert snapshot(profile(root))==trial;assert not (components(root)/'browser-selection.json').exists()
 if raw is not None:assert not run(root,'launch-gate',epoch)['ok']
 ok(root,'recover',epoch);old(root,before,epoch)
 if raw is not None:assert (components(root)/('.browser-adoption-done-'+epoch)/'trial-stop').read_bytes()==raw
 passed('bound-commit-refuses-'+mutation,compatibleRollback=True,unknownStopMarkerPreserved=raw is not None)
for point in ['trial-stop-prefix','trial-stop-durable']:
 root,before=fixture('killed-'+point);epoch=ok(root,'begin')['epoch'];ok(root,'trial',epoch);changed(root);run(root,'stop-fence',epoch,point);assert not run(root,'launch-gate',epoch)['ok'];ok(root,'recover',epoch);old(root,before,epoch);passed(point,realKilledProcess=True,lateLaunchRefused=True,compatibleRollback=True)
print(json.dumps(dict(complete=True,checks=results,realProcessKills=kills,actualHostFiles=True,realSqliteCookies=True,actualAlgorithms=True,linuxUidModeDirfdAndPrctlAdapters=True,profileConsumerRecipeAdapter=True,spaceReservationAdapter=True,serviceAndLeaseAdapters=True,realLinux=False,realVm=False,browserExecuted=False)))
