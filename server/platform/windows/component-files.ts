// Pinned POSIX component file operations; Windows fixtures adapt only OS metadata/handles.
export const WINDOWS_COMPONENT_FILES_PYTHON=String.raw`import os,sys,stat,json,hashlib,tarfile,fcntl,ctypes,re
class Refused(Exception):pass
def need(ok):
 if not ok:raise Refused('Component identity or contents could not be verified')
def identity(s):return s.st_dev,s.st_ino
def stamp(s):return identity(s)+(s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def directory(s):need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022)
def regular(s,maximum):need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1 and 0<=s.st_size<=maximum)
def sync(fd):os.fsync(fd)
def write_all(fd,b):
 while b:
  n=os.write(fd,b);need(n>0);b=b[n:]
class Pins:
 def __init__(self):self.handles=[];self.bindings=[]
 def add(self,fd):self.handles.append(fd);return fd
 def path(self,parts,create=False):
  parent=self.add(os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW));directory(os.fstat(parent))
  for name in parts:
   if create:
    try:os.mkdir(name,0o755,dir_fd=parent);sync(parent)
    except FileExistsError:pass
   child=self.child(parent,name);parent=child
  return parent
 def child(self,parent,name):
  fd=self.add(os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent));s=os.fstat(fd);directory(s);self.bindings.append((parent,name,fd,identity(s)));return fd
 def check(self):
  for parent,name,fd,before in self.bindings:
   a=os.fstat(fd);b=os.stat(name,dir_fd=parent,follow_symlinks=False);directory(a);directory(b);need(before==identity(a)==identity(b))
  directory(os.fstat(self.handles[0]))
 def close(self):
  for fd in reversed(self.handles):os.close(fd)
  self.handles=[]
def exists(parent,name):
 try:os.stat(name,dir_fd=parent,follow_symlinks=False);return True
 except FileNotFoundError:return False
def stable(parent,name,fd,before,maximum):
 a=os.fstat(fd);b=os.stat(name,dir_fd=parent,follow_symlinks=False);regular(a,maximum);regular(b,maximum);need(stamp(before)==stamp(a)==stamp(b))
def read_exact(parent,name,expected):
 fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
 try:
  before=os.fstat(fd);regular(before,expected['bytes']);need(before.st_size==expected['bytes']);h=hashlib.sha256();count=0
  while True:
   block=os.read(fd,1048576)
   if not block:break
   h.update(block);count+=len(block);need(count<=expected['bytes'])
  need(count==expected['bytes'] and h.hexdigest()==expected['sha256']);stable(parent,name,fd,before,expected['bytes'])
 finally:os.close(fd)
def check_tree(parent,files):
 need(set(os.listdir(parent))==set(files))
 for name,item in files.items():read_exact(parent,name,item)
def fill(parent,name,source,expected,pins,executable=False):
 pins.check()
 try:fd=os.open(name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=parent);sync(parent)
 except FileExistsError:fd=os.open(name,os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent)
 try:
  before=os.fstat(fd);regular(before,expected['bytes']);old=before.st_size;read=0;h=hashlib.sha256()
  while read<expected['bytes']:
   block=source.read(min(1048576,expected['bytes']-read));need(bool(block));h.update(block)
   existing=min(len(block),max(0,old-read))
   if existing:need(os.read(fd,existing)==block[:existing])
   if existing<len(block):write_all(fd,block[existing:])
   read+=len(block)
  need(not source.read(1) and read==expected['bytes'] and h.hexdigest()==expected['sha256'])
  # Preserve every pre-existing unknown byte instead of truncating a file.
  after=os.fstat(fd);regular(after,expected['bytes']);need(after.st_size==expected['bytes'] and identity(after)==identity(before));pins.check();need(identity(os.stat(name,dir_fd=parent,follow_symlinks=False))==identity(before))
  os.fchmod(fd,0o755 if executable else 0o644);sync(fd)
 finally:os.close(fd)
def rename_exclusive(parent,source,target):
 libc=ctypes.CDLL(None,use_errno=True);need(hasattr(libc,'renameat2'))
 if libc.renameat2(parent,os.fsencode(source),parent,os.fsencode(target),1)!=0:raise OSError(ctypes.get_errno(),'Exclusive component publication failed')
`;
