import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import {windowsDesktopAsset} from './desktop-assets.ts';
import {WINDOWS_COMPONENT_FILES_PYTHON} from './component-files.ts';
import {WINDOWS_CLIENT_RUNTIME_PYTHON} from './desktop-runtime.ts';

// Source-only component preparation. Fixed archives and every extracted file
// are pinned. No Debian maintainer script, client, shell or package manager runs.
export const WINDOWS_DESKTOP_COMPONENT_PYTHON=WINDOWS_COMPONENT_FILES_PYTHON+String.raw`
import io

class DesktopPins(Pins):
 def __init__(self):
  super().__init__();self.children={}
 def child(self,parent,name):
  key=(parent,name)
  if key in self.children:
   fd,before=self.children[key];opened=os.fstat(fd);named=os.stat(name,dir_fd=parent,follow_symlinks=False)
   directory(opened);directory(named);need(before==identity(opened)==identity(named));return fd
  fd=super().child(parent,name);self.children[key]=(fd,identity(os.fstat(fd)));return fd

def desktop_dirs(files):
 result=set()
 for name in files:
  parts=name.split('/')
  need(all(p not in ['','.','..'] and '\\' not in p for p in parts))
  for n in range(1,len(parts)):result.add('/'.join(parts[:n]))
 need(not set(files)&result)
 return result

def desktop_walk(parent,pins,files,partial=False,prefix=''):
 dirs=desktop_dirs(files)
 expected={p[len(prefix):].split('/')[0] for p in set(files)|dirs if p.startswith(prefix)}
 names=set(os.listdir(parent));need(names<=expected if partial else names==expected)
 size=0
 for name in names:
  relative=prefix+name
  if relative in dirs:
   child=pins.child(parent,name);size+=desktop_walk(child,pins,files,partial,relative+'/')
  else:
   item=files[relative];fd=os.open(name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent)
   try:
    s=os.fstat(fd);regular(s,item['bytes']);size+=s.st_size
    if not partial:need(stat.S_IMODE(s.st_mode)==item.get('mode',0o755 if item.get('executable') else 0o644))
   finally:os.close(fd)
   if not partial:read_exact(parent,name,item)
 return size

def desktop_parent(stage,name,pins,create=False):
 parts=name.split('/');parent=stage
 for part in parts[:-1]:
  if create:
   try:os.mkdir(part,0o755,dir_fd=parent);sync(parent)
   except FileExistsError:pass
  parent=pins.child(parent,part)
 return parent,parts[-1]

def desktop_elf(stage,name,pins):
 parent,local=desktop_parent(stage,name,pins);fd=os.open(local,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent)
 try:
  header=os.read(fd,20);need(len(header)==20 and header[:6]==bytes([127,69,76,70,2,1]) and header[18:20]==bytes([62,0]))
 finally:os.close(fd)

def desktop_data(source,length):
 need(source.read(8)==b'!<arch>\n');seen=set();data=None
 while source.tell()<length:
  header=source.read(60);need(len(header)==60 and header[58:]==b'\x60\n')
  name=header[:16].decode('ascii').strip().rstrip('/');raw=header[48:58].decode('ascii').strip();need(raw.isdecimal());size=int(raw)
  need(name not in seen and name in ['debian-binary','control.tar.xz','control.tar.gz','data.tar.xz','data.tar.gz'] and 0<=size<=length-source.tell());seen.add(name)
  if name=='debian-binary':need(source.read(size)==b'2.0\n')
  else:
   if name.startswith('data.tar'):need(data is None);data=(source.tell(),size)
   source.seek(size,1)
  if size%2:need(source.read(1)==b'\n')
 need(source.tell()==length and 'debian-binary' in seen and len(seen)==3 and data is not None)
 return data

class DesktopSlice:
 def __init__(self,source,count):self.source=source;self.count=count
 def read(self,n=-1):
  n=self.count if n<0 else min(n,self.count);raw=self.source.read(n);self.count-=len(raw);return raw

def main(asset,mode):
 need(mode in ['inspect','install']);prefixes={'grok-bot':'opt/Grok Bot/','claude-desktop':'usr/lib/claude-desktop/'}
 need(asset['id'] in prefixes and asset['architecture']=='amd64' and re.fullmatch(r'\d+\.\d+\.\d+',asset['version']) is not None)
 files=dict(asset['files']);need(1<=len(files)<=4096 and asset['executable'] in files and asset['sandbox'] in files)
 need(0<asset['bytes']<=268435456 and re.fullmatch(r'[a-f0-9]{64}',asset['sha256']) is not None and asset['prefix']==prefixes[asset['id']])
 for item in files.values():need(type(item['bytes']) is int and 0<=item['bytes']<=471859200 and re.fullmatch(r'[a-f0-9]{64}',item['sha256']) is not None and type(item['executable']) is bool)
 need(sum(item['bytes'] for item in files.values())<=1073741824 and all(n.split('/')[0] not in ['.archive.deb','.mu-component.json'] for n in files));desktop_dirs(files)
 files[asset['sandbox']]={**files[asset['sandbox']],'mode':0o4755}
 leaf='desktop-'+asset['id']+'-'+asset['version'];candidate='.'+leaf+'.installing';pins=DesktopPins();lock=None;result=dict(version=1,state='untrusted')
 record=json.dumps(dict(version=1,id=asset['id'],release=asset['version'],architecture='amd64',archiveSha256=asset['sha256'],files=files),sort_keys=True,separators=(',',':')).encode()
 need(len(record)<=1048576);files['.mu-component.json']=dict(bytes=len(record),sha256=hashlib.sha256(record).hexdigest())
 try:
  if mode=='install':need(os.geteuid()==0)
  parent=pins.path(['opt','mucodesandbox','windows'],mode=='install')
  if exists(parent,leaf):
   final=pins.child(parent,leaf)
   try:desktop_walk(final,pins,files)
   except FileNotFoundError:raise Refused('Published desktop component incomplete')
   pins.check();result['state']='verified';return result
  if mode=='inspect':result['state']='pending' if exists(parent,candidate) else 'missing';pins.check();return result
  lock=os.open('.desktop-'+asset['id']+'-install.lock',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=parent) if not exists(parent,'.desktop-'+asset['id']+'-install.lock') else os.open('.desktop-'+asset['id']+'-install.lock',os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent)
  regular(os.fstat(lock),0)
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:result['state']='busy';return result
  pins.check()
  if exists(parent,leaf):final=pins.child(parent,leaf);desktop_walk(final,pins,files);pins.check();result['state']='verified';return result
  try:os.mkdir(candidate,0o700,dir_fd=parent);sync(parent)
  except FileExistsError:pass
  stage=pins.child(parent,candidate);bounds={**files,'.archive.deb':dict(bytes=asset['bytes'],sha256=asset['sha256'])};present=desktop_walk(stage,pins,bounds,True)
  space=os.fstatvfs(parent);need(space.f_bavail*space.f_frsize>=sum(v['bytes'] for v in bounds.values())-present+67108864)
  fill(stage,'.archive.deb',sys.stdin.buffer,dict(bytes=asset['bytes'],sha256=asset['sha256']),pins)
  archive=os.open('.archive.deb',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=stage)
  try:
   before=os.fstat(archive);regular(before,asset['bytes']);seen=set()
   with os.fdopen(archive,'rb',closefd=False) as source:
    offset,length=desktop_data(source,asset['bytes']);source.seek(offset)
    with tarfile.open(fileobj=DesktopSlice(source,length),mode='r|*') as bundle:
     for member in bundle:
      name=member.name[2:] if member.name.startswith('./') else member.name
      if not name.startswith(asset['prefix']):continue
      name=name[len(asset['prefix']):]
      if not name:need(member.isdir());continue
      if member.isdir():need(not name.startswith('/') and all(p not in ['','.','..'] for p in name.rstrip('/').split('/')));continue
      need(name in asset['files'] and name not in seen and member.isfile() and not member.pax_headers and member.size==files[name]['bytes']);seen.add(name)
      target,local=desktop_parent(stage,name,pins,True)
      with bundle.extractfile(member) as content:fill(target,local,content,files[name],pins,files[name]['executable'])
      if name==asset['sandbox']:
       helper=os.open(local,os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=target)
       try:regular(os.fstat(helper),files[name]['bytes']);os.fchmod(helper,0o4755);sync(helper)
       finally:os.close(helper)
   need(seen==set(asset['files']));stable(stage,'.archive.deb',archive,before,asset['bytes'])
  finally:os.close(archive)
  fill(stage,'.mu-component.json',io.BytesIO(record),files['.mu-component.json'],pins)
  desktop_walk(stage,pins,bounds);desktop_elf(stage,asset['executable'],pins);desktop_elf(stage,asset['sandbox'],pins);pins.check();os.unlink('.archive.deb',dir_fd=stage);sync(stage)
  desktop_walk(stage,pins,files);pins.check();os.fchmod(stage,0o755);sync(stage)
  rename_exclusive(parent,candidate,leaf);sync(parent)
  pins.bindings=[(p,leaf if p==parent and n==candidate else n,fd,b) for p,n,fd,b in pins.bindings]
  pins.check();need(identity(os.stat(leaf,dir_fd=parent,follow_symlinks=False))==identity(os.fstat(stage)));desktop_walk(stage,pins,files);result['state']='verified';return result
 except FileNotFoundError:
  if mode=='inspect':result['state']='missing';return result
  raise
 except (Refused,OSError,ValueError,tarfile.TarError):
  if mode=='inspect':return result
  raise
 finally:
  if lock is not None:os.close(lock)
  pins.close()
`;

export function windowsDesktopComponentProgram(id:DesktopAppId,mode:'inspect'|'install'){
 if(mode!=='inspect'&&mode!=='install')throw Error('Invalid desktop component operation');
 return WINDOWS_DESKTOP_COMPONENT_PYTHON+(mode==='install'?'\n'+WINDOWS_CLIENT_RUNTIME_PYTHON+'\nassert_desktop_runtime('+JSON.stringify(id)+')\n':'')+'\nprint(json.dumps(main(json.loads('+JSON.stringify(JSON.stringify(windowsDesktopAsset(id)))+'),'+JSON.stringify(mode)+'),sort_keys=True))\n';
}
