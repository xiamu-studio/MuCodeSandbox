"""Unchanged production readers, real file bytes/IDs/hardlinks. Explicit Linux
uid/mode/relative-directory-FD and synthetic candidate digest adapters. No exec.
"""
import os as native,sys,pathlib,stat,json,hashlib,types,builtins,io,contextlib
folder=pathlib.Path(sys.argv[1]);catalog=json.loads((folder/'catalog.json').read_text());base,candidate=catalog;results=[]
cases=[('selection',name) for name in ['legacy','base','candidate','unknown','wrong-hash','duplicate','array','boolean','extra','non-ascii','oversized','empty','hardlink','directory','owner','writable','replaced','stamp','parent-owner','parent-writable','parent-replaced','parent-link','unreadable','adoption-dir','adoption-file','repair-dir','missing-record-appears','missing-parent-appears']]
cases += [('profile',name) for name in ['candidate','candidate-newer','candidate-unrecorded','base-pinned-candidate','candidate-pinned-base','candidate-pinned-candidate','selection-changed']]
cases += [('installation',name) for name in ['candidate','candidate-binary-changed','candidate-record-mismatch','selection-changed']]
for action,case in cases:
 root=folder/'cases'/(action+'-'+case);component=root/'opt/mucodesandbox/windows';component.mkdir(parents=True);profile=root/'home/dev/.local/share/mucodesandbox/browser';profile.mkdir(parents=True);record=profile/'Last Version';record.write_text(candidate['version']+'\n' if action=='profile' else base['version']);(profile/'Cookie-sentinel').write_bytes(b'original unrelated private fixture')
 selector=component/'browser-selection.json';selected=candidate if case.startswith('candidate') or case in ['base-pinned-candidate','selection-changed'] else base
 if case=='candidate-pinned-base':selected=base
 raw=json.dumps(dict(schema=1,version=selected['version'],archiveSha256=selected['sha256'])).encode()
 if case not in ['legacy','missing-record-appears','missing-parent-appears']:selector.write_bytes(raw)
 if case=='unknown':selector.write_text(json.dumps(dict(schema=1,version='157.0.0.0',archiveSha256=base['sha256'])))
 if case=='wrong-hash':selector.write_text(json.dumps(dict(schema=1,version=candidate['version'],archiveSha256=base['sha256'])))
 if case=='duplicate':selector.write_bytes(raw[:-1]+b',"schema":1}')
 if case=='array':selector.write_text('[]')
 if case=='boolean':selector.write_text(json.dumps(dict(schema=True,version=base['version'],archiveSha256=base['sha256'])))
 if case=='extra':selector.write_text(json.dumps(dict(schema=1,version=base['version'],archiveSha256=base['sha256'],path='/foreign')))
 if case=='non-ascii':selector.write_bytes(b'\xff')
 if case=='oversized':selector.write_bytes(b' '*4097)
 if case=='empty':selector.write_bytes(b'')
 if case=='hardlink':native.link(selector,root/'selector-retained')
 if case=='directory':selector.unlink();selector.mkdir()
 if case=='adoption-dir':(component/'.browser-adoption').mkdir()
 if case=='adoption-file':(component/'.browser-adoption').write_bytes(b'unknown active marker')
 if case=='repair-dir':(component/'.browser-repair').mkdir()
 if case=='missing-parent-appears':component.rmdir()
 if case=='candidate-newer':record.write_text('157.0.0.0')
 if case=='candidate-unrecorded':record.unlink()
 payload=b'candidate synthetic binary, never executed';old_payload=b'base synthetic binary, never executed'
 if action=='installation':
  binary_root=component/('chrome-'+candidate['version']);binary_root.mkdir();(binary_root/'chrome').write_bytes(payload+(b'changed' if case=='candidate-binary-changed' else b''));(binary_root/'.mu-component.json').write_text(json.dumps(dict(version=base['version'] if case=='candidate-record-mismatch' else candidate['version'],architecture='amd64',archiveSha256=candidate['sha256'],binarySha256=candidate['binarySha256'])))
 def snapshot():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 before=snapshot();fds={};next_fd=[100000];selector_reads=[0]
 def info(path,named=False,fd=None):
  value=native.fstat(fd) if fd is not None else path.stat();directory=stat.S_ISDIR(value.st_mode);dev=path==root/'home/dev' or root/'home/dev' in path.parents;uid=1000 if dev else 0;mode=(stat.S_IFDIR|0o700) if directory else (stat.S_IFREG|0o600);inode=value.st_ino;mtime=value.st_mtime_ns
  if path==selector:
   if case=='owner':uid=1000
   if case=='writable':mode|=0o020
   if named and case=='replaced':inode+=1
   if named and case=='stamp':mtime+=1
  if path==component:
   if case=='parent-owner':uid=1000
   if case=='parent-writable':mode|=0o020
   if named and case=='parent-replaced':inode+=1
  return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=1000 if dev else 0,st_dev=value.st_dev,st_ino=inode,st_nlink=value.st_nlink,st_size=value.st_size,st_mtime_ns=mtime,st_ctime_ns=value.st_ctime_ns)
 def opening(name,flags,dir_fd=None):
  assert flags in [0x300000,0x700000,0xb00000,0xf00000],flags
  path=root if name=='/' else fds[dir_fd][0]/name
  assert path==root or path.is_relative_to(root)
  if case=='parent-link' and path==component:raise OSError('Explicit no-follow adapter')
  if case=='unreadable' and path==selector:raise PermissionError('Explicit read refusal')
  if flags&0x400000:
   if not path.exists():raise FileNotFoundError(str(path))
   assert path.is_dir();fd=next_fd[0];next_fd[0]+=1;fds[fd]=(path,True)
  else:
   if path.is_dir():raise IsADirectoryError(str(path))
   fd=native.open(path,native.O_RDONLY|getattr(native,'O_BINARY',0));fds[fd]=(path,False)
  return fd
 def named(name,dir_fd=None,follow_symlinks=None):
  assert follow_symlinks is False;path=fds[dir_fd][0]/name
  if case=='missing-record-appears' and path==selector:return info(component)
  if case=='missing-parent-appears' and path==component:return info(component.parent)
  return info(path,True)
 def closing(fd):
  path,directory=fds.pop(fd)
  if not directory:native.close(fd)
 def reading(fd,size):
  path,directory=fds[fd];assert not directory
  if path==selector:
   selector_reads[0]+=1
   if case=='selection-changed' and selector_reads[0]>=2:return json.dumps(dict(schema=1,version=base['version'],archiveSha256=base['sha256'])).encode()
  return native.read(fd,size)
 def fdopen(fd,mode,closefd=True):assert mode=='rb' and closefd is False;return native.fdopen(fd,mode,closefd=False)
 fake_os=types.SimpleNamespace(O_RDONLY=0,O_CLOEXEC=0x100000,O_NOFOLLOW=0x200000,O_DIRECTORY=0x400000,O_NONBLOCK=0x800000,open=opening,stat=named,fstat=lambda fd:info(fds[fd][0],fd=None if fds[fd][1] else fd),close=closing,read=reading,fdopen=fdopen,getuid=lambda:1000)
 class Digest:
  def __init__(self,*a):self.value=bytearray(*a)
  def update(self,data):self.value.extend(data)
  def hexdigest(self):return candidate['binarySha256'] if bytes(self.value)==payload else hashlib.sha256(self.value).hexdigest()
 def importing(name,*a,**kw):
  if name=='os':return fake_os
  if name=='hashlib':return types.SimpleNamespace(sha256=Digest)
  assert name in ['stat','json','re'];return builtins.__import__(name,*a,**kw)
 safe=dict(vars(builtins));safe['__import__']=importing;safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unpinned access'))
 program='profile-base' if case=='base-pinned-candidate' else 'profile-candidate' if case in ['candidate-pinned-base','candidate-pinned-candidate'] else action
 output=io.StringIO();ns={'__builtins__':safe};error=None;answer=None
 try:
  with contextlib.redirect_stdout(output):exec(compile((folder/(program+'.py')).read_text(encoding='utf-8'),'<unchanged-selected-reader>','exec'),ns)
 except Exception as caught:
  assert action=='selection' and isinstance(caught,(ns.get('MuSelectionRefused',RuntimeError),OSError)),(action,case,caught)
  error=getattr(caught,'issue','unreadable')
 finally:assert not fds,(action,case,fds)
 if output.getvalue():answer=json.loads(output.getvalue())
 assert snapshot()==before,(action,case,'mutation')
 if action=='selection':
  if case in ['legacy','base','candidate']:assert error is None and answer['selectedVersion']==selected['version']
  else:assert error is not None,(case,answer)
 elif action=='profile':
  expected='newer' if case=='candidate-newer' else 'unrecorded' if case=='candidate-unrecorded' else 'untrusted' if case in ['base-pinned-candidate','candidate-pinned-base','selection-changed'] else 'compatible'
  assert answer['state']==expected,(case,answer)
  if expected=='untrusted':assert answer['issue']=='selection-changed'
  else:assert answer['selectedVersion']==candidate['version']
 else:
  assert answer['state']==('verified' if case=='candidate' else 'untrusted'),(case,answer)
  if case=='candidate':assert answer['recordedVersion']==candidate['version']==answer['selectedVersion']
 results.append(dict(case=action+'-'+case,passed=True,readonly=True,handlesClosed=True))
print(json.dumps(dict(complete=True,checks=results,actualFilesAndIds=True,actualHardlinks=True,linuxUidModeAndDirfdAdapters=True,candidateDigestAdapter=True,realLinux=False,realVm=False,browserExecuted=False)))
