"""Ordinary host bytes/identities; explicit Linux uid/mode/no-follow adapters.
The unchanged reader has no write, creation, command or networking API.
"""
import os as native,sys,pathlib,json,stat,types,builtins,io,contextlib,hashlib
program=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');base=pathlib.Path(sys.argv[2]);selected=sys.argv[3];archive=sys.argv[4]
cases=['absent','unrecorded','equal','older','numeric-older','newer-patch','newer-major','malformed','leading-zero','non-ascii','oversized','empty','hardlink','record-owner','record-writable','parent-owner','parent-writable','parent-link','special','unreadable','record-replaced','record-stamp','parent-replaced','missing-appears','root-caller']
cases+=['adoption-directory','adoption-file','selection-base','selection-candidate','selection-invalid','selection-duplicate','selection-oversized','selection-owner','selection-writable','selection-hardlink','selection-replaced','selection-stamp']
checks=[]
for case in cases:
 root=base/case;profile=root/'home/dev/.local/share/mucodesandbox/browser';profile.mkdir(parents=True);record=profile/'Last Version';record.write_text(selected+'\n',encoding='ascii');(profile/'Cookie-sentinel').write_bytes(b'private unrelated fixture bytes')
 if case=='absent':record.unlink();(profile/'Cookie-sentinel').unlink();profile.rmdir()
 if case in ['unrecorded','missing-appears']:record.unlink()
 if case=='older':record.write_text('154.0.1.2')
 if case=='numeric-older':record.write_text('99.99.999.99')
 if case=='newer-patch':record.write_text('155.0.8059.85')
 if case=='newer-major':record.write_text('156.0.0.0')
 if case=='malformed':record.write_bytes(b'not a version')
 if case=='leading-zero':record.write_bytes(b'0155.0.8059.84')
 if case=='non-ascii':record.write_bytes(b'\xff')
 if case=='oversized':record.write_bytes(b'1'*257)
 if case=='empty':record.write_bytes(b'')
 if case=='hardlink':native.link(record,root/'retained-link')
 selector=root/'opt/mucodesandbox/windows/browser-selection.json'
 if case.startswith(('adoption-','selection-')):
  selector.parent.mkdir(parents=True);selector.write_text(json.dumps(dict(schema=1,version=selected,archiveSha256=archive)))
 if case=='adoption-directory':(selector.parent/'.browser-adoption').mkdir()
 if case=='adoption-file':(selector.parent/'.browser-adoption').write_bytes(b'untrusted active marker')
 if case=='selection-candidate':selector.write_text(json.dumps(dict(schema=1,version='156.0.8078.47',archiveSha256=archive)))
 if case=='selection-invalid':selector.write_text('{}')
 if case=='selection-duplicate':selector.write_text('{"schema":1,"schema":1,"version":'+json.dumps(selected)+',"archiveSha256":'+json.dumps(archive)+'}')
 if case=='selection-oversized':selector.write_bytes(b' '*4097)
 if case=='selection-hardlink':native.link(selector,root/'selector-link')
 def snapshot():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 before=snapshot();fds={};next_fd=[100000];reads=[]
 def info(path,named=False):
  value=path.stat();is_dir=path.is_dir();uid=1000 if path==root/'home/dev' or root/'home/dev' in path.parents else 0;mode=(stat.S_IFDIR|0o700) if is_dir else (stat.S_IFREG|0o600);ino=value.st_ino;mtime=value.st_mtime_ns
  if case=='parent-owner' and path==profile:uid=0
  if case=='parent-writable' and path==profile:mode|=0o020
  if case=='record-owner' and path==record:uid=0
  if case=='record-writable' and path==record:mode|=0o020
  if case=='special' and path==record:mode=stat.S_IFIFO|0o600
  if named and case=='record-replaced' and path==record:ino+=1
  if named and case=='record-stamp' and path==record:mtime+=1
  if named and case=='parent-replaced' and path==profile:ino+=1
  if case=='selection-owner' and path==selector:uid=1000
  if case=='selection-writable' and path==selector:mode|=0o020
  if named and case=='selection-replaced' and path==selector:ino+=1
  if named and case=='selection-stamp' and path==selector:mtime+=1
  return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=1000,st_dev=value.st_dev,st_ino=ino,st_nlink=value.st_nlink,st_size=value.st_size,st_mtime_ns=mtime,st_ctime_ns=value.st_ctime_ns)
 def opening(name,flags,dir_fd=None):
  assert flags in [0xf00000,0xb00000],('Unsafe flags',flags)
  p=root if name=='/' else fds[dir_fd][0]/name
  assert p==root or p.is_relative_to(root)
  if case=='parent-link' and p==profile:raise OSError('No-follow adapter rejects link')
  if case=='unreadable' and p==record:raise PermissionError('Read denied')
  if not p.exists():raise FileNotFoundError(str(p))
  if flags&0x400000:assert p.is_dir();fd=next_fd[0];next_fd[0]+=1;fds[fd]=(p,True)
  else:assert p in [record,selector];fd=native.open(p,native.O_RDONLY|getattr(native,'O_BINARY',0));fds[fd]=(p,False)
  return fd
 def named(name,dir_fd=None,follow_symlinks=None):
  assert follow_symlinks is False;p=fds[dir_fd][0]/name
  if case=='missing-appears' and p==record:return types.SimpleNamespace()
  return info(p,True)
 def reading(fd,size):assert size in [257,4097] and not fds[fd][1];reads.append(size);return native.read(fd,size)
 def closing(fd):
  p,is_dir=fds.pop(fd)
  if not is_dir:native.close(fd)
 fake=types.SimpleNamespace(O_RDONLY=0,O_CLOEXEC=0x100000,O_NOFOLLOW=0x200000,O_DIRECTORY=0x400000,O_NONBLOCK=0x800000,open=opening,stat=named,fstat=lambda fd:info(fds[fd][0]),getuid=lambda:0 if case=='root-caller' else 1000,read=reading,close=closing)
 def importing(name,*args,**kwargs):
  if name=='os':return fake
  assert name in ['stat','re','json'];return builtins.__import__(name,*args,**kwargs)
 safe=dict(vars(builtins));safe['__import__']=importing;safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unpinned file access'))
 output=io.StringIO();globals={'__builtins__':safe}
 with contextlib.redirect_stdout(output):exec(compile(program,'<unchanged-profile-reader>','exec'),globals)
 result=json.loads(output.getvalue());assert not fds;assert snapshot()==before
 expected='absent' if case=='absent' else 'unrecorded' if case=='unrecorded' else 'compatible' if case in ['equal','older','numeric-older','selection-base'] else 'newer' if case.startswith('newer-') else 'untrusted'
 assert result['state']==expected,(case,result);assert result['selectedVersion']==selected
 if case.startswith('adoption-'):assert result['issue']=='adoption-pending'
 if case=='selection-candidate':assert result['issue']=='selection-unavailable'
 if case in ['oversized','empty','hardlink','record-owner','record-writable','parent-owner','parent-writable','parent-link','special','unreadable']:assert not reads,case
 rejected=False
 try:globals['mu_profile_admit']()
 except RuntimeError as error:assert str(error).startswith('MU_BROWSER_PROFILE_');rejected=True
 assert rejected==(expected in ['newer','untrusted']);assert not fds;assert snapshot()==before
 checks.append(dict(name=case,passed=True,readonly=True,handlesClosed=True))
print(json.dumps(dict(complete=True,checks=checks,actualHostFileBytes=True,posixMetadataAdapter=True,realLinux=False,executedBrowser=False)))
