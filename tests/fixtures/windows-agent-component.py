"""Production helper functions on real ordinary Windows files.
POSIX uid/mode, relative-directory handles, flock and renameat2 are explicit
adapters. No installed program is executed and no privileged path is touched.
"""
import os as native,sys,pathlib,json,hashlib,stat,types,builtins,io,tarfile,contextlib
source=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');base=pathlib.Path(sys.argv[2]);results=[]
binary=b'\x7fELF\x02\x01'+bytes((n*37+n//251)%256 for n in range(65536))
payloads={'claude':binary,'package.json':b'{"name":"@anthropic-ai/claude-code-linux-x64","version":"2.1.310"}','LICENSE.md':b'Synthetic license','README.md':b'Synthetic native component'}
def digest(b):return hashlib.sha256(b).hexdigest()
def archive(files=None,extra=None):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w:gz',format=tarfile.USTAR_FORMAT) as t:
  for name,raw in (files or payloads).items():
   entry=tarfile.TarInfo('package/'+name);entry.size=len(raw);t.addfile(entry,io.BytesIO(raw))
  if extra:
   entry=tarfile.TarInfo(extra);entry.size=1;t.addfile(entry,io.BytesIO(b'x'))
 return out.getvalue()
packed=archive();asset=dict(name='@anthropic-ai/claude-code-linux-x64',version='2.1.310',bytes=len(packed),sha256=digest(packed),files={n:dict(bytes=len(b),sha256=digest(b)) for n,b in payloads.items()})
class Crash(BaseException):pass
class Fixture:
 def __init__(self,name):
  self.root=base/name;self.root.mkdir();self.fds={};self.next=100000;self.modes={};self.owners={};self.calls=[];self.stop=None;self.stopped=False;self.busy=False;self.space=1<<40;self.user=0;self.race=False
  self.project=self.root/'workspace'/'project.txt';self.project.parent.mkdir();self.project.write_bytes(b'KEEP PROJECT')
  self.credentials=self.root/'home/dev/.claude/credentials.json';self.credentials.parent.mkdir(parents=True);self.credentials.write_bytes(b'SYNTHETIC ACCOUNT SENTINEL')
 @property
 def parent(self):return self.root/'opt/mucodesandbox/windows'
 @property
 def stage(self):return self.parent/'.claude-code-2.1.310.installing'
 @property
 def final(self):return self.parent/'claude-code-2.1.310'
 def file(self,name,dir_fd=None):
  name=native.fsdecode(name);return self.root if name=='/' else self.fds[dir_fd][0]/name
 def info(self,p):
  s=p.lstat();mode=(stat.S_IFDIR if p.is_dir() else stat.S_IFREG)|self.modes.get(p,0o755 if p.is_dir() else 0o644)
  return types.SimpleNamespace(st_mode=mode,st_uid=self.owners.get(p,0),st_dev=s.st_dev,st_ino=s.st_ino,st_size=s.st_size,st_nlink=s.st_nlink,st_mtime_ns=s.st_mtime_ns,st_ctime_ns=s.st_ctime_ns)
 def opening(self,name,flags,mode=0o777,dir_fd=None):
  p=self.file(name,dir_fd);self.calls.append(('open',str(p.relative_to(self.root)),flags));directory=flags&0x400000
  if directory:
   if not p.exists():raise FileNotFoundError(str(p))
   if not p.is_dir():raise OSError('Not a directory')
   fd=self.next;self.next+=1;self.fds[fd]=(p,True);return fd
  existed=p.exists();fd=native.open(p,(flags&~0x700000)|getattr(native,'O_BINARY',0),mode);self.fds[fd]=(p,False)
  if not existed:self.modes[p]=mode
  return fd
 def close(self,fd):
  p,isdir=self.fds.pop(fd)
  if not isdir:native.close(fd)
 def chmod(self,fd,mode):self.modes[self.fds[fd][0]]=mode
 def writing(self,fd,b):
  p=self.fds[fd][0]
  if self.stop==p.name and not self.stopped:
   self.stopped=True;native.write(fd,b[:min(37,len(b))]);raise Crash('Synthetic process death during '+p.name)
  return native.write(fd,b)
 def mkdir(self,name,mode=0o777,dir_fd=None):
  p=self.file(name,dir_fd);p.mkdir(mode=mode);self.modes[p]=mode
 def sync(self,fd):
  if not self.fds[fd][1]:native.fsync(fd)
 def rename(self,parent,src,other,dst,flags):
  assert flags==1 and parent==other;old=self.file(src,parent);new=self.file(dst,parent)
  if self.race:new.mkdir();(new/'unrelated.txt').write_bytes(b'KEEP FOREIGN DESTINATION')
  if new.exists():self.errno=17;return -1
  native.rename(old,new)
  for fd,(p,d) in list(self.fds.items()):
   if p==old or old in p.parents:self.fds[fd]=(new/p.relative_to(old),d)
  for values in [self.modes,self.owners]:
   for p,v in list(values.items()):
    if p==old or old in p.parents:values[new/p.relative_to(old)]=values.pop(p)
  if self.stop=='after-publication' and not self.stopped:self.stopped=True;raise Crash('Synthetic death after atomic publication')
  return 0
 def execute(self,mode,raw=packed,selected=asset):
  def locking(fd,flags):
   assert flags==6
   if self.busy:raise BlockingIOError('Synthetic competing installer')
  fake=types.SimpleNamespace(O_RDONLY=native.O_RDONLY,O_RDWR=native.O_RDWR,O_CREAT=native.O_CREAT,O_EXCL=native.O_EXCL,O_DIRECTORY=0x400000,O_NOFOLLOW=0x200000,O_CLOEXEC=0x100000,open=self.opening,close=self.close,fstat=lambda fd:self.info(self.fds[fd][0]),stat=lambda n,dir_fd=None,follow_symlinks=None:self.info(self.file(n,dir_fd)),mkdir=self.mkdir,listdir=lambda fd:native.listdir(self.fds[fd][0]),read=native.read,write=self.writing,fchmod=self.chmod,fsync=self.sync,geteuid=lambda:self.user,fstatvfs=lambda fd:types.SimpleNamespace(f_bavail=self.space,f_frsize=1),fdopen=native.fdopen,unlink=lambda n,dir_fd=None:native.unlink(self.file(n,dir_fd)),fsencode=native.fsencode)
  library=types.SimpleNamespace(renameat2=self.rename)
  special={'os':fake,'sys':types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=io.BytesIO(raw))),'fcntl':types.SimpleNamespace(LOCK_EX=2,LOCK_NB=4,flock=locking),'ctypes':types.SimpleNamespace(CDLL=lambda *a,**k:library,get_errno=lambda:getattr(self,'errno',0))}
  def importing(name,*args,**kwargs):
   if name in special:return special[name]
   assert name in ['stat','json','hashlib','tarfile','re','io'],name
   return builtins.__import__(name,*args,**kwargs)
  safe=dict(vars(builtins));safe['__import__']=importing;safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unpinned path operation'))
  env={'__builtins__':safe};exec(compile(source,'unchanged-agent-component-functions','exec'),env)
  try:return env['main'](selected,mode)
  finally:
   leaked=list(self.fds)
   for fd in list(self.fds):self.close(fd)
   assert not leaked,('Handle leak',leaked)
   assert self.project.read_bytes()==b'KEEP PROJECT';assert self.credentials.read_bytes()==b'SYNTHETIC ACCOUNT SENTINEL'
def expect_refused(f,raw=packed,selected=asset):
 try:f.execute('install',raw,selected)
 except (Exception,Crash):pass
 else:raise AssertionError('Unsafe component accepted')
def passed(name):results.append(dict(case=name,passed=True))
f=Fixture('fresh');assert f.execute('inspect')['state']=='missing';assert f.execute('install')['state']=='verified';assert f.execute('inspect')['state']=='verified';assert (f.final/'claude').read_bytes()==binary;assert not (f.final/'.archive.tgz').exists();before={str(p.relative_to(f.final)):digest(p.read_bytes()) for p in f.final.iterdir()};assert f.execute('install',b'not consulted after verified installation')['state']=='verified';assert before=={str(p.relative_to(f.final)):digest(p.read_bytes()) for p in f.final.iterdir()};passed('fresh-verified-idempotent-no-program-execution')
for point in ['.archive.tgz','claude','.mu-component.json','before-publication','after-publication']:
 f=Fixture('death-'+point.replace('.','-'));f.stop=point
 if point=='before-publication':
  original=f.rename
  def stopped(*args):raise Crash('Synthetic death before publication')
  f.rename=stopped
 try:f.execute('install')
 except Crash:pass
 else:raise AssertionError('Fixture did not interrupt '+point)
 if point=='before-publication':f.rename=original
 assert f.execute('inspect')['state']==('verified' if point=='after-publication' else 'pending');f.stop=None;assert f.execute('install')['state']=='verified';assert f.execute('inspect')['state']=='verified';passed('resume-'+point)
for case in ['unknown-candidate','changed-prefix','hardlink','unsafe-owner','unsafe-mode','unknown-published','changed-published','missing-published-record','space','nonroot','busy','destination-race','bad-archive','extra-archive-byte','tar-traversal','tar-unknown','tar-duplicate']:
 f=Fixture(case)
 if case in ['unknown-candidate','changed-prefix']:
  f.stop='claude'
  try:f.execute('install')
  except Crash:pass
  f.stop=None
  if case=='unknown-candidate':(f.stage/'personal.txt').write_bytes(b'KEEP UNKNOWN FILE')
  else:(f.stage/'claude').write_bytes(b'KEEP MODIFIED PREFIX')
  before={str(p.relative_to(f.stage)):digest(p.read_bytes()) for p in f.stage.iterdir()};expect_refused(f);assert before=={str(p.relative_to(f.stage)):digest(p.read_bytes()) for p in f.stage.iterdir()};assert not f.final.exists()
 elif case in ['hardlink','unsafe-owner','unsafe-mode','unknown-published','changed-published','missing-published-record']:
  assert f.execute('install')['state']=='verified'
  if case=='hardlink':native.link(f.final/'claude',f.root/'retained-binary-link')
  if case=='unsafe-owner':f.owners[f.parent]=2001
  if case=='unsafe-mode':f.modes[f.final/'claude']=0o777
  if case=='unknown-published':(f.final/'personal.txt').write_bytes(b'KEEP PUBLISHED UNKNOWN FILE')
  if case=='changed-published':(f.final/'claude').write_bytes(b'KEEP MODIFIED PUBLISHED FILE')
  if case=='missing-published-record':(f.final/'.mu-component.json').unlink()
  before={str(p.relative_to(f.final)):digest(p.read_bytes()) for p in f.final.iterdir()};assert f.execute('inspect')['state']=='untrusted';expect_refused(f);assert before=={str(p.relative_to(f.final)):digest(p.read_bytes()) for p in f.final.iterdir()}
 elif case=='space':f.space=1;expect_refused(f);assert not f.final.exists() and list(f.stage.iterdir())==[]
 elif case=='nonroot':f.user=2001;expect_refused(f);assert not f.parent.exists()
 elif case=='busy':f.busy=True;assert f.execute('install')['state']=='busy';assert not f.stage.exists()
 elif case=='destination-race':f.race=True;expect_refused(f);assert (f.final/'unrelated.txt').read_bytes()==b'KEEP FOREIGN DESTINATION';assert f.stage.exists()
 elif case=='bad-archive':expect_refused(f,packed[:-1]+bytes([packed[-1]^1]));assert not f.final.exists()
 elif case=='extra-archive-byte':expect_refused(f,packed+b'x');assert not f.final.exists()
 else:
  raw=archive(extra='package/../outside' if case=='tar-traversal' else 'package/unknown' if case=='tar-unknown' else 'package/claude');selected={**asset,'bytes':len(raw),'sha256':digest(raw)};expect_refused(f,raw,selected);assert not f.final.exists() and not (f.root/'outside').exists()
 passed(case)
print(json.dumps(dict(complete=True,checks=results,actualOrdinaryFiles=True,actualHashes=True,actualHardLinks=True,unchangedHelperFunctions=True,syntheticApprovedAsset=True,posixMetadataDirfdLockRenameAdapters=True,actualLinux=False,executedCli=False,actualHyperV=False,projectAndCredentialSentinelsPreserved=True)))
