// A fixed dev child, invoked only while the root trial gate holds the common
// installation lock. The inherited profile descriptor is the transaction's.
export const WINDOWS_BROWSER_TRIAL_PREFERENCES=String.raw`
import os,sys,stat,json,uuid,ctypes,signal
descriptor,parent,device,inode,locale=int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),sys.argv[5]
def require(ok):
 if not ok:raise RuntimeError('Candidate profile preferences cannot be verified')
require(os.getuid()!=0 and locale in ['en-US','zh-CN','zh-TW','ja-JP','de-DE'])
libc=ctypes.CDLL(None,use_errno=True);require(libc.prctl(1,signal.SIGKILL,0,0,0)==0 and libc.prctl(4,0,0,0,0)==0 and os.getppid()==parent)
FLAGS=os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK
def identity(info):return info.st_dev,info.st_ino
def stamp(info):return identity(info)+(info.st_mode,info.st_uid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def directory(info,owner=None):require(stat.S_ISDIR(info.st_mode) and info.st_uid==(os.getuid() if owner is None else owner) and not info.st_mode&0o022)
def regular(info):require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and not info.st_mode&0o022 and info.st_size<=16777216)
def absent(fd,name):
 try:os.stat(name,dir_fd=fd,follow_symlinks=False)
 except FileNotFoundError:return True
 return False
def exclusive(source,target,fd):
 require(hasattr(libc,'renameat2'));require(libc.renameat2(fd,os.fsencode(source),fd,os.fsencode(target),1)==0);os.fsync(fd)
def pairs(items):
 value={}
 for key,item in items:
  require(key not in value);value[key]=item
 return value
handles=[];created=None;backup=None
try:
 profile=os.dup(descriptor);handles.append(profile);info=os.fstat(profile);directory(info);require(identity(info)==(device,inode))
 try:os.mkdir('Default',0o700,dir_fd=profile)
 except FileExistsError:pass
 default=os.open('Default',os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=profile);handles.append(default);default_info=os.fstat(default);directory(default_info)
 source=None;before=None;data={}
 try:source=os.open('Preferences',os.O_RDONLY|FLAGS,dir_fd=default)
 except FileNotFoundError:pass
 if source is not None:
  handles.append(source);before=os.fstat(source);regular(before);raw=bytearray()
  while len(raw)<=16777216:
   block=os.read(source,min(1048576,16777217-len(raw)))
   if not block:break
   raw.extend(block)
  require(len(raw)==before.st_size and stamp(before)==stamp(os.fstat(source))==stamp(os.stat('Preferences',dir_fd=default,follow_symlinks=False)))
  data=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs)
  os.close(source);handles.remove(source)
 require(isinstance(data,dict))
 for name in ['intl','session','translate','download']:
  if name not in data:data[name]={}
  require(isinstance(data[name],dict))
 data['intl'].update(accept_languages=','.join(dict.fromkeys([locale,locale.split('-')[0]])),selected_languages=','.join(dict.fromkeys([locale,locale.split('-')[0]])))
 data['session']['restore_on_startup']=5;data['translate']['enabled']=False;data['download'].update(default_directory='/home/dev/Downloads',prompt_for_download=False)
 raw=json.dumps(data,ensure_ascii=True,separators=(',',':')).encode();require(len(raw)<=16777216)
 root=os.open('/',os.O_RDONLY|os.O_DIRECTORY|FLAGS);handles.append(root);directory(os.fstat(root),0)
 home=os.open('home',os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=root);handles.append(home);directory(os.fstat(home),0)
 dev=os.open('dev',os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=home);handles.append(dev);directory(os.fstat(dev))
 try:os.mkdir('Downloads',0o700,dir_fd=dev)
 except FileExistsError:pass
 downloads=os.open('Downloads',os.O_RDONLY|os.O_DIRECTORY|FLAGS,dir_fd=dev);handles.append(downloads);directory(os.fstat(downloads));require(identity(os.fstat(downloads))==identity(os.stat('Downloads',dir_fd=dev,follow_symlinks=False)))
 created='.trial-preferences-'+uuid.uuid4().hex;output=os.open(created,os.O_CREAT|os.O_EXCL|os.O_WRONLY|FLAGS,0o600,dir_fd=default);handles.append(output);produced=identity(os.fstat(output));pending=memoryview(raw)
 while pending:
  written=os.write(output,pending);require(written>0);pending=pending[written:]
 os.fsync(output);os.close(output);handles.remove(output);require(identity(os.stat(created,dir_fd=default,follow_symlinks=False))==produced)
 require(identity(os.stat('Default',dir_fd=profile,follow_symlinks=False))==identity(default_info))
 if before is not None:
  require(stamp(before)==stamp(os.stat('Preferences',dir_fd=default,follow_symlinks=False)));backup='.trial-preferences-prior-'+uuid.uuid4().hex;exclusive('Preferences',backup,default);retained=os.stat(backup,dir_fd=default,follow_symlinks=False);require(identity(retained)==identity(before))
 else:require(absent(default,'Preferences'))
 exclusive(created,'Preferences',default);created=None;require(identity(os.stat('Preferences',dir_fd=default,follow_symlinks=False))==produced)
 if backup is not None:
  require(stamp(os.stat(backup,dir_fd=default,follow_symlinks=False))==stamp(retained));os.unlink(backup,dir_fd=default);backup=None;os.fsync(default)
 require(identity(os.stat('Default',dir_fd=profile,follow_symlinks=False))==identity(default_info));os.fsync(profile);print(json.dumps(dict(prepared=True)))
finally:
 for fd in reversed(handles):os.close(fd)
 # Incomplete owned outputs and the prior preferences remain in the profile.
 # The durable root checkpoint, rather than this child, owns failure rollback.
`;
