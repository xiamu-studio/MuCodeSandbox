"""Actual readonly program and approved catalog; real files, IDs and hardlinks.
Only Linux ownership/mode/dirfd/root UID and fcntl availability are adapted.
No executable, archive, network call, repair mutation or VM is used.
"""
import os as native,sys,pathlib,stat,json,hashlib,types,builtins,struct,io,contextlib
folder=pathlib.Path(sys.argv[1]);catalog=json.loads((folder/'catalog.json').read_text());base,candidate=catalog;results=[]
cases=['legacy','base','candidate','candidate-damaged','pending-base','pending-candidate','phase-archive-ready','phase-prepared','phase-published','torn-newer','unknown-selection','wrong-selection-hash','duplicate-selection','selector-owner','selector-writable','selector-hardlink','selector-directory','adoption-dir','adoption-file','reset','legacy-install','slot-file','slot-owner','slot-writable','journal-owner','journal-writable','journal-hardlink','journal-directory','journal-empty','journal-oversize','journal-corrupt','journal-duplicate','journal-replaced','journal-stamp','unknown-recipe','wrong-recipe','bad-epoch','bad-phase','root-binding','slot-binding','journal-binding','sequence-gap','immutable-frames','unknown-slot-file','selection-changed','pending-appeared','pending-disappeared']
program=(folder/'observation.py').read_text(encoding='utf-8')
for case in cases:
 root=folder/'cases'/case;root.mkdir(parents=True);component=root/'opt/mucodesandbox/windows';component.mkdir(parents=True);state=root/'var/lib/mucodesandbox';state.mkdir(parents=True);profile=root/'home/dev/browser';profile.mkdir(parents=True);(profile/'private-sentinel').write_bytes(b'Unrelated synthetic private data')
 selected=base if case in ['legacy','base','pending-base'] else candidate;selector=component/'browser-selection.json';slot=component/'.browser-repair';journal=slot/'journal.bin';parts=root.parts
 if case!='legacy':selector.write_text(json.dumps(dict(schema=1,version=selected['version'],archiveSha256=selected['sha256'])))
 pending=case not in ['legacy','base','candidate','candidate-damaged','pending-appeared']
 if pending:
  slot.mkdir();journal.write_bytes(b'\0'*16384)
  ident=lambda file:[str(file.stat().st_dev),str(file.stat().st_ino)]
  data=dict(schema=1,epoch='a'*32,root=ident(component),slot=ident(slot),journal=ident(journal),archive=['1','2'],candidate=['1','3'],old=['1','4'],recipe=selected,phase=case.removeprefix('phase-') if case.startswith('phase-') else 'receiving')
  if case=='unknown-recipe':data['recipe']={**candidate,'version':'157.0.0.0'}
  if case=='wrong-recipe':data['recipe']=base
  if case=='bad-epoch':data['epoch']='../foreign'
  if case=='bad-phase':data['phase']='exec'
  for field in ['root','slot','journal']:
   if case==field+'-binding':data[field]=['0','0']
  def frame(value,sequence=1,duplicate=False):
   payload=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
   if duplicate:payload=payload[:-1]+b',"schema":1}'
   assert len(payload)<8136
   return struct.pack('>8sQQ32s',b'MUCRP001',sequence,len(payload),hashlib.sha256(payload).digest())+payload+b'\0'*(8136-len(payload))
  raw=frame(data,duplicate=case=='journal-duplicate')+b'\0'*8192
  if case=='torn-newer':raw=frame(data)+frame({**data,'phase':'archive-ready'},2)[:64]+b'\0'*8128
  if case=='sequence-gap':raw=frame(data)+frame(data,3)
  if case=='immutable-frames':raw=frame(data)+frame({**data,'epoch':'b'*32},2)
  journal.write_bytes(raw)
 if case=='candidate-damaged':(component/('chrome-'+candidate['version'])).mkdir();(component/('chrome-'+candidate['version'])/'chrome').write_bytes(b'damaged executable; never opened')
 if case=='unknown-selection':selector.write_text(json.dumps(dict(schema=1,version='157.0.0.0',archiveSha256=candidate['sha256'])))
 if case=='wrong-selection-hash':selector.write_text(json.dumps(dict(schema=1,version=candidate['version'],archiveSha256=base['sha256'])))
 if case=='duplicate-selection':selector.write_bytes(selector.read_bytes()[:-1]+b',"schema":1}')
 if case=='selector-hardlink':native.link(selector,root/'selector-link')
 if case=='selector-directory':selector.unlink();selector.mkdir()
 if case=='adoption-dir':(component/'.browser-adoption').mkdir()
 if case=='adoption-file':(component/'.browser-adoption').write_bytes(b'foreign adoption marker')
 if case=='reset':(state/'browser-reset.json').write_bytes(b'pending reset')
 if case=='legacy-install':(state/'browser-install-transaction.json').write_bytes(b'unknown old intent')
 if case=='slot-file':journal.unlink();slot.rmdir();slot.write_bytes(b'foreign slot')
 if case=='journal-hardlink':native.link(journal,root/'journal-link')
 if case=='journal-directory':journal.unlink();journal.mkdir()
 if case=='journal-empty':journal.write_bytes(b'')
 if case=='journal-oversize':journal.write_bytes(b'\0'*16385)
 if case=='journal-corrupt':journal.write_bytes(b'x'*16384)
 if case=='unknown-slot-file':(slot/'foreign').write_bytes(b'unknown file preserved')
 def snapshot():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 before=snapshot();dirs={};files={};nextfd=[100000];reads={'selector':0,'journal':0};probes=[0];mutations=[0];opened_files=[]
 class FilePath(type(pathlib.Path())):
  def __new__(cls,*args):
   if args and str(args[0]).startswith('/') and not str(args[0]).startswith(str(root)):args=(root,*pathlib.PurePosixPath(str(args[0])).parts[1:],*args[1:])
   return super().__new__(cls,*args)
  @property
  def parts(self):
   values=super().parts
   return ('/',*values[len(parts):]) if values[:len(parts)]==parts else values
  @property
  def anchor(self):return '/' if super().parts[:len(parts)]==parts else super().anchor
  def lstat(self):return metadata(self,True)
 def metadata(path,named=False,fd=None):
  if str(path)==str(slot) and case=='pending-disappeared' and reads['journal']:raise FileNotFoundError('Explicit disappearing private slot adapter')
  path=pathlib.Path(str(path));info=native.fstat(fd) if fd is not None else path.lstat();values={key:getattr(info,key) for key in dir(info) if key.startswith('st_')};directory=stat.S_ISDIR(info.st_mode);mode=(0o700 if path==slot else 0o755) if directory else 0o600;owner=0
  if path==selector:
   if case=='selector-owner':owner=1000
   if case=='selector-writable':mode|=0o020
  if path==slot:
   if case=='slot-owner':owner=1000
   if case=='slot-writable':mode|=0o020
  if path==journal:
   if case=='journal-owner':owner=1000
   if case=='journal-writable':mode|=0o020
   if case=='journal-replaced' and named and reads['journal']:values['st_ino']+=1
   if case=='journal-stamp' and reads['journal']:values['st_mtime_ns']+=1
  values.update(st_mode=stat.S_IFMT(info.st_mode)|mode,st_uid=owner,st_gid=0)
  return types.SimpleNamespace(**values)
 mask=0xf00000
 def resolve(name,dir_fd=None):return dirs[dir_fd]/str(name) if dir_fd is not None else FilePath(name)
 def opening(name,flags,dir_fd=None):
  if flags&~mask:mutations[0]+=1;raise AssertionError(('write attempt',name,flags))
  path=resolve(name,dir_fd)
  if flags&0x400000:
   if not path.is_dir():
    if not path.exists():raise FileNotFoundError(str(path))
    raise NotADirectoryError(str(path))
   fd=nextfd[0];nextfd[0]+=1;dirs[fd]=path;return fd
  if path.is_dir():raise IsADirectoryError(str(path))
  fd=native.open(str(path),native.O_RDONLY|getattr(native,'O_BINARY',0));files[fd]=path;opened_files.append(str(path));return fd
 def closing(fd):
  if fd in dirs:dirs.pop(fd)
  else:files.pop(fd);native.close(fd)
 def reading(fd,size):
  path=files[fd]
  if path==selector:
   reads['selector']+=1
   if case=='selection-changed' and reads['selector']>=2:return json.dumps(dict(schema=1,version=base['version'],archiveSha256=base['sha256'])).encode()
  if path==journal:reads['journal']+=1
  return native.read(fd,size)
 def named(name,dir_fd=None,follow_symlinks=None):
  assert follow_symlinks is False;return metadata(resolve(name,dir_fd),True)
 def lexists(path):
  if str(path)==str(slot):
   probes[0]+=1
   if case=='pending-appeared':return probes[0]>1
   if case=='pending-disappeared' and probes[0]>1:return False
  return native.path.lexists(str(path))
 def denied(*a,**k):mutations[0]+=1;raise AssertionError('Readonly observation invoked a mutating primitive or subprocess')
 values={key:getattr(native,key) for key in dir(native) if not key.startswith('__')};values.update(O_CLOEXEC=0x100000,O_NOFOLLOW=0x200000,O_DIRECTORY=0x400000,O_NONBLOCK=0x800000,open=opening,close=closing,read=reading,stat=named,fstat=lambda fd:metadata(dirs[fd]) if fd in dirs else metadata(files[fd],fd=fd),geteuid=lambda:0,path=types.SimpleNamespace(lexists=lexists),write=denied,rename=denied,mkdir=denied,fsync=denied,chown=denied)
 fake_os=types.SimpleNamespace(**values)
 def importing(name,*a,**kw):
  if name=='os':return fake_os
  if name=='pathlib':return types.SimpleNamespace(Path=FilePath,PurePosixPath=pathlib.PurePosixPath)
  if name=='fcntl':return types.SimpleNamespace(flock=denied)
  if name=='subprocess':return types.SimpleNamespace(run=denied,Popen=denied,check_output=denied)
  return builtins.__import__(name,*a,**kw)
 safe=dict(vars(builtins));safe['__import__']=importing;safe['open']=denied;output=io.StringIO();error=None
 try:
  with contextlib.redirect_stdout(output):exec(compile(program,'<unchanged-root-repair-observation>','exec'),dict(__builtins__=safe))
 except Exception as caught:error=caught
 finally:assert not dirs and not files,(case,dirs,files)
 assert snapshot()==before,(case,'mutated host files');assert mutations==[0],(case,'attempted mutation');assert set(opened_files)<={str(selector),str(journal)},(case,'opened an executable or private file')
 success=case in ['legacy','base','candidate','candidate-damaged','pending-base','pending-candidate','phase-archive-ready','phase-prepared','phase-published','torn-newer']
 if success:
  assert error is None,(case,repr(error));answer=json.loads(output.getvalue());assert answer['selectedVersion']==selected['version']
  assert (answer['pending'] is not None)==pending
  if pending:assert answer['pending']==dict(epoch='a'*32,phase=data['phase'])
 else:assert error is not None,(case,output.getvalue());assert output.getvalue()=='',(case,'advertised rejected state')
 results.append(dict(case=case,passed=True,readonly=True,handlesClosed=True,refused=not success))
print(json.dumps(dict(complete=True,checks=results,actualFilesAndIds=True,actualHardlinks=True,actualApprovedCatalog=True,linuxRootUidModeDirfdAndFcntlAdapters=True,syntheticDigestAdapter=False,executableOpened=False,mutatingCalls=0,realLinux=False,realVm=False)))
