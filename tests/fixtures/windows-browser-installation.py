"""Run the unchanged guest reader on ordinary host files.
POSIX ownership/mode and relative directory handles are explicit adapters.
Regular file bytes, hashes, file identities and hard links use the host OS.
"""
import os as native,sys,pathlib,json,hashlib,stat,types,builtins,io,contextlib
program=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');base=pathlib.Path(sys.argv[2]);asset=json.loads(sys.argv[3]);version=asset['version']
cases=['verified','repair-pending','missing-root','missing-record','missing-binary','parent-owner','parent-writable','parent-link','record-owner','record-link','binary-link','record-large','record-json','record-duplicate','record-fields','wrong-architecture','wrong-archive','wrong-version','binary-changed','binary-owner','binary-writable','binary-stamp','binary-replaced','unreadable']
expected={'verified':('verified',None),'repair-pending':('untrusted','repair-pending'),'missing-root':('missing','missing'),'missing-record':('missing','missing'),'missing-binary':('missing','missing'),'parent-owner':('untrusted','unsafe'),'parent-writable':('untrusted','unsafe'),'parent-link':('untrusted','unreadable'),'record-owner':('untrusted','unsafe'),'record-link':('untrusted','unsafe'),'binary-link':('untrusted','unsafe'),'record-large':('untrusted','unsafe'),'record-json':('untrusted','record'),'record-duplicate':('untrusted','record'),'record-fields':('untrusted','record'),'wrong-architecture':('untrusted','unapproved'),'wrong-archive':('untrusted','unapproved'),'wrong-version':('untrusted','unapproved'),'binary-changed':('untrusted','changed'),'binary-owner':('untrusted','unsafe'),'binary-writable':('untrusted','unsafe'),'binary-stamp':('untrusted','changed'),'binary-replaced':('untrusted','changed'),'unreadable':('untrusted','unreadable')}
def snapshot(folder):return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob('*') if p.is_file()}
results=[]
for case in cases:
 root=base/case;root.mkdir();component=root/'opt'/'mucodesandbox'/'windows'/('chrome-'+version);component.mkdir(parents=True);binary=component/'chrome';record=component/'.mu-component.json';payload=b'synthetic browser executable must never run';binary.write_bytes(payload)
 values=dict(archiveSha256=asset['sha256'],binarySha256=hashlib.sha256(payload).hexdigest(),architecture='amd64',version=version)
 if case=='wrong-architecture':values['architecture']='arm64'
 if case=='wrong-archive':values['archiveSha256']='b'*64
 if case=='wrong-version':values['version']='154.0.1.2'
 if case=='record-fields':values['command']='must not execute'
 record.write_text(json.dumps(values),encoding='utf-8')
 if case=='repair-pending':(component.parent/'.browser-repair').mkdir()
 if case=='missing-root':record.unlink();binary.unlink();component.rmdir()
 if case=='missing-record':record.unlink()
 if case=='missing-binary':binary.unlink()
 if case=='record-link':native.link(record,root/'record-retained')
 if case=='binary-link':native.link(binary,root/'binary-retained')
 if case=='record-large':record.write_bytes(b' '*4097)
 if case=='record-json':record.write_bytes(b'{broken')
 if case=='record-duplicate':record.write_text(json.dumps(values)[:-1]+',"version":"'+version+'"}',encoding='utf-8')
 if case=='binary-changed':binary.write_bytes(payload+b'changed')
 before=snapshot(root);fds={};next_dir=[100000];calls=[];file_stats={}
 def info(path,phase='handle'):
  item=path.stat();mode=(stat.S_IFDIR|0o755) if path.is_dir() else (stat.S_IFREG|0o644);uid=0;inode=item.st_ino;mtime=item.st_mtime_ns
  if path.name=='windows' and case=='parent-owner':uid=1000
  if path.name=='windows' and case=='parent-writable':mode|=0o020
  if path.name=='.mu-component.json' and case=='record-owner':uid=1000
  if path.name=='chrome' and case=='binary-owner':uid=1000
  if path.name=='chrome' and case=='binary-writable':mode|=0o002
  if path.name=='chrome' and phase=='handle':
   file_stats[path]=file_stats.get(path,0)+1
   if case=='binary-stamp' and file_stats[path]>1:mtime+=1
  if path.name=='chrome' and phase=='named' and case=='binary-replaced':inode+=1
  return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_dev=item.st_dev,st_ino=inode,st_nlink=item.st_nlink,st_size=item.st_size,st_mtime_ns=mtime,st_ctime_ns=item.st_ctime_ns)
 def open_read(name,flags,dir_fd=None):
  assert flags in [0x300000,0x700000,0xb00000,0xf00000],('Unexpected write or creation flags',flags)
  path=root if name=='/' else fds[dir_fd][0]/name
  if path.name=='windows' and case=='parent-link':raise OSError('Synthetic symlink refusal')
  if path.name=='chrome' and case=='unreadable':raise PermissionError('Synthetic read refusal')
  if not path.exists():raise FileNotFoundError(str(path))
  if flags&0x400000:
   assert path.is_dir();fd=next_dir[0];next_dir[0]+=1;fds[fd]=(path,True)
  else:fd=native.open(path,native.O_RDONLY|getattr(native,'O_BINARY',0));fds[fd]=(path,False)
  calls.append(('read-open',str(path)));return fd
 def fstat(fd):return info(fds[fd][0])
 def named(name,dir_fd=None,follow_symlinks=None):assert follow_symlinks is False;return info(fds[dir_fd][0]/name,'named')
 def fdopen(fd,mode,closefd=True):assert mode=='rb' and closefd is False and not fds[fd][1];return native.fdopen(fd,'rb',closefd=False)
 def close(fd):
  path,is_dir=fds.pop(fd)
  if not is_dir:native.close(fd)
 fake=types.SimpleNamespace(O_RDONLY=0,O_CLOEXEC=0x100000,O_NOFOLLOW=0x200000,O_DIRECTORY=0x400000,O_NONBLOCK=0x800000,open=open_read,fstat=fstat,stat=named,fdopen=fdopen,read=native.read,close=close)
 def importing(name,*args,**kwargs):
  if name=='os':return fake
  if name not in ['stat','json','hashlib','re']:raise AssertionError('Unexpected guest dependency or executable: '+name)
  return builtins.__import__(name,*args,**kwargs)
 safe=dict(vars(builtins));safe['__import__']=importing;safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unexpected unpinned file operation'))
 captured=io.StringIO()
 try:
  with contextlib.redirect_stdout(captured):exec(compile(program,'unchanged-windows-browser-reader','exec'),{'__builtins__':safe})
 finally:
  leaked=list(fds)
  for fd in list(fds):close(fd)
  assert not leaked,('Guest reader leaked handles',case,leaked)
 result=json.loads(captured.getvalue());assert (result['state'],result['issue'])==expected[case],(case,result);assert snapshot(root)==before,('Guest reader changed files',case)
 results.append(dict(case=case,state=result['state'],issue=result['issue'],readonly=True,handlesClosed=True))
print(json.dumps(dict(complete=True,checks=results,unchangedGuestSource=True,actualRegularFiles=True,actualHashes=True,actualHardLinks=True,posixMetadataAdapter=True,realLinux=False,executedBrowser=False)))
