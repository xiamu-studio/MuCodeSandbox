"""Production client profile/inspection helpers with explicit POSIX/proc/systemd adapters.
Real ordinary Windows files and hashes; no client, Linux service, sudo or VM.
"""
import pathlib as paths,sys,os as native,stat,types,builtins,json,hashlib,io,contextlib
profile_source=paths.Path(sys.argv[1]).read_text(encoding='utf8');inspect_source=paths.Path(sys.argv[2]).read_text(encoding='utf8');base=paths.Path(sys.argv[3]);spec=json.loads(paths.Path(sys.argv[4]).read_text(encoding='utf8'))
shared=paths.Path(__file__).with_name('windows-agent-component.py').read_text(encoding='utf8');exec(compile(shared.split('def expect_refused')[0],'shared-explicit-file-adapters','exec'),globals());base=paths.Path(sys.argv[3]);checks=[]
def absolute_file(f,name,dir_fd=None):
 text=native.fsdecode(name);return f.root.joinpath(*paths.PurePosixPath(text).parts[1:]) if text.startswith('/') else f.fds[dir_fd][0]/text
def imports(overrides):
 def importing(name,*args,**kwargs):return overrides[name] if name in overrides else builtins.__import__(name,*args,**kwargs)
 safe=dict(vars(builtins));safe['__import__']=importing;return safe
def inventory(f):return {p.relative_to(f.root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in f.root.rglob('*') if p.is_file()}
def profile_case(case):
 f=Fixture('profile-'+case);f.file=lambda n,dir_fd=None:absolute_file(f,n,dir_fd);f.user=1000
 original_info=f.info
 def info(path):
  value=original_info(path);value.st_uid=f.owners.get(path,1000)
  if case=='link-parent' and path.name=='share' or case=='link-profile' and path.name==spec['application']:value.st_mode=stat.S_IFLNK|0o777
  return value
 f.info=info
 def mkdir(name,mode=0o777,dir_fd=None):f.mkdir(name,mode,dir_fd);f.owners[f.file(name,dir_fd)]=1000
 replaced=False
 def checking(name,dir_fd=None,follow_symlinks=False):
  nonlocal replaced
  if case=='replaced-parent' and name=='.local' and not replaced:
   replaced=True;old=f.file(name,dir_fd);new=old.with_name('.local-original');native.rename(old,new);old.mkdir()
   for fd,(p,d) in list(f.fds.items()):
    if p==old or old in p.parents:f.fds[fd]=(new/p.relative_to(old),d)
   for values in [f.modes,f.owners]:
    for p,v in list(values.items()):
     if p==old or old in p.parents:values[new/p.relative_to(old)]=values.pop(p)
  return f.info(f.file(name,dir_fd))
 fake=types.SimpleNamespace(O_RDONLY=native.O_RDONLY,O_DIRECTORY=0x400000,O_NOFOLLOW=0x200000,O_CLOEXEC=0x100000,open=f.opening,close=f.close,fstat=lambda fd:f.info(f.fds[fd][0]),stat=checking,mkdir=mkdir,fsync=f.sync,geteuid=lambda:f.user)
 env={'__builtins__':imports({'os':fake})};exec(compile(profile_source,'unchanged-profile-helper','exec'),env)
 home=f.root/'home/dev';leaf=home/'.local/share/mucodesandbox/desktop-clients'/spec['application']
 if case not in ['fresh','unknown-id','root-user','foreign-home','writable-home','file-collision']:
  leaf.mkdir(parents=True)
  for p in [leaf,*[leaf/n for n in ['profile','config','cache','data']]]:p.mkdir(exist_ok=True);f.modes[p]=0o700
  (leaf/'profile/keep-synthetic-account').write_bytes(b'KEEP CLIENT ACCOUNT')
 if case=='root-user':f.user=0
 if case=='foreign-home':f.owners[home]=0
 if case=='writable-home':f.modes[home]=0o777
 if case=='foreign-parent':f.owners[home/'.local/share']=0
 if case=='writable-parent':f.modes[home/'.local/share']=0o777
 if case=='foreign-profile':f.owners[leaf]=2001
 if case=='public-profile':f.modes[leaf]=0o755
 if case=='file-collision':(home/'.local').write_bytes(b'KEEP UNKNOWN COLLISION')
 before=inventory(f);error=None
 try:env['prepare_desktop_profile']('unknown' if case=='unknown-id' else spec['application'])
 except (RuntimeError,OSError) as failure:error=failure
 assert not f.fds,('Profile FD leak',case)
 if case in ['fresh','idempotent']:
  assert error is None,error
  snapshot=inventory(f);env['prepare_desktop_profile'](spec['application']);assert snapshot==inventory(f)
  assert all(f.modes[leaf/n]==0o700 for n in ['profile','config','cache','data'])
 else:assert error is not None,('Unsafe profile accepted',case)
 after=inventory(f)
 if case!='replaced-parent':assert before==after
 else:assert sorted(before.values())==sorted(after.values())
 checks.append('profile-'+case)
for case in ['fresh','idempotent','root-user','foreign-home','writable-home','foreign-parent','writable-parent','link-parent','foreign-profile','public-profile','link-profile','file-collision','replaced-parent','unknown-id']:profile_case(case)

def inspect_case(case):
 f=Fixture('inspect-'+case);f.file=lambda n,dir_fd=None:absolute_file(f,n,dir_fd)
 for name,text,mode in [('/run/systemd/system/'+spec['unit'],spec['unitText'],0o644),(spec['job']+'/launcher',spec['launcher'],0o755)]:
  target=f.file(name);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(text.encode('utf8'));f.modes[target]=mode
 group='/sys/fs/cgroup/system.slice/'+spec['unit'];parent=f.file(group);parent.mkdir(parents=True)
 (parent/'cgroup.procs').write_text('2222\n3333\n');(parent/'cgroup.events').write_text('populated 1\nfrozen 0\n')
 status='Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nSeccomp:\t2\nNoNewPrivs:\t1\n'
 for pid,argv in [('2222',spec['argv']),('3333',[spec['executable'],'--type=renderer'])]:
  p=f.file('/proc/'+pid);(p/'task'/pid).mkdir(parents=True)
  (p/'stat').write_text(pid+' (synthetic client) '+' '.join(['S']+['0']*18+['12345']))
  (p/'status').write_text(status);(p/'task'/pid/'status').write_text(status);(p/'cgroup').write_text('0::/system.slice/'+spec['unit']+'\n');(p/'cmdline').write_bytes(b'\0'.join(s.encode() for s in argv)+b'\0')
 def values():return dict(LoadState='loaded',ActiveState='active',MainPID='2222',User='dev',Group='dev',ControlGroup='/system.slice/'+spec['unit'],FragmentPath='/run/systemd/system/'+spec['unit'],DropInPaths='',KillMode='control-group',Type='exec',Description=spec['description'],BindsTo='mucodesandbox-display.service',PartOf='mucodesandbox-display.service')
 current=values();reads={}
 if case in ['stopped','stopped-populated','missing','missing-populated','stopped-foreign-group']:
  current.update(ActiveState='inactive',MainPID='0',ControlGroup='')
  if case.startswith('missing'):current['LoadState']='not-found'
  if case in ['stopped','missing','stopped-foreign-group']:(parent/'cgroup.events').write_text('populated 0\nfrozen 0\n')
 if case=='stopped-foreign-group':current['ControlGroup']='/foreign'
 field_changes={'unit-user':('User','root'),'unit-group':('Group','root'),'unit-kill':('KillMode','process'),'unit-type':('Type','simple'),'unit-description':('Description','foreign'),'unit-fragment':('FragmentPath','/etc/systemd/system/foreign.service'),'unit-dropin':('DropInPaths','/run/foreign.conf'),'unit-bind':('BindsTo','foreign.service'),'unit-part':('PartOf','foreign.service'),'unit-cgroup':('ControlGroup','/foreign'),'unit-pid':('MainPID','../../bad')}
 if case in field_changes:key,value=field_changes[case];current[key]=value
 if case=='changed-launcher':f.file(spec['job']+'/launcher').write_bytes(b'UNTRUSTED LAUNCHER')
 if case=='hardlink-unit':native.link(f.file('/run/systemd/system/'+spec['unit']),f.root/'keep-unit-link')
 if case=='no-renderer':(parent/'cgroup.procs').write_text('2222\n')
 if case=='no-main':(parent/'cgroup.procs').write_text('3333\n')
 if case=='bad-member':(parent/'cgroup.procs').write_text('../../foreign\n')
 if case=='unsafe-flag':f.file('/proc/3333/cmdline').write_bytes((spec['executable']+'\0--type=renderer\0--no-sandbox=true\0').encode())
 if case=='main-argv':f.file('/proc/2222/cmdline').write_bytes((spec['executable']+'\0--user-data-dir=/home/dev/foreign\0').encode())
 if case=='process-cgroup':f.file('/proc/3333/cgroup').write_text('0::/foreign\n')
 mutations={'thread-seccomp':('Seccomp:\t2','Seccomp:\t0'),'thread-nnp':('NoNewPrivs:\t1','NoNewPrivs:\t0'),'thread-caps':('CapEff:\t0','CapEff:\t1'),'thread-permitted':('CapPrm:\t0','CapPrm:\t1'),'thread-uid':('Uid:\t1000\t1000\t1000\t1000','Uid:\t1000\t0\t1000\t1000')}
 if case in mutations:
  a,b=mutations[case];f.file('/proc/3333/task/3333/status').write_text(status.replace(a,b))
 if case=='extra-unsafe-thread':
  extra=f.file('/proc/3333/task/3334');extra.mkdir();(extra/'status').write_text(status.replace('CapEff:\t0','CapEff:\t1'))
 if case=='thread-missing-seccomp':f.file('/proc/3333/task/3333/status').write_text(status.replace('Seccomp:\t2\n',''))
 before=inventory(f)
 class Path:
  def __init__(self,name):self.path=paths.PurePosixPath(name)
  def __truediv__(self,name):return Path(self.path/name)
  @property
  def name(self):return self.path.name
  def read_text(self):
   key=str(self.path);reads[key]=reads.get(key,0)+1;raw=f.file(key).read_text(encoding='utf8')
   if case=='process-replaced' and key=='/proc/3333/stat' and reads[key]>1:raw=raw.replace('12345','67890')
   if case=='members-changed' and key.endswith('/cgroup.procs') and reads[key]>1:raw+='4444\n'
   return raw
  def read_bytes(self):return f.file(str(self.path)).read_bytes()
  def iterdir(self):
   key='threads-'+str(self.path);reads[key]=reads.get(key,0)+1;items=[Path(self.path/p.name) for p in f.file(str(self.path)).iterdir()]
   if case=='threads-changed' and str(self.path)=='/proc/3333/task' and reads[key]>1:items.append(Path(self.path/'3334'))
   return items
 def run(args,**kwargs):
  assert args[:3]==['/usr/bin/systemctl','show',spec['unit']];reads['unit']=reads.get('unit',0)+1;v=dict(current)
  if case=='unit-changed' and reads['unit']>1:v['MainPID']='5555'
  return types.SimpleNamespace(returncode=0,stdout=('\n'.join(k+'='+v for k,v in v.items())+'\n'+('User=dev\n' if case=='unit-duplicate' else '')).encode())
 def readlink(path):return '/usr/bin/foreign' if case=='main-exe' or case=='renderer-exe' and path.path.parts[-2]=='3333' else spec['executable']
 fake=types.SimpleNamespace(O_RDONLY=native.O_RDONLY,O_DIRECTORY=0x400000,O_NOFOLLOW=0x200000,O_CLOEXEC=0x100000,open=f.opening,close=f.close,fstat=lambda fd:f.info(f.fds[fd][0]),stat=lambda n,dir_fd=None,follow_symlinks=False:f.info(f.file(n,dir_fd)),geteuid=lambda:0,read=native.read,readlink=readlink)
 overrides={'fcntl':types.SimpleNamespace(),'os':fake,'pathlib':types.SimpleNamespace(Path=Path),'subprocess':types.SimpleNamespace(run=run,check_output=lambda args:b'1000\n',DEVNULL=-3,PIPE=-1)}
 env={'__builtins__':imports(overrides)};exec(compile(inspect_source,'unchanged-client-inspection','exec'),env);error=None;result=None
 try:result=env['inspect_client'](spec)
 except env['Refused'] as failure:error=failure;trace=__import__('traceback').format_exc()
 assert not f.fds,('Client inspection FD leak',case)
 if case in ['valid','no-renderer','stopped','missing']:
  assert error is None,(case,str(error),trace if error else None);assert result['state']==('running' if case=='valid' else 'starting' if case=='no-renderer' else 'stopped')
 else:assert error is not None,('Unsafe client accepted',case)
 assert before==inventory(f);checks.append('inspect-'+case)
for case in ['valid','no-renderer','stopped','missing','stopped-populated','missing-populated','unit-user','unit-group','unit-kill','unit-type','unit-description','unit-fragment','unit-dropin','unit-bind','unit-part','unit-cgroup','unit-pid','changed-launcher','hardlink-unit','no-main','bad-member','unsafe-flag','main-argv','process-cgroup','thread-seccomp','thread-nnp','thread-caps','thread-permitted','thread-uid','process-replaced','members-changed','unit-changed','main-exe','renderer-exe','extra-unsafe-thread','threads-changed','unit-duplicate','thread-missing-seccomp','stopped-foreign-group']:inspect_case(case)
print(json.dumps(dict(complete=True,checks=checks,actualOrdinaryFiles=True,actualHardlinks=True,explicitPosixProcSystemdAdapters=True,clientExecuted=False,actualLinux=False,actualHyperV=False)))
