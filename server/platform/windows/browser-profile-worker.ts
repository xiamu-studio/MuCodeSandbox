// Executed only by the root transaction, after dropping to dev. No user paths
// or shell fragments enter this program. Its cwd is an inherited pinned fd.
export const WINDOWS_BROWSER_PROFILE_WORKER=String.raw`
import os,sys,stat,tarfile,pathlib,json,ctypes,signal,decimal,re
kind,descriptor,parent=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
if os.getuid()==0:raise RuntimeError('Profile worker must run as dev')
libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(1,signal.SIGKILL,0,0,0)!=0 or libc.prctl(4,0,0,0,0)!=0:raise RuntimeError('Private worker fence unavailable')
if os.getppid()!=parent:raise RuntimeError('Profile transaction owner exited')
os.fchdir(descriptor)
FLAGS=os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK
LIMIT=1099511627776
def require(ok):
 if not ok:raise RuntimeError('Profile object or checkpoint changed')
def stamp(info):return info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns
def directory(info):require(stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o022)
def regular(info):require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o022)
def same(parent,name,fd,before):
 after=os.fstat(fd);named=os.stat(name,dir_fd=parent,follow_symlinks=False);regular(after);regular(named);require(stamp(before)==stamp(after)==stamp(named))
root=os.open('.',os.O_RDONLY|os.O_DIRECTORY|FLAGS);directory(os.fstat(root));device=os.fstat(root).st_dev
paths=set();allowed_dirs={''};files=0;total=0;path_bytes=0
def bounded(name,size):
 global files,total,path_bytes
 length=len(name.encode());require(name not in paths and length<=1024 and size>=0);paths.add(name);files+=1;total+=size;path_bytes+=length
 require(files<=100000 and total<=LIMIT and path_bytes<=4194304)
def capture(folder,prefix,output):
 before_folder=os.fstat(folder);directory(before_folder)
 for name in sorted(os.listdir(folder)):
  if not prefix and name in ['SingletonLock','SingletonSocket','SingletonCookie']:continue
  require(name not in ['.','..'] and '/' not in name and chr(92) not in name)
  relative=prefix+'/'+name if prefix else name;before=os.stat(name,dir_fd=folder,follow_symlinks=False);require(before.st_dev==device)
  if stat.S_ISDIR(before.st_mode):
   child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=folder)
   try:
    directory(os.fstat(child));require((before.st_dev,before.st_ino)==(os.fstat(child).st_dev,os.fstat(child).st_ino));bounded(relative,0)
    item=tarfile.TarInfo(relative);item.type=tarfile.DIRTYPE;item.mode=0o700;output.addfile(item);capture(child,relative,output)
    named=os.stat(name,dir_fd=folder,follow_symlinks=False);require((before.st_dev,before.st_ino)==(named.st_dev,named.st_ino))
   finally:os.close(child)
  else:
   regular(before);fd=os.open(name,os.O_RDONLY|FLAGS,dir_fd=folder)
   try:
    regular(os.fstat(fd));require(stamp(before)==stamp(os.fstat(fd)));bounded(relative,before.st_size)
    item=tarfile.TarInfo(relative);item.size=before.st_size;item.mode=stat.S_IMODE(before.st_mode)&0o700;item.mtime=before.st_mtime_ns//1000000000;item.pax_headers['mtime']=str(decimal.Decimal(before.st_mtime_ns)/1000000000)
    with os.fdopen(fd,'rb',closefd=False) as source:output.addfile(item,source)
    same(folder,name,fd,before)
   finally:os.close(fd)
 require(stamp(before_folder)==stamp(os.fstat(folder)))
def parent(parts,create):
 fd=os.dup(root)
 try:
  for name in parts:
   if create:
    try:os.mkdir(name,0o700,dir_fd=fd)
    except FileExistsError:pass
   child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=fd);directory(os.fstat(child));os.close(fd);fd=child
  return fd
 except BaseException:os.close(fd);raise
def inventory(folder,prefix=''):
 for name in os.listdir(folder):
  relative=prefix+'/'+name if prefix else name;info=os.stat(name,dir_fd=folder,follow_symlinks=False)
  if stat.S_ISDIR(info.st_mode):
   directory(info);require(relative in allowed_dirs);child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=folder)
   try:inventory(child,relative)
   finally:os.close(child)
  else:regular(info);require(relative in paths)
try:
 if kind=='capture':
  with tarfile.open(fileobj=sys.stdout.buffer,mode='w|',format=tarfile.PAX_FORMAT) as output:capture(root,'',output)
  os.fsync(root)
 elif kind=='version':
  info=os.stat('Last Version',dir_fd=root,follow_symlinks=False);regular(info);require(info.st_nlink==1 and 0<info.st_size<=256);fd=os.open('Last Version',os.O_RDONLY|FLAGS,dir_fd=root)
  try:
   regular(os.fstat(fd));require(stamp(info)==stamp(os.fstat(fd)));raw=os.read(fd,257);require(len(raw)==info.st_size);value=raw.decode('ascii').strip();require(re.fullmatch(r'(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){3}',value) is not None);same(root,'Last Version',fd,info)
  finally:os.close(fd)
  print(json.dumps(dict(version=value)))
 elif kind in ['restore','verify']:
  with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
   for item in archive:
    parts=pathlib.PurePosixPath(item.name).parts
    require(not item.name.startswith('/') and '..' not in parts and chr(92) not in item.name and (item.isfile() or item.isdir()))
    if not parts:require(item.isdir());continue
    name='/'.join(parts);bounded(name,item.size)
    for count in range(1,len(parts)):allowed_dirs.add('/'.join(parts[:count]))
    owner=parent(parts[:-1],kind=='restore')
    try:
     leaf=parts[-1]
     if item.isdir():
      allowed_dirs.add(name)
      if kind=='restore':
       try:os.mkdir(leaf,0o700,dir_fd=owner)
       except FileExistsError:pass
      child=os.open(leaf,os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=owner)
      try:directory(os.fstat(child));os.fsync(child)
      finally:os.close(child)
      continue
     try:fd=os.open(leaf,os.O_RDONLY|FLAGS,dir_fd=owner)
     except FileNotFoundError:
      require(kind=='restore');fd=os.open(leaf,os.O_CREAT|os.O_EXCL|os.O_RDWR|FLAGS,0o600,dir_fd=owner)
     try:
      info=os.fstat(fd);regular(info);require(info.st_nlink==1 and info.st_size<=item.size);existing=info.st_size
      source=archive.extractfile(item);position=0;writer=None
      try:
       while True:
        block=source.read(1048576)
        if not block:break
        check=min(max(existing-position,0),len(block));require(os.read(fd,check)==block[:check])
        if check<len(block):
         require(kind=='restore')
         if writer is None:
          require(info.st_mode&0o200);writer=os.open(leaf,os.O_WRONLY|FLAGS,dir_fd=owner);require(stamp(os.fstat(writer))==stamp(info));os.lseek(writer,existing,os.SEEK_SET)
         pending=memoryview(block[check:])
         while pending:
          written=os.write(writer,pending);require(written>0);pending=pending[written:]
        position+=len(block)
       require(position==item.size and (kind!='verify' or existing==item.size))
       named=os.stat(leaf,dir_fd=owner,follow_symlinks=False);current=os.fstat(fd);require((info.st_dev,info.st_ino)==(named.st_dev,named.st_ino)==(current.st_dev,current.st_ino) and named.st_size==item.size)
       if kind=='restore':
        moment=decimal.Decimal(str(item.pax_headers.get('mtime',item.mtime)));require(moment.is_finite() and -62135596800<=moment<=253402300799);nanoseconds=int(moment*1000000000)
        os.fchmod(fd,(item.mode&0o700)|0o400);os.utime(fd,ns=(nanoseconds,nanoseconds));os.fsync(writer if writer is not None else fd)
      finally:
       source.close()
       if writer is not None:os.close(writer)
     finally:os.close(fd)
     os.fsync(owner)
    finally:os.close(owner)
  inventory(root);os.fsync(root);print(json.dumps(dict(files=files,bytes=total)))
 else:raise RuntimeError('Unknown profile worker action')
finally:os.close(root)
`;
