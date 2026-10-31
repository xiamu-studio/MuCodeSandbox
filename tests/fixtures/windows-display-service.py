"""Production read-only service checker on ordinary Windows files.
Root ownership, POSIX modes, procfs and systemd responses are explicit adapters;
the checker never executes a client, host systemctl or a privileged command.
"""
import os as native,pathlib as paths,stat,types,sys,builtins,io,contextlib,json,hashlib
program=paths.Path(sys.argv[1]).read_text(encoding='utf8');base=paths.Path(sys.argv[2]);unit=paths.Path(sys.argv[3]).read_bytes();launcher=paths.Path(sys.argv[4]).read_bytes();checks=[]
cases=['valid','parent-owner','file-owner','symlink-metadata','changed-unit','changed-launcher','hardlink','writable-file','nonexecutable-launcher','inactive-unit','invalid-pid','wrong-user','wrong-group','wrong-cgroup','dropin','capability','uid','process-cgroup','process-replaced','properties-changed']
for case in cases:
 root=base/case;root.mkdir();opens=[];property_reads=[0];stat_reads=[0]
 def file(name):return root.joinpath(*paths.PurePosixPath(name).parts[1:])
 for name,raw in [('/etc/systemd/system/mucodesandbox-display.service',unit),('/usr/local/libexec/mu-windows-display',launcher)]:
  target=file(name);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
 process=file('/proc/2222');process.mkdir(parents=True)
 (process/'stat').write_text('2222 (fixture display) '+' '.join(['S']+['0']*18+['12345']),encoding='utf8')
 (process/'status').write_text('Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\n',encoding='utf8')
 (process/'cgroup').write_text('0::/system.slice/mucodesandbox-display.service\n',encoding='utf8')
 marker=root/'synthetic-account-sentinel';marker.write_bytes(b'KEEP SYNTHETIC ACCOUNT DATA')
 if case=='changed-unit':file('/etc/systemd/system/mucodesandbox-display.service').write_bytes(b'X'+unit[1:])
 if case=='changed-launcher':file('/usr/local/libexec/mu-windows-display').write_bytes(b'X'+launcher[1:])
 if case=='hardlink':native.link(file('/usr/local/libexec/mu-windows-display'),root/'retained-helper-link')
 if case=='capability':(process/'status').write_text('Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000001\n',encoding='utf8')
 if case=='uid':(process/'status').write_text('Uid:\t1000\t0\t1000\t1000\nCapEff:\t0000000000000000\n',encoding='utf8')
 if case=='process-cgroup':(process/'cgroup').write_text('0::/system.slice/foreign.service\n',encoding='utf8')
 before={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 class Path:
  def __init__(self,name):self.name=paths.PurePosixPath(name)
  def __truediv__(self,name):return Path(self.name/name)
  def __fspath__(self):return str(file(str(self.name)))
  @property
  def parents(self):return tuple(Path(p) for p in self.name.parents)
  def lstat(self):
   real=file(str(self.name));s=real.lstat();isdir=real.is_dir();mode=(stat.S_IFDIR if isdir else stat.S_IFREG)|(0o755 if isdir or str(self.name).endswith('/mu-windows-display') else 0o644);uid=0
   if case=='parent-owner' and str(self.name)=='/usr/local':uid=1000
   if case=='file-owner' and str(self.name).endswith('/mu-windows-display'):uid=1000
   if case=='writable-file' and str(self.name).endswith('/mu-windows-display'):mode=stat.S_IFREG|0o777
   if case=='nonexecutable-launcher' and str(self.name).endswith('/mu-windows-display'):mode=stat.S_IFREG|0o644
   if case=='symlink-metadata' and str(self.name).endswith('/mu-windows-display'):mode=stat.S_IFLNK|0o777
   return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_dev=s.st_dev,st_ino=s.st_ino,st_nlink=s.st_nlink,st_size=s.st_size,st_mtime_ns=s.st_mtime_ns,st_ctime_ns=s.st_ctime_ns)
  def read_text(self):
   raw=file(str(self.name)).read_text(encoding='utf8')
   if str(self.name).endswith('/stat'):
    stat_reads[0]+=1
    if case=='process-replaced' and stat_reads[0]>1:raw=raw.replace('12345','67890')
   return raw
 fds={}
 def opening(name,flags):
  fd=native.open(name,flags&~0x200000);fds[fd]=name;opens.append(str(name.name));return fd
 def closing(fd):native.close(fd);fds.pop(fd)
 def command(args,**kwargs):
  if args==['id','-u','dev']:return '1000\n'
  assert args[:3]==['systemctl','show','mucodesandbox-display.service'],args
  property_reads[0]+=1;value=dict(ActiveState='active',MainPID='2222',User='dev',Group='dev',ControlGroup='/system.slice/mucodesandbox-display.service',FragmentPath='/etc/systemd/system/mucodesandbox-display.service',DropInPaths='')
  mapping={'inactive-unit':('ActiveState','inactive'),'invalid-pid':('MainPID','../../foreign'),'wrong-user':('User','root'),'wrong-group':('Group','root'),'wrong-cgroup':('ControlGroup','/system.slice/foreign.service'),'dropin':('DropInPaths','/etc/systemd/system/foreign.conf')}
  if case in mapping:key,val=mapping[case];value[key]=val
  if case=='properties-changed' and property_reads[0]>1:value['MainPID']='3333'
  return '\n'.join(k+'='+v for k,v in value.items())+'\n'
 fakeos=types.SimpleNamespace(O_RDONLY=native.O_RDONLY,O_NOFOLLOW=0x200000,open=opening,close=closing,fstat=lambda fd:fds[fd].lstat(),fdopen=native.fdopen)
 overrides={'os':fakeos,'pathlib':types.SimpleNamespace(Path=Path),'subprocess':types.SimpleNamespace(check_output=command)}
 def importing(name,*args,**kwargs):return overrides[name] if name in overrides else builtins.__import__(name,*args,**kwargs)
 safe=dict(vars(builtins));safe['__import__']=importing;safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unmapped file operation'))
 failed=None;out=io.StringIO()
 try:
  with contextlib.redirect_stdout(out):exec(compile(program,'unchanged-display-service-checker','exec'),{'__builtins__':safe})
 except (RuntimeError,OSError,ValueError,IndexError) as error:failed=error
 assert not fds,('Leaked handles',case,list(fds))
 if case=='valid':assert failed is None,failed;assert json.loads(out.getvalue())==dict(version=1,state='verified')
 else:assert failed is not None,('Invalid service accepted',case)
 assert before=={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 checks.append(dict(case=case,passed=True))
print(json.dumps(dict(complete=True,checks=checks,actualOrdinaryFiles=True,actualHardLinks=True,readOnlyFileBytesPreserved=True,ownerModeProcSystemdAdapters=True,actualLinux=False,actualHyperV=False,executedClient=False,executedHostSystemctl=False)))
